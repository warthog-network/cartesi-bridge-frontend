/**
 * S5 — browser-node signal quorum progress (vault-sign-signal-v0).
 *
 * Polls public `/api/signals` aggregator. Cosigner gate stays OFF on live
 * (`requireSignals: false`); this module only surfaces progress + helpers.
 *
 * Full digest math lives in repo scripts/lib (Node). Browser builds a minimal
 * policyDigest client via ethers when needed for withdraw packaging (S4).
 */

/**
 * Aggregator status (no vault filter).
 * @returns {Promise<{ ok: boolean, requireSignals: boolean, quorumX: number, signals: number, vaults: number }>}
 */
export async function fetchSignalsStatus() {
  const res = await fetch('/api/signals', { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `signals HTTP ${res.status}`);
  }
  return {
    ok: Boolean(body.ok),
    requireSignals: body.requireSignals === true,
    quorumX: Number(body.quorumX || 3),
    signals: Number(body.signals || 0),
    vaults: Number(body.vaults || 0),
    ttlSec: body.ttlSec,
    service: body.service,
  };
}

/**
 * Quorum for vault + policyDigest.
 * @param {{ vault: string, policyDigest: string }} q
 */
export async function fetchSignalQuorum({ vault, policyDigest }) {
  const v = String(vault || '').toLowerCase();
  const d = String(policyDigest || '').toLowerCase();
  if (!v || !d) throw new Error('vault and policyDigest required');
  const url = `/api/signals?vault=${encodeURIComponent(v)}&policyDigest=${encodeURIComponent(d)}&quorum=1`;
  const res = await fetch(url, { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `signals HTTP ${res.status}`);
  }
  return {
    ok: true,
    count: Number(body.count || 0),
    x: Number(body.x || 3),
    quorumMet: Boolean(body.quorumMet),
    nodeIds: Array.isArray(body.nodeIds) ? body.nodeIds : [],
    policyDigest: body.policyDigest || d,
    vault: body.vault || v,
  };
}

/** Human label for vault withdraw UI. */
export function formatSignalProgress(q, { gateOn = false } = {}) {
  if (!gateOn) {
    if (q && Number(q.count) > 0) {
      return `Browser signals: ${q.count}/${q.x || 3} (gate off — informational)`;
    }
    return 'Browser signals: gate off (demo)';
  }
  if (!q) return 'Browser signals: waiting for nodes…';
  const c = Number(q.count || 0);
  const x = Number(q.x || 3);
  if (q.quorumMet) return `Browser signals: ${c}/${x} agreed ✓`;
  return `Browser signals: ${c}/${x} agreed — need ${x}`;
}
