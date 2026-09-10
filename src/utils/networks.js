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

function envAddr(key) {
  if (typeof import.meta === 'undefined') return '';
  const v = import.meta.env?.[key];
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : '';
}

const ZERO = '0x0000000000000000000000000000000000000000';

/** Build-time rollups API selector (bridgeConfig.js reads the same var). */
const ROLLUPS_V2 =
  typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_ROLLUPS_API === 'v2';

/**
 * Cartesi rollups v2 devnet base contracts (cartesi/sdk 0.12 anvil state,
 * chain 31337). Verified with eth_getCode on the live v2 anvil 2026-09-10;
 * the ERC20Portal is the only devnet contract carrying selector 0x95854b81
 * (depositERC20Tokens), the EtherPortal the only one with 0x938c054f.
 */
export const CARTESI_V2_DEVNET_BASE = {
  inputBox: '0x346B3df038FE9f8380071eC6514D5a83aD143939',
  etherPortal: '0x8b53327575ac999bdfa8003f4b5134DFF9027516',
  erc20Portal: '0x22E57511C30CcE6CDaa742E13CE3b774fDC663b1',
  selfHostedApplicationFactory: '0x6145C5996a71a379E030aEb0440df79D60833418',
};

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
    // Rollups v2 (PUBLIC_ROLLUPS_API=v2): the Application address comes from the
    // build env and the base contracts are the v2 devnet ones — the 1.x CREATE2
    // addresses below have NO code on the cartesi/sdk 0.12 anvil.
    dapp: envAddr('PUBLIC_APP_ADDRESS') || '0xab7528bb862fB57E8A2BCd567a2e929a0Be56a5e',
    inputBox:
      envAddr('PUBLIC_INPUT_BOX_ADDRESS') ||
      (ROLLUPS_V2 ? CARTESI_V2_DEVNET_BASE.inputBox : '0x59b22D57D4f067708AB0c00552767405926dc768'),
    etherPortal:
      envAddr('PUBLIC_ETHER_PORTAL_ADDRESS') ||
      (ROLLUPS_V2 ? CARTESI_V2_DEVNET_BASE.etherPortal : '0xFfdbe43d4c855BF7e0f105c400A50857f53AB044'),
    erc20Portal:
      envAddr('PUBLIC_ERC20_PORTAL_ADDRESS') ||
      (ROLLUPS_V2 ? CARTESI_V2_DEVNET_BASE.erc20Portal : '0x9C21AEb2093C32DDbC53eEF24B873BDCd1aDa1DB'),
    /** 1.x only — v2 puts app_contract in every input; zero on v2. */
    dappAddressRelay: ROLLUPS_V2 ? ZERO : '0xF5DE34d6BbC0446E2a45719E718efEbaaE179daE',
    /** Live demo token — promoted MinterWWART (minter-only). */
    wwart: LOCAL_WWART.address,
    /**
     * Product-shaped minter-only token (MinterWWART).
     * Updated by deploy-minter-wwart.mjs; zero means not deployed yet.
     */
    minterWwart: '0xBc174Ba3265e5E0FbdEFa2A8c9FDa5F334471287',
    /** ETH 3P deposit adapter. Filled by deploy-eth3p-adapter.mjs --promote. */
    eth3pAdapter: '0x2E983A1Ba5e8b38AAAeC4B440B9dDcFBf72E15d1',
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
 * Sepolia Mode B — dapp/wwart filled after cartesi deploy + MinterWWART deploy.
 * Portals/relay are Cartesi CLI 1.5 CREATE2 addresses (same as Anvil; verified
 * on Sepolia public RPC 2026-07-28). Override via PUBLIC_SEPOLIA_* if redeployed.
 *
 * Build flags:
 *   PUBLIC_NETWORK=sepolia
 *   PUBLIC_SEPOLIA_DAPP=0x…
 *   PUBLIC_SEPOLIA_WWART=0x…
 *   PUBLIC_L1_RPC=https://…sepolia…
 */

/** Cartesi rollups 1.x base contracts (CREATE2) — confirmed code on Sepolia. */
export const CARTESI_SEPOLIA_BASE = {
  inputBox: '0x59b22D57D4f067708AB0c00552767405926dc768',
  etherPortal: '0xFfdbe43d4c855BF7e0f105c400A50857f53AB044',
  erc20Portal: '0x9C21AEb2093C32DDbC53eEF24B873BDCd1aDa1DB',
  dappAddressRelay: '0xF5DE34d6BbC0446E2a45719E718efEbaaE179daE',
};

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
    /** Per-app Application — zero until Mode B deploy + PUBLIC_SEPOLIA_DAPP. */
    dapp: envAddr('PUBLIC_SEPOLIA_DAPP') || ZERO,
    inputBox: envAddr('PUBLIC_SEPOLIA_INPUTBOX') || CARTESI_SEPOLIA_BASE.inputBox,
    etherPortal:
      envAddr('PUBLIC_SEPOLIA_ETHER_PORTAL') || CARTESI_SEPOLIA_BASE.etherPortal,
    erc20Portal:
      envAddr('PUBLIC_SEPOLIA_ERC20_PORTAL') || CARTESI_SEPOLIA_BASE.erc20Portal,
    dappAddressRelay:
      envAddr('PUBLIC_SEPOLIA_DAPP_RELAY') || CARTESI_SEPOLIA_BASE.dappAddressRelay,
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
