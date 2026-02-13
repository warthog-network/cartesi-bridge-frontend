// src/components/SubWallet.jsx
import { useState, useEffect } from 'react';
import { gql, GraphQLClient } from 'graphql-request';
import { ethers } from 'ethers';
import { Toaster, toast } from 'react-hot-toast';
import '../styles/subWallet.css';
const GRAPHQL_URL = 'http://localhost:8080/graphql';
const INSPECT_URL = "/rollup/inspect";
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

  // Regenerate state
  const [regenIndex, setRegenIndex] = useState('');

  // Vault checked state
  const [checkedVault, setCheckedVault] = useState({});

  // Active deposit tx monitoring (for enabling manual sweep after confirmation)
  const [activeDepositTxs, setActiveDepositTxs] = useState({}); // { subIndex: txHash }

  // Screen size state
  const [isSmallScreen, setIsSmallScreen] = useState(window.innerWidth <= 688);

  const client = new GraphQLClient(GRAPHQL_URL);

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
        toast.success('Deposit confirmed! You can now sweep to vault manually.');
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
      return ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes(noticePayload + userMainAddress + timestamp)
      );
    } catch {
      return 'fallback_salt';
    }
  };

  const generateLockedSubWallet = async () => {
    if (!mainMnemonic) return toast.error('Main wallet mnemonic required');

    const salt = await fetchCartesiSalt(mainWallet.address);
    const saltedIndex = subIndex + parseInt(salt.slice(2, 10), 16) % (2 ** 31 - 1);
    const path = `m/44'/2070'/0'/0/${saltedIndex}'`;

    try {
      const hdNode = ethers.utils.HDNode.fromMnemonic(mainMnemonic).derivePath(path);
      const publicKeyHex = ethers.utils.hexlify(hdNode.publicKey);
      const shaHex = ethers.utils.sha256(publicKeyHex);
      const ripemdHex = ethers.utils.ripemd160(shaHex);
      const ripemd = ripemdHex.slice(2);
      const checksum = ethers.utils.sha256(ripemdHex).slice(2, 10);
      const subAddress = ripemd + checksum;

      const newSub = { index: saltedIndex, address: subAddress, locked: false, balance: '0', vaultAddress: null, depositTxHash: null, sweepTxHash: null, pendingVaultAddress: null, locking: false, vaultBalance: null };
      setSubWallets(prev => [...prev, newSub]);
      setSubIndex(prev => prev + 1);

      toast.success('Sub-wallet created!');
      await refreshSubBalance(subAddress);
    } catch (err) {
      toast.error('Failed to generate sub-wallet');
    }
  };

  const regenerateSubWallet = async () => {
    if (!mainMnemonic) return toast.error('Main mnemonic required');
    if (!regenIndex || isNaN(regenIndex)) return toast.error('Enter a valid index number');

    const saltedIndex = Number(regenIndex);
    const path = `m/44'/2070'/0'/0/${saltedIndex}'`;

    try {
      const hdNode = ethers.utils.HDNode.fromMnemonic(mainMnemonic).derivePath(path);
      const publicKeyHex = ethers.utils.hexlify(hdNode.publicKey);
      const shaHex = ethers.utils.sha256(publicKeyHex);
      const ripemdHex = ethers.utils.ripemd160(shaHex);
      const ripemd = ripemdHex.slice(2);
      const checksum = ethers.utils.sha256(ripemdHex).slice(2, 10);
      const subAddress = ripemd + checksum;

      // Replace or add the regenerated wallet
      setSubWallets(prev => {
        const filtered = prev.filter(s => s.index !== saltedIndex);
        return [...filtered, { index: saltedIndex, address: subAddress, locked: false, balance: '0', vaultAddress: null, depositTxHash: null, sweepTxHash: null, pendingVaultAddress: null, locking: false, vaultBalance: null }];
      });

      // If it was the last one or higher, update subIndex if needed
      if (saltedIndex >= subIndex) {
        setSubIndex(saltedIndex + 1);
      }

      toast.success('Sub-wallet regenerated!');
      await refreshSubBalance(subAddress);
      setRegenIndex(''); // clear input
    } catch (err) {
      toast.error('Failed to regenerate sub-wallet');
    }
  };

  const depositToSub = async (sub) => {
    const amount = subDeposits[sub.index]?.trim();
    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return toast.error('Enter a valid amount');
    }

    setIsDepositing(prev => ({ ...prev, [sub.index]: true }));
    setLoading(true);
    const toastId = toast.loading('Processing deposit...');

    try {
      const txData = await sendTransaction(
        mainWallet.privateKey,
        mainWallet.address,
        sub.address,
        amount,
        '0.01'
      );

      const txHash = txData?.data?.txHash || txData?.txHash || txData?.hash;
      if (!txHash) throw new Error('No tx hash received');

      toast.success('Deposit sent! Securing wallet...', { id: toastId });

      setSubWallets(prev =>
        prev.map(s =>
          s.index === sub.index
            ? { ...s, balance: (Number(s.balance || 0) + Number(amount)).toFixed(8), depositTxHash: txHash }
            : s
        )
      );

      setSubDeposits(prev => ({ ...prev, [sub.index]: '' }));

      // Send sub_lock immediately
      const vaultAddress = await sendSubLock(sub, txHash);
      if (vaultAddress) {
        setSubWallets(prev =>
          prev.map(s => s.address === sub.address ? { ...s, pendingVaultAddress: vaultAddress, locking: true } : s)
        );
        setActiveDepositTxs(prev => ({ ...prev, [sub.index]: txHash })); // Start monitoring
        toast.success('Deposit sent! Monitoring for confirmations...', { id: toastId });
      } else {
        toast.warning('Deposit sent, but sub_lock failed. Try again later.', { id: toastId });
      }

      await refreshSubBalance(sub.address);

      // Fetch and set vault balance after deposit
      if (vaultAddress) {
        try {
          const vaultBalanceData = await fetchBalanceAndNonce(vaultAddress, false);
          setSubWallets(prev =>
            prev.map(s => s.address === sub.address ? { ...s, vaultBalance: vaultBalanceData.balance || '0' } : s)
          );
        } catch (err) {
          console.error('Failed to fetch vault balance:', err);
        }
      }
    } catch (err) {
      toast.error('Deposit failed: ' + err.message, { id: toastId });
    } finally {
      setIsDepositing(prev => ({ ...prev, [sub.index]: false }));
      setLoading(false);
      setAutoLockPhase(prev => ({ ...prev, [sub.index]: null }));
    }
  };

  // Simplified: Send sub_lock and poll for pending notice
  const sendSubLock = async (sub, txHash) => {
    try {
      const proof = await getWartTxProof(txHash);
      await send({
        type: 'sub_lock',
        subAddress: sub.address,
        proof,
        index: sub.index,
        recipient: l1Address,
      });
      const pendingNotice = await pollForPendingNotice(sub.address);
      return pendingNotice ? pendingNotice.vaultAddress : null;
    } catch (err) {
      console.error('sendSubLock error:', err.message);
      return null;
    }
  };

  // Sweep to vault and complete lock
  const sweepToVault = async (sub, amount) => {
    const vaultAddress = sub.vaultAddress || sub.pendingVaultAddress;
    if (!vaultAddress) return toast.error('No vault address available');

    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return toast.error('Enter a valid amount');
    }
    if (Number(amount) > Number(sub.balance || 0)) {
      return toast.error('Insufficient balance');
    }

    setIsSweeping(prev => ({ ...prev, [sub.index]: true }));
    setSubWallets(prev => prev.map(s => s.index === sub.index ? { ...s, locking: true } : s));
    setLoading(true);
    const toastId = toast.loading('Sweeping to vault...');

    try {
      if (!mainMnemonic) throw new Error('Main mnemonic required');

      // Derive sub's private key
      const saltedIndex = sub.index;
      const path = `m/44'/2070'/0'/0/${saltedIndex}'`;
      const hdNode = ethers.utils.HDNode.fromMnemonic(mainMnemonic).derivePath(path);
      let subPrivateKey = ethers.utils.hexlify(hdNode.privateKey);
      if (subPrivateKey.startsWith('0x')) subPrivateKey = subPrivateKey.slice(2);

      const txData = await sendTransaction(
        subPrivateKey, // Sub's PK as hex string without 0x
        sub.address, // From
        vaultAddress, // To
        amount,
        '0.01' // Fee
      );

      const sweepTxHash = txData?.data?.txHash || txData?.txHash;
      if (!sweepTxHash) throw new Error('No sweep tx hash');

      setSubWallets(prev => prev.map(s => s.index === sub.index ? { ...s, sweepTxHash } : s));

      // Wait for sweep confirmations
      const sweepConfirmed = await pollTxConfirmations(sweepTxHash, 2);
      if (!sweepConfirmed) throw new Error('Sweep not confirmed in time');

      // Get proof of sweep tx
      const sweepProof = await getWartTxProof(sweepTxHash);

      // Update toast to indicate sweep is complete (proof received)
      toast.success('Sweep complete! Finalizing lock...', { id: toastId });

      // Send sweep_lock to complete
      await send({
        type: 'sweep_lock',
        subAddress: sub.address,
        sweepProof,
        index: sub.index,
      });

      // Poll for completion
      const completed = await pollForLockNotice(sub.address, 90000); // Increased timeout
      if (completed) {
        setSubWallets(prev =>
          prev.map(s => s.index === sub.index ? { ...s, locked: true, locking: false, vaultAddress: s.pendingVaultAddress || s.vaultAddress, pendingVaultAddress: null } : s)
        );
        // Refresh subwallet balance (should be 0 after sweep)
        await refreshSubBalance(sub.address);
        // Fetch and display vault balance (Warhog address balance)
        if (vaultAddress) {
          const vaultBalanceData = await fetchBalanceAndNonce(vaultAddress, false);
          toast.success(`Vault Balance: ${vaultBalanceData.balance || '0'} WART`, { duration: 4000 });
        }
        toast.success('Lock completed! Vault received swept deposit.', { id: toastId });
      } else {
        toast.error('Lock completion not confirmed', { id: toastId });
        setSubWallets(prev =>
          prev.map(s => s.index === sub.index ? { ...s, locking: false } : s)
        );
      }
    } catch (err) {
      toast.error('Sweep and lock failed: ' + err.message, { id: toastId });
      setSubWallets(prev =>
        prev.map(s => s.index === sub.index ? { ...s, locking: false } : s)
      );
    } finally {
      setIsSweeping(prev => ({ ...prev, [sub.index]: false }));
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

      const path = `m/44'/2070'/0'/0/${sub.index}'`;
      const hdNode = ethers.utils.HDNode.fromMnemonic(mainMnemonic).derivePath(path);

      // FIX: Convert bytes to hex string and remove '0x' prefix if present → send raw hex
      let subPrivateKey = ethers.utils.hexlify(hdNode.privateKey);
      if (subPrivateKey.startsWith('0x')) {
        subPrivateKey = subPrivateKey.slice(2);
      }

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

  const setMaxSweep = (sub) => {
    setSubSweepAmounts(prev => ({
      ...prev,
      [sub.index]: sub.balance || '0'
    }));
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
          try { return JSON.parse(ethers.utils.toUtf8String(e.node.payload)); }
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

  const pollForUnlockNotice = async (subAddress, timeoutMs = 45000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const { notices } = await client.request(gql`
          { notices(last: 5) { edges { node { payload } } } }
        `);
        const parsed = notices.edges
          .map(e => {
            try { return JSON.parse(ethers.utils.toUtf8String(e.node.payload)); }
            catch { return null; }
          })
          .filter(Boolean);
        if (parsed.some(n => n.type === 'subwallet_unlocked' && n.subAddress === subAddress && n.verified)) {
          return true;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
    return false;
  };

  const pollForPendingNotice = async (subAddress, timeoutMs = 45000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const { notices } = await client.request(gql`
          { notices(last: 5) { edges { node { payload } } } }
        `);
        const parsed = notices.edges
          .map(e => {
            try { return JSON.parse(ethers.utils.toUtf8String(e.node.payload)); }
            catch { return null; }
          })
          .filter(Boolean);
        const notice = parsed.find(n => n.type === 'subwallet_pending' && n.subAddress === subAddress);
        if (notice) return notice;
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
    return null;
  };

  const pollTxConfirmations = async (txHash, requiredConfirmations = 2) => {
    const nodeBaseParam = `nodeBase=${encodeURIComponent(selectedNode)}`;
    let attempts = 0;
    const maxAttempts = 60; // 5 mins at 5s
    while (attempts < maxAttempts) {
      try {
        const response = await fetch(`${API_URL}?nodePath=transaction/lookup/${txHash}&${nodeBaseParam}`);
        const data = await response.json();
        const tx = data.data?.transaction || data.data || data;
        if (tx.blockHeight !== undefined && tx.confirmations >= requiredConfirmations) {
          return true;
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
      const { notices } = await client.request(gql`
        { notices(last: 20) { edges { node { payload } } } }
      `);
      const parsed = notices.edges
        .map(e => {
          try { return JSON.parse(ethers.utils.toUtf8String(e.node.payload)); }
          catch { return null; }
        })
        .filter(Boolean);
      const relevant = parsed.filter(
        n => n.subAddress === subAddress && ['subwallet_pending', 'sweep_locked', 'subwallet_unlocked', 'vault_created'].includes(n.type)
      );
      if (relevant.length > 0) {
        // Take the most recent one (assuming last:20 is recent first)
        const latest = relevant[0];
        return latest.vaultAddress;
      }
    } catch (err) {
      console.error('getVaultAddressForSub error:', err);
    }
    return null;
  };

  const isSubLocked = async (subAddress) => {
  try {
    const { notices } = await client.request(gql`
      { notices(last: 20) { edges { node { payload } } } }
    `);
    const parsed = notices.edges
      .map(e => {
        try { return JSON.parse(ethers.utils.toUtf8String(e.node.payload)); }
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

 const requestUnlock = async (sub) => {
  setIsUnlocking(prev => ({ ...prev, [sub.index]: true }));
  setLoading(true); // optional — depends if you want global loading too

  const toastId = toast.loading('Requesting unlock...');

  try {
    await send({ type: 'sub_unlock', subAddress: sub.address });

    toast.loading('Waiting for unlock confirmation...', { id: toastId });

    const unlocked = await pollForUnlockNotice(sub.address); // ← give it a bit more time if needed

    if (unlocked) {
      setSubWallets(prev =>
        prev.map(s => s.index === sub.index ? { ...s, locked: false } : s)
      );
      toast.success('Sub-wallet unlocked!', { id: toastId });
    } else {
      toast.error('Unlock not confirmed in time', { id: toastId });
    }
  } catch (err) {
    toast.error('Unlock request failed: ' + err.message, { id: toastId });
  } finally {
    setIsUnlocking(prev => ({ ...prev, [sub.index]: false }));
    setLoading(false);
  }
};

  const refreshSubBalance = async (subAddress) => {
    try {
      const { balance } = await fetchBalanceAndNonce(subAddress, true);
      const locked = await isSubLocked(subAddress);
      let updates = { balance: balance || '0', locked };

      // Fetch vault address if any exists
      const vaultAddr = await getVaultAddressForSub(subAddress);
      if (vaultAddr) {
        updates.vaultAddress = vaultAddr;
        // Fetch vault balance
        const vaultBalanceData = await fetchBalanceAndNonce(vaultAddr, false);
        updates.vaultBalance = vaultBalanceData.balance || '0';
      }

      setSubWallets(prev =>
        prev.map(sub =>
          sub.address === subAddress ? { ...sub, ...updates } : sub
        )
      );
      toast.success('Balance & lock state refreshed', { duration: 2000 });
    } catch {
      toast.error('Failed to refresh');
    }
  };

  const inspectVault = async (vaultAddress) => {
    try {
      const res = await fetch(`${INSPECT_URL}/vault/${vaultAddress.slice(2).toLowerCase()}`);
      const data = await res.json();
      if (data.reports?.length > 0) {
        const payload = JSON.parse(ethers.utils.toUtf8String(data.reports[0].payload));
        toast.success(`Vault Balances: Liquid ${payload.liquid}, wWART ${payload.wWART}, CTSI ${payload.CTSI}, ETH ${payload.eth}, USDC ${payload.usdc}`);
      } else {
        toast('Vault data not available yet');
      }
    } catch (err) {
      toast.error('Failed to inspect vault');
    }
  };

  const getLockStatusText = (phase) => {
    if (phase === 'preparing') return 'Preparing proof (may take a few minutes)';
    if (phase === 'fetching')   return 'Waiting for Cartesi to index transaction';
    if (phase === 'confirming') return 'Submitting lock & waiting for confirmation';
    if (phase === 'waiting_confirmations') return 'Waiting for deposit confirmations (1-2 blocks)';
    if (phase === 'sweeping') return 'Sweeping funds to vault';
    return 'Securing sub-wallet...';
  };

  // Refactored VaultInfo component
  const VaultInfo = ({ sub }) => {
    if (!sub.pendingVaultAddress && !sub.vaultAddress) return null;

    const vaultAddr = sub.pendingVaultAddress || sub.vaultAddress;
    const displayedVaultAddr = isSmallScreen ? `${vaultAddr.slice(0, 6)}...${vaultAddr.slice(-4)}` : vaultAddr;

    return (
      <div style={{ opacity: sub.locking ? 0.5 : 1, pointerEvents: sub.locking ? 'none' : 'auto', background: 'rgba(0,0,0,0.8)', padding: '10px', borderRadius: '5px', textAlign: 'center' }}>
        <div>
          <strong>Vault Address:</strong>{' '}
          <span style={{ cursor: 'pointer' }} onClick={() => copyToClipboard(vaultAddr)} title="Click to copy">
            {displayedVaultAddr}
          </span>
        </div>
        <div><strong>Vault Balance:</strong> {sub.vaultBalance ?? 'Loading...'} WART</div>
        <div>
          <strong>Status:</strong>{' '}
          <span className={sub.locked ? 'status-locked' : 'status-unlocked'}>
            {sub.locked ? 'Locked 🔒' : 'Unlocked 🔓'}
          </span>
        </div>
        {sub.vaultAddress && (
          <button
            onClick={() => inspectVault(sub.vaultAddress)}
            disabled={loading}
            className="btn primary small"
          >
            Inspect Vault
          </button>
        )}
        {sub.locked && (
          <>
            <button
              onClick={() => requestUnlock(sub)}
              disabled={loading || isUnlocking[sub.index]}
              className="btn danger small"
            >
              {isUnlocking[sub.index] ? 'Unlocking...' : 'Request Unlock'}
            </button>
            <button
              onClick={() => {
                setSubWallets(prev =>
                  prev.map(s => s.index === sub.index ? { ...s, locked: false } : s)
                );
                toast.success('Force unlocked for testing!');
              }}
              disabled={loading}
              className="btn danger small"
            >
              Force Unlock
            </button>
          </>
        )}
        {isUnlocking[sub.index] && (
          <div className="status-message status-unlock">
            <div className="spinner" />
            <span>
              Requesting unlock & waiting for confirmation
              <LoadingDots />
            </span>
          </div>
        )}
      </div>
    );
  };

return (
  <section className="subwallet-section">
    <h3>Sub-Wallets (Locked with Cartesi Proofs)</h3>

    <div className="subwallet-controls">
      <button
        onClick={generateLockedSubWallet}
        disabled={loading}
        className="btn primary small"
      >
        + Generate New Sub-Wallet
      </button>

      <div className="regen-group">
        <input
          type="number"
          placeholder="Enter salted index to regenerate"
          value={regenIndex}
          onChange={(e) => setRegenIndex(e.target.value)}
          className="input regen-input"
        />
        <button
          onClick={regenerateSubWallet}
          disabled={loading || !regenIndex}
          className="btn primary small"
        >
          Regenerate
        </button>
      </div>
    </div>

    <ul className="subwallet-list">
      {subWallets.map((sub) => {
        const displayedSubAddr = isSmallScreen ? `${sub.address.slice(0, 6)}...${sub.address.slice(-4)}` : sub.address;
        return (
        <li
          key={sub.index}
          className={`subwallet-item ${sub.locked ? 'locked' : 'unlocked'}`}
          style={{ textAlign: 'left' }}
        >
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <button
              onClick={() => refreshSubBalance(sub.address)}
              disabled={loading || isUnlocking[sub.index]}
              className="btn primary small"
            >
              Refresh
            </button>
            <button
              onClick={async () => {
                const hasChecked = checkedVault[sub.index];
                if (sub.vaultAddress) {
                  // Hide vault
                  setSubWallets(prev => prev.map(s => s.address === sub.address ? { ...s, vaultAddress: null, vaultBalance: null } : s));
                  setCheckedVault(prev => ({ ...prev, [sub.index]: false }));
                  toast('Vault hidden');
                } else if (hasChecked) {
                  // Generate vault
                  send({
                    type: 'create_vault',
                    subAddress: sub.address,
                    index: sub.index,
                    owner: mainWallet.address
                  });
                  toast('Creating empty vault...');
                  // After sending, refresh to show the vault
                  setTimeout(() => refreshSubBalance(sub.address), 5000);
                } else {
                  // Show vault
                  const vaultAddr = await getVaultAddressForSub(sub.address);
                  setCheckedVault(prev => ({ ...prev, [sub.index]: true }));
                  if (vaultAddr) {
                    setSubWallets(prev => prev.map(s => s.address === sub.address ? { ...s, vaultAddress: vaultAddr } : s));
                    const vaultBalanceData = await fetchBalanceAndNonce(vaultAddr, false);
                    setSubWallets(prev => prev.map(s => s.address === sub.address ? { ...s, vaultBalance: vaultBalanceData.balance || '0' } : s));
                    toast.success('Vault loaded');
                  } else {
                    toast('No vault found. Deposit to create one.');
                  }
                }
              }}
              disabled={loading}
              className="btn primary small"
            >
              {(() => {
                const hasChecked = checkedVault[sub.index];
                return sub.vaultAddress ? 'Hide Vault' : hasChecked ? 'Generate Vault' : 'Show Vault';
              })()}
            </button>
          </div>
          <div className="subwallet-info">
            <div>
              <strong>Index:</strong> {sub.index}
            </div>
            <div>
              <strong>Address:</strong>{' '}
              <span style={{ cursor: 'pointer' }} onClick={() => copyToClipboard(sub.address)} title="Click to copy">
                {displayedSubAddr}
              </span>
            </div>
            <div>
              <strong>Balance:</strong> {sub.balance ?? '0'} WART
            </div>

            <VaultInfo sub={sub} />
          </div>

     <div className="subwallet-actions">

  {/* Deposit */}
  <div className="action-group deposit-group">
    <input
      type="number"
      step="0.00000001"
      placeholder="Deposit amount"
      value={subDeposits[sub.index] || ''}
      onChange={(e) =>
        setSubDeposits((prev) => ({ ...prev, [sub.index]: e.target.value }))
      }
      disabled={isDepositing[sub.index] || loading}
      className="input amount-input"
    />
    <button
      onClick={() => depositToSub(sub)}
      disabled={isDepositing[sub.index] || loading || sub.locking}
      className="btn primary small"
    >
      {isDepositing[sub.index] ? 'Processing...' : sub.locking ? 'Locking...' : 'Deposit'}
    </button>
  </div>

  {/* Withdraw */}
  <div className="action-group withdraw-group">
    <input
      type="number"
      step="0.00000001"
      placeholder="Withdraw amount"
      value={subWithdrawAmounts[sub.index] || ''}
      onChange={(e) =>
        setSubWithdrawAmounts((prev) => ({ ...prev, [sub.index]: e.target.value }))
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
      onClick={() => setMaxWithdraw(sub)}
      disabled={
        isWithdrawing[sub.index] ||
        loading ||
        !sub.balance ||
        Number(sub.balance) <= 0
      }
      className="btn primary small"
    >
      Max
    </button>
    <button
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
      {isWithdrawing[sub.index] ? 'Sending...' : 'Withdraw to Main'}
    </button>
  </div>

  {/* Sweep */}
  {(sub.pendingVaultAddress || sub.vaultAddress) && (
    <div className="action-group sweep-group">
      <input
        type="number"
        step="0.00000001"
        placeholder="Sweep amount"
        value={subSweepAmounts[sub.index] || ''}
        onChange={(e) =>
          setSubSweepAmounts((prev) => ({ ...prev, [sub.index]: e.target.value }))
        }
        disabled={
          isSweeping[sub.index] ||
          loading ||
          !sub.balance ||
          Number(sub.balance) <= 0 ||
          sub.locking
        }
        className="input amount-input"
      />
      <button
        onClick={() => setMaxSweep(sub)}
        disabled={
          isSweeping[sub.index] ||
          loading ||
          !sub.balance ||
          Number(sub.balance) <= 0 ||
          sub.locking
        }
        className="btn primary small"
      >
        Max
      </button>
      <button
        onClick={() => sweepToVault(sub, subSweepAmounts[sub.index])}
        disabled={
          isSweeping[sub.index] ||
          loading ||
          !sub.balance ||
          Number(sub.balance) <= 0 ||
          sub.locking
        }
        className="btn primary small"
      >
        {isSweeping[sub.index] ? 'Sweeping...' : 'Sweep to Vault and Lock'}
      </button>
    </div>
  )}
          </div>

          {/* Status feedback messages */}
          {(isDepositing[sub.index] || autoLockPhase[sub.index]) && (
            <div className="status-message status-deposit">
              <div className="spinner" />
              <span>
                {getLockStatusText(autoLockPhase[sub.index])}
                <LoadingDots />
              </span>
            </div>
          )}

          {sub.locking && (
            <div className="status-message status-locking">
              <div className="spinner" />
              <span>
                Locking in progress — monitoring for confirmations
                <LoadingDots />
              </span>
            </div>
          )}

          {isWithdrawing[sub.index] && (
            <div className="status-message status-withdraw">
              <div className="spinner" />
              <span>
                Sending to main wallet
                <LoadingDots />
              </span>
            </div>
          )}

          {isSweeping[sub.index] && (
            <div className="status-message status-sweep">
              <div className="spinner" />
              <span>
                Sweeping to vault and locking
                <LoadingDots />
              </span>
            </div>
          )}
        </li>
      )})}
    </ul>

    {subError && <div className="error-message">{subError}</div>}

    <Toaster position="top-right" />
  </section>
);
}

export default SubWallet;
