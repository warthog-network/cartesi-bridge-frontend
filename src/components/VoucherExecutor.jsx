/**
 * In-app L1 voucher list + execute (wWART mint, ERC-20 transfer, ETH, etc.).
 * Replaces the old "go use Portals explorer" dead-end.
 * Shows decoded JSON before MetaMask executeVoucher.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import {
  fetchVouchers,
  executeVoucherOnL1,
  wasVoucherExecuted,
  getDappAddress,
} from '../utils/vouchers.js';
import { describeVoucherExecute, formatDescribeJson } from '../utils/mmTxDescribe.js';
import { useMmTxConfirm } from './MmTxConfirm.jsx';

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
  const [expanded, setExpanded] = useState({}); // key -> bool
  const [confirmMmTx, mmTxModal] = useMmTxConfirm();

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
    const desc = describeVoucherExecute(v, { dappAddress: getDappAddress() });
    const ok = await confirmMmTx(desc);
    if (!ok) {
      toast('Cancelled — nothing sent to MetaMask');
      return;
    }
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

  const statusLabel = (st) =>
    st === 'done' ? 'done' : st === 'ready' ? 'ready' : 'pending';

  return (
    <div className={`voucher-exec voucher-exec--compact ${compact ? '' : ''}`.trim()}>
      {mmTxModal}
      <div className="voucher-exec-head">
        <div className="voucher-exec-head-left">
          <h3 className="voucher-exec-title">L1 vouchers</h3>
          <p className="voucher-exec-sub">
            After Withdraw → Execute so MetaMask receives the token.
          </p>
        </div>
        <button type="button" className="btn small secondary" onClick={load} disabled={loading}>
          {loading ? '…' : 'Refresh'}
        </button>
      </div>

      {rows.length === 0 && !loading ? (
        <p className="voucher-exec-empty">None yet — withdraw first, then execute here.</p>
      ) : (
        <ul className="voucher-exec-list">
          {rows.map((v) => {
            const key = `${v.inputIndex}:${v.voucherIndex}`;
            const st = statusMap[key] || (v.hasProof ? 'ready' : 'pending');
            const busy = executing === key;
            const isOpen = !!expanded[key];
            const detail = describeVoucherExecute(v, { dappAddress: getDappAddress() });
            const when = v.timestamp
              ? new Date(v.timestamp * 1000).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : null;
            return (
              <li key={key} className="voucher-exec-card">
                <div className="voucher-exec-card-main">
                  <div className="voucher-exec-card-title">
                    {v.token ? <span className="voucher-pill">{v.token}</span> : null}
                    <span className="voucher-summary">{v.summary}</span>
                    <strong className={`voucher-status st-${st === 'done' ? 'done' : st === 'ready' ? 'ready' : 'pending'}`}>
                      {statusLabel(st)}
                    </strong>
                  </div>
                  <div className="voucher-exec-meta mono">
                    #{v.inputIndex}/{v.voucherIndex}
                    {v.destination ? ` · ${v.destination.slice(0, 6)}…${v.destination.slice(-4)}` : ''}
                    {when ? ` · ${when}` : ''}
                    {' · '}
                    <button
                      type="button"
                      className="voucher-json-toggle"
                      onClick={() => setExpanded((m) => ({ ...m, [key]: !m[key] }))}
                    >
                      {isOpen ? 'hide JSON' : 'JSON'}
                    </button>
                  </div>
                  {isOpen ? (
                    <div className="voucher-json-blocks">
                      {detail.sections.map((sec, i) => (
                        <details
                          key={`${key}-sec-${i}`}
                          className="voucher-json-block"
                          open={i === 0}
                        >
                          <summary>{sec.label}</summary>
                          <pre className="voucher-json mono">
                            {formatDescribeJson(sec.json)}
                          </pre>
                        </details>
                      ))}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="btn primary small voucher-exec-btn"
                  disabled={busy || st === 'done' || st === 'pending' || !signer}
                  onClick={() => onExecute(v)}
                  title={
                    st === 'pending'
                      ? 'Waiting for epoch proof'
                      : st === 'done'
                        ? 'Already executed'
                        : 'Execute voucher on L1'
                  }
                >
                  {busy ? '…' : st === 'done' ? 'Done' : 'Execute'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <style>{`
        .voucher-exec {
          text-align: left;
          margin-top: 0.55rem;
          width: 100%;
          max-width: 100%;
          min-width: 0;
          box-sizing: border-box;
        }
        .voucher-exec-head {
          display: flex;
          flex-wrap: wrap;
          justify-content: space-between;
          gap: 0.4rem 0.65rem;
          align-items: center;
          margin-bottom: 0.45rem;
          width: 100%;
          min-width: 0;
        }
        .voucher-exec-head-left {
          flex: 1 1 10rem;
          min-width: 0;
        }
        .voucher-exec-head > .btn,
        .voucher-exec-card > .btn,
        .warthog-section .voucher-exec-head > .btn,
        .warthog-section .voucher-exec-card > .btn {
          width: auto !important;
          max-width: none !important;
          flex: 0 0 auto !important;
          margin: 0 !important;
          padding: 0.28rem 0.6rem !important;
          font-size: 0.72rem !important;
        }
        .voucher-exec-title {
          margin: 0;
          font-size: 0.82rem;
          font-weight: 700;
          color: #00ffcc;
          letter-spacing: 0.02em;
        }
        .voucher-exec-sub {
          margin: 0.12rem 0 0;
          font-size: 0.7rem;
          opacity: 0.7;
          line-height: 1.3;
          max-width: 100%;
          white-space: normal;
        }
        .voucher-exec-empty {
          font-size: 0.74rem;
          opacity: 0.7;
          margin: 0.35rem 0;
        }
        .voucher-exec-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
          width: 100%;
          min-width: 0;
        }
        .voucher-exec-card {
          display: flex;
          flex-direction: row;
          flex-wrap: wrap;
          gap: 0.4rem 0.55rem;
          align-items: flex-start;
          justify-content: space-between;
          border: 1px solid #2a2a2a;
          border-radius: 8px;
          padding: 0.45rem 0.55rem;
          background: rgba(0, 0, 0, 0.32);
          width: 100%;
          min-width: 0;
          max-width: 100%;
          box-sizing: border-box;
        }
        .voucher-exec-card-main {
          min-width: 0;
          flex: 1 1 10rem;
          max-width: 100%;
          text-align: left;
        }
        .voucher-exec-card-title {
          font-size: 0.78rem;
          display: flex;
          flex-wrap: wrap;
          gap: 0.25rem 0.35rem;
          align-items: center;
          line-height: 1.3;
        }
        .voucher-summary {
          flex: 1 1 auto;
          min-width: 0;
          white-space: normal;
          overflow-wrap: break-word;
        }
        .voucher-status {
          flex: 0 0 auto;
          font-size: 0.65rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }
        .voucher-pill {
          flex: 0 0 auto;
          font-size: 0.62rem;
          font-weight: 700;
          color: #0a0a0a;
          background: #fdb913;
          border-radius: 4px;
          padding: 0.05rem 0.32rem;
        }
        .voucher-exec-meta {
          font-size: 0.66rem;
          opacity: 0.72;
          margin-top: 0.15rem;
          line-height: 1.35;
          white-space: normal;
          overflow-wrap: break-word;
        }
        .voucher-exec-meta.mono,
        .voucher-exec .mono {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        }
        .voucher-json-toggle {
          display: inline !important;
          width: auto !important;
          margin: 0 !important;
          padding: 0 !important;
          border: none !important;
          background: none !important;
          color: color-mix(in srgb, #00ffcc 85%, #fff) !important;
          font: inherit;
          font-size: inherit;
          font-weight: 600;
          cursor: pointer;
          box-shadow: none !important;
          transform: none !important;
        }
        .voucher-json-toggle:hover {
          text-decoration: underline;
        }
        .voucher-json-blocks {
          margin-top: 0.3rem;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          width: 100%;
          min-width: 0;
        }
        .voucher-json-block {
          border-radius: 6px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(0, 0, 0, 0.28);
          overflow: hidden;
          width: 100%;
          min-width: 0;
        }
        .voucher-json-block summary {
          cursor: pointer;
          padding: 0.22rem 0.4rem;
          font-size: 0.65rem;
          font-weight: 600;
          color: color-mix(in srgb, #fdb913 65%, #fff);
          list-style: none;
          user-select: none;
        }
        .voucher-json-block summary::-webkit-details-marker { display: none; }
        .voucher-json {
          margin: 0;
          padding: 0.3rem 0.4rem 0.4rem;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          font-size: 0.64rem;
          line-height: 1.35;
          white-space: pre-wrap;
          word-break: break-word;
          overflow-wrap: break-word;
          max-height: 9rem;
          overflow: auto;
          color: #d8fff6;
          width: 100%;
          max-width: 100%;
          box-sizing: border-box;
        }
        .st-ready { color: #4ade80; }
        .st-pending { color: #fbbf24; }
        .st-done { color: #94a3b8; }
      `}</style>
    </div>
  );
}
