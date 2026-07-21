/**
 * In-app L1 voucher list + execute (wWART mint, ERC-20 transfer, ETH, etc.).
 * Replaces the old "go use Portals explorer" dead-end.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import {
  fetchVouchers,
  executeVoucherOnL1,
  wasVoucherExecuted,
  getDappAddress,
} from '../utils/vouchers.js';

export default function VoucherExecutor({
  address,
  signer,
  provider,
  /** optional filter: only vouchers whose decoded.to matches this address */
  onlyMine = true,
  compact = false,
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(null); // key
  const [statusMap, setStatusMap] = useState({}); // key -> 'ready'|'pending'|'done'|'error'

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let list = await fetchVouchers({ last: 50 });
      const me = String(address || '')
        .replace(/^0x/i, '')
        .toLowerCase();
      if (onlyMine && me) {
        list = list.filter((v) => {
          const to = String(v.decoded?.to || '')
            .replace(/^0x/i, '')
            .toLowerCase();
          // also show if no decoded recipient (unknown) so user can still try
          if (!to) return true;
          return to === me;
        });
      }

      const reader = signer || provider;
      const nextStatus = {};
      if (reader) {
        await Promise.all(
          list.map(async (v) => {
            const key = `${v.inputIndex}:${v.voucherIndex}`;
            if (!v.hasProof) {
              nextStatus[key] = 'pending';
              return;
            }
            try {
              const done = await wasVoucherExecuted(reader, v);
              nextStatus[key] = done ? 'done' : 'ready';
            } catch {
              nextStatus[key] = v.hasProof ? 'ready' : 'pending';
            }
          }),
        );
      } else {
        for (const v of list) {
          const key = `${v.inputIndex}:${v.voucherIndex}`;
          nextStatus[key] = v.hasProof ? 'ready' : 'pending';
        }
      }

      setRows(list);
      setStatusMap(nextStatus);
    } catch (e) {
      console.warn('[VoucherExecutor]', e);
      toast.error(e?.message || 'Failed to load vouchers');
    } finally {
      setLoading(false);
    }
  }, [address, onlyMine, signer, provider]);

  useEffect(() => {
    load();
    const t = setInterval(load, 12_000);
    return () => clearInterval(t);
  }, [load]);

  const onExecute = async (v) => {
    if (!signer) {
      toast.error('Connect MetaMask first');
      return;
    }
    const key = `${v.inputIndex}:${v.voucherIndex}`;
    setExecuting(key);
    try {
      const { hash } = await executeVoucherOnL1(signer, v);
      toast.success(`Voucher executed · ${hash.slice(0, 10)}…`, { duration: 6000 });
      setStatusMap((m) => ({ ...m, [key]: 'done' }));
      setTimeout(load, 2000);
    } catch (e) {
      const msg = e?.shortMessage || e?.reason || e?.message || String(e);
      toast.error(msg, { duration: 7000 });
      console.error('[executeVoucher]', e);
    } finally {
      setExecuting(null);
    }
  };

  return (
    <div className={`voucher-exec ${compact ? 'voucher-exec--compact' : ''}`}>
      <div className="voucher-exec-head">
        <div>
          <h3 className="voucher-exec-title">L1 vouchers</h3>
          <p className="voucher-exec-sub">
            After <strong>Withdraw</strong>, execute here so MetaMask receives wWART / ERC-20 / ETH.
            Proofs appear after the rollup epoch (local demo is fast).
          </p>
          <p className="voucher-exec-sub mono">
            Application {getDappAddress()?.slice(0, 10)}…
          </p>
        </div>
        <button type="button" className="btn small secondary" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {rows.length === 0 && !loading ? (
        <p className="voucher-exec-empty">
          No vouchers yet. Mint/claim wWART, then use <strong>Withdraw voucher</strong> on Portals —
          the mint voucher will show up here.
        </p>
      ) : (
        <ul className="voucher-exec-list">
          {rows.map((v) => {
            const key = `${v.inputIndex}:${v.voucherIndex}`;
            const st = statusMap[key] || (v.hasProof ? 'ready' : 'pending');
            const busy = executing === key;
            return (
              <li key={key} className="voucher-exec-card">
                <div className="voucher-exec-card-main">
                  <div className="voucher-exec-card-title">
                    {v.token ? <span className="voucher-pill">{v.token}</span> : null}
                    <span>{v.summary}</span>
                  </div>
                  <div className="voucher-exec-meta mono">
                    input #{v.inputIndex} · voucher #{v.voucherIndex}
                    {v.timestamp
                      ? ` · ${new Date(v.timestamp * 1000).toLocaleString()}`
                      : ''}
                  </div>
                  <div className="voucher-exec-meta">
                    dest {v.destination?.slice(0, 10)}… · status:{' '}
                    <strong
                      className={
                        st === 'done'
                          ? 'st-done'
                          : st === 'ready'
                            ? 'st-ready'
                            : 'st-pending'
                      }
                    >
                      {st === 'done'
                        ? 'executed'
                        : st === 'ready'
                          ? 'ready to execute'
                          : 'waiting for proof'}
                    </strong>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn primary small"
                  disabled={busy || st === 'done' || st === 'pending' || !signer}
                  onClick={() => onExecute(v)}
                  title={
                    st === 'pending'
                      ? 'Epoch proof not available yet'
                      : st === 'done'
                        ? 'Already executed'
                        : 'Call Application.executeVoucher via MetaMask'
                  }
                >
                  {busy ? 'Executing…' : st === 'done' ? 'Done' : 'Execute on L1'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <style>{`
        .voucher-exec {
          text-align: left;
          margin-top: 0.75rem;
        }
        .voucher-exec-head {
          display: flex;
          justify-content: space-between;
          gap: 0.75rem;
          align-items: flex-start;
          margin-bottom: 0.65rem;
        }
        .voucher-exec-title {
          margin: 0;
          font-size: 0.95rem;
          color: #00ffcc;
        }
        .voucher-exec-sub {
          margin: 0.25rem 0 0;
          font-size: 0.78rem;
          opacity: 0.8;
          line-height: 1.4;
          max-width: 36rem;
          overflow-wrap: anywhere;
        }
        .voucher-exec-empty {
          font-size: 0.84rem;
          opacity: 0.75;
          margin: 0.5rem 0;
        }
        .voucher-exec-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.55rem;
        }
        .voucher-exec-card {
          display: flex;
          justify-content: space-between;
          gap: 0.75rem;
          align-items: center;
          border: 1px solid #2a2a2a;
          border-radius: 12px;
          padding: 0.65rem 0.75rem;
          background: rgba(0, 0, 0, 0.35);
          min-width: 0;
        }
        .voucher-exec-card-main {
          min-width: 0;
          flex: 1;
        }
        .voucher-exec-card-title {
          font-size: 0.84rem;
          display: flex;
          flex-wrap: wrap;
          gap: 0.35rem;
          align-items: center;
          overflow-wrap: anywhere;
        }
        .voucher-pill {
          font-size: 0.7rem;
          font-weight: 700;
          color: #0a0a0a;
          background: #fdb913;
          border-radius: 6px;
          padding: 0.1rem 0.4rem;
        }
        .voucher-exec-meta {
          font-size: 0.72rem;
          opacity: 0.7;
          margin-top: 0.2rem;
          overflow-wrap: anywhere;
        }
        .voucher-exec-meta.mono,
        .mono {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        }
        .st-ready { color: #4ade80; }
        .st-pending { color: #fbbf24; }
        .st-done { color: #94a3b8; }
      `}</style>
    </div>
  );
}
