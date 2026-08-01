/**
 * S5 — compact signal quorum status for vault / withdraw surfaces.
 * Non-blocking: live demo keeps COSIGNER_REQUIRE_SIGNALS off.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  fetchSignalQuorum,
  fetchSignalsStatus,
  formatSignalProgress,
} from '../utils/signalQuorum.js';

/**
 * @param {{ vaultAddress?: string, policyDigest?: string, pollMs?: number, compact?: boolean }} props
 */
export default function SignalQuorumBadge({
  vaultAddress = '',
  policyDigest = '',
  pollMs = 8000,
  compact = true,
}) {
  const [status, setStatus] = useState(null);
  const [quorum, setQuorum] = useState(null);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    try {
      const st = await fetchSignalsStatus();
      setStatus(st);
      setErr('');
      if (vaultAddress && policyDigest) {
        const q = await fetchSignalQuorum({
          vault: vaultAddress,
          policyDigest,
        });
        setQuorum(q);
      } else {
        setQuorum(null);
      }
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }, [vaultAddress, policyDigest]);

  useEffect(() => {
    refresh();
    if (!pollMs || pollMs < 1000) return undefined;
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  const gateOn = status?.requireSignals === true;
  const label = formatSignalProgress(quorum, { gateOn });

  if (compact) {
    return (
      <div
        className="signal-quorum-badge"
        title={
          err ||
          (status
            ? `aggregator vaults=${status.vaults} signals=${status.signals} X=${status.quorumX}`
            : 'Loading signal status…')
        }
        style={{
          fontSize: '0.8rem',
          opacity: 0.85,
          marginTop: '0.35rem',
          lineHeight: 1.35,
        }}
      >
        <span aria-live="polite">{err ? `Signals: ${err}` : label}</span>
        {gateOn && (
          <span style={{ color: 'var(--warn, #c90)', marginLeft: 6 }}>
            gate ON
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="signal-quorum-panel"
      style={{
        border: '1px solid rgba(128,128,128,0.35)',
        borderRadius: 8,
        padding: '0.6rem 0.75rem',
        marginTop: '0.5rem',
        fontSize: '0.85rem',
      }}
    >
      <strong>Browser-node signals</strong>
      <div style={{ marginTop: 4 }}>{err ? err : label}</div>
      {status && (
        <div style={{ opacity: 0.75, marginTop: 4 }}>
          Store: {status.signals} signal(s) / {status.vaults} vault(s) · X=
          {status.quorumX}
          {gateOn ? ' · cosigner gate ON' : ' · cosigner gate off'}
        </div>
      )}
      {quorum?.nodeIds?.length > 0 && (
        <div style={{ opacity: 0.7, marginTop: 4, wordBreak: 'break-all' }}>
          Nodes: {quorum.nodeIds.map((n) => String(n).slice(0, 10)).join(', ')}
          …
        </div>
      )}
    </div>
  );
}
