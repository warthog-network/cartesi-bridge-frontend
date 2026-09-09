/**
 * The one door to Cartesi `inspect` for the whole coordinator.
 *
 * server-manager (Cartesi 1.5) holds a single session lock. Every InspectState
 * competes with the node's own AdvanceState / GetEpochStatus; too many and the
 * advance-runner aborts, the session taints, the validator segfaults — and a
 * `cartesi run` node then replays every input since genesis (4,545 on
 * 2026-09-08, at ~12/min while inspects kept hitting the lock). Four separate
 * caches used to sit in front of that lock, each with its own TTL and its own
 * per-owner keys, so the fleet's inspect rate scaled with pollers, not time.
 *
 * Here: one cached read per kind per TTL, coalesced, served stale-but-marked
 * when the machine is unwell, and the machine's replay progress is measured
 * (processed_input_count vs the DB's input total) so callers can wait instead
 * of acting on a ledger that is hours behind.
 */
import nodeProcess from 'node:process';

function env(key, fallback = '') {
  const v = nodeProcess.env[key];
  return v == null || v === '' ? fallback : String(v);
}

const INSPECT = env('CARTESI_INSPECT_URL', 'http://127.0.0.1:8080/inspect').replace(/\/$/, '');
const GRAPHQL = env('CARTESI_GRAPHQL_URL', 'http://127.0.0.1:8080/graphql');
const TTL_MS = Number(env('INSPECT_HUB_TTL_MS', '20000')) || 20000;
const OWNER_TTL_MS = Number(env('INSPECT_HUB_OWNER_TTL_MS', '60000')) || 60000;
const REPLAY_TTL_MS = Number(env('INSPECT_HUB_REPLAY_TTL_MS', '60000')) || 60000;
const STALE_MS = Number(env('INSPECT_HUB_STALE_MS', '600000')) || 600000;
const TOTAL_TTL_MS = Number(env('INSPECT_HUB_TOTAL_TTL_MS', '60000')) || 60000;
const REPLAY_LAG_INPUTS = Number(env('INSPECT_HUB_REPLAY_LAG', '3')) || 3;
const REQ_MS = Number(env('INSPECT_HUB_REQ_MS', '12000')) || 12000;

const cache = new Map(); // key -> { at, raw, decoded, inflight }
let total = { at: 0, value: null, inflight: null };
const samples = []; // { at, processed } for rate/eta
let lastProgressLog = 0;
let wasReplaying = false;

export function decodeInspectPayload(payload) {
  if (payload == null) return null;
  if (typeof payload === 'object') return payload;
  const s = String(payload);
  try {
    return JSON.parse(s.startsWith('0x') ? Buffer.from(s.slice(2), 'hex').toString('utf8') : s);
  } catch {
    return null;
  }
}

function proxyIsDown(err) {
  const code = String(err?.cause?.code || err?.code || '');
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH';
}

async function fetchWithTimeout(url, init = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQ_MS);
  try {
    return await fetch(url, { cache: 'no-store', ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readInspect(path) {
  const attempt = async (base) => {
    const res = await fetchWithTimeout(`${base}${path}`);
    if (!res.ok) throw new Error(`inspect HTTP ${res.status}`);
    const raw = await res.json();
    const decoded = decodeInspectPayload(raw?.reports?.[0]?.payload);
    return { raw, decoded, processed: Number(raw?.processed_input_count ?? NaN) };
  };
  try {
    return await attempt(INSPECT);
  } catch (e) {
    // Only when the serialize proxy itself is absent — never bypass it because
    // the node is slow; an unserialized InspectState is what kills the node.
    if (proxyIsDown(e) && INSPECT.includes(':18080')) {
      return attempt(INSPECT.replace(':18080', ':8080'));
    }
    throw e;
  }
}

function noteProgress(processed) {
  if (!Number.isFinite(processed)) return;
  const now = Date.now();
  samples.push({ at: now, processed });
  while (samples.length > 40) samples.shift();
  const v = machineView();
  if (v.replaying && !wasReplaying) {
    console.warn(`[inspect-hub] machine is REPLAYING: ${v.processed}/${v.total} inputs — inspect is stale until it catches up`);
  } else if (!v.replaying && wasReplaying) {
    console.warn(`[inspect-hub] machine caught up: ${v.processed}/${v.total} inputs`);
  } else if (v.replaying && now - lastProgressLog > 300000) {
    console.warn(`[inspect-hub] replay ${v.processed}/${v.total} (${v.ratePerMin}/min, eta ${v.etaMinutes} min)`);
    lastProgressLog = now;
  }
  wasReplaying = v.replaying;
}

async function refreshTotal() {
  const now = Date.now();
  if (total.value != null && now - total.at < TOTAL_TTL_MS) return total.value;
  if (total.inflight) return total.inflight;
  total.inflight = (async () => {
    try {
      const res = await fetchWithTimeout(GRAPHQL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ inputs { totalCount } }' }),
      });
      const j = await res.json();
      const n = Number(j?.data?.inputs?.totalCount);
      if (Number.isFinite(n)) total = { at: Date.now(), value: n, inflight: null };
      return total.value;
    } catch {
      return total.value;
    } finally {
      total.inflight = null;
    }
  })();
  return total.inflight;
}

/** Latest processed count the hub has seen, from any inspect read. */
function lastProcessed() {
  return samples.length ? samples[samples.length - 1].processed : null;
}

export function isReplaying() {
  return machineView().replaying;
}

/** Cheap, synchronous, from cache: how far behind the machine is and how fast it moves. */
export function machineView() {
  const processed = lastProcessed();
  const tot = total.value;
  const lag = processed != null && tot != null ? tot - processed : null;
  let ratePerMin = null;
  if (samples.length >= 2) {
    const a = samples[0];
    const b = samples[samples.length - 1];
    const min = (b.at - a.at) / 60000;
    if (min >= 0.5 && b.processed >= a.processed) ratePerMin = Math.round(((b.processed - a.processed) / min) * 10) / 10;
  }
  const replaying = lag != null && lag > REPLAY_LAG_INPUTS;
  const etaMinutes = replaying && ratePerMin ? Math.round(lag / ratePerMin) : null;
  return {
    processed,
    total: tot,
    lagInputs: lag,
    replaying,
    ratePerMin,
    etaMinutes,
    lastInspectAt: samples.length ? new Date(samples[samples.length - 1].at).toISOString() : null,
  };
}

/**
 * @param {'pool'|'eth3p'} kind
 * @param {{owner?:string, maxAgeMs?:number}} opts  maxAgeMs shortens the TTL for a caller that just posted an input
 * @returns {Promise<{raw:object, decoded:object|null, at:number, ageMs:number, stale:boolean, processed:number|null}>}
 */
export async function getInspect(kind = 'pool', { owner = null, maxAgeMs = null } = {}) {
  const own = owner ? String(owner).replace(/^0x/i, '').toLowerCase() : null;
  const path = own ? `/${kind}/${own}` : `/${kind}`;
  const key = path;
  const now = Date.now();
  const replaying = isReplaying();
  let ttl = own ? OWNER_TTL_MS : replaying ? REPLAY_TTL_MS : TTL_MS;
  if (maxAgeMs != null) ttl = Math.min(ttl, Math.max(0, Number(maxAgeMs)));
  const hit = cache.get(key) || {};
  refreshTotal().catch(() => null);
  if (hit.decoded && now - hit.at < ttl) {
    return { raw: hit.raw, decoded: hit.decoded, at: hit.at, ageMs: now - hit.at, stale: false, processed: hit.processed ?? null };
  }
  if (hit.inflight) return hit.inflight;
  const inflight = (async () => {
    try {
      const r = await readInspect(path);
      noteProgress(r.processed);
      const entry = { at: Date.now(), raw: r.raw, decoded: r.decoded, processed: r.processed };
      cache.set(key, entry);
      return { ...entry, ageMs: 0, stale: false };
    } catch (e) {
      if (hit.decoded && Date.now() - hit.at < STALE_MS) {
        cache.set(key, { ...hit, inflight: null });
        return { raw: hit.raw, decoded: hit.decoded, at: hit.at, ageMs: Date.now() - hit.at, stale: true, processed: hit.processed ?? null, error: e?.message || String(e) };
      }
      throw e;
    } finally {
      const cur = cache.get(key);
      if (cur?.inflight === inflight) delete cur.inflight;
    }
  })();
  cache.set(key, { ...hit, inflight });
  return inflight;
}

/** After posting an input the caller wants the next read fresh. */
export function invalidateInspect(kind = null) {
  if (!kind) {
    cache.clear();
    return;
  }
  for (const k of cache.keys()) if (k === `/${kind}` || k.startsWith(`/${kind}/`)) cache.delete(k);
}
