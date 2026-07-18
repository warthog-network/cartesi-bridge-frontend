// src/components/SubWallet.jsx
import { useState, useEffect, useMemo } from 'react';
import { gql, GraphQLClient } from 'graphql-request';
import { keccak256, toUtf8Bytes, toUtf8String } from 'ethers-v6';
import { Toaster, toast } from 'react-hot-toast';
import '../styles/subWallet.css';
import { createWarthogApi } from '../utils/warthogClient.js';
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
  MULTISIG_SCHEME,
} from '../utils/twoPartyEcdsa.js';
import { registerMultiSigVault } from '../utils/cosignerClient.js';
import { multiSigTransferWart } from '../utils/multiSigTransfer.js';
const API_URL = '/api/proxy';

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

  // Screen size state
  const [isSmallScreen, setIsSmallScreen] = useState(window.innerWidth <= 688);

  // Keep carousel index in range when subs are added/removed
  useEffect(() => {
    if (subWallets.length === 0) {
      setActiveSubPos(0);
      return;
    }
    setActiveSubPos((pos) => Math.min(Math.max(0, pos), subWallets.length - 1));
  }, [subWallets.length]);

  // Pick sensible vault action tab only when switching which sub is focused
  useEffect(() => {
    const sub = subWallets[activeSubPos];
    if (!sub) return;
    try {
      const out = BigInt(sub.mintedE8 || '0');
      if (sub.locked || out > 0n) setVaultActionTab('burn');
      else setVaultActionTab('withdraw');
    } catch {
      setVaultActionTab('withdraw');
    }
    setSubActionTab('fund');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on sub switch
  }, [activeSubPos]);

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
        toast.success('Step 3 done: deposit confirmed — ready for Sweep to vault (mints spoofed wWART).');
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

  // Animated dots
  const LoadingDots = () => {
    const [dots, setDots] = useState(1);
    useEffect(() => {
      const interval = setInterval(() => setDots((prev) => (prev % 3) + 1), 500);
      return () => clearInterval(interval);
    }, []);
    return <span>{'.'.repeat(dots)}</span>;
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
      .then(() => toast.success('Address copied to clipboard!'))
      .catch(() => toast.error('Failed to copy address'));
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

      toast.success('Sub-wallet created!');
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

      toast.loading('MetaMask sweep_lock (mint spoofed wWART 1:1)…', { id: toastId });
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
      // pollForLockNotice returns boolean — re-fetch last sweep_locked for mintedE8
      let mintedFromNotice = null;
      try {
        const gqlClient = new GraphQLClient(getRollupGraphqlUrl());
        const { notices } = await gqlClient.request(gql`
          { notices(last: 15) { edges { node { payload } } } }
        `);
        const subNorm = String(sub.address).replace(/^0x/i, '').toLowerCase();
        const hits = (notices?.edges || [])
          .map((e) => parseNoticePayload(e.node.payload))
          .filter(
            (n) =>
              n?.type === 'sweep_locked' &&
              String(n.subAddress || '').replace(/^0x/i, '').toLowerCase() === subNorm,
          );
        if (hits[0]?.mintedE8 != null) mintedFromNotice = String(hits[0].mintedE8);
      } catch {
        /* ignore */
      }

      setSubWallets((prev) =>
        prev.map((s) => {
          if (s.index !== sub.index) return s;
          let nextMinted = s.mintedE8 || '0';
          try {
            const add = BigInt(mintedFromNotice || '0');
            nextMinted = (BigInt(s.mintedE8 || '0') + add).toString();
          } catch {
            if (mintedFromNotice) nextMinted = mintedFromNotice;
          }
          return {
            ...s,
            locked: true,
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
        'Step 4 done: locked. Spoofed wWART minted — burn any amount to unlock partially.',
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
   * 2P-ECDSA multi-sig withdraw — full private key never assembled.
   * Live-refetches vault balance first (UI cache is often stale after burns/sweeps).
   */
  const withdrawVaultToMain = async (sub) => {
    const vaultAddr = (sub.vaultAddress || sub.pendingVaultAddress || '')
      .toString()
      .replace(/^0x/i, '')
      .toLowerCase();
    if (!vaultAddr) return toast.error('No multi-sig vault — Load / create vault first');
    if (!mainMnemonic) return toast.error('Mnemonic required to decrypt 2P client secret');
    if (!l1Address) return toast.error('Connect MetaMask (L1) — cosigner checks owner');
    if (!address && !mainWallet?.address) {
      return toast.error('Main Warthog address required as recipient');
    }

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
          'Nothing freeable yet — burn spoofed wWART first (1:1 releases vault WART while residual stays locked).',
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
          `Only ${freeable} WART freeable (live free ${liveSpendable} − outstanding ${e8ToWartDisplay(outstandingE8)}).`,
        );
      }

      const local = loadTwoPartyClientLocal(mainWallet?.address || address, sub.address);
      if (!local?.encryptedClientSecret) {
        throw new Error(
          'Missing 2P client secret on this browser — recreate multi-sig vault here',
        );
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

  const pollForBurnNotice = async (subAddress, { fullUnlock = false, timeoutMs = 60000 } = {}) => {
    const start = Date.now();
    const subNorm = String(subAddress).replace(/^0x/i, '').toLowerCase();
    while (Date.now() - start < timeoutMs) {
      try {
        const gqlClient = new GraphQLClient(getRollupGraphqlUrl());
        const { notices } = await gqlClient.request(gql`
          { notices(last: 20) { edges { node { payload } } } }
        `);
        const parsed = (notices?.edges || [])
          .map((e) => parseNoticePayload(e.node.payload))
          .filter(Boolean);
        const hit = parsed.find((n) => {
          const sa = String(n.subAddress || '').replace(/^0x/i, '').toLowerCase();
          if (sa !== subNorm || !n.verified) return false;
          if (fullUnlock) return n.type === 'subwallet_unlocked';
          return n.type === 'spoofed_wwart_burned' || n.type === 'subwallet_unlocked';
        });
        if (hit) return hit;
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 2000));
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
   * Freeable native WART after partial burns (1:1 collateral).
   * freeable ≈ min(vaultBalance, max(0, vaultBalance − outstanding)).
   * Burn 30 of 99 → outstanding 69, vault 99 → freeable 30.
   */
  const freeableVaultWart = (sub) => {
    try {
      const balE8 = BigInt(wartToE8String(String(sub.vaultBalance || '0')));
      const outE8 = BigInt(sub.mintedE8 || '0');
      const freeE8 = balE8 > outE8 ? balE8 - outE8 : 0n;
      return e8ToWartDisplay(freeE8);
    } catch {
      return '0';
    }
  };

  /** Client-side outstanding spoofed wWART (E8). Not source of truth after rollup wipe. */
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
        saveTwoPartyClientLocal({
          mainAddress: mainAddr,
          subAddress: sub.address,
          vaultAddress: vault.address,
          index: sub.index,
          encryptedClientSecret: enc,
          scheme: vault.scheme,
        });

        toast.loading('Registering 2P material with co-signer (no full key)…', { id: toastId });
        await registerMultiSigVault({
          ...vault.cosignerRegister,
          owner: l1Address.toLowerCase(),
          subAddress: sub.address,
          index: sub.index,
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
        `2P-ECDSA vault ${vaultAddr.slice(0, 12)}… — full key never stored`,
        { id: toastId, duration: 6000 },
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
      return toast.error('No active lock / spoofed wWART on this sub');
    }

    const outstandingE8 = BigInt(sub.mintedE8 || '0');
    if (outstandingE8 <= 0n && !burnAll) {
      return toast.error('No outstanding spoofed wWART to burn on this sub');
    }

    let burnE8;
    try {
      if (burnAll || amountWart === 'max' || amountWart === '') {
        burnE8 = outstandingE8 > 0n ? outstandingE8.toString() : null; // null = backend burns full
      } else {
        burnE8 = wartToE8String(amountWart);
        if (outstandingE8 > 0n && BigInt(burnE8) > outstandingE8) {
          return toast.error(
            `Can only burn up to ${e8ToWartDisplay(outstandingE8)} spoofed wWART on this lock`,
            { duration: 6000 },
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
        ? 'Burning all spoofed wWART & unlocking…'
        : `Burning ${amountWart} spoofed wWART…`,
    );

    try {
      await send({
        type: 'sub_unlock',
        subAddress: sub.address,
        ...(burnE8 != null ? { burnAmt: String(burnE8) } : {}),
      });

      toast.loading('Waiting for burn notice…', { id: toastId });
      const notice = await pollForBurnNotice(sub.address, { fullUnlock: isFull });

      if (!notice) {
        toast.error('Burn submitted but notice not seen — check rollup / refresh', {
          id: toastId,
          duration: 7000,
        });
        return;
      }

      const remaining = notice.remainingMintedE8 != null
        ? String(notice.remainingMintedE8)
        : isFull
          ? '0'
          : (outstandingE8 - BigInt(burnE8 || 0)).toString();
      const fullyUnlocked = remaining === '0' || notice.type === 'subwallet_unlocked';

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
          `Burned. Outstanding ${e8ToWartDisplay(remaining)}; ~${freeHint} WART freeable to withdraw`,
          { id: toastId, duration: 8000 },
        );
      }
    } catch (err) {
      toast.error('Burn failed: ' + (err.message || err), { id: toastId, duration: 8000 });
    } finally {
      setIsUnlocking((prev) => ({ ...prev, [sub.index]: false }));
      setLoading(false);
    }
  };

  /** @deprecated use requestBurnUnlock */
  const requestUnlock = (sub) => requestBurnUnlock(sub, { burnAll: true });

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

  /** Vault card — status + tabbed burn / withdraw (like app Overview/Send tabs). */
  const VaultCard = ({ sub }) => {
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
    const canBurn = sub.locked || outE8 > 0n;

    return (
      <div
        className={`sw-card sw-card--vault ${sub.locking ? 'is-busy' : ''}`}
      >
        <div className="sw-card-head">
          <h4 className="sw-card-title">Vault</h4>
          <span className={`sw-pill ${st.className}`}>{st.label}</span>
        </div>

        <div className="sw-card-meta">
          <div className="sw-meta-row">
            <span className="sw-meta-k">Address</span>
            <button
              type="button"
              className="sw-meta-v mono sw-link"
              onClick={() => copyToClipboard(vaultAddr)}
              title={vaultAddr}
            >
              {displayedVaultAddr}
            </button>
          </div>
          <div className="sw-meta-row">
            <span className="sw-meta-k">Balance</span>
            <span className="sw-meta-v">
              {sub.vaultSpendable != null && sub.vaultSpendable !== ''
                ? `${sub.vaultSpendable} free`
                : sub.vaultBalance ?? '…'}{' '}
              WART
              {sub.vaultBalanceAt ? (
                <span className="sw-live-tag" title={new Date(sub.vaultBalanceAt).toLocaleString()}>
                  · live
                </span>
              ) : (
                <span className="sw-live-tag">· cached</span>
              )}
            </span>
          </div>
          {outE8 > 0n && (
            <div className="sw-meta-row">
              <span className="sw-meta-k">Outstanding</span>
              <span className="sw-meta-v">
                {e8ToWartDisplay(sub.mintedE8 || '0')} spoofed wWART
                {Number(freeable) > 0 ? (
                  <span className="sw-live-tag"> · freeable {freeable}</span>
                ) : null}
              </span>
            </div>
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
            title="Hide vault panel"
          >
            Hide
          </button>
          {!sub.locked && outE8 === 0n && (
            <button
              type="button"
              className="btn secondary small"
              disabled={loading}
              title="Clear stale client lock flags after cartesi wipe"
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

        {/* Action tabs — same idea as Overview / Send / Activity */}
        <nav className="sw-action-tabs" role="tablist" aria-label="Vault actions">
          <button
            type="button"
            role="tab"
            aria-selected={vaultActionTab === 'burn'}
            className={`sw-action-tab ${vaultActionTab === 'burn' ? 'is-active' : ''}`}
            onClick={() => setVaultActionTab('burn')}
          >
            Burn wWART
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={vaultActionTab === 'withdraw'}
            className={`sw-action-tab ${vaultActionTab === 'withdraw' ? 'is-active' : ''}`}
            onClick={() => setVaultActionTab('withdraw')}
          >
            Vault → main
          </button>
        </nav>

        {vaultActionTab === 'burn' && (
          <div className="sw-action-panel" role="tabpanel">
            {canBurn ? (
              <div className="action-group burn-group">
                <input
                  type="number"
                  step="0.00000001"
                  min="0"
                  placeholder="Burn amount"
                  value={burnAmounts[sub.index] || ''}
                  onChange={(e) =>
                    setBurnAmounts((prev) => ({ ...prev, [sub.index]: e.target.value }))
                  }
                  disabled={isUnlocking[sub.index] || loading}
                  className="input amount-input"
                  title={`Max outstanding ${e8ToWartDisplay(sub.mintedE8 || '0')}`}
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
                  {isUnlocking[sub.index] ? '…' : 'Burn'}
                </button>
                <button
                  type="button"
                  className="btn danger small"
                  disabled={isUnlocking[sub.index] || loading}
                  onClick={() => requestBurnUnlock(sub, { burnAll: true })}
                  title="Burn all outstanding & fully unlock"
                >
                  Burn all
                </button>
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
                    toast.success('Cleared client lock/collateral (UI only)', {
                      duration: 5000,
                    });
                  }}
                  disabled={loading}
                  title="UI-only unlock after rollup wipe"
                >
                  Force UI unlock
                </button>
              </div>
            ) : (
              <p className="sw-tab-empty">
                Nothing to burn — vault unlocked (outstanding 0).
              </p>
            )}
            {isUnlocking[sub.index] && (
              <div className="status-message status-unlock">
                <div className="spinner" />
                <span>
                  Burning spoofed wWART
                  <LoadingDots />
                </span>
              </div>
            )}
          </div>
        )}

        {vaultActionTab === 'withdraw' && (
          <div className="sw-action-panel" role="tabpanel">
            <div className="action-group vault-withdraw-group">
              <input
                type="number"
                step="0.00000001"
                placeholder={
                  outE8 > 0n ? `Freeable ≤ ${freeable}` : sub.vaultBalance || '0'
                }
                value={vaultWithdrawAmounts[sub.index] || ''}
                onChange={(e) =>
                  setVaultWithdrawAmounts((prev) => ({
                    ...prev,
                    [sub.index]: e.target.value,
                  }))
                }
                disabled={
                  isVaultWithdrawing[sub.index] ||
                  loading ||
                  !sub.vaultBalance ||
                  Number(sub.vaultBalance) <= 0 ||
                  (outE8 > 0n && Number(freeable) <= 0)
                }
                className="input amount-input"
                title={
                  outE8 > 0n
                    ? `Freeable ${freeable} (vault − outstanding). Burn more to free more.`
                    : 'Multi-sig send to main (live balance checked on submit)'
                }
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
                title="2P multi-sig vault → main"
              >
                {isVaultWithdrawing[sub.index] ? 'Sending…' : 'Withdraw'}
              </button>
            </div>
            {outE8 > 0n && Number(freeable) <= 0 && (
              <p className="sw-tab-empty">
                Nothing freeable yet — switch to <strong>Burn wWART</strong> first.
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
        )}
      </div>
    );
  };

  const totalSubs = subWallets.length;
  const safePos =
    totalSubs === 0 ? 0 : Math.min(Math.max(0, activeSubPos), totalSubs - 1);
  const activeSub = totalSubs > 0 ? subWallets[safePos] : null;

  const goPrevSub = () => {
    if (totalSubs <= 1) return;
    setActiveSubPos((p) => (p - 1 + totalSubs) % totalSubs);
  };
  const goNextSub = () => {
    if (totalSubs <= 1) return;
    setActiveSubPos((p) => (p + 1) % totalSubs);
  };

  const generateAndFocus = async () => {
    const before = subWallets.length;
    await generateLockedSubWallet();
    // New sub is appended — focus it after state settles
    setTimeout(() => setActiveSubPos(before), 50);
  };

  return (
  <section className="subwallet-section">
    <div className="subwallet-top">
      <h3>Sub-wallets</h3>
      <details className="bridge-flow-guide">
        <summary>How it works</summary>
        <p className="bridge-flow-lead">
          Fund sub (any source) → <strong>sweep to vault</strong> → mint spoofed wWART 1:1 → burn to free → multi-sig withdraw.
          Needs MetaMask + seed + rollup.
        </p>
        <ol className="bridge-flow-steps">
          <li><span className="step-num">1</span><span>Generate sub · Load/create vault</span></li>
          <li><span className="step-num">2</span><span>Fund sub (main or peer send)</span></li>
          <li><span className="step-num">3</span><span>Refresh · Sweep any free amount → mint</span></li>
          <li><span className="step-num">4</span><span>Burn spoofed wWART · vault → main</span></li>
        </ol>
      </details>
    </div>

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
          title="Salted index to regenerate"
        />
        <button
          onClick={async () => {
            await regenerateSubWallet();
            // Jump to regenerated index if present
            const idx = Number(regenIndex);
            if (!Number.isNaN(idx)) {
              const pos = subWallets.findIndex((s) => s.index === idx);
              if (pos >= 0) setActiveSubPos(pos);
              else setActiveSubPos(Math.max(0, subWallets.length - 1));
            }
          }}
          disabled={loading || !regenIndex}
          className="btn secondary small"
        >
          Regen
        </button>
      </div>
    </div>

    {totalSubs === 0 && (
      <div className="sw-empty">
        <p>No sub-wallets yet. Generate one to start the bridge path.</p>
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

      return (
        <div className="sw-carousel" key={sub.index}>
          {/* Pager: cycle sub + paired vault without showing every sub */}
          <div className="sw-pager" role="navigation" aria-label="Sub-wallet switcher">
            <button
              type="button"
              className="btn secondary small sw-pager-btn"
              onClick={goPrevSub}
              disabled={totalSubs <= 1}
              title="Previous sub-wallet"
              aria-label="Previous sub-wallet"
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
                title="Jump to sub-wallet"
                aria-label="Select sub-wallet"
              >
                {subWallets.map((s, i) => {
                  const short = `${String(s.address).slice(0, 6)}…${String(s.address).slice(-4)}`;
                  const locked = s.locked || (s.mintedE8 && BigInt(s.mintedE8 || '0') > 0n);
                  return (
                    <option key={s.index} value={i}>
                      {i + 1}. #{s.index} · {short}
                      {locked ? ' · locked' : ''}
                      {s.balance && Number(s.balance) > 0 ? ` · ${s.balance} WART` : ''}
                    </option>
                  );
                })}
              </select>
              <div className="sw-pager-dots">
                {subWallets.map((s, i) => {
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
                      title={`Sub-wallet ${i + 1} (index ${s.index})`}
                      aria-label={`Show sub-wallet ${i + 1} of ${totalSubs}`}
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
              title="Next sub-wallet"
              aria-label="Next sub-wallet"
            >
              Next →
            </button>
          </div>

          <div className="sw-cards">
            {/* ── Sub wallet card ── */}
            <div className="sw-card sw-card--sub">
              <div className="sw-card-head">
                <h4 className="sw-card-title">Sub-wallet</h4>
                <span className="sw-pill sw-pill-muted" title={`Index ${sub.index}`}>
                  {shortPill}
                </span>
              </div>

              <div className="sw-card-meta">
                <div className="sw-meta-row">
                  <span className="sw-meta-k">Address</span>
                  <button
                    type="button"
                    className="sw-meta-v mono sw-link"
                    onClick={() => copyToClipboard(sub.address)}
                    title={sub.address}
                  >
                    {displayedSubAddr}
                  </button>
                </div>
                <div className="sw-meta-row">
                  <span className="sw-meta-k">Balance</span>
                  <span className="sw-meta-v">{sub.balance ?? '0'} WART</span>
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

              {/* Action tabs — same pattern as Overview / Send / Activity */}
              <nav className="sw-action-tabs" role="tablist" aria-label="Sub-wallet actions">
                <button
                  type="button"
                  role="tab"
                  aria-selected={subActionTab === 'fund'}
                  className={`sw-action-tab ${subActionTab === 'fund' ? 'is-active' : ''}`}
                  onClick={() => setSubActionTab('fund')}
                >
                  Fund / exit
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={subActionTab === 'sweep'}
                  className={`sw-action-tab ${subActionTab === 'sweep' ? 'is-active' : ''}`}
                  onClick={() => setSubActionTab('sweep')}
                >
                  Sweep &amp; mint
                </button>
              </nav>

              {subActionTab === 'fund' && (
                <div className="sw-action-panel" role="tabpanel">
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
                      title="Optional main → sub"
                    />
                    <button
                      type="button"
                      onClick={() => depositToSub(sub)}
                      disabled={isDepositing[sub.index] || loading}
                      className="btn primary small"
                      title="Main → sub (optional if peers fund the sub)"
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
                      title="Sub → main (not vault)"
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
                      title="Sub → main"
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
              )}

              {subActionTab === 'sweep' && (
                <div className="sw-action-panel" role="tabpanel">
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
                      title={
                        !hasVault
                          ? 'Create vault first'
                          : 'Any free WART on sub → vault + mint spoofed wWART'
                      }
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
                      title="Sweep free balance to vault + mint spoofed wWART 1:1"
                    >
                      {isSweeping[sub.index] ? 'Sweeping…' : 'Sweep & mint'}
                    </button>
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
                        title="Re-post sweep_lock if mint failed after funds hit vault"
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
              )}
            </div>

            {/* Paired vault for this sub only */}
            <VaultCard sub={sub} />
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
