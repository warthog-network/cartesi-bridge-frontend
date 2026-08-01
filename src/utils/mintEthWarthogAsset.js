/**
 * Warthog WETH linked to ETH-bridge rollup claims.
 *
 * Model (best fit for current stack — no Warthog asset-burn opcode):
 *   1. Lock vault ETH → eth capacity
 *   2. Mint: createAssets("WETH") on Warthog + mint_weth_claim on rollup
 *      · supply = claim amount (1:1 value link)
 *      · asset hash stored with claim (inspect ethWartAssets when backend live;
 *        always mirrored in localStorage)
 *   3. Burn claim: frees capacity Used; marks link status released (FIFO).
 *      Warthog WETH tokens remain in wallet (demo trust until escrow/burn path).
 *
 * Asset name is WETH (≤5 chars). Decimals 8 (u64 supply range; WART-style).
 */

import { createWarthogApi, signAndSubmitTransaction } from './warthogClient.js';
import { getSmartNonce, bumpNonceAfterSuccess } from './cancelLimitOrder.js';
import { DEFAULT_NODE_URL } from './presetNodes.js';

export const WARTHOG_ETH_ASSET_NAME = 'WETH';
/** 8-dec matches WART funds scale; larger amounts fit in u64 vs 18-dec. */
export const WARTHOG_ETH_ASSET_DECIMALS = '8';

const LS_LINKS = 'cartesiWethWartLinks';
const LS_WATCH = 'cartesiWethWartWatch';

function ownerKey(ownerL1) {
  return String(ownerL1 || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

function normHash(h) {
  if (!h) return null;
  const s = String(h).replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

function normEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const assetHash = normHash(raw.assetHash || raw.hash);
  if (!assetHash) return null;
  const amount =
    raw.assetAmount != null
      ? String(raw.assetAmount)
      : raw.amount != null
        ? String(raw.amount)
        : '0';
  return {
    assetHash,
    assetName: String(raw.assetName || raw.name || WARTHOG_ETH_ASSET_NAME)
      .toUpperCase()
      .slice(0, 5),
    amount,
    amountWei: raw.amountWei != null ? String(raw.amountWei) : null,
    decimals:
      raw.assetDecimals != null
        ? Number(raw.assetDecimals)
        : raw.decimals != null
          ? Number(raw.decimals)
          : Number(WARTHOG_ETH_ASSET_DECIMALS),
    txHash: normHash(raw.assetTxHash || raw.txHash) || null,
    wartAddress: raw.wartAddress
      ? String(raw.wartAddress).replace(/^0x/i, '').toLowerCase()
      : null,
    ownerL1: raw.ownerL1 ? ownerKey(raw.ownerL1) : null,
    /** active = claim still open · released = capacity burned · pending = asset only */
    status: raw.status || (raw.claimLinked === false ? 'pending' : 'active'),
    claimLinked: raw.claimLinked !== false,
    releasedAmount: raw.releasedAmount != null ? String(raw.releasedAmount) : '0',
    createdAt: raw.createdAt || raw.timestamp || Date.now(),
    source: raw.source || 'local',
  };
}

function readStore(key) {
  if (typeof localStorage === 'undefined') return {};
  try {
    return JSON.parse(localStorage.getItem(key) || '{}') || {};
  } catch {
    return {};
  }
}

function writeStore(key, obj) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

export function listLocalEthWartAssets(ownerL1) {
  const key = ownerKey(ownerL1);
  const all = readStore(LS_LINKS);
  let list = all[key] || [];
  // Migrate prior session key from first ETH-asset ship
  if (!list.length && typeof localStorage !== 'undefined') {
    try {
      const legacy = JSON.parse(localStorage.getItem('cartesiEthWartAssets') || '{}');
      const leg = legacy[key] || legacy[`0x${key}`];
      if (Array.isArray(leg) && leg.length) {
        list = leg;
        all[key] = leg;
        writeStore(LS_LINKS, all);
      }
    } catch {
      /* */
    }
  }
  return (Array.isArray(list) ? list : []).map(normEntry).filter(Boolean);
}

function saveLocalLinks(ownerL1, list) {
  const all = readStore(LS_LINKS);
  all[ownerKey(ownerL1)] = list.slice(0, 50);
  writeStore(LS_LINKS, all);
}

export function saveLocalLink(ownerL1, entry) {
  if (!ownerL1) return;
  const e = normEntry({ ...entry, source: entry.source || 'local' });
  if (!e) return;
  const list = listLocalEthWartAssets(ownerL1).filter(
    (x) => x.assetHash !== e.assetHash,
  );
  list.unshift(e);
  saveLocalLinks(ownerL1, list);
  if (e.wartAddress) addWethWatch(e.wartAddress, e);
}

/** Persist watch entries for Warthog wallet surface (by wart address). */
export function addWethWatch(wartAddress, entry) {
  const w = String(wartAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!w) return;
  const e = normEntry(entry);
  if (!e) return;
  const all = readStore(LS_WATCH);
  const list = Array.isArray(all[w]) ? all[w] : [];
  const next = [e, ...list.filter((x) => normHash(x.assetHash) !== e.assetHash)].slice(
    0,
    40,
  );
  all[w] = next;
  writeStore(LS_WATCH, all);
}

export function listWethWatch(wartAddress) {
  const w = String(wartAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!w) return [];
  const all = readStore(LS_WATCH);
  return (Array.isArray(all[w]) ? all[w] : []).map(normEntry).filter(Boolean);
}

/**
 * Merge inspect ethWartAssets + local links (inspect wins on hash collision for amounts).
 * Newest first. Rollup matches promote local "pending" → "active" and persist that.
 */
export function mergeEthWartAssetLinks(ownerL1, inspectList) {
  const byHash = new Map();
  for (const raw of listLocalEthWartAssets(ownerL1)) {
    byHash.set(raw.assetHash, { ...raw, source: raw.source || 'local' });
  }
  const inspectArr = Array.isArray(inspectList) ? inspectList : [];
  for (const raw of inspectArr) {
    const e = normEntry({
      ...raw,
      source: 'rollup',
      claimLinked: true,
      status: 'active',
    });
    if (!e) continue;
    const prev = byHash.get(e.assetHash);
    byHash.set(e.assetHash, {
      ...prev,
      ...e,
      claimLinked: true,
      // Keep released if user already burned; otherwise rollup link = active
      status: prev?.status === 'released' ? 'released' : 'active',
      releasedAmount: prev?.releasedAmount || e.releasedAmount || '0',
      source: 'rollup',
    });
  }
  const list = [...byHash.values()].sort(
    (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0),
  );
  // Persist promotions so Refresh / reload don't re-show "pending" after claim linked
  if (ownerL1 && inspectArr.length) {
    saveLocalLinks(ownerL1, list);
  }
  return list;
}

/** Mark a link as claim-linked after successful mint_weth_claim. */
export function markLinkClaimed(ownerL1, assetHash, patch = {}) {
  const h = normHash(assetHash);
  if (!ownerL1 || !h) return;
  const list = listLocalEthWartAssets(ownerL1).map((e) =>
    e.assetHash === h
      ? {
          ...e,
          ...patch,
          claimLinked: true,
          status: 'active',
          source: e.source || 'local',
        }
      : e,
  );
  // if missing, insert
  if (!list.some((e) => e.assetHash === h)) {
    const e = normEntry({
      assetHash: h,
      ...patch,
      claimLinked: true,
      status: 'active',
      ownerL1,
    });
    if (e) list.unshift(e);
  }
  saveLocalLinks(ownerL1, list);
}

/**
 * FIFO: mark linked WETH amounts as released when user burns rollup claim.
 * Does not destroy Warthog tokens (no asset-burn tx on chain yet).
 * @returns {{ released: Array, remainingBurn: string }}
 */
export function markLinksReleasedFifo(ownerL1, burnAmountHuman) {
  const burn = Number(String(burnAmountHuman || '0').trim());
  if (!ownerL1 || !Number.isFinite(burn) || burn <= 0) {
    return { released: [], remainingBurn: String(burnAmountHuman || '0') };
  }
  let left = burn;
  const released = [];
  const list = listLocalEthWartAssets(ownerL1).map((e) => {
    if (left <= 0 || e.status === 'released') return e;
    const amt = Number(e.amount) || 0;
    const already = Number(e.releasedAmount) || 0;
    const open = Math.max(0, amt - already);
    if (open <= 0) {
      return { ...e, status: 'released' };
    }
    const take = Math.min(open, left);
    left -= take;
    const newReleased = already + take;
    const fully = newReleased + 1e-12 >= amt;
    const next = {
      ...e,
      releasedAmount: String(newReleased),
      status: fully ? 'released' : 'active',
    };
    released.push({ ...next, releasedNow: take });
    return next;
  });
  saveLocalLinks(ownerL1, list);
  return {
    released,
    remainingBurn: left > 1e-12 ? String(left) : '0',
  };
}

export function ethCapacityFromVault(vault) {
  const toWei = (v) => {
    if (v == null || v === '') return 0n;
    try {
      return BigInt(String(v));
    } catch {
      return 0n;
    }
  };
  const capacityWei = toWei(vault?.ethCapacity18);
  const claimedWei = toWei(vault?.ethClaimed18);
  const remainingWei =
    vault?.ethRemaining18 != null
      ? toWei(vault.ethRemaining18)
      : capacityWei > claimedWei
        ? capacityWei - claimedWei
        : 0n;
  return {
    remainingWei,
    capacityWei,
    claimedWei,
    hasLocked: capacityWei > 0n,
    hasAvailable: remainingWei > 0n,
  };
}

/** Human ETH amount → createAssets supply (8-dec). */
export function normalizeEthSupplyAmount(amountStr) {
  const s = String(amountStr || '').trim();
  if (!s || s === '0') throw new Error('Amount must be > 0');
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Invalid amount');
  const [w, f = ''] = s.split('.');
  const whole = w.replace(/^0+(?=\d)/, '') || '0';
  const frac = f.slice(0, 8).replace(/0+$/, '');
  const out = frac ? `${whole}.${frac}` : whole;
  if (out === '0' || out === '0.0') throw new Error('Amount too small (min 1e-8 ETH)');
  return out;
}

export async function resolveEthAssetHash(
  api,
  { name = WARTHOG_ETH_ASSET_NAME, txHash, creatorAddress },
) {
  const wantName = String(name).toUpperCase();
  if (txHash && /^[0-9a-fA-F]{64}$/.test(String(txHash).replace(/^0x/i, ''))) {
    return String(txHash).replace(/^0x/i, '').toLowerCase();
  }

  for (let i = 0; i < 24; i++) {
    try {
      const res = await api.searchAssets(wantName);
      if (res.success) {
        const matches = res.data?.matches || [];
        const exact = matches.filter(
          (m) => String(m.name || '').toUpperCase() === wantName,
        );
        const byCreator = creatorAddress
          ? exact.filter(
              (m) =>
                String(m.creator || m.owner || m.address || '')
                  .replace(/^0x/i, '')
                  .toLowerCase() ===
                String(creatorAddress).replace(/^0x/i, '').toLowerCase(),
            )
          : [];
        const pick = (byCreator[0] || exact[exact.length - 1] || exact[0])?.hash;
        if (pick) return String(pick).replace(/^0x/i, '').toLowerCase();
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}

/**
 * Create Warthog native WETH for `amount` and register a local link (pending until claim).
 */
export async function createWarthogEthAsset({
  amount,
  wartAddress,
  nodeUrl,
  privateKey,
  ownerL1,
  remainingWei,
}) {
  if (!wartAddress) throw new Error('Unlock Warthog wallet first');
  const supply = normalizeEthSupplyAmount(amount);

  if (remainingWei != null) {
    const rem =
      typeof remainingWei === 'bigint' ? remainingWei : BigInt(String(remainingWei || 0));
    if (rem <= 0n) {
      throw new Error('No ETH capacity available — lock vault ETH first');
    }
    try {
      const want = Number(supply);
      const avail = Number(rem) / 1e18;
      if (Number.isFinite(want) && Number.isFinite(avail) && want > avail + 1e-12) {
        throw new Error(`Amount ${supply} exceeds available ETH capacity (~${avail})`);
      }
    } catch (e) {
      if (e?.message?.includes('exceeds')) throw e;
    }
  }

  const node = nodeUrl || DEFAULT_NODE_URL;
  const api = await createWarthogApi(node);
  const nonceId = getSmartNonce(wartAddress, 0);

  const { nonce, data } = await signAndSubmitTransaction(api, {
    privateKey: privateKey || undefined,
    nonceId,
    buildSpec: {
      type: 'ASSET_CREATE',
      name: WARTHOG_ETH_ASSET_NAME,
      supply,
      decimals: WARTHOG_ETH_ASSET_DECIMALS,
    },
  });
  bumpNonceAfterSuccess(wartAddress, nonce, 0);

  const txHash = data?.txHash || data?.hash || null;
  let assetHash = txHash
    ? String(txHash).replace(/^0x/i, '').toLowerCase()
    : null;
  const resolved = await resolveEthAssetHash(api, {
    name: WARTHOG_ETH_ASSET_NAME,
    txHash,
    creatorAddress: wartAddress,
  });
  if (resolved) assetHash = resolved;
  if (!assetHash) {
    throw new Error(
      'WETH asset created but hash not found yet — check Assets in wallet shortly',
    );
  }

  const entry = {
    assetHash,
    assetName: WARTHOG_ETH_ASSET_NAME,
    amount: supply,
    decimals: Number(WARTHOG_ETH_ASSET_DECIMALS),
    txHash: txHash ? String(txHash).replace(/^0x/i, '').toLowerCase() : null,
    wartAddress: String(wartAddress).replace(/^0x/i, '').toLowerCase(),
    ownerL1: ownerL1 ? ownerKey(ownerL1) : null,
    createdAt: Date.now(),
    status: 'pending',
    claimLinked: false,
    source: 'local',
  };
  if (ownerL1) saveLocalLink(ownerL1, entry);
  else addWethWatch(wartAddress, entry);

  return entry;
}

/** Payload fields to attach on mint_weth_claim for rollup link. */
export function claimLinkPayload(assetLink, wartAddress) {
  if (!assetLink?.assetHash) return {};
  return {
    assetHash: assetLink.assetHash,
    assetName: assetLink.assetName || WARTHOG_ETH_ASSET_NAME,
    assetAmount: assetLink.amount,
    assetDecimals: assetLink.decimals ?? Number(WARTHOG_ETH_ASSET_DECIMALS),
    wartAddress: wartAddress || assetLink.wartAddress || null,
    assetTxHash: assetLink.txHash || null,
  };
}

/** Summarize active linked supply vs rollup claim (UI helper). */
export function summarizeLinkedWeth(links, claimHuman) {
  const list = Array.isArray(links) ? links : [];
  let active = 0;
  let released = 0;
  for (const e of list) {
    const amt = Number(e.amount) || 0;
    const rel = Number(e.releasedAmount) || 0;
    if (e.status === 'released') released += amt;
    else active += Math.max(0, amt - rel);
  }
  const claim = Number(claimHuman) || 0;
  return {
    activeLinked: active,
    releasedLinked: released,
    claim,
    linkCount: list.length,
    activeCount: list.filter((e) => e.status !== 'released').length,
  };
}

// Back-compat aliases
export const listLocalWethLinks = listLocalEthWartAssets;
