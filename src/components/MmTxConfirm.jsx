/**
 * Pre-MetaMask confirmation: shows descriptive JSON for rollup inputs,
 * vouchers, and portal payloads before the wallet popup.
 */
import { useCallback, useState } from 'react';
import { formatDescribeJson } from '../utils/mmTxDescribe.js';

export function MmTxConfirmModal({
  open,
  title,
  method,
  summary,
  sections = [],
  confirmLabel = 'Open MetaMask',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}) {
  if (!open) return null;

  return (
    <div
      className="mm-tx-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mm-tx-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel?.();
      }}
    >
      <div className="mm-tx-modal">
        <header className="mm-tx-head">
          <h3 id="mm-tx-title" className="mm-tx-title">
            {title || 'Confirm transaction'}
          </h3>
          {method ? <p className="mm-tx-method mono">{method}</p> : null}
        </header>

        {summary ? (
          <pre className="mm-tx-summary mono">{summary}</pre>
        ) : null}

        <div className="mm-tx-sections">
          {(sections || []).map((sec, i) => (
            <details
              key={`${sec.label || 'section'}-${i}`}
              className="mm-tx-section"
              open={i === 0}
            >
              <summary>{sec.label || `Details ${i + 1}`}</summary>
              <pre className="mm-tx-json mono">
                {typeof sec.json === 'string'
                  ? sec.json
                  : formatDescribeJson(sec.json)}
              </pre>
            </details>
          ))}
        </div>

        <p className="mm-tx-hint">
          Review the JSON above — MetaMask will show the contract call next.
          Bytes fields appear as hex there; this is the decoded payload.
        </p>

        <div className="mm-tx-actions">
          <button type="button" className="btn secondary small" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="btn primary small" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>

      <style>{`
        .mm-tx-overlay {
          position: fixed;
          inset: 0;
          z-index: 10050;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
          background: rgba(0, 0, 0, 0.62);
          backdrop-filter: blur(2px);
        }
        .mm-tx-modal {
          width: min(32rem, 100%);
          max-height: min(88vh, 40rem);
          overflow: auto;
          border-radius: 12px;
          border: 1px solid color-mix(in srgb, #00ffcc 28%, #333);
          background: linear-gradient(165deg, #1a2220 0%, #121416 55%, #0e1012 100%);
          box-shadow:
            0 0 0 1px rgba(0, 0, 0, 0.4),
            0 16px 48px rgba(0, 0, 0, 0.55),
            0 0 24px color-mix(in srgb, #00ffcc 12%, transparent);
          color: #f2f2f2;
          padding: 0.9rem 1rem 1rem;
          text-align: left;
        }
        .mm-tx-head {
          margin-bottom: 0.55rem;
        }
        .mm-tx-title {
          margin: 0;
          font-size: 1rem;
          color: #00ffcc;
          font-weight: 700;
        }
        .mm-tx-method {
          margin: 0.3rem 0 0;
          font-size: 0.72rem;
          opacity: 0.72;
          overflow-wrap: anywhere;
        }
        .mm-tx-summary {
          margin: 0 0 0.55rem;
          padding: 0.45rem 0.55rem;
          border-radius: 8px;
          background: rgba(0, 0, 0, 0.35);
          border: 1px solid rgba(255, 255, 255, 0.08);
          font-size: 0.74rem;
          line-height: 1.45;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .mm-tx-sections {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }
        .mm-tx-section {
          border-radius: 8px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(0, 0, 0, 0.28);
          overflow: hidden;
        }
        .mm-tx-section summary {
          cursor: pointer;
          padding: 0.4rem 0.55rem;
          font-size: 0.75rem;
          font-weight: 600;
          color: color-mix(in srgb, #fdb913 70%, #fff);
          user-select: none;
          list-style: none;
        }
        .mm-tx-section summary::-webkit-details-marker { display: none; }
        .mm-tx-section summary::before {
          content: '▸ ';
          opacity: 0.75;
        }
        .mm-tx-section[open] summary::before {
          content: '▾ ';
        }
        .mm-tx-json {
          margin: 0;
          padding: 0.45rem 0.55rem 0.55rem;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          font-size: 0.7rem;
          line-height: 1.4;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          max-height: 14rem;
          overflow: auto;
          color: #d8fff6;
        }
        .mm-tx-hint {
          margin: 0.55rem 0 0.65rem;
          font-size: 0.7rem;
          opacity: 0.65;
          line-height: 1.4;
        }
        .mm-tx-actions {
          display: flex;
          justify-content: flex-end;
          gap: 0.45rem;
          flex-wrap: wrap;
        }
        .mm-tx-modal .mono {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        }
      `}</style>
    </div>
  );
}

/**
 * @returns {[confirm: (desc: object) => Promise<boolean>, modal: JSX.Element|null]}
 */
export function useMmTxConfirm() {
  const [pending, setPending] = useState(null);

  const confirm = useCallback((desc) => {
    if (!desc) return Promise.resolve(true);
    return new Promise((resolve) => {
      setPending({ desc, resolve });
    });
  }, []);

  const close = useCallback(
    (ok) => {
      if (!pending) return;
      pending.resolve(Boolean(ok));
      setPending(null);
    },
    [pending],
  );

  const modal = pending ? (
    <MmTxConfirmModal
      open
      title={pending.desc.title}
      method={pending.desc.method}
      summary={pending.desc.summary}
      sections={pending.desc.sections}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  ) : null;

  return [confirm, modal];
}
