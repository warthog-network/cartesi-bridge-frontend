/**
 * Path A hot-wallet payout — send real WART from fungible pool address.
 * Does not touch cosigner threshold shares.
 *
 * Nonce policy (Warthog account nonces are unique per origin, not "ETH-style next"):
 *  1. Scan account history for max used nonceId
 *  2. Merge with local durable counter (.data/fungible-pool-nonce.json)
 *  3. Allocate max+1 (or higher after collisions)
 *  4. On "Duplicate transaction nonce", bump and retry
 *  5. Persist every successful/attempted allocation so restarts stay consistent
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const HOT_KEY_PATH =
  process.env.FUNGIBLE_POOL_HOT_KEY ||
  '/opt/cartesi-bridge/cartesi-bridge-frontend/.data/fungible-pool-hot.json';
const PAID_PATH =
  process.env.FUNGIBLE_POOL_PAID ||
  '/opt/cartesi-bridge/cartesi-bridge-frontend/.data/fungible-pool-paid.json';
const NONCE_PATH =
  process.env.FUNGIBLE_POOL_NONCE_PATH ||
  '/opt/cartesi-bridge/cartesi-bridge-frontend/.data/fungible-pool-nonce.json';
const NODE_URL =
  process.env.WARTHOG_RPC ||
  process.env.FUNGIBLE_POOL_NODE ||
  'https://warthog-defitestnet.duckdns.org';
/** Extra node URLs tried for history/balance (comma-separated). */
const NODE_URLS = [
  NODE_URL,
  ...(process.env.FUNGIBLE_POOL_NODE_FALLBACKS || 'http://127.0.0.1:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
].filter((v, i, a) => v && a.indexOf(v) === i);

const MAX_NONCE_RETRIES = Number(process.env.POOL_PAYOUT_NONCE_RETRIES || 8);

export async function loadPoolHotKey() {
  const raw = await readFile(HOT_KEY_PATH, 'utf8');
  const j = JSON.parse(raw);
  if (!j?.privateKeyHex || !j?.address) {
    throw new Error('fungible pool hot key file missing address/privateKeyHex');
  }
  return {
    address: String(j.address).replace(/^0x/i, '').toLowerCase(),
    privateKeyHex: String(j.privateKeyHex).replace(/^0x/i, '').toLowerCase(),
    poolId: j.poolId || 'wart-pool-0',
  };
}

async function loadPaid() {
  try {
    return JSON.parse(await readFile(PAID_PATH, 'utf8'));
  } catch {
    return { version: 1, tickets: {} };
  }
}

async function savePaid(state) {
  await mkdir(dirname(PAID_PATH), { recursive: true });
  await writeFile(PAID_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function loadNonceState(address) {
  try {
    const j = JSON.parse(await readFile(NONCE_PATH, 'utf8'));
    if (String(j.address || '').toLowerCase() !== String(address).toLowerCase()) {
      return {
        version: 1,
        address: String(address).toLowerCase(),
        nextNonce: 0,
        lastUsedNonce: null,
        lastTicketId: null,
        updatedAt: null,
      };
    }
    return {
      version: 1,
      address: String(address).toLowerCase(),
      nextNonce: Number(j.nextNonce || 0),
      lastUsedNonce:
        j.lastUsedNonce != null ? Number(j.lastUsedNonce) : null,
      lastTicketId: j.lastTicketId || null,
      updatedAt: j.updatedAt || null,
    };
  } catch {
    return {
      version: 1,
      address: String(address).toLowerCase(),
      nextNonce: 0,
      lastUsedNonce: null,
      lastTicketId: null,
      updatedAt: null,
    };
  }
}

async function saveNonceState(state) {
  await mkdir(dirname(NONCE_PATH), { recursive: true });
  state.updatedAt = new Date().toISOString();
  await writeFile(NONCE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function e8ToHuman(e8) {
  const n = BigInt(e8);
  const whole = n / 100000000n;
  let frac = (n % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

function collectNonces(obj, out = new Set(), depth = 0) {
  if (!obj || depth > 10) return out;
  if (Array.isArray(obj)) {
    for (const x of obj) collectNonces(x, out, depth + 1);
    return out;
  }
  if (typeof obj !== 'object') return out;
  if (obj.nonceId != null && Number.isFinite(Number(obj.nonceId))) {
    out.add(Number(obj.nonceId));
  }
  if (
    obj.signedCommon?.nonceId != null &&
    Number.isFinite(Number(obj.signedCommon.nonceId))
  ) {
    out.add(Number(obj.signedCommon.nonceId));
  }
  for (const v of Object.values(obj)) collectNonces(v, out, depth + 1);
  return out;
}

/**
 * Max nonceId observed on-chain for this address (history pages).
 * @returns {Promise<{ max: number|null, source: string, nodesTried: string[] }>}
 */
async function discoverChainMaxNonce(WarthogApi, address) {
  const nodesTried = [];
  let max = null;
  let source = 'none';

  for (const base of NODE_URLS) {
    nodesTried.push(base);
    try {
      const api = new WarthogApi(base);
      // Primary: paginated history (works when /account/:addr 502s)
      let before = 4294967295;
      for (let page = 0; page < 5; page++) {
        const hist = await api.getAccountHistory(address, before);
        if (!hist?.success) break;
        const data = hist.data || {};
        const nonces = collectNonces(data);
        for (const n of nonces) {
          if (max == null || n > max) {
            max = n;
            source = `${base}#history`;
          }
        }
        const perBlock = data.perBlock;
        if (!Array.isArray(perBlock) || perBlock.length === 0) break;
        // advance cursor if present
        if (data.fromId != null && Number(data.fromId) < before) {
          before = Number(data.fromId);
        } else {
          break;
        }
      }

      // Secondary: account / wart_balance fields when available
      try {
        const acc = await api.getNodePath(`account/${address}`);
        if (acc?.success) {
          const n = Number(
            acc.data?.nextNonceId ??
              acc.data?.nonceId ??
              acc.data?.account?.nextNonceId ??
              acc.data?.account?.nonceId,
          );
          if (Number.isFinite(n)) {
            // nextNonceId is next to use → max used is n-1
            const used = acc.data?.nextNonceId != null ? n - 1 : n;
            if (max == null || used > max) {
              max = used;
              source = `${base}#account`;
            }
          }
        }
      } catch {
        /* account 502 common */
      }

      try {
        const bal = await api.getAccountWartBalance(address);
        if (bal?.success) {
          const n = Number(
            bal.data?.nonceId ??
              bal.data?.nextNonceId ??
              bal.data?.account?.nonceId ??
              bal.data?.account?.nextNonceId,
          );
          if (Number.isFinite(n)) {
            const used =
              bal.data?.nextNonceId != null ||
              bal.data?.account?.nextNonceId != null
                ? n - 1
                : n;
            if (max == null || used > max) {
              max = used;
              source = `${base}#wart_balance`;
            }
          }
        }
      } catch {
        /* */
      }

      // Mempool nonces must not be reused
      try {
        const mem = await api.getAccountMempool(address);
        if (mem?.success) {
          const nonces = collectNonces(mem.data);
          for (const n of nonces) {
            if (max == null || n > max) {
              max = n;
              source = `${base}#mempool`;
            }
          }
        }
      } catch {
        /* */
      }

      if (max != null) break; // good enough from first healthy node
    } catch {
      /* try next node */
    }
  }

  // Also fold nonces recorded in paid tickets
  try {
    const paid = await loadPaid();
    for (const rec of Object.values(paid.tickets || {})) {
      if (rec?.nonceId != null && Number.isFinite(Number(rec.nonceId))) {
        const n = Number(rec.nonceId);
        if (max == null || n > max) {
          max = n;
          source = source === 'none' ? 'paid-store' : `${source}+paid`;
        }
      }
    }
  } catch {
    /* */
  }

  return { max, source, nodesTried };
}

/**
 * Allocate next nonce: max(chainMax, localLast)+1, then advance local cursor.
 */
async function allocateNonce(address, { ticketId } = {}) {
  const { WarthogApi } = await import('warthog-js');
  const local = await loadNonceState(address);
  const chain = await discoverChainMaxNonce(WarthogApi, address);

  const candidates = [];
  if (local.lastUsedNonce != null) candidates.push(Number(local.lastUsedNonce));
  if (local.nextNonce != null) candidates.push(Number(local.nextNonce) - 1);
  if (chain.max != null) candidates.push(Number(chain.max));

  const floor = candidates.length ? Math.max(...candidates) : -1;
  let next = floor + 1;
  if (next < 0) next = 0;
  // u32 wrap safety
  if (next > 0xffffffff) next = 0;

  local.nextNonce = next + 1;
  local.lastUsedNonce = next; // provisional; confirmed on success (same value)
  local.lastTicketId = ticketId || local.lastTicketId;
  await saveNonceState(local);

  return {
    nonce: next,
    chainMax: chain.max,
    chainSource: chain.source,
    nodesTried: chain.nodesTried,
    localNextAfter: local.nextNonce,
  };
}

async function bumpNonceAfterCollision(address, failedNonce) {
  const local = await loadNonceState(address);
  const base = Math.max(
    Number(failedNonce) + 1,
    Number(local.nextNonce || 0),
    Number(local.lastUsedNonce != null ? local.lastUsedNonce + 1 : 0),
  );
  local.nextNonce = base + 1;
  local.lastUsedNonce = base;
  await saveNonceState(local);
  return base;
}

function isDuplicateNonceError(err) {
  const msg = String(err?.message || err || '');
  return /duplicate.*nonce|nonce.*duplicate|already.*nonce/i.test(msg);
}

/**
 * @param {{
 *   ticketId: string,
 *   toAddress: string,
 *   amountE8: string|number|bigint,
 *   owner?: string,
 *   verifiedFromNotice?: boolean,
 *   noticeIndex?: number,
 * }} args
 * Callers MUST verify the ticket against rollup notices (pool.js does).
 */
export async function payoutPoolTicket(args) {
  const ticketId = String(args.ticketId || '').trim();
  let toNorm = String(args.toAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const amountE8 = BigInt(String(args.amountE8 || 0));
  if (!ticketId) throw new Error('ticketId required');
  if (amountE8 <= 0n) throw new Error('amountE8 must be > 0');
  if (
    args.verifiedFromNotice !== true &&
    process.env.POOL_PAYOUT_SKIP_VERIFY !== '1'
  ) {
    throw new Error(
      'payoutPoolTicket: verifiedFromNotice required (use /api/pool payout)',
    );
  }

  const paid = await loadPaid();
  // Idempotency: same ticketId + amount + destination already paid.
  const prior = paid.tickets[ticketId];
  if (
    prior &&
    String(prior.amountE8) === String(amountE8) &&
    String(prior.toAddress || '')
      .replace(/^0x/i, '')
      .toLowerCase() === toNorm
  ) {
    return { ok: true, alreadyPaid: true, ...prior };
  }
  // Also match disambiguated keys ticketId@amount
  const altKey = `${ticketId}@${amountE8}`;
  if (paid.tickets[altKey] && !prior) {
    const p = paid.tickets[altKey];
    if (
      String(p.amountE8) === String(amountE8) &&
      String(p.toAddress || '')
        .replace(/^0x/i, '')
        .toLowerCase() === toNorm
    ) {
      return { ok: true, alreadyPaid: true, ...p };
    }
  }
  const paidKey =
    prior && String(prior.amountE8) !== String(amountE8)
      ? `${ticketId}@${amountE8}`
      : ticketId;

  const hot = await loadPoolHotKey();
  const {
    WarthogApi,
    Account,
    Address,
    NonceId,
    RoundedFee,
    Wart,
    TransactionContext,
    normalizeChainPin,
  } = await import('warthog-js');

  if (toNorm.length === 40) {
    const expanded = Address.fromRaw(toNorm);
    if (!expanded) throw new Error('Invalid 40-hex Warthog address');
    toNorm = expanded.hex;
  } else if (toNorm.length !== 48) {
    throw new Error(`toAddress must be 40 or 48 hex (got ${toNorm.length})`);
  }
  if (toNorm === hot.address) {
    throw new Error('Self send transaction not allowed');
  }
  const toAddr = Address.fromHex(toNorm);
  if (!toAddr) throw new Error('invalid toAddress');

  // Prefer primary NODE_URL for submit; fall back if needed
  let api = new WarthogApi(NODE_URL);
  const account = Account.fromPrivateKeyHex(hot.privateKeyHex);
  const fromAddr = String(account.address.hex).toLowerCase();
  if (fromAddr !== hot.address) {
    throw new Error(
      `hot key address mismatch file=${hot.address} derived=${fromAddr}`,
    );
  }

  // Spendable check
  let spendableE8 = null;
  for (const base of NODE_URLS) {
    try {
      const a = new WarthogApi(base);
      const balRes = await a.getAccountWartBalance(fromAddr);
      if (balRes.success) {
        const d = balRes.data || {};
        const wart = d.wart || d;
        const totalE8 = BigInt(
          wart.total?.E8 ??
            d.spendable?.E8 ??
            d.spendableE8 ??
            d.balance?.E8 ??
            d.E8 ??
            0,
        );
        const lockedE8 = BigInt(wart.locked?.E8 ?? d.locked?.E8 ?? 0);
        const mempoolE8 = BigInt(wart.mempool?.E8 ?? d.mempool?.E8 ?? 0);
        spendableE8 = totalE8 - lockedE8 - mempoolE8;
        if (spendableE8 < 0n) spendableE8 = 0n;
        api = a; // use working node for later fee/head/submit
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (spendableE8 != null && spendableE8 < amountE8) {
    throw new Error(
      `pool spendable ${e8ToHuman(spendableE8)} WART < payout ${e8ToHuman(amountE8)} — fund pool ${fromAddr}`,
    );
  }

  const feeRes = await api.getMinFee();
  if (!feeRes.success) throw new Error(feeRes.error || 'getMinFee failed');
  const fee = RoundedFee.fromE8(BigInt(feeRes.data.minFee.E8), true);
  if (!fee) throw new Error('invalid fee');

  let alloc = await allocateNonce(fromAddr, { ticketId });
  let lastErr = null;

  for (let attempt = 0; attempt < MAX_NONCE_RETRIES; attempt++) {
    const nonceNum =
      attempt === 0
        ? alloc.nonce
        : await bumpNonceAfterCollision(fromAddr, alloc.nonce);
    alloc = { ...alloc, nonce: nonceNum };

    const nonce = NonceId.fromNumber(nonceNum);
    if (!nonce) throw new Error(`invalid nonce ${nonceNum}`);

    let headRes = await api.getChainHead();
    if (!headRes.success) {
      // try other nodes
      for (const base of NODE_URLS) {
        try {
          const a = new WarthogApi(base);
          headRes = await a.getChainHead();
          if (headRes.success) {
            api = a;
            break;
          }
        } catch {
          /* */
        }
      }
    }
    if (!headRes.success) throw new Error(headRes.error || 'chain head failed');
    const { pinHash, pinHeight } = normalizeChainPin(headRes.data);

    const wart = Wart.fromE8(amountE8);
    if (!wart) throw new Error('invalid amount E8');

    const ctx = new TransactionContext(
      {
        pinHash: String(pinHash).replace(/^0x/i, ''),
        pinHeight: Number(pinHeight),
      },
      fee,
      nonce,
    );
    const tx = ctx.transferWart(account, toAddr, wart);
    const body = JSON.parse(
      JSON.stringify(tx, (_, v) => (typeof v === 'bigint' ? Number(v) : v)),
    );

    const sub = await api.submitTransaction(body);
    if (sub.success) {
      const txHash =
        sub.data?.txHash ||
        sub.data?.hash ||
        sub.data?.transaction?.hash ||
        sub.data?.data?.txHash ||
        null;

      const record = {
        ticketId,
        paidKey,
        owner: args.owner || null,
        toAddress: toNorm,
        amountE8: amountE8.toString(),
        amountHuman: e8ToHuman(amountE8),
        fromAddress: fromAddr,
        txHash,
        nonceId: nonceNum,
        pinHeight: Number(pinHeight),
        pinHash: String(pinHash).replace(/^0x/i, ''),
        paidAt: new Date().toISOString(),
        node: api.baseUrl || NODE_URL,
        nonceMeta: {
          chainMax: alloc.chainMax,
          chainSource: alloc.chainSource,
          attempt: attempt + 1,
        },
      };
      paid.tickets[paidKey] = record;
      paid.updatedAt = record.paidAt;
      await savePaid(paid);

      // Confirm cursor past this nonce
      const st = await loadNonceState(fromAddr);
      st.lastUsedNonce = nonceNum;
      st.nextNonce = Math.max(Number(st.nextNonce || 0), nonceNum + 1);
      st.lastTicketId = ticketId;
      await saveNonceState(st);

      return { ok: true, alreadyPaid: false, ...record };
    }

    lastErr = sub.error || 'submitTransaction failed';
    if (isDuplicateNonceError(lastErr)) {
      // loop continues with bumpNonceAfterCollision
      continue;
    }
    throw new Error(lastErr);
  }

  throw new Error(
    `submitTransaction failed after ${MAX_NONCE_RETRIES} nonce attempts: ${lastErr}`,
  );
}

export async function getPoolHotPublic() {
  try {
    const hot = await loadPoolHotKey();
    let nonceState = null;
    try {
      nonceState = await loadNonceState(hot.address);
    } catch {
      /* */
    }
    return {
      poolId: hot.poolId,
      address: hot.address,
      custody: 'hot-wallet-lab',
      node: NODE_URL,
      nonce: nonceState
        ? {
            nextNonce: nonceState.nextNonce,
            lastUsedNonce: nonceState.lastUsedNonce,
            updatedAt: nonceState.updatedAt,
          }
        : null,
    };
  } catch (e) {
    return { error: e.message };
  }
}

/** Ops/debug: recompute nonce cursor from chain history + paid store. */
export async function resyncPoolHotNonce() {
  const hot = await loadPoolHotKey();
  const { WarthogApi } = await import('warthog-js');
  const chain = await discoverChainMaxNonce(WarthogApi, hot.address);
  const local = await loadNonceState(hot.address);
  const floor = Math.max(
    chain.max != null ? chain.max : -1,
    local.lastUsedNonce != null ? local.lastUsedNonce : -1,
  );
  local.lastUsedNonce = floor >= 0 ? floor : null;
  local.nextNonce = floor + 1;
  await saveNonceState(local);
  return {
    ok: true,
    address: hot.address,
    chainMax: chain.max,
    chainSource: chain.source,
    nextNonce: local.nextNonce,
    lastUsedNonce: local.lastUsedNonce,
  };
}
