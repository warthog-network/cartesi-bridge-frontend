/**
 * Shamir secret sharing over secp256k1 scalar field (curve order n).
 * Lab Path A3 — pool threshold  t-of-n  (default 3-of-4).
 *
 * Pure ESM + bigint. No network.
 */
import { randomBytes } from 'node:crypto';

export const SECP256K1_N = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
);

export function modN(a, n = SECP256K1_N) {
  let x = a % n;
  if (x < 0n) x += n;
  return x;
}

export function invMod(a, n = SECP256K1_N) {
  // Fermat: a^(n-2) mod n for prime n
  let base = modN(a, n);
  if (base === 0n) throw new Error('invMod of 0');
  let exp = n - 2n;
  let res = 1n;
  while (exp > 0n) {
    if (exp & 1n) res = modN(res * base, n);
    base = modN(base * base, n);
    exp >>= 1n;
  }
  return res;
}

export function hexToScalar(hex) {
  const h = String(hex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]+$/.test(h) || h.length === 0 || h.length > 64) {
    throw new Error('invalid scalar hex');
  }
  const x = modN(BigInt('0x' + h));
  if (x === 0n) throw new Error('zero scalar');
  return x;
}

export function scalarToHex(x) {
  return modN(x).toString(16).padStart(64, '0');
}

function randomScalar(n = SECP256K1_N) {
  for (let i = 0; i < 32; i++) {
    const bytes = randomBytes(40);
    let x = 0n;
    for (const b of bytes) x = (x << 8n) | BigInt(b);
    x = modN(x, n);
    if (x > 0n) return x;
  }
  throw new Error('randomScalar failed');
}

/**
 * Split secret into n shares, threshold t.
 * @param {bigint|string} secret - private key scalar
 * @param {{ t?: number, n?: number }} opts
 * @returns {{ index: number, y: bigint, yHex: string }[]}
 */
export function splitSecret(secret, opts = {}) {
  const t = Number(opts.t ?? 3);
  const n = Number(opts.n ?? 4);
  if (!(t >= 2 && n >= t && n <= 32)) {
    throw new Error(`bad t/n: t=${t} n=${n}`);
  }
  const s = typeof secret === 'bigint' ? modN(secret) : hexToScalar(secret);
  if (s === 0n) throw new Error('zero secret');

  // f(x) = s + a1 x + … + a_{t-1} x^{t-1}
  const coeffs = [s];
  for (let i = 1; i < t; i++) {
    coeffs.push(randomScalar());
  }

  const shares = [];
  for (let i = 1; i <= n; i++) {
    const x = BigInt(i);
    let y = 0n;
    let xp = 1n;
    for (let k = 0; k < coeffs.length; k++) {
      y = modN(y + coeffs[k] * xp);
      xp = modN(xp * x);
    }
    shares.push({ index: i, y, yHex: scalarToHex(y) });
  }
  return shares;
}

/**
 * Lagrange interpolate f(0) from t shares.
 * @param {{ index: number, y: bigint|string }[]} points
 */
export function combineShares(points, opts = {}) {
  const t = Number(opts.t ?? points.length);
  if (!Array.isArray(points) || points.length < t) {
    throw new Error(`need ≥${t} shares, got ${points?.length || 0}`);
  }
  const pts = points.slice(0, t).map((p) => ({
    x: BigInt(p.index),
    y: typeof p.y === 'bigint' ? modN(p.y) : hexToScalar(p.yHex || p.y),
  }));

  let secret = 0n;
  for (let i = 0; i < pts.length; i++) {
    const { x: xi, y: yi } = pts[i];
    let num = 1n;
    let den = 1n;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const xj = pts[j].x;
      num = modN(num * (0n - xj)); // -xj
      den = modN(den * (xi - xj));
    }
    const li = modN(num * invMod(den));
    secret = modN(secret + yi * li);
  }
  if (secret === 0n) throw new Error('reconstructed zero secret');
  return secret;
}

export function combineSharesHex(points, opts) {
  return scalarToHex(combineShares(points, opts));
}
