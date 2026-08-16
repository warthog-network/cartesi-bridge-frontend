/**
 * Path A pool round-trip tracker (client).
 * Like Warthog mempool pending: stay visible until the cycle is done
 * (WART back in Warthog wallet after burn/redeem payout).
 *
 * Steps (order):
 *   deposit_pending → credit_pending → credited
 *   → minted → voucher_ready → wwart_on_l1
 *   → portal_ready → burned → payout_pending → complete
 */

const KEY = 'cartesi.pool.flow.v1';

/** Ordered pipeline for UI */
export const FLOW_STEPS = [
  {
    id: 'deposit_pending',
    label: 'WART deposit',
    hint: 'Warthog tx confirming (like mempool)',
  },
  {
    id: 'credit_pending',
    label: 'Pool credit',
    hint: 'Relayer / rollup crediting deposit',
  },
  {
    id: 'credited',
    label: 'Credited',
    hint: 'WART locked in pool — ready to mint',
  },
  {
    id: 'minted',
    label: 'Claim minted',
    hint: 'Portable claim open — withdraw voucher next',
  },
  {
    id: 'voucher_ready',
    label: 'Voucher ready',
    hint: 'Execute voucher for MetaMask wWART',
  },
  {
    id: 'wwart_on_l1',
    label: 'wWART on L1',
    hint: 'In wallet — deposit portal to return',
  },
  {
    id: 'portal_ready',
    label: 'Portal deposited',
    hint: 'Ready to burn claim',
  },
  {
    id: 'burned',
    label: 'Claim burned',
    hint: 'Unlock ticket issued',
  },
  {
    id: 'payout_pending',
    label: 'WART payout',
    hint: 'Hot wallet sending WART back',
  },
  {
    id: 'complete',
    label: 'Complete',
    hint: 'WART back in Warthog wallet',
  },
];

const STEP_INDEX = Object.fromEntries(FLOW_STEPS.map((s, i) => [s.id, i]));

function safeParse(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function readAll() {
  if (typeof localStorage === 'undefined') return [];
  return safeParse(localStorage.getItem(KEY));
}

function writeAll(list) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20)));
}

export function listFlows(owner) {
  const all = readAll();
  if (!owner) return all;
  const o = String(owner).toLowerCase();
  return all.filter((f) => String(f.owner || '').toLowerCase() === o);
}

export function isOpenFlow(flow) {
  if (!flow) return false;
  const s = String(flow.step || '');
  return s && s !== 'complete' && s !== 'failed' && s !== 'cancelled';
}

export function listOpenFlows(owner) {
  return listFlows(owner).filter(isOpenFlow);
}

/**
 * Start or refresh a flow after Warthog deposit send.
 * @param {{ owner: string, amountHuman?: string, amountE8?: string, depositTxHash?: string, step?: string }} entry
 */
export function upsertFlow(entry) {
  const owner = String(entry.owner || '').toLowerCase();
  if (!owner) throw new Error('flow requires owner');
  const id =
    entry.id ||
    entry.depositTxHash ||
    `flow-${owner.slice(2, 10)}-${Date.now().toString(36)}`;
  const list = readAll().filter((f) => f.id !== id);
  const row = {
    id: String(id).toLowerCase(),
    owner,
    amountHuman: entry.amountHuman || null,
    amountE8: entry.amountE8 != null ? String(entry.amountE8) : null,
    depositTxHash: entry.depositTxHash
      ? String(entry.depositTxHash).toLowerCase()
      : null,
    step: entry.step || 'deposit_pending',
    ticketId: entry.ticketId || null,
    payoutTxHash: entry.payoutTxHash || null,
    note: entry.note || null,
    createdAt: entry.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // Prefer one open flow per owner when starting deposit (merge latest)
  if (entry.replaceOpen) {
    const rest = list.filter(
      (f) => !(String(f.owner).toLowerCase() === owner && isOpenFlow(f)),
    );
    rest.unshift(row);
    writeAll(rest);
    return row;
  }
  list.unshift(row);
  writeAll(list);
  return row;
}

export function updateFlow(id, patch) {
  const want = String(id || '').toLowerCase();
  const list = readAll();
  let updated = null;
  const next = list.map((f) => {
    if (String(f.id).toLowerCase() !== want) return f;
    updated = {
      ...f,
      ...patch,
      id: f.id,
      owner: f.owner,
      updatedAt: new Date().toISOString(),
    };
    return updated;
  });
  writeAll(next);
  return updated;
}

/** Advance open flow for owner to at least `step` (never go backwards). */
export function advanceFlowForOwner(owner, step, patch = {}) {
  const o = String(owner || '').toLowerCase();
  const target = STEP_INDEX[step];
  if (target == null) return null;
  const list = readAll();
  let updated = null;
  const next = list.map((f) => {
    if (String(f.owner).toLowerCase() !== o || !isOpenFlow(f)) return f;
    const cur = STEP_INDEX[f.step] ?? -1;
    if (target < cur) return f;
    updated = {
      ...f,
      ...patch,
      step,
      updatedAt: new Date().toISOString(),
    };
    return updated;
  });
  writeAll(next);
  return updated;
}

export function completeFlow(id, patch = {}) {
  return updateFlow(id, { step: 'complete', note: patch.note || 'done', ...patch });
}

export function cancelFlow(id) {
  return updateFlow(id, { step: 'cancelled' });
}

/** Cancel every open flow for an L1 owner (browser tracker only — no chain effect). */
export function clearOpenFlowsForOwner(owner) {
  const o = String(owner || '').toLowerCase();
  if (!o || typeof localStorage === 'undefined') return 0;
  const list = readAll();
  let n = 0;
  const next = list.map((f) => {
    if (String(f.owner || '').toLowerCase() !== o || !isOpenFlow(f)) return f;
    n += 1;
    return {
      ...f,
      step: 'cancelled',
      note: f.note || 'cleared stuck pipeline',
      updatedAt: new Date().toISOString(),
    };
  });
  writeAll(next);
  return n;
}

/** Wipe all flow rows for an owner (open + terminal). */
export function wipeFlowsForOwner(owner) {
  const o = String(owner || '').toLowerCase();
  if (!o || typeof localStorage === 'undefined') return 0;
  const list = readAll();
  const next = list.filter((f) => String(f.owner || '').toLowerCase() !== o);
  const removed = list.length - next.length;
  writeAll(next);
  return removed;
}

export function stepMeta(stepId) {
  return FLOW_STEPS.find((s) => s.id === stepId) || {
    id: stepId,
    label: stepId,
    hint: '',
  };
}

/**
 * Reconcile open flows from rollup inspect + optional L1 wWART balance.
 * Moves the step forward when chain truth has advanced (refresh / poll).
 *
 * @param {string} owner
 * @param {{ user?: object, lockedE8?: string, claimed18?: string } | null} poolInspect
 * @param {{ mmWwartHuman?: string|number|null, portalWwart?: string|null }} [extra]
 */
export function reconcileFlowsFromInspect(owner, poolInspect, extra = {}) {
  const o = String(owner || '').toLowerCase();
  if (!o) return listOpenFlows(o);

  const u = poolInspect?.user || {};
  const deposited = BigInt(String(u.depositedE8 || 0));
  const claim = BigInt(String(u.claim18 || 0));
  const portable = BigInt(String(u.portable18 || 0));
  const redeemed = BigInt(String(u.redeemedE8 || 0));
  const freeable = BigInt(String(u.freeableE8 || 0));
  const locked = BigInt(String(poolInspect?.lockedE8 || 0));

  let mm = 0;
  try {
    if (extra.mmWwartHuman != null && extra.mmWwartHuman !== '') {
      mm = Number(extra.mmWwartHuman);
    }
  } catch {
    mm = 0;
  }
  let portal = 0n;
  try {
    portal = BigInt(String(extra.portalWwart || 0));
  } catch {
    portal = 0n;
  }

  // Infer furthest step from chain
  let inferred = null;
  if (deposited === 0n && claim === 0n && locked === 0n && redeemed > 0n) {
    inferred = 'complete'; // or burned+paid; treat as complete if no lock
  } else if (deposited === 0n && claim === 0n && freeable === 0n && redeemed > 0n) {
    inferred = 'payout_pending';
  } else if (claim === 0n && deposited > 0n && freeable > 0n) {
    // post-burn freeable unlock path
    inferred = 'burned';
  } else if (claim > 0n && portal > 0n) {
    inferred = 'portal_ready';
  } else if (claim > 0n && portable === 0n && mm > 0) {
    inferred = 'wwart_on_l1';
  } else if (claim > 0n && portable === 0n && mm <= 0) {
    // voucher issued, not executed yet (or already burned L1)
    inferred = 'voucher_ready';
  } else if (claim > 0n && portable > 0n) {
    inferred = 'minted';
  } else if (deposited > 0n && claim === 0n) {
    inferred = 'credited';
  }

  const list = readAll();
  let changed = false;
  const next = list.map((f) => {
    if (String(f.owner).toLowerCase() !== o || !isOpenFlow(f)) return f;
    if (!inferred) return f;
    const cur = STEP_INDEX[f.step] ?? -1;
    const inf = STEP_INDEX[inferred] ?? -1;
    // Don't jump from early deposit steps to complete without intermediate —
    // only advance if inferred is ahead.
    if (inf <= cur) return f;
    // Special: if still deposit_pending/credit and inspect already credited
    if (
      (f.step === 'deposit_pending' || f.step === 'credit_pending') &&
      deposited > 0n
    ) {
      changed = true;
      return {
        ...f,
        step: 'credited',
        updatedAt: new Date().toISOString(),
        note: 'synced from rollup inspect',
      };
    }
    changed = true;
    return {
      ...f,
      step: inferred,
      updatedAt: new Date().toISOString(),
      note: 'synced from rollup inspect',
    };
  });

  // Auto-complete when fully flat after a cycle
  const next2 = next.map((f) => {
    if (String(f.owner).toLowerCase() !== o || !isOpenFlow(f)) return f;
    if (
      deposited === 0n &&
      claim === 0n &&
      locked === 0n &&
      (f.step === 'burned' ||
        f.step === 'payout_pending' ||
        f.step === 'portal_ready' ||
        f.step === 'wwart_on_l1')
    ) {
      changed = true;
      return {
        ...f,
        step: 'complete',
        updatedAt: new Date().toISOString(),
        note: 'cycle complete (inspect clear)',
      };
    }
    return f;
  });

  if (changed) writeAll(next2);
  return listOpenFlows(o);
}

/** Progress 0–1 for stepper UI */
export function flowProgress(stepId) {
  const i = STEP_INDEX[stepId];
  if (i == null) return 0;
  if (stepId === 'complete') return 1;
  return Math.min(1, (i + 1) / FLOW_STEPS.length);
}
