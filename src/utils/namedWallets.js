/**
 * Named encrypted wallets (wartbunker-compatible key prefix).
 * Keys: warthogWallet_${name}
 * Legacy single slot: warthogWallet
 *
 * Values may be:
 *  - legacy CryptoJS AES ciphertext (password)
 *  - warthog-wallet-v1 JSON envelope (password and/or passkey)
 */

import {
  inspectWalletBlob,
  authBadgeForBlob,
  cleanupPasskeyStorage,
} from './passkeyWallet.js';

export const NAMED_WALLET_PREFIX = 'warthogWallet_';
export const LEGACY_WALLET_KEY = 'warthogWallet';
export const LAST_WALLET_NAME_KEY = 'warthogLastWalletName';

/** @returns {string[]} sorted display names */
export function listNamedWallets() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const names = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(NAMED_WALLET_PREFIX)) {
        names.push(key.slice(NAMED_WALLET_PREFIX.length));
      }
    }
    return names.sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function namedWalletStorageKey(name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('Wallet name is required');
  if (n.includes('/') || n.includes('\\')) {
    throw new Error('Wallet name cannot contain slashes');
  }
  return `${NAMED_WALLET_PREFIX}${n}`;
}

export function hasLegacyWallet() {
  try {
    return Boolean(localStorage.getItem(LEGACY_WALLET_KEY));
  } catch {
    return false;
  }
}

/** Ciphertext / envelope for a named wallet, or null */
export function getNamedWalletCipher(name) {
  try {
    return localStorage.getItem(namedWalletStorageKey(name));
  } catch {
    return null;
  }
}

export function getLegacyWalletCipher() {
  try {
    return localStorage.getItem(LEGACY_WALLET_KEY);
  } catch {
    return null;
  }
}

/**
 * @param {string} name
 * @param {string} encryptedCipher AES ciphertext string or envelope JSON
 */
export function saveNamedWalletCipher(name, encryptedCipher) {
  const key = namedWalletStorageKey(name);
  localStorage.setItem(key, encryptedCipher);
  try {
    localStorage.setItem(LAST_WALLET_NAME_KEY, String(name).trim());
  } catch {
    /* ignore */
  }
}

/** Optional: keep wartbunker-style last-used pointer */
export function getLastWalletName() {
  try {
    return localStorage.getItem(LAST_WALLET_NAME_KEY) || '';
  } catch {
    return '';
  }
}

export function setLastWalletName(name) {
  try {
    if (name) localStorage.setItem(LAST_WALLET_NAME_KEY, String(name).trim());
    else localStorage.removeItem(LAST_WALLET_NAME_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Delete one named wallet. Does not touch session/sub-wallets.
 * @returns {boolean} true if a key was removed
 */
export function deleteNamedWallet(name) {
  try {
    const key = namedWalletStorageKey(name);
    const raw = localStorage.getItem(key);
    if (raw == null) return false;
    // fire-and-forget cleanup of device AES keys
    try {
      void cleanupPasskeyStorage(raw);
    } catch {
      /* ignore */
    }
    localStorage.removeItem(key);
    if (getLastWalletName() === String(name).trim()) {
      setLastWalletName('');
    }
    return true;
  } catch {
    return false;
  }
}

/** Remove legacy single-slot key only */
export function deleteLegacyWallet() {
  try {
    const raw = localStorage.getItem(LEGACY_WALLET_KEY);
    if (raw) {
      try {
        void cleanupPasskeyStorage(raw);
      } catch {
        /* ignore */
      }
    }
    localStorage.removeItem(LEGACY_WALLET_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * All selectable entries for the login UI.
 * @returns {{ id: string, label: string, kind: 'named' | 'legacy', hasPasskey: boolean, hasPassword: boolean, require2fa: boolean, authBadge: string, addressHint: string }[]}
 */
export function listWalletEntries() {
  const entries = listNamedWallets().map((name) => {
    const raw = getNamedWalletCipher(name);
    const info = inspectWalletBlob(raw);
    return {
      id: name,
      label: name,
      kind: 'named',
      hasPasskey: info.hasPasskey,
      hasPassword: info.hasPassword,
      require2fa: info.require2fa,
      authBadge: authBadgeForBlob(raw),
      addressHint: info.addressHint || '',
    };
  });
  if (hasLegacyWallet()) {
    const raw = getLegacyWalletCipher();
    const info = inspectWalletBlob(raw);
    entries.unshift({
      id: '__legacy__',
      label: 'Default (legacy)',
      kind: 'legacy',
      hasPasskey: info.hasPasskey,
      hasPassword: info.hasPassword,
      require2fa: info.require2fa,
      authBadge: authBadgeForBlob(raw),
      addressHint: info.addressHint || '',
    });
  }
  return entries;
}

/** Raw stored blob for an entry id (named name or __legacy__). */
export function getWalletBlobForEntry(entryId) {
  if (!entryId) return null;
  if (entryId === '__legacy__') return getLegacyWalletCipher();
  return getNamedWalletCipher(entryId);
}
