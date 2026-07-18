/**
 * Named encrypted wallets (wartbunker-compatible key prefix).
 * Keys: warthogWallet_${name}
 * Legacy single slot: warthogWallet
 */

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

/** Ciphertext for a named wallet, or null */
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
 * @param {string} encryptedCipher AES ciphertext string
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
    if (localStorage.getItem(key) == null) return false;
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
    localStorage.removeItem(LEGACY_WALLET_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * All selectable entries for the login UI.
 * @returns {{ id: string, label: string, kind: 'named' | 'legacy' }[]}
 */
export function listWalletEntries() {
  const entries = listNamedWallets().map((name) => ({
    id: name,
    label: name,
    kind: 'named',
  }));
  if (hasLegacyWallet()) {
    entries.unshift({
      id: '__legacy__',
      label: 'Default (legacy)',
      kind: 'legacy',
    });
  }
  return entries;
}
