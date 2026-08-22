/**
 * Build / submit a Warthog transfer signed by 3P-ECDSA (no private key on server).
 */
import { readFileSync } from 'node:fs';
import { buildWartTransferHash } from '../twoPartyEcdsa.js';
import { serializeTransaction } from '../warthogTx.js';

function env(key, fallback = '') {
  const e = globalThis.process?.env || {};
  const v = e[key];
  return v == null || v === '' ? fallback : String(v);
}

const NODE_URL =
  env('WARTHOG_RPC') || env('FUNGIBLE_POOL_NODE') || 'http://127.0.0.1:3001';

const NONCE_PATH =
  env('POOL_3P_NONCE') ||
  '/opt/cartesi-bridge/cartesi-bridge-frontend/.data/pool-3p-nonce.json';

async function readNonceFile() {
  try {
    const { readFileSync } = await import('node:fs');
    return JSON.parse(readFileSync(NONCE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function writeNonceFile(j) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(NONCE_PATH), { recursive: true });
  await writeFile(NONCE_PATH, JSON.stringify(j, null, 2));
}

async function nextOutgoingNonce(from) {
  const addr = String(from).replace(/^0x/i, '').toLowerCase();
  let n = 0;
  const file = await readNonceFile();
  if (file[addr] != null && Number.isFinite(Number(file[addr]))) {
    n = Number(file[addr]) + 1;
  }
  try {
    const memRes = await fetch(`${NODE_URL.replace(/\/$/, '')}/transaction/mempool`);
    const mem = memRes.ok ? await memRes.json() : null;
    const list = Array.isArray(mem?.data) ? mem.data : [];
    const mine = list.filter((tx) => {
      const o = String(tx?.signedCommon?.originAddress || tx?.fromAddress || '')
        .replace(/^0x/i, '')
        .toLowerCase();
      return o === addr;
    });
    if (mine.length) {
      const m =
        Math.max(
          ...mine.map((tx) => Number(tx?.signedCommon?.nonceId ?? tx?.nonceId ?? -1)),
        ) + 1;
      if (m > n) n = m;
    }
  } catch {
    /* */
  }
  return n;
}

/** True if this nonce was already broadcast from `from` (prep must be rebuilt). */
export function nonceAlreadyUsed(fromAddress, nonceId) {
  const addr = String(fromAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const n = Number(nonceId);
  if (!addr || !Number.isFinite(n)) return false;
  try {
    const file = JSON.parse(readFileSync(NONCE_PATH, 'utf8'));
    const last = Number(file[addr]);
    return Number.isFinite(last) && n <= last;
  } catch {
    return false;
  }
}

export async function recordOutgoingNonce(from, nonceId) {
  const addr = String(from).replace(/^0x/i, '').toLowerCase();
  const file = await readNonceFile();
  const prev = Number(file[addr]);
  const next = Number(nonceId);
  if (!Number.isFinite(next)) return;
  if (!Number.isFinite(prev) || next > prev) {
    file[addr] = next;
    await writeNonceFile(file);
  }
}

async function loadWjs() {
  return import('warthog-js');
}

export async function preparePool3pTransfer({
  fromAddress,
  toAddress,
  amountE8,
  nonceId: nonceOverride,
}) {
  const { WarthogApi, Address, normalizeChainPin } = await loadWjs();
  const api = new WarthogApi(NODE_URL);
  let toNorm = String(toAddress).replace(/^0x/i, '').toLowerCase();
  if (toNorm.length === 40) {
    const expanded = Address.fromRaw(toNorm);
    if (!expanded) throw new Error('invalid toAddress');
    toNorm = expanded.hex;
  }
  const from = String(fromAddress).replace(/^0x/i, '').toLowerCase();
  if (from && toNorm && from === toNorm) {
    throw new Error('Self send transaction not allowed');
  }
  const amt = BigInt(amountE8);

  const balRes = await api.getAccountWartBalance(from);
  if (!balRes.success) throw new Error(balRes.error || '3P pool balance failed');
  const wart = balRes.data?.wart || balRes.data;
  const total = BigInt(wart.total?.E8 ?? 0);
  const locked = BigInt(wart.locked?.E8 ?? 0);
  const mempool = BigInt(wart.mempool?.E8 ?? 0);
  const spendable = total - locked - mempool;

  const feeRes = await api.getMinFee();
  if (!feeRes.success) throw new Error(feeRes.error || 'min fee failed');
  const feeE8 = BigInt(feeRes.data.minFee.E8);
  if (spendable < amt + feeE8) {
    throw new Error(
      `3P pool spendable ${spendable} < amount+fee ${amt + feeE8}`,
    );
  }

  const head = await api.getChainHead();
  if (!head.success) throw new Error(head.error || 'chain head failed');
  const { pinHash, pinHeight } = normalizeChainPin(head.data);

  // Outgoing nonce. Do not use account history (incoming txs + this node
  // crashes on /account/{addr}/history). Persist last paid nonce on disk.
  let nonceId = 0;
  if (nonceOverride != null && Number.isFinite(Number(nonceOverride))) {
    nonceId = Number(nonceOverride);
  } else {
    nonceId = await nextOutgoingNonce(from);
  }

  const hashHex = buildWartTransferHash({
    pinHash,
    pinHeight,
    nonceId,
    feeE8,
    toAddrHex: toNorm,
    wartE8: amt,
  });

  return {
    ok: true,
    fromAddress: from,
    toAddress: toNorm,
    amountE8: amt.toString(),
    feeE8: feeE8.toString(),
    pinHash: String(pinHash).replace(/^0x/i, ''),
    pinHeight: Number(pinHeight),
    nonceId,
    hashHex,
    node: NODE_URL,
  };
}

export async function submitPool3pTransfer({
  fromAddress,
  toAddress,
  amountE8,
  feeE8,
  pinHash,
  pinHeight,
  nonceId,
  signature65,
}) {
  const { WarthogApi } = await loadWjs();
  const api = new WarthogApi(NODE_URL);
  const sig = String(signature65 || '').replace(/^0x/i, '').toLowerCase();
  if (sig.length !== 130) throw new Error('signature65 must be 130 hex chars');
  const tx = serializeTransaction({
    type: 'wartTransfer',
    pinHeight: Number(pinHeight),
    nonceId: Number(nonceId),
    feeE8: Number(feeE8),
    toAddr: String(toAddress).replace(/^0x/i, '').toLowerCase(),
    wartE8: Number(amountE8),
    signature65: sig,
  });
  const sub = await api.submitTransaction(tx);
  if (!sub.success) throw new Error(sub.error || '3P submit rejected');
  await recordOutgoingNonce(fromAddress, nonceId);
  return {
    ok: true,
    txHash: sub.data?.txHash || sub.data?.hash || null,
    fromAddress,
    toAddress,
    amountE8: String(amountE8),
    nonceId: Number(nonceId),
  };
}
