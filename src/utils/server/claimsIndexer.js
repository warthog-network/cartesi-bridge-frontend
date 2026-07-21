/**
 * Cartesi notice → owner claims indexer.
 *
 * Durable on-disk table of notices + per-owner claim aggregates.
 * Incremental GraphQL sync; wipe detection when rollup notices shrink/reset.
 *
 * Used by GET /api/claims/:owner so the liquid tab can prefer real rollup
 * history over browser localStorage.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LOCAL_WWART } from '../localTokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Same root as cosigner local store: cartesi-bridge-frontend/.data */
const DATA_DIR = path.resolve(__dirname, '../../../.data');
const INDEX_PATH = path.join(DATA_DIR, 'claims-index.json');

/** Live L1 wWART — capacity claims for other token deploys are ignored. */
const LIVE_WWART = String(LOCAL_WWART?.address || '')
  .replace(/^0x/i, '')
  .toLowerCase();

function noticeMatchesLiveWwart(n) {
  const t = String(n?.tokenAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  // Require explicit match — legacy notices without tokenAddress (or old mock) do not count.
  return Boolean(LIVE_WWART) && t === LIVE_WWART;
}

const GRAPHQL_URL =
  process.env.CARTESI_GRAPHQL_URL ||
  process.env.PUBLIC_GRAPHQL_URL ||
  'http://127.0.0.1:8080/graphql';

/** Min interval between full GraphQL pulls for the same process. */
const SYNC_MIN_MS = Number(process.env.CLAIMS_INDEX_SYNC_MS || 2000);
/** Page size for notices(first: N). */
const PAGE_SIZE = 100;
/** Soft cap so a runaway rollup cannot blow memory (unlikely in local). */
const MAX_NOTICES = Number(process.env.CLAIMS_INDEX_MAX_NOTICES || 50_000);

/** Bump when claim aggregation rules change (e.g. portable vs capacity on withdraw). */
const INDEX_VERSION = 3;

/** In-process lock + last sync clock (single Node process / Astro server). */
let syncInFlight = null;
let lastSyncAttemptAt = 0;
let memoryIndex = null;

// ─── helpers ────────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function normOwner(addr) {
  const h = String(addr || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (h.length !== 40 || !/^[0-9a-f]+$/.test(h)) return null;
  return h;
}

export function noticeKey(inputIndex, noticeIndex) {
  return `${Number(inputIndex)}:${Number(noticeIndex)}`;
}

export function decodeNoticePayload(payload) {
  if (payload == null) return null;
  try {
    if (typeof payload === 'object' && !Array.isArray(payload)) return payload;
    const s = String(payload);
    if (s.trim().startsWith('{')) return JSON.parse(s);
    const hex = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
    return JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
  } catch {
    return null;
  }
}

function emptyOwnerAgg() {
  return {
    liquid: 0n,
    l1WwartClaim: 0n,
    /** Withdrawable rollup balance (mint − burn − withdraw); capacity uses l1WwartClaim */
    wwartPortable: 0n,
    spoofedMintE8: 0n,
    spoofedBurnE8: 0n,
    matches: 0,
    lastNoticeKey: null,
    lastType: null,
  };
}

/**
 * Apply one decoded notice to an owner aggregate (mutates agg).
 * Returns the owner hex or null if notice is irrelevant / unowned.
 */
export function applyNoticeToAgg(agg, n) {
  if (!n?.type) return null;

  // Prefer explicit user/owner; vault notices may only have owner
  const owner =
    normOwner(n.user) ||
    normOwner(n.owner) ||
    null;
  if (!owner) return null;

  const amount = (() => {
    try {
      return BigInt(String(n.amount ?? '0'));
    } catch {
      return 0n;
    }
  })();

  const type = String(n.type);

  if (type === 'wliq_minted' || type === 'liquid_minted') {
    agg.liquid += amount;
    agg.matches++;
  } else if (type === 'wliq_burned' || type === 'liquid_burned') {
    agg.liquid = agg.liquid > amount ? agg.liquid - amount : 0n;
    agg.matches++;
  } else if (type === 'wwart_minted') {
    if (!noticeMatchesLiveWwart(n)) return owner; // old token deploy — ignore
    agg.l1WwartClaim += amount;
    agg.wwartPortable += amount;
    agg.matches++;
  } else if (type === 'wwart_burned') {
    // Burns must always free capacity. Older notices omit tokenAddress — still apply.
    // Only skip when an explicit *other* token address is present.
    if (n.tokenAddress && !noticeMatchesLiveWwart(n)) return owner;
    agg.l1WwartClaim = agg.l1WwartClaim > amount ? agg.l1WwartClaim - amount : 0n;
    agg.wwartPortable =
      agg.wwartPortable > amount ? agg.wwartPortable - amount : 0n;
    agg.matches++;
  } else if (type === 'wwart_deposited') {
    // Portal inventory only — does NOT free l1WwartClaim (burn_wwart does).
    // Track for audit/matches; capacity Used stays until burn.
    agg.matches++;
  } else if (type === 'wwart_withdrawn') {
    // L1 mirror only — frees portable, NOT capacity (l1WwartClaim stays)
    if (!noticeMatchesLiveWwart(n) && n.tokenAddress) return owner;
    const portableDebit = (() => {
      try {
        if (n.portableMinted != null) return BigInt(String(n.portableMinted));
      } catch {
        /* */
      }
      return amount;
    })();
    if (portableDebit > 0n) {
      agg.wwartPortable =
        agg.wwartPortable > portableDebit
          ? agg.wwartPortable - portableDebit
          : 0n;
      agg.matches++;
    }
  } else if (type === 'sweep_locked' && n.mintedE8 != null) {
    try {
      agg.spoofedMintE8 += BigInt(String(n.mintedE8));
      agg.matches++;
    } catch {
      /* */
    }
  } else if (
    (type === 'spoofed_wwart_burned' || type === 'subwallet_unlocked') &&
    n.burnedE8 != null
  ) {
    try {
      agg.spoofedBurnE8 += BigInt(String(n.burnedE8));
      agg.matches++;
    } catch {
      /* */
    }
  } else {
    // vault_created etc. — still tag owner for audit but no claim change
    return owner;
  }

  agg.lastType = type;
  return owner;
}

/** Build serializable claim snapshot from bigint aggregates. */
export function finalizeOwnerClaims(agg, ownerHex) {
  const outstandingE8 =
    agg.spoofedMintE8 > agg.spoofedBurnE8
      ? agg.spoofedMintE8 - agg.spoofedBurnE8
      : 0n;
  // Notices path: capacity from spoofed only (portal deposits need inspect)
  const capacity18 = outstandingE8 * 10n ** 10n;
  const claimed18 = agg.liquid + agg.l1WwartClaim;
  const remaining18 = capacity18 > claimed18 ? capacity18 - claimed18 : 0n;
  const portable =
    agg.wwartPortable != null ? agg.wwartPortable : agg.l1WwartClaim;

  return {
    owner: `0x${ownerHex}`,
    liquid: agg.liquid.toString(),
    l1WwartClaim: agg.l1WwartClaim.toString(),
    wwartPortable: portable.toString(),
    outstandingE8: outstandingE8.toString(),
    totalSpoofedMinted: agg.spoofedMintE8.toString(),
    totalSpoofedBurned: agg.spoofedBurnE8.toString(),
    mintCapacity18: capacity18.toString(),
    mintClaimed18: claimed18.toString(),
    mintRemaining18: remaining18.toString(),
    matches: agg.matches,
    lastNoticeKey: agg.lastNoticeKey,
    lastType: agg.lastType,
    _source: 'claims_index',
  };
}

function emptyIndex() {
  return {
    version: INDEX_VERSION,
    meta: {
      graphqlUrl: GRAPHQL_URL,
      createdAt: Date.now(),
      lastSyncAt: 0,
      lastSyncOk: false,
      lastError: null,
      noticeCount: 0,
      ownerCount: 0,
      totalCountReported: null,
      endCursor: null,
      /** First notice key ever seen — wipe detector */
      genesisKey: null,
    },
    /** key -> { inputIndex, noticeIndex, type, owner, amount, mintedE8, burnedE8, indexedAt } */
    notices: {},
    /** ownerHex -> finalized claim snapshot strings */
    owners: {},
  };
}

function loadIndexFromDisk() {
  ensureDataDir();
  if (!fs.existsSync(INDEX_PATH)) return emptyIndex();
  try {
    const raw = fs.readFileSync(INDEX_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (!j || j.version !== INDEX_VERSION || typeof j.notices !== 'object') {
      return emptyIndex();
    }
    j.meta = { ...emptyIndex().meta, ...(j.meta || {}) };
    j.notices = j.notices || {};
    j.owners = j.owners || {};
    return j;
  } catch (e) {
    console.warn('[claimsIndexer] load failed, starting fresh:', e?.message || e);
    return emptyIndex();
  }
}

function getIndex() {
  if (!memoryIndex) memoryIndex = loadIndexFromDisk();
  return memoryIndex;
}

/** Atomic write: temp + rename. */
function persistIndex(index) {
  ensureDataDir();
  const tmp = `${INDEX_PATH}.${process.pid}.tmp`;
  const payload = JSON.stringify(index, null, 2);
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  fs.renameSync(tmp, INDEX_PATH);
  memoryIndex = index;
}

/**
 * Recompute all owner aggregates from the notices table.
 * Deterministic order: inputIndex asc, noticeIndex asc.
 */
export function recomputeOwners(index) {
  const rows = Object.values(index.notices).sort((a, b) => {
    if (a.inputIndex !== b.inputIndex) return a.inputIndex - b.inputIndex;
    return a.noticeIndex - b.noticeIndex;
  });

  const aggs = new Map();

  for (const row of rows) {
    const n = {
      type: row.type,
      user: row.owner,
      owner: row.owner,
      amount: row.amount,
      mintedE8: row.mintedE8,
      burnedE8: row.burnedE8,
      tokenAddress: row.tokenAddress,
    };
    const ownerHint = normOwner(row.owner);
    if (!ownerHint) continue;
    if (!aggs.has(ownerHint)) aggs.set(ownerHint, emptyOwnerAgg());
    const agg = aggs.get(ownerHint);
    const applied = applyNoticeToAgg(agg, n);
    if (applied) {
      agg.lastNoticeKey = noticeKey(row.inputIndex, row.noticeIndex);
    }
  }

  const owners = {};
  for (const [hex, agg] of aggs) {
    if (agg.matches === 0) continue;
    owners[hex] = finalizeOwnerClaims(agg, hex);
  }
  index.owners = owners;
  index.meta.ownerCount = Object.keys(owners).length;
  index.meta.noticeCount = Object.keys(index.notices).length;
  return index;
}

function rowFromEdge(edge) {
  const node = edge?.node;
  if (!node) return null;
  const inputIndex = Number(node.input?.index);
  const noticeIndex = Number(node.index);
  if (!Number.isFinite(inputIndex) || !Number.isFinite(noticeIndex)) return null;

  const decoded = decodeNoticePayload(node.payload);
  if (!decoded?.type) return null;

  const owner =
    normOwner(decoded.user) ||
    normOwner(decoded.owner) ||
    null;

  const amount =
    decoded.amount != null ? String(decoded.amount) : null;
  const mintedE8 =
    decoded.mintedE8 != null ? String(decoded.mintedE8) : null;
  const burnedE8 =
    decoded.burnedE8 != null ? String(decoded.burnedE8) : null;

  return {
    key: noticeKey(inputIndex, noticeIndex),
    inputIndex,
    noticeIndex,
    type: String(decoded.type),
    owner: owner ? `0x${owner}` : null,
    amount,
    mintedE8,
    burnedE8,
    tokenAddress:
      decoded.tokenAddress != null ? String(decoded.tokenAddress) : null,
    indexedAt: Date.now(),
  };
}

async function graphqlNoticesPage({ first, after }) {
  const afterPart = after ? `, after: ${JSON.stringify(after)}` : '';
  const query = `{ notices(first: ${first}${afterPart}) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges { cursor node { index input { index } payload } }
  } }`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query }),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    const data = await res.json();
    if (data.errors?.length) {
      throw new Error(data.errors[0]?.message || 'GraphQL error');
    }
    return data.data.notices;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full or incremental sync from Cartesi GraphQL into the notices table.
 * @param {{ force?: boolean }} opts
 */
export async function syncClaimsIndex(opts = {}) {
  const force = !!opts.force;
  const now = Date.now();

  if (syncInFlight) return syncInFlight;

  if (!force && now - lastSyncAttemptAt < SYNC_MIN_MS) {
    const idx = getIndex();
    return {
      ok: idx.meta.lastSyncOk,
      skipped: true,
      reason: 'rate_limit',
      meta: idx.meta,
      noticeCount: idx.meta.noticeCount,
      ownerCount: idx.meta.ownerCount,
    };
  }

  lastSyncAttemptAt = now;

  syncInFlight = (async () => {
    const index = getIndex();
    let added = 0;
    let pages = 0;
    let wipe = false;

    try {
      // Probe first page for wipe detection + totalCount
      const firstPage = await graphqlNoticesPage({ first: PAGE_SIZE, after: null });
      pages++;
      const totalReported =
        typeof firstPage.totalCount === 'number' ? firstPage.totalCount : null;
      const firstEdge = firstPage.edges?.[0];
      const firstRow = firstEdge ? rowFromEdge(firstEdge) : null;
      const liveGenesis = firstRow?.key ?? null;

      // Machine wipe / new epoch: fewer notices, or genesis notice changed
      const storedCount = Object.keys(index.notices).length;
      if (
        (totalReported != null && totalReported < storedCount) ||
        (index.meta.genesisKey &&
          liveGenesis &&
          index.meta.genesisKey !== liveGenesis) ||
        (storedCount > 0 && totalReported === 0)
      ) {
        wipe = true;
        index.notices = {};
        index.owners = {};
        index.meta.genesisKey = null;
        index.meta.endCursor = null;
        index.meta.noticeCount = 0;
        index.meta.ownerCount = 0;
        console.warn(
          '[claimsIndexer] notice wipe detected — resetting index',
          { storedCount, totalReported, liveGenesis, prevGenesis: index.meta.genesisKey },
        );
      }

      if (!index.meta.genesisKey && liveGenesis) {
        index.meta.genesisKey = liveGenesis;
      }

      // If we already have everything and no wipe, only fetch tail
      let after = null;
      let hasNext = true;
      let edges = firstPage.edges || [];
      let pageInfo = firstPage.pageInfo || {};
      let useCachedFirst = true;

      // When index is non-empty and not wiped, resume after last stored endCursor
      // only if totalCount grew; otherwise re-scan from start is safer for gaps.
      const needFullScan =
        wipe ||
        storedCount === 0 ||
        totalReported == null ||
        totalReported !== storedCount ||
        force;

      if (!needFullScan) {
        // Nothing new
        index.meta.lastSyncAt = Date.now();
        index.meta.lastSyncOk = true;
        index.meta.lastError = null;
        index.meta.totalCountReported = totalReported;
        index.meta.graphqlUrl = GRAPHQL_URL;
        persistIndex(index);
        return {
          ok: true,
          skipped: false,
          added: 0,
          pages: 1,
          wipe: false,
          meta: index.meta,
          noticeCount: index.meta.noticeCount,
          ownerCount: index.meta.ownerCount,
        };
      }

      // Full scan (idempotent upsert by key)
      while (hasNext) {
        if (!useCachedFirst) {
          const page = await graphqlNoticesPage({ first: PAGE_SIZE, after });
          pages++;
          edges = page.edges || [];
          pageInfo = page.pageInfo || {};
          if (typeof page.totalCount === 'number') {
            index.meta.totalCountReported = page.totalCount;
          }
        } else {
          useCachedFirst = false;
          index.meta.totalCountReported = totalReported;
        }

        for (const edge of edges) {
          const row = rowFromEdge(edge);
          if (!row) continue;
          if (!index.notices[row.key]) added++;
          index.notices[row.key] = {
            inputIndex: row.inputIndex,
            noticeIndex: row.noticeIndex,
            type: row.type,
            owner: row.owner,
            amount: row.amount,
            mintedE8: row.mintedE8,
            burnedE8: row.burnedE8,
            tokenAddress: row.tokenAddress ?? null,
            indexedAt: row.indexedAt,
          };
          if (!index.meta.genesisKey) {
            index.meta.genesisKey = row.key;
          }
        }

        if (Object.keys(index.notices).length > MAX_NOTICES) {
          throw new Error(`notice cap ${MAX_NOTICES} exceeded`);
        }

        hasNext = !!pageInfo.hasNextPage;
        after = pageInfo.endCursor || null;
        if (hasNext && !after) break;
      }

      index.meta.endCursor = after;
      recomputeOwners(index);
      index.meta.lastSyncAt = Date.now();
      index.meta.lastSyncOk = true;
      index.meta.lastError = null;
      index.meta.graphqlUrl = GRAPHQL_URL;
      persistIndex(index);

      return {
        ok: true,
        skipped: false,
        added,
        pages,
        wipe,
        meta: index.meta,
        noticeCount: index.meta.noticeCount,
        ownerCount: index.meta.ownerCount,
      };
    } catch (e) {
      const msg = e?.message || String(e);
      index.meta.lastSyncAt = Date.now();
      index.meta.lastSyncOk = false;
      index.meta.lastError = msg;
      // Still persist partial progress if we have notices
      try {
        if (Object.keys(index.notices).length > 0) {
          recomputeOwners(index);
          persistIndex(index);
        }
      } catch {
        /* */
      }
      console.warn('[claimsIndexer] sync failed:', msg);
      return {
        ok: false,
        skipped: false,
        error: msg,
        added,
        pages,
        wipe,
        meta: index.meta,
        noticeCount: index.meta.noticeCount,
        ownerCount: index.meta.ownerCount,
      };
    } finally {
      syncInFlight = null;
    }
  })();

  return syncInFlight;
}

/**
 * Get claims for one L1 owner. Syncs index if stale.
 * @param {string} ownerAddr
 * @param {{ forceSync?: boolean }} opts
 */
export async function getClaimsForOwner(ownerAddr, opts = {}) {
  const owner = normOwner(ownerAddr);
  if (!owner) {
    return { ok: false, error: 'invalid_owner', owner: ownerAddr };
  }

  const sync = await syncClaimsIndex({ force: !!opts.forceSync });
  const index = getIndex();
  const claims = index.owners[owner] || null;

  // Also list raw notice keys for this owner (debug / UI transparency)
  const noticeKeys = Object.values(index.notices)
    .filter((r) => normOwner(r.owner) === owner)
    .sort((a, b) =>
      a.inputIndex !== b.inputIndex
        ? a.inputIndex - b.inputIndex
        : a.noticeIndex - b.noticeIndex,
    )
    .map((r) => ({
      key: noticeKey(r.inputIndex, r.noticeIndex),
      type: r.type,
      amount: r.amount,
      mintedE8: r.mintedE8,
      burnedE8: r.burnedE8,
    }));

  if (!claims) {
    return {
      ok: true,
      found: false,
      owner: `0x${owner}`,
      claims: {
        owner: `0x${owner}`,
        liquid: '0',
        l1WwartClaim: '0',
        wwartPortable: '0',
        outstandingE8: '0',
        totalSpoofedMinted: '0',
        totalSpoofedBurned: '0',
        mintCapacity18: '0',
        mintClaimed18: '0',
        mintRemaining18: '0',
        matches: 0,
        _source: 'claims_index',
      },
      notices: noticeKeys,
      sync,
      meta: {
        lastSyncAt: index.meta.lastSyncAt,
        noticeCount: index.meta.noticeCount,
        ownerCount: index.meta.ownerCount,
        graphqlUrl: index.meta.graphqlUrl,
      },
    };
  }

  return {
    ok: true,
    found: true,
    owner: `0x${owner}`,
    claims,
    notices: noticeKeys,
    sync,
    meta: {
      lastSyncAt: index.meta.lastSyncAt,
      noticeCount: index.meta.noticeCount,
      ownerCount: index.meta.ownerCount,
      graphqlUrl: index.meta.graphqlUrl,
    },
  };
}

export function getIndexStatus() {
  const index = getIndex();
  return {
    path: INDEX_PATH,
    version: index.version,
    meta: index.meta,
    noticeCount: Object.keys(index.notices).length,
    ownerCount: Object.keys(index.owners).length,
    owners: Object.keys(index.owners).map((h) => `0x${h}`),
  };
}

export function getIndexPath() {
  return INDEX_PATH;
}
