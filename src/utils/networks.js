/**
 * Multi-network address book: Anvil (Mode A demo) vs Sepolia (Mode B product path).
 *
 * Selection (first match wins):
 *   1. import.meta.env.PUBLIC_NETWORK   — "anvil" | "sepolia"
 *   2. import.meta.env.PUBLIC_CHAIN_ID  — "31337" | "11155111"
 *   3. default "anvil" (usability lock: live DuckDNS stays on Anvil until staged)
 *
 * Sepolia addresses are placeholders until Mode B deploy fills them
 * (see docs/MODE-B-SEPOLIA.md). Override via PUBLIC_* env at build time.
 */

import { LOCAL_WWART } from './localTokens.js';

/** @typedef {'anvil' | 'sepolia'} NetworkId */

export const NETWORK_IDS = /** @type {const} */ (['anvil', 'sepolia']);

/**
 * Cartesi CLI 1.5 Anvil book + this VPS mock/minter tokens.
 * minterWwart is filled by scripts/deploy-minter-wwart.mjs (lab); live demo still uses wwart.
 */
export const ANVIL = {
  id: 'anvil',
  label: 'Cartesi Bridge Anvil (demo)',
  chainId: 31337,
  chainIdHex: '0x7a69',
  /** Public RPC for MetaMask on this VPS (DuckDNS). */
  rpcUrl:
    (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_L1_RPC) ||
    'https://cartesi-bridge.duckdns.org/rpc',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  contracts: {
    dapp: '0xab7528bb862fB57E8A2BCd567a2e929a0Be56a5e',
    inputBox: '0x59b22D57D4f067708AB0c00552767405926dc768',
    etherPortal: '0xFfdbe43d4c855BF7e0f105c400A50857f53AB044',
    erc20Portal: '0x9C21AEb2093C32DDbC53eEF24B873BDCd1aDa1DB',
    dappAddressRelay: '0xF5DE34d6BbC0446E2a45719E718efEbaaE179daE',
    /** Live demo token — promoted MinterWWART (minter-only). */
    wwart: LOCAL_WWART.address,
    /**
     * Product-shaped minter-only token (MinterWWART).
     * Updated by deploy-minter-wwart.mjs; zero means not deployed yet.
     */
    minterWwart: '0x663F3ad617193148711d28f5334eE4Ed07016602',
  },
  tokens: {
    wwart: {
      address: LOCAL_WWART.address,
      symbol: 'wWART',
      name: LOCAL_WWART.name || 'Wrapped WART (mock)',
      decimals: 18,
      openMint: Boolean(LOCAL_WWART.openMint),
      minterOnly: Boolean(LOCAL_WWART.minterOnly),
      note: LOCAL_WWART.note,
    },
  },
  rollup: {
    graphql:
      (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_GRAPHQL_URL) ||
      '/rollup/graphql',
    inspect:
      (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_INSPECT_URL) ||
      '/rollup/inspect',
  },
  isDemo: true,
  allowOpenMint: false,
};

/**
 * Sepolia Mode B placeholders — filled after cartesi deploy + MinterWWART deploy.
 * Build flags:
 *   PUBLIC_NETWORK=sepolia
 *   PUBLIC_SEPOLIA_DAPP=0x…
 *   PUBLIC_SEPOLIA_WWART=0x…
 *   PUBLIC_L1_RPC=https://…sepolia…
 */
function envAddr(key) {
  if (typeof import.meta === 'undefined') return '';
  const v = import.meta.env?.[key];
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : '';
}

const ZERO = '0x0000000000000000000000000000000000000000';

export const SEPOLIA = {
  id: 'sepolia',
  label: 'Sepolia (Mode B)',
  chainId: 11155111,
  chainIdHex: '0xaa36a7',
  rpcUrl:
    (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_L1_RPC) ||
    (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_SEPOLIA_RPC) ||
    '',
  nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
  contracts: {
    dapp: envAddr('PUBLIC_SEPOLIA_DAPP') || ZERO,
    inputBox: envAddr('PUBLIC_SEPOLIA_INPUTBOX') || ZERO,
    etherPortal: envAddr('PUBLIC_SEPOLIA_ETHER_PORTAL') || ZERO,
    erc20Portal: envAddr('PUBLIC_SEPOLIA_ERC20_PORTAL') || ZERO,
    dappAddressRelay: envAddr('PUBLIC_SEPOLIA_DAPP_RELAY') || ZERO,
    wwart: envAddr('PUBLIC_SEPOLIA_WWART') || ZERO,
    minterWwart: envAddr('PUBLIC_SEPOLIA_WWART') || ZERO,
  },
  tokens: {
    wwart: {
      address: envAddr('PUBLIC_SEPOLIA_WWART') || ZERO,
      symbol: 'wWART',
      name: 'Wrapped WART',
      decimals: 18,
      openMint: false,
      minterOnly: true,
      note: 'Sepolia minter-only. Never open-mint on public path.',
    },
  },
  rollup: {
    graphql:
      (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_GRAPHQL_URL) ||
      '',
    inspect:
      (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_INSPECT_URL) ||
      '',
  },
  isDemo: false,
  allowOpenMint: false,
};

export const NETWORKS = {
  anvil: ANVIL,
  sepolia: SEPOLIA,
};

/**
 * Resolve active network id from build env. Defaults to anvil (live demo lock).
 * @returns {NetworkId}
 */
export function getNetworkId() {
  const raw =
    (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_NETWORK) ||
    '';
  const n = String(raw).toLowerCase().trim();
  if (n === 'sepolia' || n === 'anvil') return n;

  const chainRaw =
    (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_CHAIN_ID) ||
    '';
  const c = String(chainRaw).trim();
  if (c === '11155111' || c === '0xaa36a7') return 'sepolia';
  if (c === '31337' || c === '0x7a69') return 'anvil';

  return 'anvil';
}

/** Full config for the active network. */
export function getNetwork() {
  return NETWORKS[getNetworkId()] || ANVIL;
}

/** Cartesi L1 addresses for the active network (dapp, portals, …). */
export function getAddresses() {
  return getNetwork().contracts;
}

/**
 * Canonical wWART token metadata for UI.
 * Prefer minter-only when configured and non-zero; else demo wwart.
 */
export function getWwartToken() {
  const net = getNetwork();
  const t = net.tokens?.wwart;
  if (!t) {
    return {
      address: ZERO,
      symbol: 'wWART',
      decimals: 18,
      openMint: false,
      minterOnly: true,
    };
  }
  return { ...t, openMint: false }; // product rule: never expose open mint as true on public builds
}

/** True only if this build intentionally allows demo open-mint (always false for now). */
export function isOpenMintAllowed() {
  const net = getNetwork();
  if (net.allowOpenMint !== true) return false;
  return Boolean(net.tokens?.wwart?.openMint);
}

/** Whether Sepolia placeholders are filled enough to switch FE. */
export function isSepoliaConfigured() {
  const c = SEPOLIA.contracts;
  return (
    c.dapp !== ZERO &&
    c.wwart !== ZERO &&
    Boolean(SEPOLIA.rpcUrl) &&
    Boolean(SEPOLIA.rollup.graphql)
  );
}
