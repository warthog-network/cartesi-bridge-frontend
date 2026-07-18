/**
 * Spendable Warthog vault key derivation — must match Rust:
 *   cartesi-bridge-backend/src/bin/zk-proof-generator.rs
 *
 * ## Model
 * - Vault private key = f(user bridge secret, subAddress, index)
 * - Frontend secret = SHA256("bridge-secret-v1" || mnemonic)  (never sent on-chain)
 * - Rollup stores only public vault address + lock policy
 * - While locked (spoofed wWART outstanding): dApp must approve unlock (burn)
 * - After burn/unlock notice: user may spend WART from vault with this private key
 *
 * Host recovery:
 *   cargo build --release --bin zk-proof-generator
 *   ./target/release/zk-proof-generator --sub-address SUB --index N --secret SECRET [--show-key]
 */

import {
  sha256,
  ripemd160,
  SigningKey,
  getBytes,
  hexlify,
  concat,
  toUtf8Bytes,
} from 'ethers-v6';

const DOMAIN = 'cartesi-bridge-wart-vault-v1';
const SECRET_PREFIX = 'bridge-secret-v1';

/** Normalize Warthog address hex (no 0x, lowercase). */
export function normalizeWartHex(addr) {
  return String(addr || '')
    .trim()
    .replace(/^0x/i, '')
    .toLowerCase();
}

/**
 * Per-wallet bridge secret from main mnemonic (or explicit secret string).
 * Matches offline recovery when the same secret is passed to the Rust binary.
 */
export function bridgeSecretFromMnemonic(mnemonic) {
  const phrase = String(mnemonic || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!phrase) throw new Error('Mnemonic required for vault secret');
  return sha256(toUtf8Bytes(SECRET_PREFIX + phrase)).replace(/^0x/i, '');
}

function secretBytesFromArg(secret) {
  const s = String(secret || '').trim();
  const hexish = s.replace(/^0x/i, '');
  if (
    hexish.length >= 32 &&
    hexish.length % 2 === 0 &&
    /^[0-9a-fA-F]+$/.test(hexish)
  ) {
    return getBytes('0x' + hexish.toLowerCase());
  }
  return toUtf8Bytes(s);
}

/**
 * Domain-separated material — must match Rust `vault_material`.
 * SHA256( DOMAIN || 0x00 || secret || 0x00 || sub_hex || 0x00 || index_str )
 */
export function vaultMaterial(secret, subAddress, index) {
  const sub = normalizeWartHex(subAddress);
  const idx = String(Number(index));
  const sec = secretBytesFromArg(secret);
  const parts = [
    toUtf8Bytes(DOMAIN),
    new Uint8Array([0]),
    sec,
    new Uint8Array([0]),
    toUtf8Bytes(sub),
    new Uint8Array([0]),
    toUtf8Bytes(idx),
  ];
  let total = 0;
  for (const p of parts) total += p.length;
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return getBytes(sha256(buf));
}

function materialToPrivateKeyHex(materialBytes) {
  let material = new Uint8Array(materialBytes);
  // Rehash while SigningKey rejects (0 / out of range) — mirrors Rust loop
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const hex = hexlify(material);
      // eslint-disable-next-line no-new
      new SigningKey(hex);
      return hex.replace(/^0x/i, '').toLowerCase();
    } catch {
      const retry = new Uint8Array(32 + material.length);
      const tag = toUtf8Bytes('cartesi-bridge-wart-vault-v1-retry');
      retry.set(tag, 0);
      // only first 32 of material after tag for sha input
      const input = concat([tag, material]);
      material = getBytes(sha256(input));
    }
  }
  throw new Error('Failed to derive valid vault secp256k1 key');
}

/** Warthog 48-char address from compressed public key (ethers SigningKey). */
export function addressFromPrivateKeyHex(privHex) {
  const key = privHex.startsWith('0x') ? privHex : `0x${privHex}`;
  const sk = new SigningKey(key);
  const compressed = getBytes(sk.compressedPublicKey);
  const sha = getBytes(sha256(compressed));
  const ripe = getBytes(ripemd160(sha));
  const checksum = getBytes(sha256(ripe)).slice(0, 4);
  return hexlify(concat([ripe, checksum])).slice(2);
}

/**
 * Derive spendable vault wallet for a sub-wallet index.
 * @param {object} opts
 * @param {string} opts.mnemonic - main wallet seed (preferred)
 * @param {string} [opts.secret] - override bridge secret (hex or utf8)
 * @param {string} opts.subAddress - 48-hex sub-wallet address
 * @param {number|string} opts.index - salted HD index
 * @returns {{ address: string, privateKey: string, publicKey: string, index: number, scheme: string }}
 */
export function deriveVaultWallet({ mnemonic, secret, subAddress, index }) {
  const sec =
    secret != null && String(secret).length > 0
      ? String(secret)
      : bridgeSecretFromMnemonic(mnemonic);

  const material = vaultMaterial(sec, subAddress, index);
  const privateKey = materialToPrivateKeyHex(material);
  const sk = new SigningKey('0x' + privateKey);
  const publicKey = sk.compressedPublicKey.replace(/^0x/i, '');
  const address = addressFromPrivateKeyHex(privateKey);

  return {
    address,
    privateKey,
    publicKey,
    index: Number(index),
    scheme: 'cartesi-bridge-wart-vault-v1',
    /** hex secret used (for host Rust --secret recovery) — do not log in prod UI */
    recoverySecretHex: typeof sec === 'string' && /^[0-9a-fA-F]+$/.test(sec.replace(/^0x/i, ''))
      ? sec.replace(/^0x/i, '').toLowerCase()
      : bridgeSecretFromMnemonic(mnemonic),
  };
}
