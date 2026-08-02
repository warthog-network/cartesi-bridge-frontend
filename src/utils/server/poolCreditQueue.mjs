/**
 * Path A — server credit queue for pool deposits.
 * FE enqueues after Warthog send; pool-deposit-relayer posts InputBox.
 *
 * Phase 3: same queue feeds wart_deposit_claim once SPV lands.
 */
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const QUEUE_PATH =
  process.env.POOL_CREDIT_QUEUE_PATH ||
  '/opt/cartesi-bridge/cartesi-bridge-frontend/.data/pool-credit-queue.json';

const EMPTY = {
  version: 1,
  items: [],
  /** warthogAddress(hex lower) → last known L1 owner */
  ownerByWart: {},
  updatedAt: null,
};

async function ensureDir() {
  await fs.mkdir(path.dirname(QUEUE_PATH), { recursive: true });
}

async function readQueue() {
  try {
    const raw = await fs.readFile(QUEUE_PATH, 'utf8');
    const j = JSON.parse(raw);
    return {
      ...EMPTY,
      ...j,
      items: Array.isArray(j.items) ? j.items : [],
      ownerByWart: j.ownerByWart && typeof j.ownerByWart === 'object' ? j.ownerByWart : {},
    };
  } catch (e) {
    if (e?.code === 'ENOENT') return { ...EMPTY, items: [], ownerByWart: {} };
    throw e;
  }
}

async function writeQueue(q) {
  await ensureDir();
  const next = {
    ...q,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${QUEUE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await fs.rename(tmp, QUEUE_PATH);
  return next;
}

function normHash(h) {
  return String(h || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

function normAddr(a) {
  return String(a || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

/**
 * Enqueue or refresh a credit request after Warthog send.
 * Owner binding: first L1 owner wins for a given Warthog fromAddress.
 */
export async function requestPoolCredit({
  txHash,
  owner,
  fromAddress,
  amountE8,
  poolAddress,
  confirmations,
  source = 'fe',
  requireVerified = false,
  verified = false,
}) {
  const hash = normHash(txHash);
  if (!hash || hash.length < 16) throw new Error('txHash required');
  const own = String(owner || '').toLowerCase();
  if (!own.startsWith('0x') || own.length < 10) {
    throw new Error('L1 owner address required for credit');
  }
  if (requireVerified && !verified) {
    throw new Error(
      'POOL_CREDIT_REQUIRE_VERIFY=1 — Warthog tx must verify as pool deposit first',
    );
  }

  const q = await readQueue();
  const from = fromAddress ? normAddr(fromAddress) : null;

  // First-writer-wins: Warthog deposit address binds to one L1 owner
  if (from) {
    const bound = q.ownerByWart[from];
    if (bound && bound !== own) {
      throw new Error(
        `Warthog ${from.slice(0, 12)}… already bound to L1 ${bound.slice(0, 10)}… — cannot credit ${own.slice(0, 10)}…`,
      );
    }
    if (!bound) {
      q.ownerByWart[from] = own;
    }
  }

  const existing = q.items.find((i) => normHash(i.txHash) === hash);
  const now = new Date().toISOString();
  if (existing) {
    if (existing.status === 'credited') {
      return { ok: true, item: existing, alreadyCredited: true };
    }
    // Do not let a later caller steal owner on the same tx
    if (
      existing.owner &&
      String(existing.owner).toLowerCase() !== own
    ) {
      throw new Error(
        `tx already queued for owner ${String(existing.owner).slice(0, 10)}…`,
      );
    }
    Object.assign(existing, {
      owner: existing.owner || own,
      fromAddress: from || existing.fromAddress,
      amountE8:
        amountE8 != null && amountE8 !== ''
          ? String(amountE8)
          : existing.amountE8,
      poolAddress: poolAddress || existing.poolAddress,
      confirmations:
        confirmations != null ? Number(confirmations) : existing.confirmations,
      status:
        existing.status === 'failed' || existing.status === 'rejected'
          ? 'pending'
          : existing.status === 'credited'
            ? 'credited'
            : 'pending',
      source,
      updatedAt: now,
      error: null,
    });
    await writeQueue(q);
    return {
      ok: true,
      item: existing,
      updated: true,
      boundOwner: from ? q.ownerByWart[from] : null,
    };
  }

  const item = {
    id: crypto.randomBytes(8).toString('hex'),
    txHash: hash,
    owner: own,
    fromAddress: from,
    amountE8: amountE8 != null ? String(amountE8) : null,
    poolAddress: poolAddress || null,
    confirmations: confirmations != null ? Number(confirmations) : 0,
    status: 'pending',
    source,
    l1TxHash: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    creditedAt: null,
  };
  q.items.unshift(item);
  // retain last 200
  q.items = q.items.slice(0, 200);
  await writeQueue(q);
  return {
    ok: true,
    item,
    created: true,
    boundOwner: from ? q.ownerByWart[from] : null,
  };
}

export async function listPoolCredits({ owner, status, limit = 50 } = {}) {
  const q = await readQueue();
  let items = q.items;
  if (owner) {
    const o = String(owner).toLowerCase();
    items = items.filter((i) => String(i.owner || '').toLowerCase() === o);
  }
  if (status) {
    const s = String(status).toLowerCase();
    items = items.filter((i) => String(i.status || '').toLowerCase() === s);
  }
  return {
    ok: true,
    items: items.slice(0, Math.min(200, Number(limit) || 50)),
    ownerByWart: q.ownerByWart,
    updatedAt: q.updatedAt,
    path: QUEUE_PATH,
  };
}

export async function markPoolCredit(txHash, patch) {
  const hash = normHash(txHash);
  const q = await readQueue();
  const item = q.items.find((i) => normHash(i.txHash) === hash);
  if (!item) throw new Error(`credit queue item not found: ${hash.slice(0, 12)}…`);
  Object.assign(item, patch, { updatedAt: new Date().toISOString() });
  if (patch.status === 'credited' && !item.creditedAt) {
    item.creditedAt = new Date().toISOString();
  }
  await writeQueue(q);
  return { ok: true, item };
}

export async function loadCreditQueueRaw() {
  return readQueue();
}

export { QUEUE_PATH, normHash, normAddr };
