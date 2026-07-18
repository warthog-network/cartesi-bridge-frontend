import { normalizeNodeUrl } from './warthogClient.js';

/** Official Warthog DeFi testnet — used when no node is chosen / stored. */
export const DEFI_TESTNET_URL = 'https://warthog-defitestnet.duckdns.org';

export const DEFAULT_NODE_URL = DEFI_TESTNET_URL;

/**
 * Preset DeFi testnet nodes (dropdown + failover pool).
 * Official is first: default selection and first failover target after the user's pick.
 */
export const PRESET_NODES = [
  { url: DEFI_TESTNET_URL, name: 'Official' },
  { url: 'http://104.251.219.14:3001', name: 'Testnet 2' },
  { url: 'http://65.87.7.86:3002', name: 'Testnet 1' },
  { url: 'http://85.56.145.106:3001', name: 'Testnet 3' },
  { url: 'http://209.127.34.202:3001', name: 'Testnet 4' },
];

/** Mainnet / public main nodes (balance endpoint differs from DeFi). */
export const MAINNET_NODES = [
  { url: 'https://warthognode.duckdns.org', name: 'Mainnet (Official)' },
  { url: 'http://217.182.64.43:3001', name: 'Mainnet 2' },
  { url: 'http://65.87.7.86:3001', name: 'Mainnet 3' },
];

export const PRESET_NODE_URLS = PRESET_NODES.map((n) => normalizeNodeUrl(n.url));

/** True when the node URL matches a preset DeFi entry (normalized). */
export const isPresetNodeUrl = (node) =>
  PRESET_NODE_URLS.includes(normalizeNodeUrl(node));

/** True for DeFi / testnet nodes (wart_balance, Assets, DEX, vaults, etc.). */
export const isDefiNode = (node) => {
  const n = normalizeNodeUrl(node).toLowerCase();
  if (!n) return false;
  if (isPresetNodeUrl(n)) return true;
  if (n.includes('defitestnet') || n.includes('testnet')) return true;
  if (n.includes('localhost') || n.includes('127.0.0.1')) return true;
  if (n.includes(':3002')) return true;
  return false;
};

/**
 * Mainnet nodes use /account/:addr/balance; DeFi testnet nodes use /wart_balance.
 */
export const isMainnetNode = (node) => !isDefiNode(node);

/** Normalize a stored node URL, falling back to the default when empty/invalid. */
export function resolveSavedNodeUrl(raw) {
  return normalizeNodeUrl(raw || '') || DEFAULT_NODE_URL;
}

/**
 * Ordered candidates for live-node failover.
 * Always tries `preferred` first. For DeFi/testnet nodes, continues through presets.
 * Mainnet / non-DeFi custom nodes are not auto-switched to testnet presets.
 */
export function buildFailoverCandidates(preferred) {
  const preferredNorm = resolveSavedNodeUrl(preferred);
  const candidates = [preferredNorm];

  if (!isDefiNode(preferredNorm)) {
    return candidates;
  }

  for (const { url } of PRESET_NODES) {
    const normalized = normalizeNodeUrl(url);
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  }
  return candidates;
}
