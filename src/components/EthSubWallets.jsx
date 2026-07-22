/**
 * ETH bridge sub-wallets + cosigner ETH vaults.
 *
 * Flow (mirrors WART, ETH-side capacity):
 *   1. Create ETH sub (index)
 *   2. Create cosigner ETH vault (2P-ECDSA → Ethereum address)
 *   3. Main → sub → fund vault
 *   4. Lock vault ETH → ETH capacity (not WART capacity)
 *   5. Mint / burn wETH claims (rollup claims until Warthog DeFi WETH)
 *   6. Release locked ETH (when freeable); cosign vault→main later
 */
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { ethers, keccak256, toUtf8Bytes } from 'ethers-v6';
import { toast } from 'react-hot-toast';
import { MoreVertical, Wallet, Shield } from 'lucide-react';
import {
  deriveEthSubWallet,
  deriveEthSubPrivateKey,
  ethSubWalletPath,
} from '../utils/ethSubWalletDerive.js';
import {
  createTwoPartyEthVault,
  encryptJsonWithMnemonic,
  saveTwoPartyClientLocal,
  loadTwoPartyEthClientLocal,
  MULTISIG_SCHEME_ETH,
} from '../utils/twoPartyEcdsa.js';
import { registerMultiSigVault } from '../utils/cosignerClient.js';
import {
  multiSigTransferEth,
  loadEthVaultClientSecret,
} from '../utils/multiSigEthTransfer.js';
import { getRollupGraphqlUrl, getAddresses, LOCAL_ADDRESSES } from '../utils/bridgeConfig.js';
import '../styles/subWallet.css';
import '../styles/ethSubWallet.css';

const STORAGE_PREFIX = 'cartesi_eth_subs_';
const GAS_BUFFER_WEI = 50_000n * 1_000_000_000n;
const PORTAL_GAS_BUFFER_WEI = 200_000n * 1_000_000_000n;

const ETHER_PORTAL_ABI = [
  'function depositEther(address _dapp, bytes calldata _execLayerData) external payable',
];

function loadLocalSubs(owner) {
  if (!owner || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + owner.toLowerCase());
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveLocalSubs(owner, list) {
  if (!owner || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      STORAGE_PREFIX + owner.toLowerCase(),
      JSON.stringify(
        (list || []).map((s) => ({
          index: s.index,
          address: s.address,
          path: s.path || null,
          hidden: !!s.hidden,
          vaultAddress: s.vaultAddress || null,
        })),
      ),
    );
  } catch {
    /* */
  }
}

function fmtEth(v, maxFrac = 6) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

function weiToHuman(weiStr) {
  try {
    return ethers.formatEther(BigInt(String(weiStr || '0')));
  } catch {
    return '0';
  }
}

export default function EthSubWallets({
  mainMnemonic,
  wartAddress = null,
  l1Address,
  signer,
  provider,
  send,
  loading,
  setLoading,
  vault,
  onRefreshVault,
  confirmMmTx,
  /** When true, parent already renders the L1 ETH wallet card */
  hideMainCard = false,
  /**
   * Parent-controlled section (Warthog-style).
   * 'subs' | 'vaults' — when set, hides internal pill tabs and locks focus.
   */
  focusMode = null,
  /** Hide subwallet-top title / steps (parent section bar already labels the view) */
  hideTopChrome = false,
  /** Hide cross-layer capacity track (parent Overview / Get wWETH owns that) */
  hideCapacityTrack = false,
}) {
  const [subs, setSubs] = useState([]);
  const [subIndex, setSubIndex] = useState(0);
  const [regenIndex, setRegenIndex] = useState('');
  const [mainEthBal, setMainEthBal] = useState(null);
  const [l1BalByAddr, setL1BalByAddr] = useState({});
  const [vaultBalByAddr, setVaultBalByAddr] = useState({});
  const [fundByIndex, setFundByIndex] = useState({});
  const [withdrawByIndex, setWithdrawByIndex] = useState({});
  const [fundVaultByIndex, setFundVaultByIndex] = useState({});
  const [lockByIndex, setLockByIndex] = useState({});
  const [mintWethByIndex, setMintWethByIndex] = useState({});
  const [burnWethAmt, setBurnWethAmt] = useState('');
  const [releaseByIndex, setReleaseByIndex] = useState({});
  const [vaultWithdrawByIndex, setVaultWithdrawByIndex] = useState({});
  const [busyKey, setBusyKey] = useState(null);
  /** 'subs' | 'vaults' — same split as Warthog Sub wallets / Vault tabs */
  const [ethFocusInternal, setEthFocusInternal] = useState('subs');
  const ethFocus =
    focusMode === 'subs' || focusMode === 'vaults' ? focusMode : ethFocusInternal;
  const setEthFocus = setEthFocusInternal;
  const controlledFocus = focusMode === 'subs' || focusMode === 'vaults';
  /** Carousel index within current focus list (WART-style one-at-a-time) */
  const [activeSubPos, setActiveSubPos] = useState(0);
  /** Which card's ⋮ menu is open: `sub:3` | `vault:3` | null */
  const [openMenuKey, setOpenMenuKey] = useState(null);
  const menuRef = useRef(null);

  const owner = (l1Address || '').toLowerCase();
  const addrs = getAddresses() || LOCAL_ADDRESSES;
  const etherPortal = addrs.etherPortal || LOCAL_ADDRESSES.etherPortal;
  const dapp = addrs.dapp || LOCAL_ADDRESSES.dapp;

  const ethCap = useMemo(() => {
    const capacity = vault?.ethCapacity18 != null ? String(vault.ethCapacity18) : '0';
    const claimed = vault?.ethClaimed18 != null ? String(vault.ethClaimed18) : '0';
    const remaining = vault?.ethRemaining18 != null ? String(vault.ethRemaining18) : '0';
    return {
      capacity: weiToHuman(capacity),
      used: weiToHuman(claimed),
      available: weiToHuman(remaining),
      claim: weiToHuman(vault?.l1WethClaim || '0'),
      portable: weiToHuman(vault?.wethPortable || '0'),
    };
  }, [vault]);

  useEffect(() => {
    if (!owner) return;
    const local = loadLocalSubs(owner);
    const remoteSubs = Array.isArray(vault?.ethSubs) ? vault.ethSubs : [];
    const remoteVaults = Array.isArray(vault?.ethVaults) ? vault.ethVaults : [];
    const byIdx = new Map();

    for (const s of local) {
      if (s?.index == null || !s.address) continue;
      const share = loadTwoPartyEthClientLocal(owner, s.address);
      byIdx.set(Number(s.index), {
        index: Number(s.index),
        address: s.address,
        path: s.path || ethSubWalletPath(s.index),
        hidden: !!s.hidden,
        ethWei: '0',
        eth: '0',
        registered: false,
        vaultAddress: s.vaultAddress || share?.vaultAddress || null,
      });
    }
    for (const s of remoteSubs) {
      if (s?.index == null || !s.address) continue;
      const i = Number(s.index);
      const prev = byIdx.get(i) || {};
      const share = loadTwoPartyEthClientLocal(owner, s.address);
      byIdx.set(i, {
        ...prev,
        index: i,
        address: s.address,
        path: s.path || prev.path || ethSubWalletPath(i),
        ethWei: s.ethWei != null ? String(s.ethWei) : prev.ethWei || '0',
        eth: s.eth != null ? String(s.eth) : prev.eth || '0',
        registered: true,
        hidden: prev.hidden || false,
        vaultAddress: prev.vaultAddress || share?.vaultAddress || null,
      });
    }
    // Attach vault records from inspect by index / sub address
    for (const rv of remoteVaults) {
      const idx = rv.index != null ? Number(rv.index) : null;
      let target = idx != null ? byIdx.get(idx) : null;
      if (!target && rv.ethSubAddress) {
        for (const [, s] of byIdx) {
          if (
            String(s.address).toLowerCase() ===
            String(rv.ethSubAddress).toLowerCase()
          ) {
            target = s;
            break;
          }
        }
      }
      if (target) {
        byIdx.set(target.index, {
          ...target,
          vaultAddress: rv.vaultAddress || target.vaultAddress,
          vaultLocked: rv.lockedOutstanding || '0',
          vaultLockedWei: rv.lockedOutstandingWei || '0',
        });
      }
    }

    const merged = [...byIdx.values()].sort((a, b) => a.index - b.index);
    setSubs(merged);
    if (merged.length) {
      const maxIdx = Math.max(...merged.map((s) => s.index));
      setSubIndex((prev) => (prev > maxIdx + 1 ? prev : maxIdx + 1));
    }
  }, [owner, vault?.ethSubs, vault?.ethVaults, vault?.eth, vault?.ethCapacity18]);

  useEffect(() => {
    if (owner && subs.length) saveLocalSubs(owner, subs);
  }, [owner, subs]);

  const refreshMainBalance = useCallback(async () => {
    if (!provider || !owner) {
      setMainEthBal(null);
      return;
    }
    try {
      setMainEthBal(ethers.formatEther(await provider.getBalance(owner)));
    } catch {
      setMainEthBal(null);
    }
  }, [provider, owner]);

  const refreshSubBalances = useCallback(async () => {
    if (!provider || !subs.length) return;
    const next = {};
    const vNext = {};
    await Promise.all(
      subs.map(async (s) => {
        try {
          next[s.address.toLowerCase()] = ethers.formatEther(
            await provider.getBalance(s.address),
          );
        } catch {
          next[s.address.toLowerCase()] = null;
        }
        if (s.vaultAddress) {
          try {
            vNext[s.vaultAddress.toLowerCase()] = ethers.formatEther(
              await provider.getBalance(s.vaultAddress),
            );
          } catch {
            vNext[s.vaultAddress.toLowerCase()] = null;
          }
        }
      }),
    );
    setL1BalByAddr(next);
    setVaultBalByAddr(vNext);
  }, [provider, subs]);

  const refreshAllBalances = useCallback(async () => {
    await Promise.all([refreshMainBalance(), refreshSubBalances()]);
  }, [refreshMainBalance, refreshSubBalances]);

  useEffect(() => {
    refreshAllBalances();
  }, [refreshAllBalances]);

  const visible = useMemo(() => subs.filter((s) => !s.hidden), [subs]);
  const vaultSubs = useMemo(
    () => visible.filter((s) => !!s.vaultAddress),
    [visible],
  );
  const isVaultFocus = ethFocus === 'vaults';
  const focusList = isVaultFocus ? vaultSubs : visible;
  const totalFocus = focusList.length;
  const safePos =
    totalFocus === 0 ? 0 : Math.min(Math.max(0, activeSubPos), totalFocus - 1);
  const activeSub = totalFocus > 0 ? focusList[safePos] : null;

  useEffect(() => {
    setActiveSubPos(0);
    setOpenMenuKey(null);
  }, [ethFocus]);

  useEffect(() => {
    if (activeSubPos >= totalFocus && totalFocus > 0) {
      setActiveSubPos(totalFocus - 1);
    }
  }, [totalFocus, activeSubPos]);

  const goPrevSub = () => {
    if (totalFocus <= 1) return;
    setActiveSubPos((p) => (p - 1 + totalFocus) % totalFocus);
    setOpenMenuKey(null);
  };
  const goNextSub = () => {
    if (totalFocus <= 1) return;
    setActiveSubPos((p) => (p + 1) % totalFocus);
    setOpenMenuKey(null);
  };

  useEffect(() => {
    if (!openMenuKey) return undefined;
    const onDoc = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setOpenMenuKey(null);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpenMenuKey(null);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenuKey]);

  const toggleMenu = (key) => {
    setOpenMenuKey((prev) => (prev === key ? null : key));
  };

  const ETH_SECTIONS = [
    {
      id: 'subs',
      label: 'ETH subs',
      hint: 'Generate · fund main ↔ sub · create vault',
    },
    {
      id: 'vaults',
      label: 'ETH vaults',
      hint: 'Lock · release · cosign withdraw',
    },
  ];

  const fetchSalt = async () => {
    try {
      const gqlUrl = getRollupGraphqlUrl();
      if (!gqlUrl || !owner) return 'fallback_salt';
      const res = await fetch(gqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: '{ notices(last: 1) { edges { node { payload } } } }',
        }),
      });
      const json = await res.json();
      const noticePayload =
        json?.data?.notices?.edges?.[0]?.node?.payload || 'fallback';
      return keccak256(
        toUtf8Bytes(
          String(noticePayload) +
            owner +
            Math.floor(Date.now() / 1000) +
            'eth-bridge',
        ),
      );
    } catch {
      return 'fallback_salt';
    }
  };

  const createSub = async () => {
    if (!mainMnemonic) {
      return toast.error('Unlock Warthog wallet first (mnemonic seeds ETH subs)');
    }
    if (!owner) return toast.error('Connect MetaMask (L1 owner)');
    try {
      setLoading?.(true);
      const salt = await fetchSalt();
      const saltedIndex =
        subIndex +
        (parseInt(String(salt).replace(/^0x/, '').slice(0, 8), 16) %
          (2 ** 31 - 1));
      const derived = deriveEthSubWallet(mainMnemonic, saltedIndex);
      setSubs((prev) => {
        const filtered = prev.filter((s) => s.index !== derived.index);
        return [
          ...filtered,
          {
            index: derived.index,
            address: derived.address,
            path: derived.path,
            ethWei: '0',
            eth: '0',
            registered: false,
            hidden: false,
            vaultAddress: null,
          },
        ].sort((a, b) => a.index - b.index);
      });
      setSubIndex((prev) => prev + 1);
      try {
        await navigator.clipboard.writeText(String(derived.index));
        toast.success(`ETH sub #${derived.index} created (index copied)`);
      } catch {
        toast.success(`ETH sub #${derived.index} created`);
      }
      setTimeout(() => refreshSubBalances(), 400);
    } catch (e) {
      toast.error(e?.message || 'Create failed');
    } finally {
      setLoading?.(false);
    }
  };

  const regenerateSub = async () => {
    if (!mainMnemonic) return toast.error('Unlock Warthog wallet first');
    const idx = Number(regenIndex);
    if (!Number.isFinite(idx) || idx < 0) return toast.error('Enter a valid index');
    try {
      const derived = deriveEthSubWallet(mainMnemonic, idx);
      const share = loadTwoPartyEthClientLocal(owner, derived.address);
      setSubs((prev) => {
        const filtered = prev.filter((s) => s.index !== idx);
        return [
          ...filtered,
          {
            index: derived.index,
            address: derived.address,
            path: derived.path,
            ethWei: '0',
            eth: '0',
            registered: false,
            hidden: false,
            vaultAddress: share?.vaultAddress || null,
          },
        ].sort((a, b) => a.index - b.index);
      });
      if (idx >= subIndex) setSubIndex(idx + 1);
      toast.success(`ETH sub #${idx} regenerated`);
      setTimeout(() => refreshSubBalances(), 400);
    } catch (e) {
      toast.error(e?.message || 'Regenerate failed');
    }
  };

  const registerSub = async (sub) => {
    if (!send || !owner) return toast.error('Connect MetaMask + rollup send');
    try {
      setBusyKey(`reg:${sub.index}`);
      setLoading?.(true);
      await send({
        type: 'register_eth_sub',
        index: sub.index,
        ethAddress: sub.address,
        path: sub.path || ethSubWalletPath(sub.index),
      });
      setSubs((prev) =>
        prev.map((s) =>
          s.index === sub.index ? { ...s, registered: true } : s,
        ),
      );
      toast.success(`Registered ETH sub #${sub.index}`);
      setTimeout(() => onRefreshVault?.(), 4000);
    } catch (e) {
      toast.error(e?.message || 'Register failed');
    } finally {
      setBusyKey(null);
      setLoading?.(false);
    }
  };

  /**
   * Cosigner ETH vault (2P) — same ceremony as WART vault, Ethereum address.
   */
  const createEthVault = async (sub) => {
    if (!mainMnemonic) return toast.error('Unlock Warthog wallet first');
    if (!owner) return toast.error('Connect MetaMask');
    if (!send) return toast.error('Rollup send missing');

    const toastId = toast.loading('Creating cosigner ETH vault (2P keygen)…');
    try {
      setBusyKey(`vault:${sub.index}`);
      setLoading?.(true);

      const existing = loadTwoPartyEthClientLocal(owner, sub.address);
      let vaultAddr = existing?.vaultAddress || sub.vaultAddress || null;
      let scheme = existing?.scheme || MULTISIG_SCHEME_ETH;

      if (!vaultAddr) {
        const vault = await createTwoPartyEthVault({
          subAddress: sub.address,
          index: sub.index,
          owner,
        });
        vaultAddr = vault.address;
        scheme = vault.scheme;
        const enc = await encryptJsonWithMnemonic(vault.clientSecret, mainMnemonic);
        saveTwoPartyClientLocal({
          mainAddress: owner,
          subAddress: sub.address,
          vaultAddress: vault.address,
          index: sub.index,
          encryptedClientSecret: enc,
          scheme: vault.scheme,
          chain: 'eth',
        });

        toast.loading('Registering with cosigner…', { id: toastId });
        await registerMultiSigVault({
          ...vault.cosignerRegister,
          owner,
          subAddress: sub.address,
          index: sub.index,
          mainAddress: owner,
          allowedTo: [owner],
          chain: 'eth',
        });
      }

      toast.loading('Registering ETH vault on rollup…', { id: toastId });
      await send({
        type: 'create_eth_vault',
        vaultAddress: vaultAddr.startsWith('0x') ? vaultAddr : `0x${vaultAddr}`,
        ethSubAddress: sub.address,
        index: sub.index,
        scheme,
      });

      const fullVault = vaultAddr.startsWith('0x') ? vaultAddr : `0x${vaultAddr}`;
      setSubs((prev) =>
        prev.map((s) =>
          s.index === sub.index
            ? { ...s, vaultAddress: fullVault.toLowerCase() }
            : s,
        ),
      );
      toast.success(
        `ETH vault ${fullVault.slice(0, 10)}… — fund vault, then Lock for ETH capacity`,
        { id: toastId, duration: 7000 },
      );
      setTimeout(() => {
        onRefreshVault?.();
        refreshAllBalances();
      }, 4000);
    } catch (e) {
      console.error(e);
      toast.error(e?.message || 'ETH vault create failed', { id: toastId });
    } finally {
      setBusyKey(null);
      setLoading?.(false);
    }
  };

  const fundSubFromMain = async (sub) => {
    if (!signer || !provider || !owner) return toast.error('Connect MetaMask');
    const amtStr = String(fundByIndex[sub.index] || '').trim();
    if (!amtStr) return toast.error('Enter amount');
    let amountWei;
    try {
      amountWei = ethers.parseEther(amtStr);
    } catch {
      return toast.error('Invalid amount');
    }
    if (amountWei <= 0n) return toast.error('Amount must be > 0');

    const toastId = toast.loading('Main → sub…');
    try {
      setBusyKey(`fund:${sub.index}`);
      setLoading?.(true);
      const mainBal = await provider.getBalance(owner);
      if (mainBal < amountWei + GAS_BUFFER_WEI) {
        throw new Error(
          `Main has ${ethers.formatEther(mainBal)} ETH — need amount + gas`,
        );
      }
      if (confirmMmTx) {
        const ok = await confirmMmTx({
          title: `Fund ETH sub #${sub.index}`,
          method: 'ETH transfer (main → sub)',
          summary: `${amtStr} ETH · MetaMask → sub`,
          sections: [
            {
              label: 'Main → sub',
              json: { from: owner, to: sub.address, amountEth: amtStr },
            },
          ],
        });
        if (!ok) {
          toast('Cancelled', { id: toastId });
          return;
        }
      }
      const tx = await signer.sendTransaction({ to: sub.address, value: amountWei });
      await tx.wait?.(1);
      toast.success(`Funded sub · ${tx.hash?.slice(0, 12)}…`, { id: toastId });
      setFundByIndex((p) => ({ ...p, [sub.index]: '' }));
      await refreshAllBalances();
    } catch (e) {
      toast.error(e?.shortMessage || e?.message || 'Fund failed', { id: toastId });
    } finally {
      setBusyKey(null);
      setLoading?.(false);
    }
  };

  const withdrawSubToMain = async (sub) => {
    if (!mainMnemonic) return toast.error('Unlock Warthog wallet first');
    if (!provider || !owner) return toast.error('Connect MetaMask');
    const amtStr = String(withdrawByIndex[sub.index] || '').trim();
    if (!amtStr) return toast.error('Enter amount');
    let amountWei;
    try {
      amountWei = ethers.parseEther(amtStr);
    } catch {
      return toast.error('Invalid amount');
    }
    if (amountWei <= 0n) return toast.error('Amount must be > 0');

    const toastId = toast.loading('Sub → main…');
    try {
      setBusyKey(`wd:${sub.index}`);
      setLoading?.(true);
      const pk = deriveEthSubPrivateKey(mainMnemonic, sub.index);
      const subWallet = new ethers.Wallet(pk, provider);
      const tx = await subWallet.sendTransaction({ to: owner, value: amountWei });
      await tx.wait?.(1);
      toast.success(`Withdrew to main · ${tx.hash?.slice(0, 12)}…`, { id: toastId });
      setWithdrawByIndex((p) => ({ ...p, [sub.index]: '' }));
      await refreshAllBalances();
    } catch (e) {
      toast.error(e?.shortMessage || e?.message || 'Withdraw failed', { id: toastId });
    } finally {
      setBusyKey(null);
      setLoading?.(false);
    }
  };

  /** Sub → cosigner ETH vault (L1). */
  const fundVaultFromSub = async (sub) => {
    if (!mainMnemonic) return toast.error('Unlock Warthog wallet first');
    if (!sub.vaultAddress) return toast.error('Create ETH vault first');
    if (!provider) return toast.error('No provider');
    const amtStr = String(fundVaultByIndex[sub.index] || '').trim();
    if (!amtStr) return toast.error('Enter amount to send to vault');
    let amountWei;
    try {
      amountWei = ethers.parseEther(amtStr);
    } catch {
      return toast.error('Invalid amount');
    }
    if (amountWei <= 0n) return toast.error('Amount must be > 0');

    const toastId = toast.loading('Sub → ETH vault…');
    try {
      setBusyKey(`fv:${sub.index}`);
      setLoading?.(true);
      const pk = deriveEthSubPrivateKey(mainMnemonic, sub.index);
      const subWallet = new ethers.Wallet(pk, provider);
      const tx = await subWallet.sendTransaction({
        to: sub.vaultAddress,
        value: amountWei,
      });
      await tx.wait?.(1);
      toast.success(`Vault funded · ${tx.hash?.slice(0, 12)}…`, { id: toastId });
      setFundVaultByIndex((p) => ({ ...p, [sub.index]: '' }));
      await refreshAllBalances();
    } catch (e) {
      toast.error(e?.shortMessage || e?.message || 'Fund vault failed', {
        id: toastId,
      });
    } finally {
      setBusyKey(null);
      setLoading?.(false);
    }
  };

  /** Lock vault ETH as ETH capacity (rollup). */
  const lockEthVault = async (sub) => {
    if (!send || !sub.vaultAddress) return toast.error('Need vault + MetaMask');
    const amtStr = String(lockByIndex[sub.index] || '').trim();
    if (!amtStr) return toast.error('Enter lock amount');
    let amountWei;
    try {
      amountWei = ethers.parseEther(amtStr);
    } catch {
      return toast.error('Invalid amount');
    }
    if (amountWei <= 0n) return toast.error('Amount must be > 0');

    try {
      setBusyKey(`lock:${sub.index}`);
      setLoading?.(true);
      await send({
        type: 'eth_vault_lock',
        vaultAddress: sub.vaultAddress,
        amountWei: amountWei.toString(),
      });
      toast.success(
        `Locked ${amtStr} ETH capacity (ETH pool only — not WART)`,
        { duration: 6000 },
      );
      setLockByIndex((p) => ({ ...p, [sub.index]: '' }));
      setTimeout(() => onRefreshVault?.(), 4000);
    } catch (e) {
      toast.error(e?.message || 'Lock failed');
    } finally {
      setBusyKey(null);
      setLoading?.(false);
    }
  };

  const mintWethClaim = async (sub) => {
    if (!send) return toast.error('Connect MetaMask');
    const amtStr = String(mintWethByIndex[sub.index] || '').trim();
    if (!amtStr) return toast.error('Enter claim amount');
    try {
      setBusyKey(`mintw:${sub.index}`);
      setLoading?.(true);
      await send({
        type: 'mint_weth_claim',
        amount: amtStr,
      });
      toast.success(`Minted ${amtStr} wETH claim (rollup)`);
      setMintWethByIndex((p) => ({ ...p, [sub.index]: '' }));
      setTimeout(() => onRefreshVault?.(), 4000);
    } catch (e) {
      toast.error(e?.message || 'Mint wETH claim failed');
    } finally {
      setBusyKey(null);
      setLoading?.(false);
    }
  };

  const burnWethClaim = async () => {
    if (!send) return toast.error('Connect MetaMask');
    const amtStr = String(burnWethAmt || '').trim();
    if (!amtStr) return toast.error('Enter burn amount');
    try {
      setBusyKey('burnw');
      setLoading?.(true);
      await send({ type: 'burn_weth_claim', amount: amtStr });
      toast.success(`Burned ${amtStr} wETH claim — Available ↑`);
      setBurnWethAmt('');
      setTimeout(() => onRefreshVault?.(), 4000);
    } catch (e) {
      toast.error(e?.message || 'Burn failed');
    } finally {
      setBusyKey(null);
      setLoading?.(false);
    }
  };

  const releaseEthLock = async (sub) => {
    if (!send || !sub.vaultAddress) return toast.error('Need vault');
    const amtStr = String(releaseByIndex[sub.index] || '').trim();
    if (!amtStr) return toast.error('Enter release amount');
    try {
      setBusyKey(`rel:${sub.index}`);
      setLoading?.(true);
      await send({
        type: 'eth_vault_unlock',
        vaultAddress: sub.vaultAddress,
        amount: amtStr,
      });
      toast.success(
        `Released ${amtStr} ETH lock · eth_release_ticket ready for cosign withdraw`,
        { duration: 7000 },
      );
      setReleaseByIndex((p) => ({ ...p, [sub.index]: '' }));
      setTimeout(() => onRefreshVault?.(), 4000);
    } catch (e) {
      toast.error(e?.message || 'Release failed — burn claims first if Used ≥ Capacity');
    } finally {
      setBusyKey(null);
      setLoading?.(false);
    }
  };

  /**
   * Cosigner ETH vault → MetaMask main.
   * Requires freeable eth_release_ticket (or fully unlocked pin).
   */
  const withdrawVaultToMain = async (sub) => {
    if (!mainMnemonic) return toast.error('Unlock Warthog wallet first');
    if (!provider || !owner) return toast.error('Connect MetaMask');
    if (!sub.vaultAddress) return toast.error('No ETH vault');

    const amtStr = String(vaultWithdrawByIndex[sub.index] || '').trim();
    if (!amtStr) return toast.error('Enter vault → main amount');

    const toastId = toast.loading('Cosigner vault → main…');
    try {
      setBusyKey(`vwd:${sub.index}`);
      setLoading?.(true);

      const clientSecret = await loadEthVaultClientSecret(
        mainMnemonic,
        owner,
        sub.address,
      );

      if (confirmMmTx) {
        const ok = await confirmMmTx({
          title: `Vault → main ${amtStr} ETH`,
          method: '2P-ECDSA cosigner ETH transfer',
          summary: `${amtStr} ETH · vault ${sub.vaultAddress.slice(0, 10)}… → ${owner.slice(0, 10)}… (ticket-gated)`,
          sections: [
            {
              label: 'Cosigner ETH withdraw',
              json: {
                vault: sub.vaultAddress,
                to: owner,
                amountEth: amtStr,
                chain: 'eth',
                note: 'Requires eth_release_ticket freeable (or fully unlocked)',
              },
            },
          ],
        });
        if (!ok) {
          toast('Cancelled', { id: toastId });
          return;
        }
      }

      const result = await multiSigTransferEth({
        provider,
        vaultAddress: sub.vaultAddress,
        toAddress: owner,
        amountEth: amtStr,
        ownerL1: owner,
        subAddress: sub.address,
        clientSecret,
      });

      toast.success(
        `Vault → main ${result.amountEth} ETH · ${String(result.txHash || '').slice(0, 12)}…`,
        { id: toastId, duration: 8000 },
      );
      setVaultWithdrawByIndex((p) => ({ ...p, [sub.index]: '' }));
      await refreshAllBalances();
      setTimeout(() => onRefreshVault?.(), 3000);
    } catch (e) {
      console.error(e);
      toast.error(e?.message || 'Vault withdraw failed', { id: toastId, duration: 9000 });
    } finally {
      setBusyKey(null);
      setLoading?.(false);
    }
  };

  const setMaxVaultWithdraw = async (sub) => {
    if (!provider || !sub.vaultAddress) return;
    try {
      const full = await provider.getBalance(sub.vaultAddress);
      // leave gas buffer for EIP-1559
      const buffer = 100_000n * 2_000_000_000n;
      const max = full > buffer ? full - buffer : 0n;
      setVaultWithdrawByIndex((p) => ({
        ...p,
        [sub.index]: ethers.formatEther(max),
      }));
    } catch {
      const vb = vaultBalByAddr[String(sub.vaultAddress).toLowerCase()];
      if (vb) setVaultWithdrawByIndex((p) => ({ ...p, [sub.index]: vb }));
    }
  };

  const setMaxWithdraw = async (sub) => {
    if (!provider) return;
    try {
      const full = await provider.getBalance(sub.address);
      const max = full > GAS_BUFFER_WEI ? full - GAS_BUFFER_WEI : 0n;
      setWithdrawByIndex((p) => ({ ...p, [sub.index]: ethers.formatEther(max) }));
    } catch {
      /* */
    }
  };

  const setMaxFund = async (sub) => {
    if (!provider || !owner) return;
    try {
      const full = await provider.getBalance(owner);
      const max = full > GAS_BUFFER_WEI ? full - GAS_BUFFER_WEI : 0n;
      setFundByIndex((p) => ({ ...p, [sub.index]: ethers.formatEther(max) }));
    } catch {
      /* */
    }
  };

  const setMaxFundVault = async (sub) => {
    if (!provider) return;
    try {
      const full = await provider.getBalance(sub.address);
      const max = full > GAS_BUFFER_WEI ? full - GAS_BUFFER_WEI : 0n;
      setFundVaultByIndex((p) => ({
        ...p,
        [sub.index]: ethers.formatEther(max),
      }));
    } catch {
      /* */
    }
  };

  const setMaxLock = (sub) => {
    const vb = vaultBalByAddr[String(sub.vaultAddress || '').toLowerCase()];
    if (vb) setLockByIndex((p) => ({ ...p, [sub.index]: vb }));
  };

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(String(text));
      toast.success(`${label} copied`);
    } catch {
      toast.error('Copy failed');
    }
  };

  if (!owner) {
    return (
      <div className="wi-panel">
        <p className="wi-muted">Connect MetaMask to manage ETH bridge sub-wallets.</p>
      </div>
    );
  }

  const renderCardMenu = (menuKey, items) => {
    const open = openMenuKey === menuKey;
    return (
      <div
        className="eth-card-menu"
        ref={open ? menuRef : undefined}
        style={{ position: 'relative', marginLeft: 'auto' }}
      >
        <button
          type="button"
          className="eth-menu-btn"
          aria-label="Card menu"
          aria-expanded={open}
          title="More actions"
          onClick={(e) => {
            e.stopPropagation();
            toggleMenu(menuKey);
          }}
        >
          <MoreVertical size={16} />
        </button>
        {open ? (
          <div className="eth-menu-dropdown" role="menu">
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`eth-menu-item${item.danger ? ' is-danger' : ''}`}
                disabled={item.disabled}
                onClick={() => {
                  setOpenMenuKey(null);
                  item.onClick?.();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <section
      className={`subwallet-section eth-subwallet-section${
        isVaultFocus ? ' eth-subwallet-section--vault-focus subwallet-section--vault-focus' : ''
      }`}
    >
      {!mainMnemonic && (
        <p className="sw-hint" style={{ marginTop: 0 }}>
          Unlock Warthog wallet to create ETH subs, vaults, and sign sub→vault.
        </p>
      )}

      {!hideTopChrome && (
        <div className="subwallet-top">
          <h3>{isVaultFocus ? 'ETH vaults' : 'ETH sub wallets'}</h3>
          <p className="sw-top-lead">
            {isVaultFocus
              ? 'Cosigner vault balances · lock capacity · release · vault → main'
              : 'Generate · fund main ↔ sub · create cosigner vault'}
          </p>
          <details className="bridge-flow-guide">
            <summary>{isVaultFocus ? 'Vault tips' : 'Steps'}</summary>
            {isVaultFocus ? (
              <ol className="bridge-flow-steps">
                <li>
                  <span className="step-num">1</span>
                  <span>
                    Create vaults from <strong>Sub wallets</strong>
                  </span>
                </li>
                <li>
                  <span className="step-num">2</span>
                  <span>
                    <strong>Sub → vault</strong> then <strong>Lock</strong> capacity
                  </span>
                </li>
                <li>
                  <span className="step-num">3</span>
                  <span>
                    <strong>Release</strong> ticket · <strong>Vault → main (cosign)</strong>
                  </span>
                </li>
              </ol>
            ) : (
              <ol className="bridge-flow-steps">
                <li>
                  <span className="step-num">1</span>
                  <span>Generate sub · fund main → sub</span>
                </li>
                <li>
                  <span className="step-num">2</span>
                  <span>
                    <strong>Load / create vault</strong> (2P cosigner)
                  </span>
                </li>
                <li>
                  <span className="step-num">3</span>
                  <span>
                    Open <strong>Vaults</strong> to lock / release / withdraw
                  </span>
                </li>
              </ol>
            )}
          </details>
        </div>
      )}

      {/* Focus pills — only when parent is not driving the section menu */}
      {!controlledFocus && (
        <nav
          className="sw-action-tabs"
          role="tablist"
          aria-label="ETH subs or vaults"
          style={{ marginBottom: '0.55rem' }}
        >
          {ETH_SECTIONS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={ethFocus === tab.id}
              className={`sw-action-tab ${ethFocus === tab.id ? 'is-active' : ''}`}
              title={tab.hint}
              onClick={() => {
                setEthFocus(tab.id);
                setOpenMenuKey(null);
              }}
            >
              {tab.label}
              {tab.id === 'subs' && visible.length ? ` (${visible.length})` : ''}
              {tab.id === 'vaults' && vaultSubs.length ? ` (${vaultSubs.length})` : ''}
            </button>
          ))}
        </nav>
      )}

      {/* Cross-layer capacity card — parent Overview / Get wWETH may own this */}
      {!hideCapacityTrack && (
        <div className="sw-card sw-card--l1-track">
          <div className="sw-card-head">
            <h4 className="sw-card-title">ETH capacity across layers</h4>
            <div className="sw-card-head-right">
              <button
                type="button"
                className="btn secondary small"
                onClick={() => {
                  onRefreshVault?.();
                  refreshAllBalances();
                }}
              >
                Refresh
              </button>
            </div>
          </div>
          <div className="sw-card-meta">
            <div className="sw-meta-row">
              <span className="sw-meta-k" title="Locked vault ETH (capacity)">
                ETH capacity
              </span>
              <span className="sw-meta-v">{fmtEth(ethCap.capacity)} ETH</span>
            </div>
            <div className="sw-meta-row">
              <span className="sw-meta-k" title="wETH claims using capacity">
                ETH used (claims)
              </span>
              <span className="sw-meta-v">{fmtEth(ethCap.used)} ETH</span>
            </div>
            <div className="sw-meta-row">
              <span className="sw-meta-k">ETH available</span>
              <span className="sw-meta-v">{fmtEth(ethCap.available)} ETH</span>
            </div>
            <div className="sw-meta-row">
              <span className="sw-meta-k" title="Rollup wETH claim / portable">
                wETH claim
              </span>
              <span className="sw-meta-v">
                {fmtEth(ethCap.claim)} · port {fmtEth(ethCap.portable)}
              </span>
            </div>
            <div className="sw-meta-row">
              <span className="sw-meta-k">Main L1 ETH</span>
              <span className="sw-meta-v">
                {mainEthBal != null ? `${fmtEth(mainEthBal)} ETH` : '—'}
              </span>
            </div>
          </div>
          <p className="wh-hint sw-l1-track-hint">
            <strong>Locked vault ETH</strong> is capacity (not WART). Optional wETH claims are
            rollup-only until DeFi WETH. Cosign vault→main needs a release ticket.
          </p>
          {isVaultFocus && (
            <div className="sw-card-toolbar">
              <input
                className="input amount-input"
                placeholder="Burn wETH claim"
                value={burnWethAmt}
                onChange={(e) => setBurnWethAmt(e.target.value)}
                disabled={loading}
              />
              <button
                type="button"
                className="btn secondary small"
                disabled={loading || !ethCap.portable || ethCap.portable === '0'}
                onClick={() => setBurnWethAmt(ethCap.portable)}
              >
                Max
              </button>
              <button
                type="button"
                className="btn primary small"
                disabled={loading || busyKey === 'burnw' || !burnWethAmt}
                onClick={burnWethClaim}
              >
                {busyKey === 'burnw' ? '…' : 'Burn claim'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Generate / regen — sub focus only */}
      {!isVaultFocus && (
        <div className="subwallet-controls">
          <button
            type="button"
            className="btn primary small"
            disabled={loading || !mainMnemonic}
            onClick={createSub}
          >
            + Generate sub
          </button>
          <div className="regen-group">
            <input
              type="number"
              className="input regen-input"
              placeholder="Index"
              value={regenIndex}
              onChange={(e) => setRegenIndex(e.target.value)}
              title="HD index to regenerate"
            />
            <button
              type="button"
              className="btn secondary small"
              disabled={loading || !mainMnemonic || !regenIndex}
              onClick={regenerateSub}
            >
              Regen
            </button>
          </div>
        </div>
      )}

      {totalFocus === 0 && (
        <div className="sw-empty">
          <p>
            {isVaultFocus
              ? 'No ETH vaults yet. Open ETH subs → Load / create vault on a sub.'
              : 'No ETH sub-wallets yet. Generate one to start.'}
          </p>
          {isVaultFocus && (
            <button
              type="button"
              className="btn secondary small"
              style={{ marginTop: '0.5rem' }}
              onClick={() => setEthFocus('subs')}
            >
              ← ETH subs
            </button>
          )}
        </div>
      )}

      {activeSub &&
        (() => {
          const sub = activeSub;
          const l1Bal = l1BalByAddr[sub.address.toLowerCase()];
          const vBal = sub.vaultAddress
            ? vaultBalByAddr[String(sub.vaultAddress).toLowerCase()]
            : null;
          const shortPill = `#${String(sub.index).length > 8 ? String(sub.index).slice(0, 6) + '…' : sub.index}`;
          const shortAddr = `${sub.address.slice(0, 6)}…${sub.address.slice(-4)}`;
          const vaultShort = sub.vaultAddress
            ? `${sub.vaultAddress.slice(0, 6)}…${sub.vaultAddress.slice(-4)}`
            : '';
          const hasVault = !!sub.vaultAddress;
          const locked = Number(sub.vaultLocked || 0) > 0;

          return (
            <div className="sw-carousel" key={`${ethFocus}-${sub.index}`}>
              <div
                className="sw-pager"
                role="navigation"
                aria-label={isVaultFocus ? 'Vault switcher' : 'Sub-wallet switcher'}
              >
                <div className="sw-pager-nav">
                  <button
                    type="button"
                    className="sw-pager-step"
                    onClick={goPrevSub}
                    disabled={totalFocus <= 1}
                    title={isVaultFocus ? 'Previous vault' : 'Previous sub-wallet'}
                    aria-label={isVaultFocus ? 'Previous vault' : 'Previous sub-wallet'}
                  >
                    ‹
                  </button>
                  <span className="sw-pager-count" title={isVaultFocus ? 'Vault position' : 'Sub position'}>
                    {safePos + 1}
                    <span className="sw-pager-count-sep">/</span>
                    {totalFocus}
                  </span>
                  <button
                    type="button"
                    className="sw-pager-step"
                    onClick={goNextSub}
                    disabled={totalFocus <= 1}
                    title={isVaultFocus ? 'Next vault' : 'Next sub-wallet'}
                    aria-label={isVaultFocus ? 'Next vault' : 'Next sub-wallet'}
                  >
                    ›
                  </button>
                </div>
                <select
                  className="input sw-pager-select"
                  value={safePos}
                  onChange={(e) => {
                    setActiveSubPos(Number(e.target.value));
                    setOpenMenuKey(null);
                  }}
                  aria-label={isVaultFocus ? 'Select vault' : 'Select sub-wallet'}
                >
                  {focusList.map((s, i) => {
                    const short = `${String(s.address).slice(0, 6)}…${String(s.address).slice(-4)}`;
                    const vAddr = String(s.vaultAddress || '');
                    const vShort = vAddr
                      ? `${vAddr.slice(0, 6)}…${vAddr.slice(-4)}`
                      : '';
                    const loc = Number(s.vaultLocked || 0) > 0;
                    return (
                      <option key={s.index} value={i}>
                        {isVaultFocus
                          ? `${i + 1}. vault ${vShort || short}${loc ? ' · locked' : ''}`
                          : `${i + 1}. #${s.index} · ${short}${s.vaultAddress ? ' · vault' : ''}`}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className={`sw-cards${isVaultFocus ? ' sw-cards--vault-only' : ''}`}>
                {/* ── Sub card (subs focus) ── */}
                {!isVaultFocus && (
                  <div className={`sw-card sw-card--sub${sub.hidden ? ' is-hidden-sub' : ''}`}>
                    <div className="sw-card-head">
                      <h4 className="sw-card-title">
                        Sub-wallet
                        {sub.hidden ? <span className="sw-live-tag"> · hidden</span> : null}
                        {sub.registered ? (
                          <span className="sw-live-tag"> · registered</span>
                        ) : (
                          <span className="sw-live-tag"> · local</span>
                        )}
                      </h4>
                      <div className="sw-card-head-right">
                        <button
                          type="button"
                          className="sw-pill sw-pill-muted sw-pill-copy"
                          title={`Copy index ${sub.index}`}
                          onClick={() => copy(sub.index, `Index ${sub.index}`)}
                        >
                          {shortPill}
                        </button>
                        {renderCardMenu(`sub:${sub.index}`, [
                          {
                            label: 'Copy sub address',
                            onClick: () => copy(sub.address, 'Sub'),
                          },
                          {
                            label: 'Copy index',
                            onClick: () => copy(sub.index, `Index ${sub.index}`),
                          },
                          !sub.registered
                            ? {
                                label: 'Register on rollup',
                                onClick: () => registerSub(sub),
                                disabled: loading,
                              }
                            : null,
                          hasVault
                            ? {
                                label: 'Open ETH vault',
                                onClick: () => setEthFocus('vaults'),
                              }
                            : {
                                label: 'Create cosigner vault',
                                onClick: () => createEthVault(sub),
                                disabled: loading || !mainMnemonic,
                              },
                          {
                            label: 'Hide from list',
                            onClick: () => hideSub(sub),
                          },
                          {
                            label: 'Remove from UI',
                            onClick: () => removeSub(sub),
                            danger: true,
                          },
                        ].filter(Boolean))}
                      </div>
                    </div>

                    <div className="sw-card-meta">
                      <div className="sw-meta-row">
                        <span className="sw-meta-k">Balance</span>
                        <span className="sw-meta-v">{fmtEth(l1Bal)} ETH</span>
                      </div>
                      <div className="sw-meta-row">
                        <span className="sw-meta-k">Address</span>
                        <button
                          type="button"
                          className="sw-meta-v mono sw-link"
                          onClick={() => copy(sub.address, 'Sub')}
                          title={sub.address}
                        >
                          {shortAddr}
                        </button>
                      </div>
                    </div>

                    <div className="sw-card-toolbar">
                      <button
                        type="button"
                        className="btn primary small"
                        onClick={() => refreshAllBalances()}
                        disabled={loading}
                      >
                        Refresh
                      </button>
                      {!hasVault ? (
                        <button
                          type="button"
                          className="btn primary small"
                          disabled={
                            loading ||
                            !mainMnemonic ||
                            busyKey === `vault:${sub.index}`
                          }
                          onClick={() => createEthVault(sub)}
                        >
                          {busyKey === `vault:${sub.index}`
                            ? '…'
                            : 'Load / create vault'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn secondary small"
                          onClick={() => setEthFocus('vaults')}
                        >
                          Open vault
                        </button>
                      )}
                      {!sub.registered && (
                        <button
                          type="button"
                          className="btn secondary small"
                          disabled={loading}
                          onClick={() => registerSub(sub)}
                        >
                          Register
                        </button>
                      )}
                    </div>

                    <details className="sw-details" open>
                      <summary>Fund / exit (main ↔ sub)</summary>
                      <div className="sw-details-body">
                        <p className="sw-hint">
                          Main = MetaMask L1. Fund pulls from main; withdraw returns free sub
                          balance.
                        </p>
                        <div className="action-group deposit-group">
                          <input
                            className="input amount-input"
                            placeholder="From main"
                            value={fundByIndex[sub.index] || ''}
                            onChange={(e) =>
                              setFundByIndex((p) => ({
                                ...p,
                                [sub.index]: e.target.value,
                              }))
                            }
                          />
                          <button
                            type="button"
                            className="btn secondary small"
                            onClick={() => setMaxFund(sub)}
                          >
                            Max
                          </button>
                          <button
                            type="button"
                            className="btn primary small"
                            disabled={loading || busyKey === `fund:${sub.index}`}
                            onClick={() => fundSubFromMain(sub)}
                          >
                            {busyKey === `fund:${sub.index}` ? '…' : 'Main → sub'}
                          </button>
                        </div>
                        <div className="action-group deposit-group">
                          <input
                            className="input amount-input"
                            placeholder="To main"
                            value={withdrawByIndex[sub.index] || ''}
                            onChange={(e) =>
                              setWithdrawByIndex((p) => ({
                                ...p,
                                [sub.index]: e.target.value,
                              }))
                            }
                          />
                          <button
                            type="button"
                            className="btn secondary small"
                            onClick={() => setMaxWithdraw(sub)}
                          >
                            Max
                          </button>
                          <button
                            type="button"
                            className="btn primary small"
                            disabled={
                              loading ||
                              !mainMnemonic ||
                              busyKey === `wd:${sub.index}`
                            }
                            onClick={() => withdrawSubToMain(sub)}
                          >
                            {busyKey === `wd:${sub.index}` ? '…' : 'Sub → main'}
                          </button>
                        </div>
                      </div>
                    </details>
                  </div>
                )}

                {/* ── Vault card (vaults focus) ── */}
                {isVaultFocus && hasVault && (
                  <div className="sw-card sw-card--vault">
                    <div className="sw-card-head">
                      <h4 className="sw-card-title">
                        ETH vault
                        {locked ? <span className="sw-live-tag"> · locked</span> : null}
                      </h4>
                      <div className="sw-card-head-right">
                        <button
                          type="button"
                          className="sw-pill sw-pill-muted sw-pill-copy"
                          title={`Sub index ${sub.index}`}
                          onClick={() => copy(sub.index, `Index ${sub.index}`)}
                        >
                          {shortPill}
                        </button>
                        {renderCardMenu(`vault:${sub.index}`, [
                          {
                            label: 'Copy vault address',
                            onClick: () => copy(sub.vaultAddress, 'Vault'),
                          },
                          {
                            label: 'Copy sub address',
                            onClick: () => copy(sub.address, 'Sub'),
                          },
                          {
                            label: 'Open linked sub',
                            onClick: () => setEthFocus('subs'),
                          },
                          {
                            label: 'Refresh balances',
                            onClick: () => refreshAllBalances(),
                          },
                          {
                            label: 'Hide linked sub',
                            onClick: () => hideSub(sub),
                          },
                        ])}
                      </div>
                    </div>

                    <div className="sw-card-meta">
                      <div className="sw-meta-row">
                        <span className="sw-meta-k">Vault L1</span>
                        <span className="sw-meta-v">{fmtEth(vBal)} ETH</span>
                      </div>
                      <div className="sw-meta-row">
                        <span className="sw-meta-k">Locked</span>
                        <span className="sw-meta-v">
                          {fmtEth(sub.vaultLocked || '0')} ETH
                        </span>
                      </div>
                      <div className="sw-meta-row">
                        <span className="sw-meta-k">Sub free</span>
                        <span className="sw-meta-v">{fmtEth(l1Bal)} ETH</span>
                      </div>
                      <div className="sw-meta-row">
                        <span className="sw-meta-k">Vault</span>
                        <button
                          type="button"
                          className="sw-meta-v mono sw-link"
                          onClick={() => copy(sub.vaultAddress, 'Vault')}
                          title={sub.vaultAddress}
                        >
                          {vaultShort}
                        </button>
                      </div>
                    </div>

                    <div className="sw-card-toolbar">
                      <button
                        type="button"
                        className="btn primary small"
                        onClick={() => {
                          onRefreshVault?.();
                          refreshAllBalances();
                        }}
                        disabled={loading}
                      >
                        Refresh
                      </button>
                    </div>

                    <details className="sw-details" open>
                      <summary>Fund vault · lock capacity</summary>
                      <div className="sw-details-body">
                        <p className="sw-hint">
                          Move free sub ETH into the multi-sig vault, then lock for ETH capacity.
                        </p>
                        <div className="action-group">
                          <input
                            className="input amount-input"
                            placeholder="Sub → vault"
                            value={fundVaultByIndex[sub.index] || ''}
                            onChange={(e) =>
                              setFundVaultByIndex((p) => ({
                                ...p,
                                [sub.index]: e.target.value,
                              }))
                            }
                          />
                          <button
                            type="button"
                            className="btn secondary small"
                            onClick={() => setMaxFundVault(sub)}
                          >
                            Max
                          </button>
                          <button
                            type="button"
                            className="btn primary small"
                            disabled={
                              loading ||
                              !mainMnemonic ||
                              busyKey === `fv:${sub.index}`
                            }
                            onClick={() => fundVaultFromSub(sub)}
                          >
                            {busyKey === `fv:${sub.index}` ? '…' : 'Sub → vault'}
                          </button>
                        </div>
                        <div className="action-group">
                          <input
                            className="input amount-input"
                            placeholder="Lock amount"
                            value={lockByIndex[sub.index] || ''}
                            onChange={(e) =>
                              setLockByIndex((p) => ({
                                ...p,
                                [sub.index]: e.target.value,
                              }))
                            }
                          />
                          <button
                            type="button"
                            className="btn secondary small"
                            onClick={() => setMaxLock(sub)}
                          >
                            Max vault
                          </button>
                          <button
                            type="button"
                            className="btn primary small"
                            disabled={loading || busyKey === `lock:${sub.index}`}
                            onClick={() => lockEthVault(sub)}
                          >
                            {busyKey === `lock:${sub.index}`
                              ? '…'
                              : 'Lock → capacity'}
                          </button>
                        </div>
                      </div>
                    </details>

                    <details className="sw-details">
                      <summary>wETH claims (optional)</summary>
                      <div className="sw-details-body">
                        <div className="action-group">
                          <input
                            className="input amount-input"
                            placeholder="Mint wETH claim"
                            value={mintWethByIndex[sub.index] || ''}
                            onChange={(e) =>
                              setMintWethByIndex((p) => ({
                                ...p,
                                [sub.index]: e.target.value,
                              }))
                            }
                          />
                          <button
                            type="button"
                            className="btn secondary small"
                            onClick={() =>
                              setMintWethByIndex((p) => ({
                                ...p,
                                [sub.index]: ethCap.available,
                              }))
                            }
                          >
                            Max avail
                          </button>
                          <button
                            type="button"
                            className="btn primary small"
                            disabled={loading || busyKey === `mintw:${sub.index}`}
                            onClick={() => mintWethClaim(sub)}
                          >
                            {busyKey === `mintw:${sub.index}` ? '…' : 'Mint claim'}
                          </button>
                        </div>
                      </div>
                    </details>

                    <details className="sw-details" open>
                      <summary>Release · vault → main (cosign)</summary>
                      <div className="sw-details-body">
                        <p className="sw-hint">
                          Release emits a ticket. Cosign withdraw amount ≤ freeable tickets (or
                          fully unlocked).
                        </p>
                        <div className="action-group">
                          <input
                            className="input amount-input"
                            placeholder="Release lock"
                            value={releaseByIndex[sub.index] || ''}
                            onChange={(e) =>
                              setReleaseByIndex((p) => ({
                                ...p,
                                [sub.index]: e.target.value,
                              }))
                            }
                          />
                          <button
                            type="button"
                            className="btn secondary small"
                            disabled={loading || busyKey === `rel:${sub.index}`}
                            onClick={() => releaseEthLock(sub)}
                          >
                            {busyKey === `rel:${sub.index}` ? '…' : 'Release lock'}
                          </button>
                        </div>
                        <div className="action-group">
                          <input
                            className="input amount-input"
                            placeholder="Vault → main"
                            value={vaultWithdrawByIndex[sub.index] || ''}
                            onChange={(e) =>
                              setVaultWithdrawByIndex((p) => ({
                                ...p,
                                [sub.index]: e.target.value,
                              }))
                            }
                          />
                          <button
                            type="button"
                            className="btn secondary small"
                            disabled={loading}
                            onClick={() => setMaxVaultWithdraw(sub)}
                          >
                            Max
                          </button>
                          <button
                            type="button"
                            className="btn primary small"
                            disabled={
                              loading ||
                              !mainMnemonic ||
                              busyKey === `vwd:${sub.index}`
                            }
                            onClick={() => withdrawVaultToMain(sub)}
                          >
                            {busyKey === `vwd:${sub.index}`
                              ? '…'
                              : 'Vault → main'}
                          </button>
                        </div>
                      </div>
                    </details>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
    </section>
  );
}
