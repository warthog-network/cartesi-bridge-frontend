/**
 * Warthog wallet create / restore / import.
 *
 * Intentionally does NOT import warthog-js here. In the browser, Vite's
 * prebundle of warthog-js pulls create-hash → ripemd160 → readable-stream
 * and crashes with "Cannot read properties of undefined (reading 'slice')".
 *
 * Address derivation matches warthog-js addressDerivation.js:
 *   RIPEMD160(SHA256(compressedPubKey)) || SHA256(that)[0..4]
 * using ethers-v6 only (already prebundled cleanly).
 */
import {
  HDNodeWallet,
  Mnemonic,
  randomBytes,
  SigningKey,
  sha256,
  ripemd160,
  getBytes,
  concat,
  hexlify,
} from 'ethers-v6';

function normalizePrivateKeyHex(privateKey) {
  if (privateKey == null || privateKey === '') {
    throw new Error(
      'Failed to derive private key from seed (got empty key). Try the other derivation path (Hardened vs Non-Hardened).'
    );
  }
  const hex = String(privateKey).replace(/^0x/i, '').toLowerCase();
  if (hex.length !== 64 || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error('Private key must be 64 hex characters');
  }
  return hex;
}

/** 48-char Warthog address hex from compressed or 0x-prefixed public key. */
export function addressHexFromPublicKey(publicKeyHex) {
  let pk = String(publicKeyHex || '').replace(/^0x/i, '');
  if (pk.length === 130 && pk.startsWith('04')) {
    // Uncompressed → compress
    const x = pk.slice(2, 66);
    const y = pk.slice(66);
    const yLast = parseInt(y.slice(-2), 16);
    pk = (yLast % 2 === 0 ? '02' : '03') + x;
  }
  if (pk.length !== 66 || (!pk.startsWith('02') && !pk.startsWith('03'))) {
    throw new Error('Invalid secp256k1 public key for Warthog address');
  }

  const pubBytes = getBytes('0x' + pk);
  const sha = getBytes(sha256(pubBytes));
  const ripe = getBytes(ripemd160(sha));
  const checksum = getBytes(sha256(ripe)).slice(0, 4);
  return hexlify(concat([ripe, checksum])).slice(2);
}

/** Build { privateKey, publicKey, address } from a 64-char private key hex. */
export function walletDataFromPrivateKey(privKey, extra = {}) {
  const privateKey = normalizePrivateKeyHex(privKey);
  const signingKey = new SigningKey('0x' + privateKey);
  const publicKey = signingKey.compressedPublicKey.replace(/^0x/i, '');
  const address = addressHexFromPublicKey(publicKey);
  return {
    ...extra,
    privateKey,
    publicKey,
    address,
  };
}

/**
 * Hardened:     m/44'/2070'/0'/0/0
 * Non-hardened: m/44'/2070'/0/0/0
 */
function deriveWalletDataFromMnemonic(mnemonic, pathType, extra = {}) {
  const phrase = mnemonic.trim().replace(/\s+/g, ' ');
  if (!phrase) throw new Error('Seed phrase is empty');

  try {
    const basePath =
      pathType === 'hardened' ? "m/44'/2070'/0'" : "m/44'/2070'/0";
    const root = HDNodeWallet.fromPhrase(phrase, '', basePath);
    const child = root.derivePath('0/0');
    return walletDataFromPrivateKey(child.privateKey, {
      mnemonic: phrase,
      ...extra,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    if (/invalid mnemonic|invalid phrase|checksum|BIP39|WORDLIST|unknown word/i.test(msg)) {
      throw new Error(`Invalid seed phrase (${msg})`);
    }
    throw err;
  }
}

/** Create a new wallet with a fresh mnemonic. */
export async function generateWallet(wordCount, pathType) {
  const strength = Number(wordCount) === 12 ? 128 : 256;
  const entropy = randomBytes(strength / 8);
  const mnemonic = Mnemonic.fromEntropy(entropy).phrase;
  return deriveWalletDataFromMnemonic(mnemonic, pathType, {
    wordCount: Number(wordCount),
    pathType,
  });
}

/** Restore a wallet from an existing mnemonic. */
export async function deriveWallet(mnemonicPhrase, wordCount, pathType) {
  const phrase = mnemonicPhrase.trim().replace(/\s+/g, ' ');
  const words = phrase.split(' ').filter(Boolean);
  const expected = Number(wordCount);
  if (expected && words.length !== expected) {
    throw new Error(`Seed phrase must have exactly ${expected} words (got ${words.length})`);
  }

  return deriveWalletDataFromMnemonic(phrase, pathType, {
    wordCount: expected || words.length,
    pathType,
  });
}

/** Import a wallet from a raw private key. */
export async function importFromPrivateKey(privKey) {
  return walletDataFromPrivateKey(privKey);
}
