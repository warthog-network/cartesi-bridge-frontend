/**
 * Sealed preshare store — shared by the WART and ETH 3P pools.
 *
 * What changed and why
 * --------------------
 * `putPreshare` used to accept raw Shamir pieces and `collectPreshare` handed
 * the whole set back. That made this process able to reconstruct d1 and d2 from
 * its own data directory: pieces for both seats, at a threshold equal to the
 * number of pieces stored, sitting next to the dapp share. The ceremony never
 * saw the seat secrets, but the pack store did.
 *
 * Here the coordinator is a relay. Pieces arrive sealed to their recipients and
 * are stored as ciphertext this process holds no key for. Recovery is a
 * conversation it can route but not conduct: a tab asks, holders reseal their
 * piece to that tab on their next heartbeat, and the tab combines. Nothing in
 * this file can open a pack, and that is the point — if a change here ever
 * makes it possible, the change is wrong.
 *
 * Access rules are unchanged in spirit from the plaintext version:
 *  - only the seat holder (or the signer that birthed it) may pack a seat
 *  - only the current holder, or anyone when the seat is vacant, may ask for a
 *    reseal — otherwise any orbit member could farm pieces for a live seat
 *  - only a member the pack actually addressed may answer a reseal
 *  - a pack bound to a different Q is reported stale rather than served
 *  - an announced next-Q pack lives in nextPacks so it cannot clobber the
 *    live Q's recovery material; cutover promotes it after the new P is live
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, copyFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

/** A reseal request is a live conversation; stale ones must not linger. */
const REQUEST_TTL_MS = 10 * 60 * 1000;

/** Keys are only useful while a node is around to be sealed to. */
const KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const nowMs = () => Date.now();

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Create a store bound to one pool.
 *
 * `ctx` supplies what only the pool module knows: who holds a seat, who birthed
 * it, and the live point for it. Passing these in keeps this file free of any
 * pool-specific state — and free of anything that could be combined into a key.
 */
export function createSealedPreshareStore({ file, pool, ctx }) {
  const empty = { v: 1, pool, keys: {}, packs: {}, nextPacks: {}, requests: {}, resealed: {} };

  const load = () => {
    const d = readJson(file, null);
    if (!d || typeof d !== 'object') return { ...empty };
    return {
      ...empty,
      ...d,
      keys: d.keys || {},
      packs: d.packs || {},
      nextPacks: d.nextPacks || {},
      requests: d.requests || {},
      resealed: d.resealed || {},
    };
  };

  /**
   * `.tmp-<pid>` was the same path for every write in the process, so two saves
   * in flight at once wrote the same scratch file and both tried to rename it —
   * the loser got ENOENT because the winner had already moved it away. The lock
   * below now serializes writers, but a scratch name that collides by design is
   * a trap for the next caller, so make it unique per write as well.
   */
  let saveSeq = 0;
  const PACK_BACKUP_KEEP = 12;

  async function backupStore(reason) {
    try {
      if (!existsSync(file)) return;
      const dir = path.dirname(file);
      const base = path.basename(file);
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const dest = path.join(dir, `${base}.bak-${reason}-${stamp}`);
      await copyFile(file, dest);
      const prefix = `${base}.bak-`;
      const names = (await readdir(dir))
        .filter((n) => n.startsWith(prefix))
        .sort();
      while (names.length > PACK_BACKUP_KEEP) {
        const old = names.shift();
        await unlink(path.join(dir, old)).catch(() => null);
      }
    } catch (e) {
      console.warn(`[${pool}3p] pack backup failed (${reason}): ${e?.message || e}`);
    }
  }

  /**
   * Whole-document writes used to drop the other seat's pack (2026-08-25 ETH e2,
   * 2026-09-18 WART d1: packed 01:33, collect no pack 01:58). Never save a
   * document that deletes a live/next pack unless the caller opted in (cutover).
   */
  function preservePacks(next, prev) {
    if (!prev) return next;
    next.packs = next.packs || {};
    next.nextPacks = next.nextPacks || {};
    for (const r of ['1', '2']) {
      if (prev.packs?.[r] && !next.packs[r]) {
        console.warn(
          `[${pool}3p] sealed store refused to drop packs[${r}] from=${String(prev.packs[r].from || '').slice(0, 20)}`,
        );
        next.packs[r] = prev.packs[r];
      }
      if (prev.nextPacks?.[r] && !next.nextPacks[r]) {
        next.nextPacks[r] = prev.nextPacks[r];
      }
    }
    return next;
  }

  async function save(d, { replacePacks = false } = {}) {
    const prev = load();
    const out = replacePacks ? d : preservePacks(d, prev);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${++saveSeq}`;
    await writeFile(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }

  /**
   * Serialize every mutation. This file is one JSON document and each mutator
   * is a whole-document read-modify-write, so two that interleave do not merge:
   * the second `save` writes a document that was loaded before the first one
   * landed, and whatever the first wrote is gone.
   *
   * That is not theoretical. Every heartbeat calls rememberNode (a write), and
   * a recovery round fires requestReseal/putResealed against those beats from a
   * different call path with no shared lock — heartbeatEth3p holds the pool's
   * withEthLock, but pool.js invokes putPack/requestReseal/putResealed straight
   * off the HTTP handler, so the two paths never exclude each other. On
   * 2026-08-25 that dropped the ETH role-2 pack, the only copy of e2's recovery
   * material, while four tabs took turns trying to rebuild the seat from it and
   * every one of them got back "no sealed pack for that seat".
   *
   * The rename in save() is atomic, so a reader never sees a torn file. That is
   * a different property and it was not the one missing. Reads stay unlocked.
   *
   * Process-local, which is what this needs: one Node process owns the file.
   * A second writing process would require a real file lock instead.
   */
  let mutations = Promise.resolve();
  function withStoreLock(fn) {
    const run = mutations.then(fn, fn);
    mutations = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Drop expired requests and keys. Called on every mutation. */
  function sweep(d) {
    const now = nowMs();
    for (const [k, r] of Object.entries(d.requests)) {
      if (!r?.at || now - r.at > REQUEST_TTL_MS) {
        delete d.requests[k];
        delete d.resealed[k];
      }
    }
    for (const [id, k] of Object.entries(d.keys)) {
      if (!k?.at || now - k.at > KEY_TTL_MS) delete d.keys[id];
    }
    return d;
  }

  const reqKey = (role, requesterId) => `${Number(role)}:${String(requesterId)}`;

  function pFromAad(aad) {
    const m = String(aad || '')
      .toLowerCase()
      .match(/(?:^|\|)p=([0-9a-f]+)/);
    return m ? m[1] : '';
  }

  function packHasP(pack, p) {
    const want = String(p || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    if (!want || !pack) return false;
    const got = pFromAad(pack.aad);
    if (got) return got === want;
    return String(pack.aad || '')
      .toLowerCase()
      .includes(`p=${want}`);
  }

  /** Is this pack for the seat that is live right now? */
  function packIsLive(pack, role) {
    const live = String(ctx.liveP(role) || '').toLowerCase();
    if (!live) return false;
    return packHasP(pack, live);
  }

  function packIsNext(pack, role) {
    if (typeof ctx.nextP !== 'function') return false;
    const next = String(ctx.nextP(role) || '').toLowerCase();
    if (!next) return false;
    if (next === String(ctx.liveP(role) || '').toLowerCase()) return false;
    return packHasP(pack, next);
  }

  function mayPack(signerId, role) {
    if (ctx.bornSignerId(role) === signerId) return true;
    if (ctx.currentHolderId(role) !== signerId) return false;
    /**
     * A seat can be leased to a tab that does not have the share yet: that is
     * how a born-but-vacant seat gets recovered. Such a tab must not be able to
     * replace the pack, because the pack is the only copy of the material it is
     * trying to rebuild from — one putPack of garbage with the right aad and the
     * seat is unrecoverable for everyone. Repacking needs a holder that has
     * shown it has the share (birthed the seat, or passed claim_born).
     *
     * Pools that do not distinguish leave holderProven unset and keep the old
     * behaviour, where holding the seat is enough.
     */
    return ctx.holderProven ? !!ctx.holderProven(role, signerId) : true;
  }

  /** Next-Q packer is the tab that birthed that seat, often the live holder. */
  function mayPackNext(signerId, role) {
    if (typeof ctx.nextBornSignerId === 'function' && ctx.nextBornSignerId(role) === signerId) {
      return true;
    }
    return mayPack(signerId, role);
  }

  function packShape(p, role) {
    if (!p) return null;
    return {
      t: p.t,
      n: p.pieces?.length || 0,
      from: p.from,
      at: p.at,
      holders: (p.pieces || []).map((x) => x.id),
      live: packIsLive(p, role),
      next: packIsNext(p, role),
    };
  }

  /** Holder + liveness via ctx.seatOccupant; falls back to holders-only on an old ctx. */
  const seatOccupantOf = (r) => {
    if (typeof ctx.seatOccupant === 'function') return ctx.seatOccupant(r);
    const occupant = ctx.currentHolderId(r) || null;
    return { occupant, live: !!occupant };
  };

  return {
    /**
     * Record a node's public key so other seats can seal pieces to it, plus its
     * most recent signed presence claim.
     *
     * The attestation is stored verbatim and never trusted here — this process
     * has no business deciding whether a holder was present. It is kept so the
     * claim can be checked later by anyone with the node's public key, which is
     * what makes a pool signature produced without its seats detectable.
     */
    async rememberNode({ signerId, pubHex, attestation }) {
      return withStoreLock(async () => {
        const sid = String(signerId || '').trim();
        if (!sid || !/^0[23][0-9a-f]{64}$/i.test(String(pubHex || ''))) return { ok: false };
        const d = sweep(load());
        const prev = d.keys[sid];
        // A node's key is minted once and kept. A different key under the same id
        // means a reinstall (or an impostor); keep the newest but record the
        // change, since outstanding packs addressed to the old key are now dead.
        const rotated = prev?.pubHex && prev.pubHex !== pubHex;
        d.keys[sid] = {
          pubHex: String(pubHex),
          at: nowMs(),
          ...(rotated ? { rotatedFrom: prev.pubHex, rotatedAt: nowMs() } : {}),
          ...(attestation?.sigHex ? { attestation } : {}),
        };
        await save(d);
        return { ok: true, rotated: !!rotated };
      });
    },

    /** Public keys of live orbit members, for a packer to seal to. */
    orbitKeys(liveIds) {
      const d = load();
      const live = new Set((liveIds || []).map(String));
      const out = {};
      for (const [id, k] of Object.entries(d.keys)) {
        if (k?.pubHex && (!liveIds || live.has(id))) out[id] = k.pubHex;
      }
      return out;
    },

    /** Latest attestations, so presence claims can be audited. */
    attestations() {
      const d = load();
      return Object.fromEntries(
        Object.entries(d.keys)
          .filter(([, k]) => k?.attestation)
          .map(([id, k]) => [id, { pubHex: k.pubHex, ...k.attestation }]),
      );
    },

    /**
     * Store a sealed pack for a seat.
     *
     * Live P → packs[role] (recovery for the Q that can currently be spent).
     * Announced next P → nextPacks[role] (does not clobber live recovery).
     * Anything else is a superseded Q and is refused.
     */
    async putPack({ signerId, role, pack }) {
      return withStoreLock(async () => {
        const r = Number(role);
        const sid = String(signerId || '').trim();
        if (r !== 1 && r !== 2) throw new Error('role must be 1 or 2');
        if (!pack?.pieces?.length || !pack?.encRecord?.ct) throw new Error('malformed pack');
        const forLive = packIsLive(pack, r);
        const forNext = !forLive && packIsNext(pack, r);
        if (!forLive && !forNext) {
          throw new Error('preshare denied — pack is not the live or announced next seat P');
        }
        if (forLive && !mayPack(sid, r)) {
          throw new Error('preshare denied — not seat holder or born dealer');
        }
        if (forNext && !mayPackNext(sid, r)) {
          throw new Error('preshare denied — not next-Q dealer or live seat holder');
        }
        // Refuse anything that looks like a secret in the clear. A pack should be
        // opaque here; if it is not, something upstream regressed.
        for (const p of pack.pieces) {
          if (!p?.sealed?.ct || p.y) throw new Error('pack piece is not sealed');
        }

        const d = sweep(load());
        const stored = {
          ...pack,
          from: sid,
          at: new Date().toISOString(),
        };
        const slot = forNext ? 'next' : 'live';
        if (forNext) {
          d.nextPacks[String(r)] = stored;
        } else {
          d.packs[String(r)] = stored;
          if (d.legacy?.[String(r)]) delete d.legacy[String(r)];
        }
        await backupStore(forNext ? `next-d${r}` : `pack-d${r}`);
        await save(d);
        return { ok: true, role: r, n: pack.pieces.length, t: pack.t, slot };
      });
    },

    /**
     * Cutover: the new dapp is already live, so nextPacks whose AAD matches
     * the new live P become packs. Outgoing-Q packs and leftover next packs
     * are dropped. Reseal conversations die with the old P.
     *
     * Call AFTER writeDapp(next) / writeEthDapp(next).
     */
    async promoteOnCutover() {
      return withStoreLock(async () => {
        const d = sweep(load());
        const promoted = {};
        const kept = {};
        for (const r of ['1', '2']) {
          const cand = d.nextPacks?.[r];
          if (cand && packIsLive(cand, Number(r))) {
            kept[r] = cand;
            promoted[r] = true;
          } else if (d.packs?.[r] && packIsLive(d.packs[r], Number(r))) {
            kept[r] = d.packs[r];
          }
        }
        d.packs = kept;
        d.nextPacks = {};
        d.requests = {};
        d.resealed = {};
        await backupStore('cutover');
        await save(d, { replacePacks: true });
        return { ok: true, promoted: Object.keys(promoted), roles: Object.keys(kept) };
      });
    },

    /**
     * A tab that cannot sign asks holders to reseal their pieces to it.
     *
     * Allowed for the current holder, or for anyone when the seat is vacant —
     * a vacant seat is exactly the case this exists to repair. Not allowed for
     * a bystander while someone else holds the seat.
     */
    async requestReseal({ signerId, role, pubHex, aad }) {
      return withStoreLock(async () => {
        const r = Number(role);
        const sid = String(signerId || '').trim();
        // Same liveness as claim/enroll/collect. A soft 200 deny, not a throw:
        // every bystander tab retries this each beat while the seat is held,
        // and each throw was a 400 in nginx with nothing to act on.
        const occ = seatOccupantOf(r);
        if (occ.occupant === sid && typeof ctx.noteHolderCollect === 'function') {
          ctx.noteHolderCollect(r, sid);
        }
        const occ2 = seatOccupantOf(r);
        if (occ2.occupant && occ2.occupant !== sid && occ2.live) {
          return {
            ok: false,
            denied: true,
            role: r,
            holder: occ2.occupant,
            message: `reseal denied — d${r} holder is live`,
          };
        }
        if (!/^0[23][0-9a-f]{64}$/i.test(String(pubHex || ''))) throw new Error('pubHex required');

        const d = sweep(load());
        const pack = d.packs[String(r)];
        if (!pack) {
          // Soft: a seat that was never packed cannot be repaired from the
          // orbit. Clients retry each beat; a throw here was a 400 per beat.
          return { ok: false, denied: true, noPack: true, role: r, message: 'no sealed pack for that seat' };
        }

        const k = reqKey(r, sid);
        const prev = d.requests[k];
        const nextAad = String(aad || pack.aad || '');
        // A client retries this every beat while it cannot sign. Clearing the
        // collected pieces each time throws away progress and can livelock a
        // recovery: pieces arrive one per holder-beat, so a requester that asks
        // faster than holders answer would never reach the threshold. Only reset
        // when the request is genuinely different — a new key or a new seat
        // context means the old ciphertexts are addressed to the wrong recipient.
        const sameRequest =
          prev && prev.pubHex === String(pubHex) && prev.aad === nextAad;
        d.requests[k] = {
          role: r,
          requesterId: sid,
          pubHex: String(pubHex),
          aad: nextAad,
          at: nowMs(),
          ...(sameRequest ? { since: prev.since || prev.at } : {}),
        };
        if (!sameRequest) d.resealed[k] = [];
        await save(d);
        return { ok: true, role: r, holders: pack.pieces.map((p) => p.id), t: pack.t };
      });
    },

    /**
     * What this node should reseal on its next beat.
     *
     * Returns the node's own sealed piece alongside the requester's key. The
     * node opens the piece locally and posts it back resealed; this process
     * never sees either form in the clear.
     */
    pendingFor(signerId) {
      const sid = String(signerId || '').trim();
      if (!sid) return [];
      const d = load();
      const out = [];
      for (const req of Object.values(d.requests)) {
        if (!req?.requesterId || req.requesterId === sid) continue;
        if (nowMs() - (req.at || 0) > REQUEST_TTL_MS) continue;
        const pack = d.packs[String(req.role)];
        const piece = pack?.pieces?.find((p) => String(p.id) === sid);
        if (!piece) continue;
        const already = (d.resealed[reqKey(req.role, req.requesterId)] || []).some(
          (x) => String(x.id) === sid,
        );
        if (already) continue;
        out.push({
          role: req.role,
          requesterId: req.requesterId,
          requesterPub: req.pubHex,
          aad: req.aad,
          piece,
        });
      }
      return out;
    },

    /** A holder answers a request with its piece resealed to the requester. */
    async putResealed({ signerId, role, requesterId, resealed }) {
      return withStoreLock(async () => {
        const r = Number(role);
        const sid = String(signerId || '').trim();
        const d = sweep(load());
        const pack = d.packs[String(r)];
        if (!pack) throw new Error('no sealed pack for that seat');
        if (!pack.pieces.some((p) => String(p.id) === sid)) {
          throw new Error('reseal denied — this signer holds no piece for that seat');
        }
        const k = reqKey(r, requesterId);
        if (!d.requests[k]) throw new Error('no open request');
        if (!resealed?.sealed?.ct) throw new Error('resealed piece is not sealed');

        const list = (d.resealed[k] || []).filter((x) => String(x.id) !== sid);
        list.push({ ...resealed, id: sid });
        d.resealed[k] = list;
        await save(d);
        return { ok: true, role: r, have: list.length, need: pack.t };
      });
    },

    /** The requester collects the pack and whatever holders have resealed. */
    collect({ signerId, role }) {
      const r = Number(role);
      const sid = String(signerId || '').trim();
      const occ0 = seatOccupantOf(r);
      if (occ0.occupant === sid && typeof ctx.noteHolderCollect === 'function') {
        ctx.noteHolderCollect(r, sid);
      }
      const occ = seatOccupantOf(r);
      const holder = occ.occupant;
      if (holder && holder !== sid && occ.live) {
        return {
          ok: false,
          denied: true,
          role: r,
          holder,
          pack: null,
          resealed: [],
          vacant: false,
          message: `collect denied — d${r} holder is live`,
        };
      }
      const d = load();
      const pack = d.packs[String(r)];
      if (!pack) return { ok: true, role: r, pack: null, resealed: [], vacant: !holder || !occ.live };
      if (!packIsLive(pack, r)) {
        return { ok: true, role: r, stale: true, pack: null, resealed: [], vacant: !holder };
      }
      const list = d.resealed[reqKey(r, sid)] || [];
      return {
        ok: true,
        role: r,
        t: pack.t,
        n: pack.pieces.length,
        pack,
        resealed: list,
        ready: list.length >= Number(pack.t || 2),
        vacant: !holder,
      };
    },

    /** Operator view. Deliberately exposes counts, never pack contents. */
    summary() {
      const d = load();
      const packs = {};
      const nextPacks = {};
      for (const [role, p] of Object.entries(d.packs)) {
        packs[role] = packShape(p, Number(role));
      }
      for (const [role, p] of Object.entries(d.nextPacks || {})) {
        nextPacks[role] = packShape(p, Number(role));
      }
      return {
        pool,
        packs,
        nextPacks,
        knownKeys: Object.keys(d.keys).length,
        openRequests: Object.values(d.requests).map((r) => ({
          role: r.role,
          requesterId: r.requesterId,
          have: (d.resealed[reqKey(r.role, r.requesterId)] || []).length,
        })),
      };
    },
  };
}
