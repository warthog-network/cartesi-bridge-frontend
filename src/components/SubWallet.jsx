// src/components/SubWallet.jsx
import { useState, useEffect, useMemo, useRef } from 'react';
import { gql, GraphQLClient } from 'graphql-request';
import { keccak256, toUtf8Bytes, toUtf8String } from 'ethers-v6';
import { Toaster, toast } from 'react-hot-toast';
import { RefreshCw, Eye, EyeOff, MoreVertical } from 'lucide-react';
import '../styles/subWallet.css';
import { createWarthogApi, signAndSubmitTransaction } from '../utils/warthogClient.js';
import { getTxConfirmationStatus } from '../utils/txProof.js';
import { getRollupGraphqlUrl, getInspectUrl } from '../utils/bridgeConfig.js';
import { deriveSubWallet, deriveSubPrivateKey } from '../utils/subWalletDerive.js';
import {
  createTwoPartyVault,
  encryptJsonWithMnemonic,
  decryptJsonWithMnemonic,
  isAesGcmClientSecretBlob,
  saveTwoPartyClientLocal,
  loadTwoPartyClientLocal,
  clearTwoPartyClientLocal,
  buildVaultSharePlainPayload,
  downloadVaultShareBackupFile,
  exportVaultShareBackupFromLocal,
  importVaultShareBackupFile,
  promptVaultSharePassword,
  VAULT_SHARE_DOWNLOAD_NAME,
  MULTISIG_SCHEME,
} from '../utils/twoPartyEcdsa.js';
import {
  registerMultiSigVault,
  cosignerStatus,
  cosignerListByOwner,
} from '../utils/cosignerClient.js';
import { multiSigTransferWart } from '../utils/multiSigTransfer.js';
import { getSmartNonce, bumpNonceAfterSuccess } from '../utils/cancelLimitOrder.js';
import { computeWliqMintAvailable } from '../utils/wliqCapacity.js';
import { SHARE_TOKEN } from '../utils/tokenNames.js';
const API_URL = '/api/proxy';

/** Module-level so SubWallet re-renders do not remount / reset dots interval. */
function LoadingDots() {
  const [dots, setDots] = useState(1);
  useEffect(() => {
    const interval = setInterval(() => setDots((prev) => (prev % 3) + 1), 500);
    return () => clearInterval(interval);
  }, []);
  return <span>{'.'.repeat(dots)}</span>;
}

function SubWallet({
  mainWallet,
  mainMnemonic,
  selectedNode,
  fetchBalanceAndNonce,
  sendTransaction,
  send,
  address, // Warthog main address
  l1Address, // NEW: L1 MetaMask address
  loading,
  setLoading,
  subWallets,
  setSubWallets,
  subIndex,
  setSubIndex,
  getWartTxProof,
  sentTransactions, // NEW
  /** 'bridge' = fund/sweep path · 'vault' = multi-sig vault focus (Vault tab) */
  focusMode = 'bridge',
  /** L1 rollup vault inspect snapshot (claimable wWART, outstanding, etc.) */
  l1Vault = null,
  /** Live MetaMask ERC-20 wWART balance (string human units) */
  mmWwartBal = null,
  onRefreshL1Vault,
  onRefreshMmWwart,
  /** Parent switches to Vault tab (⋮ menu / Open vault) */
  onOpenVaultTab = null,
}) {
  const [subError, setSubError] = useState(null);
  const [subDeposits, setSubDeposits] = useState({});
  const [isDepositing, setIsDepositing] = useState({});
  const [autoLockPhase, setAutoLockPhase] = useState({});
  const [isUnlocking, setIsUnlocking] = useState({});
  // Withdraw states
  const [subWithdrawAmounts, setSubWithdrawAmounts] = useState({});
  const [subWithdrawFees, setSubWithdrawFees] = useState({});
  const [isWithdrawing, setIsWithdrawing] = useState({});

  // Sweep states
  const [subSweepAmounts, setSubSweepAmounts] = useState({});
  const [isSweeping, setIsSweeping] = useState({});
  // Vault → main withdraw (after unlock)
  const [vaultWithdrawAmounts, setVaultWithdrawAmounts] = useState({});
  const [isVaultWithdrawing, setIsVaultWithdrawing] = useState({});
  /**
   * Vaults with rollup/share history for this owner that are not on a loaded card.
   * @type {Array<{ vaultAddress: string, subAddress: string|null, subIndex: number|null, balance: string, spendable: string, lastType: string|null, lastAt: number|null, loaded: boolean }>}
   */
  const [unloadedVaults, setUnloadedVaults] = useState([]);
  const [unloadedBusy, setUnloadedBusy] = useState(false);
  /** Unloaded vaults panel starts collapsed — open only via toggle. */
  const [unloadedPanelOpen, setUnloadedPanelOpen] = useState(false);
  /** Vault addresses user hid / dismissed (persist — do not auto-reattach). */
  const [dismissedVaults, setDismissedVaults] = useState([]);
  // Controlled <details> open flags per sub (survive re-renders; default closed)
  // { [subIndex]: { vaultMain?: boolean, burn?: boolean, details?: boolean } }
  const [openVaultPanels, setOpenVaultPanels] = useState({});
  // Partial spoofed wWART burn (E8 outstanding tracked on sub.mintedE8)
  const [burnAmounts, setBurnAmounts] = useState({});

  // Regenerate state
  const [regenIndex, setRegenIndex] = useState('');

  // Vault checked state
  const [checkedVault, setCheckedVault] = useState({});

  // Active deposit tx monitoring (for enabling manual sweep after confirmation)
  const [activeDepositTxs, setActiveDepositTxs] = useState({}); // { subIndex: txHash }

  // Cycle one sub (+ its vault) at a time — not a full list of every sub
  const [activeSubPos, setActiveSubPos] = useState(0);
  // Action tabs (same pattern as Overview / Send / Sub-wallets app tabs)
  const [subActionTab, setSubActionTab] = useState('fund'); // fund | sweep
  const [vaultActionTab, setVaultActionTab] = useState('withdraw'); // burn | withdraw
  /** Include subs marked hidden (stuck old vaults) in the carousel */
  const [showHiddenSubs, setShowHiddenSubs] = useState(false);
  /** Toggle Balances across layers body (header stays for show/hide) */
  const [showLayersCard, setShowLayersCard] = useState(true);
  /** Which card ⋮ menu is open: `sub:3` | `vault:3` | null */
  const [openMenuKey, setOpenMenuKey] = useState(null);
  const cardMenuRef = useRef(null);

  // Screen size state
  const [isSmallScreen, setIsSmallScreen] = useState(window.innerWidth <= 688);

  // Keep carousel index in range when visible subs change
  useEffect(() => {
    const n = showHiddenSubs
      ? subWallets.length
      : subWallets.filter((s) => !s.hidden).length;
    if (n === 0) {
      setActiveSubPos(0);
      return;
    }
    setActiveSubPos((pos) => Math.min(Math.max(0, pos), n - 1));
  }, [subWallets, showHiddenSubs]);

  // Pick sensible vault action tab only when switching which sub is focused.
  // Keep vault details / release / withdraw panels closed by default.
  useEffect(() => {
    const list = showHiddenSubs ? subWallets : subWallets.filter((s) => !s.hidden);
    const sub = list[activeSubPos];
    if (!sub) return;
    try {
      const out = BigInt(sub.mintedE8 || '0');
      if (sub.locked || out > 0n) setVaultActionTab('burn');
      else setVaultActionTab('withdraw');
    } catch {
      setVaultActionTab('withdraw');
    }
    setSubActionTab(focusMode === 'vault' ? 'sweep' : 'fund');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on sub / mode switch
  }, [activeSubPos, focusMode]);

  // Absolute URL required — relative `/rollup/graphql` throws in graphql-request
  const client = useMemo(() => new GraphQLClient(getRollupGraphqlUrl()), []);

  // Monitor deposit confirmations to enable manual sweep
  useEffect(() => {
    Object.entries(activeDepositTxs).forEach(([subIndex, txHash]) => {
      const tx = sentTransactions.find(t => t.txHash === txHash);
      if (tx && tx.status === 'confirmed') {
        // Deposit confirmed, enable manual sweep by clearing locking
        setSubWallets(prev =>
          prev.map(s => s.index === Number(subIndex) ? { ...s, locking: false } : s)
        );
        setActiveDepositTxs(prev => {
          const newState = { ...prev };
          delete newState[subIndex];
          return newState;
        });
        toast.success('Step 3 done: deposit confirmed — ready for Sweep to vault (locks WART as capacity).');
      }
    });
  }, [sentTransactions, activeDepositTxs, setSubWallets]);

  // Handle resize for screen size
  useEffect(() => {
    const handleResize = () => {
      setIsSmallScreen(window.innerWidth <= 688);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Load / persist dismissed vault addresses per main Warthog wallet
  const dismissedStorageKey = (main) =>
    `cartesiDismissedVaults:${String(main || '')
      .replace(/^0x/i, '')
      .toLowerCase()}`;

  useEffect(() => {
    const main = mainWallet?.address || address;
    if (!main || typeof localStorage === 'undefined') {
      setDismissedVaults([]);
      return;
    }
    try {
      const raw = localStorage.getItem(dismissedStorageKey(main));
      const arr = raw ? JSON.parse(raw) : [];
      setDismissedVaults(Array.isArray(arr) ? arr.map((a) => String(a).toLowerCase()) : []);
    } catch {
      setDismissedVaults([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainWallet?.address, address]);

  useEffect(() => {
    const main = mainWallet?.address || address;
    if (!main || typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(
        dismissedStorageKey(main),
        JSON.stringify(dismissedVaults),
      );
    } catch {
      /* */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissedVaults, mainWallet?.address, address]);

  const dismissVaultAddress = (vaultAddr) => {
    const v = String(vaultAddr || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    if (v.length < 40) return;
    setDismissedVaults((prev) => (prev.includes(v) ? prev : [...prev, v]));
  };

  const undismissVaultAddress = (vaultAddr) => {
    const v = String(vaultAddr || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    setDismissedVaults((prev) => prev.filter((x) => x !== v));
  };

  const isVaultDismissed = (vaultAddr) => {
    const v = String(vaultAddr || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    return dismissedVaults.includes(v);
  };

  /**
   * Re-fetch balances only for vaults already attached to a sub card.
   * Do NOT auto-reattach after "Dismiss vault" (that was popping vaults back).
   */
  useEffect(() => {
    let cancelled = false;
    const targets = (subWallets || []).filter((s) => {
      if (s.vaultDetached) return false;
      const v = (s.vaultAddress || s.pendingVaultAddress || '').toString();
      return v.replace(/^0x/i, '').length >= 40;
    });
    if (!targets.length || !fetchBalanceAndNonce) return undefined;

    (async () => {
      for (const s of targets) {
        if (cancelled) break;
        const vaultAddr = String(s.vaultAddress || s.pendingVaultAddress)
          .replace(/^0x/i, '')
          .toLowerCase();
        try {
          const vb = await fetchBalanceAndNonce(vaultAddr, true);
          if (cancelled || vb?.ok === false) continue;
          setSubWallets((prev) =>
            prev.map((x) =>
              x.index === s.index && !x.vaultDetached
                ? {
                    ...x,
                    // Keep the same attached address — never switch to another vault
                    vaultAddress: vaultAddr,
                    pendingVaultAddress: vaultAddr,
                    vaultBalance: String(vb.balance ?? x.vaultBalance ?? '0'),
                    vaultSpendable: String(
                      vb.spendable ?? vb.balance ?? x.vaultSpendable ?? '0',
                    ),
                    vaultBalanceAt: Date.now(),
                  }
                : x,
            ),
          );
        } catch (e) {
          console.warn('[vault balance heal]', e?.message || e);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    address,
    selectedNode,
    // fire when sub/vault identity changes (not every balance tick)
    (subWallets || [])
      .map(
        (s) =>
          `${s.index}:${s.vaultAddress || s.pendingVaultAddress || ''}:${s.vaultDetached ? 1 : 0}`,
      )
      .join('|'),
  ]);

  // Discover vaults with history that are not on a loaded card (Vault tab / L1 ready)
  useEffect(() => {
    if (!l1Address && !(subWallets || []).length) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      if (!cancelled) {
        discoverUnloadedVaults().catch(() => {});
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    l1Address,
    address,
    focusMode,
    (subWallets || [])
      .map((s) => `${s.index}:${s.vaultAddress || s.pendingVaultAddress || ''}`)
      .join('|'),
  ]);

  // Re-sync locked collateral (mintedE8) from rollup notices + L1 inspect.
  // Fixes sticky unlock after unlock→re-lock (historical subwallet_unlocked must not pin UI to 0).
  useEffect(() => {
    let cancelled = false;
    const subs = (subWallets || []).filter(
      (s) => s?.address && (s.locked || (s.mintedE8 && s.mintedE8 !== '0') || s.vaultAddress),
    );
    if (!subs.length && !(l1Vault?.outstandingE8 != null && l1Address)) return undefined;

    (async () => {
      const updates = [];
      // Prefer live inspect outstanding for this L1 owner when present
      let inspectOut = null;
      try {
        if (l1Vault?.outstandingE8 != null) {
          inspectOut = BigInt(String(l1Vault.outstandingE8));
        }
      } catch {
        inspectOut = null;
      }
      for (const s of subs) {
        try {
          const rebuilt = await rebuildOutstandingE8FromNotices(s.address);
          if (cancelled) continue;
          let next =
            rebuilt?.outstandingE8 != null ? BigInt(String(rebuilt.outstandingE8)) : null;
          // If notices lag or sticky-zero after re-lock, inspect is authoritative
          if (inspectOut != null && (next == null || next < inspectOut)) {
            next = inspectOut;
          }
          if (next == null) continue;
          const nextStr = next.toString();
          const prev = String(s.mintedE8 || '0');
          const nextLocked = next > 0n;
          if (prev !== nextStr || !!s.locked !== nextLocked) {
            updates.push({
              index: s.index,
              mintedE8: nextStr,
              locked: nextLocked,
            });
          }
        } catch {
          /* rollup may be down */
        }
      }
      // No sub list yet but inspect shows pin — still nothing to patch
      if (cancelled || !updates.length) return;
      setSubWallets((prev) =>
        prev.map((s) => {
          const u = updates.find((x) => x.index === s.index);
          return u ? { ...s, mintedE8: u.mintedE8, locked: u.locked } : s;
        }),
      );
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    address,
    l1Address,
    l1Vault?.outstandingE8,
    // stable-ish fingerprint of which subs exist
    (subWallets || []).map((s) => `${s.index}:${s.address}`).join('|'),
  ]);

  // NOTE: do not define child components inside SubWallet — each re-render remounts them
  // and collapses <details> / steals input focus (Vault → main typing bug).

  const copyToClipboard = (text, label = 'Copied') => {
    const s = String(text ?? '');
    if (!s) return toast.error('Nothing to copy');
    navigator.clipboard
      .writeText(s)
      .then(() => toast.success(`${label}: ${s.length > 24 ? s.slice(0, 12) + '…' : s}`))
      .catch(() => toast.error('Failed to copy'));
  };

  /**
   * Download opaque password-encrypted user-vault-share.txt (WartBunker-style).
   * Never uploads to cosigner/server — trust model intact.
   */
  const downloadVaultShareBackup = async (sub) => {
    const mainAddr = mainWallet?.address || address;
    if (!mainAddr) return toast.error('Unlock main Warthog wallet first');
    if (!sub?.address) return toast.error('No sub-wallet');
    if (!mainMnemonic) {
      return toast.error('Mnemonic required to export vault share from this browser');
    }
    try {
      let password;
      try {
        password = promptVaultSharePassword('encrypt');
      } catch (e) {
        return toast.error(String(e?.message || e));
      }
      if (!password) return toast('Download cancelled — no password');

      const plain = await exportVaultShareBackupFromLocal(mainAddr, sub.address, {
        ownerL1: l1Address,
        mnemonic: mainMnemonic,
      });
      if (!plain) {
        return toast.error(
          'No local user share for this vault — create multi-sig vault first, or Import a backup file',
          { duration: 8000 },
        );
      }
      const name = downloadVaultShareBackupFile(plain, password);
      toast.success(
        `Downloaded ${name} — user half only (password blob). Cosigner half stays on the cosigner; not in this file.`,
        { duration: 9000 },
      );
    } catch (e) {
      toast.error(String(e?.message || e));
    }
  };

  /**
   * Import opaque user-vault-share.txt (password) into this browser only.
   * Re-wraps with mnemonic for localStorage. Does not send d_user to cosigner.
   */
  const importVaultShareBackup = (sub, fileList) => {
    const file = fileList?.[0];
    if (!file) return;
    const mainAddr = mainWallet?.address || address;
    if (!mainAddr) return toast.error('Unlock main Warthog wallet first');
    if (!mainMnemonic) {
      return toast.error('Mnemonic required to install vault share into this browser');
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const text = String(reader.result || '');
        const isLegacyJson = text.trim().startsWith('{');
        let password = null;
        if (!isLegacyJson) {
          password = promptVaultSharePassword('decrypt');
          if (!password) return toast('Import cancelled — no password');
        }
        const result = await importVaultShareBackupFile(text, {
          mainAddress: mainAddr,
          mnemonic: mainMnemonic,
          password,
          subAddress: sub?.address || undefined,
        });
        if (sub?.index != null && result.vaultAddress) {
          setSubWallets((prev) =>
            prev.map((s) =>
              s.index === sub.index
                ? {
                    ...s,
                    vaultAddress: result.vaultAddress,
                    pendingVaultAddress: result.vaultAddress,
                    multisig: true,
                    vaultScheme: result.scheme,
                  }
                : s,
            ),
          );
          // Refresh balance so funded old vault shows immediately after import
          try {
            const bal = await fetchBalanceAndNonce(result.vaultAddress, true);
            setSubWallets((prev) =>
              prev.map((s) =>
                s.index === sub.index
                  ? {
                      ...s,
                      vaultBalance: bal.balance || '0',
                      vaultSpendable: bal.spendable || bal.balance || '0',
                      vaultBalanceAt: Date.now(),
                    }
                  : s,
              ),
            );
          } catch {
            /* ignore */
          }
        }
        toast.success(
          `Imported user share for vault ${String(result.vaultAddress).slice(0, 12)}…` +
            (result.strippedCosignerMaterial
              ? ' (legacy cosigner half in file was discarded — not stored in browser)'
              : ' (user half only). Use Load if cosigner check is needed.') +
            ` Balance refresh attempted.`,
          { duration: 9000 },
        );
      } catch (e) {
        toast.error(String(e?.message || e), { duration: 9000 });
      }
    };
    reader.onerror = () => toast.error('Failed to read vault-share file');
    reader.readAsText(file);
  };

  /** Visible list (hidden stuck vaults stay in storage until removed). */
  const baseVisibleSubs = useMemo(
    () => (showHiddenSubs ? subWallets : subWallets.filter((s) => !s.hidden)),
    [subWallets, showHiddenSubs],
  );
  const hiddenCount = useMemo(
    () => subWallets.filter((s) => s.hidden).length,
    [subWallets],
  );

  const hideSubWallet = (sub) => {
    setSubWallets((prev) =>
      prev.map((s) => (s.index === sub.index ? { ...s, hidden: true } : s)),
    );
    toast.success(`Hid sub #${sub.index} from list (still in storage — unhide or remove)`);
  };

  const unhideSubWallet = (sub) => {
    setSubWallets((prev) =>
      prev.map((s) => (s.index === sub.index ? { ...s, hidden: false } : s)),
    );
    toast.success(`Sub #${sub.index} visible again`);
  };

  /** Remove from UI list permanently (does not move on-chain funds). */
  const removeSubWallet = (sub) => {
    const vaultBal = Number(sub.vaultBalance || sub.vaultSpendable || 0);
    const subBal = Number(sub.balance || 0);
    const stuck =
      vaultBal > 0 ||
      subBal > 0 ||
      (sub.mintedE8 && BigInt(sub.mintedE8 || '0') > 0n);
    const msg = stuck
      ? `Remove sub #${sub.index} from UI?\n\nNote: on-chain balances are NOT moved. Stuck multi-sig vault funds stay on-chain.\nAddress: ${String(sub.address).slice(0, 12)}…`
      : `Remove sub #${sub.index} from this list?`;
    if (typeof window !== 'undefined' && !window.confirm(msg)) return;

    setSubWallets((prev) => prev.filter((s) => s.index !== sub.index));
    // Clear related UI state
    setSubDeposits((prev) => {
      const n = { ...prev };
      delete n[sub.index];
      return n;
    });
    setVaultWithdrawAmounts((prev) => {
      const n = { ...prev };
      delete n[sub.index];
      return n;
    });
    toast.success(`Removed sub #${sub.index} from UI`);
  };

  const clearAllHiddenSubs = () => {
    const hidden = subWallets.filter((s) => s.hidden);
    if (!hidden.length) return toast('No hidden subs');
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        `Permanently remove ${hidden.length} hidden sub-wallet(s) from the UI list?\nOn-chain funds are not moved.`,
      )
    ) {
      return;
    }
    setSubWallets((prev) => prev.filter((s) => !s.hidden));
    toast.success(`Cleared ${hidden.length} hidden sub(s) from UI`);
  };

  const fetchCartesiSalt = async (userMainAddress) => {
    try {
      const { notices } = await client.request(gql`{ notices(last: 1) { edges { node { payload } } } }`);
      const noticePayload = notices.edges[0]?.node.payload || 'fallback';
      const timestamp = Math.floor(Date.now() / 1000);
      return keccak256(
        toUtf8Bytes(noticePayload + userMainAddress + timestamp)
      );
    } catch {
      return 'fallback_salt';
    }
  };

  const generateLockedSubWallet = async () => {
    if (!mainMnemonic) return toast.error('Main wallet mnemonic required');

    try {
      const salt = await fetchCartesiSalt(mainWallet.address);
      const saltedIndex = subIndex + (parseInt(String(salt).replace(/^0x/, '').slice(0, 8), 16) % (2 ** 31 - 1));
      const derived = await deriveSubWallet(mainMnemonic, saltedIndex);

      const newSub = {
        index: derived.index,
        address: derived.address,
        locked: false,
        balance: '0',
        vaultAddress: null,
        depositTxHash: null,
        sweepTxHash: null,
        pendingVaultAddress: null,
        locking: false,
        vaultBalance: null,
      };
      setSubWallets((prev) => [...prev, newSub]);
      setSubIndex((prev) => prev + 1);

      // Copy index for easy paste into notes / regen
      try {
        await navigator.clipboard.writeText(String(derived.index));
        toast.success(
          `Sub-wallet created · index ${derived.index} (copied) · ${String(derived.address).slice(0, 10)}…`,
          { duration: 6000 },
        );
      } catch {
        toast.success(
          `Sub-wallet created · index ${derived.index} — click index to copy`,
          { duration: 6000 },
        );
      }
      await refreshSubBalance(derived.address);
    } catch (err) {
      console.error(err);
      toast.error('Failed to generate sub-wallet: ' + (err.message || err));
    }
  };

  const regenerateSubWallet = async () => {
    if (!mainMnemonic) return toast.error('Main mnemonic required');
    if (!regenIndex || isNaN(regenIndex)) return toast.error('Enter a valid index number');

    const saltedIndex = Number(regenIndex);

    try {
      const derived = await deriveSubWallet(mainMnemonic, saltedIndex);

      setSubWallets((prev) => {
        const filtered = prev.filter((s) => s.index !== saltedIndex);
        return [
          ...filtered,
          {
            index: derived.index,
            address: derived.address,
            locked: false,
            balance: '0',
            vaultAddress: null,
            depositTxHash: null,
            sweepTxHash: null,
            pendingVaultAddress: null,
            locking: false,
            vaultBalance: null,
          },
        ];
      });

      if (saltedIndex >= subIndex) {
        setSubIndex(saltedIndex + 1);
      }

      toast.success('Sub-wallet regenerated!');
      await refreshSubBalance(derived.address);
      setRegenIndex('');
    } catch (err) {
      console.error(err);
      toast.error('Failed to regenerate sub-wallet: ' + (err.message || err));
    }
  };

  const depositToSub = async (sub) => {
    const amount = subDeposits[sub.index]?.trim();
    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return toast.error('Enter a valid amount');
    }
    if (!l1Address) {
      return toast.error('Connect MetaMask (L1) first — vault lock needs your L1 owner address');
    }
    if (!mainWallet?.address) {
      return toast.error('Main Warthog wallet required');
    }

    setIsDepositing(prev => ({ ...prev, [sub.index]: true }));
    setLoading(true);
    const toastId = toast.loading('Checking main spendable balance…');

    try {
      // DeFi nodes reserve unconfirmed outs in wart.mempool — total can look like 10
      // while only ~1 is free. Check spendable before signing.
      const mainBal = await fetchBalanceAndNonce(mainWallet.address, true);
      const spendable = Number(mainBal?.spendable ?? mainBal?.balance ?? 0);
      const mempool = Number(mainBal?.mempool ?? 0);
      const feeEst = 0.01; // matches fee passed to sendTransaction below
      const need = Number(amount) + feeEst;
      if (!(spendable >= need)) {
        const msg =
          mempool > 0
            ? `Main spendable ${spendable.toFixed(8)} WART (mempool holds ${mempool.toFixed(8)}). ` +
              `Need ~${need.toFixed(8)} for amount+fee. Wait for pending txs to confirm, or send ≤ spendable.`
            : `Main spendable ${spendable.toFixed(8)} WART — need ~${need.toFixed(8)} (amount + fee).`;
        throw new Error(msg);
      }

      toast.loading('Step 2a: sending WART main → sub…', { id: toastId });
      const txData = await sendTransaction(
        mainWallet.privateKey,
        mainWallet.address,
        sub.address,
        amount,
        '0.01'
      );

      const txHash = txData?.data?.txHash || txData?.txHash || txData?.hash;
      if (!txHash) {
        throw new Error(
          'No tx hash received (node may have rejected — check main spendable vs mempool)',
        );
      }

      toast.success('Step 2a: WART main → sub sent. Posting sub_lock…', { id: toastId });

      setSubWallets(prev =>
        prev.map(s =>
          s.index === sub.index
            ? { ...s, balance: (Number(s.balance || 0) + Number(amount)).toFixed(8), depositTxHash: txHash }
            : s
        )
      );

      setSubDeposits(prev => ({ ...prev, [sub.index]: '' }));

      // Send sub_lock immediately (Cartesi pending vault + deposit proof)
      let vaultAddress = await sendSubLock(sub, txHash);
      // Notice poll can lag GraphQL even when rollup already accepted sub_lock —
      // recover vault from any recent notice for this sub.
      if (!vaultAddress) {
        vaultAddress = await getVaultAddressForSub(sub.address);
      }
      if (vaultAddress) {
        setSubWallets(prev =>
          prev.map(s =>
            s.address === sub.address
              ? { ...s, pendingVaultAddress: vaultAddress, locking: true, depositTxHash: txHash }
              : s,
          ),
        );
        setActiveDepositTxs(prev => ({ ...prev, [sub.index]: txHash }));
        toast.success(
          'Step 2b: sub_lock accepted — vault pending. Wait for confirmations, then Sweep (step 4).',
          { id: toastId, duration: 6000 },
        );
      } else {
        // WART is on the sub; rollup may still have accepted sub_lock (check cartesi logs).
        // react-hot-toast has no toast.warning — use blank toast.
        setActiveDepositTxs(prev => ({ ...prev, [sub.index]: txHash }));
        toast(
          'WART reached sub and sub_lock was submitted. Vault address not in GraphQL yet — wait, then Show Vault / Sweep.',
          { id: toastId, duration: 8000, icon: '⏳' },
        );
      }

      await refreshSubBalance(sub.address);

      // Fetch and set vault balance after deposit
      if (vaultAddress) {
        try {
          // isForSub=true so vault lookup never overwrites main header balance
          const vaultBalanceData = await fetchBalanceAndNonce(vaultAddress, true);
          setSubWallets(prev =>
            prev.map(s => s.address === sub.address ? { ...s, vaultBalance: vaultBalanceData.balance || '0' } : s)
          );
        } catch (err) {
          console.error('Failed to fetch vault balance:', err);
        }
      }
    } catch (err) {
      toast.error('Deposit failed: ' + (err.message || err), { id: toastId, duration: 8000 });
    } finally {
      setIsDepositing(prev => ({ ...prev, [sub.index]: false }));
      setLoading(false);
      setAutoLockPhase(prev => ({ ...prev, [sub.index]: null }));
    }
  };

  // Simplified: Send sub_lock and poll for pending notice
  const sendSubLock = async (sub, txHash) => {
    if (!l1Address) {
      toast.error('Connect MetaMask (L1) before locking — owner address required');
      return null;
    }
    if (!txHash) {
      toast.error('Missing deposit tx hash for lock proof');
      return null;
    }
    if (sub.index === undefined || sub.index === null) {
      toast.error('Invalid sub-wallet index');
      return null;
    }
    try {
      const proof = await getWartTxProof(txHash);
      if (!proof) throw new Error('Empty Warthog tx proof');

      // Multi-sig vault only — must exist from Load / create vault
      if (!mainMnemonic) throw new Error('Mnemonic required');
      const mainAddr = mainWallet?.address || address;
      const localShare = loadTwoPartyClientLocal(mainAddr, sub.address);
      let vaultAddress =
        sub.vaultAddress ||
        sub.pendingVaultAddress ||
        localShare?.vaultAddress ||
        null;
      if (!vaultAddress) {
        throw new Error(
          'No multi-sig vault — click Load / create vault first (2P-ECDSA keygen)',
        );
      }
      vaultAddress = String(vaultAddress).replace(/^0x/i, '').toLowerCase();

      await send({
        type: 'sub_lock',
        subAddress: sub.address,
        proof,
        index: sub.index,
        recipient: l1Address,
        vaultAddress,
        multisig: true,
        scheme: localShare?.scheme || MULTISIG_SCHEME,
      });
      const pendingNotice = await pollForPendingNotice(sub.address);
      return pendingNotice?.vaultAddress || vaultAddress;
    } catch (err) {
      console.error('sendSubLock error:', err.message);
      toast.error('sub_lock failed: ' + (err.message || err));
      return null;
    }
  };

  /**
   * Resolve multi-sig vault address for a sub without requiring main→sub deposit.
   * Peer / external funds on the sub are fine — vault identity is independent of deposit origin.
   */
  const resolveVaultAddressForSweep = (sub) => {
    const mainAddr = mainWallet?.address || address;
    const localShare = mainAddr
      ? loadTwoPartyClientLocal(mainAddr, sub.address)
      : null;
    const raw =
      sub.vaultAddress ||
      sub.pendingVaultAddress ||
      localShare?.vaultAddress ||
      null;
    if (!raw) return null;
    return String(raw).replace(/^0x/i, '').toLowerCase();
  };

  /**
   * Sweep any WART currently on the sub → vault, then rollup sweep_lock mints spoofed wWART 1:1.
   * Does NOT require a prior main→sub deposit or sub_lock. Funds may come from:
   *   main→sub, peer→sub, faucet, or any other inbound to the sub address.
   */
  const sweepToVault = async (sub, amountArg) => {
    if (!mainMnemonic) {
      toast.error('Seed phrase required to sign from the sub-wallet', { duration: 5000 });
      return;
    }
    if (!l1Address) {
      toast.error('Connect MetaMask (L1) — sweep_lock needs the rollup owner', { duration: 5000 });
      return;
    }
    if (!send) {
      toast.error('Rollup send() missing — connect MetaMask on WalletIsland', { duration: 5000 });
      return;
    }

    let vaultAddress = resolveVaultAddressForSweep(sub);
    if (!vaultAddress) {
      toast.error(
        'No vault yet — click Load / create vault first, then sweep any sub balance (external sends OK)',
        { duration: 7000 },
      );
      return;
    }

    setIsSweeping((prev) => ({ ...prev, [sub.index]: true }));
    setSubWallets((prev) =>
      prev.map((s) =>
        s.index === sub.index
          ? {
              ...s,
              locking: false, // never block direct fund on deposit "locking" flag
              vaultAddress,
              pendingVaultAddress: vaultAddress,
            }
          : s,
      ),
    );
    setLoading(true);
    const toastId = toast.loading('Refreshing live sub balance…');

    try {
      // Live spendable on sub — UI cache is often stale after peer deposits
      const live = await fetchBalanceAndNonce(sub.address, true);
      const liveTotal = String(live.balance || '0');
      const liveSpendable = String(live.spendable || live.balance || '0');
      setSubWallets((prev) =>
        prev.map((s) =>
          s.index === sub.index
            ? { ...s, balance: liveTotal, spendable: liveSpendable }
            : s,
        ),
      );

      // Leave fee room (node min is tiny; keep conservative 0.01 default like other paths)
      const feeWart = '0.01';
      let maxSend = 0;
      try {
        const spendE8 = BigInt(wartToE8String(liveSpendable));
        const feeE8 = BigInt(wartToE8String(feeWart));
        maxSend = Number(e8ToWartDisplay(spendE8 > feeE8 ? spendE8 - feeE8 : 0n));
      } catch {
        maxSend = Math.max(0, Number(liveSpendable) - Number(feeWart));
      }

      let amount = String(amountArg ?? subSweepAmounts[sub.index] ?? '').trim();
      if (!amount || amount === 'max') {
        amount = String(maxSend);
        setSubSweepAmounts((prev) => ({ ...prev, [sub.index]: amount }));
      }
      if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
        throw new Error(
          `Enter a sweep amount. Live free on sub: ${liveSpendable} WART (max sendable ≈ ${maxSend} after fee)`,
        );
      }
      if (Number(amount) > Number(liveSpendable)) {
        setSubSweepAmounts((prev) => ({ ...prev, [sub.index]: String(maxSend) }));
        throw new Error(
          `Insufficient sub free balance (live free ${liveSpendable}, need ${amount}). Amount set to max ≈ ${maxSend}.`,
        );
      }
      if (Number(amount) > maxSend + 1e-12) {
        setSubSweepAmounts((prev) => ({ ...prev, [sub.index]: String(maxSend) }));
        throw new Error(
          `Leave fee room: max sendable ≈ ${maxSend} WART (free ${liveSpendable} − fee ${feeWart})`,
        );
      }

      toast.loading(
        `Sweeping ${amount} WART sub → vault (any source OK)…`,
        { id: toastId },
      );

      const subPrivateKey = deriveSubPrivateKey(mainMnemonic, sub.index);
      const txData = await sendTransaction(
        subPrivateKey,
        sub.address,
        vaultAddress,
        amount,
        feeWart,
      );

      if (!txData) {
        throw new Error(
          'Warthog transfer failed (see red error — often mempool/spendable or wrong key)',
        );
      }

      const sweepTxHash = txData?.data?.txHash || txData?.txHash || txData?.hash;
      if (!sweepTxHash) throw new Error('No sweep tx hash from node');

      setSubWallets((prev) =>
        prev.map((s) => (s.index === sub.index ? { ...s, sweepTxHash } : s)),
      );

      toast.loading('Waiting for sweep confirmations…', { id: toastId });
      const sweepConfirmed = await pollTxConfirmations(sweepTxHash, 2);
      if (!sweepConfirmed) throw new Error('Sweep not confirmed in time — check Warthog node');

      const sweepProof = await getWartTxProof(sweepTxHash);
      if (!sweepProof) throw new Error('Empty sweep proof from node');

      toast.loading('MetaMask sweep_lock (lock WART 1:1)…', { id: toastId });
      // Backend accepts without prior sub_lock (direct-sweep path)
      await postSweepLock(sub, vaultAddress, sweepProof, toastId);
    } catch (err) {
      console.error('sweepToVault error:', err);
      toast.error('Sweep failed: ' + (err.message || err), { id: toastId, duration: 9000 });
      setSubWallets((prev) =>
        prev.map((s) => (s.index === sub.index ? { ...s, locking: false } : s)),
      );
    } finally {
      setIsSweeping((prev) => ({ ...prev, [sub.index]: false }));
      setLoading(false);
    }
  };

  /** Normalize Warthog address to 40-hex account id for notice matching. */
  const wartAccountId = (addr) =>
    String(addr || '')
      .replace(/^0x/i, '')
      .toLowerCase()
      .slice(0, 40);

  /** Live L1 inspect outstandingE8 (authoritative pin after re-lock). */
  const fetchInspectOutstandingE8 = async (ownerL1 = l1Address) => {
    const bare = String(ownerL1 || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    if (bare.length !== 40) return null;
    try {
      const base = getInspectUrl().replace(/\/$/, '');
      const res = await fetch(`${base}/vault/${bare}`, { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      const payload = data?.reports?.[0]?.payload;
      if (!payload) return null;
      let json;
      try {
        if (typeof payload === 'string' && payload.trim().startsWith('{')) {
          json = JSON.parse(payload);
        } else {
          json = JSON.parse(toUtf8String(payload));
        }
      } catch {
        const hex = String(payload).replace(/^0x/i, '');
        json = JSON.parse(
          new TextDecoder().decode(
            new Uint8Array(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16))),
          ),
        );
      }
      if (json?.error) return null;
      if (json?.outstandingE8 == null) return null;
      return BigInt(String(json.outstandingE8));
    } catch {
      return null;
    }
  };

  /** Post sweep_lock + poll (shared by full sweep and retry-mint). */
  const postSweepLock = async (sub, vaultAddress, sweepProof, toastId) => {
    let prevOutstanding = 0n;
    try {
      prevOutstanding = BigInt(String(sub.mintedE8 || '0'));
    } catch {
      prevOutstanding = 0n;
    }
    // Snapshot notice stream so we only accept a *new* sweep_locked (not historical)
    let seenFingerprints = new Set();
    try {
      const snap = await rebuildOutstandingE8FromNotices(sub.address, {
        last: 200,
        collectFingerprints: true,
      });
      if (snap?.outstandingE8 != null) {
        try {
          prevOutstanding = BigInt(String(snap.outstandingE8));
        } catch {
          /* */
        }
      }
      if (snap?.lockFingerprints) seenFingerprints = new Set(snap.lockFingerprints);
    } catch {
      /* */
    }

    // Include vaultAddress + owner so rollup can recover if pendingLocks was lost
    // (cartesi restart) or user only ran create_vault without sub_lock.
    await send({
      type: 'sweep_lock',
      subAddress: sub.address,
      sweepProof,
      index: sub.index,
      vaultAddress: vaultAddress,
      owner: l1Address,
      recipient: l1Address,
    });

    const pollStart = Date.now();
    const completed = await pollForLockNotice(sub.address, {
      timeoutMs: 90000,
      sinceMs: pollStart - 5000,
      prevOutstandingE8: prevOutstanding,
      seenFingerprints,
    });

    // Resolve outstanding with retries — notices lag after unlock→re-lock
    let nextMinted = prevOutstanding;
    let resolved = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const rebuilt = await rebuildOutstandingE8FromNotices(sub.address, { last: 200 });
        if (rebuilt?.outstandingE8 != null) {
          const o = BigInt(String(rebuilt.outstandingE8));
          // Accept if pin increased (re-lock) or any positive after success notice
          if (o > prevOutstanding || (completed && o > 0n)) {
            nextMinted = o;
            resolved = true;
            break;
          }
        }
      } catch {
        /* */
      }
      try {
        const insp = await fetchInspectOutstandingE8(l1Address);
        if (insp != null && (insp > prevOutstanding || (completed && insp > 0n))) {
          nextMinted = insp;
          resolved = true;
          break;
        }
      } catch {
        /* */
      }
      if (attempt < 7) await new Promise((r) => setTimeout(r, 2000));
    }

    // Last resort: if notice completed but rebuild stuck at 0, re-query inspect once more
    if (!resolved || nextMinted === 0n) {
      try {
        const insp = await fetchInspectOutstandingE8(l1Address);
        if (insp != null && insp > 0n) {
          nextMinted = insp;
          resolved = true;
        }
      } catch {
        /* */
      }
    }

    if (completed || resolved || nextMinted > prevOutstanding) {
      const nextStr = nextMinted.toString();
      setSubWallets((prev) =>
        prev.map((s) => {
          if (s.index !== sub.index) return s;
          return {
            ...s,
            locked: nextMinted > 0n,
            locking: false,
            vaultAddress: vaultAddress,
            pendingVaultAddress: vaultAddress,
            mintedE8: nextStr,
          };
        }),
      );
      await refreshSubBalance(sub.address);
      try {
        const vaultBalanceData = await fetchBalanceAndNonce(vaultAddress, true);
        if (vaultBalanceData?.ok !== false) {
          setSubWallets((prev) =>
            prev.map((s) =>
              s.index === sub.index
                ? {
                    ...s,
                    vaultBalance: String(
                      vaultBalanceData.balance ?? vaultBalanceData.spendable ?? '0',
                    ),
                    vaultSpendable: String(
                      vaultBalanceData.spendable ??
                        vaultBalanceData.balance ??
                        '0',
                    ),
                    vaultBalanceAt: Date.now(),
                  }
                : s,
            ),
          );
          toast.success(
            `Vault balance: ${vaultBalanceData.balance || vaultBalanceData.spendable || '0'} WART`,
            { duration: 4000 },
          );
        }
      } catch {
        /* ignore */
      }
      if (nextMinted > 0n) {
        toast.success(
          `Step 4 done: locked ${e8ToWartDisplay(nextMinted)} WART as collateral — release to free withdrawable.`,
          { id: toastId, duration: 7000 },
        );
      } else {
        toast.error(
          'sweep_lock accepted but outstanding still 0 — Refresh L1 vault / wait for notice index, then retry mint.',
          { id: toastId, duration: 9000 },
        );
      }
      try {
        onRefreshL1Vault?.();
      } catch {
        /* */
      }
    } else {
      toast.error(
        'sweep_lock submitted but lock notice not seen — check cartesi logs / GraphQL',
        { id: toastId, duration: 7000 },
      );
      setSubWallets((prev) =>
        prev.map((s) => (s.index === sub.index ? { ...s, locking: false } : s)),
      );
    }
  };

  /**
   * WART already on vault (sweep tx mined) but rollup rejected mint —
   * re-post sweep_lock only with proof from known tx hash.
   */
  const retryMintSpoofedWwart = async (sub) => {
    const vaultAddress = (sub.vaultAddress || sub.pendingVaultAddress || '')
      .toString()
      .replace(/^0x/i, '')
      .toLowerCase();
    const txHash = sub.sweepTxHash;
    if (!vaultAddress) return toast.error('No vault address');
    if (!txHash) {
      return toast.error(
        'No sweep tx hash saved — enter the Warthog sweep hash after rebuild, or sweep a new amount',
        { duration: 7000 },
      );
    }
    if (!l1Address || !send) return toast.error('Connect MetaMask (L1) first');

    setIsSweeping((prev) => ({ ...prev, [sub.index]: true }));
    setLoading(true);
    const toastId = toast.loading('Retry mint: fetching sweep proof…');
    try {
      const sweepProof = await getWartTxProof(txHash);
      if (!sweepProof) throw new Error('Empty proof for ' + txHash);
      toast.loading('Retry mint: MetaMask sweep_lock…', { id: toastId });
      await postSweepLock(sub, vaultAddress, sweepProof, toastId);
    } catch (err) {
      toast.error('Retry mint failed: ' + (err.message || err), { id: toastId, duration: 8000 });
      setSubWallets((prev) =>
        prev.map((s) => (s.index === sub.index ? { ...s, locking: false } : s)),
      );
    } finally {
      setIsSweeping((prev) => ({ ...prev, [sub.index]: false }));
      setLoading(false);
    }
  };

  /**
   * Withdraw vault → main via multi-sig 2P only (cosigner + user half).
   * Force UI unlock only clears local flags — does not restore cosigner shares.
   */
  const withdrawVaultToMain = async (sub) => {
    const vaultAddr = (sub.vaultAddress || sub.pendingVaultAddress || '')
      .toString()
      .replace(/^0x/i, '')
      .toLowerCase();
    if (!vaultAddr) return toast.error('No vault address — Load / create vault first');
    if (!mainMnemonic) return toast.error('Mnemonic required for vault spend');
    if (!address && !mainWallet?.address) {
      return toast.error('Main Warthog address required as recipient');
    }

    // Live pin from rollup — never trust stale localStorage / Force UI unlock alone.
    // (Historical subwallet_unlocked + re-lock used to leave mintedE8=0 and open full withdraw.)
    let outstandingE8 = 0n;
    try {
      const rebuilt = await rebuildOutstandingE8FromNotices(sub.address);
      if (rebuilt?.outstandingE8 != null) {
        outstandingE8 = BigInt(String(rebuilt.outstandingE8));
      }
    } catch {
      try {
        outstandingE8 = BigInt(sub.mintedE8 || '0');
      } catch {
        outstandingE8 = 0n;
      }
    }
    // Also prefer L1 inspect snapshot when parent passed it (authoritative dApp counters)
    try {
      const inspOut = l1Vault?.outstandingE8;
      if (inspOut != null && BigInt(String(inspOut)) > outstandingE8) {
        outstandingE8 = BigInt(String(inspOut));
      }
    } catch {
      /* */
    }
    // Keep UI in sync with live pin
    setSubWallets((prev) =>
      prev.map((s) =>
        s.index === sub.index
          ? {
              ...s,
              mintedE8: outstandingE8.toString(),
              locked: outstandingE8 > 0n,
            }
          : s,
      ),
    );

    const mainAddr = mainWallet?.address || address;

    setIsVaultWithdrawing((prev) => ({ ...prev, [sub.index]: true }));
    setLoading(true);
    const toastId = toast.loading('Refreshing live vault balance…');

    try {
      const liveBal = await fetchBalanceAndNonce(vaultAddr, true);
      const liveTotal = String(liveBal.balance || '0');
      const liveSpendable = String(liveBal.spendable || liveBal.balance || '0');
      setSubWallets((prev) =>
        prev.map((s) =>
          s.index === sub.index
            ? {
                ...s,
                vaultBalance: liveTotal,
                vaultSpendable: liveSpendable,
                vaultBalanceAt: Date.now(),
                mintedE8: outstandingE8.toString(),
                locked: outstandingE8 > 0n,
              }
            : s,
        ),
      );

      if (Number(liveSpendable) <= 0 && Number(liveTotal) <= 0) {
        throw new Error(
          'Vault balance is 0 on Warthog — nothing to withdraw (funds may already be moved or wrong address).',
        );
      }

      let freeable = liveSpendable;
      if (outstandingE8 > 0n) {
        try {
          const balE8 = BigInt(wartToE8String(liveSpendable));
          const freeE8 = balE8 > outstandingE8 ? balE8 - outstandingE8 : 0n;
          freeable = e8ToWartDisplay(freeE8);
        } catch {
          freeable = freeableVaultWart({
            ...sub,
            vaultBalance: liveSpendable,
            mintedE8: outstandingE8.toString(),
          });
        }
      }
      if (outstandingE8 > 0n && Number(freeable) <= 0) {
        throw new Error(
          `Vault is pinned: ${e8ToWartDisplay(outstandingE8)} WART still locked as collateral ` +
            `(rollup outstanding / WLIQ capacity). Release locked WART first (burn/unlock spoofed), ` +
            `then withdraw freeable only. Force UI unlock does not free coins.`,
        );
      }

      let amount = (vaultWithdrawAmounts[sub.index] || '').trim();
      if (amount === 'max' || amount === '') {
        amount = freeable;
      }
      if (!amount || isNaN(amount) || Number(amount) <= 0) {
        throw new Error('Enter a valid vault withdraw amount');
      }
      if (Number(amount) > Number(liveSpendable)) {
        setVaultWithdrawAmounts((prev) => ({ ...prev, [sub.index]: liveSpendable }));
        throw new Error(
          `Insufficient vault balance: live free ${liveSpendable} WART` +
            (liveTotal !== liveSpendable ? ` (total ${liveTotal})` : '') +
            `, need ${amount}. Amount field set to live free — try again.`,
        );
      }
      if (outstandingE8 > 0n && Number(amount) > Number(freeable)) {
        setVaultWithdrawAmounts((prev) => ({ ...prev, [sub.index]: freeable }));
        throw new Error(
          `Only ${freeable} WART withdrawable (in vault ${liveSpendable} − locked collateral ${e8ToWartDisplay(outstandingE8)}).`,
        );
      }

      // --- Try multi-sig first ---
      const local = loadTwoPartyClientLocal(mainWallet?.address || address, sub.address);
      let multiSigTried = false;
      let multiSigErr = null;

      if (local?.encryptedClientSecret && l1Address) {
        multiSigTried = true;
        try {
          // Preflight: cosigner must know this vault (shares often lost on VPS redeploy)
          let needRestore = false;
          try {
            await cosignerStatus(vaultAddr);
          } catch (e) {
            const msg = String(e?.message || e);
            if (/unknown vault|404|not found/i.test(msg)) {
              needRestore = true;
            } else {
              throw e;
            }
          }

          // Unknown vault → browser no longer holds d_dapp; recovery is ops-only
          if (needRestore) {
            throw new Error(
              'COSIGNER_MISSING: Cosigner says Unknown vault (no d_dapp for this address). ' +
                'The browser does not store the cosigner half (split-key). ' +
                'Restore from ops cosigner backup (cosigner-restore.mjs), then retry. ' +
                'Multi-sig cannot sign this address without the server-side d_dapp. ' +
                'Will try legacy secret-derived key next — if this was a 2P multi-sig vault, ' +
                'only ops cosigner restore recovers the old address.',
            );
          }

          const clientSecret = await decryptJsonWithMnemonic(
            local.encryptedClientSecret,
            mainMnemonic,
          );
          // Transparent upgrade: re-wrap XOR-era secrets as AES-GCM v2
          if (!isAesGcmClientSecretBlob(local.encryptedClientSecret)) {
            try {
              const rewrapped = await encryptJsonWithMnemonic(clientSecret, mainMnemonic);
              saveTwoPartyClientLocal({
                mainAddress: mainWallet?.address || address,
                subAddress: sub.address,
                vaultAddress: vaultAddr,
                index: sub.index,
                encryptedClientSecret: rewrapped,
                scheme: MULTISIG_SCHEME,
              });
            } catch {
              /* non-fatal */
            }
          }
          toast.loading('Co-signer pin check + 2P-ECDSA multi-sig…', { id: toastId });
          const result = await multiSigTransferWart({
            nodeBase: selectedNode,
            vaultAddress: vaultAddr,
            toAddress: mainAddr,
            amountWart: amount,
            ownerL1: l1Address,
            subAddress: sub.address,
            clientSecret,
          });

          const txHash = result.txHash;
          if (!txHash) throw new Error('No tx hash from multi-sig submit');

          toast.success(`Multi-sig vault → main: ${String(txHash).slice(0, 12)}…`, {
            id: toastId,
            duration: 6000,
          });
          setVaultWithdrawAmounts((prev) => ({ ...prev, [sub.index]: '' }));

          const refreshed = await fetchBalanceAndNonce(vaultAddr, true);
          setSubWallets((prev) =>
            prev.map((s) =>
              s.index === sub.index
                ? {
                    ...s,
                    vaultBalance: refreshed.balance || refreshed.spendable || '0',
                    vaultSpendable: refreshed.spendable || refreshed.balance || '0',
                    vaultBalanceAt: Date.now(),
                  }
                : s,
            ),
          );
          return;
        } catch (e) {
          multiSigErr = e;
          console.warn('[vault withdraw] multi-sig failed', e);
          throw e;
        }
      }

      if (!local?.encryptedClientSecret) {
        throw new Error(
          'No 2P client secret on this browser for this sub. Load/create multi-sig vault first, ' +
            'or Import vault share. Cosigner 2P-ECDSA is required.',
        );
      }
      if (multiSigTried && multiSigErr) {
        throw multiSigErr;
      }
      throw new Error(
        'Multi-sig vault withdraw requires MetaMask L1 owner + cosigner. ' +
          (multiSigErr ? String(multiSigErr.message || multiSigErr).slice(0, 200) : ''),
      );
    } catch (err) {
      toast.error('Vault withdraw failed: ' + (err.message || err), {
        id: toastId,
        duration: 10000,
      });
    } finally {
      setIsVaultWithdrawing((prev) => ({ ...prev, [sub.index]: false }));
      setLoading(false);
    }
  };

  const withdrawToMain = async (sub) => {
    const amountStr = subWithdrawAmounts[sub.index] || '';
    const fee = subWithdrawFees[sub.index] || '0.01';

    let amount = amountStr === 'max' ? sub.balance : amountStr;

    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return toast.error('Enter a valid amount');
    }
    if (Number(amount) > Number(sub.balance || 0)) {
      return toast.error('Insufficient balance');
    }

    setIsWithdrawing(prev => ({ ...prev, [sub.index]: true }));
    setLoading(true);
    const toastId = toast.loading('Processing withdrawal...');

    try {
      if (!mainMnemonic) throw new Error('Main mnemonic required');

      const subPrivateKey = deriveSubPrivateKey(mainMnemonic, sub.index);

      const txData = await sendTransaction(
        subPrivateKey,           // ← now raw hex without 0x
        sub.address,
        address,                 // main wallet address
        amount,
        fee
      );

      const txHash = txData?.data?.txHash || txData?.txHash || txData?.hash;
      if (!txHash) throw new Error('No tx hash received');

      toast.success('Withdrawal sent!', { id: toastId });

      setSubWallets(prev =>
        prev.map(s =>
          s.index === sub.index
            ? { ...s, balance: (Number(s.balance || 0) - Number(amount)).toFixed(8) }
            : s
        )
      );

      setSubWithdrawAmounts(prev => ({ ...prev, [sub.index]: '' }));
      setSubWithdrawFees(prev => ({ ...prev, [sub.index]: '0.01' }));

      setTimeout(async () => {
        await refreshSubBalance(sub.address);
      }, 4000);

    } catch (err) {
      console.error('Withdraw error:', err);
      toast.error('Withdrawal failed: ' + (err.message || 'Unknown error'), { id: toastId });
    } finally {
      setIsWithdrawing(prev => ({ ...prev, [sub.index]: false }));
      setLoading(false);
    }
  };

  const setMaxWithdraw = (sub) => {
    setSubWithdrawAmounts(prev => ({
      ...prev,
      [sub.index]: sub.balance || '0'
    }));
  };

  /** Max main → sub from main wallet spendable (ETH-style fund row). */
  const setMaxDeposit = async (sub) => {
    try {
      if (!mainWallet?.address || !fetchBalanceAndNonce) return;
      const live = await fetchBalanceAndNonce(mainWallet.address, true);
      const free = String(live.spendable || live.balance || '0');
      const feeWart = 0.01;
      let maxStr = String(Math.max(0, Number(free) - feeWart));
      try {
        const spendE8 = BigInt(wartToE8String(free));
        const feeE8 = BigInt(wartToE8String('0.01'));
        maxStr = e8ToWartDisplay(spendE8 > feeE8 ? spendE8 - feeE8 : 0n);
      } catch {
        /* use Number path */
      }
      setSubDeposits((prev) => ({ ...prev, [sub.index]: maxStr }));
    } catch (e) {
      console.warn('setMaxDeposit', e);
    }
  };

  const setMaxSweep = async (sub) => {
    try {
      const live = await fetchBalanceAndNonce(sub.address, true);
      const free = String(live.spendable || live.balance || '0');
      const feeWart = 0.01;
      const maxSend = Math.max(0, Number(free) - feeWart);
      // Prefer 8-decimal string without FP noise when possible
      let maxStr = String(maxSend);
      try {
        const spendE8 = BigInt(wartToE8String(free));
        const feeE8 = BigInt(wartToE8String('0.01'));
        maxStr = e8ToWartDisplay(spendE8 > feeE8 ? spendE8 - feeE8 : 0n);
      } catch {
        /* use Number path */
      }
      setSubWallets((prev) =>
        prev.map((s) =>
          s.index === sub.index
            ? { ...s, balance: live.balance || free, spendable: free }
            : s,
        ),
      );
      setSubSweepAmounts((prev) => ({ ...prev, [sub.index]: maxStr }));
    } catch {
      setSubSweepAmounts((prev) => ({
        ...prev,
        [sub.index]: sub.balance || '0',
      }));
    }
  };
  /**
   * Wait for a *new* sweep_locked notice for this sub.
   * CRITICAL: never treat historical sweep_locked as success after unlock→re-lock
   * (that raced rebuild while outstanding still 0 → sticky unlock UI).
   */
  const pollForLockNotice = async (subAddress, opts = {}) => {
    const timeoutMs = opts.timeoutMs ?? 45000;
    const sinceMs = opts.sinceMs ?? Date.now() - 15_000;
    const prevOutstandingE8 = opts.prevOutstandingE8 ?? 0n;
    const seenFingerprints = opts.seenFingerprints || new Set();
    const subId = wartAccountId(subAddress);
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const { notices } = await client.request(gql`
          { notices(last: 40) { edges { node { payload } } } }
        `);
        const parsed = (notices?.edges || [])
          .map((e) => parseNoticePayload(e.node.payload))
          .filter(Boolean);

        // Prefer newest-first scan of recent window
        for (let i = parsed.length - 1; i >= 0; i--) {
          const n = parsed[i];
          if (n.type !== 'sweep_locked') continue;
          const nSub = wartAccountId(n.subAddress);
          if (nSub && nSub !== subId) continue;
          // verified may be missing on older machines — do not require it alone
          const ts = n.timestamp != null ? Number(n.timestamp) : 0;
          const mint = n.mintedE8 != null ? String(n.mintedE8) : '';
          const fp = `${nSub}:${mint}:${ts}:${n.vaultAddress || ''}`;
          const isNewFp = mint && !seenFingerprints.has(fp);
          const isRecent = ts >= sinceMs || ts === 0; // 0 = no timestamp, allow if fingerprint new
          if (isNewFp && isRecent) {
            return true;
          }
        }

        // Also accept if outstanding already advanced (inspect/notice rebuild)
        try {
          const rebuilt = await rebuildOutstandingE8FromNotices(subAddress, { last: 200 });
          if (rebuilt && BigInt(String(rebuilt.outstandingE8)) > prevOutstandingE8) {
            return true;
          }
        } catch {
          /* */
        }
        try {
          const insp = await fetchInspectOutstandingE8(l1Address);
          if (insp != null && insp > prevOutstandingE8) return true;
        } catch {
          /* */
        }
      } catch {
        /* */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  };

  /**
   * Rebuild locked outstanding (E8) for a sub from full notice history.
   * minted = sum(sweep_locked.mintedE8), burned = sum(spoofed burns).
   *
   * CRITICAL: do NOT treat a historical `subwallet_unlocked` as permanent.
   * Unlock-then-re-lock (sweep_locked after full release) must restore pin:
   * outstanding = sum(mints) − sum(burns) across the whole stream.
   * A sticky fullyUnlocked flag left UI at 0 after re-locking 100 WART.
   */
  const rebuildOutstandingE8FromNotices = async (
    subAddress,
    { last = 200, collectFingerprints = false } = {},
  ) => {
    const subNorm = wartAccountId(subAddress);
    if (!subNorm) return null;
    const gqlClient = new GraphQLClient(getRollupGraphqlUrl());
    const { notices } = await gqlClient.request(gql`
      { notices(last: ${last}) { edges { node { payload } } } }
    `);
    let minted = 0n;
    let burned = 0n;
    let lastBurnNotice = null;
    // Chronological running pin (GraphQL last:N is oldest→newest on this stack)
    let runningOutstanding = 0n;
    const lockFingerprints = collectFingerprints ? [] : null;
    for (const e of notices?.edges || []) {
      const n = parseNoticePayload(e.node.payload);
      if (!n?.type) continue;
      // Match 40-hex account id (ignore checksum / case / 0x)
      const nSub = wartAccountId(n.subAddress);
      if (nSub && nSub !== subNorm) continue;
      if (n.type === 'sweep_locked' && n.mintedE8 != null) {
        try {
          const m = BigInt(String(n.mintedE8));
          minted += m;
          runningOutstanding += m; // re-lock after unlock re-pins
          if (lockFingerprints) {
            const ts = n.timestamp != null ? Number(n.timestamp) : 0;
            lockFingerprints.push(
              `${nSub}:${String(n.mintedE8)}:${ts}:${n.vaultAddress || ''}`,
            );
          }
        } catch {
          /* */
        }
      } else if (
        (n.type === 'spoofed_wwart_burned' || n.type === 'subwallet_unlocked') &&
        n.burnedE8 != null
      ) {
        try {
          const b = BigInt(String(n.burnedE8));
          burned += b;
          if (n.remainingMintedE8 != null && n.remainingMintedE8 !== '') {
            runningOutstanding = BigInt(String(n.remainingMintedE8));
          } else if (n.type === 'subwallet_unlocked') {
            runningOutstanding = 0n;
          } else {
            runningOutstanding =
              runningOutstanding > b ? runningOutstanding - b : 0n;
          }
        } catch {
          /* */
        }
        // Keep the newest burn notice (GraphQL last:N is oldest→newest on this stack)
        lastBurnNotice = n;
      } else if (n.type === 'subwallet_unlocked') {
        // Only zero running pin — do NOT clear mint/burn sums (re-lock still needs them)
        runningOutstanding = 0n;
        lastBurnNotice = n;
      }
    }
    // Prefer sum(mint−burn); running stream is a cross-check for remainingMintedE8 paths
    const bySum = minted > burned ? minted - burned : 0n;
    // After unlock→re-lock, if remainingMintedE8 stream is higher (edge race), take max
    const outstandingE8 = bySum > runningOutstanding ? bySum : runningOutstanding;
    return {
      outstandingE8: outstandingE8.toString(),
      mintedE8: minted.toString(),
      burnedE8: burned.toString(),
      lastBurnNotice,
      runningOutstandingE8: runningOutstanding.toString(),
      fullyUnlocked: outstandingE8 === 0n,
      ...(lockFingerprints ? { lockFingerprints } : {}),
    };
  };

  /**
   * Wait for a burn/unlock notice that advances state past prevOutstandingE8.
   * IMPORTANT: GraphQL `notices(last:N)` is chronological (oldest first) here —
   * never `.find()` the first match (that reuses an older partial burn forever).
   */
  const pollForBurnNotice = async (
    subAddress,
    {
      fullUnlock = false,
      timeoutMs = 60000,
      prevOutstandingE8 = null,
      expectBurnedE8 = null,
    } = {},
  ) => {
    const start = Date.now();
    const subNorm = String(subAddress).replace(/^0x/i, '').toLowerCase();
    const prev =
      prevOutstandingE8 != null && prevOutstandingE8 !== ''
        ? BigInt(String(prevOutstandingE8))
        : null;
    const expectBurn =
      expectBurnedE8 != null && expectBurnedE8 !== ''
        ? BigInt(String(expectBurnedE8))
        : null;

    while (Date.now() - start < timeoutMs) {
      try {
        // Prefer full rebuild — survives multi-release history
        const rebuilt = await rebuildOutstandingE8FromNotices(subAddress);
        if (rebuilt) {
          if (fullUnlock && rebuilt.fullyUnlocked) {
            return (
              rebuilt.lastBurnNotice || {
                type: 'subwallet_unlocked',
                remainingMintedE8: '0',
                burnedE8: rebuilt.burnedE8,
                verified: true,
                subAddress: subNorm,
              }
            );
          }
          if (!fullUnlock && prev != null) {
            const out = BigInt(rebuilt.outstandingE8);
            // Progress: outstanding dropped, or full unlock
            if (out < prev || rebuilt.fullyUnlocked) {
              return (
                rebuilt.lastBurnNotice || {
                  type: out === 0n ? 'subwallet_unlocked' : 'spoofed_wwart_burned',
                  remainingMintedE8: rebuilt.outstandingE8,
                  burnedE8: expectBurn != null ? expectBurn.toString() : rebuilt.burnedE8,
                  verified: true,
                  subAddress: subNorm,
                }
              );
            }
          }
          // No prev baseline: accept newest burn if present
          if (!fullUnlock && prev == null && rebuilt.lastBurnNotice) {
            return rebuilt.lastBurnNotice;
          }
        }

        // Fallback: newest matching notice in the window (last element, not first)
        const gqlClient = new GraphQLClient(getRollupGraphqlUrl());
        const { notices } = await gqlClient.request(gql`
          { notices(last: 40) { edges { node { payload } } } }
        `);
        const parsed = (notices?.edges || [])
          .map((e) => parseNoticePayload(e.node.payload))
          .filter(Boolean);
        const hits = parsed.filter((n) => {
          const sa = String(n.subAddress || '').replace(/^0x/i, '').toLowerCase();
          if (sa !== subNorm || n.verified === false) return false;
          if (fullUnlock) return n.type === 'subwallet_unlocked';
          return n.type === 'spoofed_wwart_burned' || n.type === 'subwallet_unlocked';
        });
        if (hits.length) {
          // Prefer: match expected burn amount → else highest timestamp → else last in list
          let hit = hits[hits.length - 1];
          if (expectBurn != null) {
            const matchBurn = [...hits].reverse().find((n) => {
              try {
                return BigInt(String(n.burnedE8 || '0')) === expectBurn;
              } catch {
                return false;
              }
            });
            if (matchBurn) hit = matchBurn;
          } else {
            const byTs = [...hits].sort(
              (a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0),
            );
            if (byTs[0]) hit = byTs[0];
          }
          if (prev != null && hit.remainingMintedE8 != null) {
            try {
              if (BigInt(String(hit.remainingMintedE8)) >= prev && hit.type !== 'subwallet_unlocked') {
                // Stale older notice — keep polling
                hit = null;
              }
            } catch {
              /* accept */
            }
          }
          if (hit) return hit;
        }
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
  };

  /** Human WART decimal → E8 integer string for sub_unlock.burnAmt */
  const wartToE8String = (wartStr) => {
    const s = String(wartStr || '').trim();
    if (!s) throw new Error('Empty amount');
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Invalid amount');
    const [w, f = ''] = s.split('.');
    const frac = (f + '00000000').slice(0, 8);
    return (BigInt(w || '0') * 100000000n + BigInt(frac || '0')).toString();
  };

  const e8ToWartDisplay = (e8) => {
    try {
      const bn = BigInt(e8 || 0);
      const whole = bn / 100000000n;
      let frac = (bn % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
      return frac ? `${whole}.${frac}` : whole.toString();
    } catch {
      return '0';
    }
  };

  /**
   * Withdrawable native WART after partial burns (1:1 collateral).
   * withdrawable ≈ max(0, vaultBalance − outstandingSpoofed).
   * Burn 30 of 99 → outstanding 69, vault 99 → withdrawable 30.
   * Prefer live vaultBalance; fall back to vaultSpendable only when balance missing.
   */
  const freeableVaultWart = (sub) => {
    try {
      const balStr =
        sub.vaultBalance != null && sub.vaultBalance !== ''
          ? String(sub.vaultBalance)
          : String(sub.vaultSpendable || '0');
      const balE8 = BigInt(wartToE8String(balStr));
      const outE8 = BigInt(sub.mintedE8 || '0');
      const freeE8 = balE8 > outE8 ? balE8 - outE8 : 0n;
      return e8ToWartDisplay(freeE8);
    } catch {
      return '0';
    }
  };

  /** Client-side outstanding locked collateral (E8). Not source of truth after rollup wipe. */
  const outstandingE8Of = (sub) => {
    try {
      return BigInt(sub?.mintedE8 || '0');
    } catch {
      return 0n;
    }
  };

  /**
   * UI lock status. "Pending sweep" must NOT show merely because pendingVaultAddress
   * is still set after unlock — postSweepLock leaves it equal to vaultAddress forever.
   */
  const vaultLockStatus = (sub) => {
    let outstanding = outstandingE8Of(sub);
    // Heal sticky unlock: L1 inspect pin wins when local mintedE8 is stale 0
    try {
      if (l1Vault?.outstandingE8 != null) {
        const insp = BigInt(String(l1Vault.outstandingE8));
        if (insp > outstanding) outstanding = insp;
      }
    } catch {
      /* */
    }
    if (sub.locked || outstanding > 0n) {
      return {
        key: 'locked',
        label:
          outstanding > 0n && !sub.locked
            ? 'Collateral residual 🔒'
            : 'Locked 🔒',
        className: 'status-locked',
      };
    }
    // Mid deposit/sweep only: vault assigned, not locked, still in locking flow
    if (sub.locking || (sub.pendingVaultAddress && !sub.vaultAddress)) {
      return { key: 'pending', label: 'Pending sweep ⏳', className: 'status-unlocked' };
    }
    return { key: 'unlocked', label: 'Unlocked 🔓', className: 'status-unlocked' };
  };

  /**
   * Clear client-only lock/collateral fields after rollup wipe or Force Unlock.
   * Keeps vault address + balances so vault → main still works.
   */
  const clearClientLockState = (subLike) => ({
    locked: false,
    locking: false,
    mintedE8: '0',
    // Promote pending → vault so status is Unlocked, not false "Pending sweep"
    vaultAddress: subLike.vaultAddress || subLike.pendingVaultAddress || null,
    pendingVaultAddress: subLike.vaultAddress || subLike.pendingVaultAddress || null,
  });

  const parseNoticePayload = (payload) => {
    if (payload == null) return null;
    try {
      // GraphQL usually returns 0x-hex; some proxies return plain JSON string
      if (typeof payload === 'string' && payload.trim().startsWith('{')) {
        return JSON.parse(payload);
      }
      return JSON.parse(toUtf8String(payload));
    } catch {
      try {
        // hex without 0x
        const hex = String(payload).replace(/^0x/i, '');
        if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
          const bytes = new Uint8Array(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
          return JSON.parse(new TextDecoder().decode(bytes));
        }
      } catch {
        /* ignore */
      }
      return null;
    }
  };

  const pollForPendingNotice = async (subAddress, timeoutMs = 60000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const { notices } = await client.request(gql`
          { notices(last: 20) { edges { node { payload } } } }
        `);
        const parsed = notices.edges
          .map((e) => parseNoticePayload(e.node.payload))
          .filter(Boolean);
        const notice = parsed.find(
          (n) => n.type === 'subwallet_pending' && n.subAddress === subAddress,
        );
        if (notice) return notice;
      } catch (err) {
        console.warn('[pollForPendingNotice]', err?.message || err);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  };

  const pollTxConfirmations = async (txHash, requiredConfirmations = 2) => {
    let attempts = 0;
    const maxAttempts = 60; // 5 mins at 5s
    while (attempts < maxAttempts) {
      try {
        const api = await createWarthogApi(selectedNode);
        const lookupRes = await api.getNodePath(`transaction/lookup/${txHash}`);
        if (lookupRes.success) {
          const { blockHeight, confirmations } = getTxConfirmationStatus(lookupRes.data);
          if (blockHeight !== undefined && confirmations >= requiredConfirmations) {
            return true;
          }
        }
      } catch (err) {
        console.error('Poll tx error:', err);
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
      attempts++;
    }
    return false;
  };

  /** All vault addresses ever seen for this sub (notices + local 2P store). */
  const collectVaultCandidatesForSub = async (sub) => {
    const subId = wartAccountId(sub?.address);
    const out = [];
    const push = (a) => {
      const h = String(a || '')
        .replace(/^0x/i, '')
        .toLowerCase();
      if (h.length >= 40 && !out.includes(h)) out.push(h);
    };
    push(sub?.vaultAddress);
    push(sub?.pendingVaultAddress);
    try {
      const local = loadTwoPartyClientLocal(
        mainWallet?.address || address,
        sub?.address,
      );
      push(local?.vaultAddress);
    } catch {
      /* */
    }
    try {
      const gqlClient = new GraphQLClient(getRollupGraphqlUrl());
      const { notices } = await gqlClient.request(gql`
        { notices(last: 200) { edges { node { payload } } } }
      `);
      for (const e of notices?.edges || []) {
        const n = parseNoticePayload(e.node.payload);
        if (!n?.vaultAddress) continue;
        if (
          ![
            'subwallet_pending',
            'sweep_locked',
            'subwallet_unlocked',
            'vault_created',
            'spoofed_wwart_burned',
            'release_ticket',
          ].includes(n.type)
        ) {
          continue;
        }
        const nSub = wartAccountId(n.subAddress);
        if (subId && nSub && nSub !== subId) continue;
        push(n.vaultAddress);
      }
    } catch {
      /* GraphQL optional */
    }
    return out;
  };

  /**
   * Live vault address + balance for a sub (explicit load / refresh only).
   * Respects dismissed vaults and vaultDetached — never force a vault the user hid.
   */
  const resolveLiveVaultBalanceForSub = async (sub, { allowSwitch = false } = {}) => {
    // User hid vault on this sub — do not re-pin
    if (sub?.vaultDetached) return null;

    const preferred = String(sub?.vaultAddress || sub?.pendingVaultAddress || '')
      .replace(/^0x/i, '')
      .toLowerCase();

    // Default: only refresh the currently attached vault
    if (preferred.length >= 40 && !allowSwitch) {
      if (isVaultDismissed(preferred)) return null;
      try {
        const vb = await fetchBalanceAndNonce(preferred, true);
        if (vb?.ok === false) return null;
        return {
          vaultAddress: preferred,
          balance: String(vb.balance ?? '0'),
          spendable: String(vb.spendable ?? vb.balance ?? '0'),
          totalE8: (() => {
            try {
              return BigInt(wartToE8String(String(vb.balance ?? '0')));
            } catch {
              return 0n;
            }
          })(),
        };
      } catch {
        return null;
      }
    }

    const candidates = (await collectVaultCandidatesForSub(sub)).filter(
      (a) => !isVaultDismissed(a),
    );
    if (!candidates.length) return null;

    let best = null;
    for (const vaultAddress of candidates) {
      try {
        const vb = await fetchBalanceAndNonce(vaultAddress, true);
        if (vb?.ok === false) continue;
        let totalE8 = 0n;
        try {
          totalE8 = BigInt(wartToE8String(String(vb.balance ?? '0')));
        } catch {
          totalE8 = 0n;
        }
        const row = {
          vaultAddress,
          balance: String(vb.balance ?? '0'),
          spendable: String(vb.spendable ?? vb.balance ?? '0'),
          totalE8,
        };
        if (!best || row.totalE8 > best.totalE8) best = row;
      } catch {
        /* try next */
      }
    }
    return best;
  };

  /**
   * Discover vaults that have notice history for this L1 owner / local subs
   * but are not currently shown on a loaded sub vault card.
   */
  const discoverUnloadedVaults = async () => {
    setUnloadedBusy(true);
    try {
      const ownerBare = String(l1Address || '')
        .replace(/^0x/i, '')
        .toLowerCase();
      const loadedVaultIds = new Set(
        (subWallets || [])
          .flatMap((s) => [s.vaultAddress, s.pendingVaultAddress])
          .map((a) =>
            String(a || '')
              .replace(/^0x/i, '')
              .toLowerCase(),
          )
          .filter((a) => a.length >= 40),
      );
      const localSubIds = new Set(
        (subWallets || [])
          .map((s) => wartAccountId(s.address))
          .filter((a) => a && a.length === 40),
      );

      /** @type {Map<string, { vaultAddress: string, subAddress: string|null, subIndex: number|null, lastType: string|null, lastAt: number|null }>} */
      const byVault = new Map();

      try {
        const gqlClient = new GraphQLClient(getRollupGraphqlUrl());
        const { notices } = await gqlClient.request(gql`
          { notices(last: 200) { edges { node { payload } } } }
        `);
        for (const e of notices?.edges || []) {
          const n = parseNoticePayload(e.node.payload);
          if (!n?.type || !n.vaultAddress) continue;
          const vault = String(n.vaultAddress)
            .replace(/^0x/i, '')
            .toLowerCase();
          if (vault.length < 40) continue;
          const nOwner = String(n.owner || '')
            .replace(/^0x/i, '')
            .toLowerCase();
          const nSub = wartAccountId(n.subAddress);
          const ownerMatch = ownerBare && nOwner && nOwner === ownerBare;
          const subMatch = nSub && localSubIds.has(nSub);
          // Keep vaults tied to this session (L1 owner or a known sub)
          if (!ownerMatch && !subMatch) continue;
          if (
            ![
              'vault_created',
              'subwallet_pending',
              'sweep_locked',
              'subwallet_unlocked',
              'spoofed_wwart_burned',
              'release_ticket',
            ].includes(n.type)
          ) {
            continue;
          }
          const ts = n.timestamp != null ? Number(n.timestamp) : Date.now();
          let subIndex = null;
          if (n.subIndex != null && n.subIndex !== '') {
            const si = Number(n.subIndex);
            if (Number.isFinite(si)) subIndex = si;
          } else if (n.index != null && n.index !== '') {
            const si = Number(n.index);
            if (Number.isFinite(si)) subIndex = si;
          }
          const prev = byVault.get(vault);
          if (!prev || (ts && (!prev.lastAt || ts >= prev.lastAt))) {
            byVault.set(vault, {
              vaultAddress: vault,
              subAddress: nSub || prev?.subAddress || null,
              subIndex: subIndex ?? prev?.subIndex ?? null,
              lastType: n.type,
              lastAt: ts || prev?.lastAt || null,
            });
          } else {
            if (prev && !prev.subAddress && nSub) prev.subAddress = nSub;
            if (prev && prev.subIndex == null && subIndex != null) prev.subIndex = subIndex;
          }
        }
      } catch (e) {
        console.warn('[unloaded vaults] notices scan failed', e?.message || e);
      }

      // Also surface 2P local shares not attached to a visible vault card
      try {
        if (typeof localStorage !== 'undefined') {
          const main = String(mainWallet?.address || address || '')
            .replace(/^0x/i, '')
            .toLowerCase();
          if (main) {
            // keys: cartesi-bridge-msig2p-user-v1:${main}:${sub}
            const prefix = `cartesi-bridge-msig2p-user-v1:${main}:`;
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              if (!key || !key.startsWith(prefix)) continue;
              try {
                const raw = localStorage.getItem(key);
                const parsed = raw ? JSON.parse(raw) : null;
                const vault = String(parsed?.vaultAddress || '')
                  .replace(/^0x/i, '')
                  .toLowerCase();
                const sub = wartAccountId(
                  parsed?.subAddress || key.slice(prefix.length),
                );
                if (vault.length < 40) continue;
                let subIndex = null;
                if (parsed?.index != null && parsed.index !== '') {
                  const si = Number(parsed.index);
                  if (Number.isFinite(si)) subIndex = si;
                }
                if (!byVault.has(vault)) {
                  byVault.set(vault, {
                    vaultAddress: vault,
                    subAddress: sub || null,
                    subIndex,
                    lastType: 'local_share',
                    lastAt: parsed?.savedAt || null,
                  });
                } else {
                  const prev = byVault.get(vault);
                  if (prev && prev.subIndex == null && subIndex != null) {
                    prev.subIndex = subIndex;
                  }
                }
              } catch {
                /* */
              }
            }
          }
        }
      } catch {
        /* */
      }

      // Cosigner registry — vaults with d_dapp for this L1 owner even when
      // rollup notices are missing (e.g. funded vault with only cosigner row).
      if (l1Address) {
        try {
          const listed = await cosignerListByOwner(l1Address);
          for (const row of listed?.vaults || []) {
            const vault = String(row.vault || row.vaultAddress || '')
              .replace(/^0x/i, '')
              .toLowerCase();
            if (vault.length < 40) continue;
            // Skip lab/test fake subs (all-c from unit tests)
            const sub = wartAccountId(row.subAddress);
            if (sub && /^c{40}$/i.test(sub)) continue;
            let subIndex = null;
            if (row.index != null && row.index !== '') {
              const si = Number(row.index);
              if (Number.isFinite(si)) subIndex = si;
            }
            const prev = byVault.get(vault);
            if (!prev) {
              byVault.set(vault, {
                vaultAddress: vault,
                subAddress: sub || null,
                subIndex,
                lastType: 'cosigner',
                lastAt: row.createdAt != null ? Number(row.createdAt) : null,
              });
            } else {
              if (!prev.subAddress && sub) prev.subAddress = sub;
              if (prev.subIndex == null && subIndex != null) prev.subIndex = subIndex;
              if (!prev.lastType) prev.lastType = 'cosigner';
            }
          }
        } catch (e) {
          console.warn('[unloaded vaults] cosigner list failed', e?.message || e);
        }
      }

      const rows = [];
      for (const entry of byVault.values()) {
        const loaded = loadedVaultIds.has(entry.vaultAddress);
        let balance = '—';
        let spendable = '—';
        try {
          const vb = await fetchBalanceAndNonce(entry.vaultAddress, true);
          if (vb?.ok !== false) {
            balance = String(vb.balance ?? '0');
            spendable = String(vb.spendable ?? vb.balance ?? '0');
          }
        } catch {
          /* */
        }
        rows.push({
          ...entry,
          balance,
          spendable,
          loaded,
          dismissed: isVaultDismissed(entry.vaultAddress),
        });
      }

      // Sort: unloaded first, then by balance desc, then recent activity
      rows.sort((a, b) => {
        if (a.dismissed !== b.dismissed) return a.dismissed ? 1 : -1;
        if (a.loaded !== b.loaded) return a.loaded ? 1 : -1;
        const ae = (() => {
          try {
            return BigInt(wartToE8String(String(a.balance === '—' ? '0' : a.balance)));
          } catch {
            return 0n;
          }
        })();
        const be = (() => {
          try {
            return BigInt(wartToE8String(String(b.balance === '—' ? '0' : b.balance)));
          } catch {
            return 0n;
          }
        })();
        if (ae !== be) return be > ae ? 1 : -1;
        return (b.lastAt || 0) - (a.lastAt || 0);
      });

      setUnloadedVaults(rows);
    } finally {
      setUnloadedBusy(false);
    }
  };

  /**
   * Attach a discovered vault address to its HD sub.
   * If the HD index is known but the sub is missing from the list, regenerate it
   * from the seed first (same as Regen with that index).
   */
  const loadDiscoveredVaultOntoSub = async (entry) => {
    const vault = String(entry.vaultAddress || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    if (vault.length < 40) return toast.error('Invalid vault address');

    const subId = wartAccountId(entry.subAddress);
    let target =
      (subId &&
        (subWallets || []).find((s) => wartAccountId(s.address) === subId)) ||
      null;

    // Match by known HD index
    if (!target && entry.subIndex != null && Number.isFinite(Number(entry.subIndex))) {
      const want = Number(entry.subIndex);
      target = (subWallets || []).find((s) => Number(s.index) === want) || null;
    }

    // Regen missing sub from seed when cosigner/notices know the index
    if (
      !target &&
      entry.subIndex != null &&
      Number.isFinite(Number(entry.subIndex)) &&
      mainMnemonic
    ) {
      const want = Number(entry.subIndex);
      const toastId = toast.loading(`Regenerating sub #${want} from seed…`);
      try {
        const derived = await deriveSubWallet(mainMnemonic, want);
        if (!derived?.address) throw new Error('derive failed');
        // Verify address matches notice/cosigner sub if we have one
        if (subId && wartAccountId(derived.address) !== subId) {
          toast.error(
            `Index #${want} derives a different sub than this vault’s record — check seed`,
            { id: toastId, duration: 8000 },
          );
          return;
        }
        undismissVaultAddress(vault);
        setSubWallets((prev) => {
          const filtered = prev.filter((s) => Number(s.index) !== want);
          return [
            ...filtered,
            {
              index: derived.index,
              address: derived.address,
              balance: null,
              spendable: null,
              locked: false,
              locking: false,
              vaultAddress: vault,
              pendingVaultAddress: vault,
              vaultBalance: entry.balance !== '—' ? entry.balance : null,
              vaultSpendable: entry.spendable !== '—' ? entry.spendable : null,
              vaultBalanceAt: Date.now(),
              vaultDetached: false,
              mintedE8: '0',
              hidden: false,
            },
          ];
        });
        setShowHiddenSubs(true);
        toast.success(
          `Sub #${want} restored · vault ${vault.slice(0, 10)}…` +
            (entry.balance && entry.balance !== '—'
              ? ` · ${entry.balance} WART`
              : '') +
            ' — still need that vault’s user share for multi-sig withdraw.',
          { id: toastId, duration: 8000 },
        );
        discoverUnloadedVaults().catch(() => {});
        return;
      } catch (e) {
        toast.error('Could not regen sub: ' + (e?.message || e), {
          id: toastId,
          duration: 7000,
        });
        return;
      }
    }

    // Fallback: sub that already has this vault, or first visible sub
    if (!target) {
      target =
        (subWallets || []).find(
          (s) =>
            String(s.vaultAddress || s.pendingVaultAddress || '')
              .replace(/^0x/i, '')
              .toLowerCase() === vault,
        ) ||
        (subWallets || []).find((s) => !s.hidden) ||
        (subWallets || [])[0] ||
        null;
    }

    if (!target) {
      const idxHint =
        entry.subIndex != null
          ? ` Use Sub wallets → Regen index ${entry.subIndex}, then Load again.`
          : ' Generate a sub or Import vault share first.';
      return toast.error('No sub wallet to attach.' + idxHint, { duration: 8000 });
    }

    undismissVaultAddress(vault);
    setSubWallets((prev) =>
      prev.map((s) =>
        s.index === target.index
          ? {
              ...s,
              vaultAddress: vault,
              pendingVaultAddress: vault,
              vaultBalance: entry.balance !== '—' ? entry.balance : s.vaultBalance,
              vaultSpendable:
                entry.spendable !== '—' ? entry.spendable : s.vaultSpendable,
              vaultBalanceAt: Date.now(),
              vaultDetached: false,
              hidden: false,
            }
          : s,
      ),
    );
    setShowHiddenSubs(true);
    // Focus that sub in the pager
    setTimeout(() => {
      setActiveSubPos(0);
      setSubWallets((prev) => {
        const list = prev.filter((s) => !s.hidden);
        const idx = list.findIndex((s) => s.index === target.index);
        if (idx >= 0) setActiveSubPos(idx);
        return prev;
      });
    }, 50);

    toast.success(
      `Loaded vault ${vault.slice(0, 10)}… on sub #${target.index}` +
        (entry.balance && entry.balance !== '—'
          ? ` · ${entry.balance} WART`
          : '') +
        ' — Import vault share if you need multi-sig withdraw (d_user).',
      { duration: 7000 },
    );
    discoverUnloadedVaults().catch(() => {});
  };

  const getVaultAddressForSub = async (subAddress) => {
    try {
      const subId = wartAccountId(subAddress);
      // Recreate client each call so origin is always current (and absolute)
      const gqlClient = new GraphQLClient(getRollupGraphqlUrl());
      const { notices } = await gqlClient.request(gql`
        { notices(last: 80) { edges { node { payload } } } }
      `);
      const parsed = (notices?.edges || [])
        .map((e) => parseNoticePayload(e.node.payload))
        .filter(Boolean);
      const relevant = parsed.filter((n) => {
        if (!n.vaultAddress) return false;
        if (
          !['subwallet_pending', 'sweep_locked', 'subwallet_unlocked', 'vault_created'].includes(
            n.type,
          )
        ) {
          return false;
        }
        const nSub = wartAccountId(n.subAddress);
        return !nSub || nSub === subId;
      });
      if (relevant.length > 0) {
        // GraphQL last:N is oldest→newest on this stack — take the LAST match
        const latest = relevant[relevant.length - 1];
        return String(latest.vaultAddress).replace(/^0x/i, '').toLowerCase();
      }
    } catch (err) {
      console.error('getVaultAddressForSub error:', err);
    }
    return null;
  };

  /** Poll GraphQL until vault appears (sub_lock pending or create_vault). */
  const pollForVaultAddress = async (subAddress, timeoutMs = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const addr = await getVaultAddressForSub(subAddress);
      if (addr) return addr;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
  };

  /**
   * Load / create 2P-ECDSA multi-sig vault (full private key never stored).
   */
  /**
   * Detach multi-sig vault from this sub only. Sub stays fully usable for a new vault.
   * Does not hide the sub wallet, does not move on-chain funds.
   */
  const dismissVaultFromSub = (sub) => {
    const displayed = sub.vaultAddress || sub.pendingVaultAddress;
    if (!displayed) {
      toast('No vault on this sub');
      return;
    }
    const v = String(displayed)
      .replace(/^0x/i, '')
      .toLowerCase();
    dismissVaultAddress(v);
    setSubWallets((prev) =>
      prev.map((s) =>
        s.address === sub.address || s.index === sub.index
          ? {
              ...s,
              vaultAddress: null,
              pendingVaultAddress: null,
              vaultBalance: null,
              vaultSpendable: null,
              vaultBalanceAt: null,
              vaultDetached: true,
              // keep sub visible and ready for new vault / fund / sweep
              hidden: false,
              locked: false,
              locking: false,
              mintedE8: '0',
            }
          : s,
      ),
    );
    setCheckedVault((prev) => ({ ...prev, [sub.index]: false }));
    toast.success(
      `Vault dismissed from sub #${sub.index} — sub kept for new vaults. ` +
        'Old vault stays under Unloaded (Dismiss there if you have no d_user).',
      { duration: 7000 },
    );
    discoverUnloadedVaults().catch(() => {});
  };

  const loadOrCreateVault = async (sub) => {
    const displayed = sub.vaultAddress || sub.pendingVaultAddress;
    if (displayed) {
      // Prefer explicit dismiss (does not hide sub)
      dismissVaultFromSub(sub);
      return;
    }

    const toastId = toast.loading('2P-ECDSA multi-sig keygen (Paillier)…');
    try {
      if (!mainMnemonic) {
        toast.error('Seed required to encrypt 2P client secret', { id: toastId });
        return;
      }
      if (!l1Address) {
        toast.error('Connect MetaMask (L1) for multi-sig owner', { id: toastId });
        return;
      }

      // Creating / restoring a vault clears detached flag on this sub
      setSubWallets((prev) =>
        prev.map((s) =>
          s.index === sub.index ? { ...s, vaultDetached: false } : s,
        ),
      );

      const mainAddr = mainWallet?.address || address;
      let vaultAddr = null;
      const vaultScheme = MULTISIG_SCHEME;

      const existing = loadTwoPartyClientLocal(mainAddr, sub.address);
      let cosignerOk = false;
      if (existing?.vaultAddress) {
        vaultAddr = existing.vaultAddress;
        toast.loading('Restored 2P client secret — checking cosigner…', { id: toastId });
        const { cosignerStatus } = await import('../utils/cosignerClient.js');
        try {
          await cosignerStatus(vaultAddr);
          cosignerOk = true;
        } catch (e) {
          // Client only has d_user; cosigner holds d_dapp. If cosigner store was
          // wiped, this vault cannot sign — re-keygen is required (new address).
          // Do NOT treat proxy/upstream errors as "unknown vault" (that wiped
          // valid local shares when /api/cosigner accidentally used local fallback).
          const msg = String(e?.message || e);
          if (
            /unknown vault|Unknown vault/i.test(msg) &&
            !/unreachable|502|503|ECONNREFUSED|fetch failed|network/i.test(msg)
          ) {
            console.warn(
              `[2p-ecdsa] Cosigner has no material for ${vaultAddr}; clearing local and re-keygen`,
            );
            clearTwoPartyClientLocal(mainAddr, sub.address);
            vaultAddr = null;
            toast.loading(
              'Cosigner lost vault share — creating new 2P vault…',
              { id: toastId },
            );
          } else {
            throw new Error(
              `Cosigner check failed: ${msg}. ` +
                `If this is a network/proxy error, fix /api/cosigner → COSIGNER_UPSTREAM ` +
                `(do not re-keygen — your vault may still be valid).`,
            );
          }
        }
      }

      if (!cosignerOk) {
        const vault = await createTwoPartyVault({
          subAddress: sub.address,
          index: sub.index,
          owner: l1Address,
        });
        vaultAddr = vault.address;
        // User half only in browser. Cosigner half is sent once to cosigner below, never stored client-side.
        const enc = await encryptJsonWithMnemonic(vault.clientSecret, mainMnemonic);
        saveTwoPartyClientLocal({
          mainAddress: mainAddr,
          subAddress: sub.address,
          vaultAddress: vault.address,
          index: sub.index,
          encryptedClientSecret: enc,
          scheme: vault.scheme,
        });

        // Offline opaque user-vault-share.txt — user half only (WartBunker-style password blob).
        try {
          let password;
          try {
            password = promptVaultSharePassword('encrypt');
          } catch (e) {
            toast.error(String(e?.message || e));
            password = null;
          }
          if (password) {
            const plain = buildVaultSharePlainPayload({
              mainAddress: mainAddr,
              subAddress: sub.address,
              vaultAddress: vault.address,
              index: sub.index,
              clientSecret: vault.clientSecret,
              scheme: vault.scheme,
              ownerL1: l1Address,
            });
            const fname = downloadVaultShareBackupFile(plain, password);
            toast.success(
              `Save offline: ${fname} — user half only. Cosigner half is only on the cosigner (ops backup).`,
              { duration: 10000 },
            );
          } else {
            toast(
              'Vault created — use Download vault share for user-vault-share.txt (password) when ready.',
              { duration: 9000 },
            );
          }
        } catch (backupErr) {
          console.warn('[vault-share] auto-download failed', backupErr);
          toast(
            'Vault created — download user-vault-share.txt from Vault card when ready.',
            { duration: 9000 },
          );
        }

        toast.loading('Registering 2P material with co-signer (no full key)…', { id: toastId });
        await registerMultiSigVault({
          ...vault.cosignerRegister,
          owner: l1Address.toLowerCase(),
          subAddress: sub.address,
          index: sub.index,
          // Destination allowlist: vault may only multi-sig-send to main Warthog
          mainAddress: mainAddr,
          allowedTo: [mainAddr],
        });
      }

      if (send) {
        toast.loading('Registering multi-sig vault on Cartesi…', { id: toastId });
        await send({
          type: 'create_vault',
          subAddress: sub.address,
          index: sub.index,
          owner: l1Address,
          vaultAddress: vaultAddr,
          multisig: true,
          scheme: vaultScheme,
        });
        await pollForVaultAddress(sub.address, 12000);
      }

      const vaultBalanceData = await fetchBalanceAndNonce(vaultAddr, true);
      setSubWallets((prev) =>
        prev.map((s) =>
          s.address === sub.address
            ? {
                ...s,
                vaultAddress: vaultAddr,
                pendingVaultAddress: vaultAddr,
                vaultBalance: vaultBalanceData.balance || '0',
                vaultSpendable:
                  vaultBalanceData.spendable || vaultBalanceData.balance || '0',
                vaultBalanceAt: Date.now(),
                vaultScheme,
                multisig: true,
                locking: false,
              }
            : s,
        ),
      );
      setCheckedVault((prev) => ({ ...prev, [sub.index]: true }));
      toast.success(
        `2P-ECDSA vault ${vaultAddr.slice(0, 12)}… — full key never stored · save ${VAULT_SHARE_DOWNLOAD_NAME} offline`,
        { id: toastId, duration: 7000 },
      );
    } catch (err) {
      toast.error(`Multi-sig vault failed: ${err.message || err}`, {
        id: toastId,
        duration: 8000,
      });
    }
  };

  /**
   * Live lock pin for a sub. Prefer mint−burn rebuild (handles unlock→re-lock).
   * Do NOT use "first notice in last:N" — GraphQL is oldest→newest, so that
   * always saw the first historical sweep_locked and stuck locked/unlocked wrong.
   */
  const isSubLocked = async (subAddress) => {
    try {
      const rebuilt = await rebuildOutstandingE8FromNotices(subAddress, { last: 200 });
      if (rebuilt) return BigInt(String(rebuilt.outstandingE8 || '0')) > 0n;
    } catch {
      /* fall through */
    }
    try {
      const insp = await fetchInspectOutstandingE8(l1Address);
      if (insp != null) return insp > 0n;
    } catch {
      /* */
    }
    return false;
  };

  /**
   * Burn spoofed wWART for this sub-lock (partial or full).
   * @param {object} sub
   * @param {{ amountWart?: string, burnAll?: boolean }} opts
   */
  const requestBurnUnlock = async (sub, { amountWart, burnAll = false } = {}) => {
    if (!l1Address) {
      return toast.error('Connect MetaMask (L1) before burning — lock owner must sign');
    }
    if (!send) return toast.error('Connect MetaMask on WalletIsland');
    if (!sub.locked && !sub.mintedE8) {
      return toast.error('No active lock / locked WART on this sub');
    }

    const outstandingE8 = BigInt(sub.mintedE8 || '0');
    if (outstandingE8 <= 0n && !burnAll) {
      return toast.error('No locked WART to release on this sub');
    }

    // Max freeable so capacity stays ≥ Used (matches backend solvency rule).
    let maxFreeableE8 = outstandingE8;
    try {
      const cap = computeWliqMintAvailable(l1Vault);
      const used18 = cap.liquid18 + cap.claim18;
      if (cap.capacity18 > 0n && used18 > 0n) {
        const free18 = cap.capacity18 > used18 ? cap.capacity18 - used18 : 0n;
        const freeE8 = free18 / 10n ** 10n;
        if (freeE8 < maxFreeableE8) maxFreeableE8 = freeE8;
      }
    } catch {
      /* backend still enforces */
    }

    let burnE8;
    try {
      if (burnAll || amountWart === 'max' || amountWart === '') {
        if (maxFreeableE8 <= 0n) {
          return toast.error(
            'Cannot release: Used ≥ Capacity. Burn wWART/WLIQ claims on Home first.',
            { duration: 8000 },
          );
        }
        if (maxFreeableE8 < outstandingE8) {
          // Cap "release all" to free headroom so backend accepts
          burnE8 = maxFreeableE8.toString();
          toast(
            `Release capped to ${e8ToWartDisplay(maxFreeableE8)} WART (keep capacity ≥ Used). Burn claims to free more.`,
            { duration: 8000 },
          );
        } else {
          burnE8 = outstandingE8 > 0n ? outstandingE8.toString() : null;
        }
      } else {
        burnE8 = wartToE8String(amountWart);
        if (outstandingE8 > 0n && BigInt(burnE8) > outstandingE8) {
          return toast.error(
            `Can only release up to ${e8ToWartDisplay(outstandingE8)} locked WART on this vault`,
            { duration: 6000 },
          );
        }
        if (BigInt(burnE8) > maxFreeableE8) {
          return toast.error(
            `Release blocked: max ${e8ToWartDisplay(maxFreeableE8)} WART freeable while Used claims remain. Burn wWART/WLIQ first.`,
            { duration: 9000 },
          );
        }
      }
    } catch (e) {
      return toast.error(e.message || 'Invalid burn amount');
    }

    const isFull =
      burnAll ||
      !burnE8 ||
      (outstandingE8 > 0n && BigInt(burnE8) >= outstandingE8);

    setIsUnlocking((prev) => ({ ...prev, [sub.index]: true }));
    setLoading(true);
    const toastId = toast.loading(
      isFull
        ? 'Releasing all locked WART & unlocking…'
        : `Releasing ${amountWart} locked WART…`,
    );

    try {
      await send({
        type: 'sub_unlock',
        subAddress: sub.address,
        ...(burnE8 != null ? { burnAmt: String(burnE8) } : {}),
      });

      toast.loading('Waiting for burn notice…', { id: toastId });
      const notice = await pollForBurnNotice(sub.address, {
        fullUnlock: isFull,
        prevOutstandingE8: outstandingE8.toString(),
        expectBurnedE8: burnE8,
      });

      if (!notice) {
        toast.error('Release submitted but notice not seen — check rollup / refresh', {
          id: toastId,
          duration: 7000,
        });
        return;
      }

      // Always rebuild from full history — a single notice can be an older partial burn
      // (GraphQL last:N is oldest→newest; stale .find() left UI at 8 after releasing 6→2).
      let remaining;
      let fullyUnlocked;
      try {
        const rebuilt = await rebuildOutstandingE8FromNotices(sub.address);
        if (rebuilt) {
          remaining = rebuilt.outstandingE8;
          fullyUnlocked = rebuilt.fullyUnlocked;
        }
      } catch {
        /* fall through */
      }
      if (remaining == null) {
        remaining =
          notice.remainingMintedE8 != null
            ? String(notice.remainingMintedE8)
            : isFull
              ? '0'
              : (outstandingE8 - BigInt(burnE8 || 0)).toString();
        fullyUnlocked = remaining === '0' || notice.type === 'subwallet_unlocked';
      }

      setSubWallets((prev) =>
        prev.map((s) =>
          s.index === sub.index
            ? {
                ...s,
                locked: !fullyUnlocked,
                mintedE8: remaining,
              }
            : s,
        ),
      );
      setBurnAmounts((prev) => ({ ...prev, [sub.index]: '' }));

      const vAddr = sub.vaultAddress || sub.pendingVaultAddress;
      if (vAddr) {
        // Retry live vault balance — never persist a failed fetch as "0"
        let liveVault = null;
        for (let i = 0; i < 4; i++) {
          try {
            const vb = await fetchBalanceAndNonce(vAddr, true);
            if (vb?.ok !== false && vb?.balance != null) {
              liveVault = vb;
              break;
            }
          } catch {
            /* */
          }
          await new Promise((r) => setTimeout(r, 800));
        }
        if (liveVault) {
          setSubWallets((prev) =>
            prev.map((s) =>
              s.index === sub.index
                ? {
                    ...s,
                    vaultBalance: String(liveVault.balance ?? liveVault.spendable ?? s.vaultBalance ?? '0'),
                    vaultSpendable: String(
                      liveVault.spendable ?? liveVault.balance ?? s.vaultSpendable ?? '0',
                    ),
                    vaultBalanceAt: Date.now(),
                  }
                : s,
            ),
          );
        }
      }

      if (fullyUnlocked) {
        toast.success(
          'Fully unlocked — coins still on vault address. Use Vault → main to withdraw.',
          { id: toastId, duration: 7000 },
        );
      } else {
        const freeHint = (() => {
          try {
            const balE8 = BigInt(wartToE8String(String(sub.vaultBalance || '0')));
            const rem = BigInt(remaining);
            return e8ToWartDisplay(balE8 > rem ? balE8 - rem : 0n);
          } catch {
            return '?';
          }
        })();
        toast.success(
          `Released. Locked remaining ${e8ToWartDisplay(remaining)}; ~${freeHint} WART withdrawable`,
          { id: toastId, duration: 8000 },
        );
      }
    } catch (err) {
      const msg = String(err?.message || err || '');
      const capacityHint =
        /reject|failed|revert/i.test(msg)
          ? ' If Capacity would fall under Used, burn wWART/WLIQ claims first (or release less).'
          : '';
      toast.error('Release failed: ' + msg + capacityHint, {
        id: toastId,
        duration: 10000,
      });
    } finally {
      setIsUnlocking((prev) => ({ ...prev, [sub.index]: false }));
      setLoading(false);
    }
  };

  /** @deprecated use requestBurnUnlock */
  const requestUnlock = (sub) => requestBurnUnlock(sub, { burnAll: true });

  /**
   * Post-restart recovery: client shows unlocked / nothing locked, but native WART
   * still sits on the vault. Clears local pin flags, optionally tries rollup Release
   * if L1 inspect still has outstanding, then vault → main for full live balance.
   */
  const recoverVaultToMainAfterRestart = async (sub) => {
    const vaultAddr = (sub.vaultAddress || sub.pendingVaultAddress || '')
      .toString()
      .replace(/^0x/i, '')
      .toLowerCase();
    if (!vaultAddr) return toast.error('No vault address');
    if (!mainMnemonic) return toast.error('Mnemonic required');
    if (!l1Address) return toast.error('Connect MetaMask (L1) for multi-sig cosign');

    setIsVaultWithdrawing((prev) => ({ ...prev, [sub.index]: true }));
    setLoading(true);
    const toastId = toast.loading('Recovery: checking live vault balance…');

    try {
      const liveBal = await fetchBalanceAndNonce(vaultAddr, true);
      const liveSpendable = String(liveBal.spendable || liveBal.balance || '0');
      if (Number(liveSpendable) <= 0) {
        throw new Error('Vault balance is 0 on Warthog — nothing to recover');
      }

      // Drop client-only lock so freeable math allows full spend
      setSubWallets((prev) =>
        prev.map((s) =>
          s.index === sub.index
            ? {
                ...s,
                ...clearClientLockState(s),
                vaultBalance: String(liveBal.balance || liveSpendable),
                vaultSpendable: liveSpendable,
                vaultBalanceAt: Date.now(),
              }
            : s,
        ),
      );

      // If rollup still pins capacity, try real Release first (Used must be 0)
      const inspOut = (() => {
        try {
          return BigInt(l1Vault?.outstandingE8 || '0');
        } catch {
          return 0n;
        }
      })();
      if (inspOut > 0n && send) {
        toast.loading(
          `Rollup still pins ${e8ToWartDisplay(inspOut)} — attempting Release all…`,
          { id: toastId },
        );
        try {
          await send({
            type: 'sub_unlock',
            subAddress: sub.address,
            burnAmt: inspOut.toString(),
          });
          await pollForBurnNotice(sub.address, { fullUnlock: true, timeoutMs: 45000 });
        } catch (e) {
          console.warn('[recover] sub_unlock', e);
          toast.loading(
            'Release skipped/failed — trying withdraw (cosigner uses live inspect pin)…',
            { id: toastId, duration: 5000 },
          );
        }
      }

      setVaultWithdrawAmounts((prev) => ({ ...prev, [sub.index]: liveSpendable }));
      // withdrawVaultToMain reads amount from state — pass via set then call after tick
      await new Promise((r) => setTimeout(r, 50));
      toast.loading(`Recovering ${liveSpendable} WART vault → main…`, { id: toastId });

      // Inline withdraw with outstanding forced to 0 so freeable = full balance
      const subForWithdraw = {
        ...sub,
        locked: false,
        mintedE8: '0',
        vaultBalance: liveSpendable,
        vaultSpendable: liveSpendable,
      };
      // Temporarily clear pin in map then withdraw
      setSubWallets((prev) =>
        prev.map((s) => (s.index === sub.index ? { ...s, ...subForWithdraw } : s)),
      );
      await withdrawVaultToMain(subForWithdraw);
    } catch (err) {
      toast.error('Recovery failed: ' + (err?.message || err), {
        id: toastId,
        duration: 10000,
      });
    } finally {
      setIsVaultWithdrawing((prev) => ({ ...prev, [sub.index]: false }));
      setLoading(false);
    }
  };

  /**
   * Live-refresh sub + vault balances from the Warthog node.
   * Vault address: prefer client state (always known after create), then GraphQL.
   * Never leave a stale vaultBalance when a vault address is known — GraphQL is
   * optional discovery only (empty after cartesi cache wipe).
   */
  const refreshSubBalance = async (subAddress) => {
    const subNorm = String(subAddress || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    const toastId = toast.loading('Fetching live balances from node…');
    try {
      const existing =
        subWallets.find(
          (s) =>
            String(s.address || '')
              .replace(/^0x/i, '')
              .toLowerCase() === subNorm,
        ) || null;

      const subBal = await fetchBalanceAndNonce(subAddress, true);
      // Outstanding pin from notices + inspect (not broken "first notice" lock check)
      let outstandingE8 = null;
      try {
        const rebuilt = await rebuildOutstandingE8FromNotices(subAddress, { last: 200 });
        if (rebuilt?.outstandingE8 != null) {
          outstandingE8 = BigInt(String(rebuilt.outstandingE8));
        }
      } catch {
        /* */
      }
      try {
        const insp = await fetchInspectOutstandingE8(l1Address);
        if (insp != null && (outstandingE8 == null || insp > outstandingE8)) {
          outstandingE8 = insp;
        }
      } catch {
        /* */
      }
      if (outstandingE8 == null) {
        try {
          outstandingE8 = BigInt(String(existing?.mintedE8 || '0'));
        } catch {
          outstandingE8 = 0n;
        }
      }
      const locked = outstandingE8 > 0n;

      const updates = {
        locked,
        mintedE8: outstandingE8.toString(),
        locking: false,
      };
      // Only apply sub balance if the node fetch succeeded
      if (subBal?.ok !== false) {
        updates.balance = subBal.balance || '0';
        updates.spendable = subBal.spendable || subBal.balance || '0';
      }

      // Resolve funded vault among candidates (local + notices + 2P share)
      try {
        const liveVault = await resolveLiveVaultBalanceForSub(
          existing || { address: subAddress },
        );
        if (liveVault) {
          updates.vaultAddress = liveVault.vaultAddress;
          updates.pendingVaultAddress = liveVault.vaultAddress;
          updates.vaultBalance = liveVault.balance;
          updates.vaultSpendable = liveVault.spendable;
          updates.vaultBalanceAt = Date.now();
        }
      } catch (e) {
        console.warn('[refreshSubBalance] vault resolve failed', e?.message || e);
      }

      setSubWallets((prev) =>
        prev.map((sub) => {
          const a = String(sub.address || '')
            .replace(/^0x/i, '')
            .toLowerCase();
          if (a !== subNorm) return sub;
          return { ...sub, ...updates };
        }),
      );

      const shownVault =
        updates.vaultBalance != null
          ? updates.vaultBalance
          : existing?.vaultBalance ?? null;
      const vaultMsg =
        shownVault != null
          ? ` · vault ${updates.vaultSpendable ?? shownVault} free / ${shownVault} total` +
            (updates.vaultAddress
              ? ` @ ${String(updates.vaultAddress).slice(0, 8)}…`
              : '')
          : ' · no vault balance resolved';
      toast.success(
        `Live node: sub ${updates.balance ?? existing?.balance ?? '?'} WART${vaultMsg}`,
        { id: toastId, duration: 4500 },
      );
    } catch (err) {
      console.error('refreshSubBalance', err);
      toast.error('Failed to refresh: ' + (err.message || err), {
        id: toastId,
        duration: 6000,
      });
    }
  };

  const inspectVault = async (vaultAddress) => {
    try {
      // L1 inspect is by Ethereum owner; Warthog vault is 48-hex (no 0x slice).
      // Prefer inspecting the L1 owner vault when we have it.
      const hex = String(vaultAddress || '').replace(/^0x/i, '').toLowerCase();
      const path =
        hex.length === 40
          ? `${getInspectUrl()}/vault/${hex}`
          : l1Address
            ? `${getInspectUrl()}/vault/${l1Address.slice(2).toLowerCase()}`
            : `${getInspectUrl()}/vault/${hex}`;
      const res = await fetch(path);
      const data = await res.json();
      if (data.reports?.length > 0) {
        const payload = JSON.parse(toUtf8String(data.reports[0].payload));
        toast.success(
          `L1 vault: Liquid ${payload.liquid}, wWART ${payload.wWART}, CTSI ${payload.CTSI}, ETH ${payload.eth}, USDC ${payload.usdc}`,
        );
      } else {
        toast('Vault data not available yet');
      }
    } catch (err) {
      toast.error('Failed to inspect vault');
    }
  };

  const getLockStatusText = (phase) => {
    if (phase === 'preparing') return 'Preparing deposit proof for sub_lock…';
    if (phase === 'fetching') return 'Waiting for Cartesi to index deposit…';
    if (phase === 'confirming') return 'Submitting sub_lock & waiting for notice…';
    if (phase === 'waiting_confirmations') return 'Step 3: waiting for main→sub deposit confirmations…';
    if (phase === 'sweeping') return 'Step 4: sweeping sub → vault…';
    return 'Securing sub-wallet (deposit path)…';
  };

  /**
   * Render vault card as a function (not an inner component).
   * Inner components remount on every keystroke and close <details> / blur inputs.
   */
  /** Import/download user half — must be available even when vault is hidden (no vault card body). */
  const renderVaultShareControls = (sub, { compact = false } = {}) => (
    <div
      className="sw-vault-share-backup"
      style={compact ? { marginTop: '0.5rem' } : undefined}
    >
      {!compact && (
        <p className="wh-hint sw-l1-track-hint" style={{ marginBottom: '0.5rem' }}>
          <strong>Vault share</strong> — restore an old multi-sig vault (e.g. funded address) with{' '}
          <code>{VAULT_SHARE_DOWNLOAD_NAME}</code>. Import works before Load; cosigner must still
          know that vault.
        </p>
      )}
      <div className="sw-row-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        <label
          className="btn secondary small"
          style={{ cursor: loading ? 'not-allowed' : 'pointer', margin: 0 }}
          title="Import user-vault-share.txt (password) into this browser"
        >
          Import vault share…
          <input
            type="file"
            accept=".txt,text/plain,application/json,.json"
            style={{ display: 'none' }}
            disabled={loading}
            onChange={(e) => {
              importVaultShareBackup(sub, e.target.files);
              e.target.value = '';
            }}
          />
        </label>
        <button
          type="button"
          className="btn secondary small"
          onClick={() => downloadVaultShareBackup(sub)}
          disabled={loading}
          title="Download password-encrypted user half for this sub’s current local vault"
        >
          Download vault share
        </button>
      </div>
    </div>
  );

  const renderVaultCard = (sub) => {
    const vaultAddr = sub.pendingVaultAddress || sub.vaultAddress;
    if (!vaultAddr) {
      // Create / load vault lives on the Sub wallets card — never hang Vault tab on empty create.
      return null;
    }

    const displayedVaultAddr = isSmallScreen
      ? `${vaultAddr.slice(0, 6)}…${vaultAddr.slice(-4)}`
      : vaultAddr;
    const st = vaultLockStatus(sub);
    const outE8 = outstandingE8Of(sub);
    const freeable = freeableVaultWart(sub);
    const totalInVault =
      sub.vaultBalance != null && sub.vaultBalance !== ''
        ? sub.vaultBalance
        : sub.vaultSpendable ?? '…';
    const canBurn = sub.locked || outE8 > 0n;
    const detailsKey = String(sub.index);
    const openVaultMain = openVaultPanels[detailsKey]?.vaultMain === true;
    const openBurn = openVaultPanels[detailsKey]?.burn === true;
    const openDetails = openVaultPanels[detailsKey]?.details === true;

    const lockedTag =
      sub.locked || outE8 > 0n ? (
        <span className="sw-live-tag"> · locked</span>
      ) : null;

    return (
      <div
        className={`sw-card sw-card--vault ${sub.locking ? 'is-busy' : ''}`}
      >
        <div className="sw-card-head">
          <h4 className="sw-card-title">
            WART vault
            {lockedTag}
          </h4>
          <div className="sw-card-head-right">
            <button
              type="button"
              className="sw-pill sw-pill-muted sw-pill-copy"
              title={`Copy sub index ${sub.index}`}
              onClick={() => copyToClipboard(String(sub.index), 'Sub index')}
            >
              {isSmallScreen ? `#${String(sub.index).slice(0, 6)}…` : `#${sub.index}`}
            </button>
            <span className={`sw-pill ${st.className}`}>{st.label}</span>
            {renderCardMenu(`vault:${sub.index}`, [
              {
                label: 'Copy vault address',
                onClick: () => copyToClipboard(vaultAddr, 'Vault address'),
              },
              {
                label: 'Copy sub address',
                onClick: () => copyToClipboard(sub.address, 'Sub address'),
              },
              {
                label: 'Refresh vault balance',
                onClick: () => {
                  if (typeof onRefreshL1Vault === 'function') onRefreshL1Vault();
                  refreshSubBalance?.(sub.address);
                },
              },
              {
                label: 'Hide linked sub',
                onClick: () => hideSubWallet(sub),
              },
            ])}
          </div>
        </div>

        {/* Always-visible summary — same density as ETH vault card */}
        <div className="sw-card-meta">
          <div className="sw-meta-row">
            <span className="sw-meta-k" title="Total native WART sitting on the vault address">
              In vault
            </span>
            <span className="sw-meta-v">
              {totalInVault} WART
              {sub.vaultBalanceAt ? (
                <span
                  className="sw-live-tag"
                  title={new Date(sub.vaultBalanceAt).toLocaleString()}
                >
                  · live
                </span>
              ) : null}
            </span>
          </div>
          <div className="sw-meta-row">
            <span
              className="sw-meta-k"
              title="Native WART on the vault pinned as mint capacity"
            >
              Locked
            </span>
            <span className="sw-meta-v">
              {outE8 > 0n ? e8ToWartDisplay(sub.mintedE8 || '0') : '0'} WART
            </span>
          </div>
          <div className="sw-meta-row">
            <span
              className="sw-meta-k"
              title="Native WART you can Vault → main after Release"
            >
              Withdrawable
            </span>
            <span className="sw-meta-v">
              {outE8 > 0n ? freeable : totalInVault === '…' ? '…' : freeable} WART
            </span>
          </div>
          <div className="sw-meta-row">
            <span className="sw-meta-k">Vault</span>
            <button
              type="button"
              className="sw-meta-v mono sw-link"
              title={vaultAddr}
              onClick={() => copyToClipboard(vaultAddr, 'Vault address')}
            >
              {displayedVaultAddr}
            </button>
          </div>
          <div className="sw-meta-row">
            <span className="sw-meta-k">Sub free</span>
            <span className="sw-meta-v">{sub.balance ?? '0'} WART</span>
          </div>
        </div>

        <div className="sw-card-toolbar">
          <button
            type="button"
            className="btn primary small"
            onClick={() => {
              if (typeof onRefreshL1Vault === 'function') onRefreshL1Vault();
              refreshSubBalance?.(sub.address);
            }}
            disabled={loading}
          >
            Refresh
          </button>
        </div>

        <details className="sw-details">
          <summary>Vault share backup</summary>
          <div className="sw-details-body">
            <p className="sw-hint" style={{ marginBottom: '0.5rem' }}>
              Your half of the key is only in this browser. Download{' '}
              <code>{VAULT_SHARE_DOWNLOAD_NAME}</code> as an opaque password blob. Cosigner still
              holds <code>d_dapp</code> separately.
            </p>
            {renderVaultShareControls(sub, { compact: true })}
          </div>
        </details>

        <details
          className="sw-details"
          open={openDetails}
          onToggle={(e) => {
            const open = e.currentTarget.open;
            setOpenVaultPanels((prev) => ({
              ...prev,
              [detailsKey]: { ...prev[detailsKey], details: open },
            }));
          }}
        >
          <summary>Vault details</summary>
          <div className="sw-details-body">
            <div className="sw-card-meta">
              <div className="sw-meta-row">
                <span className="sw-meta-k">Address</span>
                <button
                  type="button"
                  className="sw-meta-v mono sw-link"
                  onClick={() => copyToClipboard(vaultAddr, 'Address copied')}
                  title={vaultAddr}
                >
                  {displayedVaultAddr}
                </button>
              </div>
              <div className="sw-meta-row">
                <span className="sw-meta-k">In vault</span>
                <span className="sw-meta-v">
                  {sub.vaultBalance ?? '…'} WART
                  {sub.vaultBalanceAt ? (
                    <span
                      className="sw-live-tag"
                      title={new Date(sub.vaultBalanceAt).toLocaleString()}
                    >
                      · live
                    </span>
                  ) : (
                    <span className="sw-live-tag">· cached</span>
                  )}
                </span>
              </div>
              {sub.vaultSpendable != null &&
                sub.vaultSpendable !== '' &&
                String(sub.vaultSpendable) !== String(sub.vaultBalance || '') && (
                  <div className="sw-meta-row">
                    <span
                      className="sw-meta-k"
                      title="On-chain spendable after mempool holds"
                    >
                      Spendable
                    </span>
                    <span className="sw-meta-v">{sub.vaultSpendable} WART</span>
                  </div>
                )}
              {outE8 > 0n && (
                <p className="sw-hint" style={{ margin: '0.35rem 0 0' }}>
                  Locked collateral and L1 mint capacity are the same pin (
                  {e8ToWartDisplay(sub.mintedE8 || '0')} WART). Not MetaMask wWART —
                  that is a separate claim under Home / Get wWART.
                </p>
              )}
            </div>
            <div className="sw-card-toolbar">
              <button
                type="button"
                className="btn secondary small"
                onClick={() => inspectVault(vaultAddr)}
                disabled={loading}
              >
                Inspect
              </button>
              <button
                type="button"
                className="btn secondary small"
                onClick={() => dismissVaultFromSub(sub)}
                disabled={loading || isUnlocking[sub.index]}
                title="Detach this multi-sig vault from the sub. Sub stays for a new vault. Does not hide the sub or move funds."
              >
                Dismiss vault
              </button>
              {!sub.locked && outE8 === 0n && (
                <button
                  type="button"
                  className="btn secondary small"
                  disabled={loading}
                  onClick={() => {
                    setSubWallets((prev) =>
                      prev.map((s) =>
                        s.index === sub.index ? { ...s, ...clearClientLockState(s) } : s,
                      ),
                    );
                    toast.success('Client vault lock flags cleared');
                  }}
                >
                  Clear stuck
                </button>
              )}
            </div>
          </div>
        </details>

        <details
          className="sw-details"
          open={openBurn}
          onToggle={(e) => {
            const open = e.currentTarget.open;
            setOpenVaultPanels((prev) => ({
              ...prev,
              [detailsKey]: { ...prev[detailsKey], burn: open },
            }));
          }}
        >
          <summary>
            Release locked WART
            {canBurn ? ` · ${e8ToWartDisplay(sub.mintedE8 || '0')} locked` : ' · none'}
          </summary>
          <div className="sw-details-body">
            {canBurn ? (
              <>
                <p className="sw-hint">
                  Unlocks native vault collateral (capacity shrinks). Backend rejects a release that
                  would leave <strong>Capacity &lt; Used</strong> — burn wWART/WLIQ claims on Home
                  first, or release only free headroom. Then Vault → main for coins.
                </p>
                <div className="action-group burn-group">
                  <input
                    type="number"
                    step="0.00000001"
                    min="0"
                    placeholder="Amount to release"
                    value={burnAmounts[sub.index] || ''}
                    onChange={(e) =>
                      setBurnAmounts((prev) => ({ ...prev, [sub.index]: e.target.value }))
                    }
                    disabled={isUnlocking[sub.index] || loading}
                    className="input amount-input"
                  />
                  <button
                    type="button"
                    className="btn secondary small"
                    disabled={isUnlocking[sub.index] || loading}
                    onClick={() =>
                      setBurnAmounts((prev) => ({
                        ...prev,
                        [sub.index]: e8ToWartDisplay(sub.mintedE8 || '0'),
                      }))
                    }
                  >
                    Max
                  </button>
                  <button
                    type="button"
                    className="btn danger small"
                    disabled={
                      isUnlocking[sub.index] ||
                      loading ||
                      !burnAmounts[sub.index] ||
                      Number(burnAmounts[sub.index]) <= 0
                    }
                    onClick={() =>
                      requestBurnUnlock(sub, { amountWart: burnAmounts[sub.index] })
                    }
                  >
                    {isUnlocking[sub.index] ? '…' : 'Release'}
                  </button>
                  <button
                    type="button"
                    className="btn danger small"
                    disabled={isUnlocking[sub.index] || loading}
                    onClick={() => requestBurnUnlock(sub, { burnAll: true })}
                  >
                    Release all
                  </button>
                </div>
                <details className="sw-details sw-details--nested">
                  <summary>Force UI unlock (advanced)</summary>
                  <div className="sw-details-body">
                    <p className="sw-hint">
                      Clears local lock flags only. Does not move coins or restore cosigner keys.
                    </p>
                    <button
                      type="button"
                      className="btn secondary small"
                      onClick={() => {
                        setSubWallets((prev) =>
                          prev.map((s) =>
                            s.index === sub.index ? { ...s, ...clearClientLockState(s) } : s,
                          ),
                        );
                        setBurnAmounts((prev) => ({ ...prev, [sub.index]: '' }));
                        toast.success(
                          'UI lock cleared — then Vault → main withdraw. Cosigner not restored.',
                          { duration: 7000 },
                        );
                      }}
                      disabled={loading}
                    >
                      Force UI unlock
                    </button>
                  </div>
                </details>
              </>
            ) : (
              <>
                <p className="sw-tab-empty">
                  Client shows 0 locked. After a rollup restart, native WART can still sit on
                  the vault while the UI looks unlocked (Force UI unlock only clears flags).
                </p>
                {Number(totalInVault) > 0 && (
                  <div className="action-group" style={{ marginTop: '0.5rem' }}>
                    <button
                      type="button"
                      className="btn primary small"
                      disabled={loading || isVaultWithdrawing[sub.index]}
                      onClick={() => recoverVaultToMainAfterRestart(sub)}
                    >
                      Recover vault → main (post-restart)
                    </button>
                  </div>
                )}
              </>
            )}
            {isUnlocking[sub.index] && (
              <div className="status-message status-unlock">
                <div className="spinner" />
                <span>
                  Releasing locked WART
                  <LoadingDots />
                </span>
              </div>
            )}
          </div>
        </details>

        <details
          className="sw-details"
          open={openVaultMain}
          onToggle={(e) => {
            const open = e.currentTarget.open;
            setOpenVaultPanels((prev) => ({
              ...prev,
              [detailsKey]: { ...prev[detailsKey], vaultMain: open },
            }));
          }}
        >
          <summary>
            Vault → main
            {outE8 > 0n ? ` · withdrawable ${freeable}` : Number(totalInVault) > 0 ? ` · ${totalInVault} in vault` : ''}
          </summary>
          <div className="sw-details-body">
            <p className="sw-hint">
              Multi-sig (or legacy) withdraw native WART from vault to main.
              {outE8 === 0n && Number(totalInVault) > 0
                ? ' If this fails with Pin held after a restart, use Recover under Release.'
                : ''}
            </p>
            <div className="action-group vault-withdraw-group">
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder={
                  outE8 > 0n ? `Withdrawable ≤ ${freeable}` : sub.vaultBalance || '0'
                }
                value={vaultWithdrawAmounts[sub.index] || ''}
                onChange={(e) => {
                  const raw = e.target.value;
                  // allow empty / decimal typing without resetting the panel
                  if (raw !== '' && !/^\d*[.,]?\d*$/.test(raw)) return;
                  setVaultWithdrawAmounts((prev) => ({
                    ...prev,
                    [sub.index]: raw.replace(',', '.'),
                  }));
                }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                disabled={
                  isVaultWithdrawing[sub.index] ||
                  loading ||
                  !sub.vaultBalance ||
                  Number(sub.vaultBalance) <= 0 ||
                  (outE8 > 0n && Number(freeable) <= 0)
                }
                className="input amount-input"
              />
              <button
                type="button"
                className="btn secondary small"
                disabled={
                  isVaultWithdrawing[sub.index] ||
                  loading ||
                  !sub.vaultBalance ||
                  Number(sub.vaultBalance) <= 0 ||
                  (outE8 > 0n && Number(freeable) <= 0)
                }
                onClick={async () => {
                  const vAddr = String(vaultAddr).replace(/^0x/i, '').toLowerCase();
                  let free = sub.vaultSpendable || sub.vaultBalance || '0';
                  try {
                    const live = await fetchBalanceAndNonce(vAddr, true);
                    free = live.spendable || live.balance || free;
                    setSubWallets((prev) =>
                      prev.map((s) =>
                        s.index === sub.index
                          ? {
                              ...s,
                              vaultBalance: live.balance || free,
                              vaultSpendable: live.spendable || free,
                              vaultBalanceAt: Date.now(),
                            }
                          : s,
                      ),
                    );
                  } catch {
                    /* cached */
                  }
                  if (outE8 > 0n) {
                    free = freeableVaultWart({ ...sub, vaultBalance: free });
                  }
                  setVaultWithdrawAmounts((prev) => ({ ...prev, [sub.index]: free }));
                }}
              >
                Max
              </button>
              <button
                type="button"
                className="btn primary small"
                disabled={
                  isVaultWithdrawing[sub.index] ||
                  loading ||
                  !sub.vaultBalance ||
                  Number(sub.vaultBalance) <= 0 ||
                  (outE8 > 0n && Number(freeable) <= 0)
                }
                onClick={() => withdrawVaultToMain(sub)}
              >
                {isVaultWithdrawing[sub.index] ? 'Sending…' : 'Withdraw'}
              </button>
            </div>
            {outE8 > 0n && Number(freeable) <= 0 && (
              <p className="sw-tab-empty">
                Nothing withdrawable yet — open <strong>Release locked WART</strong> first.
                Release emits <strong>release tickets</strong>; cosigner only signs freeable
                ticket amounts while collateral is still pinned.
              </p>
            )}
            {isVaultWithdrawing[sub.index] && (
              <div className="status-message status-withdraw">
                <div className="spinner" />
                <span>
                  Multi-sig vault → main
                  <LoadingDots />
                </span>
              </div>
            )}
          </div>
        </details>
      </div>
    );
  };

  const isVaultFocus = focusMode === 'vault';

  useEffect(() => {
    if (!openMenuKey) return undefined;
    const onDoc = (e) => {
      if (cardMenuRef.current && !cardMenuRef.current.contains(e.target)) {
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

  const toggleCardMenu = (key) => {
    setOpenMenuKey((prev) => (prev === key ? null : key));
  };

  /** ⋮ menu — same pattern as ETH sub/vault cards */
  const renderCardMenu = (menuKey, items) => {
    const open = openMenuKey === menuKey;
    return (
      <div
        className="sw-card-menu"
        ref={open ? cardMenuRef : undefined}
        style={{ position: 'relative', marginLeft: 'auto' }}
      >
        <button
          type="button"
          className="sw-menu-btn"
          aria-label="Card menu"
          aria-expanded={open}
          title="More actions"
          onClick={(e) => {
            e.stopPropagation();
            toggleCardMenu(menuKey);
          }}
        >
          <MoreVertical size={16} />
        </button>
        {open ? (
          <div className="sw-menu-dropdown" role="menu">
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`sw-menu-item${item.danger ? ' is-danger' : ''}`}
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

  // Sub wallets tab: all non-hidden subs (create vault lives here).
  // Vault tab: only subs that currently have a vault attached — no empty "create vault" hang.
  const visibleSubs = isVaultFocus
    ? baseVisibleSubs.filter((s) => {
        const v = String(s.vaultAddress || s.pendingVaultAddress || '')
          .replace(/^0x/i, '')
          .toLowerCase();
        return v.length >= 40 && !s.vaultDetached;
      })
    : baseVisibleSubs;

  const totalSubs = visibleSubs.length;
  const safePos =
    totalSubs === 0 ? 0 : Math.min(Math.max(0, activeSubPos), totalSubs - 1);
  const activeSub = totalSubs > 0 ? visibleSubs[safePos] : null;

  const goPrevSub = () => {
    if (totalSubs <= 1) return;
    setActiveSubPos((p) => (p - 1 + totalSubs) % totalSubs);
  };
  const goNextSub = () => {
    if (totalSubs <= 1) return;
    setActiveSubPos((p) => (p + 1) % totalSubs);
  };

  const generateAndFocus = async () => {
    await generateLockedSubWallet();
    // New sub is appended to full list; show non-hidden and focus last visible
    setShowHiddenSubs(false);
    setTimeout(() => {
      setActiveSubPos((pos) => {
        // after state update, focus will clamp; use large number then effect clamps
        return 9999;
      });
    }, 80);
  };

  // Cross-layer snapshot: vault locks · WLIQ · wWART claim · MetaMask ERC-20
  const clientSpoofedE8 = (() => {
    try {
      return subWallets.reduce((acc, s) => {
        try {
          return acc + BigInt(s?.mintedE8 || '0');
        } catch {
          return acc;
        }
      }, 0n);
    } catch {
      return 0n;
    }
  })();
  /** Parse vault 18-dec (or already-human) amount to number. */
  const human18 = (raw) => {
    try {
      if (raw == null || raw === '') return 0;
      const n = Number(raw);
      if (Number.isFinite(n) && Math.abs(n) < 1e15) return n; // already human
      const bi = BigInt(String(raw).split('.')[0] || '0');
      return Number(bi) / 1e18;
    } catch {
      return 0;
    }
  };
  const rollupWliqHuman = human18(l1Vault?.liquid);
  const rollupClaimHuman = human18(
    l1Vault?.l1WwartClaim ?? l1Vault?.wwartPortable ?? '0',
  );
  const mmHuman =
    mmWwartBal != null && mmWwartBal !== ''
      ? Number(mmWwartBal)
      : null;
  const fmtAmt = (n) =>
    n == null || !Number.isFinite(n)
      ? '—'
      : n.toLocaleString(undefined, { maximumFractionDigits: 4 });

  const unloadedOnly = unloadedVaults.filter((v) => !v.loaded && !v.dismissed);
  const discoveredLoaded = unloadedVaults.filter((v) => v.loaded);
  const dismissedOnly = unloadedVaults.filter((v) => v.dismissed && !v.loaded);

  const renderUnloadedVaultsPanel = () => {
    if (!isVaultFocus) return null;
    const n = unloadedOnly.length;
    const value =
      unloadedBusy && unloadedVaults.length === 0
        ? '…'
        : n > 0
          ? String(n)
          : '—';
    return (
      <div
        className={`sw-unloaded-panel${unloadedPanelOpen ? ' is-open' : ''}`}
      >
        <div className="sw-meta-row sw-unloaded-toggle-row">
          <span className="sw-meta-k">Unloaded</span>
          <button
            type="button"
            className="sw-meta-v mono sw-link sw-unloaded-toggle"
            aria-expanded={unloadedPanelOpen}
            title="History / cosigner vaults not on a card — click to expand"
            onClick={() => setUnloadedPanelOpen((open) => !open)}
          >
            {unloadedPanelOpen ? '▾' : '▸'} {value}
          </button>
        </div>
        {unloadedPanelOpen ? (
          <div className="sw-unloaded-panel-body">
            <div className="sw-card-head sw-unloaded-head">
              <p className="sw-card-empty-msg" style={{ margin: 0, flex: 1 }}>
                Not on a card. <strong>Load</strong> (view-only without{' '}
                <code>d_user</code>) or <strong>Dismiss</strong>. New vaults: Sub wallets.
              </p>
              <div className="sw-card-head-right">
                <button
                  type="button"
                  className="btn secondary small"
                  disabled={unloadedBusy}
                  onClick={() => discoverUnloadedVaults()}
                >
                  {unloadedBusy ? '…' : '↻'}
                </button>
              </div>
            </div>
            {unloadedBusy && unloadedVaults.length === 0 ? (
              <p className="sw-tab-empty">Scanning notices &amp; balances…</p>
            ) : unloadedOnly.length === 0 ? (
              <p className="sw-tab-empty">
                {unloadedVaults.length === 0
                  ? 'No other vaults found for this L1 / sub history yet.'
                  : 'No undismissed unloaded vaults (see dismissed below if any).'}
              </p>
            ) : (
              <ul className="sw-unloaded-list">
                {unloadedOnly.map((v) => {
                  const short = `${v.vaultAddress.slice(0, 10)}…${v.vaultAddress.slice(-6)}`;
                  const subShort = v.subAddress
                    ? `${v.subAddress.slice(0, 6)}…${v.subAddress.slice(-4)}`
                    : '—';
                  const idxLabel =
                    v.subIndex != null && Number.isFinite(Number(v.subIndex))
                      ? `#${v.subIndex}`
                      : null;
                  return (
                    <li key={v.vaultAddress} className="sw-unloaded-row">
                      <div className="sw-unloaded-main">
                        <button
                          type="button"
                          className="sw-meta-v mono sw-link"
                          title={v.vaultAddress}
                          onClick={() => copyToClipboard(v.vaultAddress, 'Vault address')}
                        >
                          {short}
                        </button>
                        <span className="sw-unloaded-bal">
                          {v.balance !== '—' ? `${v.balance} WART` : 'balance ?'}
                        </span>
                        <span className="sw-muted sw-unloaded-meta">
                          {idxLabel ? (
                            <button
                              type="button"
                              className="sw-link"
                              title="Copy HD sub index — use Regen if sub is missing"
                              onClick={() =>
                                copyToClipboard(String(v.subIndex), 'Sub index')
                              }
                            >
                              sub {idxLabel}
                            </button>
                          ) : (
                            'sub index ?'
                          )}
                          {` · ${subShort}`}
                          {v.lastType ? ` · ${v.lastType}` : ''}
                        </span>
                      </div>
                      <div className="sw-unloaded-actions">
                        <button
                          type="button"
                          className="btn primary small"
                          title={
                            idxLabel
                              ? `Attach to sub ${idxLabel} (view only without user share)`
                              : 'Attach to matching or first sub'
                          }
                          onClick={() => loadDiscoveredVaultOntoSub(v)}
                        >
                          {idxLabel ? `Load on sub ${idxLabel}` : 'Load on sub'}
                        </button>
                        <button
                          type="button"
                          className="btn secondary small"
                          title="Hide from this list forever (until Undismiss). Funds stay on-chain."
                          onClick={() => {
                            dismissVaultAddress(v.vaultAddress);
                            // Also detach from any sub still showing this vault
                            setSubWallets((prev) =>
                              prev.map((s) => {
                                const va = String(
                                  s.vaultAddress || s.pendingVaultAddress || '',
                                )
                                  .replace(/^0x/i, '')
                                  .toLowerCase();
                                if (va !== v.vaultAddress) return s;
                                return {
                                  ...s,
                                  vaultAddress: null,
                                  pendingVaultAddress: null,
                                  vaultBalance: null,
                                  vaultSpendable: null,
                                  vaultBalanceAt: null,
                                  vaultDetached: true,
                                  locked: false,
                                  locking: false,
                                  mintedE8: '0',
                                };
                              }),
                            );
                            toast.success(
                              `Dismissed ${v.vaultAddress.slice(0, 10)}… — gone from Unloaded & cards`,
                              { duration: 5000 },
                            );
                            // Optimistic UI — remove from list immediately
                            setUnloadedVaults((prev) =>
                              prev.map((row) =>
                                row.vaultAddress === v.vaultAddress
                                  ? { ...row, dismissed: true, loaded: false }
                                  : row,
                              ),
                            );
                          }}
                        >
                          Dismiss
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {dismissedOnly.length > 0 && (
              <details className="sw-unloaded-loaded">
                <summary>Dismissed ({dismissedOnly.length}) — hidden until Undismiss</summary>
                <ul className="sw-unloaded-list sw-unloaded-list--dim">
                  {dismissedOnly.map((v) => (
                    <li key={`dismissed-${v.vaultAddress}`} className="sw-unloaded-row">
                      <span className="mono">
                        {v.vaultAddress.slice(0, 10)}…{v.vaultAddress.slice(-6)}
                      </span>
                      <span className="sw-unloaded-bal">
                        {v.balance !== '—' ? `${v.balance} WART` : '—'}
                      </span>
                      <button
                        type="button"
                        className="btn secondary small"
                        onClick={() => {
                          undismissVaultAddress(v.vaultAddress);
                          setUnloadedVaults((prev) =>
                            prev.map((row) =>
                              row.vaultAddress === v.vaultAddress
                                ? { ...row, dismissed: false }
                                : row,
                            ),
                          );
                          toast.success('Undismissed — use Load on sub if needed');
                        }}
                      >
                        Undismiss
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {discoveredLoaded.length > 0 && (
              <details className="sw-unloaded-loaded">
                <summary>
                  Also on chain/history ({discoveredLoaded.length} already on a card)
                </summary>
                <ul className="sw-unloaded-list sw-unloaded-list--dim">
                  {discoveredLoaded.map((v) => (
                    <li key={`loaded-${v.vaultAddress}`} className="sw-unloaded-row">
                      <span className="mono">
                        {v.vaultAddress.slice(0, 10)}…{v.vaultAddress.slice(-6)}
                      </span>
                      <span className="sw-unloaded-bal">
                        {v.balance !== '—' ? `${v.balance} WART` : '—'}
                      </span>
                      <span className="sw-muted">loaded</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  return (
  <section className={`subwallet-section${isVaultFocus ? ' subwallet-section--vault-focus' : ''}`}>
    <div className="subwallet-top">
      <h3>{isVaultFocus ? 'WART vaults' : 'Sub wallets'}</h3>
      <p className="sw-top-lead">
        {isVaultFocus
          ? 'Multi-sig vault balances · release locked · Vault → main'
          : 'Fund → sweep → mint capacity · then claim wWART on L1'}
      </p>
      <details className="bridge-flow-guide">
        <summary>{isVaultFocus ? 'Vault tips' : 'Steps'}</summary>
        {isVaultFocus ? (
          <ol className="bridge-flow-steps">
            <li><span className="step-num">1</span><span>Only loaded vaults here — create new ones on <strong>Sub wallets</strong></span></li>
            <li><span className="step-num">2</span><span>Open <strong>Unloaded vaults</strong> → Load on sub or <strong>Dismiss</strong></span></li>
            <li><span className="step-num">3</span><span>Release locked WART if needed, then Vault → main</span></li>
          </ol>
        ) : (
          <>
            <p className="bridge-flow-lead">
              Needs MetaMask + seed + rollup online.
            </p>
            <ol className="bridge-flow-steps">
              <li><span className="step-num">1</span><span>Generate sub · create vault</span></li>
              <li><span className="step-num">2</span><span>Fund sub</span></li>
              <li><span className="step-num">3</span><span>Sweep → lock WART capacity</span></li>
              <li><span className="step-num">4</span><span>L1: claim wWART → withdraw → Execute voucher</span></li>
            </ol>
          </>
        )}
      </details>
    </div>

    {/* Cross-layer: locked vault WART · WLIQ · wWART claim · MetaMask ERC-20 */}
    <div
      className={`sw-card sw-card--l1-track${showLayersCard ? '' : ' is-collapsed'}`}
    >
      <div className="sw-card-head">
        <h4 className="sw-card-title">Balances across layers</h4>
        <div className="sw-card-head-right sw-layers-actions">
          <button
            type="button"
            className="sw-icon-btn"
            title="Refresh L1 balances"
            aria-label="Refresh L1 balances"
            onClick={() => {
              if (typeof onRefreshL1Vault === 'function') onRefreshL1Vault();
              if (typeof onRefreshMmWwart === 'function') onRefreshMmWwart();
            }}
          >
            <RefreshCw size={14} strokeWidth={2.25} aria-hidden />
          </button>
          <button
            type="button"
            className="sw-icon-btn"
            title={
              showLayersCard
                ? 'Hide balances across layers'
                : 'Show balances across layers'
            }
            aria-label={
              showLayersCard
                ? 'Hide balances across layers'
                : 'Show balances across layers'
            }
            aria-expanded={showLayersCard}
            onClick={() => setShowLayersCard((v) => !v)}
          >
            {showLayersCard ? (
              <EyeOff size={14} strokeWidth={2.25} aria-hidden />
            ) : (
              <Eye size={14} strokeWidth={2.25} aria-hidden />
            )}
          </button>
        </div>
      </div>
      {showLayersCard && (
        <>
          <div className="sw-card-meta">
            <div className="sw-meta-row">
              <span
                className="sw-meta-k"
                title="Native WART still locked as collateral on your vaults. Release this to free withdrawable WART."
              >
                Locked WART
              </span>
              <span className="sw-meta-v">
                {e8ToWartDisplay(clientSpoofedE8)} WART
              </span>
            </div>
            <div className="sw-meta-row">
              <span
                className="sw-meta-k"
                title={`${SHARE_TOKEN.symbol} share held on the rollup (mint/burn on Warthog Home). Uses the same capacity pool as wWART claims.`}
              >
                Rollup {SHARE_TOKEN.symbol}
              </span>
              <span className="sw-meta-v">
                {fmtAmt(rollupWliqHuman)} {SHARE_TOKEN.symbol}
              </span>
            </div>
            <div className="sw-meta-row">
              <span
                className="sw-meta-k"
                title="Rollup wWART capacity claim — withdraw + execute voucher to mint ERC-20 in MetaMask"
              >
                Rollup wWART claim
              </span>
              <span className="sw-meta-v">{fmtAmt(rollupClaimHuman)} wWART</span>
            </div>
            <div className="sw-meta-row">
              <span
                className="sw-meta-k"
                title="ERC-20 wWART already in your connected MetaMask wallet"
              >
                MetaMask
              </span>
              <span className="sw-meta-v">
                {mmHuman != null ? `${fmtAmt(mmHuman)} wWART` : '— connect MM'}
              </span>
            </div>
          </div>
          <p className="wh-hint sw-l1-track-hint">
            <strong>Locked WART</strong> is vault collateral.{' '}
            <strong>{SHARE_TOKEN.symbol}</strong> and <strong>wWART claim</strong> are rollup
            shares against that capacity. MetaMask shows L1 ERC-20 after voucher execute.
          </p>
        </>
      )}
    </div>

    {/* History vaults not on the active card (re-create / wrong local address) */}
    {renderUnloadedVaultsPanel()}

    {/* Sub generation only on Sub wallets tab — not on Vault tab.
        Layout matches ETH: Generate | Index | Regen on one neat row. */}
    {!isVaultFocus && (
      <>
        <div className="subwallet-controls">
          <button
            type="button"
            onClick={generateAndFocus}
            disabled={loading}
            className="btn primary small"
          >
            + Generate sub
          </button>
          <div className="regen-group">
            <input
              type="number"
              placeholder="Index"
              value={regenIndex}
              onChange={(e) => setRegenIndex(e.target.value)}
              className="input regen-input"
              title="HD index to regenerate (click sub index to copy)"
            />
            <button
              type="button"
              onClick={async () => {
                const idx = Number(regenIndex);
                await regenerateSubWallet();
                setShowHiddenSubs(false);
                if (!Number.isNaN(idx)) {
                  setTimeout(() => {
                    setActiveSubPos(0);
                    // focus after list updates — match by index in visible list
                    setActiveSubPos((_) => {
                      const list = subWallets.filter((s) => !s.hidden || s.index === idx);
                      const pos = list.findIndex((s) => s.index === idx);
                      return pos >= 0 ? pos : 9999;
                    });
                  }, 100);
                }
              }}
              disabled={loading || !regenIndex}
              className="btn secondary small"
            >
              Regen
            </button>
          </div>
        </div>
        {hiddenCount > 0 && (
          <div className="sw-hidden-controls">
            <button
              type="button"
              className="btn secondary small"
              onClick={() => setShowHiddenSubs((v) => !v)}
              title="Show or hide subs marked hidden"
            >
              {showHiddenSubs ? 'Hide stuck' : `Show hidden (${hiddenCount})`}
            </button>
            <button
              type="button"
              className="btn danger small"
              onClick={clearAllHiddenSubs}
              title="Permanently remove all hidden subs from this UI list"
            >
              Clear hidden
            </button>
          </div>
        )}
      </>
    )}

    {totalSubs === 0 && (
      <div className="sw-empty">
        <p>
          {isVaultFocus
            ? subWallets.length === 0
              ? 'No vaults yet. Open Sub wallets, generate a sub, then Load / create vault.'
              : 'No vaults created yet. Open Sub wallets → Load / create vault on a sub.'
            : subWallets.length === 0
              ? 'No sub-wallets yet. Generate one to start the bridge path.'
              : `${hiddenCount} sub(s) hidden — click “Show hidden” or generate a new sub.`}
        </p>
      </div>
    )}

    {activeSub && (() => {
      const sub = activeSub;
      const displayedSubAddr = isSmallScreen
        ? `${sub.address.slice(0, 6)}…${sub.address.slice(-4)}`
        : sub.address;
      const hasVault = !!(sub.vaultAddress || sub.pendingVaultAddress);
      const shortPill = isSmallScreen
        ? `#${String(sub.index).slice(0, 6)}…`
        : `#${sub.index}`;
      const vaultAddrShort = (() => {
        const va = String(sub.vaultAddress || sub.pendingVaultAddress || '');
        if (!va) return '';
        return `${va.slice(0, 6)}…${va.slice(-4)}`;
      })();

      return (
        <div className="sw-carousel" key={sub.index}>
          {/* Pager */}
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
                disabled={totalSubs <= 1}
                title={isVaultFocus ? 'Previous vault' : 'Previous sub-wallet'}
                aria-label={isVaultFocus ? 'Previous vault' : 'Previous sub-wallet'}
              >
                ‹
              </button>
              <span className="sw-pager-count" title={isVaultFocus ? 'Vault position' : 'Sub position'}>
                {safePos + 1}
                <span className="sw-pager-count-sep">/</span>
                {totalSubs}
              </span>
              <button
                type="button"
                className="sw-pager-step"
                onClick={goNextSub}
                disabled={totalSubs <= 1}
                title={isVaultFocus ? 'Next vault' : 'Next sub-wallet'}
                aria-label={isVaultFocus ? 'Next vault' : 'Next sub-wallet'}
              >
                ›
              </button>
            </div>
            <select
              className="input sw-pager-select"
              value={safePos}
              onChange={(e) => setActiveSubPos(Number(e.target.value))}
              title={isVaultFocus ? 'Jump to vault' : 'Jump to sub-wallet'}
              aria-label={isVaultFocus ? 'Select vault' : 'Select sub-wallet'}
            >
              {visibleSubs.map((s, i) => {
                const short = `${String(s.address).slice(0, 6)}…${String(s.address).slice(-4)}`;
                const vAddr = String(s.vaultAddress || s.pendingVaultAddress || '');
                const vShort = vAddr ? `${vAddr.slice(0, 6)}…${vAddr.slice(-4)}` : '';
                const locked = s.locked || (s.mintedE8 && BigInt(s.mintedE8 || '0') > 0n);
                return (
                  <option key={s.index} value={i}>
                    {isVaultFocus
                      ? `${i + 1}. vault ${vShort || short}${locked ? ' · locked' : ''}${
                          s.vaultBalance != null && Number(s.vaultBalance) > 0
                            ? ` · ${s.vaultBalance} WART`
                            : ''
                        }`
                      : `${i + 1}. #${s.index} · ${short}${s.hidden ? ' · hidden' : ''}${
                          locked ? ' · locked' : ''
                        }${s.balance && Number(s.balance) > 0 ? ` · ${s.balance} WART` : ''}`}
                  </option>
                );
              })}
            </select>
          </div>

          <div className={`sw-cards${isVaultFocus ? ' sw-cards--vault-only' : ''}`}>
            {/* ── Sub wallet card — layout matches ETH sub card ── */}
            {!isVaultFocus && (
            <div className={`sw-card sw-card--sub ${sub.hidden ? 'is-hidden-sub' : ''}`}>
              <div className="sw-card-head">
                <h4 className="sw-card-title">
                  Sub-wallet
                  {sub.hidden ? <span className="sw-live-tag"> · hidden</span> : null}
                  {hasVault ? (
                    <span className="sw-live-tag"> · vault</span>
                  ) : (
                    <span className="sw-live-tag"> · no vault</span>
                  )}
                </h4>
                <div className="sw-card-head-right">
                  <button
                    type="button"
                    className="sw-pill sw-pill-muted sw-pill-copy"
                    title={`Copy index ${sub.index}`}
                    onClick={() => copyToClipboard(String(sub.index), 'Index copied')}
                  >
                    {shortPill}
                  </button>
                  {renderCardMenu(`sub:${sub.index}`, [
                    {
                      label: 'Copy sub address',
                      onClick: () => copyToClipboard(sub.address, 'Address copied'),
                    },
                    {
                      label: 'Copy index',
                      onClick: () => copyToClipboard(String(sub.index), 'Index copied'),
                    },
                    hasVault
                      ? {
                          label: 'Open WART vault',
                          onClick: () => {
                            if (typeof onOpenVaultTab === 'function') onOpenVaultTab();
                            else toast('Open the Vault tab in the section menu');
                          },
                        }
                      : {
                          label: sub.vaultDetached
                            ? 'Create new vault'
                            : 'Load / create vault',
                          onClick: () => loadOrCreateVault(sub),
                          disabled: loading || isUnlocking[sub.index],
                        },
                    sub.hidden
                      ? {
                          label: 'Unhide',
                          onClick: () => unhideSubWallet(sub),
                        }
                      : {
                          label: 'Hide from list',
                          onClick: () => hideSubWallet(sub),
                        },
                    {
                      label: 'Remove from UI',
                      onClick: () => removeSubWallet(sub),
                      danger: true,
                    },
                  ].filter(Boolean))}
                </div>
              </div>

              <div className="sw-card-meta">
                <div className="sw-meta-row">
                  <span className="sw-meta-k">Balance</span>
                  <span className="sw-meta-v">{sub.balance ?? '0'} WART</span>
                </div>
                <div className="sw-meta-row">
                  <span className="sw-meta-k">Address</span>
                  <button
                    type="button"
                    className="sw-meta-v mono sw-link"
                    onClick={() => copyToClipboard(sub.address, 'Address copied')}
                    title={sub.address}
                  >
                    {displayedSubAddr}
                  </button>
                </div>
              </div>

              <div className="sw-card-toolbar">
                <button
                  type="button"
                  className="btn primary small"
                  onClick={() => refreshSubBalance(sub.address)}
                  disabled={loading || isUnlocking[sub.index]}
                >
                  Refresh
                </button>
                {!hasVault ? (
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() => loadOrCreateVault(sub)}
                    disabled={loading || isUnlocking[sub.index]}
                    title={
                      sub.vaultDetached
                        ? 'Create a new multi-sig vault on this sub (old vault was dismissed)'
                        : 'Create multi-sig vault or restore local share'
                    }
                  >
                    {sub.vaultDetached ? 'Create new vault' : 'Load / create vault'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn secondary small"
                    onClick={() => {
                      if (typeof onOpenVaultTab === 'function') onOpenVaultTab();
                      else toast('Open the Vault tab in the section menu');
                    }}
                  >
                    Open vault
                  </button>
                )}
              </div>

              {!hasVault && (
                <div className="sw-vault-share-inline">
                  {sub.vaultDetached ? (
                    <p className="sw-hint" style={{ margin: '0 0 0.5rem' }}>
                      Previous vault dismissed. Sub index #{sub.index} is free for a new vault
                      or Import share.
                    </p>
                  ) : null}
                  {renderVaultShareControls(sub)}
                </div>
              )}

              <details className="sw-details" open>
                <summary>Fund / exit (main ↔ sub)</summary>
                <div className="sw-details-body">
                  <p className="sw-hint">
                    Main = Warthog main wallet. Fund pulls from main; withdraw returns free sub
                    balance (not vault).
                  </p>
                  <div className="action-group deposit-group">
                    <input
                      type="number"
                      step="0.00000001"
                      placeholder="From main"
                      value={subDeposits[sub.index] || ''}
                      onChange={(e) =>
                        setSubDeposits((prev) => ({
                          ...prev,
                          [sub.index]: e.target.value,
                        }))
                      }
                      disabled={isDepositing[sub.index] || loading}
                      className="input amount-input"
                    />
                    <button
                      type="button"
                      className="btn secondary small"
                      onClick={() => setMaxDeposit(sub)}
                      disabled={isDepositing[sub.index] || loading}
                    >
                      Max
                    </button>
                    <button
                      type="button"
                      onClick={() => depositToSub(sub)}
                      disabled={isDepositing[sub.index] || loading}
                      className="btn primary small"
                    >
                      {isDepositing[sub.index] ? '…' : 'Main → sub'}
                    </button>
                  </div>
                  <div className="action-group deposit-group">
                    <input
                      type="number"
                      step="0.00000001"
                      placeholder="To main"
                      value={subWithdrawAmounts[sub.index] || ''}
                      onChange={(e) =>
                        setSubWithdrawAmounts((prev) => ({
                          ...prev,
                          [sub.index]: e.target.value,
                        }))
                      }
                      disabled={
                        isWithdrawing[sub.index] ||
                        loading ||
                        !sub.balance ||
                        Number(sub.balance) <= 0
                      }
                      className="input amount-input"
                    />
                    <button
                      type="button"
                      onClick={() => setMaxWithdraw(sub)}
                      disabled={
                        isWithdrawing[sub.index] ||
                        loading ||
                        !sub.balance ||
                        Number(sub.balance) <= 0
                      }
                      className="btn secondary small"
                    >
                      Max
                    </button>
                    <button
                      type="button"
                      onClick={() => withdrawToMain(sub)}
                      disabled={
                        isWithdrawing[sub.index] ||
                        loading ||
                        sub.locking ||
                        !sub.balance ||
                        Number(sub.balance) <= 0
                      }
                      className="btn primary small"
                    >
                      {isWithdrawing[sub.index] ? '…' : 'Sub → main'}
                    </button>
                  </div>
                  {(isDepositing[sub.index] || autoLockPhase[sub.index]) && (
                    <div className="status-message status-deposit">
                      <div className="spinner" />
                      <span>
                        {getLockStatusText(autoLockPhase[sub.index])}
                        <LoadingDots />
                      </span>
                    </div>
                  )}
                  {isWithdrawing[sub.index] && (
                    <div className="status-message status-withdraw">
                      <div className="spinner" />
                      <span>
                        Sub → main
                        <LoadingDots />
                      </span>
                    </div>
                  )}
                </div>
              </details>

              <details className="sw-details" open={!!hasVault}>
                <summary>Sweep &amp; mint (sub → vault)</summary>
                <div className="sw-details-body">
                  <p className="sw-hint">
                    Move free sub WART into vault and lock it 1:1 as capacity.
                  </p>
                  <div className="action-group sweep-group">
                    <input
                      type="number"
                      step="0.00000001"
                      placeholder={sub.balance || '0'}
                      value={subSweepAmounts[sub.index] || ''}
                      onChange={(e) =>
                        setSubSweepAmounts((prev) => ({
                          ...prev,
                          [sub.index]: e.target.value,
                        }))
                      }
                      disabled={isSweeping[sub.index] || loading || !hasVault}
                      className="input amount-input"
                    />
                    <button
                      type="button"
                      onClick={() => setMaxSweep(sub)}
                      disabled={isSweeping[sub.index] || loading || !hasVault}
                      className="btn secondary small"
                    >
                      Max
                    </button>
                    <button
                      type="button"
                      onClick={() => sweepToVault(sub, subSweepAmounts[sub.index])}
                      disabled={isSweeping[sub.index] || loading || !hasVault}
                      className="btn primary small"
                    >
                      {isSweeping[sub.index] ? 'Sweeping…' : 'Sweep & mint'}
                    </button>
                  </div>
                  <details className="sw-details sw-details--nested">
                    <summary>Advanced (retry mint / clear locking)</summary>
                    <div className="sw-details-body">
                      <div className="sw-card-toolbar">
                        {sub.locking && !isSweeping[sub.index] && (
                          <button
                            type="button"
                            className="btn secondary small"
                            onClick={() =>
                              setSubWallets((prev) =>
                                prev.map((s) =>
                                  s.index === sub.index ? { ...s, locking: false } : s,
                                ),
                              )
                            }
                          >
                            Clear locking
                          </button>
                        )}
                        {(sub.sweepTxHash || hasVault) && !sub.locked && (
                          <button
                            type="button"
                            className="btn secondary small"
                            disabled={isSweeping[sub.index] || loading || !l1Address}
                            onClick={() => {
                              if (!sub.sweepTxHash) {
                                const known =
                                  typeof window !== 'undefined'
                                    ? window.prompt('Paste Warthog sweep tx hash', '')
                                    : null;
                                if (!known) return;
                                setSubWallets((prev) =>
                                  prev.map((s) =>
                                    s.index === sub.index
                                      ? { ...s, sweepTxHash: known.trim() }
                                      : s,
                                  ),
                                );
                                setTimeout(
                                  () =>
                                    retryMintSpoofedWwart({
                                      ...sub,
                                      sweepTxHash: known.trim(),
                                    }),
                                  50,
                                );
                                return;
                              }
                              retryMintSpoofedWwart(sub);
                            }}
                          >
                            Retry mint
                          </button>
                        )}
                      </div>
                    </div>
                  </details>
                  {isSweeping[sub.index] && (
                    <div className="status-message status-sweep">
                      <div className="spinner" />
                      <span>
                        Sweep → vault + mint
                        <LoadingDots />
                      </span>
                    </div>
                  )}
                </div>
              </details>
            </div>
            )}

            {/* Vault card only on Vault tab — Sub wallets stays sub-only */}
            {isVaultFocus && renderVaultCard(sub)}
          </div>
        </div>
      );
    })()}

    {subError && <div className="error-message">{subError}</div>}

    <Toaster position="top-right" />
  </section>
);
}

export default SubWallet;
