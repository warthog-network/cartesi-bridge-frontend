/**
 * Path A3 — pool threshold coordinator (unique signers + raisable policy t).
 *
 * Crypto: Shamir over secp256k1, degree shamirT-1 (default 3-of-n).
 * Policy: assemble only after `policyT` *unique issued slots* contribute.
 *   policyT >= shamirT. Auto-raise as more unique signers enroll.
 *
 * Lease: come online → HTTPS enroll returns a share; go away → epoch
 * reshare kills that hex. Clients must keep shareHex in RAM only.
 *
 * Share files live on the coordinator for delivery. This process still
 * reads the hot key to reshare; it must not log or return that key.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import nodeProcess from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FE_ROOT = path.join(__dirname, '../../..');
const require = createRequire(path.join(FE_ROOT, 'package.json'));

function env(key, fallback = '') {
  try {
    const v = nodeProcess.env[key];
    return v == null || v === '' ? fallback : String(v);
  } catch {
    return fallback;
  }
}

const STORE_PATH =
  env('POOL_THRESHOLD_STORE') ||
  path.join(FE_ROOT, '.data/pool-threshold-pending.json');
const REGISTRY_PATH =
  env('POOL_THRESHOLD_REGISTRY') ||
  path.join(FE_ROOT, '.data/pool-threshold-registry.json');
const SHARE_DIR =
  env('POOL_THRESHOLD_SHARE_DIR') ||
  path.join(FE_ROOT, '.data/pool-threshold-shares');
const HOT_PATH =
  env('POOL_THRESHOLD_HOT') ||
  path.join(FE_ROOT, '.data/fungible-pool-hot.json');

const SHAMIR_T = Number(env('POOL_THRESHOLD_SHAMIR_T', env('POOL_THRESHOLD_T', '3')));
const N_MAX = Number(env('POOL_THRESHOLD_N', '4'));
const SHARE_INDEX_CAP = 32;

function isThresholdMode() {
  const v = env('POOL_THRESHOLD_MODE').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function autoRaiseOn() {
  const v = env('POOL_THRESHOLD_AUTO_RAISE', '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

function abandonOn() {
  const v = env('POOL_THRESHOLD_ABANDON', '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

function signerVerifyOn() {
  const v = env('POOL_SIGNER_VERIFY', '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

const GRAPHQL_URL =
  env('CARTESI_GRAPHQL_URL', 'http://127.0.0.1:8080/graphql');
const INSPECT_POOL_URL =
  env('CARTESI_INSPECT_POOL_URL') ||
  `${env('CARTESI_INSPECT_URL', 'http://127.0.0.1:8080/inspect').replace(/\/$/, '')}/pool`;
const WART_HEAD_URL = env(
  'POOL_WART_HEAD_URL',
  'https://warthog-defitestnet.duckdns.org/chain/head',
);
const MAX_SPV_LAG = Number(env('POOL_SPV_MAX_LAG', '64')) || 64;
const MIN_SPV_LAG = Number(env('POOL_SPV_MIN_LAG', '-8'));

function hexToUtf8(raw) {
  const s = String(raw || '');
  if (!s.startsWith('0x')) return s;
  try {
    return Buffer.from(s.slice(2), 'hex').toString('utf8');
  } catch {
    return '';
  }
}

function addrsMatch(a, b) {
  const na = normAddr(a);
  const nb = normAddr(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const a40 = na.length >= 40 ? na.slice(-40) : na;
  const b40 = nb.length >= 40 ? nb.slice(-40) : nb;
  return a40 === b40;
}

function e8Match(a, b) {
  try {
    return BigInt(String(a || '0')) === BigInt(String(b || '0'));
  } catch {
    return false;
  }
}

function decodeInspectBody(body) {
  if (!body || typeof body !== 'object') return null;
  for (const r of body.reports || []) {
    try {
      const obj = JSON.parse(hexToUtf8(r?.payload));
      if (obj && typeof obj === 'object') {
        return {
          ...obj,
          processedInputCount: Number(
            body.processed_input_count ?? obj.processedInputCount ?? 0,
          ),
        };
      }
    } catch {
      /* next */
    }
  }
  return null;
}

function extractWartHead(j) {
  const head = j?.data?.chainHead || j?.chainHead || j?.data || j;
  if (!head || typeof head !== 'object') return null;
  const height = Number(head.height ?? head.blockHeight);
  if (!Number.isFinite(height) || height <= 0) return null;
  return {
    height,
    hash: String(head.hash || head.blockHash || '')
      .replace(/^0x/i, '')
      .toLowerCase(),
  };
}

let inspectLocalCache = { at: 0, value: null };
const INSPECT_LOCAL_TTL_MS = 8000;

async function fetchInspectPoolLocal() {
  if (inspectLocalCache.value && Date.now() - inspectLocalCache.at < INSPECT_LOCAL_TTL_MS) {
    return inspectLocalCache.value;
  }
  const res = await fetch(INSPECT_POOL_URL, { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`inspect HTTP ${res.status}`);
  const pool = decodeInspectBody(body);
  if (!pool?.ok) throw new Error('inspect/pool not ok');
  const value = { raw: body, pool };
  inspectLocalCache = { at: Date.now(), value };
  return value;
}

async function fetchReleaseNoticeLocal(ticketId) {
  const id = String(ticketId || '').trim();
  if (!id) return null;
  let cursor = null;
  let best = null;
  for (let page = 0; page < 20; page++) {
    const after = cursor ? `, before: "${cursor}"` : '';
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ notices(last: 100${after}) { pageInfo { hasPreviousPage startCursor } edges { node { index payload } } } }`,
      }),
    });
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    const json = await res.json();
    const conn = json?.data?.notices || {};
    for (const e of conn.edges || []) {
      let obj = null;
      try {
        obj = JSON.parse(hexToUtf8(e?.node?.payload));
      } catch {
        continue;
      }
      const typ = String(obj.type || '');
      if (
        typ !== 'pool_release_ticket' &&
        typ !== 'pool_release_authorized' &&
        typ !== 'pool_release_pending'
      ) {
        continue;
      }
      if (String(obj.ticketId || '') !== id) continue;
      const idx = Number(e?.node?.index ?? 0);
      const rank =
        typ === 'pool_release_authorized' || obj.status === 'authorized'
          ? 2
          : typ === 'pool_release_ticket'
            ? 1
            : 0;
      const bestRank = best
        ? best.type === 'pool_release_authorized' || best.status === 'authorized'
          ? 2
          : best.type === 'pool_release_ticket'
            ? 1
            : 0
        : -1;
      if (!best || rank > bestRank || (rank === bestRank && idx >= best._index)) {
        best = { ...obj, _index: idx };
      }
    }
    if (best) return best;
    if (!conn.pageInfo?.hasPreviousPage || !conn.pageInfo?.startCursor) break;
    cursor = conn.pageInfo.startCursor;
  }
  return best;
}

async function fetchWartHeadLocal() {
  const res = await fetch(WART_HEAD_URL, { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`wart head HTTP ${res.status}`);
  const head = extractWartHead(body);
  if (!head) throw new Error('wart head missing height');
  return { source: 'defi-head', ...head };
}

export async function getTicketVerifySnapshot(ticketId) {
  const id = String(ticketId || '').trim();
  const [inspect, notice, wartHead, store] = await Promise.all([
    fetchInspectPoolLocal().catch((e) => ({ error: e.message })),
    id && id !== '1'
      ? fetchReleaseNoticeLocal(id).catch((e) => ({ error: e.message }))
      : Promise.resolve(null),
    fetchWartHeadLocal().catch((e) => ({ error: e.message })),
    loadStore().catch(() => ({ requests: {} })),
  ]);
  const req = id && store.requests ? store.requests[id] : null;
  const inspectTicket =
    inspect?.pool && id
      ? (inspect.pool.recentTickets || []).find((t) => String(t.ticketId) === id) ||
        null
      : null;
  return {
    ok: true,
    ticketId: id || null,
    request: req
      ? {
          ticketId: req.ticketId,
          toAddress: req.toAddress,
          amountE8: req.amountE8,
          labDemo: Boolean(req.labDemo),
          status: req.status,
          poolAddress: req.poolAddress,
        }
      : null,
    notice: notice && !notice.error ? notice : null,
    noticeError: notice?.error || null,
    inspect: inspect?.error
      ? { error: inspect.error }
      : {
          pool: inspect.pool,
          processedInputCount: inspect.pool?.processedInputCount,
        },
    inspectTicket,
    wartHead: wartHead?.error ? { error: wartHead.error } : wartHead,
    voucherCount: 0,
  };
}

async function assertTicketStillValid(r) {
  if (!signerVerifyOn()) return { skipped: true };
  const inspect = await fetchInspectPoolLocal();
  const pool = inspect.pool;
  if (r.poolAddress && pool.poolAddress && !addrsMatch(r.poolAddress, pool.poolAddress)) {
    throw new Error('VERIFY: inspect poolAddress does not match ticket');
  }
  const inspectTicket = (pool.recentTickets || []).find(
    (t) => String(t.ticketId) === String(r.ticketId),
  );
  let notice;
  try {
    notice = await fetchReleaseNoticeLocal(r.ticketId);
  } catch (e) {
    throw new Error(`VERIFY: graphql ${e.message}`);
  }
  if (!notice) {
    throw new Error(
      'VERIFY: no pool_release_ticket notice — that notice is the burn attestation',
    );
  }
  const signers = pool.signers || {};
  const quorumOn = !!signers.requireQuorum && Number(signers.enrolled || 0) >= Number(signers.policyT || 0);
  const pending =
    notice.type === 'pool_release_pending' ||
    notice.status === 'pending' ||
    (inspectTicket && inspectTicket.status === 'pending');
  if (quorumOn && pending) {
    throw new Error(
      `VERIFY: ticket still pending on-machine signer quorum (have ${notice.have ?? inspectTicket?.have ?? 0}/${notice.need ?? signers.policyT})`,
    );
  }
  if (!e8Match(notice.amountE8, r.amountE8)) {
    throw new Error('VERIFY: release notice amountE8 mismatch');
  }
  if (r.toAddress && notice.toAddress && !addrsMatch(notice.toAddress, r.toAddress)) {
    throw new Error('VERIFY: release notice toAddress mismatch');
  }
  if (inspectTicket) {
    if (!e8Match(inspectTicket.amountE8, r.amountE8)) {
      throw new Error('VERIFY: inspect ticket amountE8 mismatch');
    }
    if (
      r.toAddress &&
      inspectTicket.toAddress &&
      !addrsMatch(inspectTicket.toAddress, r.toAddress)
    ) {
      throw new Error('VERIFY: inspect ticket toAddress mismatch');
    }
  }
  const spv = pool.spv || {};
  if (!spv.bootstrapped) throw new Error('VERIFY: in-machine SPV not bootstrapped');
  const machineH = Number(spv.bestHeight || 0);
  if (!machineH) throw new Error('VERIFY: in-machine SPV has no tip');
  const head = await fetchWartHeadLocal();
  const lag = head.height - machineH;
  if (lag > MAX_SPV_LAG || lag < MIN_SPV_LAG) {
    throw new Error(`VERIFY: SPV lag ${lag} (machine ${machineH} vs head ${head.height})`);
  }
  const mHash = String(spv.bestHash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (lag === 0 && mHash && head.hash && mHash !== head.hash) {
    throw new Error('VERIFY: SPV hash ≠ independent head');
  }
  return {
    notice: true,
    noticeIndex: notice._index ?? null,
    inspectTicket: Boolean(inspectTicket),
    machineBestHeight: machineH,
    independentHeight: head.height,
    lag,
  };
}

export function shareHashHex(hex) {
  const h = String(hex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  return createHash('sha256').update(h, 'utf8').digest('hex');
}

/** policyT = max(shamirT, ceil(enrolled * 0.75)) once enrolled > 4. */
export function suggestedPolicyT(enrolled, shamirT = SHAMIR_T) {
  const e = Number(enrolled) || 0;
  const t0 = Number(shamirT) || 3;
  if (e <= 0) return t0;
  if (e <= 4) return Math.min(e, t0);
  return Math.min(e, Math.max(t0, Math.ceil(e * 0.75)));
}

function emptyRegistry() {
  return {
    version: 3,
    scheme: 'wart-pool-threshold-shamir-v0',
    shamirT: SHAMIR_T,
    n: N_MAX,
    policyT: SHAMIR_T,
    autoRaise: autoRaiseOn(),
    leaseMode: false,
    epoch: 0,
    slots: {},
    updatedAt: null,
  };
}

async function loadRegistry() {
  try {
    const j = JSON.parse(await readFile(REGISTRY_PATH, 'utf8'));
    if (j && typeof j === 'object') {
      j.slots = j.slots || {};
      return j;
    }
  } catch {
    /* fall through */
  }
  const boot = bootstrapRegistryFromShareDir();
  if (boot) {
    await saveRegistry(boot);
    return boot;
  }
  return emptyRegistry();
}

function bootstrapRegistryFromShareDir() {
  if (!existsSync(SHARE_DIR)) return null;
  const reg = emptyRegistry();
  let found = 0;
  for (let i = 1; i <= SHARE_INDEX_CAP; i++) {
    const p = path.join(SHARE_DIR, `share-${i}.json`);
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      const idx = Number(j.shareIndex || i);
      const hex = String(j.shareHex || '')
        .replace(/^0x/i, '')
        .toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hex)) continue;
      reg.slots[String(idx)] = {
        shareIndex: idx,
        signerId: j.signerId || `pool-signer-${idx}`,
        shareHash: shareHashHex(hex),
        issued: true,
        role: idx === 1 ? 'home-extension' : 'vps-faux',
        lastSeen: null,
      };
      found++;
      if (j.n) reg.n = Number(j.n);
      if (j.threshold) reg.shamirT = Number(j.threshold);
      if (j.epoch) reg.epoch = Number(j.epoch);
    } catch {
      /* skip bad file */
    }
  }
  if (!found) return null;
  const enrolled = Object.values(reg.slots).filter((s) => s.issued).length;
  reg.policyT = suggestedPolicyT(enrolled, reg.shamirT || SHAMIR_T);
  return reg;
}

async function saveRegistry(reg) {
  reg.updatedAt = new Date().toISOString();
  await mkdir(dirname(REGISTRY_PATH), { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 2), { mode: 0o600 });
}

export function enrolledCount(reg) {
  return Object.values(reg.slots || {}).filter((s) => s.issued && s.signerId).length;
}

const ACTIVE_MS = Number(env('POOL_THRESHOLD_ACTIVE_MS', '120000')) || 120000;
const ROTATE_DEBOUNCE_MS =
  Number(env('POOL_THRESHOLD_ROTATE_DEBOUNCE_MS', '15000')) || 15000;

export function isSlotOnline(slot, nowMs = Date.now(), epoch = null) {
  if (!slot?.issued || !slot.signerId || !slot.lastSeen) return false;
  if (epoch != null && Number(slot.heldEpoch || 0) !== Number(epoch)) return false;
  const t = Date.parse(slot.lastSeen);
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= ACTIVE_MS;
}

export function activeSigners(reg, nowMs = Date.now()) {
  const epoch = reg?.leaseMode ? Number(reg.epoch || 0) : null;
  return Object.values(reg.slots || {}).filter((s) => isSlotOnline(s, nowMs, epoch));
}

function nOfNOn() {
  const v = env('POOL_THRESHOLD_N_OF_N', '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

export async function currentPolicyT(regOpt) {
  const override = env('POOL_THRESHOLD_POLICY_T', '').trim();
  if (override && Number(override) >= 2) return Number(override);
  const reg = regOpt || (await loadRegistry());
  const shamirT = Number(reg.shamirT || SHAMIR_T);
  if (nOfNOn()) {
    // Anyone currently running is required. Floor at shamirT so 1 node cannot pay.
    const active = activeSigners(reg).length;
    return Math.max(shamirT, active);
  }
  const enrolled = enrolledCount(reg);
  if (reg.autoRaise !== false && autoRaiseOn()) {
    return suggestedPolicyT(enrolled, shamirT);
  }
  return Number(reg.policyT || shamirT);
}

function shareFileCandidates(idx) {
  return [
    path.join(SHARE_DIR, `share-${idx}.json`),
    path.join(SHARE_DIR, 'unissued', `share-${idx}.json`),
  ];
}

function readShareFile(idx) {
  for (const p of shareFileCandidates(idx)) {
    if (!existsSync(p)) continue;
    try {
      return { path: p, data: JSON.parse(readFileSync(p, 'utf8')) };
    } catch {
      /* try next */
    }
  }
  return null;
}

function loadHotKey() {
  if (!existsSync(HOT_PATH)) {
    throw new Error(`hot key missing at ${HOT_PATH} — cannot reshare`);
  }
  const j = JSON.parse(readFileSync(HOT_PATH, 'utf8'));
  const hex = String(j.privateKeyHex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('hot key retired or invalid — cannot reshare abandoned shares');
  }
  return {
    hex,
    address: String(j.address || '')
      .replace(/^0x/i, '')
      .toLowerCase(),
    poolId: j.poolId || 'wart-pool-0',
  };
}

async function loadShamir() {
  try {
    return await import('./shamirSecp.mjs');
  } catch {
    const candidates = [
      process.env.POOL_SHAMIR_PATH,
      path.join(FE_ROOT, 'src/utils/server/shamirSecp.mjs'),
      '/opt/cartesi-bridge/scripts/lib/shamirSecp.mjs',
      path.join(FE_ROOT, '../scripts/lib/shamirSecp.mjs'),
    ].filter(Boolean);
    let lastErr;
    for (const p of candidates) {
      try {
        return await import(p);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('shamirSecp module not found');
  }
}

let rotating = false;
let lastRotateMs = 0;

function holdersOfCurrentEpoch(reg, nowMs = Date.now()) {
  const epoch = Number(reg.epoch || 0);
  return Object.values(reg.slots || {}).filter((s) => {
    if (!s.issued || !s.signerId) return false;
    if (Number(s.heldEpoch || 0) !== epoch || epoch <= 0) return false;
    return !isSlotOnline(s, nowMs);
  });
}

async function rotateShares(reg, reason, abandoned = []) {
  const hot = loadHotKey();
  const n = Number(reg.n || N_MAX);
  const shamirT = Number(reg.shamirT || SHAMIR_T);
  const { splitSecret, combineSharesHex } = await loadShamir();
  const pts = splitSecret(hot.hex, { t: shamirT, n });
  const check = combineSharesHex(pts.slice(0, shamirT), { t: shamirT });
  if (check !== hot.hex) throw new Error('reshare self-check failed');

  const nextEpoch = Number(reg.epoch || 0) + 1;
  const now = new Date().toISOString();
  await mkdir(path.join(SHARE_DIR, 'unissued'), { recursive: true });

  for (const p of pts) {
    const prev = reg.slots[String(p.index)] || {
      shareIndex: p.index,
      issued: false,
      role: 'reserved',
    };
    const issued = Boolean(prev.issued && prev.signerId);
    const rec = {
      scheme: 'wart-pool-threshold-shamir-v0',
      poolId: hot.poolId,
      poolAddress: hot.address || reg.poolAddress || null,
      threshold: shamirT,
      n,
      epoch: nextEpoch,
      shareIndex: p.index,
      shareHex: p.yHex,
      signerId: issued ? prev.signerId : null,
      createdAt: now,
      issued,
    };
    const dest = issued
      ? path.join(SHARE_DIR, `share-${p.index}.json`)
      : path.join(SHARE_DIR, 'unissued', `share-${p.index}.json`);
    await writeFile(dest, JSON.stringify(rec, null, 2), { mode: 0o600 });
    if (issued) {
      const stale = path.join(SHARE_DIR, 'unissued', `share-${p.index}.json`);
      if (existsSync(stale)) {
        await writeFile(stale, JSON.stringify(rec, null, 2), { mode: 0o600 });
      }
    }
    prev.shareIndex = p.index;
    prev.shareHash = shareHashHex(p.yHex);
    prev.heldEpoch = undefined;
    prev.issued = issued;
    reg.slots[String(p.index)] = prev;
  }

  const store = await loadStore();
  let wiped = 0;
  for (const r of Object.values(store.requests || {})) {
    if (r.status === 'paid' || r.status === 'lab_paid') continue;
    if (r.contributions && Object.keys(r.contributions).length) {
      r.contributions = {};
      wiped += 1;
    }
    r.epoch = nextEpoch;
  }
  if (wiped) await saveStore(store);

  reg.epoch = nextEpoch;
  reg.leaseMode = true;
  reg.rotatedAt = now;
  reg.rotateReason = reason;
  reg.abandoned = abandoned.map((s) => ({
    shareIndex: s.shareIndex,
    signerId: s.signerId,
  }));
  if (!reg.poolAddress && hot.address) reg.poolAddress = hot.address;
  await saveRegistry(reg);
  console.log(
    `[pool-threshold] epoch ${nextEpoch} reshare (${reason}) abandoned=${abandoned.length} wiped=${wiped}`,
  );
  return { rotated: true, epoch: nextEpoch, reason, abandoned: abandoned.length };
}

async function maybeRotateAbandoned(reg) {
  if (!existsSync(HOT_PATH)) return false;
  try {
    const j = JSON.parse(readFileSync(HOT_PATH, 'utf8'));
    if (!j.privateKeyHex || j.retired) return false;
  } catch {
    return false;
  }
  if (!abandonOn() || rotating) return { rotated: false };
  const now = Date.now();
  if (now - lastRotateMs < ROTATE_DEBOUNCE_MS) return { rotated: false };

  const boot = !reg.leaseMode;
  const abandoned = boot ? [] : holdersOfCurrentEpoch(reg, now);
  if (!boot && abandoned.length === 0) return { rotated: false };

  rotating = true;
  lastRotateMs = now;
  try {
    return await rotateShares(reg, boot ? 'enable-lease' : 'abandon', abandoned);
  } catch (e) {
    console.error('[pool-threshold] rotate failed:', e?.message || e);
    return { rotated: false, error: e?.message || String(e) };
  } finally {
    rotating = false;
  }
}

function enrollPayload(reg, slot, hex, rec, { already }) {
  const shamirT = Number(reg.shamirT || SHAMIR_T);
  const n = Number(reg.n || N_MAX);
  return {
    ok: true,
    already: Boolean(already),
    signerId: slot.signerId,
    shareIndex: slot.shareIndex,
    shareHex: hex,
    epoch: Number(reg.epoch || 0),
    scheme: rec?.scheme || 'wart-pool-threshold-shamir-v0',
    poolAddress: rec?.poolAddress || reg.poolAddress || null,
    shamirT,
    n,
    threshold: null,
    enrolled: enrolledCount(reg),
    active: activeSigners(reg).length,
    need: null,
    role: slot.role || 'open-node',
    leaseMs: ACTIVE_MS,
    persistShare: false,
  };
}

/**
 * Auto-enroll a unique browser/extension node as the next unused Shamir slot.
 * Same signerId always gets the same slot. Share material is the *current*
 * epoch only — previous hex is dead after a rotate.
 */
export async function enrollThresholdSigner({ signerId, role } = {}) {
  const sid = String(signerId || '').trim();
  if (sid.length < 16 || sid.length > 120) {
    throw new Error('signerId must be 16–120 chars (use a persisted UUID)');
  }
  if (!/^[a-zA-Z0-9._:-]+$/.test(sid)) {
    throw new Error('signerId has invalid characters');
  }

  const reg = await loadRegistry();
  await maybeRotateAbandoned(reg);
  const n = Number(reg.n || N_MAX);
  const shamirT = Number(reg.shamirT || SHAMIR_T);

  for (const slot of Object.values(reg.slots || {})) {
    if (slot.issued && slot.signerId === sid) {
      const rec = readShareFile(slot.shareIndex);
      if (!rec?.data?.shareHex) {
        throw new Error(`slot ${slot.shareIndex} is issued but share file is missing`);
      }
      const hex = String(rec.data.shareHex).replace(/^0x/i, '').toLowerCase();
      slot.lastSeen = new Date().toISOString();
      slot.heldEpoch = Number(reg.epoch || 0);
      slot.shareHash = shareHashHex(hex);
      await saveRegistry(reg);
      const policyT = await currentPolicyT(reg);
      const payload = enrollPayload(reg, slot, hex, rec.data, { already: true });
      payload.threshold = policyT;
      payload.need = policyT;
      payload.shamirT = shamirT;
      payload.n = n;
      return payload;
    }
  }

  let freeIdx = null;
  for (let i = 1; i <= n; i++) {
    const slot = reg.slots[String(i)];
    if (!slot) {
      freeIdx = i;
      break;
    }
    if (!slot.issued) {
      freeIdx = i;
      break;
    }
  }
  if (freeIdx == null) {
    throw new Error(`roster full (${n} unique signers) — ops must expand the ceremony`);
  }

  const rec = readShareFile(freeIdx);
  if (!rec?.data?.shareHex) {
    throw new Error(`no share file for slot ${freeIdx} — run ceremony --n ${n}`);
  }
  const hex = String(rec.data.shareHex).replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('bad share material on disk');

  const now = new Date().toISOString();
  reg.slots[String(freeIdx)] = {
    ...(reg.slots[String(freeIdx)] || {}),
    shareIndex: freeIdx,
    signerId: sid,
    shareHash: shareHashHex(hex),
    issued: true,
    role: role || 'open-node',
    lastSeen: now,
    heldEpoch: Number(reg.epoch || 0),
    signedCount: Number(reg.slots[String(freeIdx)]?.signedCount || 0),
    enrolledAt: now,
  };

  rec.data.signerId = sid;
  rec.data.issued = true;
  rec.data.epoch = Number(reg.epoch || 0);
  const dest = path.join(SHARE_DIR, `share-${freeIdx}.json`);
  await mkdir(SHARE_DIR, { recursive: true });
  await writeFile(dest, JSON.stringify(rec.data, null, 2), { mode: 0o600 });
  await saveRegistry(reg);

  const policyT = await currentPolicyT(reg);
  const slot = reg.slots[String(freeIdx)];
  const payload = enrollPayload(reg, slot, hex, rec.data, { already: false });
  payload.threshold = policyT;
  payload.need = policyT;
  payload.shamirT = shamirT;
  payload.n = n;
  return payload;
}

async function loadStore() {
  try {
    return JSON.parse(await readFile(STORE_PATH, 'utf8'));
  } catch {
    return { version: 1, requests: {}, updatedAt: null };
  }
}

async function saveStore(s) {
  s.updatedAt = new Date().toISOString();
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
}

function normAddr(a) {
  return String(a || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

function publicSlots(reg) {
  const now = Date.now();
  const epoch = Number(reg.epoch || 0);
  const liveEpoch = reg.leaseMode ? epoch : null;
  return Object.values(reg.slots || {})
    .sort((a, b) => a.shareIndex - b.shareIndex)
    .map((s) => ({
      shareIndex: s.shareIndex,
      signerId: s.issued ? s.signerId : null,
      issued: Boolean(s.issued),
      role: s.role || (s.issued ? 'signer' : 'reserved'),
      lastSeen: s.lastSeen || null,
      online: isSlotOnline(s, now, liveEpoch),
      abandoned: Boolean(s.issued) && !isSlotOnline(s, now, liveEpoch),
      holding: Number(s.heldEpoch || 0) === epoch && epoch > 0 && isSlotOnline(s, now, liveEpoch),
      signedCount: Number(s.signedCount || 0),
      lastSignedTicket: s.lastSignedTicket || null,
      lastSignedAt: s.lastSignedAt || null,
    }));
}

export async function getThresholdStatus(ticketId) {
  const s = await loadStore();
  const reg = await loadRegistry();
  await maybeRotateAbandoned(reg);
  const policyT = await currentPolicyT(reg);
  const shamirT = Number(reg.shamirT || SHAMIR_T);
  const n = Number(reg.n || N_MAX);
  const enrolled = enrolledCount(reg);
  const active = activeSigners(reg).length;
  const signerInfo = {
    shamirT,
    n,
    policyT,
    mode: nOfNOn() ? 'n-of-n-active' : 'fixed',
    activeMs: ACTIVE_MS,
    leaseMs: ACTIVE_MS,
    epoch: Number(reg.epoch || 0),
    leaseMode: Boolean(reg.leaseMode),
    abandon: abandonOn(),
    persistShare: false,
    rotatedAt: reg.rotatedAt || null,
    rotateReason: reg.rotateReason || null,
    suggestedPolicyT: nOfNOn()
      ? Math.max(shamirT, active)
      : suggestedPolicyT(enrolled, shamirT),
    autoRaise: reg.autoRaise !== false && autoRaiseOn(),
    enrolled,
    active,
    uniqueRequired: policyT,
    slots: publicSlots(reg),
  };

  if (ticketId) {
    const r = s.requests[ticketId];
    if (!r) {
      return {
        ok: true,
        thresholdMode: isThresholdMode(),
        t: policyT,
        n,
        shamirT,
        ticketId,
        found: false,
        signers: signerInfo,
      };
    }
    return {
      ok: true,
      thresholdMode: isThresholdMode(),
      t: policyT,
      n,
      shamirT,
      ticketId,
      found: true,
      status: r.status,
      count: Object.keys(r.contributions || {}).length,
      need: r.threshold || policyT,
      quorumMet:
        Object.keys(r.contributions || {}).length >= (r.threshold || policyT),
      contributors: Object.values(r.contributions || {}).map((c) => ({
        shareIndex: c.shareIndex,
        signerId: c.signerId,
      })),
      toAddress: r.toAddress,
      amountE8: r.amountE8,
      poolAddress: r.poolAddress,
      paid: r.paid || null,
      error: r.error || null,
      openedAt: r.openedAt,
      signers: signerInfo,
    };
  }
  const all = Object.values(s.requests || {});
  const open = all.filter(
    (r) => r.status === 'open' || r.status === 'assembling' || r.status === 'failed',
  );
  const recent = all
    .filter((r) => r.status === 'paid' || r.status === 'lab_paid')
    .sort((a, b) =>
      String(b.paid?.paidAt || '').localeCompare(String(a.paid?.paidAt || '')),
    )
    .slice(0, 5)
    .map((r) => ({
      ticketId: r.ticketId,
      status: r.status,
      labDemo: Boolean(r.labDemo),
      paid: r.paid,
      amountE8: r.amountE8,
    }));
  return {
    ok: true,
    thresholdMode: isThresholdMode(),
    t: policyT,
    n,
    shamirT,
    epoch: Number(reg.epoch || 0),
    openCount: open.filter((r) => r.status === 'open' || r.status === 'assembling')
      .length,
    open: open.map((r) => ({
      ticketId: r.ticketId,
      count: Object.keys(r.contributions || {}).length,
      need: r.threshold || policyT,
      amountE8: r.amountE8,
      toAddress: r.toAddress,
      status: r.status,
      labDemo: Boolean(r.labDemo),
      error: r.error || null,
      contributors: Object.values(r.contributions || {}).map((c) => c.signerId),
    })),
    recentPaid: recent,
    signers: signerInfo,
    fauxSignersHint:
      'Lease: HTTPS enroll hands a RAM-only share. Idle > leaseMs → epoch reshare, old hex is dead.',
  };
}

export async function openThresholdPayout({
  ticketId,
  toAddress,
  amountE8,
  owner,
  poolAddress,
  noticeIndex,
  labDemo = false,
}) {
  const id = String(ticketId || '').trim();
  if (!id) throw new Error('ticketId required');
  const to = normAddr(toAddress);
  const amt = String(amountE8);
  if (!to || BigInt(amt) <= 0n) throw new Error('toAddress/amountE8 required');

  const reg = await loadRegistry();
  await maybeRotateAbandoned(reg);
  const policyT = await currentPolicyT(reg);
  const shamirT = Number(reg.shamirT || SHAMIR_T);
  const n = Number(reg.n || N_MAX);

  const s = await loadStore();
  const existing = s.requests[id];
  if (existing && (existing.status === 'paid' || existing.status === 'lab_paid')) {
    return { ok: true, alreadyPaid: true, ...summarize(existing, policyT) };
  }
  if (existing && existing.status === 'open') {
    return { ok: true, alreadyOpen: true, ...summarize(existing, policyT) };
  }

  s.requests[id] = {
    ticketId: id,
    toAddress: to,
    amountE8: amt,
    owner: owner || null,
    poolAddress: normAddr(poolAddress),
    noticeIndex: noticeIndex ?? null,
    threshold: policyT,
    shamirT,
    n,
    epoch: Number(reg.epoch || 0),
    status: 'open',
    contributions: {},
    openedAt: new Date().toISOString(),
    paid: null,
    error: null,
    labDemo: Boolean(labDemo),
  };
  await saveStore(s);
  return {
    ok: true,
    opened: true,
    labDemo: Boolean(labDemo),
    ...summarize(s.requests[id], policyT),
  };
}

export async function openLabDemoThreshold({ amountE8, poolAddress, toAddress } = {}) {
  const { getPoolHotPublic } = await import('./poolPayout.mjs');
  const pub = await getPoolHotPublic();
  const pool = normAddr(poolAddress || pub.address);
  if (!pool) throw new Error('pool address unknown');
  const to = normAddr(toAddress || pool);
  const id = `lab-demo-${Date.now()}`;
  return openThresholdPayout({
    ticketId: id,
    toAddress: to,
    amountE8: amountE8 || '100000000',
    owner: null,
    poolAddress: pool,
    noticeIndex: null,
    labDemo: true,
  });
}

function summarize(r, policyT) {
  const need = r.threshold || policyT || SHAMIR_T;
  return {
    ticketId: r.ticketId,
    status: r.status,
    count: Object.keys(r.contributions || {}).length,
    need,
    quorumMet: Object.keys(r.contributions || {}).length >= need,
    toAddress: r.toAddress,
    amountE8: r.amountE8,
    paid: r.paid,
  };
}

export async function contributeThresholdShare({
  ticketId,
  shareIndex,
  shareHex,
  signerId,
  verification,
}) {
  const id = String(ticketId || '').trim();
  const idx = Number(shareIndex);
  const yHex = String(shareHex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const sid = String(signerId || '').trim();
  if (!id) throw new Error('ticketId required');
  if (!Number.isFinite(idx) || idx < 1 || idx > SHARE_INDEX_CAP) {
    throw new Error(`shareIndex must be 1..${SHARE_INDEX_CAP}`);
  }
  if (!/^[0-9a-f]{64}$/.test(yHex)) throw new Error('shareHex must be 32-byte hex');
  if (!sid) throw new Error('signerId required (unique per operator)');

  const reg = await loadRegistry();
  await maybeRotateAbandoned(reg);
  const n = Number(reg.n || N_MAX);
  if (idx > n) throw new Error(`shareIndex ${idx} > n=${n}`);

  const slot = reg.slots[String(idx)];
  if (!slot) {
    throw new Error(`share slot ${idx} is not in the ceremony registry`);
  }
  if (!slot.issued) {
    throw new Error(`share slot ${idx} is reserved / not issued to a unique signer`);
  }
  if (slot.signerId && slot.signerId !== sid) {
    throw new Error(
      `signerId mismatch: slot ${idx} belongs to ${slot.signerId}, not ${sid}`,
    );
  }
  if (slot.shareHash && slot.shareHash !== shareHashHex(yHex)) {
    throw new Error(
      'EPOCH_ROTATED: share is dead — re-enroll over HTTPS for a fresh lease',
    );
  }
  // One signerId owns at most one slot
  for (const other of Object.values(reg.slots)) {
    if (other.shareIndex !== idx && other.issued && other.signerId === sid) {
      throw new Error(`signerId ${sid} already bound to slot ${other.shareIndex}`);
    }
  }

  slot.lastSeen = new Date().toISOString();
  slot.heldEpoch = Number(reg.epoch || 0);
  await saveRegistry(reg);

  const policyT = await currentPolicyT(reg);
  const s = await loadStore();
  const r = s.requests[id];
  if (!r) throw new Error(`no open request for ticket ${id} — call threshold_open first`);
  const verified = await assertTicketStillValid(r);
  r.lastVerify = {
    at: new Date().toISOString(),
    signerId: sid,
    client: verification || null,
    server: verified,
  };
  if (r.status === 'paid' || r.status === 'lab_paid') {
    return { ok: true, alreadyPaid: true, ...summarize(r, policyT) };
  }
  if (r.status === 'failed') {
    r.status = 'open';
    r.error = null;
  }

  const existing = r.contributions?.[String(idx)];
  if (existing) {
    if (existing.signerId && existing.signerId !== sid) {
      throw new Error(`slot ${idx} already contributed by ${existing.signerId}`);
    }
    const count = Object.keys(r.contributions).length;
    if (count >= (r.threshold || policyT)) {
      return assembleAndPay(id);
    }
    return {
      ok: true,
      contributed: true,
      alreadyHad: true,
      signerId: sid,
      epoch: Number(reg.epoch || 0),
      ...summarize(r, policyT),
      message: `share ${idx} (${sid}) already present — ${count}/${r.threshold || policyT}`,
    };
  }

  // Unique signer per ticket: same signerId cannot fill two indexes
  for (const c of Object.values(r.contributions || {})) {
    if (c.signerId === sid && c.shareIndex !== idx) {
      throw new Error(`signer ${sid} already contributed slot ${c.shareIndex} on this ticket`);
    }
  }

  r.contributions[String(idx)] = {
    shareIndex: idx,
    shareHex: yHex,
    signerId: sid,
    epoch: Number(reg.epoch || 0),
    at: new Date().toISOString(),
  };
  s.requests[id] = r;
  await saveStore(s);

  slot.signedCount = Number(slot.signedCount || 0) + 1;
  slot.lastSignedTicket = id;
  slot.lastSignedAt = new Date().toISOString();
  await saveRegistry(reg);

  const count = Object.keys(r.contributions).length;
  const need = r.threshold || policyT;
  if (count < need) {
    return {
      ok: true,
      contributed: true,
      signerId: sid,
      epoch: Number(reg.epoch || 0),
      ...summarize(r, policyT),
      message: `unique signer ${sid} accepted — ${count}/${need}`,
    };
  }

  return assembleAndPay(id);
}

export async function heartbeatSigner({ signerId, shareIndex, epoch } = {}) {
  const sid = String(signerId || '').trim();
  const idx = Number(shareIndex);
  if (!sid || !Number.isFinite(idx)) throw new Error('signerId + shareIndex required');
  const reg = await loadRegistry();
  await maybeRotateAbandoned(reg);
  const slot = reg.slots[String(idx)];
  if (!slot || !slot.issued) throw new Error(`slot ${idx} not issued`);
  if (slot.signerId !== sid) throw new Error('signerId does not own this slot');
  const curEpoch = Number(reg.epoch || 0);
  const clientEpoch =
    epoch == null || epoch === '' ? null : Number(epoch);
  const rotated =
    clientEpoch != null && Number.isFinite(clientEpoch) && clientEpoch !== curEpoch;
  if (!rotated) {
    slot.lastSeen = new Date().toISOString();
    if (clientEpoch === curEpoch && curEpoch > 0) {
      slot.heldEpoch = curEpoch;
    }
    await saveRegistry(reg);
  }
  const policyT = await currentPolicyT(reg);
  return {
    ok: true,
    signerId: sid,
    shareIndex: idx,
    lastSeen: slot.lastSeen,
    signedCount: Number(slot.signedCount || 0),
    lastSignedTicket: slot.lastSignedTicket || null,
    lastSignedAt: slot.lastSignedAt || null,
    policyT,
    enrolled: enrolledCount(reg),
    active: activeSigners(reg).length,
    epoch: curEpoch,
    rotated,
    leaseMs: ACTIVE_MS,
  };
}

async function assembleAndPay(ticketId) {
  const s = await loadStore();
  const r = s.requests[ticketId];
  if (!r) throw new Error('request vanished');
  r.status = 'assembling';
  await saveStore(s);

  let skHex = null;
  try {
    const { combineSharesHex } = await loadShamir();
    const pts = Object.values(r.contributions).map((c) => ({
      index: c.shareIndex,
      yHex: c.shareHex,
    }));
    const shamirT = Number(r.shamirT || SHAMIR_T);
    if (pts.length < shamirT) {
      throw new Error(`need ≥${shamirT} unique shares to reconstruct, got ${pts.length}`);
    }
    // Use all unique contributions (policy may require more than shamirT)
    skHex = combineSharesHex(pts, { t: pts.length });

    const { Account } = await import('warthog-js');
    const acc = Account.fromPrivateKeyHex(skHex);
    const derived = String(acc.address.hex).toLowerCase();
    if (r.poolAddress && derived !== r.poolAddress) {
      throw new Error(
        `reconstructed key address ${derived.slice(0, 12)} ≠ pool ${r.poolAddress.slice(0, 12)}`,
      );
    }

    if (r.labDemo) {
      r.status = 'lab_paid';
      r.paid = {
        txHash: null,
        labDemo: true,
        reconstructedAddress: derived,
        paidAt: new Date().toISOString(),
        note: 'Lab demo: unique-signer reconstruct OK; no Warthog transfer submitted',
      };
      r.contributions = {};
      r.error = null;
      s.requests[ticketId] = r;
      await saveStore(s);
      return {
        ok: true,
        assembled: true,
        paid: true,
        labDemo: true,
        ...summarize(r),
        payout: r.paid,
      };
    }

    const { payoutPoolTicket } = await import('./poolPayout.mjs');
    const result = await payoutPoolTicket({
      ticketId: r.ticketId,
      toAddress: r.toAddress,
      amountE8: r.amountE8,
      owner: r.owner,
      verifiedFromNotice: true,
      noticeIndex: r.noticeIndex,
      privateKeyHex: skHex,
    });

    r.status = 'paid';
    r.paid = {
      txHash: result.txHash || result.hash || null,
      paidAt: new Date().toISOString(),
      alreadyPaid: result.alreadyPaid || false,
      skipped: result.skipped || false,
    };
    r.contributions = {};
    r.error = null;
    s.requests[ticketId] = r;
    await saveStore(s);

    return {
      ok: true,
      assembled: true,
      paid: true,
      ...summarize(r),
      payout: result,
    };
  } catch (e) {
    r.status = 'failed';
    r.error = e?.message || String(e);
    s.requests[ticketId] = r;
    await saveStore(s);
    throw e;
  } finally {
    skHex = null;
  }
}

export async function listOpenThresholdRequests() {
  return getThresholdStatus();
}

export { isThresholdMode, SHAMIR_T as THRESHOLD_T, N_MAX as THRESHOLD_N };
