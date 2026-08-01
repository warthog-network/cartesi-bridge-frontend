/**
 * Path A — client pending deposit store (resume after drop / refresh).
 * Server credit queue is source of truth for the relayer; this is UX continuity.
 */

const KEY = 'cartesi.pool.pendingDeposits.v1';

function safeParse(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function listPendingDeposits() {
  if (typeof localStorage === 'undefined') return [];
  return safeParse(localStorage.getItem(KEY));
}

export function listPendingForOwner(owner) {
  const o = String(owner || '').toLowerCase();
  if (!o) return listPendingDeposits();
  return listPendingDeposits().filter(
    (p) => String(p.owner || '').toLowerCase() === o,
  );
}

export function upsertPendingDeposit(entry) {
  if (typeof localStorage === 'undefined') return entry;
  const txHash = String(entry.txHash || '').toLowerCase();
  if (!txHash) throw new Error('pending deposit requires txHash');
  const list = listPendingDeposits().filter(
    (p) => String(p.txHash || '').toLowerCase() !== txHash,
  );
  const row = {
    ...entry,
    txHash,
    owner: entry.owner ? String(entry.owner).toLowerCase() : null,
    updatedAt: new Date().toISOString(),
    createdAt: entry.createdAt || new Date().toISOString(),
  };
  list.unshift(row);
  // keep last 30
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, 30)));
  return row;
}

export function updatePendingStatus(txHash, status, extra = {}) {
  const h = String(txHash || '').toLowerCase();
  const list = listPendingDeposits();
  const next = list.map((p) =>
    String(p.txHash || '').toLowerCase() === h
      ? {
          ...p,
          ...extra,
          status,
          updatedAt: new Date().toISOString(),
        }
      : p,
  );
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(KEY, JSON.stringify(next));
  }
  return next.find((p) => String(p.txHash || '').toLowerCase() === h) || null;
}

export function removePendingDeposit(txHash) {
  const h = String(txHash || '').toLowerCase();
  if (typeof localStorage === 'undefined') return;
  const list = listPendingDeposits().filter(
    (p) => String(p.txHash || '').toLowerCase() !== h,
  );
  localStorage.setItem(KEY, JSON.stringify(list));
}

/** Statuses that still need rollup credit (not terminal). */
export function isOpenPendingStatus(status) {
  return [
    'awaiting_confirm',
    'credit_requested',
    'awaiting_rollup',
    'stranded',
  ].includes(String(status || ''));
}
