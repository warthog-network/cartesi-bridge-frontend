/**
 * True 2-of-2 multi-sig vault (additive scalar shares) for Warthog.
 *
 * ## Crypto
 *   d_user, d_dapp ← random scalars in (0, n)
 *   d = (d_user + d_dapp) mod n     // full private key
 *   P = d·G                         // aggregate pubkey (chain sees one key)
 *   address = Warthog(compress(P))
 *
 * ## Multi-sig control
 *   User stores only d_user (encrypted).
 *   Co-signer stores only d_dapp.
 *   Spend: BOTH shares required. Co-signer combines on its side, returns a
 *   one-shot private key OR better: signs after receiving user share in the
 *   sign request (full key never stored, only assembled ephemerally on cosigner).
 *
 * This is 2-of-2 multi-party control of one secp256k1 key (not native Warthog
 * script multisig). Ladder next: MuSig2/FROST or 2P-ECDSA so d never assembles.
 */

import {
  sha256,
  ripemd160,
  SigningKey,
  getBytes,
  hexlify,
  concat,
  toUtf8Bytes,
  randomBytes,
} from 'ethers-v6';

export const MULTISIG_SCHEME = 'wart-multisig-additive-2of2-v1';
/** @deprecated use MULTISIG_SCHEME */
export const THRESHOLD_SCHEME = MULTISIG_SCHEME;

const USER_SHARE_PREFIX = 'cartesi-bridge-msig-user-v1:';
const ENC_PREFIX = 'cartesi-bridge-msig-enc-v1';

/** secp256k1 group order */
export const SECP256K1_N = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
);

function bytesToScalar(bytes) {
  const hex = hexlify(bytes);
  let x = BigInt(hex);
  x = x % SECP256K1_N;
  if (x === 0n) x = 1n;
  return x;
}

function scalarToHex32(s) {
  let x = s % SECP256K1_N;
  if (x < 0n) x += SECP256K1_N;
  return x.toString(16).padStart(64, '0');
}

function hexToScalar(hex) {
  const h = String(hex).replace(/^0x/i, '');
  let x = BigInt('0x' + h);
  x = x % SECP256K1_N;
  if (x === 0n) throw new Error('Invalid share: zero scalar');
  return x;
}

function randomScalar() {
  // 48 bytes → mod n to reduce bias
  for (let i = 0; i < 16; i++) {
    const x = bytesToScalar(randomBytes(48));
    if (x > 0n && x < SECP256K1_N) return x;
  }
  throw new Error('Failed to sample scalar');
}

function privateKeyFromScalar(d) {
  const hex = scalarToHex32(d);
  // Validate via SigningKey
  // eslint-disable-next-line no-new
  new SigningKey('0x' + hex);
  return hex;
}

function addressFromPrivateKeyHex(privHex) {
  const key = privHex.startsWith('0x') ? privHex : `0x${privHex}`;
  const sk = new SigningKey(key);
  const compressed = getBytes(sk.compressedPublicKey);
  const sha = getBytes(sha256(compressed));
  const ripe = getBytes(ripemd160(sha));
  const checksum = getBytes(sha256(ripe)).slice(0, 4);
  return hexlify(concat([ripe, checksum])).slice(2);
}

/** Combine additive shares → full private key hex (no 0x). */
export function combineSharesToPrivateKey(userShareHex, dappShareHex) {
  const dUser = hexToScalar(userShareHex);
  const dDapp = hexToScalar(dappShareHex);
  const d = (dUser + dDapp) % SECP256K1_N;
  if (d === 0n) throw new Error('Combined key is zero (invalid shares)');
  return privateKeyFromScalar(d);
}

export function addressFromShares(userShareHex, dappShareHex) {
  return addressFromPrivateKeyHex(
    combineSharesToPrivateKey(userShareHex, dappShareHex),
  );
}

/**
 * 2-of-2 multi-sig keygen (dealer in browser once).
 * Returns userShare + dappShare + aggregate address. Full priv only for tests.
 */
export function createMultiSigVault({ subAddress, index, owner } = {}) {
  const dUser = randomScalar();
  const dDapp = randomScalar();
  const d = (dUser + dDapp) % SECP256K1_N;
  const privateKey = privateKeyFromScalar(d);
  const sk = new SigningKey('0x' + privateKey);
  const address = addressFromPrivateKeyHex(privateKey);

  return {
    scheme: MULTISIG_SCHEME,
    address,
    publicKey: sk.compressedPublicKey.replace(/^0x/i, ''),
    privateKey, // do not persist — tests only
    userShareHex: scalarToHex32(dUser),
    dappShareHex: scalarToHex32(dDapp),
    subAddress: subAddress
      ? String(subAddress).replace(/^0x/i, '').toLowerCase()
      : null,
    index: index != null ? Number(index) : null,
    owner: owner ? String(owner).toLowerCase() : null,
    createdAt: Date.now(),
  };
}

/** @deprecated alias */
export const createThresholdVault = createMultiSigVault;

/** Encrypt user share for localStorage (XOR with mnemonic-derived pad). */
export function encryptUserShare(userShareHex, mnemonic) {
  const phrase = String(mnemonic || '').trim().replace(/\s+/g, ' ');
  if (!phrase) throw new Error('Mnemonic required to encrypt user share');
  const keyMat = getBytes(sha256(toUtf8Bytes(ENC_PREFIX + phrase)));
  const share = getBytes(
    '0x' + String(userShareHex).replace(/^0x/i, '').padStart(64, '0'),
  );
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = share[i] ^ keyMat[i];
  return hexlify(out).slice(2);
}

export function decryptUserShare(encryptedHex, mnemonic) {
  return encryptUserShare(encryptedHex, mnemonic);
}

function storageKey(mainAddress, subAddress) {
  const m = String(mainAddress || 'anon').replace(/^0x/i, '').toLowerCase();
  const s = String(subAddress || '').replace(/^0x/i, '').toLowerCase();
  return `${USER_SHARE_PREFIX}${m}:${s}`;
}

export function saveUserShareLocal({
  mainAddress,
  subAddress,
  vaultAddress,
  index,
  encryptedUserShare,
  scheme = MULTISIG_SCHEME,
}) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(
    storageKey(mainAddress, subAddress),
    JSON.stringify({
      vaultAddress: String(vaultAddress).replace(/^0x/i, '').toLowerCase(),
      subAddress: String(subAddress).replace(/^0x/i, '').toLowerCase(),
      index: Number(index),
      encryptedUserShare,
      scheme,
      savedAt: Date.now(),
    }),
  );
}

export function loadUserShareLocal(mainAddress, subAddress) {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey(mainAddress, subAddress));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Local open (both shares present) — prefer cosigner multiSigOpen instead
 * so full key never sits with only the browser holding dappShare.
 */
export function openMultiSigVault({ mnemonic, encryptedUserShare, dappShareHex }) {
  const userShareHex = decryptUserShare(encryptedUserShare, mnemonic);
  const privateKey = combineSharesToPrivateKey(userShareHex, dappShareHex);
  const address = addressFromPrivateKeyHex(privateKey);
  return { privateKey, address, userShareHex, scheme: MULTISIG_SCHEME };
}

/** @deprecated */
export const openThresholdVault = openMultiSigVault;
