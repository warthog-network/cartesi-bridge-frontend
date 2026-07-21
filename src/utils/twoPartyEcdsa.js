/**
 * 2-party ECDSA (Lindell-style) — full private key never assembled.
 *
 * d = d_user + d_dapp (mod n). Cosigner stores d_dapp + Enc(d_user) only.
 * Sign: interactive; output (r,s,recid) under aggregate pubkey.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { generateRandomKeys, PublicKey, PrivateKey } from 'paillier-bigint';
import { sha256, ripemd160, getBytes, hexlify, concat, toUtf8Bytes } from 'ethers-v6';

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

// ─── Offline vault-share backup (user-held; never upload plaintext to cosigner) ───

/** Downloadable file type — client-side only recovery of user half (+ optional enc d_dapp re-register). */
export const VAULT_SHARE_FILE_TYPE = 'cartesi-bridge-vault-share-v1';

/**
 * Build an offline backup object.
 *
 * Trust model (unchanged):
 * - encryptedClientSecret = mnemonic-wrapped d_user + Paillier sk  → user only
 * - encryptedCosignerBackup = mnemonic-wrapped d_dapp register blob → optional; only re-registers
 *   app half to cosigner (never sends plaintext d_user)
 * - Full d is never in this file
 */
export function buildVaultShareBackupFile({
  mainAddress,
  subAddress,
  vaultAddress,
  index,
  encryptedClientSecret,
  encryptedCosignerBackup = null,
  scheme = MULTISIG_SCHEME,
  ownerL1 = null,
}) {
  if (!encryptedClientSecret) {
    throw new Error('encryptedClientSecret required for vault-share backup');
  }
  const vault = String(vaultAddress || '')
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
    version: 1,
    scheme: scheme || MULTISIG_SCHEME,
    createdAt: Date.now(),
    mainAddress: main || null,
    subAddress: sub || null,
    vaultAddress: vault || null,
    index: index != null ? Number(index) : null,
    ownerL1: ownerL1 ? String(ownerL1).toLowerCase() : null,
    /** Ciphertexts only — decrypt with Warthog mnemonic offline */
    encryptedClientSecret: String(encryptedClientSecret),
    encryptedCosignerBackup: encryptedCosignerBackup
      ? String(encryptedCosignerBackup)
      : null,
    trustModel: {
      userShare:
        'Browser-only. This file holds mnemonic-encrypted d_user + Paillier sk. Never sent to cosigner as plaintext.',
      dappShare:
        'Cosigner holds d_dapp. encryptedCosignerBackup (if present) only re-registers app half after cosigner wipe.',
      fullKey: 'Never assembled or stored. d = d_user + d_dapp only ephemerally at keygen.',
      doNot: 'Do not upload this file to the cosigner, dApp, or any third party unencrypted.',
    },
  };
}

/** Trigger browser download of the backup JSON (client-side only). */
export function downloadVaultShareBackupFile(fileObj, filename) {
  if (typeof document === 'undefined') {
    throw new Error('downloadVaultShareBackupFile requires a browser');
  }
  const parsed =
    fileObj?.type === VAULT_SHARE_FILE_TYPE
      ? fileObj
      : buildVaultShareBackupFile(fileObj);
  const vaultShort = (parsed.vaultAddress || 'vault').slice(0, 12);
  const name =
    filename ||
    `vault-share-${vaultShort}-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(parsed, null, 2)], {
    type: 'application/json',
  });
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

/** Parse + validate a vault-share backup from JSON text or object. */
export function parseVaultShareBackupFile(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) throw new Error('Empty vault-share file');
    try {
      obj = JSON.parse(t);
    } catch {
      throw new Error('Vault-share file is not valid JSON');
    }
  }
  if (!obj || typeof obj !== 'object') {
    throw new Error('Invalid vault-share file');
  }
  if (obj.type !== VAULT_SHARE_FILE_TYPE) {
    throw new Error(
      `Unknown file type "${obj.type || '?'}" — expected ${VAULT_SHARE_FILE_TYPE}`,
    );
  }
  if (!obj.encryptedClientSecret) {
    throw new Error('File missing encryptedClientSecret (user half)');
  }
  return obj;
}

/**
 * Verify mnemonic opens the ciphertext, then write into localStorage.
 * Does NOT contact cosigner or upload anything.
 *
 * @returns {{ vaultAddress, subAddress, index, hasCosignerBackup }}
 */
export function importVaultShareBackupFile(
  raw,
  { mainAddress, mnemonic, subAddress: preferSub = null } = {},
) {
  const file = parseVaultShareBackupFile(raw);
  const phrase = String(mnemonic || '').trim();
  if (!phrase) throw new Error('Mnemonic required to verify vault-share backup');

  // Prove we can decrypt user half — fail closed on wrong phrase / corrupt file
  let clientSecret;
  try {
    clientSecret = decryptJsonWithMnemonic(file.encryptedClientSecret, phrase);
  } catch {
    throw new Error(
      'Cannot decrypt user share — wrong Warthog mnemonic, or file corrupt',
    );
  }
  if (!clientSecret?.userShareHex || !clientSecret?.paillierLambda) {
    throw new Error('Decrypted payload is not a valid 2P client secret');
  }
  if (file.encryptedCosignerBackup) {
    try {
      decryptJsonWithMnemonic(file.encryptedCosignerBackup, phrase);
    } catch {
      throw new Error(
        'encryptedCosignerBackup present but will not decrypt with this mnemonic',
      );
    }
  }

  const main = String(mainAddress || file.mainAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const sub = String(preferSub || file.subAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!main) throw new Error('mainAddress required to import vault share');
  if (!sub) throw new Error('subAddress missing in file — cannot import');

  const vault = String(
    file.vaultAddress || clientSecret.address || '',
  )
    .replace(/^0x/i, '')
    .toLowerCase();

  saveTwoPartyClientLocal({
    mainAddress: main,
    subAddress: sub,
    vaultAddress: vault,
    index: file.index != null ? Number(file.index) : 0,
    encryptedClientSecret: file.encryptedClientSecret,
    encryptedCosignerBackup: file.encryptedCosignerBackup || null,
    scheme: file.scheme || MULTISIG_SCHEME,
  });

  return {
    vaultAddress: vault,
    subAddress: sub,
    index: file.index != null ? Number(file.index) : 0,
    hasCosignerBackup: !!file.encryptedCosignerBackup,
    scheme: file.scheme || MULTISIG_SCHEME,
  };
}

/**
 * Export from existing localStorage binding (if present).
 * @returns {object|null} backup file object
 */
export function exportVaultShareBackupFromLocal(
  mainAddress,
  subAddress,
  { ownerL1 = null } = {},
) {
  const local = loadTwoPartyClientLocal(mainAddress, subAddress);
  if (!local?.encryptedClientSecret) return null;
  return buildVaultShareBackupFile({
    mainAddress,
    subAddress,
    vaultAddress: local.vaultAddress,
    index: local.index,
    encryptedClientSecret: local.encryptedClientSecret,
    encryptedCosignerBackup: local.encryptedCosignerBackup,
    scheme: local.scheme,
    ownerL1,
  });
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
