/**
 * 2-party ECDSA (Lindell-style) — full private key never assembled.
 *
 * d = d_user + d_dapp (mod n). Cosigner stores d_dapp + Enc(d_user) only.
 * Sign: interactive; output (r,s,recid) under aggregate pubkey.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { generateRandomKeys, PublicKey, PrivateKey } from 'paillier-bigint';
import { sha256, ripemd160, getBytes, hexlify, concat, toUtf8Bytes } from 'ethers-v6';
import CryptoJS from 'crypto-js';

export const MULTISIG_SCHEME = 'wart-2p-ecdsa-lindell-v1';

export const CURVE_N = secp256k1.CURVE.n;
const G = secp256k1.ProjectivePoint.BASE;

const ENC_PREFIX = 'cartesi-bridge-2p-ecdsa-enc-v1';
const USER_STORE_PREFIX = 'cartesi-bridge-msig2p-user-v1:';

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
  const h = String(hex).replace(/^0x/i, '');
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

function hashToScalar(hashHex) {
  return modN(BigInt('0x' + String(hashHex).replace(/^0x/i, '')));
}

export function encryptJsonWithMnemonic(obj, mnemonic) {
  const phrase = String(mnemonic || '').trim().replace(/\s+/g, ' ');
  if (!phrase) throw new Error('Mnemonic required');
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(data.length);
  let counter = 0;
  let offset = 0;
  while (offset < data.length) {
    const block = getBytes(
      sha256(toUtf8Bytes(`${ENC_PREFIX}:${phrase}:${counter}`)),
    );
    for (let i = 0; i < 32 && offset < data.length; i++, offset++) {
      out[offset] = data[offset] ^ block[i];
    }
    counter++;
  }
  return hexlify(out).slice(2);
}

export function decryptJsonWithMnemonic(encHex, mnemonic) {
  const phrase = String(mnemonic || '').trim().replace(/\s+/g, ' ');
  const data = getBytes('0x' + String(encHex).replace(/^0x/i, ''));
  const out = new Uint8Array(data.length);
  let counter = 0;
  let offset = 0;
  while (offset < data.length) {
    const block = getBytes(
      sha256(toUtf8Bytes(`${ENC_PREFIX}:${phrase}:${counter}`)),
    );
    for (let i = 0; i < 32 && offset < data.length; i++, offset++) {
      out[offset] = data[offset] ^ block[i];
    }
    counter++;
  }
  return JSON.parse(new TextDecoder().decode(out));
}

/**
 * Keygen: additive shares + Paillier Enc(d_user) for cosigner.
 * Full d is computed only to derive address/pubkey, then discarded.
 */
export async function createTwoPartyVault({ subAddress, index, owner } = {}) {
  const dUser = randomScalar();
  const dDapp = randomScalar();
  const d = modN(dUser + dDapp);
  const Q = G.multiply(d);
  const pubHex = pointToCompressedHex(Q);
  const address = addressFromPubCompressedHex(pubHex);

  const bits =
    typeof process !== 'undefined' && process.env?.PAILLIER_BITS
      ? Number(process.env.PAILLIER_BITS)
      : 1024;
  const { publicKey, privateKey } = await generateRandomKeys(bits);
  const ckey = publicKey.encrypt(dUser);

  // discard d from memory path
  const vault = {
    scheme: MULTISIG_SCHEME,
    address,
    publicKey: pubHex,
    cosignerRegister: {
      vaultAddress: address,
      dappShareHex: scalarToHex(dDapp),
      paillierN: publicKey.n.toString(),
      paillierG: publicKey.g.toString(),
      ckey: ckey.toString(),
      publicKey: pubHex,
      scheme: MULTISIG_SCHEME,
    },
    clientSecret: {
      // d_user only — never d_dapp / never full d
      userShareHex: scalarToHex(dUser),
      paillierLambda: privateKey.lambda.toString(),
      paillierMu: privateKey.mu.toString(),
      paillierN: publicKey.n.toString(),
      paillierG: publicKey.g.toString(),
      publicKey: pubHex,
      address,
      scheme: MULTISIG_SCHEME,
    },
    subAddress: subAddress
      ? String(subAddress).replace(/^0x/i, '').toLowerCase()
      : null,
    index: index != null ? Number(index) : null,
    owner: owner ? String(owner).toLowerCase() : null,
    createdAt: Date.now(),
  };
  return vault;
}

function storageKey(mainAddress, subAddress) {
  const m = String(mainAddress || 'anon').replace(/^0x/i, '').toLowerCase();
  const s = String(subAddress || '').replace(/^0x/i, '').toLowerCase();
  return `${USER_STORE_PREFIX}${m}:${s}`;
}

/**
 * Persist client secret + optional encrypted cosignerRegister backup.
 * Backup lets us re-register d_dapp after cosigner store wipe (same vault address).
 * Still encrypted with mnemonic — not plaintext on disk.
 */
export function saveTwoPartyClientLocal({
  mainAddress,
  subAddress,
  vaultAddress,
  index,
  encryptedClientSecret,
  encryptedCosignerBackup = null,
  scheme = MULTISIG_SCHEME,
}) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(
    storageKey(mainAddress, subAddress),
    JSON.stringify({
      vaultAddress: String(vaultAddress).replace(/^0x/i, '').toLowerCase(),
      subAddress: String(subAddress).replace(/^0x/i, '').toLowerCase(),
      index: Number(index),
      encryptedClientSecret,
      encryptedCosignerBackup: encryptedCosignerBackup || null,
      scheme,
      savedAt: Date.now(),
    }),
  );
}

/** Re-register cosigner from browser backup after Unknown vault. */
export function restoreCosignerRegisterFromLocal(mainAddress, subAddress, mnemonic) {
  const local = loadTwoPartyClientLocal(mainAddress, subAddress);
  if (!local?.encryptedCosignerBackup) return null;
  try {
    return decryptJsonWithMnemonic(local.encryptedCosignerBackup, mnemonic);
  } catch {
    return null;
  }
}

export function loadTwoPartyClientLocal(mainAddress, subAddress) {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey(mainAddress, subAddress));
    return raw ? JSON.parse(raw) : null;
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
// Inside (after password decrypt): user clientSecret + optional cosignerRegister.
// Full d is never stored. Cosigner still holds live d_dapp separately.

/** Logical type inside the encrypted payload (never visible in the .txt). */
export const VAULT_SHARE_FILE_TYPE = 'cartesi-bridge-vault-share-v1';
/** Opaque download name (WartBunker-style). */
export const VAULT_SHARE_DOWNLOAD_NAME = 'user-vault-share.txt';

/**
 * Build the *plaintext* payload that will be password-AES encrypted into the .txt.
 * Prefer passing clientSecret / cosignerRegister objects (not outer mnemonic wraps).
 */
export function buildVaultSharePlainPayload({
  mainAddress,
  subAddress,
  vaultAddress,
  index,
  clientSecret,
  cosignerRegister = null,
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
    version: 2,
    scheme: scheme || MULTISIG_SCHEME,
    createdAt: Date.now(),
    mainAddress: main || null,
    subAddress: sub || null,
    vaultAddress: vault || null,
    index: index != null ? Number(index) : null,
    ownerL1: ownerL1 ? String(ownerL1).toLowerCase() : null,
    /** Plain only inside password-encrypted blob — never written as open JSON */
    clientSecret,
    cosignerRegister: cosignerRegister || null,
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
 * @param {string|object} cipherOrPayload - AES ciphertext string, or plain payload (+ password required)
 * @param {string} [password] - required if cipherOrPayload is plain object
 * @param {string} [filename]
 */
export function downloadVaultShareBackupFile(cipherOrPayload, password, filename) {
  if (typeof document === 'undefined') {
    throw new Error('downloadVaultShareBackupFile requires a browser');
  }
  let cipher;
  if (typeof cipherOrPayload === 'string' && !cipherOrPayload.trim().startsWith('{')) {
    cipher = cipherOrPayload.trim();
  } else {
    cipher = encryptVaultShareWithPassword(cipherOrPayload, password);
  }
  const name = filename || VAULT_SHARE_DOWNLOAD_NAME;
  const blob = new Blob([cipher], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return name;
}

/** @deprecated alias — prefer buildVaultSharePlainPayload + encryptVaultShareWithPassword */
export function buildVaultShareBackupFile(args) {
  return buildVaultSharePlainPayload({
    ...args,
    clientSecret: args.clientSecret,
    cosignerRegister: args.cosignerRegister,
  });
}

/**
 * Build plain payload from localStorage (needs mnemonic to unwrap mnemonic-wrapped secrets).
 * @returns {object|null}
 */
export function exportVaultShareBackupFromLocal(
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
    clientSecret = decryptJsonWithMnemonic(local.encryptedClientSecret, phrase);
  } catch {
    throw new Error('Cannot unwrap local user share — wrong mnemonic?');
  }
  let cosignerRegister = null;
  if (local.encryptedCosignerBackup) {
    try {
      cosignerRegister = decryptJsonWithMnemonic(local.encryptedCosignerBackup, phrase);
    } catch {
      cosignerRegister = null;
    }
  }
  return buildVaultSharePlainPayload({
    mainAddress,
    subAddress,
    vaultAddress: local.vaultAddress,
    index: local.index,
    clientSecret,
    cosignerRegister,
    scheme: local.scheme,
    ownerL1,
  });
}

/**
 * Import opaque password .txt (or legacy open JSON v1).
 * Re-wraps secrets with mnemonic into localStorage. Does NOT contact cosigner.
 *
 * @returns {{ vaultAddress, subAddress, index, hasCosignerBackup, scheme }}
 */
export function importVaultShareBackupFile(
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
        clientSecret = decryptJsonWithMnemonic(file.encryptedClientSecret, phrase);
      } catch {
        throw new Error('Legacy vault-share: cannot decrypt with this mnemonic');
      }
      let cosignerRegister = null;
      if (file.encryptedCosignerBackup) {
        try {
          cosignerRegister = decryptJsonWithMnemonic(
            file.encryptedCosignerBackup,
            phrase,
          );
        } catch {
          /* optional */
        }
      }
      payload = {
        ...file,
        clientSecret,
        cosignerRegister,
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

  const enc = encryptJsonWithMnemonic(clientSecret, phrase);
  const encBackup = payload.cosignerRegister
    ? encryptJsonWithMnemonic(payload.cosignerRegister, phrase)
    : null;

  saveTwoPartyClientLocal({
    mainAddress: main,
    subAddress: sub,
    vaultAddress: vault,
    index: payload.index != null ? Number(payload.index) : 0,
    encryptedClientSecret: enc,
    encryptedCosignerBackup: encBackup,
    scheme: payload.scheme || MULTISIG_SCHEME,
  });

  return {
    vaultAddress: vault,
    subAddress: sub,
    index: payload.index != null ? Number(payload.index) : 0,
    hasCosignerBackup: !!payload.cosignerRegister,
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

/**
 * Cosigner: R = k2·R1, build Lindell ciphertext for client.
 * Never sees d_user or full d.
 */
export function cosignerSignStep({
  R1Hex,
  hashHex,
  dappShareHex,
  ckeyStr,
  paillierN,
  paillierG,
}) {
  const k2 = randomScalar();
  const R1 = pointFromCompressedHex(R1Hex);
  const R = R1.multiply(k2);
  const r = modN(R.toAffine().x);
  if (r === 0n) throw new Error('bad r — retry');

  const z = hashToScalar(hashHex);
  const x2 = hexToScalar(dappShareHex);
  const k2inv = invScalar(k2);

  const pub = new PublicKey(BigInt(paillierN), BigInt(paillierG));
  const ckey = BigInt(ckeyStr);

  const termM = modN(k2inv * z);
  const termX2 = modN(k2inv * r * x2);
  const exp = modN(k2inv * r);

  const rhoBytes = crypto.getRandomValues(new Uint8Array(32));
  let rho = 0n;
  for (const b of rhoBytes) rho = (rho << 8n) | BigInt(b);
  rho = (rho % (pub.n - 1n)) + 1n;

  let c = pub.encrypt(termM);
  c = pub.addition(c, pub.encrypt(termX2));
  c = pub.addition(c, pub.multiply(ckey, exp));
  c = pub.addition(c, pub.encrypt(rho * CURVE_N));

  return {
    rHex: scalarToHex(r),
    ciphertext: c.toString(),
    RHex: pointToCompressedHex(R),
  };
}

/**
 * Client finishes s = k1^{-1} * (Dec(c) mod n); returns Warthog signature65.
 * Never sees d_dapp.
 */
export function clientSignFinish({ k1Hex, rHex, ciphertext, hashHex, clientSecret }) {
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

function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/i, '');
  if (h.length % 2) throw new Error('odd hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
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
