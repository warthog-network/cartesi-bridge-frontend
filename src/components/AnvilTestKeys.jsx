/**
 * Demo-only: list Foundry/Anvil pre-funded private keys for MetaMask import.
 * MetaMask has no import-PK RPC — copy + Account details → Import account.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import {
  ANVIL_TEST_ACCOUNTS,
  fetchAnvilAccountBalances,
} from '../utils/anvilTestAccounts.js';

function shortAddr(a) {
  if (!a || a.length < 12) return a || '';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function shortPk(pk) {
  if (!pk || pk.length < 14) return pk || '';
  return `${pk.slice(0, 8)}…${pk.slice(-6)}`;
}

/**
 * @param {{ rpcUrl?: string, compact?: boolean, highlightAddress?: string|null }} props
 */
export default function AnvilTestKeys({
  rpcUrl = '',
  compact = false,
  highlightAddress = null,
}) {
  const [open, setOpen] = useState(!compact);
  const [balances, setBalances] = useState({});
  const [showReserved, setShowReserved] = useState(false);
  const [revealed, setRevealed] = useState({}); // index → bool

  const hi = highlightAddress ? String(highlightAddress).toLowerCase() : null;

  useEffect(() => {
    if (!open || !rpcUrl) return;
    let cancelled = false;
    fetchAnvilAccountBalances(rpcUrl).then((b) => {
      if (!cancelled) setBalances(b);
    });
    return () => {
      cancelled = true;
    };
  }, [open, rpcUrl]);

  const copy = async (label, value) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error(`Could not copy ${label}`);
    }
  };

  const rows = ANVIL_TEST_ACCOUNTS.filter(
    (a) => showReserved || !a.reserved || (hi && a.address.toLowerCase() === hi),
  );

  return (
    <div className={`wi-anvil-keys${compact ? ' wi-anvil-keys--compact' : ''}`}>
      <button
        type="button"
        className="wi-token-copy wi-anvil-keys-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▾' : '▸'} Test Anvil keys (pre-funded ETH) · demo only
      </button>
      {open ? (
        <div className="wi-anvil-keys-body">
          <p className="wi-muted wi-anvil-keys-note">
            Public Foundry defaults for chain <strong>31337</strong>. MetaMask → Account menu →{' '}
            <strong>Import account</strong> → paste private key. Prefer spares if you already use
            another account. Never use these on mainnet.
          </p>
          <label className="wi-anvil-keys-check">
            <input
              type="checkbox"
              checked={showReserved}
              onChange={(e) => setShowReserved(e.target.checked)}
            />
            Show reserved (deploy / minter scripts)
          </label>
          <ul className="wi-anvil-keys-list">
            {rows.map((a) => {
              const isYou = hi && a.address.toLowerCase() === hi;
              const bal = balances[a.address.toLowerCase()];
              const showPk = !!revealed[a.index];
              return (
                <li
                  key={a.index}
                  className={`wi-anvil-key-row${isYou ? ' wi-anvil-key-row--you' : ''}${
                    a.reserved ? ' wi-anvil-key-row--reserved' : ''
                  }`}
                >
                  <div className="wi-anvil-key-meta">
                    <span className="wi-anvil-key-idx">#{a.index}</span>
                    <span className="wi-anvil-key-addr" title={a.address}>
                      {shortAddr(a.address)}
                    </span>
                    {bal != null ? (
                      <span className="wi-anvil-key-bal">{bal} ETH</span>
                    ) : null}
                    {isYou ? <span className="wi-anvil-key-tag">connected</span> : null}
                    {a.reserved ? (
                      <span className="wi-anvil-key-tag wi-anvil-key-tag--warn">reserved</span>
                    ) : (
                      <span className="wi-anvil-key-tag wi-anvil-key-tag--ok">spare</span>
                    )}
                  </div>
                  <div className="wi-anvil-key-role">{a.role}</div>
                  <div className="wi-anvil-key-actions">
                    <button
                      type="button"
                      className="btn secondary small"
                      onClick={() => copy('Address', a.address)}
                    >
                      Copy address
                    </button>
                    <button
                      type="button"
                      className="btn secondary small"
                      onClick={() =>
                        setRevealed((prev) => ({ ...prev, [a.index]: !prev[a.index] }))
                      }
                    >
                      {showPk ? 'Hide key' : 'Show key'}
                    </button>
                    <button
                      type="button"
                      className="btn primary small"
                      onClick={() => copy('Private key', a.privateKey)}
                    >
                      Copy private key
                    </button>
                  </div>
                  {showPk ? (
                    <code className="wi-anvil-key-pk" title={a.privateKey}>
                      {a.privateKey}
                    </code>
                  ) : (
                    <code className="wi-anvil-key-pk wi-anvil-key-pk--masked">
                      {shortPk(a.privateKey)}
                    </code>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
