/**
 * Persist L1 vault capacity / claim snapshot per MetaMask address.
 * Survives leave-and-return; rehydrated then overwritten by inspect when available.
 *
 * Preference order for liquid-tab claims (see WalletIsland refreshVault):
 *   1. Cartesi inspect (live machine state)
 *   2. GET /api/claims/:owner  (server notice indexer — durable, shared)
 *   3. Browser GraphQL notice sum (legacy fallback)
 *   4. localStorage cache (last resort)
 */

import { LOCAL_WWART } from './localTokens.js';

// v2: key includes live wWART so redeploys drop stale capacity cache
const PREFIX = 'cartesi-l1-vault-cache-v2:';

export function vaultCacheKey(l1Address) {
  const wwart = String(LOCAL_WWART?.address || '')
    .replace(/^0x/i, '')
    .toLowerCase()
    .slice(0, 12);
  return `${PREFIX}${wwart}:${String(l1Address || '')
    .replace(/^0x/i, '')
    .toLowerCase()}`;
}

export function loadVaultCache(l1Address) {
  if (typeof localStorage === 'undefined' || !l1Address) return null;
  try {
    const raw = localStorage.getItem(vaultCacheKey(l1Address));
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    return j;
  } catch {
    return null;
  }
}

/** Drop browser vault snapshot (e.g. after clean Anvil / claims wipe). */
export function clearVaultCache(l1Address) {
  if (typeof localStorage === 'undefined' || !l1Address) return;
  try {
    localStorage.removeItem(vaultCacheKey(l1Address));
  } catch {
    /* */
  }
}

export function saveVaultCache(l1Address, vault, spoofedExtra = null) {
  if (typeof localStorage === 'undefined' || !l1Address || !vault) return;
  try {
    const payload = {
      savedAt: Date.now(),
      vault: {
        liquid: String(vault.liquid || '0'),
        l1WwartClaim: String(vault.l1WwartClaim || '0'),
        wwartPortable: String(vault.wwartPortable || '0'),
        wWART: String(vault.wWART || '0'),
        CTSI: String(vault.CTSI || '0'),
        usdc: String(vault.usdc || '0'),
        eth: String(vault.eth || '0'),
        outstandingE8: String(vault.outstandingE8 || '0'),
        mintCapacity18: vault.mintCapacity18 != null ? String(vault.mintCapacity18) : null,
        mintClaimed18: vault.mintClaimed18 != null ? String(vault.mintClaimed18) : null,
        mintRemaining18: vault.mintRemaining18 != null ? String(vault.mintRemaining18) : null,
        totalSpoofedMinted: vault.totalSpoofedMinted != null ? String(vault.totalSpoofedMinted) : null,
        totalSpoofedBurned: vault.totalSpoofedBurned != null ? String(vault.totalSpoofedBurned) : null,
      },
      spoofed: spoofedExtra || null,
    };
    localStorage.setItem(vaultCacheKey(l1Address), JSON.stringify(payload));
  } catch (e) {
    console.warn('[vaultStateCache] save failed', e);
  }
}

/** True if vault has any non-zero capacity / claims worth caching. */
export function vaultHasShareState(vault) {
  if (!vault) return false;
  try {
    return (
      BigInt(vault.liquid || 0) > 0n ||
      BigInt(vault.l1WwartClaim || 0) > 0n ||
      BigInt(vault.wwartPortable || 0) > 0n ||
      BigInt(vault.outstandingE8 || 0) > 0n ||
      BigInt(vault.mintCapacity18 || 0) > 0n ||
      BigInt(vault.mintClaimed18 || 0) > 0n
    );
  } catch {
    return false;
  }
}

function decodeNoticePayload(payload) {
  if (payload == null) return null;
  try {
    if (typeof payload === 'object') return payload;
    const s = String(payload);
    if (s.trim().startsWith('{')) return JSON.parse(s);
    const hex = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
    const bytes = new Uint8Array(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Fetch claims from the server notice indexer (preferred over localStorage).
 * Same-origin `/api/claims/:owner` — works with Astro node adapter / vite dev.
 *
 * @param {string} ownerL1 0x or bare 40 hex
 * @param {{ force?: boolean, signal?: AbortSignal }} [opts]
 * @returns {Promise<object|null>} claim fields or null on miss/error
 */
export async function fetchClaimsFromApi(ownerL1, opts = {}) {
  const owner = String(ownerL1 || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!owner || owner.length !== 40 || !/^[0-9a-f]+$/.test(owner)) return null;

  const controller = opts.signal ? null : new AbortController();
  const signal = opts.signal || controller.signal;
  const timer =
    controller != null ? setTimeout(() => controller.abort(), 8000) : null;

  try {
    const q = opts.force ? '?force=1' : '';
    const res = await fetch(`/api/claims/0x${owner}${q}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.ok) return null;

    // Prefer nested claims object; fall back to flattened top-level fields
    const c = data.claims && typeof data.claims === 'object' ? data.claims : data;
    const liquid = String(c.liquid ?? data.liquid ?? '0');
    const l1WwartClaim = String(c.l1WwartClaim ?? data.l1WwartClaim ?? '0');
    const outstandingE8 = String(c.outstandingE8 ?? data.outstandingE8 ?? '0');

    // Treat all-zero with no matches as "not found" so callers can try next source
    const matches = Number(c.matches ?? data.matches ?? 0);
    const found = data.found === true || matches > 0;
    try {
      const hasValue =
        BigInt(liquid) > 0n ||
        BigInt(l1WwartClaim) > 0n ||
        BigInt(outstandingE8) > 0n;
      if (!found && !hasValue) return null;
    } catch {
      if (!found) return null;
    }

    return {
      liquid,
      l1WwartClaim,
      wwartPortable: String(c.wwartPortable ?? data.wwartPortable ?? l1WwartClaim),
      outstandingE8,
      totalSpoofedMinted: String(
        c.totalSpoofedMinted ?? data.totalSpoofedMinted ?? '0',
      ),
      totalSpoofedBurned: String(
        c.totalSpoofedBurned ?? data.totalSpoofedBurned ?? '0',
      ),
      mintCapacity18:
        c.mintCapacity18 != null || data.mintCapacity18 != null
          ? String(c.mintCapacity18 ?? data.mintCapacity18)
          : undefined,
      mintClaimed18:
        c.mintClaimed18 != null || data.mintClaimed18 != null
          ? String(c.mintClaimed18 ?? data.mintClaimed18)
          : undefined,
      mintRemaining18:
        c.mintRemaining18 != null || data.mintRemaining18 != null
          ? String(c.mintRemaining18 ?? data.mintRemaining18)
          : undefined,
      matches,
      _source: 'claims_api',
      _meta: data.meta || null,
    };
  } catch (e) {
    if (e?.name !== 'AbortError') {
      console.warn('[fetchClaimsFromApi]', e?.message || e);
    }
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Rebuild WLIQ / wWART claims from GraphQL notices (survives inspect empty if notices still present).
 * Legacy browser-side fallback — prefer fetchClaimsFromApi when the server indexer is up.
 * @param {string} graphqlUrl absolute
 * @param {string} ownerL1 0x or bare 40 hex
 */
export async function claimsFromGraphQLNotices(graphqlUrl, ownerL1) {
  const owner = String(ownerL1 || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!owner || owner.length !== 40) return null;

  const query = `{ notices(last: 200) { edges { node { payload } } } }`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    const edges = data?.data?.notices?.edges || [];

    let wliq = 0n;
    let wwart = 0n;
    let portable = 0n;
    let spoofedMint = 0n;
    let spoofedBurn = 0n;
    let matches = 0;

    const liveTok = String(LOCAL_WWART?.address || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    const tokOk = (n) => {
      if (!liveTok) return false;
      const tok = String(n.tokenAddress || '')
        .replace(/^0x/i, '')
        .toLowerCase();
      return tok === liveTok;
    };

    for (const e of edges) {
      const n = decodeNoticePayload(e?.node?.payload);
      if (!n?.type) continue;
      const u = String(n.user || n.owner || '')
        .replace(/^0x/i, '')
        .toLowerCase();
      if (u && u !== owner) continue;

      const amt = (() => {
        try {
          return BigInt(String(n.amount || '0'));
        } catch {
          return 0n;
        }
      })();

      if (n.type === 'wliq_minted' || n.type === 'liquid_minted') {
        wliq += amt;
        matches++;
      } else if (n.type === 'wliq_burned' || n.type === 'liquid_burned') {
        wliq = wliq > amt ? wliq - amt : 0n;
        matches++;
      } else if (n.type === 'wwart_minted') {
        if (!tokOk(n)) continue; // ignore claims for previous L1 deploys
        wwart += amt;
        portable += amt;
        matches++;
      } else if (n.type === 'wwart_burned') {
        if (!tokOk(n)) continue;
        wwart = wwart > amt ? wwart - amt : 0n;
        portable = portable > amt ? portable - amt : 0n;
        matches++;
      } else if (n.type === 'wwart_withdrawn') {
        // Capacity claim stays; portable moves to MetaMask
        if (n.tokenAddress && !tokOk(n)) continue;
        let debit = amt;
        try {
          if (n.portableMinted != null) debit = BigInt(String(n.portableMinted));
        } catch {
          /* */
        }
        portable = portable > debit ? portable - debit : 0n;
        matches++;
      } else if (n.type === 'sweep_locked' && n.mintedE8 != null) {
        try {
          spoofedMint += BigInt(String(n.mintedE8));
          matches++;
        } catch {
          /* */
        }
      } else if (
        (n.type === 'spoofed_wwart_burned' || n.type === 'subwallet_unlocked') &&
        n.burnedE8 != null
      ) {
        try {
          spoofedBurn += BigInt(String(n.burnedE8));
          matches++;
        } catch {
          /* */
        }
      }
    }

    if (matches === 0) return null;

    const outstandingE8 = spoofedMint > spoofedBurn ? spoofedMint - spoofedBurn : 0n;
    const capacity18 =
      outstandingE8 * 10n ** 10n; // notices path: spoofed only (no eth/ctsi without inspect)
    const claimed18 = wliq + wwart;
    const remaining18 = capacity18 > claimed18 ? capacity18 - claimed18 : 0n;

    return {
      liquid: wliq.toString(),
      l1WwartClaim: wwart.toString(),
      wwartPortable: portable.toString(),
      outstandingE8: outstandingE8.toString(),
      totalSpoofedMinted: spoofedMint.toString(),
      totalSpoofedBurned: spoofedBurn.toString(),
      mintCapacity18: capacity18.toString(),
      mintClaimed18: claimed18.toString(),
      mintRemaining18: remaining18.toString(),
      _source: 'graphql_notices',
      _matches: matches,
    };
  } catch (e) {
    console.warn('[claimsFromGraphQLNotices]', e?.message || e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
