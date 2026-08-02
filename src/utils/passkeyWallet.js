/**
 * Passkey / fingerprint unlock for Warthog named wallets.
 *
 * Security model:
 *  1. Prefer WebAuthn PRF → AES-256-GCM key derived from the authenticator.
 *  2. Fallback: non-extractable AES key in IndexedDB + platform userVerification
 *     (fingerprint / Face ID / Windows Hello).
 *
 * Unlock modes (optional 2FA):
 *  - password only
 *  - fingerprint only (passkey)
 *  - either (password OR fingerprint)
 *  - require2fa: true → password AND fingerprint both required
 *
 * Prefer platform authenticators (fingerprint / thumbprint / Face ID) by default;
 * security keys remain available as a fallback option.
 *
 * Storage envelope (JSON in localStorage warthogWallet_*):
 *  {
 *    v: 1,
 *    kind: 'warthog-wallet-v1',
 *    addressHint: string,
 *    require2fa: boolean,
 *    password: string | null,   // product-specific password ciphertext
 *    passkey: {
 *      credentialId, rpId, mode: 'prf'|'device',
 *      prfSalt?, iv, ciphertext, transports?,
 *      platformPreferred?: boolean,
 *    } | null
 *  }
 */

const ENVELOPE_KIND = 'warthog-wallet-v1';
const ENVELOPE_V = 1;
const IDB_NAME = 'warthog-passkey-v1';
const IDB_STORE = 'device-aes-keys';
const PRF_HKDF_INFO = new TextEncoder().encode('warthog-wallet-passkey-aes-v1');

/** Product label shown in the OS passkey prompt */
let rpDisplayName = 'Warthog Wallet';

/** Configure RP display name (e.g. "WartBunker") before creating credentials. */
export function setPasskeyProductName(name) {
  if (name && String(name).trim()) rpDisplayName = String(name).trim().slice(0, 64);
}

export function getPasskeyProductName() {
  return rpDisplayName;
}

// ─── base64url / bytes ───────────────────────────────────────────────

export function bytesToBase64Url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(s) {
  const str = String(s || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function getSubtle() {
  const c = globalThis.crypto;
  if (c?.subtle) return c.subtle;
  throw new Error('WebCrypto is required for passkey wallets');
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function shortAddressHint(address) {
  const a = String(address || '').replace(/^0x/i, '');
  if (a.length < 12) return a || '';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function walletPayload(data) {
  return {
    privateKey: data.privateKey,
    publicKey: data.publicKey,
    address: data.address,
    mnemonic: data.mnemonic,
    wordCount: data.wordCount,
    pathType: data.pathType,
  };
}

// ─── capability checks ───────────────────────────────────────────────

export function isWebAuthnAvailable() {
  try {
    return (
      typeof window !== 'undefined' &&
      window.isSecureContext === true &&
      typeof PublicKeyCredential !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      !!navigator.credentials?.create &&
      !!navigator.credentials?.get
    );
  } catch {
    return false;
  }
}

/**
 * Platform authenticator = fingerprint / thumbprint / Face ID / Windows Hello.
 */
export async function hasPlatformAuthenticator() {
  try {
    if (!isWebAuthnAvailable()) return false;
    if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    }
    return true;
  } catch {
    return false;
  }
}

/** Short UI label — always "passkey" (device may use Face ID, PIN, or password manager). */
export function fingerprintLabel(_platformAvailable = true) {
  return 'passkey';
}

// ─── envelope parse / serialize ──────────────────────────────────────

export function tryParseEnvelope(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s.startsWith('{')) return null;
  try {
    const obj = JSON.parse(s);
    if (obj && obj.kind === ENVELOPE_KIND && Number(obj.v) === ENVELOPE_V) return obj;
    return null;
  } catch {
    return null;
  }
}

export function isWalletEnvelope(raw) {
  return tryParseEnvelope(raw) != null;
}

export function serializeEnvelope(env) {
  return JSON.stringify(env);
}

/**
 * Password ciphertext only (strips multi-auth envelope wrapper).
 * For pure password blobs, returns the raw string unchanged.
 */
export function getPasswordCipherFromBlob(raw) {
  const env = tryParseEnvelope(raw);
  if (env) return env.password || null;
  return raw == null || raw === '' ? null : String(raw);
}

/**
 * Auth capabilities for a stored blob.
 * @returns {{
 *   hasPassword: boolean,
 *   hasPasskey: boolean,
 *   passkeyMode: string|null,
 *   require2fa: boolean,
 *   addressHint: string,
 *   envelope: object|null,
 * }}
 */
export function inspectWalletBlob(raw) {
  const env = tryParseEnvelope(raw);
  if (!env) {
    return {
      hasPassword: Boolean(raw),
      hasPasskey: false,
      passkeyMode: null,
      require2fa: false,
      addressHint: '',
      envelope: null,
    };
  }
  const hasPassword = Boolean(env.password);
  const hasPasskey = Boolean(env.passkey?.credentialId && env.passkey?.ciphertext);
  return {
    hasPassword,
    hasPasskey,
    passkeyMode: env.passkey?.mode || null,
    // 2FA only meaningful when both methods exist
    require2fa: Boolean(env.require2fa) && hasPassword && hasPasskey,
    addressHint: env.addressHint || '',
    envelope: env,
  };
}

export function emptyEnvelope(address) {
  return {
    v: ENVELOPE_V,
    kind: ENVELOPE_KIND,
    addressHint: shortAddressHint(address),
    require2fa: false,
    password: null,
    passkey: null,
  };
}

// ─── AES-GCM ─────────────────────────────────────────────────────────

async function deriveAesFromPrf(prfFirstBytes) {
  const subtle = getSubtle();
  const base = await subtle.importKey('raw', prfFirstBytes, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: PRF_HKDF_INFO,
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function aesGcmEncrypt(key, plaintextObj) {
  const iv = randomBytes(12);
  const pt = new TextEncoder().encode(JSON.stringify(plaintextObj));
  const ctBuf = await getSubtle().encrypt({ name: 'AES-GCM', iv }, key, pt);
  return {
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ctBuf)),
  };
}

async function aesGcmDecrypt(key, ivB64, ctB64) {
  const iv = base64UrlToBytes(ivB64);
  const ct = base64UrlToBytes(ctB64);
  try {
    const ptBuf = await getSubtle().decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(ptBuf));
  } catch {
    throw new Error('Passkey unlock failed — wrong authenticator or corrupted wallet data');
  }
}

// ─── IndexedDB for device-mode keys ──────────────────────────────────

function openKeyDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

async function idbPutKey(credentialIdB64, cryptoKey) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('IndexedDB write failed'));
    };
    tx.objectStore(IDB_STORE).put(cryptoKey, credentialIdB64);
  });
}

async function idbGetKey(credentialIdB64) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(credentialIdB64);
    req.onsuccess = () => {
      db.close();
      resolve(req.result || null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error || new Error('IndexedDB read failed'));
    };
  });
}

async function idbDeleteKey(credentialIdB64) {
  try {
    const db = await openKeyDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
      tx.objectStore(IDB_STORE).delete(credentialIdB64);
    });
  } catch {
    /* ignore */
  }
}

// ─── WebAuthn create / get ───────────────────────────────────────────

function rpId() {
  if (typeof location === 'undefined') return 'localhost';
  return location.hostname || 'localhost';
}

/**
 * Create a discoverable credential.
 * @param {{
 *   displayName?: string,
 *   userIdBytes?: Uint8Array,
 *   prfSalt?: Uint8Array,
 *   preferFingerprint?: boolean, // true = platform (fingerprint/Face ID) first
 * }} opts
 */
export async function createPasskeyCredential({
  displayName,
  userIdBytes,
  prfSalt,
  preferFingerprint = false,
} = {}) {
  if (!isWebAuthnAvailable()) {
    throw new Error(
      'Passkey unlock needs HTTPS and a modern browser (Chrome, Safari, Edge, Firefox).',
    );
  }

  const userId = userIdBytes || randomBytes(16);
  const challenge = randomBytes(32);
  const name = String(displayName || 'Warthog wallet').slice(0, 64);
  const salt = prfSalt || randomBytes(32);

  const prfExt = {
    eval: { first: salt },
  };

  // Default: no authenticatorAttachment → browser can offer password manager
  // (1Password, Bitwarden, Google Password Manager, iCloud Keychain) or device passkey.
  // preferFingerprint=true forces platform only (Face ID / Touch ID / Windows Hello).
  const authenticatorSelection = {
    residentKey: 'required',
    requireResidentKey: true,
    userVerification: 'required',
  };
  if (preferFingerprint) {
    authenticatorSelection.authenticatorAttachment = 'platform';
  }

  const basePublicKey = {
    challenge,
    rp: {
      id: rpId(),
      name: rpDisplayName,
    },
    user: {
      id: userId,
      name: `${name}@warthog`,
      displayName: name,
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection,
    timeout: 120_000,
    attestation: 'none',
    extensions: {
      prf: prfExt,
    },
  };

  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey: basePublicKey });
  } catch (err) {
    const msg = err?.message || String(err);
    if (/NotAllowedError|timed out|cancel|abort/i.test(err?.name || msg)) {
      throw new Error('Passkey setup cancelled');
    }
    // If platform-only failed, retry open so password managers / security keys work
    if (preferFingerprint) {
      try {
        const looseSelection = {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required',
        };
        credential = await navigator.credentials.create({
          publicKey: {
            ...basePublicKey,
            challenge: randomBytes(32),
            authenticatorSelection: looseSelection,
          },
        });
      } catch (err2) {
        throw new Error(err2?.message || msg || 'Failed to create passkey');
      }
    } else {
      throw new Error(msg || 'Failed to create passkey');
    }
  }

  if (!credential || !credential.rawId) {
    throw new Error('Passkey creation returned no credential');
  }

  const credentialId = bytesToBase64Url(new Uint8Array(credential.rawId));
  const ext = credential.getClientExtensionResults?.() || {};
  let prfFirst = null;
  if (ext.prf?.results?.first) {
    prfFirst = new Uint8Array(ext.prf.results.first);
  }
  const prfEnabled = Boolean(ext.prf?.enabled || prfFirst);
  const transports =
    typeof credential.response?.getTransports === 'function'
      ? credential.response.getTransports()
      : [];

  return {
    credential,
    credentialId,
    prfEnabled,
    prfFirst,
    prfSalt: salt,
    transports,
    rpId: rpId(),
    platformPreferred: preferFingerprint,
  };
}

/**
 * Assert passkey + optionally evaluate PRF.
 * userVerification: required → fingerprint / PIN / Face ID on platform authenticators.
 */
export async function assertPasskey({ credentialId, prfSalt, transports } = {}) {
  if (!isWebAuthnAvailable()) {
    throw new Error('Passkey unlock is not available in this browser');
  }
  if (!credentialId) throw new Error('Missing passkey credential id');

  const idBytes = base64UrlToBytes(credentialId);
  const challenge = randomBytes(32);
  const allowCred = {
    type: 'public-key',
    id: idBytes,
  };
  if (Array.isArray(transports) && transports.length) {
    allowCred.transports = transports;
  }

  const publicKey = {
    challenge,
    rpId: rpId(),
    allowCredentials: [allowCred],
    userVerification: 'required',
    timeout: 120_000,
  };

  if (prfSalt) {
    const saltBytes = typeof prfSalt === 'string' ? base64UrlToBytes(prfSalt) : prfSalt;
    publicKey.extensions = {
      prf: {
        eval: {
          first: saltBytes,
        },
      },
    };
  }

  let assertion;
  try {
    assertion = await navigator.credentials.get({ publicKey });
  } catch (err) {
    const msg = err?.message || String(err);
    if (/NotAllowedError|timed out|cancel|abort/i.test(err?.name || msg)) {
      throw new Error('Passkey unlock cancelled');
    }
    throw new Error(msg || 'Passkey unlock failed');
  }

  if (!assertion) throw new Error('Passkey unlock failed');

  const ext = assertion.getClientExtensionResults?.() || {};
  let prfFirst = null;
  if (ext.prf?.results?.first) {
    prfFirst = new Uint8Array(ext.prf.results.first);
  }

  return { assertion, prfFirst };
}

// ─── high-level encrypt / decrypt ────────────────────────────────────

/**
 * Encrypt wallet data under a new passkey.
 * @param {object} walletData
 * @param {{ displayName?: string, preferFingerprint?: boolean }} [opts]
 */
export async function encryptWithNewPasskey(walletData, { displayName, preferFingerprint = false } = {}) {
  if (!walletData?.privateKey || !walletData?.address) {
    throw new Error('Invalid wallet data for passkey encryption');
  }

  const prfSalt = randomBytes(32);
  const created = await createPasskeyCredential({
    displayName: displayName || shortAddressHint(walletData.address) || 'Warthog',
    prfSalt,
    preferFingerprint,
  });

  const payload = walletPayload(walletData);
  let mode = 'device';
  let prfSaltB64 = null;
  let key;
  let prfFirst = created.prfFirst;

  if ((!prfFirst || prfFirst.length < 32) && created.prfEnabled) {
    try {
      const got = await assertPasskey({
        credentialId: created.credentialId,
        prfSalt,
        transports: created.transports,
      });
      prfFirst = got.prfFirst;
    } catch (err) {
      if (/cancelled/i.test(err?.message || '')) throw err;
    }
  }

  if (prfFirst && prfFirst.length >= 32) {
    key = await deriveAesFromPrf(prfFirst);
    mode = 'prf';
    prfSaltB64 = bytesToBase64Url(prfSalt);
  } else {
    const raw = randomBytes(32);
    const nonExtractable = await getSubtle().importKey(
      'raw',
      raw,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    await idbPutKey(created.credentialId, nonExtractable);
    key = nonExtractable;
  }

  const { iv, ciphertext } = await aesGcmEncrypt(key, payload);

  return {
    mode,
    passkey: {
      credentialId: created.credentialId,
      rpId: created.rpId,
      mode,
      prfSalt: prfSaltB64,
      iv,
      ciphertext,
      transports: created.transports || [],
      platformPreferred: preferFingerprint,
    },
  };
}

/**
 * Decrypt envelope.passkey block via WebAuthn (fingerprint / Face ID).
 */
export async function decryptWithPasskey(passkeyBlock) {
  if (!passkeyBlock?.credentialId || !passkeyBlock?.ciphertext) {
    throw new Error('This wallet has no passkey unlock');
  }

  const mode = passkeyBlock.mode || 'device';
  let key;

  if (mode === 'prf') {
    if (!passkeyBlock.prfSalt) {
      throw new Error('Passkey PRF salt missing — re-enable passkey unlock');
    }
    const { prfFirst } = await assertPasskey({
      credentialId: passkeyBlock.credentialId,
      prfSalt: passkeyBlock.prfSalt,
      transports: passkeyBlock.transports,
    });
    if (!prfFirst || prfFirst.length < 32) {
      throw new Error(
        'This device did not return a passkey encryption secret (PRF). Try Chrome/Edge, or re-enable passkey unlock.',
      );
    }
    key = await deriveAesFromPrf(prfFirst);
  } else {
    await assertPasskey({
      credentialId: passkeyBlock.credentialId,
      transports: passkeyBlock.transports,
    });
    key = await idbGetKey(passkeyBlock.credentialId);
    if (!key) {
      throw new Error(
        'Device key missing (site data cleared or different browser). Unlock with password or seed, then re-enable passkey.',
      );
    }
  }

  const data = await aesGcmDecrypt(key, passkeyBlock.iv, passkeyBlock.ciphertext);
  if (!data?.privateKey || !data?.address) {
    throw new Error('Decrypted wallet data is invalid');
  }
  return data;
}

/**
 * Build full envelope with passkey (+ optional password cipher + optional 2FA).
 * @param {object} walletData
 * @param {{
 *   displayName?: string,
 *   existingPasswordCipher?: string|null,
 *   previousEnvelope?: object|null,
 *   require2fa?: boolean,
 *   preferFingerprint?: boolean,
 * }} [opts]
 */
export async function buildEnvelopeWithPasskey(walletData, {
  displayName,
  existingPasswordCipher = null,
  previousEnvelope = null,
  require2fa = false,
  preferFingerprint = false,
} = {}) {
  const { passkey, mode } = await encryptWithNewPasskey(walletData, {
    displayName,
    preferFingerprint,
  });
  const prev = previousEnvelope && previousEnvelope.kind === ENVELOPE_KIND ? previousEnvelope : null;

  if (prev?.passkey?.credentialId && prev.passkey.credentialId !== passkey.credentialId) {
    await idbDeleteKey(prev.passkey.credentialId);
  }

  const password =
    existingPasswordCipher != null
      ? existingPasswordCipher
      : prev?.password != null
        ? prev.password
        : null;

  const want2fa = Boolean(require2fa);
  if (want2fa && !password) {
    throw new Error('2FA needs a password as well — set a password, then enable password + passkey');
  }

  return {
    envelope: {
      v: ENVELOPE_V,
      kind: ENVELOPE_KIND,
      addressHint: shortAddressHint(walletData.address),
      require2fa: want2fa && Boolean(password),
      password,
      passkey,
    },
    mode,
  };
}

/**
 * Merge password cipher into envelope (preserve passkey + require2fa flags).
 */
export function envelopeWithPassword(walletData, passwordCipher, previous = null, { require2fa } = {}) {
  const base =
    previous && previous.kind === ENVELOPE_KIND
      ? { ...previous }
      : emptyEnvelope(walletData?.address);
  base.addressHint = shortAddressHint(walletData?.address) || base.addressHint;
  base.password = passwordCipher;
  if (typeof require2fa === 'boolean') {
    base.require2fa = require2fa && Boolean(passwordCipher) && Boolean(base.passkey);
  } else if (base.require2fa && !passwordCipher) {
    base.require2fa = false;
  }
  return base;
}

/**
 * Toggle require2fa on an existing envelope (both methods must already exist).
 */
export function setEnvelopeRequire2fa(envelope, require2fa) {
  if (!envelope || envelope.kind !== ENVELOPE_KIND) {
    throw new Error('Not a multi-auth wallet envelope');
  }
  const next = { ...envelope };
  if (require2fa) {
    if (!next.password || !next.passkey) {
      throw new Error('2FA needs both a password and passkey unlock saved');
    }
    next.require2fa = true;
  } else {
    next.require2fa = false;
  }
  return next;
}

/**
 * 2FA unlock: password decrypt + fingerprint decrypt; addresses must match.
 * @param {object} envelope
 * @param {string} password
 * @param {(cipher: string, password: string) => object} decryptPasswordFn sync decrypt
 */
export async function unlockEnvelopeWith2fa(envelope, password, decryptPasswordFn) {
  if (!envelope?.password || !envelope?.passkey) {
    throw new Error('2FA unlock needs both password and passkey on this wallet');
  }
  if (!password) throw new Error('Password is required for 2FA unlock');

  let fromPassword;
  try {
    fromPassword = decryptPasswordFn(envelope.password, password);
  } catch {
    throw new Error('Invalid password');
  }

  const fromPasskey = await decryptWithPasskey(envelope.passkey);

  const a = String(fromPassword?.address || '').replace(/^0x/i, '').toLowerCase();
  const b = String(fromPasskey?.address || '').replace(/^0x/i, '').toLowerCase();
  if (!a || !b || a !== b) {
    throw new Error('Password and passkey unlocked different keys — re-enable unlock methods');
  }

  // Prefer passkey payload (may include mnemonic); fall back to password payload fields
  return {
    ...fromPassword,
    ...fromPasskey,
    privateKey: fromPasskey.privateKey || fromPassword.privateKey,
    publicKey: fromPasskey.publicKey || fromPassword.publicKey,
    address: fromPasskey.address || fromPassword.address,
  };
}

/**
 * Human-readable auth label for UI badges.
 */
export function authBadgeForBlob(raw) {
  const info = inspectWalletBlob(raw);
  if (info.require2fa) return 'Password + passkey (2FA)';
  if (info.hasPasskey && info.hasPassword) return 'Passkey or password';
  if (info.hasPasskey) {
    return info.passkeyMode === 'prf' ? 'Passkey' : 'Passkey (this device)';
  }
  if (info.hasPassword) return 'Password';
  return 'Saved';
}

/**
 * Clean device key when deleting a saved wallet.
 */
export async function cleanupPasskeyStorage(raw) {
  const env = tryParseEnvelope(raw);
  if (env?.passkey?.credentialId) {
    await idbDeleteKey(env.passkey.credentialId);
  }
}
