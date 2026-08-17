/**
 * Shared Path A bind message. Warthog key + L1 key both sign this
 * before any deposit credit can attach a WART address to an ETH owner.
 */
export function normWartAddr(a) {
  return String(a || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

export function normL1Addr(a) {
  let s = String(a || '').toLowerCase();
  if (s && !s.startsWith('0x')) s = `0x${s}`;
  return s;
}

export function buildPoolBindMessage({ fromAddress, owner, issuedAt }) {
  const wart = normWartAddr(fromAddress);
  const own = normL1Addr(owner);
  const ts = Math.floor(Number(issuedAt));
  if (!wart || wart.length < 40) throw new Error('fromAddress required');
  if (!own || own.length !== 42) throw new Error('owner L1 address required');
  if (!Number.isFinite(ts) || ts <= 0) throw new Error('issuedAt required');
  return [
    'cartesi-pool-bind-v1',
    `wart:${wart}`,
    `owner:${own}`,
    `issuedAt:${ts}`,
  ].join('\n');
}
