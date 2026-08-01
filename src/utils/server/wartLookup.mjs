/**
 * Host-side Warthog tx verify (Phase 1 trust bump; Phase 3 replaces with SPV).
 */
const DEFAULT_NODE =
  process.env.WARTHOG_NODE_URL ||
  process.env.POOL_WART_NODE ||
  'http://127.0.0.1:3000';

export async function lookupWartTx(txHash, { nodeUrl = DEFAULT_NODE } = {}) {
  const h = String(txHash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!h) throw new Error('txHash required');
  const base = String(nodeUrl).replace(/\/$/, '');
  const res = await fetch(`${base}/transaction/lookup/${h}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Warthog lookup HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== 0 && body.code != null) {
    throw new Error(body.error || `Warthog lookup code ${body.code}`);
  }
  return body.data || body;
}

/** Flatten v0.10+ lookup to deposit fields. */
export function flattenWartLookup(data) {
  if (!data) return null;
  const t = data.transaction || data;
  const nested = t.data || {};
  const common = t.signedCommon || t.signingData || {};
  const amountObj = nested.amount || {};
  const amountE8 = Number(
    amountObj.E8 ?? amountObj.u64 ?? nested.amountE8 ?? t.amountE8 ?? 0,
  );
  const toAddress = String(nested.toAddress || t.toAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const fromAddress = String(
    common.originAddress || nested.fromAddress || t.fromAddress || '',
  )
    .replace(/^0x/i, '')
    .toLowerCase();
  const txHash = String(t.hash || t.txHash || data.hash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  return {
    txHash,
    fromAddress,
    toAddress,
    amountE8,
    blockHeight: data.mined?.block?.height ?? t.blockHeight ?? null,
    confirmations: Number(data.confirmations ?? t.confirmations ?? 0),
    mined: data.mined || null,
    raw: data,
  };
}

/**
 * Verify lookup is a positive transfer to the fungible pool.
 */
export function assertPoolDepositTx(flat, poolAddress) {
  const pool = String(poolAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!flat?.txHash) throw new Error('invalid lookup: no txHash');
  if (!flat.toAddress || flat.toAddress !== pool) {
    throw new Error(
      `tx to=${flat.toAddress?.slice?.(0, 12) || '?'}… is not pool ${pool.slice(0, 12)}…`,
    );
  }
  if (!(flat.amountE8 > 0)) throw new Error('tx amount must be > 0');
  return true;
}

export async function verifyPoolDepositTx(txHash, poolAddress, opts) {
  const data = await lookupWartTx(txHash, opts);
  const flat = flattenWartLookup(data);
  assertPoolDepositTx(flat, poolAddress);
  return flat;
}
