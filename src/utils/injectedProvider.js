/**
 * Discover EIP-1193 browser wallets (MetaMask, Rabby, Brave, etc.).
 *
 * - EIP-6963 announcements (best multi-wallet support)
 * - window.ethereum.providers[] (legacy multi-inject)
 * - window.ethereum / window.rabby fallbacks
 *
 * When several are present (e.g. Brave + MetaMask + Rabby), callers should
 * show a picker via listInjectedWallets() instead of auto-picking.
 */

/** @typedef {{ info?: { uuid?: string, name?: string, rdns?: string, icon?: string }, provider: object }} Eip6963Detail */

/** @typedef {{
 *   id: string,
 *   name: string,
 *   rdns?: string,
 *   icon?: string|null,
 *   provider: object,
 *   source: string,
 * }} InjectedWallet */

/** @type {Map<string, Eip6963Detail>} */
const announced = new Map();

let listening = false;
/** @type {object|null} */
let preferredProvider = null;

const PREFERRED_KEY = 'cartesi.preferredWalletRdns';

function detailKey(detail) {
  return (
    detail?.info?.uuid ||
    detail?.info?.rdns ||
    detail?.info?.name ||
    `anon-${announced.size}`
  );
}

function onAnnounce(event) {
  const detail = event?.detail;
  if (!detail?.provider) return;
  announced.set(detailKey(detail), detail);
}

/** Start collecting EIP-6963 announcements (safe to call many times). */
export function startProviderDiscovery() {
  if (typeof window === 'undefined') return;
  if (!listening) {
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    listening = true;
  }
  try {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  } catch {
    /* ignore */
  }
}

/**
 * Guess a friendly name from provider flags / rdns.
 * @param {object} provider
 * @param {string} [hint]
 * @param {string} [rdns]
 */
export function nameFromProvider(provider, hint, rdns) {
  if (hint && String(hint).trim()) return String(hint).trim();
  const r = String(rdns || '').toLowerCase();
  if (r.includes('rabby')) return 'Rabby';
  if (r.includes('metamask')) return 'MetaMask';
  if (r.includes('brave')) return 'Brave Wallet';
  if (r.includes('coinbase')) return 'Coinbase Wallet';
  if (r.includes('okx')) return 'OKX Wallet';
  if (provider?.isRabby || provider?._isRabby) return 'Rabby';
  if (provider?.isBraveWallet) return 'Brave Wallet';
  if (provider?.isCoinbaseWallet) return 'Coinbase Wallet';
  // MetaMask sets isMetaMask; Rabby/Brave sometimes do too — checked after Rabby/Brave
  if (provider?.isMetaMask) return 'MetaMask';
  return 'Browser wallet';
}

/**
 * Stable de-dupe key so the same wallet is not listed thrice (6963 + providers + ethereum).
 * @param {object} provider
 * @param {string} [rdns]
 * @param {string} [name]
 */
function walletDedupeKey(provider, rdns, name) {
  if (rdns) return `rdns:${String(rdns).toLowerCase()}`;
  const n = nameFromProvider(provider, name, rdns).toLowerCase();
  if (n !== 'browser wallet') return `name:${n}`;
  // last resort: object identity
  return null;
}

/**
 * Snapshot of discovered wallets (EIP-6963 + legacy injects), de-duplicated.
 * @returns {InjectedWallet[]}
 */
export function listInjectedWallets() {
  if (typeof window === 'undefined') return [];
  startProviderDiscovery();

  /** @type {InjectedWallet[]} */
  const out = [];
  const seenProvider = new Set();
  const seenKey = new Set();

  const push = (provider, name, source, id, rdns, icon) => {
    if (!provider || typeof provider.request !== 'function') return;
    if (seenProvider.has(provider)) return;
    const label = nameFromProvider(provider, name, rdns);
    const key = walletDedupeKey(provider, rdns, label);
    if (key && seenKey.has(key)) return;
    seenProvider.add(provider);
    if (key) seenKey.add(key);
    out.push({
      id: id || `${source}-${out.length}`,
      name: label,
      rdns: rdns || undefined,
      icon: icon || null,
      provider,
      source,
    });
  };

  // 1) EIP-6963 (includes icons + stable rdns — best multi-wallet list)
  for (const [id, detail] of announced) {
    push(
      detail.provider,
      detail.info?.name || 'Wallet',
      'eip6963',
      id,
      detail.info?.rdns,
      detail.info?.icon || null,
    );
  }

  const eth = window.ethereum;
  if (eth) {
    const list = Array.isArray(eth.providers) ? eth.providers : null;
    if (list?.length) {
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        push(p, nameFromProvider(p), 'providers', `providers-${i}`);
      }
    } else {
      push(eth, nameFromProvider(eth), 'window.ethereum', 'window-ethereum');
    }
  }

  if (window.rabby) {
    push(window.rabby, 'Rabby', 'window.rabby', 'window-rabby', 'io.rabby');
  }

  // Stable sort: Rabby, MetaMask, Brave, then alpha
  const rank = (name) => {
    const n = String(name || '').toLowerCase();
    if (n.includes('rabby')) return 0;
    if (n.includes('metamask')) return 1;
    if (n.includes('brave')) return 2;
    if (n.includes('coinbase')) return 3;
    return 9;
  };
  out.sort((a, b) => {
    const d = rank(a.name) - rank(b.name);
    if (d !== 0) return d;
    return String(a.name).localeCompare(String(b.name));
  });

  return out;
}

/**
 * Auto-pick only when a single wallet exists, or a saved preference matches.
 * With multiple wallets and no preference, returns null so UI can show a picker.
 * @param {{ forcePick?: boolean, preferRdns?: string|string[], preferName?: RegExp }} [opts]
 * @returns {object|null}
 */
export function getInjectedProvider(opts = {}) {
  if (typeof window === 'undefined') return null;
  startProviderDiscovery();

  if (preferredProvider && typeof preferredProvider.request === 'function') {
    return preferredProvider;
  }

  const wallets = listInjectedWallets();
  if (!wallets.length) return null;

  const preferRdns = []
    .concat(opts.preferRdns || [])
    .map((s) => String(s).toLowerCase())
    .filter(Boolean);

  // Saved preference from last explicit user choice
  if (!preferRdns.length && typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem(PREFERRED_KEY);
      if (saved) preferRdns.push(saved.toLowerCase());
    } catch {
      /* ignore */
    }
  }

  if (preferRdns.length) {
    const hit = wallets.find((w) =>
      preferRdns.some(
        (r) =>
          (w.rdns || '').toLowerCase() === r ||
          (w.rdns || '').toLowerCase().includes(r) ||
          String(w.name || '').toLowerCase().includes(r),
      ),
    );
    if (hit) return hit.provider;
  }

  if (opts.preferName instanceof RegExp) {
    const hit = wallets.find((w) => opts.preferName.test(w.name || ''));
    if (hit) return hit.provider;
  }

  // Multiple wallets: do not auto-steal Brave — let the UI choose
  if (wallets.length > 1 && !opts.forcePick) {
    return null;
  }

  return wallets[0].provider;
}

/**
 * @param {object|null} provider
 * @param {{ rdns?: string, name?: string }} [meta]
 */
export function setPreferredProvider(provider, meta = {}) {
  preferredProvider = provider || null;
  if (typeof localStorage === 'undefined') return;
  try {
    if (!provider) {
      localStorage.removeItem(PREFERRED_KEY);
      return;
    }
    const rdns =
      meta.rdns ||
      listInjectedWallets().find((w) => w.provider === provider)?.rdns ||
      '';
    if (rdns) localStorage.setItem(PREFERRED_KEY, rdns);
    else if (meta.name) localStorage.setItem(PREFERRED_KEY, String(meta.name).toLowerCase());
  } catch {
    /* ignore */
  }
}

/**
 * Wait until at least one wallet is available (late inject).
 * @param {number} [timeoutMs]
 * @returns {Promise<object|null>} first provider if any (may still be multi — use list)
 */
export function waitForInjectedProvider(timeoutMs = 2500) {
  if (typeof window === 'undefined') return Promise.resolve(null);

  const existing = listInjectedWallets();
  if (existing.length) {
    return Promise.resolve(getInjectedProvider({ forcePick: true }) || existing[0].provider);
  }

  startProviderDiscovery();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      const list = listInjectedWallets();
      resolve(list[0]?.provider || null);
    };

    const onAny = () => {
      if (listInjectedWallets().length) finish();
    };

    const cleanup = () => {
      window.removeEventListener('ethereum#initialized', onAny);
      window.removeEventListener('eip6963:announceProvider', onAny);
      clearInterval(poll);
      clearTimeout(timer);
    };

    window.addEventListener('ethereum#initialized', onAny, { once: true });
    window.addEventListener('eip6963:announceProvider', onAny);
    try {
      window.dispatchEvent(new Event('eip6963:requestProvider'));
    } catch {
      /* ignore */
    }

    const poll = setInterval(onAny, 150);
    const timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * @param {object|null} provider
 */
export function describeProvider(provider) {
  if (!provider) return 'wallet';
  const hit = listInjectedWallets().find((w) => w.provider === provider);
  if (hit?.name) return hit.name;
  return nameFromProvider(provider);
}

/**
 * Resolve for connect when only one wallet / preferred — otherwise null (show picker).
 * @returns {Promise<object|null>}
 */
export async function resolveProviderForConnect() {
  startProviderDiscovery();
  // allow late inject
  if (!listInjectedWallets().length) {
    await waitForInjectedProvider(2800);
  }
  return getInjectedProvider();
}

/**
 * Always return a concrete provider list after a short wait.
 * @returns {Promise<InjectedWallet[]>}
 */
export async function resolveWalletOptions() {
  startProviderDiscovery();
  if (!listInjectedWallets().length) {
    await waitForInjectedProvider(2800);
  } else {
    // one more EIP-6963 ping so Brave/MM/Rabby all announce
    try {
      window.dispatchEvent(new Event('eip6963:requestProvider'));
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return listInjectedWallets();
}

/**
 * True for typical phone browsers (extensions like Rabby/MM do NOT inject here).
 * Desktop Chrome/Brave with extensions will return false.
 */
export function isMobileClient() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPadOS 13+ may pretend to be Mac — treat touch Mac as mobile-ish for wallets
  const iPadOs =
    navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return (
    iPadOs ||
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(
      ua,
    )
  );
}

/**
 * MetaMask mobile deep-link to open this dapp inside MetaMask's browser.
 * @param {string} [href]
 */
export function metamaskMobileDappLink(href) {
  if (typeof window === 'undefined') return '';
  const url = new URL(href || window.location.href);
  // strip hash noise; MetaMask expects host + path (+ optional query)
  const path = `${url.host}${url.pathname}${url.search}`;
  return `https://metamask.app.link/dapp/${path}`;
}

/**
 * Snapshot of why inject might be empty (for UI help text).
 */
export function walletInjectDiagnostics() {
  if (typeof window === 'undefined') {
    return { secure: false, hasEthereum: false, mobile: false, count: 0 };
  }
  const list = listInjectedWallets();
  return {
    secure: window.isSecureContext !== false,
    hasEthereum: !!window.ethereum,
    mobile: isMobileClient(),
    count: list.length,
    names: list.map((w) => w.name),
  };
}
