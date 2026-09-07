/**
 * 2-party ECDSA (Lindell-style) — full private key never assembled.
 *
 * Aggregate pubkey Q = d_user·G + d_dapp·G (additive shares). Cosigner stores
 * d_dapp + Enc(d_user) only. Sign is interactive Lindell; output (r,s,recid)
 * under Q. Full scalar d is never formed after keygen (and not at keygen either).
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { generateRandomKeys, PublicKey, PrivateKey } from 'paillier-bigint';
import {
  sha256,
  ripemd160,
  getBytes,
  hexlify,
  concat,
  toUtf8Bytes,
  computeAddress,
  SigningKey,
} from 'ethers-v6';
import CryptoJS from 'crypto-js';
import {
  proveSignC,
  verifySignC,
  sampleSignRho,
  randomCoprimeTo,
  invModQ,
} from './lindellZk.js';
import {
  downloadTextFile,
  promptDownloadFilename,
  sanitizeDownloadFilename,
} from './downloadFile.js';

export const MULTISIG_SCHEME = 'wart-2p-ecdsa-lindell-v1';
/** Same 2P-ECDSA keygen; address is Ethereum (keccak) not Warthog. */
export const MULTISIG_SCHEME_ETH = 'eth-2p-ecdsa-lindell-v1';

export const CURVE_N = secp256k1.CURVE.n;
const G = secp256k1.ProjectivePoint.BASE;

/** @deprecated XOR stream prefix — still decryptable for migration */
const ENC_PREFIX_XOR_V1 = 'cartesi-bridge-2p-ecdsa-enc-v1';
/** AES-256-GCM + PBKDF2 (v2) blob prefix */
const ENC_PREFIX_AES_V2 = 'cartesi-bridge-2p-aesgcm-v2:';
const USER_STORE_PREFIX = 'cartesi-bridge-msig2p-user-v1:';
/** Default Paillier modulus bits. Floor is 2048 — 1024 is refused at keygen/birth/rekey. */
export const DEFAULT_PAILLIER_BITS = 2048;
export const MIN_PAILLIER_BITS = 2048;
/**
 * Lindell'17 samples ρ ← Z_q² (~512 bits) and adds Enc(ρ·q).
 * 32-byte ρ was not paper-faithful. High bit set so the client can reject a
 * missing/tiny pad. This is statistical hiding of x2 from P1, NOT a
 * well-formedness proof of c. Phase 0/1 ≠ malicious Lindell.
 */
export const LINDELL_RHO_BITS = 512;
const PBKDF2_ITERS = 120_000;

export function modN(a) {
  let x = a % CURVE_N;
  if (x < 0n) x += CURVE_N;
  return x;
}

function modPow(base, exp, mod) {
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  let r = 1n;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

export function invScalar(a) {
  return modPow(modN(a), CURVE_N - 2n, CURVE_N);
}

export function randomScalar() {
  for (let i = 0; i < 32; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(48));
    let x = 0n;
    for (const b of bytes) x = (x << 8n) | BigInt(b);
    x = modN(x);
    if (x > 0n) return x;
  }
  throw new Error('scalar sample failed');
}

export function hexToScalar(hex) {
  const h = String(hex ?? '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]+$/.test(h)) {
    throw new Error(`bad hex scalar (${String(hex).slice(0, 18) || 'empty'})`);
  }
  const x = modN(BigInt('0x' + h));
  if (x === 0n) throw new Error('zero scalar');
  return x;
}

export function scalarToHex(s) {
  return modN(s).toString(16).padStart(64, '0');
}

function pointToCompressedHex(P) {
  return Buffer.from(P.toRawBytes(true)).toString('hex');
}

function pointFromCompressedHex(hex) {
  return secp256k1.ProjectivePoint.fromHex(
    String(hex).replace(/^0x/i, ''),
  );
}

export function addressFromPubCompressedHex(pubHex) {
  const compressed = getBytes('0x' + String(pubHex).replace(/^0x/i, ''));
  const sha = getBytes(sha256(compressed));
  const ripe = getBytes(ripemd160(sha));
  const checksum = getBytes(sha256(ripe)).slice(0, 4);
  return hexlify(concat([ripe, checksum])).slice(2);
}

/**
 * Ethereum address from compressed secp256k1 pubkey (same Q as Warthog 2P vault).
 * @returns {string} 0x-prefixed checksummed or lowercase address
 */
export function ethAddressFromPubCompressedHex(pubHex) {
  const compressed = '0x' + String(pubHex).replace(/^0x/i, '');
  // ethers accepts compressed pubkey for computeAddress via SigningKey
  const uncompressed = SigningKey.computePublicKey(compressed, false);
  return computeAddress(uncompressed);
}

function hashToScalar(hashHex) {
  return modN(BigInt('0x' + String(hashHex).replace(/^0x/i, '')));
}

export function paillierBitLength(nStr) {
  const n = BigInt(nStr);
  if (n <= 0n) return 0;
  return n.toString(2).length;
}

/** Refuse <2048-bit N at keygen / birth / rekey. */
export function assertPaillierModulus(
  nStr,
  { minBits = MIN_PAILLIER_BITS, what = 'Paillier N' } = {},
) {
  const bits = paillierBitLength(nStr);
  if (bits < minBits) {
    throw new Error(
      `${what} is ${bits}-bit; floor is ${minBits} (1024-bit Enc(d1) is a d1 leak if N factors)`,
    );
  }
  return bits;
}

export function seatPokContext(kind, role, Phex) {
  return [
    'wart-3p-seat',
    String(kind || ''),
    String(Number(role || 0)),
    String(Phex || '')
      .replace(/^0x/i, '')
      .toLowerCase(),
  ].join('|');
}

function schnorrChallengeScalar(Phex, Rhex, context) {
  const msg = [
    'wart-3p-schnorr-v1',
    String(context || ''),
    String(Phex || '').replace(/^0x/i, '').toLowerCase(),
    String(Rhex || '').replace(/^0x/i, '').toLowerCase(),
  ].join('|');
  return hashToScalar(String(sha256(toUtf8Bytes(msg))).replace(/^0x/i, ''));
}

/**
 * Schnorr PoK of dlog(P). Does NOT prove Enc(d) encrypts that dlog.
 * Birth still needs a range/DL proof on the ciphertext for Lindell keygen.
 */
export function schnorrProveDlog(shareHex, context) {
  const d = hexToScalar(shareHex);
  const P = G.multiply(d);
  const Phex = pointToCompressedHex(P);
  let k;
  let Rhex;
  let e;
  for (let i = 0; i < 8; i++) {
    k = randomScalar();
    Rhex = pointToCompressedHex(G.multiply(k));
    e = schnorrChallengeScalar(Phex, Rhex, context);
    if (e !== 0n) break;
  }
  if (!e) throw new Error('schnorr challenge was 0');
  return {
    P: Phex,
    R: Rhex,
    s: scalarToHex(modN(k + e * d)),
    context: String(context || ''),
  };
}

export function schnorrVerifyDlog(pok, expectedP, context) {
  if (!pok?.R || !pok?.s) throw new Error('SCHNORR_MISSING: need {R,s} PoK of dlog(P)');
  const ctx = String(context || pok.context || '');
  const Phex = String(expectedP || pok.P || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{66}$/.test(Phex)) throw new Error('SCHNORR_BAD_P');
  const P = pointFromCompressedHex(Phex);
  const R = pointFromCompressedHex(pok.R);
  const s = hexToScalar(pok.s);
  const e = schnorrChallengeScalar(Phex, String(pok.R).replace(/^0x/i, ''), ctx);
  const left = G.multiply(s);
  const right = R.add(P.multiply(e));
  if (pointToCompressedHex(left) !== pointToCompressedHex(right)) {
    throw new Error('SCHNORR_BAD: sG ≠ R + eP — not the dlog of P');
  }
  return { ok: true, P: Phex, context: ctx };
}

function normPubHex(hex) {
  return String(hex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

function schnorrChallengeOnBase(statementHex, commitHex, baseHex, context) {
  const msg = [
    'wart-3p-schnorr-base-v1',
    String(context || ''),
    normPubHex(baseHex),
    normPubHex(statementHex),
    normPubHex(commitHex),
  ].join('|');
  return hashToScalar(String(sha256(toUtf8Bytes(msg))).replace(/^0x/i, ''));
}

/**
 * Schnorr PoK of dlog_Base(Statement) = witness. Seat PoK stays on G
 * (wart-3p-schnorr-v1). This domain is for R = k2·R1.
 */
export function schnorrProveDlogOnBase(witnessHex, baseHex, context) {
  const w = hexToScalar(witnessHex);
  const Base = pointFromCompressedHex(baseHex);
  const statementHex = pointToCompressedHex(Base.multiply(w));
  const baseN = normPubHex(baseHex);
  let k;
  let commitHex;
  let e;
  for (let i = 0; i < 8; i++) {
    k = randomScalar();
    commitHex = pointToCompressedHex(Base.multiply(k));
    e = schnorrChallengeOnBase(statementHex, commitHex, baseN, context);
    if (e !== 0n) break;
  }
  if (!e) throw new Error('schnorr-on-base challenge was 0');
  return {
    P: statementHex,
    R: commitHex,
    s: scalarToHex(modN(k + e * w)),
    base: baseN,
    context: String(context || ''),
  };
}

export function schnorrVerifyDlogOnBase(pok, expectedStatement, baseHex, context) {
  if (!pok?.R || !pok?.s) {
    throw new Error('LINDELL_R_POK_MISSING: need {R,s} PoK of dlog_{R1}(R)');
  }
  const ctx = String(context || pok.context || '');
  const statementHex = normPubHex(expectedStatement || pok.P);
  const baseN = normPubHex(baseHex || pok.base);
  if (!/^[0-9a-f]{66}$/.test(statementHex) || !/^[0-9a-f]{66}$/.test(baseN)) {
    throw new Error('LINDELL_R_POK: bad R or R1');
  }
  const Base = pointFromCompressedHex(baseN);
  const Statement = pointFromCompressedHex(statementHex);
  const T = pointFromCompressedHex(pok.R);
  const s = hexToScalar(pok.s);
  const e = schnorrChallengeOnBase(statementHex, normPubHex(pok.R), baseN, ctx);
  const left = Base.multiply(s);
  const right = T.add(Statement.multiply(e));
  if (pointToCompressedHex(left) !== pointToCompressedHex(right)) {
    throw new Error('LINDELL_R_POK: s·R1 ≠ T + e·R — coordinator does not know k2');
  }
  return { ok: true, P: statementHex, base: baseN, context: ctx };
}

/** Fiat-Shamir bind for R = k2·R1. Not a well-formedness proof of c. */
export function lindellRPokContext({ R1Hex, RHex, rHex, hashHex, ciphertext }) {
  const cHash = String(sha256(toUtf8Bytes(String(ciphertext || '')))).replace(/^0x/i, '');
  return [
    'wart-3p-r-eq-k2r1-v1',
    normPubHex(R1Hex),
    normPubHex(RHex),
    String(rHex || '')
      .replace(/^0x/i, '')
      .toLowerCase(),
    String(hashHex || '')
      .replace(/^0x/i, '')
      .toLowerCase(),
    cHash,
  ].join('|');
}

export function proveLindellR({ k2Hex, R1Hex, RHex, rHex, hashHex, ciphertext }) {
  const ctx = lindellRPokContext({ R1Hex, RHex, rHex, hashHex, ciphertext });
  const pok = schnorrProveDlogOnBase(k2Hex, R1Hex, ctx);
  if (normPubHex(pok.P) !== normPubHex(RHex)) {
    throw new Error('LINDELL_R_POK: k2·R1 ≠ R');
  }
  return pok;
}

/**
 * d1 checks: R1 = k1·G, r = Rx(R), and coordinator knows k2 with R = k2·R1.
 * Does not prove c is the Lindell tuple for (R1, z, k2).
 */
export function verifyLindellR({ pok, k1Hex, R1Hex, RHex, rHex, hashHex, ciphertext }) {
  if (!pok?.R || !pok?.s) {
    throw new Error('LINDELL_R_POK_MISSING: need Schnorr that R = k2·R1');
  }
  if (!RHex) throw new Error('LINDELL_R_POK_MISSING: need RHex');
  const k1 = hexToScalar(k1Hex);
  const R1got = pointToCompressedHex(G.multiply(k1));
  const R1n = normPubHex(R1Hex || R1got);
  if (normPubHex(R1got) !== R1n) {
    throw new Error('LINDELL_R_POK: R1 ≠ k1·G');
  }
  const R = pointFromCompressedHex(RHex);
  if (modN(R.toAffine().x) !== hexToScalar(rHex)) {
    throw new Error('LINDELL_R_POK: r ≠ Rx(R) mod n');
  }
  const ctx = lindellRPokContext({
    R1Hex: R1n,
    RHex,
    rHex,
    hashHex,
    ciphertext,
  });
  schnorrVerifyDlogOnBase(pok, RHex, R1n, ctx);
  return true;
}

/**
 * Honest Dec(c) = k2^{-1}z + k2^{-1} r x2 + x1·k2^{-1} r + ρ·n
 * with ρ ∈ [2^{511}, 2^{512}). Missing pad ⇒ pt ≈ O(n²) and fails the floor.
 */
export function lindellPlaintextBounds(paillierN) {
  const n = CURVE_N;
  const N = BigInt(paillierN);
  const rhoMin = 1n << BigInt(LINDELL_RHO_BITS - 1);
  const rhoMax = (1n << BigInt(LINDELL_RHO_BITS)) - 1n;
  const lo = rhoMin * n;
  const hi = rhoMax * n + 2n * n * n + 2n * n;
  if (lo >= N) {
    throw new Error('Paillier N too small for 512-bit Lindell ρ');
  }
  return { lo, hi: hi < N ? hi : N - 1n };
}

export function assertLindellPlaintextRange(pt, paillierN) {
  const { lo, hi } = lindellPlaintextBounds(paillierN);
  if (pt < lo || pt > hi) {
    throw new Error(
      'LINDELL_RANGE: Dec(c) not in the 512-bit ρ window — refusing s (missing pad or malformed c)',
    );
  }
  return true;
}


/**
 * Path B (2P-ECDSA personal vaults) was removed 2026-09-05. The vault keygen,
 * mnemonic-encrypted client-share storage and vault-share backup/restore block
 * that lived here is gone; what remains is the Lindell signing core shared by the
 * Path A4 fungible pool (utils/server/pool3p*.mjs, poolEth3p.mjs).
 */

function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/i, '');
  if (h.length % 2) throw new Error('odd hex length');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function clientSignRound1() {
  const k1 = randomScalar();
  return {
    k1Hex: scalarToHex(k1),
    R1Hex: pointToCompressedHex(G.multiply(k1)),
  };
}

/** ρ ← {2^{511} … 2^{512}-1} so Dec(c) sits in a checkable window. Not a proof of c. */
export function sampleLindellRho(paillierN) {
  const N = BigInt(paillierN);
  const bytes = crypto.getRandomValues(new Uint8Array(LINDELL_RHO_BITS / 8));
  bytes[0] |= 0x80; // force ≥ 2^{511}
  let rho = 0n;
  for (const b of bytes) rho = (rho << 8n) | BigInt(b);
  const pad = rho * CURVE_N;
  if (pad >= N) {
    throw new Error('Lindell ρ·n ≥ Paillier N — need ≥2048-bit N');
  }
  return rho;
}

/**
 * Cosigner: R = k2·R1, build Lindell ciphertext for client.
 * Phase 6: Coinbase integer-commit ZK that c is the Lindell tuple, plus R = k2·R1.
 *
 * x2 is the coordinator share (d_dapp, plus d2 if folded into the scalar).
 * ckey encrypts the dealer share only (d1). Q2Hex = x2·G (Pdapp, or P2+Pdapp).
 */
export function cosignerSignStep({
  R1Hex,
  hashHex,
  dappShareHex,
  d2Hex,
  encD2Str,
  ckeyStr,
  paillierN,
  paillierG,
  Q2Hex,
  sid,
}) {
  const k2 = randomScalar();
  const R1 = pointFromCompressedHex(R1Hex);
  const R = R1.multiply(k2);
  const r = modN(R.toAffine().x);
  if (r === 0n) throw new Error('bad r — retry');

  const z = hashToScalar(hashHex);
  let x2 = hexToScalar(dappShareHex);
  if (d2Hex && !encD2Str) x2 = modN(x2 + hexToScalar(d2Hex));
  const k2inv = invModQ(k2);

  const pub = new PublicKey(BigInt(paillierN), BigInt(paillierG));
  const slack = CURVE_N << 80n;
  let ckeyAdj = pub.plaintextAddition(BigInt(ckeyStr), slack);
  if (encD2Str) {
    ckeyAdj = pub.addition(ckeyAdj, BigInt(String(encD2Str)));
  }
  const w2 = modN(k2inv * x2);
  const rho = sampleSignRho();
  const rc = randomCoprimeTo(pub.n);
  const temp = k2inv * z + w2 * r + rho * CURVE_N;
  const exp = k2inv * r;
  const c = pub.addition(pub.multiply(ckeyAdj, exp), pub.encrypt(temp, rc));

  const rHex = scalarToHex(r);
  const RHex = pointToCompressedHex(R);
  const R2Hex = pointToCompressedHex(G.multiply(k2));
  const ciphertext = c.toString();
  const pokR = proveLindellR({
    k2Hex: scalarToHex(k2),
    R1Hex,
    RHex,
    rHex,
    hashHex,
    ciphertext,
  });
  if (!Q2Hex) {
    throw new Error('Q2Hex required — x2·G (Pdapp or P2+Pdapp) for the c-wellformedness proof');
  }
  const pokC = proveSignC({
    paillierN,
    paillierG,
    ckey: ckeyAdj.toString(),
    c: ciphertext,
    Q2Hex,
    R2Hex,
    m: z,
    r,
    k2,
    x2,
    rho,
    rc,
    sid: sid || hashHex,
    aux: 0,
  });

  return {
    rHex,
    ciphertext,
    RHex,
    R2Hex,
    Q2Hex: String(Q2Hex).replace(/^0x/i, '').toLowerCase(),
    ckeyAdj: ckeyAdj.toString(),
    pokR,
    pokC,
  };
}

/**
 * Client finishes s = k1^{-1} * (Dec(c) mod n); returns Warthog signature65.
 * Never sees d_dapp. Requires pokR (R = k2·R1) before decrypt.
 */
export function clientSignFinish({
  k1Hex,
  rHex,
  ciphertext,
  hashHex,
  clientSecret,
  RHex,
  R1Hex,
  pokR,
  pokC,
  R2Hex,
  Q2Hex,
  ckeyAdj,
  sid,
}) {
  verifyLindellR({
    pok: pokR,
    k1Hex,
    R1Hex,
    RHex,
    rHex,
    hashHex,
    ciphertext,
  });
  const z = hashToScalar(hashHex);
  if (!Q2Hex || !R2Hex || ckeyAdj == null) {
    throw new Error('LINDELL_C_ZK_MISSING: need Q2Hex, R2Hex, and ckeyAdj');
  }
  verifySignC({
    paillierN: clientSecret.paillierN,
    paillierG: clientSecret.paillierG,
    ckey: String(ckeyAdj),
    c: ciphertext,
    Q2Hex,
    R2Hex,
    m: z,
    r: hexToScalar(rHex),
    pokC,
    sid: sid || hashHex,
    aux: 0,
  });
  const k1 = hexToScalar(k1Hex);
  const r = hexToScalar(rHex);

  const pub = new PublicKey(
    BigInt(clientSecret.paillierN),
    BigInt(clientSecret.paillierG),
  );
  const sk = new PrivateKey(
    BigInt(clientSecret.paillierLambda),
    BigInt(clientSecret.paillierMu),
    pub,
  );

  const pt = sk.decrypt(BigInt(ciphertext));
  const sPartial = modN(pt);
  let s = modN(invScalar(k1) * sPartial);
  if (s > CURVE_N / 2n) s = CURVE_N - s;

  const rPad = scalarToHex(r);
  const sPad = scalarToHex(s);
  const msg = getBytes('0x' + String(hashHex).replace(/^0x/i, ''));
  const expectPub = String(clientSecret.publicKey).replace(/^0x/i, '').toLowerCase();

  let recid = null;
  for (let rec = 0; rec < 4; rec++) {
    try {
      const sig = new secp256k1.Signature(r, s).addRecoveryBit(rec);
      const recPub = Buffer.from(sig.recoverPublicKey(msg).toRawBytes(true))
        .toString('hex')
        .toLowerCase();
      if (recPub === expectPub) {
        recid = rec;
        break;
      }
    } catch {
      /* continue */
    }
  }
  if (recid == null) {
    throw new Error(
      '2P-ECDSA recovery failed — signature does not match vault public key (check transfer hash layout)',
    );
  }

  return {
    r: rPad,
    s: sPad,
    recid,
    signature65: rPad + sPad + recid.toString(16).padStart(2, '0'),
  };
}

function u32be(n) {
  const b = new Uint8Array(4);
  const v = Number(n) >>> 0;
  b[0] = (v >>> 24) & 0xff;
  b[1] = (v >>> 16) & 0xff;
  b[2] = (v >>> 8) & 0xff;
  b[3] = v & 0xff;
  return b;
}

function u64be(n) {
  const b = new Uint8Array(8);
  let x = BigInt(n);
  for (let i = 7; i >= 0; i--) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}

function concatBytes(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Warthog wartTransfer preimage hash (same layout as warthog-js TransactionContext).
 *
 * Important: addressToBytes in warthog-js only hashes the first 20 bytes
 * (40 hex account id) — NOT the 4-byte checksum. Using 24 bytes here made the
 * node recover a garbage from-address → "Address not found".
 */
export function buildWartTransferHash({
  pinHash,
  pinHeight,
  nonceId,
  feeE8,
  toAddrHex,
  wartE8,
}) {
  const pin = hexToBytes(String(pinHash).replace(/^0x/i, ''));
  if (pin.length !== 32) throw new Error('pinHash must be 32 bytes hex');

  const toRaw = String(toAddrHex).replace(/^0x/i, '').toLowerCase();
  // Match warthog-js: Buffer.from(address.slice(0, 40), 'hex') → 20 bytes
  if (toRaw.length !== 40 && toRaw.length !== 48) {
    throw new Error('toAddr must be 40 or 48 hex chars');
  }
  const to = hexToBytes(toRaw.slice(0, 40));
  if (to.length !== 20) throw new Error('toAddr account id must be 20 bytes');

  const binary = concatBytes(
    pin,
    u32be(pinHeight),
    u32be(nonceId),
    new Uint8Array(3),
    u64be(feeE8),
    to,
    u64be(wartE8),
  );
  return String(sha256(binary)).replace(/^0x/i, '');
}

export function wartToE8(amountStr) {
  const s = String(amountStr || '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Invalid WART amount');
  const [w, f = ''] = s.split('.');
  const frac = (f + '00000000').slice(0, 8);
  return (BigInt(w || '0') * 100000000n + BigInt(frac || '0')).toString();
}
