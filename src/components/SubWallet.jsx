// src/components/SubWallet.jsx
import { useState, useEffect, useMemo } from 'react';
import { gql, GraphQLClient } from 'graphql-request';
import { keccak256, toUtf8Bytes, toUtf8String } from 'ethers-v6';
import { Toaster, toast } from 'react-hot-toast';
import '../styles/subWallet.css';
import { createWarthogApi, signAndSubmitTransaction } from '../utils/warthogClient.js';
import { getTxConfirmationStatus } from '../utils/txProof.js';
import { getRollupGraphqlUrl, getInspectUrl } from '../utils/bridgeConfig.js';
import { deriveSubWallet, deriveSubPrivateKey } from '../utils/subWalletDerive.js';
import {
  createTwoPartyVault,
  encryptJsonWithMnemonic,
  decryptJsonWithMnemonic,
  saveTwoPartyClientLocal,
  loadTwoPartyClientLocal,
  clearTwoPartyClientLocal,
  restoreCosignerRegisterFromLocal,
  buildVaultSharePlainPayload,
  downloadVaultShareBackupFile,
  exportVaultShareBackupFromLocal,
  importVaultShareBackupFile,
  promptVaultSharePassword,
  VAULT_SHARE_DOWNLOAD_NAME,
  MULTISIG_SCHEME,
} from '../utils/twoPartyEcdsa.js';
import { registerMultiSigVault, cosignerStatus } from '../utils/cosignerClient.js';
import { multiSigTransferWart } from '../utils/multiSigTransfer.js';
import { deriveVaultWallet } from '../utils/vaultDerive.js';
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

  // Re-sync locked collateral (mintedE8) from rollup notices when subs load.
  // Fixes stale localStorage after partial releases (e.g. UI stuck at 8 after release → 2).
  useEffect(() => {
    let cancelled = false;
    const subs = (subWallets || []).filter(
      (s) => s?.address && (s.locked || (s.mintedE8 && s.mintedE8 !== '0') || s.vaultAddress),
    );
    if (!subs.length) return undefined;

    (async () => {
      const updates = [];
      for (const s of subs) {
        try {
          const rebuilt = await rebuildOutstandingE8FromNotices(s.address);
          if (!rebuilt || cancelled) continue;
          const prev = String(s.mintedE8 || '0');
          if (prev !== rebuilt.outstandingE8) {
            updates.push({
              index: s.index,
              mintedE8: rebuilt.outstandingE8,
              locked: !rebuilt.fullyUnlocked && BigInt(rebuilt.outstandingE8) > 0n,
            });
          }
        } catch {
          /* rollup may be down */
        }
      }
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
    // Only when wallet/sub list identity changes — not every mintedE8 write
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    address,
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
  const downloadVaultShareBackup = (sub) => {
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

      const plain = exportVaultShareBackupFromLocal(mainAddr, sub.address, {
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
        `Downloaded ${name} — opaque password blob (like warthog_wallet.txt). Cosigner still holds d_dapp separately.`,
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
    reader.onload = () => {
      try {
        const text = String(reader.result || '');
        const isLegacyJson = text.trim().startsWith('{');
        let password = null;
        if (!isLegacyJson) {
          password = promptVaultSharePassword('decrypt');
          if (!password) return toast('Import cancelled — no password');
        }
        const result = importVaultShareBackupFile(text, {
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
        }
        toast.success(
          `Imported user share for vault ${String(result.vaultAddress).slice(0, 12)}…` +
            (result.hasCosignerBackup
              ? ' (cosigner re-register material included — still separate from user half)'
              : ''),
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

  /** Post sweep_lock + poll (shared by full sweep and retry-mint). */
  const postSweepLock = async (sub, vaultAddress, sweepProof, toastId) => {
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

    const completed = await pollForLockNotice(sub.address, 90000);
    if (completed) {
      // Rebuild outstanding from ALL notices for this sub — never add latest notice
      // onto existing mintedE8 (retry / double-poll used to double locked amount, e.g. 16→32).
      let outstandingFromNotices = null;
      try {
        const rebuilt = await rebuildOutstandingE8FromNotices(sub.address);
        if (rebuilt) outstandingFromNotices = rebuilt.outstandingE8;
      } catch {
        /* ignore */
      }

      setSubWallets((prev) =>
        prev.map((s) => {
          if (s.index !== sub.index) return s;
          // Prefer notice rebuild; fall back to previous outstanding (do not add)
          const nextMinted =
            outstandingFromNotices != null
              ? outstandingFromNotices
              : s.mintedE8 || '0';
          return {
            ...s,
            locked: BigInt(nextMinted || '0') > 0n,
            locking: false,
            vaultAddress: vaultAddress,
            pendingVaultAddress: vaultAddress,
            mintedE8: nextMinted,
          };
        }),
      );
      await refreshSubBalance(sub.address);
      try {
        const vaultBalanceData = await fetchBalanceAndNonce(vaultAddress, true);
        setSubWallets((prev) =>
          prev.map((s) =>
            s.index === sub.index
              ? { ...s, vaultBalance: vaultBalanceData.balance || '0' }
              : s,
          ),
        );
        toast.success(`Vault balance: ${vaultBalanceData.balance || '0'} WART`, {
          duration: 4000,
        });
      } catch {
        /* ignore */
      }
      toast.success(
        'Step 4 done: locked. WART is locked as collateral — release any amount to unlock partially.',
        { id: toastId, duration: 7000 },
      );
    } else {
      toast.error(
        'sweep_lock submitted but notice not seen — check cartesi logs / GraphQL',
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
   * Withdraw vault → main.
   * 1) Multi-sig 2P path when cosigner still has this vault
   * 2) Legacy mnemonic-derived vault (vaultDerive) if address matches
   *
   * Note: "Force UI unlock" only clears local lock flags — it does not move keys
   * or restore cosigner shares. After rollup wipe, multi-sig still needs cosigner.
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

    // Force UI unlock only clears UI; if mintedE8 still set, user may still hit freeable checks.
    // Treat explicit full free as spendable when live balance exists and user cleared UI lock.
    const outstandingE8 = BigInt(sub.mintedE8 || '0');
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
          freeable = freeableVaultWart({ ...sub, vaultBalance: liveSpendable });
        }
      }
      if (outstandingE8 > 0n && Number(freeable) <= 0) {
        throw new Error(
          'Nothing withdrawable yet — release locked WART first, or use Force UI unlock only after rollup wipe (then locked should be 0 in UI). ' +
            'Force unlock does not move coins by itself.',
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

          // Unknown vault → re-push d_dapp from encrypted browser backup (if we have it)
          if (needRestore) {
            const backup = restoreCosignerRegisterFromLocal(
              mainWallet?.address || address,
              sub.address,
              mainMnemonic,
            );
            if (backup?.dappShareHex && backup?.ckey) {
              toast.loading('Cosigner lost vault — restoring share from browser backup…', {
                id: toastId,
              });
              await registerMultiSigVault({
                ...backup,
                vaultAddress: vaultAddr,
                owner: l1Address.toLowerCase(),
                subAddress: sub.address,
                index: sub.index,
                mainAddress: mainAddr,
                allowedTo: [mainAddr],
              });
              toast.loading('Cosigner restored — signing multi-sig…', { id: toastId });
            } else {
              throw new Error(
                'COSIGNER_MISSING: Cosigner says Unknown vault (no d_dapp for this address). ' +
                  'This browser has no encrypted cosigner backup either (vault created before backup feature). ' +
                  'Multi-sig cannot sign this address. Will try legacy secret-derived key next — ' +
                  'if this was a 2P multi-sig vault, funds need an old cosigner backup file.',
              );
            }
          }

          const clientSecret = decryptJsonWithMnemonic(
            local.encryptedClientSecret,
            mainMnemonic,
          );
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
          const m = String(e?.message || e);
          // Policy / pin failures must NOT fall through to legacy full-key path
          // (that would bypass COSIGNER_REQUIRE_TICKETS and freeable caps).
          if (
            /COSIGNER_REQUIRE_TICKETS|release_ticket|ticket-backed|ticket sum|freeable|outstanding|Insufficient|Pin held|Pin:|amountE8|Nothing freeable|Mnemonic|owner mismatch|not allowed|Destination not allowed|hashHex does not match/i.test(
              m,
            )
          ) {
            throw e;
          }
          // Only fall through to legacy on Unknown vault / missing cosigner share
          if (
            !/COSIGNER_MISSING|Unknown vault|unknown vault|Missing 2P|recreate multi-sig|no encrypted cosigner backup/i.test(
              m,
            )
          ) {
            // Other multi-sig errors: still surface (do not silent-bypass policy)
            throw e;
          }
        }
      }

      // --- Legacy secret-derived vault (vaultDerive) ---
      toast.loading('Trying legacy mnemonic vault key…', { id: toastId });
      const derived = deriveVaultWallet({
        mnemonic: mainMnemonic,
        subAddress: sub.address,
        index: sub.index,
      });
      const derivedAddr = String(derived.address).replace(/^0x/i, '').toLowerCase();
      const vaultNorm = vaultAddr.length === 48 ? vaultAddr.slice(0, 40) : vaultAddr;
      const derNorm = derivedAddr.length === 48 ? derivedAddr.slice(0, 40) : derivedAddr;

      if (derNorm !== vaultNorm && derivedAddr !== vaultAddr) {
        const hint = multiSigErr
          ? ` Multi-sig failed: ${String(multiSigErr.message || multiSigErr).slice(0, 160)}`
          : multiSigTried
            ? ''
            : ' No 2P client secret on this browser.';
        throw new Error(
          `Cannot spend this vault. Address is not your legacy secret-derived vault for sub #${sub.index}, ` +
            `and multi-sig cosigner cannot help (often after VPS redeploy / Force UI unlock alone). ` +
            `Derived would be ${derivedAddr.slice(0, 12)}… but vault is ${vaultAddr.slice(0, 12)}….` +
            hint +
            ` If this was multi-sig and cosigner lost d_dapp, funds need cosigner backup — creating a NEW vault will not recover the old address.`,
        );
      }

      const api = await createWarthogApi(selectedNode);
      const nonceId = getSmartNonce(vaultAddr, 0);
      toast.loading('Signing legacy vault → main…', { id: toastId });
      const { nonce, data } = await signAndSubmitTransaction(api, {
        privateKey: derived.privateKey,
        nonceId,
        buildSpec: {
          type: 'WART_TRANSFER',
          toAddress: mainAddr,
          amount: String(amount).trim(),
        },
      });
      bumpNonceAfterSuccess(vaultAddr, nonce, 0);
      const txHash = data?.txHash || data?.hash;
      if (!txHash) throw new Error('Node accepted legacy transfer but no tx hash returned');

      toast.success(`Legacy vault → main: ${String(txHash).slice(0, 12)}…`, {
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
const pollForLockNotice = async (subAddress, timeoutMs = 45000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { notices } = await client.request(gql`
        { notices(last: 5) { edges { node { payload } } } }
      `);
      const parsed = notices.edges
        .map(e => {
          try { return JSON.parse(toUtf8String(e.node.payload)); }
          catch { return null; }
        })
        .filter(Boolean);
      // Updated: Removed 'subwallet_locked' since backend now sends 'sweep_locked' for consistency
      if (parsed.some(n => n.type === 'sweep_locked' && n.subAddress === subAddress && n.verified)) {
        return true;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
};

  /**
   * Rebuild locked outstanding (E8) for a sub from full notice history.
   * minted = sum(sweep_locked.mintedE8), burned = sum(spoofed burns).
   * Source of truth after partial releases — do not trust a single stale notice.
   */
  const rebuildOutstandingE8FromNotices = async (subAddress, { last = 120 } = {}) => {
    const subNorm = String(subAddress || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    if (!subNorm) return null;
    const gqlClient = new GraphQLClient(getRollupGraphqlUrl());
    const { notices } = await gqlClient.request(gql`
      { notices(last: ${last}) { edges { node { payload } } } }
    `);
    let minted = 0n;
    let burned = 0n;
    let lastBurnNotice = null;
    let fullyUnlocked = false;
    for (const e of notices?.edges || []) {
      const n = parseNoticePayload(e.node.payload);
      if (!n?.type) continue;
      const nSub = String(n.subAddress || '')
        .replace(/^0x/i, '')
        .toLowerCase();
      if (nSub && nSub !== subNorm) continue;
      if (n.type === 'sweep_locked' && n.mintedE8 != null) {
        try {
          minted += BigInt(String(n.mintedE8));
        } catch {
          /* */
        }
      } else if (
        (n.type === 'spoofed_wwart_burned' || n.type === 'subwallet_unlocked') &&
        n.burnedE8 != null
      ) {
        try {
          burned += BigInt(String(n.burnedE8));
        } catch {
          /* */
        }
        // Keep the newest burn notice (GraphQL last:N is oldest→newest on this stack)
        lastBurnNotice = n;
        if (n.type === 'subwallet_unlocked' || String(n.remainingMintedE8 || '') === '0') {
          fullyUnlocked = true;
        }
      }
    }
    const outstandingE8 = fullyUnlocked
      ? 0n
      : minted > burned
        ? minted - burned
        : 0n;
    return {
      outstandingE8: outstandingE8.toString(),
      mintedE8: minted.toString(),
      burnedE8: burned.toString(),
      lastBurnNotice,
      fullyUnlocked: fullyUnlocked || outstandingE8 === 0n,
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
    const outstanding = outstandingE8Of(sub);
    if (sub.locked || outstanding > 0n) {
      return { key: 'locked', label: outstanding > 0n && !sub.locked ? 'Collateral residual 🔒' : 'Locked 🔒', className: 'status-locked' };
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

  const getVaultAddressForSub = async (subAddress) => {
    try {
      // Recreate client each call so origin is always current (and absolute)
      const gqlClient = new GraphQLClient(getRollupGraphqlUrl());
      const { notices } = await gqlClient.request(gql`
        { notices(last: 20) { edges { node { payload } } } }
      `);
      const parsed = (notices?.edges || [])
        .map((e) => parseNoticePayload(e.node.payload))
        .filter(Boolean);
      const relevant = parsed.filter(
        (n) =>
          n.subAddress === subAddress &&
          n.vaultAddress &&
          ['subwallet_pending', 'sweep_locked', 'subwallet_unlocked', 'vault_created'].includes(
            n.type,
          ),
      );
      if (relevant.length > 0) {
        // Take the most recent one (assuming last:20 is recent first)
        const latest = relevant[0];
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
  const loadOrCreateVault = async (sub) => {
    const displayed = sub.vaultAddress || sub.pendingVaultAddress;
    if (displayed) {
      setSubWallets((prev) =>
        prev.map((s) =>
          s.address === sub.address
            ? { ...s, vaultAddress: null, pendingVaultAddress: null, vaultBalance: null }
            : s,
        ),
      );
      setCheckedVault((prev) => ({ ...prev, [sub.index]: false }));
      toast('Vault hidden');
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
          // wiped (empty .data/threshold-shares.json), this vault cannot sign —
          // re-keygen is required (new vault address).
          const msg = String(e?.message || e);
          if (/unknown vault|404|not found/i.test(msg)) {
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
            throw e;
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
        const enc = encryptJsonWithMnemonic(vault.clientSecret, mainMnemonic);
        // Backup cosigner half encrypted — recover after VPS/cosigner wipe (same vault)
        const encBackup = encryptJsonWithMnemonic(vault.cosignerRegister, mainMnemonic);
        saveTwoPartyClientLocal({
          mainAddress: mainAddr,
          subAddress: sub.address,
          vaultAddress: vault.address,
          index: sub.index,
          encryptedClientSecret: enc,
          encryptedCosignerBackup: encBackup,
          scheme: vault.scheme,
        });

        // Offline opaque user-vault-share.txt (password AES, WartBunker-style). Client-only.
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
              cosignerRegister: vault.cosignerRegister,
              scheme: vault.scheme,
              ownerL1: l1Address,
            });
            const fname = downloadVaultShareBackupFile(plain, password);
            toast.success(
              `Save offline: ${fname} — password-encrypted blob. Cosigner keeps d_dapp separately.`,
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

  const isSubLocked = async (subAddress) => {
  try {
    const { notices } = await client.request(gql`
      { notices(last: 20) { edges { node { payload } } } }
    `);
    const parsed = notices.edges
      .map(e => {
        try { return JSON.parse(toUtf8String(e.node.payload)); }
        catch { return null; }
      })
      .filter(Boolean);
    // Updated: Removed 'subwallet_locked' since backend now sends 'sweep_locked' for consistency
    const relevant = parsed.filter(
      n => n.subAddress === subAddress && n.verified && ['subwallet_unlocked', 'sweep_locked'].includes(n.type)
    );
    // Note: Assumes notices are ordered by recency (last:20 fetches recent first); takes the most recent relevant one
    return relevant.length > 0 && relevant[0].type === 'sweep_locked';
  } catch {
    return false;
  }
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
        try {
          const vb = await fetchBalanceAndNonce(vAddr, true);
          setSubWallets((prev) =>
            prev.map((s) =>
              s.index === sub.index
                ? { ...s, vaultBalance: vb.balance || vb.spendable || '0' }
                : s,
            ),
          );
        } catch {
          /* ignore */
        }
      }

      if (fullyUnlocked) {
        toast.success(
          'Fully unlocked — you can Withdraw vault → main',
          { id: toastId, duration: 6000 },
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
      let locked = false;
      try {
        locked = await isSubLocked(subAddress);
      } catch {
        locked = !!existing?.locked;
      }

      const updates = {
        balance: subBal.balance || '0',
        spendable: subBal.spendable || subBal.balance || '0',
        locked,
      };

      // 1) Client-known vault (reliable after wipe)  2) GraphQL if rollup has notices
      let vaultAddr = (
        existing?.vaultAddress ||
        existing?.pendingVaultAddress ||
        ''
      )
        .toString()
        .replace(/^0x/i, '')
        .toLowerCase();
      try {
        const fromRollup = await getVaultAddressForSub(subAddress);
        if (fromRollup) {
          vaultAddr = String(fromRollup).replace(/^0x/i, '').toLowerCase();
        }
      } catch {
        /* GraphQL optional */
      }

      if (vaultAddr && vaultAddr.length >= 40) {
        updates.vaultAddress = vaultAddr;
        updates.pendingVaultAddress = vaultAddr;
        const vaultBal = await fetchBalanceAndNonce(vaultAddr, true);
        // Always overwrite cache with live node numbers (including "0")
        updates.vaultBalance = String(vaultBal.balance ?? '0');
        updates.vaultSpendable = String(
          vaultBal.spendable ?? vaultBal.balance ?? '0',
        );
        updates.vaultBalanceAt = Date.now();
      }

      if (!locked) {
        updates.mintedE8 = '0';
        updates.locking = false;
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

      const vaultMsg =
        updates.vaultBalance != null
          ? ` · vault free ${updates.vaultSpendable ?? updates.vaultBalance} (total ${updates.vaultBalance})`
          : vaultAddr
            ? ' · vault address known but balance fetch returned empty'
            : ' · no vault address on this sub';
      toast.success(
        `Live node: sub ${updates.balance} WART${vaultMsg}`,
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
  const renderVaultCard = (sub) => {
    const vaultAddr = sub.pendingVaultAddress || sub.vaultAddress;
    if (!vaultAddr) {
      return (
        <div className="sw-card sw-card--vault sw-card--empty">
          <div className="sw-card-head">
            <h4 className="sw-card-title">Vault</h4>
          </div>
          <p className="sw-card-empty-msg">No vault yet — create multi-sig vault to sweep &amp; mint.</p>
          <button
            type="button"
            className="btn primary small"
            onClick={() => loadOrCreateVault(sub)}
            disabled={loading || isUnlocking[sub.index]}
          >
            Load / create vault
          </button>
        </div>
      );
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

    return (
      <div
        className={`sw-card sw-card--vault ${sub.locking ? 'is-busy' : ''}`}
      >
        <div className="sw-card-head">
          <h4 className="sw-card-title">Vault</h4>
          <div className="sw-card-head-right">
            <button
              type="button"
              className="sw-pill sw-pill-muted sw-pill-copy"
              title={`Copy sub index ${sub.index}`}
              onClick={() => copyToClipboard(String(sub.index), 'Sub index')}
            >
              sub #{sub.index}
            </button>
            <span className={`sw-pill ${st.className}`}>{st.label}</span>
          </div>
        </div>

        {/* Always-visible summary — clear collateral vs withdrawable */}
        <div className="sw-card-meta">
          <div className="sw-meta-row">
            <span className="sw-meta-k">Sub index</span>
            <button
              type="button"
              className="sw-meta-v mono sw-link"
              title="Copy HD sub index"
              onClick={() => copyToClipboard(String(sub.index), 'Sub index')}
            >
              #{sub.index}
            </button>
          </div>
          <div className="sw-meta-row">
            <span className="sw-meta-k">Sub address</span>
            <button
              type="button"
              className="sw-meta-v mono sw-link"
              title={sub.address}
              onClick={() => copyToClipboard(sub.address, 'Sub address')}
            >
              {isSmallScreen
                ? `${String(sub.address).slice(0, 6)}…${String(sub.address).slice(-4)}`
                : sub.address}
            </button>
          </div>
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
          {outE8 > 0n && (
            <div className="sw-meta-row">
              <span
                className="sw-meta-k"
                title="Native WART on the vault pinned as mint capacity (not MetaMask ERC-20 wWART). One figure only — same as capacity credit."
              >
                Locked collateral
              </span>
              <span className="sw-meta-v">
                {e8ToWartDisplay(sub.mintedE8 || '0')} WART
                <span className="sw-live-tag">· capacity pin</span>
              </span>
            </div>
          )}
          <div className="sw-meta-row">
            <span
              className="sw-meta-k"
              title="Native WART you can Vault → main after Release (in vault − locked collateral)"
            >
              Withdrawable
            </span>
            <span className="sw-meta-v">
              {outE8 > 0n ? freeable : totalInVault === '…' ? '…' : freeable} WART
            </span>
          </div>
        </div>

        {/* Offline vault-share — opaque password .txt (WartBunker-style); never uploaded */}
        <div className="sw-card-actions sw-vault-share-backup">
          <p className="wh-hint sw-l1-track-hint" style={{ marginBottom: '0.5rem' }}>
            <strong>Vault share backup</strong> — your half of the key is only in this browser.
            Download <code>{VAULT_SHARE_DOWNLOAD_NAME}</code> as an opaque password blob (like{' '}
            <code>warthog_wallet.txt</code>). Cosigner still holds <code>d_dapp</code> separately.
          </p>
          <div className="sw-row-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            <button
              type="button"
              className="btn secondary small"
              onClick={() => downloadVaultShareBackup(sub)}
              disabled={loading}
              title="Download password-encrypted user-vault-share.txt"
            >
              Download vault share
            </button>
            <label
              className="btn secondary small"
              style={{ cursor: 'pointer', margin: 0 }}
              title="Import user-vault-share.txt into this browser only"
            >
              Import vault share…
              <input
                type="file"
                accept=".txt,text/plain,application/json,.json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  importVaultShareBackup(sub, e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
        </div>

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
                onClick={() => loadOrCreateVault(sub)}
                disabled={loading || isUnlocking[sub.index]}
                title="Hide vault from panel"
              >
                Hide vault
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

  // Sub wallets tab: all non-hidden subs. Vault tab: only those with a vault address.
  const visibleSubs = isVaultFocus
    ? baseVisibleSubs.filter((s) => !!(s.vaultAddress || s.pendingVaultAddress))
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
            <li><span className="step-num">1</span><span>Cycle vaults with the pager</span></li>
            <li><span className="step-num">2</span><span>Refresh for live vault totals</span></li>
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
    <div className="sw-card sw-card--l1-track">
      <div className="sw-card-head">
        <h4 className="sw-card-title">Balances across layers</h4>
        <div className="sw-card-head-right">
          <button
            type="button"
            className="btn secondary small"
            onClick={() => {
              if (typeof onRefreshL1Vault === 'function') onRefreshL1Vault();
              if (typeof onRefreshMmWwart === 'function') onRefreshMmWwart();
            }}
          >
            Refresh L1
          </button>
        </div>
      </div>
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
        <strong>{SHARE_TOKEN.symbol}</strong> and <strong>wWART claim</strong> are rollup shares
        against that capacity. MetaMask shows L1 ERC-20 after voucher execute.
      </p>
    </div>

    {/* Sub generation only on Sub wallets tab — not on Vault tab */}
    {!isVaultFocus && (
    <div className="subwallet-controls">
      <button
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
    </div>
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
            <button
              type="button"
              className="btn secondary small sw-pager-btn"
              onClick={goPrevSub}
              disabled={totalSubs <= 1}
              title={isVaultFocus ? 'Previous vault' : 'Previous sub-wallet'}
              aria-label={isVaultFocus ? 'Previous vault' : 'Previous sub-wallet'}
            >
              ← Prev
            </button>

            <div className="sw-pager-center">
              <span className="sw-pager-count">
                {safePos + 1} / {totalSubs}
              </span>
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
              <div className="sw-pager-dots">
                {visibleSubs.map((s, i) => {
                  const locked =
                    s.locked || (s.mintedE8 && BigInt(s.mintedE8 || '0') > 0n);
                  return (
                    <button
                      key={s.index}
                      type="button"
                      className={`sw-dot ${i === safePos ? 'is-active' : ''} ${
                        locked ? 'is-locked' : ''
                      }`}
                      onClick={() => setActiveSubPos(i)}
                      title={
                        isVaultFocus
                          ? `Vault ${i + 1}`
                          : `Sub-wallet ${i + 1} (index ${s.index})`
                      }
                      aria-label={
                        isVaultFocus
                          ? `Show vault ${i + 1} of ${totalSubs}`
                          : `Show sub-wallet ${i + 1} of ${totalSubs}`
                      }
                      aria-current={i === safePos ? 'true' : undefined}
                    >
                      {i + 1}
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              type="button"
              className="btn secondary small sw-pager-btn"
              onClick={goNextSub}
              disabled={totalSubs <= 1}
              title={isVaultFocus ? 'Next vault' : 'Next sub-wallet'}
              aria-label={isVaultFocus ? 'Next vault' : 'Next sub-wallet'}
            >
              Next →
            </button>
          </div>

          <div className={`sw-cards${isVaultFocus ? ' sw-cards--vault-only' : ''}`}>
            {/* ── Sub wallet card (Sub wallets tab only) ── */}
            {!isVaultFocus && (
            <div className={`sw-card sw-card--sub ${sub.hidden ? 'is-hidden-sub' : ''}`}>
              <div className="sw-card-head">
                <h4 className="sw-card-title">
                  Sub-wallet
                  {sub.hidden ? (
                    <span className="sw-live-tag"> · hidden</span>
                  ) : null}
                </h4>
                <button
                  type="button"
                  className="sw-pill sw-pill-muted sw-pill-copy"
                  title={`Click to copy full index: ${sub.index}`}
                  onClick={() => copyToClipboard(String(sub.index), 'Index copied')}
                >
                  {shortPill}
                </button>
              </div>

              {/* Always-visible summary */}
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
                {!hasVault && (
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() => loadOrCreateVault(sub)}
                    disabled={loading || isUnlocking[sub.index]}
                  >
                    Load / create vault
                  </button>
                )}
              </div>

              <details className="sw-details">
                <summary>Sub details &amp; list tools</summary>
                <div className="sw-details-body">
                  <div className="sw-card-meta">
                    <div className="sw-meta-row">
                      <span className="sw-meta-k">Index</span>
                      <button
                        type="button"
                        className="sw-meta-v mono sw-link"
                        onClick={() => copyToClipboard(String(sub.index), 'Index copied')}
                        title={`Full HD index: ${sub.index}`}
                      >
                        {sub.index}
                      </button>
                    </div>
                  </div>
                  <div className="sw-card-toolbar">
                    {sub.hidden ? (
                      <button
                        type="button"
                        className="btn secondary small"
                        onClick={() => unhideSubWallet(sub)}
                      >
                        Unhide
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn secondary small"
                        onClick={() => hideSubWallet(sub)}
                      >
                        Hide from list
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn danger small"
                      onClick={() => removeSubWallet(sub)}
                      title="Remove from UI only — does not move on-chain WART"
                    >
                      Remove from UI
                    </button>
                  </div>
                </div>
              </details>

              <details className="sw-details">
                <summary>Fund / exit (main ↔ sub)</summary>
                <div className="sw-details-body">
                  <p className="sw-hint">Main → sub deposit or return free sub balance to main (not vault).</p>
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
                      onClick={() => depositToSub(sub)}
                      disabled={isDepositing[sub.index] || loading}
                      className="btn primary small"
                    >
                      {isDepositing[sub.index] ? '…' : 'Main → sub'}
                    </button>
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

              <details className="sw-details">
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
                      disabled={isSweeping[sub.index] || loading}
                      className="input amount-input"
                    />
                    <button
                      type="button"
                      onClick={() => setMaxSweep(sub)}
                      disabled={isSweeping[sub.index] || loading}
                      className="btn secondary small"
                    >
                      Max
                    </button>
                    <button
                      type="button"
                      onClick={() => sweepToVault(sub, subSweepAmounts[sub.index])}
                      disabled={isSweeping[sub.index] || loading}
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
