// src/components/SubWallet.jsx
//
// Warthog sub-wallets — plain derived holding addresses.
//
// Path B (2P-ECDSA personal vaults + cosigner) was removed 2026-09-05. Sub-wallets
// are now HD-derived addresses you fund from main and withdraw back to main; they
// carry no vault, no lock state and no mint path. All WART → wWART bridging goes
// through the Path A4 fungible pool (FungiblePool.jsx), which is independent of
// this component.
//
// NOTE: `l1Vault` here is the **L1 wWART claim/capacity snapshot** (vaultStateCache.js),
// not a personal vault. It stays.
import { useState, useEffect, useMemo, useRef } from 'react';
import { gql, GraphQLClient } from 'graphql-request';
import { keccak256, toUtf8Bytes } from 'ethers-v6';
import { Toaster, toast } from 'react-hot-toast';
import { RefreshCw, Eye, EyeOff, MoreVertical } from 'lucide-react';
import '../styles/subWallet.css';
import { getRollupGraphqlUrl } from '../utils/bridgeConfig.js';
import { deriveSubWallet, deriveSubPrivateKey } from '../utils/subWalletDerive.js';
import { SHARE_TOKEN } from '../utils/tokenNames.js';

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
  address, // Warthog main address
  loading,
  setLoading,
  subWallets,
  setSubWallets,
  subIndex,
  setSubIndex,
  /** L1 rollup wWART claim snapshot (claimable wWART, WLIQ, etc.) */
  l1Vault = null,
  /** Live MetaMask ERC-20 wWART balance (string human units) */
  mmWwartBal = null,
  onRefreshL1Vault,
  onRefreshMmWwart,
}) {
  const [subError, setSubError] = useState(null);
  const [subDeposits, setSubDeposits] = useState({});
  const [isDepositing, setIsDepositing] = useState({});

  // Withdraw states
  const [subWithdrawAmounts, setSubWithdrawAmounts] = useState({});
  const [subWithdrawFees, setSubWithdrawFees] = useState({});
  const [isWithdrawing, setIsWithdrawing] = useState({});

  // Regenerate state
  const [regenIndex, setRegenIndex] = useState('');

  // Cycle one sub at a time — not a full list of every sub
  const [activeSubPos, setActiveSubPos] = useState(0);
  /** Include subs marked hidden in the carousel */
  const [showHiddenSubs, setShowHiddenSubs] = useState(false);
  /** Toggle Balances across layers body (header stays for show/hide) */
  const [showLayersCard, setShowLayersCard] = useState(true);
  /** Which card ⋮ menu is open: `sub:3` | null */
  const [openMenuKey, setOpenMenuKey] = useState(null);
  const cardMenuRef = useRef(null);

  // Screen size state
  const [isSmallScreen, setIsSmallScreen] = useState(
    typeof window !== 'undefined' ? window.innerWidth <= 688 : false,
  );

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

  // Absolute URL required — relative `/rollup/graphql` throws in graphql-request
  const client = useMemo(() => new GraphQLClient(getRollupGraphqlUrl()), []);

  // Handle resize for screen size
  useEffect(() => {
    const handleResize = () => {
      setIsSmallScreen(window.innerWidth <= 688);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // NOTE: do not define child components inside SubWallet — each re-render remounts them
  // and collapses <details> / steals input focus.

  const copyToClipboard = (text, label = 'Copied') => {
    const s = String(text ?? '');
    if (!s) return toast.error('Nothing to copy');
    navigator.clipboard
      .writeText(s)
      .then(() => toast.success(`${label}: ${s.length > 24 ? s.slice(0, 12) + '…' : s}`))
      .catch(() => toast.error('Failed to copy'));
  };

  /** Visible list (hidden subs stay in storage until removed). */
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
    const subBal = Number(sub.balance || 0);
    const msg =
      subBal > 0
        ? `Remove sub #${sub.index} from UI?\n\nNote: on-chain balance is NOT moved — ${subBal} WART stays at this address.\nAddress: ${String(sub.address).slice(0, 12)}…`
        : `Remove sub #${sub.index} from this list?`;
    if (typeof window !== 'undefined' && !window.confirm(msg)) return;

    setSubWallets((prev) => prev.filter((s) => s.index !== sub.index));
    // Clear related UI state
    setSubDeposits((prev) => {
      const n = { ...prev };
      delete n[sub.index];
      return n;
    });
    setSubWithdrawAmounts((prev) => {
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

  const wartToE8String = (wartStr) => {
    const [w, f = ''] = String(wartStr ?? '0').split('.');
    const frac = (f + '00000000').slice(0, 8);
    return `${BigInt(w || '0') * 100000000n + BigInt(frac || '0')}`;
  };

  const e8ToWartDisplay = (e8) => {
    const v = BigInt(e8 ?? 0n);
    const whole = v / 100000000n;
    const frac = (v % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : `${whole}`;
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

  const refreshSubBalance = async (subAddress) => {
    const subNorm = String(subAddress || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    const toastId = toast.loading('Fetching live balance from node…');
    try {
      const subBal = await fetchBalanceAndNonce(subAddress, true);
      // ok:false means the node/proxy failed — never write a confirmed zero
      if (subBal?.ok === false) {
        throw new Error(subBal.error || 'Node fetch failed');
      }

      const updates = {
        balance: subBal.balance || '0',
        spendable: subBal.spendable || subBal.balance || '0',
      };

      setSubWallets((prev) =>
        prev.map((sub) => {
          const a = String(sub.address || '')
            .replace(/^0x/i, '')
            .toLowerCase();
          if (a !== subNorm) return sub;
          return { ...sub, ...updates };
        }),
      );

      toast.success(
        `Live node: ${updates.balance} WART (${updates.spendable} free)`,
        { id: toastId, duration: 4000 },
      );
    } catch (err) {
      console.error('refreshSubBalance', err);
      toast.error('Failed to refresh: ' + (err.message || err), {
        id: toastId,
        duration: 6000,
      });
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
        balance: '0',
        spendable: '0',
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
            balance: '0',
            spendable: '0',
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

  /** Main → sub transfer. No lock, no vault — plain WART send. */
  const depositToSub = async (sub) => {
    const amount = subDeposits[sub.index]?.trim();
    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return toast.error('Enter a valid amount');
    }
    if (!mainWallet?.address) {
      return toast.error('Main Warthog wallet required');
    }

    setIsDepositing((prev) => ({ ...prev, [sub.index]: true }));
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

      toast.loading('Sending WART main → sub…', { id: toastId });
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

      setSubWallets((prev) =>
        prev.map((s) =>
          s.index === sub.index
            ? {
                ...s,
                balance: (Number(s.balance || 0) + Number(amount)).toFixed(8),
                depositTxHash: txHash,
              }
            : s
        )
      );

      setSubDeposits((prev) => ({ ...prev, [sub.index]: '' }));
      toast.success('WART sent main → sub.', { id: toastId, duration: 5000 });

      await refreshSubBalance(sub.address);
    } catch (err) {
      toast.error('Deposit failed: ' + (err.message || err), { id: toastId, duration: 8000 });
    } finally {
      setIsDepositing((prev) => ({ ...prev, [sub.index]: false }));
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

    setIsWithdrawing((prev) => ({ ...prev, [sub.index]: true }));
    setLoading(true);
    const toastId = toast.loading('Processing withdrawal...');

    try {
      if (!mainMnemonic) throw new Error('Main mnemonic required');

      const subPrivateKey = deriveSubPrivateKey(mainMnemonic, sub.index);

      const txData = await sendTransaction(
        subPrivateKey,           // ← raw hex without 0x
        sub.address,
        address,                 // main wallet address
        amount,
        fee
      );

      const txHash = txData?.data?.txHash || txData?.txHash || txData?.hash;
      if (!txHash) throw new Error('No tx hash received');

      toast.success('Withdrawal sent!', { id: toastId });

      setSubWallets((prev) =>
        prev.map((s) =>
          s.index === sub.index
            ? { ...s, balance: (Number(s.balance || 0) - Number(amount)).toFixed(8) }
            : s
        )
      );

      setSubWithdrawAmounts((prev) => ({ ...prev, [sub.index]: '' }));
      setSubWithdrawFees((prev) => ({ ...prev, [sub.index]: '0.01' }));

      setTimeout(async () => {
        await refreshSubBalance(sub.address);
      }, 4000);

    } catch (err) {
      console.error('Withdraw error:', err);
      toast.error('Withdrawal failed: ' + (err.message || 'Unknown error'), { id: toastId });
    } finally {
      setIsWithdrawing((prev) => ({ ...prev, [sub.index]: false }));
      setLoading(false);
    }
  };

  const setMaxWithdraw = (sub) => {
    setSubWithdrawAmounts((prev) => ({
      ...prev,
      [sub.index]: sub.balance || '0'
    }));
  };

  /** Max main → sub from main wallet spendable. */
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

  const toggleCardMenu = (key) => {
    setOpenMenuKey((prev) => (prev === key ? null : key));
  };

  /** ⋮ menu — same pattern as ETH sub cards */
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

  const visibleSubs = baseVisibleSubs;
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
      // large number — the clamp effect pulls it to the last visible position
      setActiveSubPos(9999);
    }, 80);
  };

  /** Parse rollup 18-dec (or already-human) amount to number. */
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
  <section className="subwallet-section">
    <div className="subwallet-top">
      <h3>Sub wallets</h3>
      <p className="sw-top-lead">
        HD-derived WART addresses · fund from main · withdraw back
      </p>
      <details className="bridge-flow-guide">
        <summary>Steps</summary>
        <>
          <p className="bridge-flow-lead">
            Needs your seed phrase. To bridge WART → wWART, use the fungible pool
            on <strong>Get wWART</strong>.
          </p>
          <ol className="bridge-flow-steps">
            <li><span className="step-num">1</span><span>Generate a sub (index is copied — keep it to regenerate)</span></li>
            <li><span className="step-num">2</span><span>Fund it from main, or receive from anywhere</span></li>
            <li><span className="step-num">3</span><span>Withdraw back to main whenever you like</span></li>
          </ol>
        </>
      </details>
    </div>

    {/* Cross-layer: WLIQ · wWART claim · MetaMask ERC-20 */}
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
            <strong>{SHARE_TOKEN.symbol}</strong> and <strong>wWART claim</strong> are rollup
            shares against pool capacity. MetaMask shows L1 ERC-20 after voucher execute.
          </p>
        </>
      )}
    </div>

    {/* Generate | Index | Regen on one neat row (layout matches ETH). */}
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
                setActiveSubPos(() => {
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
          {showHiddenSubs ? 'Hide hidden' : `Show hidden (${hiddenCount})`}
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

    {totalSubs === 0 && (
      <div className="sw-empty">
        <p>
          {subWallets.length === 0
            ? 'No sub-wallets yet. Generate one to get a derived WART address.'
            : `${hiddenCount} sub(s) hidden — click “Show hidden” or generate a new sub.`}
        </p>
      </div>
    )}

    {activeSub && (() => {
      const sub = activeSub;
      const displayedSubAddr = isSmallScreen
        ? `${sub.address.slice(0, 6)}…${sub.address.slice(-4)}`
        : sub.address;
      const shortPill = isSmallScreen
        ? `#${String(sub.index).slice(0, 6)}…`
        : `#${sub.index}`;

      return (
        <div className="sw-carousel" key={sub.index}>
          {/* Pager */}
          <div
            className="sw-pager"
            role="navigation"
            aria-label="Sub-wallet switcher"
          >
            <div className="sw-pager-nav">
              <button
                type="button"
                className="sw-pager-step"
                onClick={goPrevSub}
                disabled={totalSubs <= 1}
                title="Previous sub-wallet"
                aria-label="Previous sub-wallet"
              >
                ‹
              </button>
              <span className="sw-pager-count" title="Sub position">
                {safePos + 1}
                <span className="sw-pager-count-sep">/</span>
                {totalSubs}
              </span>
              <button
                type="button"
                className="sw-pager-step"
                onClick={goNextSub}
                disabled={totalSubs <= 1}
                title="Next sub-wallet"
                aria-label="Next sub-wallet"
              >
                ›
              </button>
            </div>
            <select
              className="input sw-pager-select"
              value={safePos}
              onChange={(e) => setActiveSubPos(Number(e.target.value))}
              title="Jump to sub-wallet"
              aria-label="Select sub-wallet"
            >
              {visibleSubs.map((s, i) => {
                const short = `${String(s.address).slice(0, 6)}…${String(s.address).slice(-4)}`;
                return (
                  <option key={s.index} value={i}>
                    {`${i + 1}. #${s.index} · ${short}${s.hidden ? ' · hidden' : ''}${
                      s.balance && Number(s.balance) > 0 ? ` · ${s.balance} WART` : ''
                    }`}
                  </option>
                );
              })}
            </select>
          </div>

          <div className="sw-cards">
            {/* ── Sub wallet card — layout matches ETH sub card ── */}
            <div className={`sw-card sw-card--sub ${sub.hidden ? 'is-hidden-sub' : ''}`}>
              <div className="sw-card-head">
                <h4 className="sw-card-title">
                  Sub-wallet
                  {sub.hidden ? <span className="sw-live-tag"> · hidden</span> : null}
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
                  disabled={loading}
                >
                  Refresh
                </button>
              </div>

              <details className="sw-details" open>
                <summary>Fund / exit (main ↔ sub)</summary>
                <div className="sw-details-body">
                  <p className="sw-hint">
                    Main = Warthog main wallet. Fund pulls from main; withdraw returns the
                    free sub balance.
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
                        !sub.balance ||
                        Number(sub.balance) <= 0
                      }
                      className="btn primary small"
                    >
                      {isWithdrawing[sub.index] ? '…' : 'Sub → main'}
                    </button>
                  </div>
                  {isDepositing[sub.index] && (
                    <div className="status-message status-deposit">
                      <div className="spinner" />
                      <span>
                        Main → sub
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
            </div>
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
