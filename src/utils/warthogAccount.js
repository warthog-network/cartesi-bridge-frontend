import { ensureBuffer, ensureWorkerCrypto } from './ensureBuffer.js';

/** Build a warthog-js Account from already-known key material (no address derivation). */
export async function accountFromKnownKeys(privateKeyHex, publicKeyHex, addressHex) {
  await ensureWorkerCrypto();

  const privateKey = String(privateKeyHex).trim().replace(/^0x/i, '');
  const publicKey = String(publicKeyHex).trim().replace(/^0x/i, '');
  const address = String(addressHex).trim().replace(/^0x/i, '');

  if (privateKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(privateKey)) {
    throw new Error('Invalid private key');
  }
  if (!publicKey || !address) {
    throw new Error('Missing public key or address');
  }

  const { Account, Address } = await import('warthog-js');
  return new Account(privateKey, publicKey, new Address(address));
}