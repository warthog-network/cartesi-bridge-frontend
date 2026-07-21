/**
 * Shared bridge / rollup config for browser components.
 * GraphQL goes through the Vite `/rollup` proxy when on the frontend dev server.
 *
 * Network switch (Anvil vs Sepolia): see `networks.js` + PUBLIC_NETWORK.
 *
 * NOTE: graphql-request uses `new URL(endpoint)` and rejects relative paths like
 * `/rollup/graphql`. Always resolve with getRollupGraphqlUrl() in the browser.
 */

import {
  getNetwork,
  getAddresses,
  getNetworkId,
  getWwartToken,
  isOpenMintAllowed,
  isSepoliaConfigured,
  ANVIL,
  SEPOLIA,
  NETWORKS,
} from './networks.js';

export {
  getNetwork,
  getAddresses,
  getNetworkId,
  getWwartToken,
  isOpenMintAllowed,
  isSepoliaConfigured,
  ANVIL,
  SEPOLIA,
  NETWORKS,
};

export const ROLLUP_GRAPHQL_URL =
  (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_GRAPHQL_URL) ||
  '/rollup/graphql';

export const INSPECT_URL =
  (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_INSPECT_URL) ||
  '/rollup/inspect';

export const L1_RPC_URL =
  (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_L1_RPC) ||
  'http://localhost:8545';

/** Make a path absolute for fetch / GraphQLClient (browser-safe). */
export function resolveAppUrl(pathOrUrl) {
  if (pathOrUrl == null || pathOrUrl === '') return pathOrUrl;
  const s = String(pathOrUrl);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return s; // already absolute (http, https, …)
  if (typeof window !== 'undefined' && window.location?.origin) {
    try {
      return new URL(s, window.location.origin).href;
    } catch {
      /* fall through */
    }
  }
  // SSR / node fallback for local Cartesi
  if (s.startsWith('/rollup')) {
    return `http://127.0.0.1:8080${s.replace(/^\/rollup/, '')}`;
  }
  return s;
}

/** Absolute GraphQL endpoint for graphql-request. */
export function getRollupGraphqlUrl() {
  return resolveAppUrl(ROLLUP_GRAPHQL_URL);
}

/** Absolute inspect base (no trailing slash issues). */
export function getInspectUrl() {
  return resolveAppUrl(INSPECT_URL);
}

/**
 * Cartesi L1 addresses for the active network.
 * Defaults remain CLI 1.5 Anvil (Mode A usability lock).
 * Prefer getAddresses() for new code.
 */
export const LOCAL_ADDRESSES = {
  dapp: ANVIL.contracts.dapp,
  inputBox: ANVIL.contracts.inputBox,
  etherPortal: ANVIL.contracts.etherPortal,
  erc20Portal: ANVIL.contracts.erc20Portal,
  dappAddressRelay: ANVIL.contracts.dappAddressRelay,
};

/** Active-network address book (Anvil or Sepolia placeholders). */
export const ACTIVE_ADDRESSES = getAddresses();

/** Storage key material for sub-wallet list (not a secret wallet key — list is non-custodial addresses). */
export function subWalletStorageSecret(mainAddress) {
  const addr = (mainAddress || 'anon').toLowerCase();
  return `cartesi-bridge-subwallets-v1:${addr}`;
}
