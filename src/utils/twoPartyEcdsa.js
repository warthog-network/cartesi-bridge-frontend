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

function getSubtle() {
  const c = globalThis.crypto;
  if (c?.subtle) return c.subtle;
  throw new Error('WebCrypto subtle unavailable — need browser or Node 18+');
}

function bytesToHex(u8) {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/i, '');
  if (h.length % 2) throw new Error('odd hex length');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function deriveAesKeyFromMnemonic(phrase, saltU8) {
  const subtle = getSubtle();
  const base = await subtle.importKey(
    'raw',
    new TextEncoder().encode(phrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltU8,
      iterations: PBKDF2_ITERS,
      hash: 'SHA-256',
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Legacy XOR stream (v1) — migration only */
function encryptJsonXorV1(obj, phrase) {
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(data.length);
  let counter = 0;
  let offset = 0;
  while (offset < data.length) {
    const block = getBytes(
      sha256(toUtf8Bytes(`${ENC_PREFIX_XOR_V1}:${phrase}:${counter}`)),
    );
    for (let i = 0; i < 32 && offset < data.length; i++, offset++) {
      out[offset] = data[offset] ^ block[i];
    }
    counter++;
  }
  return hexlify(out).slice(2);
}

function decryptJsonXorV1(encHex, phrase) {
  const data = getBytes('0x' + String(encHex).replace(/^0x/i, ''));
  const out = new Uint8Array(data.length);
  let counter = 0;
  let offset = 0;
  while (offset < data.length) {
    const block = getBytes(
      sha256(toUtf8Bytes(`${ENC_PREFIX_XOR_V1}:${phrase}:${counter}`)),
    );
    for (let i = 0; i < 32 && offset < data.length; i++, offset++) {
      out[offset] = data[offset] ^ block[i];
    }
    counter++;
  }
  return JSON.parse(new TextDecoder().decode(out));
}

/**
 * Encrypt clientSecret (user half) with mnemonic via AES-256-GCM + PBKDF2.
 * Returns versioned string starting with ENC_PREFIX_AES_V2.
 */
export async function encryptJsonWithMnemonic(obj, mnemonic) {
  const phrase = String(mnemonic || '').trim().replace(/\s+/g, ' ');
  if (!phrase) throw new Error('Mnemonic required');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKeyFromMnemonic(phrase, salt);
  const pt = new TextEncoder().encode(JSON.stringify(obj));
  const ctBuf = await getSubtle().encrypt({ name: 'AES-GCM', iv }, key, pt);
  const ct = new Uint8Array(ctBuf);
  // salt(16) || iv(12) || ciphertext+tag
  const packed = new Uint8Array(16 + 12 + ct.length);
  packed.set(salt, 0);
  packed.set(iv, 16);
  packed.set(ct, 28);
  return ENC_PREFIX_AES_V2 + bytesToHex(packed);
}

/**
 * Decrypt clientSecret. Supports AES-GCM v2 and legacy XOR v1 (auto-migrate path).
 */
export async function decryptJsonWithMnemonic(encHex, mnemonic) {
  const phrase = String(mnemonic || '').trim().replace(/\s+/g, ' ');
  const raw = String(encHex || '');
  if (raw.startsWith(ENC_PREFIX_AES_V2)) {
    const packed = hexToBytes(raw.slice(ENC_PREFIX_AES_V2.length));
    if (packed.length < 16 + 12 + 16) throw new Error('AES-GCM blob too short');
    const salt = packed.subarray(0, 16);
    const iv = packed.subarray(16, 28);
    const ct = packed.subarray(28);
    const key = await deriveAesKeyFromMnemonic(phrase, salt);
    try {
      const ptBuf = await getSubtle().decrypt({ name: 'AES-GCM', iv }, key, ct);
      return JSON.parse(new TextDecoder().decode(ptBuf));
    } catch {
      throw new Error('Cannot decrypt 2P client secret (AES-GCM) — wrong mnemonic?');
    }
  }
  // Legacy XOR — try and let caller re-wrap with AES
  try {
    return decryptJsonXorV1(raw, phrase);
  } catch {
    throw new Error('Cannot decrypt 2P client secret — wrong mnemonic or corrupt blob');
  }
}

/** True if blob is already AES-GCM v2 */
export function isAesGcmClientSecretBlob(encHex) {
  return String(encHex || '').startsWith(ENC_PREFIX_AES_V2);
}

/**
 * Shared 2P keygen core. `chain: 'wart' | 'eth'` selects address encoding only.
 * Full scalar d is NEVER formed.
 */
async function createTwoPartyVaultCore({
  subAddress,
  index,
  owner,
  chain = 'wart',
} = {}) {
  const dUser = randomScalar();
  const dDapp = randomScalar();
  const Q = G.multiply(dUser).add(G.multiply(dDapp));
  const pubHex = pointToCompressedHex(Q);
  const scheme = chain === 'eth' ? MULTISIG_SCHEME_ETH : MULTISIG_SCHEME;
  const address =
    chain === 'eth'
      ? ethAddressFromPubCompressedHex(pubHex)
      : addressFromPubCompressedHex(pubHex);
  // Cosigner stores bare hex for both; keep 0x for ETH display consistency
  const vaultAddressForCosigner =
    chain === 'eth'
      ? String(address).replace(/^0x/i, '').toLowerCase()
      : String(address).replace(/^0x/i, '').toLowerCase();

  const envBits =
    typeof process !== 'undefined' && process.env?.PAILLIER_BITS
      ? Number(process.env.PAILLIER_BITS)
      : NaN;
  const bits =
    Number.isFinite(envBits) && envBits >= 2048 ? envBits : DEFAULT_PAILLIER_BITS;
  const { publicKey, privateKey } = await generateRandomKeys(bits);
  const ckey = publicKey.encrypt(dUser);

  const displayAddress =
    chain === 'eth'
      ? (String(address).startsWith('0x') ? address : `0x${address}`).toLowerCase()
      : vaultAddressForCosigner;

  return {
    scheme,
    chain,
    address: displayAddress,
    publicKey: pubHex,
    cosignerRegister: {
      vaultAddress: vaultAddressForCosigner,
      dappShareHex: scalarToHex(dDapp),
      paillierN: publicKey.n.toString(),
      paillierG: publicKey.g.toString(),
      ckey: ckey.toString(),
      publicKey: pubHex,
      scheme,
      chain,
    },
    clientSecret: {
      userShareHex: scalarToHex(dUser),
      paillierLambda: privateKey.lambda.toString(),
      paillierMu: privateKey.mu.toString(),
      paillierN: publicKey.n.toString(),
      paillierG: publicKey.g.toString(),
      publicKey: pubHex,
      address: displayAddress,
      scheme,
      chain,
      paillierBits: bits,
    },
    subAddress: subAddress
      ? String(subAddress).replace(/^0x/i, '').toLowerCase()
      : null,
    index: index != null ? Number(index) : null,
    owner: owner ? String(owner).toLowerCase() : null,
    createdAt: Date.now(),
  };
}

/**
 * Keygen: additive shares + Paillier Enc(d_user) for cosigner.
 * Public key Q = d_user·G + d_dapp·G — full scalar d is NEVER formed.
 * Warthog vault address (RIPEMD160+checksum).
 */
export async function createTwoPartyVault({ subAddress, index, owner } = {}) {
  return createTwoPartyVaultCore({ subAddress, index, owner, chain: 'wart' });
}

/**
 * Cosigner ETH vault — same 2P material, Ethereum address from Q.
 * Fundable with native ETH; cosign ETH withdraw is a later step.
 */
export async function createTwoPartyEthVault({
  subAddress,
  index,
  owner,
} = {}) {
  return createTwoPartyVaultCore({ subAddress, index, owner, chain: 'eth' });
}

function storageKey(mainAddress, subAddress, chain = 'wart') {
  const m = String(mainAddress || 'anon').replace(/^0x/i, '').toLowerCase();
  const s = String(subAddress || '').replace(/^0x/i, '').toLowerCase();
  const prefix =
    chain === 'eth' ? `${USER_STORE_PREFIX}eth:` : USER_STORE_PREFIX;
  return `${prefix}${m}:${s}`;
}

/**
 * Persist **user half only** (encrypted with mnemonic).
 * Never store d_dapp / cosignerRegister in the browser — that lives only on the cosigner
 * (and ops cosigner-backup.mjs). Client-side cosigner backups were removed as a split-key hole.
 */
export function saveTwoPartyClientLocal({
  mainAddress,
  subAddress,
  vaultAddress,
  index,
  encryptedClientSecret,
  /** @deprecated ignored — cosigner half must not live in the browser */
  encryptedCosignerBackup: _ignoredCosignerBackup = null,
  scheme = MULTISIG_SCHEME,
  chain = scheme === MULTISIG_SCHEME_ETH ? 'eth' : 'wart',
}) {
  if (typeof localStorage === 'undefined') return;
  const bareVault = String(vaultAddress).replace(/^0x/i, '').toLowerCase();
  localStorage.setItem(
    storageKey(mainAddress, subAddress, chain),
    JSON.stringify({
      vaultAddress: chain === 'eth' ? `0x${bareVault}` : bareVault,
      subAddress: String(subAddress).replace(/^0x/i, '').toLowerCase(),
      index: Number(index),
      encryptedClientSecret,
      scheme,
      chain,
      savedAt: Date.now(),
    }),
  );
}

/** Load ETH cosigner vault user-half record for an ETH sub address. */
export function loadTwoPartyEthClientLocal(mainAddress, subAddress) {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey(mainAddress, subAddress, 'eth'));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @deprecated Always returns null. Cosigner half is no longer kept in the browser.
 * Recovery after cosigner wipe is ops-only (cosigner-restore.mjs).
 */
export function restoreCosignerRegisterFromLocal(_mainAddress, _subAddress, _mnemonic) {
  return null;
}

export function loadTwoPartyClientLocal(mainAddress, subAddress) {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey(mainAddress, subAddress));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Scrub legacy cosigner-half backups left from older builds
    if (parsed?.encryptedCosignerBackup) {
      const { encryptedCosignerBackup: _drop, ...rest } = parsed;
      try {
        localStorage.setItem(
          storageKey(mainAddress, subAddress),
          JSON.stringify({ ...rest, savedAt: Date.now() }),
        );
      } catch {
        /* */
      }
      return rest;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Drop stale client binding when cosigner no longer has d_dapp for this vault. */
export function clearTwoPartyClientLocal(mainAddress, subAddress) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(storageKey(mainAddress, subAddress));
  } catch {
    /* */
  }
}

// ─── Offline vault-share backup (WartBunker-style opaque password blob) ───
//
// File: user-vault-share.txt — single CryptoJS AES ciphertext (text/plain).
// Unlock: password only (like warthog_wallet.txt). Never uploaded to cosigner.
// Inside (after password decrypt): **user clientSecret only** (d_user + Paillier sk).
// Cosigner half (d_dapp) is never written here — only on the cosigner service / ops backup.

/** Logical type inside the encrypted payload (never visible in the .txt). */
export const VAULT_SHARE_FILE_TYPE = 'cartesi-bridge-vault-share-v1';
/** Opaque download name (WartBunker-style). */
export const VAULT_SHARE_DOWNLOAD_NAME = 'user-vault-share.txt';

/**
 * Build the *plaintext* payload that will be password-AES encrypted into the .txt.
 * User half only — any cosignerRegister argument is ignored/discarded.
 */
export function buildVaultSharePlainPayload({
  mainAddress,
  subAddress,
  vaultAddress,
  index,
  clientSecret,
  /** @deprecated ignored — never put d_dapp in the share file */
  cosignerRegister: _ignoredCosignerRegister = null,
  scheme = MULTISIG_SCHEME,
  ownerL1 = null,
}) {
  if (!clientSecret?.userShareHex || !clientSecret?.paillierLambda) {
    throw new Error('clientSecret (user half) required for vault-share backup');
  }
  const vault = String(vaultAddress || clientSecret.address || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const sub = String(subAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const main = String(mainAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  return {
    type: VAULT_SHARE_FILE_TYPE,
    version: 3, // v3 = user half only (no cosignerRegister)
    scheme: scheme || MULTISIG_SCHEME,
    createdAt: Date.now(),
    mainAddress: main || null,
    subAddress: sub || null,
    vaultAddress: vault || null,
    index: index != null ? Number(index) : null,
    ownerL1: ownerL1 ? String(ownerL1).toLowerCase() : null,
    /** Plain only inside password-encrypted blob — never written as open JSON */
    clientSecret,
  };
}

/** CryptoJS AES encrypt entire payload → opaque string (same style as warthog_wallet.txt). */
export function encryptVaultShareWithPassword(plainPayload, password) {
  const pwd = String(password || '');
  if (!pwd) throw new Error('Password required to encrypt user-vault-share.txt');
  if (pwd.length < 4) throw new Error('Password too short (min 4 characters)');
  const payload =
    plainPayload?.type === VAULT_SHARE_FILE_TYPE
      ? plainPayload
      : buildVaultSharePlainPayload(plainPayload);
  return CryptoJS.AES.encrypt(JSON.stringify(payload), pwd).toString();
}

/** Decrypt opaque ciphertext with password → validated plain payload. */
export function decryptVaultShareWithPassword(cipherText, password) {
  const pwd = String(password || '');
  if (!pwd) throw new Error('Password required to open user-vault-share.txt');
  const raw = String(cipherText || '').trim();
  if (!raw) throw new Error('Empty vault-share file');
  // Reject obvious open JSON (old v1 format) — handled separately by import
  if (raw.startsWith('{')) {
    throw new Error('LEGACY_JSON_VAULT_SHARE');
  }
  let decrypted;
  try {
    const bytes = CryptoJS.AES.decrypt(raw, pwd);
    decrypted = bytes.toString(CryptoJS.enc.Utf8);
  } catch {
    throw new Error('Failed to decrypt vault-share: invalid password or corrupt file');
  }
  if (!decrypted) {
    throw new Error('Failed to decrypt vault-share: invalid password or corrupt file');
  }
  let obj;
  try {
    obj = JSON.parse(decrypted);
  } catch {
    throw new Error('Failed to decrypt vault-share: invalid password or corrupt file');
  }
  if (obj?.type !== VAULT_SHARE_FILE_TYPE) {
    throw new Error(`Unknown vault-share payload type "${obj?.type || '?'}"`);
  }
  if (!obj.clientSecret?.userShareHex) {
    throw new Error('Vault-share payload missing user half (clientSecret)');
  }
  return obj;
}

/**
 * Download opaque password-encrypted .txt (client-side only).
 * In Rabby / wallet in-app browsers, automatic download is often blocked —
 * a copy/open fallback modal is shown.
 *
 * @param {string|object} cipherOrPayload - AES ciphertext string, or plain payload (+ password required)
 * @param {string} [password] - required if cipherOrPayload is plain object
 * @param {string} [filename] - optional; defaults to user-vault-share.txt
 * @param {{ promptName?: boolean }} [opts] - if promptName, ask for filename (default pre-filled)
 * @returns {Promise<string|null>} filename used, or null if user cancelled the name prompt
 */
export async function downloadVaultShareBackupFile(
  cipherOrPayload,
  password,
  filename,
  opts = {},
) {
  if (typeof document === 'undefined') {
    throw new Error('downloadVaultShareBackupFile requires a browser');
  }
  let cipher;
  if (typeof cipherOrPayload === 'string' && !cipherOrPayload.trim().startsWith('{')) {
    cipher = cipherOrPayload.trim();
  } else {
    cipher = encryptVaultShareWithPassword(cipherOrPayload, password);
  }
  if (!cipher) {
    throw new Error('Nothing to download — empty vault-share ciphertext');
  }

  let name = filename;
  if (opts?.promptName) {
    name = promptDownloadFilename(
      sanitizeDownloadFilename(
        filename || VAULT_SHARE_DOWNLOAD_NAME,
        VAULT_SHARE_DOWNLOAD_NAME,
      ),
      'Vault share file name (edit or keep default)',
    );
    if (name == null) return null;
  } else {
    name = sanitizeDownloadFilename(
      filename || VAULT_SHARE_DOWNLOAD_NAME,
      VAULT_SHARE_DOWNLOAD_NAME,
    );
  }

  const result = await downloadTextFile(cipher, name, 'text/plain;charset=utf-8');
  return result?.name || name;
}

/** @deprecated alias — prefer buildVaultSharePlainPayload + encryptVaultShareWithPassword */
export function buildVaultShareBackupFile(args) {
  return buildVaultSharePlainPayload({
    ...args,
    clientSecret: args.clientSecret,
  });
}

/**
 * Build plain payload from localStorage (needs mnemonic to unwrap mnemonic-wrapped secrets).
 * User half only — never exports cosigner material even if legacy storage had it.
 * @returns {object|null}
 */
export async function exportVaultShareBackupFromLocal(
  mainAddress,
  subAddress,
  { ownerL1 = null, mnemonic = null } = {},
) {
  const local = loadTwoPartyClientLocal(mainAddress, subAddress);
  if (!local?.encryptedClientSecret) return null;
  const phrase = String(mnemonic || '').trim();
  if (!phrase) {
    throw new Error('Mnemonic required to export vault share (unwrap local secret)');
  }
  let clientSecret;
  try {
    clientSecret = await decryptJsonWithMnemonic(local.encryptedClientSecret, phrase);
  } catch {
    throw new Error('Cannot unwrap local user share — wrong mnemonic?');
  }
  return buildVaultSharePlainPayload({
    mainAddress,
    subAddress,
    vaultAddress: local.vaultAddress,
    index: local.index,
    clientSecret,
    scheme: local.scheme,
    ownerL1,
  });
}

/**
 * Import opaque password .txt (or legacy open JSON v1).
 * Re-wraps **user half only** into localStorage. Does NOT contact cosigner.
 * Legacy files that still contain cosignerRegister are accepted but that material is discarded.
 *
 * @returns {{ vaultAddress, subAddress, index, hasCosignerBackup, strippedCosignerMaterial, scheme }}
 */
export async function importVaultShareBackupFile(
  raw,
  {
    mainAddress,
    mnemonic,
    password = null,
    subAddress: preferSub = null,
  } = {},
) {
  const phrase = String(mnemonic || '').trim();
  if (!phrase) {
    throw new Error('Mnemonic required to install vault share into this browser');
  }

  const text = typeof raw === 'string' ? raw.trim() : '';
  let payload;

  // Legacy open JSON (v1) — mnemonic-wrapped fields, no outer password
  if (text.startsWith('{') || (raw && typeof raw === 'object' && raw.type)) {
    const file = typeof raw === 'object' && raw.type ? raw : JSON.parse(text);
    if (file.type !== VAULT_SHARE_FILE_TYPE) {
      throw new Error(`Unknown file type "${file.type || '?'}"`);
    }
    if (file.clientSecret?.userShareHex) {
      // Already plain (shouldn't be open on disk) — accept carefully
      payload = file;
    } else if (file.encryptedClientSecret) {
      let clientSecret;
      try {
        clientSecret = await decryptJsonWithMnemonic(file.encryptedClientSecret, phrase);
      } catch {
        throw new Error('Legacy vault-share: cannot decrypt with this mnemonic');
      }
      payload = {
        ...file,
        clientSecret,
      };
    } else {
      throw new Error('Legacy vault-share missing user half');
    }
  } else {
    // Opaque WartBunker-style blob
    const pwd = String(password || '');
    if (!pwd) throw new Error('Password required to open user-vault-share.txt');
    payload = decryptVaultShareWithPassword(text, pwd);
  }

  const clientSecret = payload.clientSecret;
  if (!clientSecret?.userShareHex || !clientSecret?.paillierLambda) {
    throw new Error('Decrypted payload is not a valid 2P client secret');
  }

  // Security: never install cosigner half into the browser, even from old backups
  const strippedCosignerMaterial = !!(
    payload.cosignerRegister?.dappShareHex ||
    payload.encryptedCosignerBackup
  );

  const main = String(mainAddress || payload.mainAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const sub = String(preferSub || payload.subAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!main) throw new Error('mainAddress required to import vault share');
  if (!sub) throw new Error('subAddress missing in file — cannot import');

  const vault = String(payload.vaultAddress || clientSecret.address || '')
    .replace(/^0x/i, '')
    .toLowerCase();

  const enc = await encryptJsonWithMnemonic(clientSecret, phrase);

  saveTwoPartyClientLocal({
    mainAddress: main,
    subAddress: sub,
    vaultAddress: vault,
    index: payload.index != null ? Number(payload.index) : 0,
    encryptedClientSecret: enc,
    scheme: payload.scheme || MULTISIG_SCHEME,
  });

  return {
    vaultAddress: vault,
    subAddress: sub,
    index: payload.index != null ? Number(payload.index) : 0,
    hasCosignerBackup: false,
    strippedCosignerMaterial,
    scheme: payload.scheme || MULTISIG_SCHEME,
  };
}

/** Prompt helper (browser). Returns password or null if cancelled. */
export function promptVaultSharePassword(mode = 'encrypt') {
  if (typeof window === 'undefined') return null;
  if (mode === 'encrypt') {
    const p1 = window.prompt(
      'Password to encrypt user-vault-share.txt\n(same idea as warthog_wallet.txt — store offline)',
    );
    if (p1 == null || p1 === '') return null;
    const p2 = window.prompt('Confirm password for user-vault-share.txt');
    if (p2 == null) return null;
    if (p1 !== p2) {
      throw new Error('Passwords do not match');
    }
    return p1;
  }
  const p = window.prompt('Password for user-vault-share.txt');
  if (p == null || p === '') return null;
  return p;
}

/** Client: k1, R1 = k1·G */
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
