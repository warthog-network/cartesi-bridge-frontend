/**
 * ETH bridge sub-wallets — plain derived L1 holding addresses.
 *
 * Path B (2P-ECDSA cosigner ETH vaults) was removed 2026-09-05. ETH subs are now
 * HD-derived addresses you fund from MetaMask and withdraw back; they carry no
 * vault, no lock and no mint path. ETH bridging goes through the Path A4 ETH
 * fungible pool (EthFungiblePool.jsx / eth3pAdapter.js), which is independent.
 *
 * Flow:
 *   1. Create ETH sub (index)
 *   2. Main → sub → sub → main
 *   3. Optionally register the sub on the rollup for attribution
 */
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { ethers, keccak256, toUtf8Bytes } from 'ethers-v6';
import { toast } from 'react-hot-toast';
import { MoreVertical } from 'lucide-react';
import {
  deriveEthSubWallet,
  deriveEthSubPrivateKey,
  ethSubWalletPath,
} from '../utils/ethSubWalletDerive.js';
import { getRollupGraphqlUrl } from '../utils/bridgeConfig.js';
import '../styles/subWallet.css';
import '../styles/ethSubWallet.css';

const STORAGE_PREFIX = 'cartesi_eth_subs_';
const GAS_BUFFER_WEI = 50_000n * 1_000_000_000n;

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

export default function EthSubWallets({
  mainMnemonic,
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
  const [fundByIndex, setFundByIndex] = useState({});
  const [withdrawByIndex, setWithdrawByIndex] = useState({});
  const [busyKey, setBusyKey] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  /** Carousel index (one-at-a-time, WART-style) */
  const [activeSubPos, setActiveSubPos] = useState(0);
  /** Which card's ⋮ menu is open: `sub:3` | null */
  const [openMenuKey, setOpenMenuKey] = useState(null);
  const menuRef = useRef(null);

  const owner = (l1Address || '').toLowerCase();

  useEffect(() => {
    if (!owner) return;
    const local = loadLocalSubs(owner);
    const remoteSubs = Array.isArray(vault?.ethSubs) ? vault.ethSubs : [];
    const byIdx = new Map();

    for (const s of local) {
      if (s?.index == null || !s.address) continue;
      byIdx.set(Number(s.index), {
        index: Number(s.index),
        address: s.address,
        path: s.path || ethSubWalletPath(s.index),
        hidden: !!s.hidden,
        ethWei: '0',
        eth: '0',
        registered: false,
      });
    }
    for (const s of remoteSubs) {
      if (s?.index == null || !s.address) continue;
      const i = Number(s.index);
      const prev = byIdx.get(i) || {};
      byIdx.set(i, {
        ...prev,
        index: i,
        address: s.address,
        path: s.path || prev.path || ethSubWalletPath(i),
        ethWei: s.ethWei != null ? String(s.ethWei) : prev.ethWei || '0',
        eth: s.eth != null ? String(s.eth) : prev.eth || '0',
        registered: true,
        hidden: prev.hidden || false,
      });
    }

    const merged = [...byIdx.values()].sort((a, b) => a.index - b.index);
    setSubs(merged);
    if (merged.length) {
      const maxIdx = Math.max(...merged.map((s) => s.index));
      setSubIndex((prev) => (prev > maxIdx + 1 ? prev : maxIdx + 1));
    }
  }, [owner, vault?.ethSubs, vault?.eth]);

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
    await Promise.all(
      subs.map(async (s) => {
        try {
          next[s.address.toLowerCase()] = ethers.formatEther(
            await provider.getBalance(s.address),
          );
        } catch {
          next[s.address.toLowerCase()] = null;
        }
      }),
    );
    setL1BalByAddr(next);
  }, [provider, subs]);

  const refreshAllBalances = useCallback(async () => {
    await Promise.all([refreshMainBalance(), refreshSubBalances()]);
  }, [refreshMainBalance, refreshSubBalances]);

  useEffect(() => {
    refreshAllBalances();
  }, [refreshAllBalances]);

  const visible = useMemo(
    () => (showHidden ? subs : subs.filter((s) => !s.hidden)),
    [subs, showHidden],
  );
  const hiddenCount = useMemo(() => subs.filter((s) => s.hidden).length, [subs]);
  const totalFocus = visible.length;
  const safePos =
    totalFocus === 0 ? 0 : Math.min(Math.max(0, activeSubPos), totalFocus - 1);
  const activeSub = totalFocus > 0 ? visible[safePos] : null;

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
          },
        ].sort((a, b) => a.index - b.index);
      });
      if (idx >= subIndex) setSubIndex(idx + 1);
      toast.success(`ETH sub #${idx} regenerated`);
      setRegenIndex('');
      setTimeout(() => refreshSubBalances(), 400);
    } catch (e) {
      toast.error(e?.message || 'Regenerate failed');
    }
  };

  /** Hide from the carousel — stays in localStorage until removed. */
  const hideSub = (sub) => {
    setSubs((prev) =>
      prev.map((s) => (s.index === sub.index ? { ...s, hidden: true } : s)),
    );
    toast.success(`Hid ETH sub #${sub.index} (unhide or remove)`);
  };

  const unhideSub = (sub) => {
    setSubs((prev) =>
      prev.map((s) => (s.index === sub.index ? { ...s, hidden: false } : s)),
    );
    toast.success(`ETH sub #${sub.index} visible again`);
  };

  /** Remove from the UI list permanently (does not move on-chain funds). */
  const removeSub = (sub) => {
    const bal = Number(l1BalByAddr[String(sub.address).toLowerCase()] || 0);
    const msg =
      bal > 0
        ? `Remove ETH sub #${sub.index} from UI?\n\nOn-chain balance is NOT moved — ${bal} ETH stays at ${sub.address.slice(0, 12)}…`
        : `Remove ETH sub #${sub.index} from this list?`;
    if (typeof window !== 'undefined' && !window.confirm(msg)) return;
    setSubs((prev) => {
      const next = prev.filter((s) => s.index !== sub.index);
      // saveLocalSubs only runs when the list is non-empty; persist the empty case here
      if (!next.length && owner) saveLocalSubs(owner, next);
      return next;
    });
    setFundByIndex((p) => {
      const n = { ...p };
      delete n[sub.index];
      return n;
    });
    setWithdrawByIndex((p) => {
      const n = { ...p };
      delete n[sub.index];
      return n;
    });
    toast.success(`Removed ETH sub #${sub.index} from UI`);
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
    <section className="subwallet-section eth-subwallet-section">
      {!mainMnemonic && (
        <p className="sw-hint" style={{ marginTop: 0 }}>
          Unlock Warthog wallet to create ETH subs and sign sub → main.
        </p>
      )}

      {!hideTopChrome && (
        <div className="subwallet-top">
          <h3>ETH sub wallets</h3>
          <p className="sw-top-lead">
            HD-derived L1 addresses · fund from MetaMask · withdraw back
          </p>
          <details className="bridge-flow-guide">
            <summary>Steps</summary>
            <ol className="bridge-flow-steps">
              <li>
                <span className="step-num">1</span>
                <span>Generate a sub (index is copied — keep it to regenerate)</span>
              </li>
              <li>
                <span className="step-num">2</span>
                <span>Fund main → sub, or receive from anywhere</span>
              </li>
              <li>
                <span className="step-num">3</span>
                <span>
                  To bridge ETH, use the pool on <strong>Get wWETH</strong>
                </span>
              </li>
            </ol>
          </details>
        </div>
      )}

      {!hideCapacityTrack && !hideMainCard && (
        <div className="sw-card sw-card--l1-track">
          <div className="sw-card-head">
            <h4 className="sw-card-title">Main L1 ETH</h4>
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
              <span className="sw-meta-k">MetaMask balance</span>
              <span className="sw-meta-v">
                {mainEthBal != null ? `${fmtEth(mainEthBal)} ETH` : '—'}
              </span>
            </div>
          </div>
        </div>
      )}

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

      {hiddenCount > 0 && (
        <div className="sw-hidden-controls">
          <button
            type="button"
            className="btn secondary small"
            onClick={() => setShowHidden((v) => !v)}
            title="Show or hide ETH subs marked hidden"
          >
            {showHidden ? 'Hide hidden' : `Show hidden (${hiddenCount})`}
          </button>
        </div>
      )}

      {totalFocus === 0 && (
        <div className="sw-empty">
          <p>
            {subs.length === 0
              ? 'No ETH sub-wallets yet. Generate one to start.'
              : `${hiddenCount} sub(s) hidden — click “Show hidden” or generate a new sub.`}
          </p>
        </div>
      )}

      {activeSub &&
        (() => {
          const sub = activeSub;
          const l1Bal = l1BalByAddr[sub.address.toLowerCase()];
          const shortPill = `#${String(sub.index).length > 8 ? String(sub.index).slice(0, 6) + '…' : sub.index}`;
          const shortAddr = `${sub.address.slice(0, 6)}…${sub.address.slice(-4)}`;

          return (
            <div className="sw-carousel" key={`sub-${sub.index}`}>
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
                    disabled={totalFocus <= 1}
                    title="Previous sub-wallet"
                    aria-label="Previous sub-wallet"
                  >
                    ‹
                  </button>
                  <span className="sw-pager-count" title="Sub position">
                    {safePos + 1}
                    <span className="sw-pager-count-sep">/</span>
                    {totalFocus}
                  </span>
                  <button
                    type="button"
                    className="sw-pager-step"
                    onClick={goNextSub}
                    disabled={totalFocus <= 1}
                    title="Next sub-wallet"
                    aria-label="Next sub-wallet"
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
                  aria-label="Select sub-wallet"
                >
                  {visible.map((s, i) => {
                    const short = `${String(s.address).slice(0, 6)}…${String(s.address).slice(-4)}`;
                    return (
                      <option key={s.index} value={i}>
                        {`${i + 1}. #${s.index} · ${short}${s.hidden ? ' · hidden' : ''}`}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className="sw-cards">
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
                        sub.hidden
                          ? {
                              label: 'Unhide',
                              onClick: () => unhideSub(sub),
                            }
                          : {
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
                    {!sub.registered && (
                      <button
                        type="button"
                        className="btn secondary small"
                        disabled={loading || busyKey === `reg:${sub.index}`}
                        onClick={() => registerSub(sub)}
                      >
                        {busyKey === `reg:${sub.index}` ? '…' : 'Register'}
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
              </div>
            </div>
          );
        })()}
    </section>
  );
}
