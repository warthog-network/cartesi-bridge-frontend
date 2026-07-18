/**
 * Shared bridge / rollup config for browser components.
 * GraphQL goes through the Vite `/rollup` proxy when on the frontend dev server.
 *
 * NOTE: graphql-request uses `new URL(endpoint)` and rejects relative paths like
 * `/rollup/graphql`. Always resolve with getRollupGraphqlUrl() in the browser.
 */

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

/** Cartesi CLI 1.5 local Anvil */
export const LOCAL_ADDRESSES = {
  dapp: '0xab7528bb862fB57E8A2BCd567a2e929a0Be56a5e',
  inputBox: '0x59b22D57D4f067708AB0c00552767405926dc768',
  etherPortal: '0xFfdbe43d4c855BF7e0f105c400A50857f53AB044',
  erc20Portal: '0x9C21AEb2093C32DDbC53eEF24B873BDCd1aDa1DB',
  dappAddressRelay: '0xF5DE34d6BbC0446E2a45719E718efEbaaE179daE',
};

/** Storage key material for sub-wallet list (not a secret wallet key — list is non-custodial addresses). */
export function subWalletStorageSecret(mainAddress) {
  const addr = (mainAddress || 'anon').toLowerCase();
  return `cartesi-bridge-subwallets-v1:${addr}`;
}
