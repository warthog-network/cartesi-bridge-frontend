/**
 * Pure ESM Node `crypto` polyfill for the browser.
 * Avoids crypto-browserify (CJS exports/require) entirely.
 *
 * Used by warthog-js (createHash('sha256')) and ensureWorkerCrypto.
 */
import { sha256, sha512, sha224, sha384 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { pbkdf2 as noblePbkdf2 } from '@noble/hashes/pbkdf2.js';

function toBytes(data) {
  if (data == null) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  throw new TypeError('Unsupported crypto input type');
}

function toBuffer(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes);
  }
  return bytes;
}

const HASH_FNS = {
  sha256,
  sha512,
  sha224,
  sha384,
};

class Hash {
  constructor(algo) {
    const fn = HASH_FNS[algo];
    if (!fn) {
      throw new Error(`Digest method not supported: ${algo}`);
    }
    this._algo = algo;
    this._fn = fn;
    this._parts = [];
  }

  update(data, _encoding) {
    this._parts.push(toBytes(data));
    return this;
  }

  digest(encoding) {
    const totalLen = this._parts.reduce((n, p) => n + p.length, 0);
    const joined = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of this._parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    const out = this._fn(joined);
    if (encoding === 'hex') {
      return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    if (encoding === 'base64') {
      let s = '';
      for (const b of out) s += String.fromCharCode(b);
      return btoa(s);
    }
    return toBuffer(out);
  }
}

class Hmac {
  constructor(algo, key) {
    const fn = HASH_FNS[algo];
    if (!fn) {
      throw new Error(`Digest method not supported: ${algo}`);
    }
    this._fn = fn;
    this._key = toBytes(key);
    this._parts = [];
  }

  update(data, _encoding) {
    this._parts.push(toBytes(data));
    return this;
  }

  digest(encoding) {
    const totalLen = this._parts.reduce((n, p) => n + p.length, 0);
    const joined = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of this._parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    const out = hmac(this._fn, this._key, joined);
    if (encoding === 'hex') {
      return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
    }
    return toBuffer(out);
  }
}

export function createHash(algo) {
  return new Hash(String(algo).toLowerCase());
}

export function createHmac(algo, key) {
  return new Hmac(String(algo).toLowerCase(), key);
}

export function randomBytes(size) {
  const out = new Uint8Array(size);
  const cryptoObj =
    (typeof globalThis !== 'undefined' && globalThis.crypto) ||
    (typeof window !== 'undefined' && window.crypto);
  if (!cryptoObj?.getRandomValues) {
    throw new Error('Secure randomBytes not available in this environment');
  }
  cryptoObj.getRandomValues(out);
  return toBuffer(out);
}

export function pbkdf2Sync(password, salt, iterations, keylen, digest) {
  const algo = HASH_FNS[String(digest || 'sha256').toLowerCase()];
  if (!algo) {
    throw new Error(`Unsupported pbkdf2 digest: ${digest}`);
  }
  const out = noblePbkdf2(algo, toBytes(password), toBytes(salt), {
    c: iterations,
    dkLen: keylen,
  });
  return toBuffer(out);
}

export function pbkdf2(password, salt, iterations, keylen, digest, callback) {
  try {
    const result = pbkdf2Sync(password, salt, iterations, keylen, digest);
    if (callback) queueMicrotask(() => callback(null, result));
    return result;
  } catch (err) {
    if (callback) queueMicrotask(() => callback(err));
    else throw err;
  }
}

const cryptoShim = {
  createHash,
  createHmac,
  randomBytes,
  pbkdf2Sync,
  pbkdf2,
};

export default cryptoShim;
