/**
 * Derive indexed ETH deposit sub-wallets for the ETH → WART bridge.
 *
 * Mirrors Warthog sub-wallets (index numbers you can regenerate), but on
 * Ethereum HD paths. Uses the Warthog main mnemonic as the bridge seed so
 * one backup unlocks both WART subs and ETH deposit addresses.
 *
 * Path: m/44'/60'/2070'/0/{index}'
 *   - coin type 60 = Ethereum
 *   - account 2070 = Warthog-bridge namespace (avoids MetaMask m/44'/60'/0'/0/0)
 *   - hardened last component like WART subs
 *
 * IMPORTANT (ethers v6): start from seed root — never derivePath full m/…
 * from a non-zero-depth node.
 */
import { HDNodeWallet, Mnemonic } from 'ethers-v6';

/** BIP32 account path for bridge ETH (coin 60, account 2070). */
const ETH_BRIDGE_ACCOUNT = "m/44'/60'/2070'";

/**
 * Full path for an ETH sub index (hardened last component).
 * @param {number|string} index
 */
export function ethSubWalletPath(index) {
  const i = Number(index);
  if (!Number.isFinite(i) || i < 0 || i >= 0x80000000) {
    throw new Error(`Invalid ETH sub-wallet index: ${index} (need 0 ≤ i < 2^31)`);
  }
  return `${ETH_BRIDGE_ACCOUNT}/0/${i}'`;
}

/**
 * HD node at the ETH sub path from a BIP39 phrase.
 */
export function deriveEthSubHdNode(mnemonic, index) {
  const phrase = String(mnemonic).trim().replace(/\s+/g, ' ');
  if (!phrase) throw new Error('Mnemonic is empty');

  const path = ethSubWalletPath(index);
  const mn = Mnemonic.fromPhrase(phrase);
  const root = HDNodeWallet.fromSeed(mn.computeSeed());
  return { hdNode: root.derivePath(path), path };
}

/**
 * @param {string} mnemonic - Warthog / bridge BIP39 phrase
 * @param {number} index - salted or plain HD index
 * @returns {{ index: number, address: string, privateKey: string, publicKey: string, path: string }}
 */
export function deriveEthSubWallet(mnemonic, index) {
  const { hdNode, path } = deriveEthSubHdNode(mnemonic, index);
  return {
    index: Number(index),
    address: hdNode.address,
    privateKey: hdNode.privateKey,
    publicKey: hdNode.publicKey,
    path,
  };
}

/**
 * Private key (0x-prefixed) for portal deposit / L1 send from this sub.
 */
export function deriveEthSubPrivateKey(mnemonic, index) {
  const { hdNode } = deriveEthSubHdNode(mnemonic, index);
  return hdNode.privateKey;
}
