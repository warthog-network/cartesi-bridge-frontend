/**
 * Path A hot-wallet payout — send real WART from fungible pool address.
 * Does not touch cosigner threshold shares.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const HOT_KEY_PATH =
  process.env.FUNGIBLE_POOL_HOT_KEY ||
  '/opt/cartesi-bridge/cartesi-bridge-frontend/.data/fungible-pool-hot.json';
const PAID_PATH =
  process.env.FUNGIBLE_POOL_PAID ||
  '/opt/cartesi-bridge/cartesi-bridge-frontend/.data/fungible-pool-paid.json';
const NODE_URL =
  process.env.WARTHOG_RPC ||
  process.env.FUNGIBLE_POOL_NODE ||
  'https://warthog-defitestnet.duckdns.org';

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

function e8ToHuman(e8) {
  const n = BigInt(e8);
  const whole = n / 100000000n;
  let frac = (n % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
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
  if (args.verifiedFromNotice !== true && process.env.POOL_PAYOUT_SKIP_VERIFY !== '1') {
    throw new Error(
      'payoutPoolTicket: verifiedFromNotice required (use /api/pool payout)',
    );
  }

  const paid = await loadPaid();
  // Idempotency: same ticketId + amount + destination already paid.
  // After Anvil restarts, ticket nonces reset (wart-pool-0:1 again) but amounts
  // differ — do not treat a new unlock as the old 5-WART payout.
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
  // Disambiguate colliding ticket ids (post-restart) so we can still record pay.
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
  const toAddr = Address.fromHex(toNorm);
  if (!toAddr) throw new Error('invalid toAddress');

  const api = new WarthogApi(NODE_URL);
  const account = Account.fromPrivateKeyHex(hot.privateKeyHex);
  const fromAddr = String(account.address.hex).toLowerCase();
  if (fromAddr !== hot.address) {
    throw new Error(`hot key address mismatch file=${hot.address} derived=${fromAddr}`);
  }

  // Spendable check (DeFi GET /account/:addr/wart_balance)
  // Shape: { wart: { total:{E8}, locked:{E8}, mempool:{E8} }, account:… }
  // Older clients exposed spendable / balance.E8 — accept both.
  let spendableE8 = null;
  try {
    const balRes = await api.getAccountWartBalance(fromAddr);
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
      // mempool outbound is not spendable for a new transfer
      const mempoolE8 = BigInt(wart.mempool?.E8 ?? d.mempool?.E8 ?? 0);
      spendableE8 = totalE8 - lockedE8 - mempoolE8;
      if (spendableE8 < 0n) spendableE8 = 0n;
    }
  } catch {
    /* continue; node will reject if underfunded */
  }
  if (spendableE8 != null) {
    // need amount + fee roughly
    if (spendableE8 < amountE8) {
      throw new Error(
        `pool spendable ${e8ToHuman(spendableE8)} WART < payout ${e8ToHuman(amountE8)} — fund pool ${fromAddr}`,
      );
    }
  }

  const feeRes = await api.getMinFee();
  if (!feeRes.success) throw new Error(feeRes.error || 'getMinFee failed');
  const fee = RoundedFee.fromE8(BigInt(feeRes.data.minFee.E8), true);
  if (!fee) throw new Error('invalid fee');

  let nonceNum = 0;
  try {
    // Prefer smart path via balance/account endpoints
    const accRes = await api.getNodePath(`account/${fromAddr}`);
    if (accRes.success) {
      nonceNum = Number(
        accRes.data?.nextNonceId ??
          accRes.data?.nonceId ??
          accRes.data?.account?.nonceId ??
          0,
      );
    }
  } catch {
    nonceNum = 0;
  }
  // Also try nonce from wart balance payload
  try {
    const balRes = await api.getAccountWartBalance(fromAddr);
    if (balRes.success && balRes.data?.nonceId != null) {
      nonceNum = Number(balRes.data.nonceId);
    }
  } catch {
    /* keep */
  }
  const nonce = NonceId.fromNumber(nonceNum);
  if (!nonce) throw new Error('invalid nonce');

  const headRes = await api.getChainHead();
  if (!headRes.success) throw new Error(headRes.error || 'chain head failed');
  const { pinHash, pinHeight } = normalizeChainPin(headRes.data);

  const wart = Wart.fromE8(amountE8);
  if (!wart) throw new Error('invalid amount E8');

  const ctx = new TransactionContext(
    { pinHash: String(pinHash).replace(/^0x/i, ''), pinHeight: Number(pinHeight) },
    fee,
    nonce,
  );
  const tx = ctx.transferWart(account, toAddr, wart);
  const body = JSON.parse(
    JSON.stringify(tx, (_, v) => (typeof v === 'bigint' ? Number(v) : v)),
  );

  const sub = await api.submitTransaction(body);
  if (!sub.success) {
    throw new Error(sub.error || 'submitTransaction failed');
  }
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
    paidAt: new Date().toISOString(),
    node: NODE_URL,
  };
  paid.tickets[paidKey] = record;
  paid.updatedAt = record.paidAt;
  await savePaid(paid);
  return { ok: true, alreadyPaid: false, ...record };
}

export async function getPoolHotPublic() {
  try {
    const hot = await loadPoolHotKey();
    return {
      poolId: hot.poolId,
      address: hot.address,
      custody: 'hot-wallet-lab',
      node: NODE_URL,
    };
  } catch (e) {
    return { error: e.message };
  }
}
