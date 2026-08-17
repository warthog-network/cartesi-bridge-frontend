/**
 * WalletConnect (Reown) — mobile-friendly connect modal.
 *
 * Opens the standard WC modal (MetaMask, Rabby, Trust, …) so phone users can
 * scan / deep-link without browser extensions. Returns an EIP-1193 provider
 * usable with ethers BrowserProvider.
 *
 * Project ID: set PUBLIC_WALLETCONNECT_PROJECT_ID at build time
 * (https://dashboard.reown.com). Allowlist cartesi-bridge.duckdns.org.
 */

import { getNetwork } from './networks.js';

/** Reown Cloud project id (public; not a secret). Override via env at build. */
export const WALLETCONNECT_PROJECT_ID =
  (typeof import.meta !== 'undefined' &&
    import.meta.env?.PUBLIC_WALLETCONNECT_PROJECT_ID) ||
  // cartesi-bridge.duckdns.org (dashboard.reown.com)
  '3fd0da9136699718844606546ee3df65';

/** Featured wallets in the modal (WalletConnect explorer IDs). */
const FEATURED_WALLET_IDS = [
  'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96', // MetaMask
  '4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0', // Trust
  'fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa', // Coinbase
  '1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369', // Rainbow
];

/** @type {import('@walletconnect/ethereum-provider').default | null} */
let wcProvider = null;

/**
 * True if localStorage still has a WC / Reown session we should resume.
 * Used so page load does not init the heavy WC provider (and its EIP-6963
 * traffic) unless there is something to resume.
 */
export function hasStoredWalletConnectSession() {
  if (typeof localStorage === 'undefined') return false;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || '';
      if (!/wc@2|walletconnect|WCM_|@w3m|reown/i.test(k)) continue;
      const v = localStorage.getItem(k);
      if (v && v !== 'null' && v !== '{}' && v !== '[]') return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function siteUrl() {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'https://cartesi-bridge.duckdns.org';
}

function activeChainConfig() {
  const net = getNetwork() || {};
  const chainId = Number(net.chainId) || 31337;
  const rpc =
    net.rpcUrl ||
    (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_L1_RPC) ||
    'https://cartesi-bridge.duckdns.org/rpc';
  return { chainId, rpc, label: net.label || 'Cartesi Bridge' };
}

/**
 * Init (or reuse) WalletConnect EthereumProvider with QR / wallet list modal.
 */
export async function getWalletConnectProvider() {
  if (typeof window === 'undefined') {
    throw new Error('WalletConnect requires a browser');
  }
  if (wcProvider) return wcProvider;

  const { default: EthereumProvider } = await import(
    '@walletconnect/ethereum-provider'
  );

  const { chainId, rpc } = activeChainConfig();
  const projectId = WALLETCONNECT_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      'Missing PUBLIC_WALLETCONNECT_PROJECT_ID — create one at https://dashboard.reown.com',
    );
  }

  // optionalChains only: wallet can connect even if not on Anvil yet; we switch after.
  wcProvider = await EthereumProvider.init({
    projectId,
    showQrModal: true,
    optionalChains: [chainId, 1, 11155111, 137, 10, 42161, 8453],
    rpcMap: {
      [chainId]: rpc,
    },
    metadata: {
      name: 'WART Bridge',
      description: 'Warthog × Cartesi bridge',
      url: siteUrl(),
      icons: [`${siteUrl()}/favicon.svg`],
    },
    qrModalOptions: {
      themeMode: 'dark',
      themeVariables: {
        '--wcm-z-index': '100000',
        '--w3m-z-index': '100000',
      },
      explorerRecommendedWalletIds: FEATURED_WALLET_IDS,
      enableExplorer: true,
    },
  });

  return wcProvider;
}

/**
 * Open WalletConnect modal, wait for session, return EIP-1193 provider.
 * @returns {Promise<object>} EIP-1193 provider (isWalletConnect)
 */
export async function connectWalletConnect() {
  const provider = await getWalletConnectProvider();

  // Already connected session (page refresh)
  if (provider.session && Array.isArray(provider.accounts) && provider.accounts.length) {
    return provider;
  }

  await provider.connect();
  return provider;
}

/**
 * Disconnect WalletConnect session if active.
 */
export async function disconnectWalletConnect() {
  try {
    if (wcProvider?.disconnect) {
      await wcProvider.disconnect();
    }
  } catch (e) {
    console.warn('[walletconnect] disconnect', e?.message || e);
  } finally {
    // Allow re-init after hard disconnect
    wcProvider = null;
  }
}

export function isWalletConnectProvider(provider) {
  return !!(provider && (provider.isWalletConnect || provider.session));
}

export function getActiveWalletConnectProvider() {
  return wcProvider;
}
