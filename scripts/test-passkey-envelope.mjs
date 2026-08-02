/**
 * Self-test: passkey envelope helpers + AES-GCM path (no WebAuthn UI).
 * Run: node scripts/test-passkey-envelope.mjs
 */
import assert from 'node:assert/strict';
import {
  bytesToBase64Url,
  base64UrlToBytes,
  tryParseEnvelope,
  serializeEnvelope,
  inspectWalletBlob,
  emptyEnvelope,
  envelopeWithPassword,
  authBadgeForBlob,
} from '../src/utils/passkeyWallet.js';

// base64url roundtrip
const sample = new Uint8Array([0, 1, 2, 250, 255, 10]);
assert.equal(
  Buffer.from(base64UrlToBytes(bytesToBase64Url(sample))).toString('hex'),
  Buffer.from(sample).toString('hex'),
);

// legacy blob
const legacy = 'U2FsdGVkX1+legacyCryptoJsLookingString==';
const leg = inspectWalletBlob(legacy);
assert.equal(leg.hasPassword, true);
assert.equal(leg.hasPasskey, false);
assert.equal(leg.envelope, null);

// envelope with password only
const env1 = envelopeWithPassword(
  { address: 'aabbccddeeff00112233445566778899aabbccdd' },
  legacy,
  null,
);
const s1 = serializeEnvelope(env1);
const p1 = tryParseEnvelope(s1);
assert.ok(p1);
assert.equal(p1.kind, 'warthog-wallet-v1');
assert.equal(p1.password, legacy);
assert.equal(p1.passkey, null);
assert.equal(inspectWalletBlob(s1).hasPassword, true);
assert.equal(inspectWalletBlob(s1).hasPasskey, false);

// envelope with passkey + password (either method)
const env2 = {
  ...emptyEnvelope('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
  require2fa: false,
  password: legacy,
  passkey: {
    credentialId: bytesToBase64Url(new Uint8Array(16).fill(7)),
    rpId: 'localhost',
    mode: 'prf',
    prfSalt: bytesToBase64Url(new Uint8Array(32).fill(3)),
    iv: bytesToBase64Url(new Uint8Array(12).fill(1)),
    ciphertext: bytesToBase64Url(new Uint8Array(48).fill(9)),
    transports: ['internal'],
  },
};
const s2 = serializeEnvelope(env2);
const info2 = inspectWalletBlob(s2);
assert.equal(info2.hasPasskey, true);
assert.equal(info2.hasPassword, true);
assert.equal(info2.require2fa, false);
assert.equal(info2.passkeyMode, 'prf');
assert.match(authBadgeForBlob(s2), /Passkey or password/i);

// 2FA envelope
const env3 = { ...env2, require2fa: true };
const s3 = serializeEnvelope(env3);
const info3 = inspectWalletBlob(s3);
assert.equal(info3.require2fa, true);
assert.match(authBadgeForBlob(s3), /2FA/);

// AES-GCM encrypt/decrypt via WebCrypto (same as PRF-derived path internals)
const subtle = globalThis.crypto.subtle;
const rawKey = crypto.getRandomValues(new Uint8Array(32));
const key = await subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, false, [
  'encrypt',
  'decrypt',
]);
const wallet = {
  privateKey: '11'.repeat(32),
  publicKey: '02' + '22'.repeat(32),
  address: '33'.repeat(24),
  mnemonic: 'test seed phrase not real words here pad',
};
const iv = crypto.getRandomValues(new Uint8Array(12));
const pt = new TextEncoder().encode(JSON.stringify(wallet));
const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, pt));
const pt2 = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
const round = JSON.parse(new TextDecoder().decode(pt2));
assert.equal(round.privateKey, wallet.privateKey);
assert.equal(round.address, wallet.address);

console.log('passkey envelope self-test OK');
