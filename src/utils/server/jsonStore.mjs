/**
 * Atomic JSON file writes + serialized read-modify-write.
 *
 * The Path A 3P state (holders, orbit, sessions, rotate) is a set of small JSON
 * files read with `readFileSync` from request handlers and rewritten from those
 * same handlers. Two defects fell out of that on 2026-09-07 and between them
 * stalled the WART rotation:
 *
 *  1. TORN READS. `writeFile` truncates the target in place, so a concurrent
 *     reader can see an empty file, or a short new document with the old tail
 *     still attached. `JSON.parse` throws, callers fall back to their empty
 *     default, and for the length of that window pool-3p-holders.json reads as
 *     "both seats vacant" — which made claimBornSeat's "current holder is
 *     live" guard fail open and hand a seat to a duplicate browser profile.
 *
 *  2. LOST UPDATES. Every mutation was `const h = load(); …; await save(h)`.
 *     The await let another request interleave between the read and the write,
 *     so the second writer clobbered the first's change with a stale snapshot.
 *
 * Fix 1 is rename-over-target: rename is atomic within a filesystem, so a
 * reader sees either the whole old file or the whole new one. Fix 2 is a
 * promise-chain gate that reloads inside the lock.
 */
import { writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

let atomicWriteSeq = 0;
const jsonCache = new Map(); // path -> { mtimeMs, size, value }

/** Sync JSON read with mtime cache. listOpen/ticketIsPaid used to re-parse
 *  sessions+paid on every ticket of every heartbeat (~100% JSON.parse CPU). */
export function readJsonSyncCached(file, fallback) {
  try {
    const st = statSync(file);
    const hit = jsonCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    jsonCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch {
    return fallback;
  }
}

export function invalidateJsonCache(file) {
  if (file) jsonCache.delete(file);
  else jsonCache.clear();
}

/** Write `value` as pretty JSON so that no reader can observe a partial file. */
export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  atomicWriteSeq += 1;
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${atomicWriteSeq.toString(36)}`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, file);
    jsonCache.delete(file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * Serialize read-modify-write on one JSON document.
 *
 * `fn` MUST be synchronous. The gate reloads the document inside the lock, and
 * an await inside `fn` would reopen the exact window this closes. Keeping `fn`
 * synchronous is also what makes the gate safe against nesting: no other code
 * can run between the load and the save, so a nested gate call can never
 * deadlock the chain.
 *
 * The document is rewritten only when `fn` actually changed it, so read-mostly
 * callers add no writes.
 */
export function makeJsonGate(load, save) {
  let tail = Promise.resolve();
  return function withDoc(fn) {
    const next = tail.then(async () => {
      const doc = load();
      const before = JSON.stringify(doc);
      const out = fn(doc);
      if (JSON.stringify(doc) !== before) await save(doc);
      return out;
    });
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}
