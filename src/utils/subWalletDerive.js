/**
 * Derive a Warthog sub-wallet address from the main mnemonic at a salted HD index.
 * Uses ethers-v6 HDNodeWallet + warthog-js Account checksum when available.
 *
 * IMPORTANT (ethers v6):
 * `HDNodeWallet.fromMnemonic()` / `fromPhrase()` without a path default to
 * Ethereum `m/44'/60'/0'/0/0` (depth 5). Calling `.derivePath("m/...")` on that
 * node throws: "cannot derive root path for a node at non-zero depth".
 * Always start from seed root (`fromSeed`) or `fromPhrase(phrase, "", "m")`.
 */
import { HDNodeWallet, Mnemonic, sha256, ripemd160, hexlify, getBytes } from 'ethers-v6';

/** BIP32 account path for Warthog (coin type 2070). */
const WART_ACCOUNT = "m/44'/2070'/0'";

/**
 * Full path for a salted sub index (hardened last component).
 * @param {number|string} index
 */
export function subWalletPath(index) {
  const i = Number(index);
  if (!Number.isFinite(i) || i < 0 || i >= 0x80000000) {
    throw new Error(`Invalid sub-wallet index: ${index} (need 0 ≤ i < 2^31)`);
  }
  return `${WART_ACCOUNT}/0/${i}'`;
}

/**
 * HD node at the sub-wallet path from a BIP39 phrase.
 * Uses seed root so full m/ paths work under ethers v6.
 */
export function deriveSubHdNode(mnemonic, index) {
  const phrase = String(mnemonic).trim().replace(/\s+/g, ' ');
  if (!phrase) throw new Error('Mnemonic is empty');

  const path = subWalletPath(index);
  const mn = Mnemonic.fromPhrase(phrase);
  // Master node at depth 0 — NOT the default Ethereum account wallet
  const root = HDNodeWallet.fromSeed(mn.computeSeed());
  return { hdNode: root.derivePath(path), path };
}

/**
 * @param {string} mnemonic
 * @param {number} index - salted HD index
 * @returns {Promise<{ index: number, address: string, privateKey: string, publicKey: string, path: string }>}
 */
export async function deriveSubWallet(mnemonic, index) {
  const { hdNode, path } = deriveSubHdNode(mnemonic, index);
  const privateKey = hdNode.privateKey.replace(/^0x/i, '');
  const publicKeyHex = hdNode.publicKey; // 0x-prefixed compressed

  // Prefer warthog-js Account for correct 48-char address with checksum
  try {
    const { Account } = await import('warthog-js');
    const account = Account.fromPrivateKeyHex(privateKey);
    return {
      index: Number(index),
      address: account.address.hex,
      privateKey: account.privateKeyHex,
      publicKey: account.publicKeyHex,
      path,
    };
  } catch {
    // Fallback: manual hash (legacy) — RIPEMD160(SHA256(pub)) || SHA256(that)[0..4]
    const pubBytes = getBytes(publicKeyHex);
    const shaHex = sha256(pubBytes);
    const ripeHex = ripemd160(getBytes(shaHex));
    const checksum = sha256(getBytes(ripeHex)).slice(2, 10);
    return {
      index: Number(index),
      address: ripeHex.slice(2) + checksum,
      privateKey,
      publicKey: publicKeyHex.replace(/^0x/i, ''),
      path,
    };
  }
}

/**
 * Derive only the private key hex (no 0x) for a salted sub-wallet index.
 * Shared by SubWallet / PersonalVaultMvp sweep+withdraw paths.
 */
export function deriveSubPrivateKey(mnemonic, index) {
  const { hdNode } = deriveSubHdNode(mnemonic, index);
  return hdNode.privateKey.replace(/^0x/i, '');
}
