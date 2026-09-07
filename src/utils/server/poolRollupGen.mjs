/**
 * Rollup ticket ids (`wart-pool-0:1`, …) restart at 1 after an Anvil / cartesi
 * wipe. Coordinator JSON lives on the VPS disk, not in the machine — so rooms
 * and paid logs must be archived on that wipe. pool-3p-dapp.json (Q / d_dapp)
 * is custody and is left alone.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const DEFAULT_DATA = '/opt/cartesi-bridge/cartesi-bridge-frontend/.data';

function env(key, fallback = '') {
  const e = globalThis.process?.env || {};
  const v = e[key];
  return v == null || v === '' ? fallback : String(v);
}

export function dataDir() {
  return env('CARTESI_BRIDGE_DATA') || DEFAULT_DATA;
}

export const GEN_PATH = () => path.join(dataDir(), 'pool-3p-rollup-gen.json');

/** Ticket-id scoped. Do not list pool-3p-dapp.json. */
export const TICKET_STATE_FILES = [
  'pool-3p-sessions.json',
  'pool-3p-paid.json',
  'fungible-pool-paid.json',
];

export function readRollupGen() {
  try {
    return JSON.parse(readFileSync(GEN_PATH(), 'utf8'));
  } catch {
    return null;
  }
}

export function writeRollupGen(gen) {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(GEN_PATH(), JSON.stringify(gen, null, 2));
}

/**
 * Highest notice count this deployment has ever seen.
 *
 * `stored.notices` alone cannot carry it: this runs from anvil-bootstrap, i.e.
 * moments after a restart when the rollup has replayed nothing and the live
 * count is 0 — and the previous run wrote that 0 back as the baseline. Once the
 * baseline is 0 the `prev > 0` test below can never fire again, so no wipe is
 * ever detected. That is how `wart-pool-0:1` came back on 2026-09-01 still
 * carrying its 2026-08-30 prep and payout.
 *
 * The claims index keeps the count we need and is wiped by the same bootstrap
 * *after* this check runs, so at this moment it still holds the pre-wipe value
 * (observed: 3115 while live read 0). Read it as the fallback baseline, and
 * persist the result in `maxNotices` so it survives the archive.
 */
function claimsIndexNotices() {
  try {
    const j = JSON.parse(
      readFileSync(path.join(dataDir(), 'claims-index.json'), 'utf8'),
    );
    const n = Number(j?.meta?.noticeCount);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function baselineNotices(stored) {
  return Math.max(Number(stored?.maxNotices) || 0, Number(stored?.notices) || 0);
}

/** Stored record with the claims-index baseline folded in. Impure by design —
 *  `rollupWipeDetected` stays a pure predicate over what it is handed. */
function withClaimsBaseline(stored) {
  if (!stored) return stored;
  const maxNotices = Math.max(baselineNotices(stored), claimsIndexNotices());
  return { ...stored, maxNotices };
}

/** Same signal as claims-index wipe in anvil-bootstrap. */
export function rollupWipeDetected(stored, liveNotices) {
  if (liveNotices == null || !Number.isFinite(Number(liveNotices))) return false;
  const live = Number(liveNotices);
  if (!stored) return false;
  const prev = baselineNotices(stored);
  if (!Number.isFinite(prev)) return false;
  if (prev > 0 && live < prev) return true;
  if (prev > 0 && live === 0) return true;
  return false;
}

function emptySessions(gen) {
  return { tickets: {}, rollupGen: gen };
}

function emptyPool3pPaid(gen) {
  return { pays: [], rollupGen: gen };
}

function emptyFungiblePaid(gen) {
  return { version: 1, tickets: {}, updatedAt: new Date().toISOString(), rollupGen: gen };
}

function writeEmptyTicketFile(name, gen) {
  const p = path.join(dataDir(), name);
  if (name === 'pool-3p-sessions.json') {
    writeFileSync(p, JSON.stringify(emptySessions(gen), null, 2));
  } else if (name === 'pool-3p-paid.json') {
    writeFileSync(p, JSON.stringify(emptyPool3pPaid(gen), null, 2));
  } else if (name === 'fungible-pool-paid.json') {
    writeFileSync(p, JSON.stringify(emptyFungiblePaid(gen), null, 2));
  }
}

/**
 * If GraphQL notice count dropped, copy ticket-id files aside and start empty.
 * Returns { wiped, dir, files, stored, liveNotices }.
 */
export function archiveTicketStateIfStale({ liveNotices, reason = 'anvil-wipe' } = {}) {
  const stored = withClaimsBaseline(readRollupGen());
  const live = liveNotices == null ? null : Number(liveNotices);
  if (!rollupWipeDetected(stored, live) && stored) {
    if (Number.isFinite(live) && live >= Number(stored.notices || 0)) {
      writeRollupGen({
        ...stored,
        notices: live,
        // Monotonic: never let a post-restart sample lower the baseline.
        maxNotices: Math.max(baselineNotices(stored), live),
        at: new Date().toISOString(),
      });
    }
    return { wiped: false, stored, liveNotices: live };
  }
  if (!stored && !Number.isFinite(live)) {
    return { wiped: false, stored: null, liveNotices: live };
  }
  if (!stored) {
    writeRollupGen({
      seq: 1,
      notices: Number.isFinite(live) ? live : 0,
      maxNotices: Math.max(claimsIndexNotices(), Number.isFinite(live) ? live : 0),
      at: new Date().toISOString(),
      reason: 'init',
    });
    return { wiped: false, stored: null, liveNotices: live, init: true };
  }
  if (!rollupWipeDetected(stored, live)) {
    return { wiped: false, stored, liveNotices: live };
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dir = path.join(dataDir(), `reset-backup-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const copied = [];
  for (const name of TICKET_STATE_FILES) {
    const src = path.join(dataDir(), name);
    if (!existsSync(src)) continue;
    copyFileSync(src, path.join(dir, name));
    copied.push(name);
  }
  const gen = {
    seq: Number(stored.seq || 0) + 1,
    notices: Number.isFinite(live) ? live : 0,
    // Survives the archive, so the NEXT wipe is still detectable. Writing the
    // post-wipe count here (always 0) is what blinded this guard before.
    maxNotices: baselineNotices(stored),
    at: new Date().toISOString(),
    reason,
    archivedTo: dir,
    prevNotices: stored.notices,
  };
  for (const name of TICKET_STATE_FILES) writeEmptyTicketFile(name, gen);
  writeRollupGen(gen);
  return { wiped: true, dir, files: copied, stored, liveNotices: live, gen };
}

export function diskGenSeq() {
  return Number(readRollupGen()?.seq || 0);
}
