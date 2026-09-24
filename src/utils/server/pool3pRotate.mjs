/**
 * Path A Q rotation without rebuilding the Cartesi machine.
 * Clock: Anvil/L1 blocks (this lab: 1 block = 1 Cartesi epoch, 3s).
 * New Q is client-born: VPS only d_dapp; browsers birth d1/d2.
 *
 * Phases: idle → need_birth → next_ready → announced → sweeping → cutover → idle
 */
import { readFileSync, existsSync } from 'node:fs';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  createDappOnlyPool,
  finalizeClientBornQ,
  loadDapp,
  writeDapp,
  openPool3pPayout,
  listOpenPool3pTickets,
  listOpenUserPool3pTickets,
  listPaidPool3pTickets,
  expireStaleUserRooms,
  closePool3pRoom,
  holdersFrozen,
  adoptHoldersFromDapp,
  invalidateOpenLindell,
  clearPreshare,
  wartSealedPreshare,
  requireSeatPok,
  stashSeatPdl,
  ORBIT_VPS_ID,
  loadHolders,
  recoverabilityView,
  paidRecordFor,
  nextBirthDeniedReason,
  nextPackSweepReady,
  maybeResetStuckFinish,
} from './pool3p.mjs';
import { getInspect, invalidateInspect, isReplaying, machineView } from './inspectHub.mjs';
import { isV2 as rollupsIsV2, addInput as rollupsAddInput } from './rollupsApi.mjs';
import { assertPaillierModulus, seatPokContext } from '../twoPartyEcdsa.js';
import { writeJsonAtomic } from './jsonStore.mjs';
import {
  verifyRangeLindell,
  pdlVerifierChallenge,
  pdlChallengePublic,
} from '../lindellZk.js';

function env(key, fallback = '') {
  const e = globalThis.process?.env || {};
  const v = e[key];
  return v == null || v === '' ? fallback : String(v);
}

function envOn(key, fallback = true) {
  const v = env(key, fallback ? '1' : '0').trim().toLowerCase();
  if (v === '') return fallback;
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

const DEFAULT_DATA = (globalThis.process?.env?.CARTESI_BRIDGE_DATA || '/opt/cartesi-bridge/cartesi-bridge-frontend/.data');
const ROTATE_PATH = env('POOL_3P_ROTATE') || path.join(DEFAULT_DATA, 'pool-3p-rotate.json');
export const NEXT_DAPP_PATH =
  env('POOL_3P_NEXT_DAPP') || path.join(DEFAULT_DATA, 'pool-3p-next.json');
const INTERVAL = Number(env('POOL_3P_ROTATE_EPOCHS', '1000')) || 1000;
/**
 * A sweep is only done when Warthog mined it. The rotation clock is Anvil
 * blocks, which keep ticking while the Warthog chain stalls: on 2026-08-31 a
 * 25-hour stall let 25 rotations run past an unmined sweep and stranded the
 * whole pool (1194.99779997 WART) in a Q that had already been retired.
 * Confirmations, not elapsed Anvil epochs, gate the next rotation.
 */
const SWEEP_MIN_CONF = Number(env('POOL_3P_SWEEP_MIN_CONF', '2')) || 2;
const REANNOUNCE_MS = Number(env('POOL_3P_REANNOUNCE_MS', '300000')) || 300000;
const RPC = env('CARTESI_RPC_URL', 'http://127.0.0.1:8545');
const INSPECT = env('CARTESI_INSPECT_URL', 'http://127.0.0.1:8080/inspect');
const WART_NODE =
  env('WARTHOG_RPC') || env('FUNGIBLE_POOL_NODE') || 'http://127.0.0.1:3001';

function emptyRotate() {
  return {
    intervalEpochs: INTERVAL,
    anchorBlock: null,
    phase: 'idle',
    next: null,
    last: null,
  };
}

function loadRotate() {
  try {
    return { ...emptyRotate(), ...JSON.parse(readFileSync(ROTATE_PATH, 'utf8')) };
  } catch {
    return emptyRotate();
  }
}

/** Atomic: a torn read of the rotate state reads as phase `idle` and re-arms. */
async function saveRotate(r) {
  await writeJsonAtomic(ROTATE_PATH, r);
}

function loadNextDapp() {
  if (!existsSync(NEXT_DAPP_PATH)) return null;
  try {
    return JSON.parse(readFileSync(NEXT_DAPP_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function writeNextDapp(d) {
  await mkdir(path.dirname(NEXT_DAPP_PATH), { recursive: true });
  await writeFile(NEXT_DAPP_PATH, JSON.stringify(d, null, 2));
}

export async function anvilBlockNumber() {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  const j = await res.json();
  const hex = j?.result;
  if (!hex) throw new Error('eth_blockNumber failed');
  return Number(BigInt(hex));
}

/** Inspect through the hub; the fallback / proxy rules live there now. */
export async function inspectPoolSnap() {
  const r = await getInspect('pool');
  if (!r.decoded) throw new Error('inspect returned no pool report');
  return r.decoded;
}

export async function machineSupportsSetAddress() {
  const r = loadRotate();
  if (r.machineHasSetAddress) return true;
  try {
    const snap = await inspectPoolSnap();
    const ok = !!(snap && Object.prototype.hasOwnProperty.call(snap, 'rotationEpoch'));
    if (ok) {
      r.machineHasSetAddress = true;
      await saveRotate(r);
    }
    return ok;
  } catch {
    return false;
  }
}

/**
 * Keep Cartesi inspect on the sealed live coordinator Q.
 * Fresh start is not done until this matches. Does not invent Q.
 */
export async function syncInspectToLiveCoordinator(opts = {}) {
  const dapp = loadDapp();
  const addr = normQ(dapp?.address);
  if (!/^[0-9a-f]{48}$/.test(addr)) {
    return { ok: false, skipped: 'coordinator has no sealed Q' };
  }
  // activateNextUnbound(): the live Q was promoted without a machine bind
  // because its creation block fell out of the machine LC window. Re-pinning
  // would post pool_announce_next(live) — flipping pendingNext away from the
  // new next Q mid-rotation — and a pool_set_address the machine rejects.
  // The machine stays on the previous Q until the next cutover binds a
  // fresh sweep; that cutover replaces r.last and lifts this.
  const lastRot = loadRotate()?.last;
  if (lastRot?.unboundInMachine && normQ(lastRot.address) === addr) {
    return {
      ok: false,
      skipped: 'live Q activated without a machine bind (LC window); machine stays on previous Q until the next cutover',
      machineLive: lastRot.machineLive || null,
    };
  }
  const p1 = dapp?.seats?.[1]?.P || dapp?.seats?.['1']?.P || dapp?.seal?.P1;
  const p2 = dapp?.seats?.[2]?.P || dapp?.seats?.['2']?.P || dapp?.seal?.P2;
  if (!p1 || !p2 || !dapp?.seal) {
    return { ok: false, skipped: 'seats not both born' };
  }
  if (!(await machineSupportsSetAddress())) {
    return { ok: false, skipped: 'machine has no pool_set_address' };
  }
  let snap = await inspectPoolSnap();
  const inspectAddr = normQ(snap?.poolAddress);
  if (inspectAddr === addr) {
    // Address match is not enough. Inspect with a null/wrong id is an
    // incomplete Q — never "already synced".
    const chain = await wartAccount(addr).catch(() => null);
    const chainId = Number(chain?.accountId || 0);
    const inspectId = Number(snap?.poolAccountId || 0);
    const prevHex = normQ(snap?.previousAddress);
    const prevChain = prevHex
      ? await wartAccount(prevHex).catch(() => null)
      : null;
    const prevChainId = Number(prevChain?.accountId || 0);
    if (inspectPairOk(snap, addr, chainId > 0 ? chainId : null)) {
      return {
        ok: true,
        already: true,
        address: addr,
        poolAccountId: inspectId,
      };
    }
    if (
      chainId > 0 &&
      chainId !== inspectId &&
      !(prevChainId > 0 && chainId === prevChainId)
    ) {
      const sweepHash = loadRotate()?.last?.sweepTxHash || null;
      if (!sweepHash) {
        return {
          ok: false,
          address: addr,
          poolAccountId: inspectId || null,
          waiting: 'no sweep hash to SPV-bind account id',
        };
      }
      const posted = await postProvenPoolAccountId({
        txHash: sweepHash,
        poolAddress: addr,
        destAccountId: chainId,
      });
      invalidateInspect('pool');
      const after = await waitInspect(
        (s) => inspectPairOk(s, addr, chainId),
        8,
        2000,
      );
      const rot = loadRotate();
      if (rot.last && normQ(rot.last.address) === addr) {
        rot.last.accountId = chainId;
        await saveRotate(rot);
      }
      return {
        ok: inspectPairOk(after, addr, chainId),
        address: addr,
        poolAccountId: after?.poolAccountId ?? chainId,
        patchedAccountId: chainId,
        setAccountTx: posted.txHash,
      };
    }
    return {
      ok: false,
      address: addr,
      poolAccountId: inspectId || null,
      waiting: 'inspect poolAccountId missing or does not match Warthog',
    };
  }
  const pending = normQ(snap?.pendingNext?.address || snap?.pendingNext);
  const waitTries = Math.max(1, Number(opts.waitTries ?? 2) || 2);
  let announce = null;
  if (pending !== addr) {
    announce = await submitPoolAdvance({
      type: 'pool_announce_next',
      address: addr,
      publicKey: dapp.publicKey || dapp.seal?.publicKey || null,
    });
    invalidateInspect('pool');
    snap = await waitInspect(
      (s) => normQ(s?.pendingNext?.address || s?.pendingNext) === addr,
      waitTries,
      1500,
    );
  }
  if (normQ(snap?.pendingNext?.address || snap?.pendingNext) !== addr) {
    return {
      ok: false,
      address: addr,
      inspect: snap?.poolAddress || null,
      waiting: 'announce not visible on inspect yet',
      announceTx: announce?.txHash || null,
    };
  }
  // Bind with the sweep that created the live Q's account (see pickBindSweepTx);
  // a refund re-sweep's hash has no newAddresses and cannot prove the id.
  const sweepHash = lastRot?.bindTxHash || lastRot?.sweepTxHash || null;
  const chain = await wartAccount(addr).catch(() => null);
  const chainId = Number(chain?.accountId || 0);
  if (!sweepHash || !(chainId > 0)) {
    return {
      ok: false,
      address: addr,
      inspect: snap?.poolAddress || null,
      waiting:
        'will not post pool_set_address without a mined sweep to SPV-bind the account id',
      announceTx: announce?.txHash || null,
    };
  }
  const posted = await postProvenSetAddress({
    txHash: sweepHash,
    address: addr,
    destAccountId: chainId,
    sweepTxHash: sweepHash,
  });
  invalidateInspect('pool');
  const after = await waitInspect((s) => inspectPairOk(s, addr, chainId), 8, 2000);
  return {
    ok: inspectPairOk(after, addr, chainId),
    address: addr,
    inspect: after?.poolAddress || null,
    accountId: after?.poolAccountId || null,
    announceTx: announce?.txHash || null,
    setTx: posted?.txHash || null,
  };
}

/**
 * An Anvil wipe replays the machine without the rotation it had already
 * applied, leaving inspect on a pool address that is neither the live Q nor
 * the next Q. tickRotation only re-pins inspect while the phase is `idle`, and
 * mid-rotation that is a deadlock: maybeOpenOrAdvanceSweep will not leave
 * `sweeping` until inspect carries the next Q, and inspect is never re-pinned
 * until it leaves `sweeping`. Break it — but only in the unambiguous stale
 * case, since re-pinning a machine that legitimately holds a pendingNext would
 * clobber a rotation that is already in flight.
 */
async function resyncStaleInspect(next) {
  const snap = await inspectPoolSnap().catch(() => null);
  if (!snap) return { ok: false, skipped: 'inspect down' };
  const cur = normQ(snap.poolAddress);
  const pend = normQ(snap.pendingNext?.address || snap.pendingNext);
  const live = normQ(loadDapp()?.address);
  const nx = normQ(next?.address);
  if (!cur || !live) return { ok: false, skipped: 'no address to compare' };
  if (cur === live || (nx && cur === nx)) {
    return { ok: false, skipped: 'inspect already on a known Q' };
  }
  if (nx && pend === nx) return { ok: false, skipped: 'announce still pending' };
  const r = loadRotate();
  const since = r.inspectSyncAt
    ? Date.now() - Date.parse(r.inspectSyncAt)
    : Number.POSITIVE_INFINITY;
  if (Number.isFinite(since) && since < REANNOUNCE_MS) {
    return { ok: false, skipped: 'inspect-sync rate-limited' };
  }
  r.inspectSyncAt = new Date().toISOString();
  await saveRotate(r);
  return syncInspectToLiveCoordinator({ waitTries: 2 });
}

async function wartAccount(addr) {
  const a = String(addr || '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{48}$/.test(a)) return null;
  const res = await fetch(`${WART_NODE.replace(/\/$/, '')}/account/${a}/wart_balance`);
  if (!res.ok) return null;
  const j = await res.json();
  const data = j?.data || j;
  const wart = data?.wart || data;
  const total = BigInt(wart?.total?.E8 ?? 0);
  const locked = BigInt(wart?.locked?.E8 ?? 0);
  const mempool = BigInt(wart?.mempool?.E8 ?? 0);
  const spendable = total - locked - mempool;
  return {
    accountId: Number(data?.account?.accountId || data?.accountId || 0) || null,
    spendable,
    total,
  };
}

async function wartMinFee() {
  const res = await fetch(`${WART_NODE.replace(/\/$/, '')}/tools/minfee`).catch(() => null);
  if (res?.ok) {
    const j = await res.json();
    const e8 = j?.data?.minFee?.E8 ?? j?.minFee?.E8;
    if (e8 != null) return BigInt(e8);
  }
  const res2 = await fetch(`${WART_NODE.replace(/\/$/, '')}/transaction/minFee`).catch(() => null);
  if (res2?.ok) {
    const j = await res2.json();
    const e8 = j?.data?.minFee?.E8 ?? j?.minFee?.E8;
    if (e8 != null) return BigInt(e8);
  }
  return 10000n;
}

/**
 * Warthog's view of a broadcast tx: mined height + confirmations.
 * `null` means we could not tell (node unreachable, malformed hash). Callers
 * must treat that as unknown — never as confirmed.
 */
async function wartTxStatus(hash) {
  const h = String(hash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) return null;
  const res = await fetch(
    `${WART_NODE.replace(/\/$/, '')}/transaction/lookup/${h}`,
  ).catch(() => null);
  if (!res?.ok) return null;
  const j = await res.json().catch(() => null);
  if (!j) return null;
  // code 56 = not found: neither mempool nor chain.
  if (Number(j.code) !== 0) return { known: false, mined: false, confirmations: 0 };
  const d = j.data || {};
  const height = d?.mined?.block?.height ?? null;
  return {
    known: true,
    mined: height != null,
    height,
    confirmations: Number(d?.confirmations || 0),
  };
}

/**
 * Which sweep tx may SPV-bind the next Q's account id?
 *
 * bindPoolHexToAccountId requires the tx's block body to carry exactly one
 * `newAddresses` entry equal to the next Q — i.e. the sweep that CREATED the
 * account. A refund re-sweep (restartSweepIfRefunded) replaces r.sweepTxHash
 * with a later tx whose block has no newAddresses, and cutover then threw
 * "cutover: body has no newAddresses" on every tick for 40 h (2026-09-11 →
 * 09-13, 341 WART parked in the next Q). So the bind tx is chosen from every
 * sweep this rotation broadcast — current first, then the restarted ones,
 * newest first — by reading each block's newAddresses, and remembered in
 * r.bindTxHash so a later restart cannot move it. Falls back to r.sweepTxHash
 * (the old behaviour) when nothing qualifies, so the existing error surfaces.
 */
async function pickBindSweepTx(r, nextAddress) {
  if (r.bindTxHash) return r.bindTxHash;
  const { spvCore, getBlockFull } = await import('../../../../scripts/lib/wartSpvHost.mjs');
  const want20 = spvCore.address20FromWartHex(
    String(nextAddress || '')
      .replace(/^0x/i, '')
      .toLowerCase(),
  );
  if (!want20) return r.sweepTxHash;
  const candidates = [
    ...new Set(
      [r.sweepTxHash, ...(r.restartedSweeps || []).slice().reverse()]
        .filter(Boolean)
        .map((h) => String(h).replace(/^0x/i, '').toLowerCase()),
    ),
  ];
  for (const h of candidates) {
    const st = await wartTxStatus(h);
    if (!st?.mined || st.height == null) continue;
    let hashes = [];
    try {
      const block = await getBlockFull(st.height, WART_NODE);
      hashes = spvCore.decodeNewAddresses(block.bodyBytes, block.bodyStructure);
    } catch {
      continue;
    }
    if (hashes.length === 1 && hashes[0] === want20) {
      if (h !== String(r.sweepTxHash || '').toLowerCase()) {
        console.warn(
          `[pool3pRotate] cutover: binding with account-creating sweep ${h.slice(0, 12)}… ` +
            `(current sweep ${String(r.sweepTxHash || '').slice(0, 12)}… has no newAddresses)`,
        );
      }
      r.bindTxHash = h;
      await saveRotate(r);
      return h;
    }
  }
  return r.sweepTxHash;
}

/** Does the live Q still hold value? `total`, not `spendable` — money that is
 *  locked or still settling is money we would be walking away from. */
async function liveQFunded() {
  const live = loadDapp();
  if (!live?.address) return false;
  const acct = await wartAccount(live.address).catch(() => null);
  const fee = await wartMinFee().catch(() => 1n);
  return (acct?.total ?? 0n) > fee;
}

/**
 * May we retire the live Q and cut a new one?
 *
 * Only once the sweep that funded it is mined. While that tx sits in the
 * mempool the live Q's confirmed balance reads 0, which is indistinguishable
 * from a Q that was never funded — rotate on that reading and the money lands
 * in an address that has already been retired, with its signing shares about to
 * be overwritten.
 */
async function inboundSweepGate(r) {
  const inbound = r?.last?.sweepTxHash || null;
  if (!inbound) return { ok: true };
  const short = String(inbound).slice(0, 12);
  const st = await wartTxStatus(inbound);
  if (!st) {
    return {
      ok: false,
      reason: `rotate hold: cannot reach Warthog to confirm inbound sweep ${short}\u2026`,
    };
  }
  if (!st.known) {
    // Neither mined nor pending. Safe to move on only if the money is
    // demonstrably already sitting in the live Q.
    if (await liveQFunded()) return { ok: true };
    return {
      ok: false,
      reason: `rotate hold: inbound sweep ${short}\u2026 not found and live Q holds nothing`,
    };
  }
  if (!st.mined) {
    return { ok: false, reason: `rotate hold: inbound sweep ${short}\u2026 still unmined` };
  }
  if (st.confirmations < SWEEP_MIN_CONF) {
    return {
      ok: false,
      reason:
        `rotate hold: inbound sweep ${short}\u2026 has ` +
        `${st.confirmations}/${SWEEP_MIN_CONF} confirmations`,
    };
  }
  return { ok: true };
}

/**
 * May we retire the live Q after THIS rotation's outbound sweep?
 *
 * inboundSweepGate looks at last.sweepTxHash (the tx that funded the current
 * Q). This looks at the sweep we just broadcast toward next. A paid ticket
 * hash is only "in mempool"; cutting over on that is what retires a funded Q
 * during a Warthog halt.
 */
async function outboundSweepGate(hash) {
  if (!hash) return { ok: false, reason: 'sweep wait: no sweep tx hash' };
  const short = String(hash).slice(0, 12);
  const st = await wartTxStatus(hash);
  if (!st) {
    return {
      ok: false,
      reason: `sweep wait: cannot reach Warthog to confirm ${short}\u2026`,
    };
  }
  if (!st.known) {
    const funded = await liveQFunded();
    return {
      ok: false,
      reason: funded
        ? `sweep wait: ${short}\u2026 not found and live Q still funded`
        : `sweep wait: ${short}\u2026 not found and live Q holds nothing`,
    };
  }
  if (!st.mined) {
    return { ok: false, reason: `sweep wait: ${short}\u2026 still unmined` };
  }
  if (st.confirmations < SWEEP_MIN_CONF) {
    return {
      ok: false,
      reason:
        `sweep wait: ${short}\u2026 has ${st.confirmations}/${SWEEP_MIN_CONF} confirmations`,
    };
  }
  return { ok: true };
}

/**
 * Incoming packs, counted only as a warning once money has moved.
 *
 * The hard wait is earlier, in next_ready, before announce. Gating cutover
 * (2026-09-04) froze Path A after a paid sweep: the next Q already held the
 * WART and inspect was still on the empty live Q. Do not bring that back.
 */
function incomingNextPacksReady() {
  try {
    return nextPackSweepReady();
  } catch {
    return sweepPackMissing();
  }
}

function sweepPackMissing() {
  return {
    ok: false,
    missing: ['1', '2'],
    eligible: 0,
    reason:
      'sweep wait: next packs need 2 seat-eligible signers besides the dealers, have 0 — deposits and withdrawals stay on the live Q',
  };
}

/**
 * This warning is observe-only and fires on every tick of a held rotation. At
 * request-driven tick rates that was 17k identical lines an hour — it was the
 * ONLY thing in the journal, which hid every real event behind it. Log on
 * state change, then at most once per PACKS_WARN_MS.
 */
const PACKS_WARN_MS = Number(env('POOL_3P_PACKS_WARN_MS', '600000')) || 600000;
const SET_ADDRESS_RETRY_MS =
  Number(env('POOL_3P_SET_ADDRESS_RETRY_MS', '300000')) || 300000;
/** Mirrors the machine's WART_SPV_MAX_HEADERS (index.js default 512). */
const LC_WINDOW_HEADERS = Number(env('WART_SPV_MAX_HEADERS', '512')) || 512;
let lastPacksWarn = { key: '', at: 0 };
function noteMissingNextPacks(where) {
  const packs = incomingNextPacksReady();
  if (!packs.ok) {
    const key = `${where}|${packs.missing.join(',')}`;
    const now = Date.now();
    if (key !== lastPacksWarn.key || now - lastPacksWarn.at >= PACKS_WARN_MS) {
      lastPacksWarn = { key, at: now };
      console.warn(`[pool3pRotate] ${where}: ${packs.reason} (observe-only)`);
    }
  }
  return packs;
}

/** Anvil block for dueInEpochs without running the rotate state machine. */
export async function rotationClockView(extra = {}) {
  let block = null;
  try {
    block = await Promise.race([
      anvilBlockNumber(),
      new Promise((resolve) => setTimeout(() => resolve(null), 800)),
    ]);
  } catch {
    /* */
  }
  return rotationView(loadRotate(), block, extra);
}

export function rotationView(r = loadRotate(), block = null, extra = {}) {
  const next = loadNextDapp();
  const elapsed =
    r.anchorBlock != null && block != null ? Math.max(0, block - Number(r.anchorBlock)) : null;
  const dueIn = elapsed == null ? null : Math.max(0, Number(r.intervalEpochs || INTERVAL) - elapsed);
  const rooms = extra.userRooms ?? listOpenUserPool3pTickets();
  const deferredForRooms = rooms.length > 0;
  const need1 = !!(next && !next.seats?.[1]?.P);
  const need2 = !!(next && !next.seats?.[2]?.P);
  return {
    intervalEpochs: Number(r.intervalEpochs || INTERVAL),
    autoRotate: envOn('POOL_3P_AUTO_ROTATE', true),
    autoSweep: envOn('POOL_3P_AUTO_SWEEP', true),
    anchorBlock: r.anchorBlock,
    block,
    elapsedEpochs: elapsed,
    dueInEpochs: dueIn,
    due: dueIn === 0 && (r.phase || 'idle') === 'idle',
    clock:
      (r.phase || 'idle') === 'idle' ? (dueIn === 0 ? 'due' : 'running') : 'rotating',
    phase: r.phase || 'idle',
    paused: !!r.paused,
    machineReady: extra.machineReady ?? null,
    sweepTicketId: r.sweepTicketId || null,
    sweepTxHash: r.sweepTxHash || lastPaidRotate()?.txHash || null,
    bindTxHash: r.bindTxHash || null,
    announceTx: r.announceTx || null,
    setTx: r.setTx || null,
    lastError: r.lastError || extra.lastError || null,
    deferredForRooms,
    deferredForPacks: !!(
      extra.deferredForPacks ||
      ((r.phase || 'idle') === 'next_ready' &&
        String(r.lastError || extra.lastError || '').startsWith('sweep wait: next packs'))
    ),
    openUserRooms: rooms.map((t) => t.ticketId),
    next: next
      ? {
          address: next.address || null,
          publicKey: next.publicKey || null,
          Pdapp: next.Pdapp || null,
          seatsReady: { 1: !!next.seats?.[1]?.P, 2: !!next.seats?.[2]?.P },
          // Hide birth so live d1/d2 tabs do not swap in next-epoch hex mid-sign.
          needBirth: {
            1: !deferredForRooms && need1,
            2: !deferredForRooms && need2,
          },
          bornBy: {
            1: next.seats?.[1]?.signerId || null,
            2: next.seats?.[2]?.signerId || null,
          },
        }
      : null,
    last: r.last || null,
  };
}

function lastPaidRotate() {
  return (
    listPaidPool3pTickets(32).find((p) => /^wart-pool-rotate-/.test(String(p.ticketId || ''))) ||
    null
  );
}

function userRoomsOpen() {
  return listOpenUserPool3pTickets();
}

let tickLock = null;

/**
 * Why a sweep is not moving.
 *
 * A sweep needs both seats present for a whole signing round. A seat that keeps
 * idling out kills every round it is part of, and the rotate loop simply tries
 * again — so the state stays 'sweeping' with lastError null, which reads as
 * healthy. Name the cause instead.
 */
/** No progress for this long on an open sweep room is reported as a stall. */
const SWEEP_STALL_MS = Number(env('POOL_3P_SWEEP_STALL_MS', '300000')) || 300000;

/**
 * Milliseconds the open sweep room has sat at the same point in the round.
 *
 * Keyed on the shares actually collected, not on wall time: a round that keeps
 * being reset (seat flap, prep-hash change) never advances past `wait_d2` and
 * must read as stalled even though the ticket's own updatedAt keeps moving.
 */
function noteSweepProgress(r, t) {
  const sig = [
    t?.ticketId || '',
    t?.haveR1 ? 1 : 0,
    t?.haveD2 ? 1 : 0,
    t?.hasPartial ? 1 : 0,
  ].join('|');
  const now = Date.now();
  if (r.sweepProgressSig !== sig) {
    r.sweepProgressSig = sig;
    r.sweepProgressAt = now;
    return 0;
  }
  return Math.max(0, now - Number(r.sweepProgressAt || now));
}

function sweepStallReason() {
  try {
    const h = loadHolders();
    const missing = ['1', '2'].filter((r) => !h.roles?.[r]?.signerId);
    if (missing.length) {
      return `sweep wait: d${missing.join(' and d')} seat vacant — no holder to sign`;
    }
    const unsteady = ['1', '2'].filter((r) => h.roles?.[r]?.unsteady);
    if (unsteady.length) {
      const worst = Math.max(
        ...unsteady.map((r) => Number(h.roles[r].worstGapMs || 0)),
      );
      return (
        `sweep wait: d${unsteady.join(' and d')} seat unsteady ` +
        `(beats up to ${Math.round(worst / 1000)}s apart; a hidden browser tab is ` +
        `throttled to ~60s and cannot hold a seat)`
      );
    }
  } catch {
    /* reporting must never break the tick */
  }
  return null;
}

/**
 * tickRotation has no timer of its own — it runs from the /api/pool handlers,
 * so six polling browser holders drove ~6.4 full ticks a second, each one
 * rewriting pool-3p-rotate.json. That write storm is what kept the .data
 * files in a half-written state often enough for readers to see them torn.
 * A floor of TICK_MIN_MS still leaves ~30 ticks/minute, far more than the
 * 60s unstick timer the state machine was designed around.
 */
const TICK_MIN_MS = Number(env('POOL_3P_TICK_MIN_MS', '2000')) || 2000;
let lastTickAt = 0;

export async function tickRotation() {
  if (!tickLock && Date.now() - lastTickAt < TICK_MIN_MS) {
    let block = null;
    try {
      block = await anvilBlockNumber();
    } catch {
      /* */
    }
    return rotationView(loadRotate(), block);
  }
  if (tickLock) {
    // Do not wait for a long inner tick (inspect-sync waitInspect used to
    // block every pool3p_status for ~72s). Status must stay snappy.
    let block = null;
    try {
      block = await anvilBlockNumber();
    } catch {
      /* */
    }
    return rotationView(loadRotate(), block);
  }
  lastTickAt = Date.now();
  tickLock = tickRotationInner();
  try {
    return await tickLock;
  } finally {
    tickLock = null;
  }
}

async function tickRotationInner() {
  const r = loadRotate();
  let block = null;
  try {
    block = await anvilBlockNumber();
  } catch {
    return rotationView(r, null);
  }
  /**
   * Operator pause in the rotate file (same as ETH): freeze the state machine
   * including an in-flight sweep so signer tabs can reload without the room
   * immediately reopening. A systemd restart would drop seat leases.
   */
  if (r.paused) {
    return rotationView(r, block);
  }
  if (r.anchorBlock == null || block < Number(r.anchorBlock)) {
    r.anchorBlock = block;
    await saveRotate(r);
    if (r.phase === 'idle') {
      return rotationView(r, block, {
        machineReady: await machineSupportsSetAddress(),
      });
    }
  }

  const auto = envOn('POOL_3P_AUTO_ROTATE', true);
  const elapsed = Math.max(0, block - Number(r.anchorBlock));
  // Stranded previous Q: coordinator live is next without a machine bind.
  // Do not start need_birth (that invents another Q) until an operator lifts
  // last.unboundInMachine.
  const holdNewRotation = !!(r.last?.unboundInMachine && r.last?.strandedPrevious);
  // Everything below reads inspect and posts inputs against what it sees. A
  // replaying machine reports a Q retired hours ago: inspect-sync would
  // re-announce/re-set addresses and cutover would refuse or misjudge. Hold.
  if (isReplaying()) {
    const m = machineView();
    r.lastError = `rotate wait: machine replaying ${m.processed}/${m.total} inputs` +
      (m.etaMinutes != null ? ` (eta ${m.etaMinutes} min)` : '');
    await saveRotate(r);
    return rotationView(r, block, { machineReady: null });
  }
  await expireStaleUserRooms().catch(() => ({ closed: [] }));
  if (r.phase === 'idle') {
    await syncInspectToLiveCoordinator().catch((e) => {
      r.lastError = `inspect-sync: ${e.message || e}`;
      return null;
    });
  }
  const rooms = userRoomsOpen();
  if (
    auto &&
    !holdNewRotation &&
    elapsed >= Number(r.intervalEpochs || INTERVAL) &&
    r.phase === 'idle'
  ) {
    const gate = await inboundSweepGate(r).catch((e) => ({
      ok: false,
      reason: `rotate hold: sweep confirmation check failed \u2014 ${e.message || e}`,
    }));
    if (rooms.length) {
      r.lastError = `rotate wait: ${rooms.length} user 3P room(s) open`;
      await saveRotate(r);
    } else if (!gate.ok) {
      // anchorBlock is deliberately left alone: the rotation stays due and
      // fires on the first tick after the sweep confirms.
      r.lastError = gate.reason;
      await saveRotate(r);
    } else {
      const { dapp } = await createDappOnlyPool();
      await writeNextDapp(dapp);
      r.phase = 'need_birth';
      r.nextStartedAt = new Date().toISOString();
      r.lastError = null;
      r.sweepTicketId = null;
      r.sweepTxHash = null;
      // Both belong to the Q we just retired; a stale bindTxHash would bind
      // the new next Q with the wrong block.
      r.bindTxHash = null;
      r.restartedSweeps = [];
      r.announceTx = null;
      r.setTx = null;
      await saveRotate(r);
    }
  }

  const live = loadDapp();
  if (
    ['need_birth', 'next_ready', 'announced', 'sweeping', 'cutover'].includes(r.phase) &&
    !loadNextDapp() &&
    r.last?.address &&
    live?.address &&
    String(live.address).toLowerCase() === String(r.last.address).toLowerCase()
  ) {
    r.phase = 'idle';
    r.sweepTicketId = null;
    r.lastError = null;
    await saveRotate(r);
  }

  const next = loadNextDapp();
  if (r.phase === 'need_birth' && next?.address && next.seats?.[1]?.P && next.seats?.[2]?.P) {
    r.phase = 'next_ready';
    await saveRotate(r);
  }

  if (r.phase === 'announced' || r.phase === 'sweeping') {
    await resyncStaleInspect(next).catch((e) => {
      r.lastError = `inspect-sync: ${e.message || e}`;
      return null;
    });
  }

  const machineReady = await machineSupportsSetAddress();
  if (!auto) return rotationView(loadRotate(), block, { machineReady });

  // Through 'announced' too: the sweep has not run yet, so a room that slipped
  // in on the idle→need_birth edge can still be allowed to finish first.
  if (rooms.length && ['need_birth', 'next_ready', 'announced'].includes(r.phase)) {
    r.lastError = `rotate wait: user 3P room still open`;
    await saveRotate(r);
    return rotationView(loadRotate(), block, { machineReady, userRooms: rooms });
  }

  const interval = Number(r.intervalEpochs || INTERVAL);
  if (r.phase === 'next_ready' && elapsed < interval) {
    if (r.lastError && String(r.lastError).startsWith('rotate wait: machine')) {
      r.lastError = null;
      await saveRotate(r);
    }
  }
  if (r.phase === 'next_ready' && elapsed >= interval && !machineReady && next?.address) {
    r.lastError = 'rotate wait: machine inspect / pool_set_address not ready';
    await saveRotate(r);
  }
  if (r.phase === 'next_ready' && machineReady && next?.address && elapsed >= interval) {
    /**
     * Stay here until both incoming seats have a sealed pack held by two
     * signers who could claim them. next_ready is not a committed phase, so
     * new withdrawals still open and deposits still credit the live Q.
     * Announce is what starts refusing new rooms. An open sweep or cutover
     * never comes back through this branch.
     */
    if (envOn('POOL_3P_REQUIRE_NEXT_PACKS', true)) {
      const packs = incomingNextPacksReady();
      if (!packs.ok) {
        if (r.lastError !== packs.reason) {
          r.lastError = packs.reason;
          await saveRotate(r);
        }
        return rotationView(loadRotate(), block, {
          machineReady,
          deferredForPacks: true,
        });
      }
    }
    try {
      const posted = await submitPoolAdvance({
        type: 'pool_announce_next',
        address: next.address,
        publicKey: next.publicKey,
      });
      r.phase = 'announced';
      r.announceTx = posted.txHash;
      r.lastError = null;
      await saveRotate(r);
    } catch (e) {
      r.lastError = `announce: ${e.message || e}`;
      await saveRotate(r);
    }
  }

  if ((r.phase === 'announced' || r.phase === 'sweeping') && next?.address) {
    await maybeOpenOrAdvanceSweep(r, next);
  }

  if (r.phase === 'cutover' && machineReady && next?.address) {
    if (!(await restartSweepIfRefunded(r))) {
      await cutOver(r, next);
    }
  }

  return rotationView(loadRotate(), block, { machineReady });
}

function openRotateRooms() {
  return listOpenPool3pTickets().filter((t) => /^wart-pool-rotate-/.test(String(t.ticketId || '')));
}

/**
 * Authorized burns on the live Q that the coordinator has NOT paid — leave
 * that e8 behind so a sweep cannot drain redeem funds.
 *
 * "Unpaid" is the coordinator's paid ledger, not the machine's ticket status:
 * the rollup never learns a payout happened, so every ticket stays
 * `authorized` there forever. Reserving for those left 28 WART behind on
 * 2026-09-08 (tickets 0:4-0:6, all paid hours earlier), which then read as a
 * "refunded" live Q and the sweep waited on its own reservation.
 */
function reservedUnpaidLiveE8(snap, liveAddr) {
  const live = normQ(liveAddr);
  let n = 0n;
  for (const t of snap?.recentTickets || []) {
    if (String(t?.status || '') !== 'authorized') continue;
    if (normQ(t.poolAddress) !== live) continue;
    if (paidRecordFor(t.ticketId, { amountE8: t.amountE8, toAddress: t.toAddress })) continue;
    try {
      n += BigInt(t.amountE8 || 0);
    } catch {
      /* */
    }
  }
  return n;
}

/**
 * Reachable from `cutover` as well as `sweeping`: a deposit that lands after
 * the sweep but before cutover used to leave cutOver() throwing "refunded
 * after sweep" on every tick with nothing to walk the phase back — rotation
 * wedged for 9h on 2026-09-08 behind a 150 WART test deposit. See the
 * comment above the caller in maybeOpenOrAdvanceSweep for why a confirmed
 * sweep next to a funded live Q must reopen the sweep, not retire the Q.
 */
async function restartSweepIfRefunded(r) {
  if (!r.sweepTxHash) return false;
  const st = await wartTxStatus(r.sweepTxHash).catch(() => null);
  const settled = !!st?.mined && Number(st.confirmations || 0) >= SWEEP_MIN_CONF;
  if (!settled || !(await liveQFunded())) return false;
  const stale = String(r.sweepTxHash).slice(0, 12);
  // Remember it, or the paid-ticket fallback below re-adopts this very sweep
  // (same next Q) on the next tick and the phase ping-pongs cutover/sweeping.
  r.restartedSweeps = [...(r.restartedSweeps || []), String(r.sweepTxHash)].slice(-8);
  r.sweepTxHash = null;
  r.sweepTicketId = null;
  r.phase = 'sweeping';
  r.lastError = `sweep restart: live Q refunded after ${stale}\u2026 confirmed`;
  await saveRotate(r);
  console.warn(`[pool3pRotate] ${r.lastError}`);
  return true;
}

async function maybeOpenOrAdvanceSweep(r, next) {
  const snap = await inspectPoolSnap().catch(() => null);
  if (!snap) {
    r.lastError = 'sweep wait: inspect down';
    await saveRotate(r);
    return;
  }
  /**
   * A confirmed sweep only retires the Q if the Q is actually empty. A deposit
   * that credits after the sweep was signed leaves a mined sweepTxHash sitting
   * next to a funded live Q, and every gate downstream — cutOver included —
   * reads that hash as "the money moved". Reopen the sweep instead of retiring
   * a balance behind it. liveQFunded() is dust-aware: a drained Q holds less
   * than one min fee.
   */
  if (await restartSweepIfRefunded(r)) return;
  const nextIsLive = normQ(snap.poolAddress) === normQ(next.address);
  if (nextIsLive) {
    // Inspect already moved, so this is normally cutover. But if the outgoing Q
    // is still funded with no sweep to show for it, cutOver() will refuse — and
    // returning here would deadlock the two against each other. Sweep first.
    const stranding = !r.sweepTxHash && (await liveQFunded());
    if (stranding) {
      r.lastError = 'sweep wait: inspect already on next Q but live Q still funded';
      await saveRotate(r);
    } else if (r.sweepTxHash) {
      const gate = await outboundSweepGate(r.sweepTxHash);
      if (!gate.ok) {
        r.lastError = gate.reason;
        await saveRotate(r);
        return;
      }
      noteMissingNextPacks('inspect already on next Q');
      r.phase = 'cutover';
      r.lastError = null;
      await saveRotate(r);
      return;
    } else {
      noteMissingNextPacks('inspect already on next Q, no sweep hash');
      r.phase = 'cutover';
      r.lastError = null;
      await saveRotate(r);
      return;
    }
  }
  if (
    !nextIsLive &&
    normQ(snap.pendingNext?.address || snap.pendingNext) !== normQ(next.address)
  ) {
    /**
     * The announce is not durable either: an Anvil wipe replays the machine
     * without it, and the phase can never walk back to `next_ready` to post it
     * again. Re-announce when inspect is sitting on the live Q with nothing
     * pending — that shape is a lost announce, not one superseded by a newer
     * rotation. Rate-limited so a machine that rejects the input cannot become
     * a retry storm.
     */
    const onLive = normQ(snap.poolAddress) === normQ(loadDapp()?.address);
    const pend = normQ(snap.pendingNext?.address || snap.pendingNext);
    const since = r.reannounceAt
      ? Date.now() - Date.parse(r.reannounceAt)
      : Number.POSITIVE_INFINITY;
    if (onLive && !pend && since > REANNOUNCE_MS) {
      r.reannounceAt = new Date().toISOString();
      await saveRotate(r);
      try {
        const posted = await submitPoolAdvance({
          type: 'pool_announce_next',
          address: next.address,
          publicKey: next.publicKey,
        });
        r.announceTx = posted.txHash;
        r.lastError = 'sweep wait: re-announced next Q after a lost announce';
      } catch (e) {
        r.lastError = `sweep wait: re-announce failed \u2014 ${e.message || e}`;
      }
      await saveRotate(r);
      return;
    }
    r.lastError = 'sweep wait: inspect pendingNext is not next Q';
    await saveRotate(r);
    return;
  }

  const restarted = new Set((r.restartedSweeps || []).map(String));
  const paid = listPaidPool3pTickets(48).find(
    (p) =>
      !restarted.has(String(p.txHash || '')) &&
      (p.ticketId === r.sweepTicketId ||
        (/^wart-pool-rotate-/.test(String(p.ticketId || '')) &&
          String(p.toAddress || '').toLowerCase() === String(next.address).toLowerCase())),
  );
  if (paid?.txHash) {
    r.sweepTxHash = paid.txHash;
    const gate = await outboundSweepGate(paid.txHash);
    if (!gate.ok) {
      r.phase = 'sweeping';
      r.lastError = gate.reason;
      await saveRotate(r);
      return;
    }
    noteMissingNextPacks('paid sweep confirmed');
    r.phase = 'cutover';
    r.lastError = null;
    await saveRotate(r);
    return;
  }

  if (!envOn('POOL_3P_AUTO_SWEEP', true)) {
    r.phase = 'cutover';
    await saveRotate(r);
    return;
  }

  if (userRoomsOpen().length) {
    // Leave the sweep ticket id so we resume after the redeem, but drop the
    // open rotate room — d1 aborts contributeOpen on the first prepare error,
    // so a live sweep starves user tickets (wart-pool-0:2 sat unsigned).
    for (const t of openRotateRooms()) {
      await closePool3pRoom(t.ticketId, 'defer-user-room').catch(() => null);
    }
    r.lastError = 'sweep wait: user 3P room still open';
    await saveRotate(r);
    return;
  }

  /**
   * Observe-only once we are about to open. The hard wait already ran in
   * next_ready. This log is the leftover for a sweep that is opening anyway
   * (POOL_3P_REQUIRE_NEXT_PACKS=0) or that reached here with packs still thin.
   */
  noteMissingNextPacks('opening sweep');

  const existing = openRotateRooms();
  if (existing.length) {
    const keep =
      (r.sweepTicketId && existing.some((t) => t.ticketId === r.sweepTicketId)
        ? r.sweepTicketId
        : existing[0].ticketId);
    if (existing.length > 1) {
      for (const t of existing) {
        if (String(t.ticketId) === String(keep)) continue;
        await closePool3pRoom(t.ticketId, 'rotate-collapse').catch(() => null);
      }
    }
    r.sweepTicketId = keep;
    r.phase = 'sweeping';
    const room = existing.find((t) => String(t.ticketId) === String(keep)) || existing[0];
    const stalledMs = noteSweepProgress(r, room);
    /**
     * Finish-ready but unbroadcast (lost k1 / stale pin / dead R1 poster):
     * drop R1 so the live d1 holder can post a fresh nonce. Do not touch
     * wait_d2. Cooldown lives in maybeResetStuckFinish.
     */
    if (room?.haveR1 && room?.hasPartial) {
      const retry = await maybeResetStuckFinish(keep, {
        stalledMs,
        stallMs: SWEEP_STALL_MS,
      }).catch(() => null);
      if (retry?.ok) {
        r.lastError = `sweep retry: reset R1 (${retry.why})`;
        await saveRotate(r);
        return;
      }
    }
    /**
     * Do NOT blanket-clear lastError here.
     *
     * This branch ran on every tick while a sweep room was open and wrote
     * `lastError = null` each time, so /api/pool reported a perfectly healthy
     * rotation while the room sat in wait_d2 for hours. Worse, it returned
     * before the sweepStallReason() block below, so the one reporter written
     * for exactly this case could never run while a room was open — it was
     * reachable only when there was no room to describe.
     */
    r.lastError =
      sweepStallReason() ||
      (stalledMs >= SWEEP_STALL_MS
        ? `sweep wait: room ${keep} stuck on ${room?.waitingOn?.join('+') || 'a share'} ` +
          `— no progress for ${Math.round(stalledMs / 60000)}m`
        : null);
    await saveRotate(r);
    return;
  }

  {
    // Report a stalled sweep even when nothing threw: the round is restarting
    // silently because a seat keeps vanishing.
    const stall = sweepStallReason();
    if (stall) {
      r.lastError = stall;
      await saveRotate(r);
    }
  }
  if (r.sweepTicketId) {
    // Closed (defer-user-room / expire) and never paid. Hanging here froze
    // rotation after wart-pool-rotate-1788751116780. Drop the id and mint a
    // new room below — the old nonce was never broadcast.
    const dropped = r.sweepTicketId;
    r.sweepTicketId = null;
    r.lastError = `sweep resume: dropped ${dropped} (not open, not paid)`;
    await saveRotate(r);
  }

  const live = loadDapp();
  if (!live?.address) {
    r.lastError = 'sweep: live dapp missing address';
    await saveRotate(r);
    return;
  }
  try {
    const acct = await wartAccount(live.address);
    const fee = await wartMinFee();
    const spendable = acct?.spendable ?? 0n;
    const reserved = reservedUnpaidLiveE8(snap, live.address);
    if (spendable <= fee + reserved) {
      if (reserved > 0n && spendable > fee) {
        r.lastError = `sweep wait: ${reserved} e8 reserved for unpaid live-Q tickets`;
        await saveRotate(r);
        return;
      }
      /**
       * "Nothing to sweep" and "the money has not been mined yet" read
       * identically here: spendable is total - locked - mempool, i.e. confirmed
       * funds only. Skip the sweep on the second one and the balance settles
       * into a Q we have already walked away from. Separate them.
       */
      const total = acct?.total ?? 0n;
      if (total > fee) {
        r.lastError = 'sweep wait: live Q balance is locked or unconfirmed';
        await saveRotate(r);
        return;
      }
      const gate = await inboundSweepGate(r).catch((e) => ({
        ok: false,
        reason: `sweep wait: sweep confirmation check failed — ${e.message || e}`,
      }));
      if (!gate.ok) {
        r.lastError = String(gate.reason).replace(/^rotate hold:/, 'sweep wait:');
        await saveRotate(r);
        return;
      }
      noteMissingNextPacks('skip-sweep, live Q is dust');
      r.phase = 'cutover';
      r.lastError = null;
      await saveRotate(r);
      return;
    }
    /**
     * Backstop for a rotation that is already announced or sweeping with no
     * ticket yet. Drop back to next_ready so POOL_ROTATING does not refuse
     * withdrawals while the packs are still missing. A paid or open sweep
     * returns before this point; cutover does not call this function.
     */
    if (envOn('POOL_3P_REQUIRE_NEXT_PACKS', true)) {
      const packs = incomingNextPacksReady();
      if (!packs.ok) {
        r.phase = 'next_ready';
        r.lastError = packs.reason;
        await saveRotate(r);
        return;
      }
    }
    const amountE8 = spendable - fee - reserved;
    const ticketId = `wart-pool-rotate-${Date.now()}`;
    await openPool3pPayout({
      ticketId,
      toAddress: next.address,
      amountE8: amountE8.toString(),
    });
    r.phase = 'sweeping';
    r.sweepTicketId = ticketId;
    r.lastError = null;
    await saveRotate(r);
  } catch (e) {
    r.lastError = `sweep: ${e.message || e}`;
    await saveRotate(r);
  }
}

function normQ(a) {
  return String(a || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

async function waitInspect(pred, tries = 6, ms = 1500) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    invalidateInspect('pool');
    last = await inspectPoolSnap().catch(() => null);
    if (last && pred(last)) return last;
    await new Promise((res) => setTimeout(res, ms));
  }
  return last;
}

async function cutOver(r, next) {
  try {
    /**
     * Refuse to retire a Q that still holds value with no sweep accounting for
     * it. This is the backstop for every path into cutover, not just the
     * missing-accountId one below.
     */
    if (r.sweepTxHash) {
      const gate = await outboundSweepGate(r.sweepTxHash);
      if (!gate.ok) {
        throw new Error(
          String(gate.reason).replace(/^sweep wait:/, 'cutover blocked —'),
        );
      }
      // Confirmed is not the same as drained: money that arrived after the
      // sweep was signed is still sitting in the Q we are about to retire.
      if (await liveQFunded()) {
        throw new Error(
          `cutover blocked \u2014 live Q refunded after sweep ` +
            `${String(r.sweepTxHash).slice(0, 12)}\u2026`,
        );
      }
    } else {
      const liveAddr = loadDapp()?.address || null;
      const liveAcct = liveAddr
        ? await wartAccount(liveAddr).catch(() => null)
        : null;
      const feeNow = await wartMinFee().catch(() => 1n);
      if ((liveAcct?.total ?? 0n) > feeNow) {
        throw new Error(
          `cutover blocked \u2014 live Q ${String(liveAddr).slice(0, 12)}\u2026 ` +
            `still holds ${liveAcct.total} E8 and no sweep tx`,
        );
      }
    }
    noteMissingNextPacks('cutover');
    /**
     * After activateNextUnbound() the machine still credits deposits to the
     * PREVIOUS Q (its poolAccountId never moved). Anything that landed there
     * since activation would be orphaned the moment this cutover moves the
     * machine to the new Q, so refuse until it is swept out.
     */
    if (r.last?.unboundInMachine && r.last?.machineLive?.address) {
      const ml = r.last.machineLive;
      const acct = await wartAccount(ml.address).catch(() => null);
      const feeNow = await wartMinFee().catch(() => 10000n);
      const held = acct?.total ?? 0n;
      const alreadyStranded = BigInt(String(r.last.strandedBalanceE8 || '0'));
      // Option 2: inspect moves to the Q that just received this rotation's
      // sweep. Pre-existing stranded coins (snapshot at unbound activation)
      // stay on the machine-live Q. Only NEW deposits since that snapshot
      // must be swept first.
      if (held > feeNow && held > alreadyStranded) {
        throw new Error(
          `blocked — machine-live Q ${String(ml.address).slice(0, 12)}… (acct ${ml.accountId}) ` +
            `holds ${held} E8 (${held - alreadyStranded} E8 above strand snapshot); sweep it before the ` +
            `machine is moved to the new Q`,
        );
      }
      if (held > feeNow) {
        console.warn(
          `[pool3pRotate] cutover: leaving ${held} E8 stranded on machine-live ` +
            `${String(ml.address).slice(0, 12)}… (snapshot ${alreadyStranded}); ` +
            `inspect will follow the swept next Q`,
        );
      }
    }
    let accountId = null;
    for (let i = 0; i < 20 && !accountId; i += 1) {
      const found = await wartAccount(next.address);
      if (found?.accountId) accountId = found.accountId;
      else await new Promise((res) => setTimeout(res, 1000));
    }
    if (!accountId) {
      throw new Error(
        `cutover blocked — Warthog has no accountId for ${String(next.address).slice(0, 12)}… yet`,
      );
    }
    if (!r.sweepTxHash) {
      throw new Error(
        'cutover blocked — no sweep tx to SPV-bind inspect poolAddress+poolAccountId',
      );
    }
    const bindTx = await pickBindSweepTx(r, next.address);
    const want = normQ(next.address);
    const snap = await inspectPoolSnap().catch(() => null);
    /**
     * The machine's light client keeps only WART_SPV_MAX_HEADERS (512, ~2 h)
     * recent headers plus its checkpoint, gap-fills only from a stored parent
     * and trims back to 512 after every apply — so a bind whose block is
     * further below the LC tip than that can NEVER verify in-machine, whatever
     * header window we attach (2026-09-13: input #2677 rejected with "cannot
     * apply header h=354050 (tip=355428)"). Posting it again every 5 min just
     * fills the InputBox with rejected inputs; say so instead. Recovery is a
     * fresh sweep out of the next Q (see memory), not a retry.
     */
    const lcTip = Number(snap?.spv?.bestHeight || 0);
    if (lcTip > 0) {
      const bindSt = await wartTxStatus(bindTx).catch(() => null);
      const bindH = Number(bindSt?.height || 0);
      if (bindH > 0 && lcTip - bindH > LC_WINDOW_HEADERS - 16) {
        throw new Error(
          `blocked — bind block h=${bindH} (sweep ${String(bindTx).slice(0, 12)}…) is ` +
            `${lcTip - bindH} headers below the machine light-client tip ${lcTip}; the LC keeps ` +
            `${LC_WINDOW_HEADERS}, so this next Q can never be SPV-bound. Operator action required: ` +
            `sweep it into a Q the machine can bind.`,
        );
      }
    }
    const pending = normQ(snap?.pendingNext?.address || snap?.pendingNext);
    const live = normQ(snap?.poolAddress);
    if (live !== want && pending !== want) {
      const announced = await submitPoolAdvance({
        type: 'pool_announce_next',
        address: next.address,
        publicKey: next.publicKey || null,
      });
      r.announceTx = announced.txHash;
      await saveRotate(r);
      const ready = await waitInspect(
        (s) => normQ(s?.pendingNext?.address || s?.pendingNext) === want,
      );
      if (normQ(ready?.pendingNext?.address || ready?.pendingNext) !== want) {
        throw new Error('cutover: inspect pendingNext never matched next Q');
      }
    }
    if (!inspectPairOk(snap, want, accountId)) {
      // A pool_set_address already in the InputBox is not stale until the node
      // has had a fair chance to run it. Every tick used to re-post while
      // inspect lagged; with the v2 node stuck (2026-09-13) that is one
      // duplicate input per tick for hours. Retry at most every
      // POOL_3P_SET_ADDRESS_RETRY_MS (default 5 min).
      const sinceSet = r.setTxAt ? Date.now() - Date.parse(r.setTxAt) : Infinity;
      if (r.setTx && r.setTx !== 'already-live' && sinceSet < SET_ADDRESS_RETRY_MS) {
        throw new Error(
          `waiting for inspect to reflect pool_set_address ${String(r.setTx).slice(0, 12)}… ` +
            `(posted ${Math.round(sinceSet / 1000)}s ago)`,
        );
      }
      if (live !== want) {
        const posted = await postProvenSetAddress({
          txHash: bindTx,
          address: next.address,
          destAccountId: accountId,
          sweepTxHash: r.sweepTxHash,
        });
        r.setTx = posted.txHash;
        r.setTxAt = new Date().toISOString();
        await saveRotate(r);
      } else {
        const posted = await postProvenPoolAccountId({
          txHash: bindTx,
          poolAddress: next.address,
          destAccountId: accountId,
        });
        r.setTx = r.setTx || posted.txHash;
        await saveRotate(r);
      }
      const after = await waitInspect(
        (s) => inspectPairOk(s, want, accountId),
        8,
        2000,
      );
      if (!inspectPairOk(after, want, accountId)) {
        throw new Error(
          `cutover: inspect pair incomplete (address=${String(after?.poolAddress || '').slice(0, 12)} id=${after?.poolAccountId ?? 'null'}, want ${want.slice(0, 12)}/${accountId})`,
        );
      }
    } else {
      r.setTx = r.setTx || 'already-live';
      await saveRotate(r);
    }
    const act = await activateNextDapp({
      sweepTxHash: r.sweepTxHash,
      accountId,
      setTx: r.setTx,
    });
    r.lastError = null;
    return act;
  } catch (e) {
    r.lastError = `cutover: ${e.message || e}`;
    await saveRotate(r);
    return null;
  }
}

export async function birthNextSeat({
  signerId,
  role,
  P,
  encD1,
  paillierN,
  paillierG,
  pok,
  rangeProof,
  network,
}) {
  const r = Number(role);
  if (r !== 1 && r !== 2) throw new Error('role must be 1 or 2');
  const sid = String(signerId || '').trim();
  if (!sid) throw new Error('signerId required');
  if (sid === ORBIT_VPS_ID || /^pool-3p-signer-[12]$/.test(sid)) {
    throw new Error('VPS must not birth next Q');
  }
  const holding =
    loadHolders().roles?.['1']?.signerId === sid ||
    loadHolders().roles?.['2']?.signerId === sid;
  const why = nextBirthDeniedReason(sid, { network, holding });
  if (why) {
    throw new Error(`next-Q birth denied — ${why}`);
  }
  if (holdersFrozen()) {
    return {
      ok: false,
      deferred: true,
      error: 'next-Q birth deferred — user 3P room is open',
      openUserRooms: listOpenUserPool3pTickets().map((t) => t.ticketId),
    };
  }
  let dapp = loadNextDapp();
  if (!dapp) {
    const made = await createDappOnlyPool();
    dapp = made.dapp;
  }
  const compressed = String(P || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{66}$/.test(compressed)) throw new Error('P must be 33-byte compressed hex');
  requireSeatPok({ pok, P: compressed, role: r, kind: 'birth-next' });
  dapp.seats = dapp.seats || { 1: null, 2: null };
  if (dapp.seats[r]?.P && dapp.seats[r]?.signerId && dapp.seats[r].signerId !== sid) {
    throw new Error(`next d${r} already born by ${dapp.seats[r].signerId}`);
  }
  const other = r === 1 ? 2 : 1;
  const otherSid = dapp.seats[other]?.signerId || null;
  if (otherSid && otherSid === sid) {
    throw new Error(
      `next-Q birth denied — this tab already birthed d${other}; another live tab must birth d${r}`,
    );
  }
  if (r === 1) {
    if (!encD1 || !paillierN || !paillierG) {
      throw new Error('d1 next-birth needs Enc(d1) + paillier keys');
    }
    assertPaillierModulus(paillierN, { what: 'next-Q d1 Paillier N' });
    verifyRangeLindell({
      c: encD1,
      paillierN,
      paillierG,
      Q1: compressed,
      proof: rangeProof,
      context: seatPokContext('birth-next', 1, compressed),
    });
    const ch = pdlVerifierChallenge({
      ckey: encD1,
      paillierN,
      paillierG,
      Q1: compressed,
    });
    stashSeatPdl({
      kind: 'birth-next',
      signerId: sid,
      ch,
      P: compressed,
      encD1,
      paillierN,
      paillierG,
    });
    await writeNextDapp(dapp);
    return {
      ok: true,
      next: true,
      role: 1,
      needPdl: true,
      pdl: pdlChallengePublic(ch),
      clientBorn: true,
      dealerSawPlaintext: false,
    };
  }
  dapp.seats[2] = {
    P: compressed,
    bornAt: new Date().toISOString(),
    signerId: sid,
    pokOk: true,
  };
  finalizeClientBornQ(dapp);
  await writeNextDapp(dapp);
  const rot = loadRotate();
  if (dapp.address && dapp.seats[1]?.P && dapp.seats[2]?.P) rot.phase = 'next_ready';
  else rot.phase = 'need_birth';
  await saveRotate(rot);
  return {
    ok: true,
    next: true,
    role: r,
    address: dapp.address || null,
    publicKey: dapp.publicKey || null,
    Pdapp: dapp.Pdapp,
    ready: !!(dapp.seats[1]?.P && dapp.seats[2]?.P),
    seal: dapp.seal || null,
    clientBorn: true,
    dealerSawPlaintext: false,
  };
}

/** Persist next-Q d1 after Protocol 6.1 accepts. Called from finishClientSeatPdl. */
export async function sealNextSeatPdl({ signerId, row }) {
  let dapp = loadNextDapp();
  if (!dapp) {
    const made = await createDappOnlyPool();
    dapp = made.dapp;
  }
  dapp.seats = dapp.seats || { 1: null, 2: null };
  const sid = String(signerId || row?.signerId || '').trim();
  if (dapp.seats[1]?.P && dapp.seats[1]?.signerId && dapp.seats[1].signerId !== sid) {
    throw new Error(`next d1 already born by ${dapp.seats[1].signerId}`);
  }
  dapp.seats[1] = {
    ...(dapp.seats[1] || {}),
    P: row.P,
    encD1: row.encD1,
    paillierN: row.paillierN,
    paillierG: row.paillierG,
    bornAt: dapp.seats[1]?.bornAt || new Date().toISOString(),
    signerId: row.signerId || sid,
    pokOk: true,
    rangeOk: true,
    pdlOk: true,
  };
  dapp.ckeyD1 = row.encD1;
  dapp.paillierN = row.paillierN;
  dapp.paillierG = row.paillierG;
  dapp.pdlOk = true;
  dapp.rangeOk = true;
  finalizeClientBornQ(dapp);
  await writeNextDapp(dapp);
  const rot = loadRotate();
  if (dapp.address && dapp.seats[1]?.P && dapp.seats[2]?.P) rot.phase = 'next_ready';
  else rot.phase = 'need_birth';
  await saveRotate(rot);
  return {
    ok: true,
    next: true,
    role: 1,
    address: dapp.address || null,
    publicKey: dapp.publicKey || null,
    Pdapp: dapp.Pdapp,
    ready: !!(dapp.seats[1]?.P && dapp.seats[2]?.P),
    seal: dapp.seal || null,
    clientBorn: true,
    dealerSawPlaintext: false,
    pdlOk: true,
    rangeOk: true,
  };
}

/** Promote next dapp to live after sweep + pool_set_address. */
export async function activateNextDapp({ sweepTxHash, accountId, setTx } = {}) {
  const next = loadNextDapp();
  if (!next?.address) throw new Error('next Q not ready');
  if (!next.seats?.[1]?.P || !next.seats?.[2]?.P) {
    throw new Error('next Q missing client-born seats');
  }
  if (!next.dappShareHex) throw new Error('next Q missing d_dapp');
  const live = loadDapp();
  const rot = loadRotate();
  if (live) {
    const arch = path.join(
      path.dirname(NEXT_DAPP_PATH),
      `pool-3p-dapp-prev-${Date.now()}.json`,
    );
    await writeFile(arch, JSON.stringify(live, null, 2));
  }
  /**
   * Recovery coverage of the Q we are leaving, read BEFORE packs are promoted.
   * Observe-only: a Q that reaches cutover unrecoverable spent its whole life
   * one closed tab away from stranding its balance.
   *
   * Incoming Q packs live in nextPacks (putPack accepts announced next P).
   * After writeDapp the new P is live, promoteOnCutover moves those packs
   * into packs[], and clearPreshare('q-rotate') does the same for the
   * legacy plaintext store. Do not wipe sealed packs here.
   */
  let recoveryAtCutover = null;
  try {
    recoveryAtCutover = recoverabilityView();
    if (!recoveryAtCutover.recoverable) {
      console.warn(
        `[rotate] cutover leaving ${live?.address?.slice(0, 12) || '?'}… ` +
          `UNRECOVERABLE: ${recoveryAtCutover.summary}`,
      );
    }
  } catch {
    /* never block a cutover on a diagnostic */
  }
  await writeDapp(next);
  await adoptHoldersFromDapp(next);
  await invalidateOpenLindell('q-rotate').catch(() => null);
  await wartSealedPreshare.promoteOnCutover().catch(() => null);
  await clearPreshare('q-rotate').catch(() => null);
  rot.phase = 'idle';
  rot.anchorBlock = await anvilBlockNumber().catch(() => rot.anchorBlock);
  rot.last = {
    at: new Date().toISOString(),
    address: next.address,
    previous: live?.address || null,
    sweepTxHash: sweepTxHash || rot.sweepTxHash || null,
    // The sweep whose block created this Q's account — the only tx that can
    // SPV-bind it again (resyncStaleInspect). Differs from sweepTxHash after
    // a refund re-sweep.
    bindTxHash: rot.bindTxHash || null,
    accountId: accountId || null,
    setTx: setTx || rot.setTx || null,
    // Coverage of the OUTGOING Q at the moment it was retired.
    recoveryAtCutover: recoveryAtCutover
      ? {
          recoverable: recoveryAtCutover.recoverable,
          atRisk: recoveryAtCutover.atRisk,
          summary: recoveryAtCutover.summary,
        }
      : null,
  };
  rot.next = null;
  rot.sweepTicketId = null;
  rot.lastError = null;
  await saveRotate(rot);
  try {
    await unlink(NEXT_DAPP_PATH);
  } catch {
    /* */
  }
  return { ok: true, address: next.address, previous: live?.address || null };
}

/**
 * Operator recovery for a next Q the machine can never bind.
 *
 * When the account-creating sweep block has fallen out of the machine LC's
 * WART_SPV_MAX_HEADERS window, pool_set_address for the next Q is rejected
 * forever while its balance sits there unspendable (2026-09-13: 341 WART in
 * 5aec0424…). This promotes that next Q to the coordinator's live Q WITHOUT a
 * machine bind — exactly activateNextDapp() minus the inspect confirmation —
 * records that the machine still sits on the previous Q (r.last.unboundInMachine
 * / machineLive), and immediately opens a fresh rotation (need_birth) so the
 * normal cycle sweeps the balance into a brand-new next Q whose creation block
 * is proven minutes later. syncInspectToLiveCoordinator() stays out of the way
 * while the flag is set; cutOver() refuses if the machine-live Q gained deposits.
 *
 * Dry-run by default. Refuses unless every precondition holds; never moves
 * funds itself.
 */
/**
 * Operator: strand the funded live Q and make next the coordinator live Q
 * without a sweep or pool_set_address. Inspect stays on the old Q;
 * pendingNext is already the next Q so browsers will sign a ticket FROM next.
 * Does not birth a further Q.
 */
export async function strandAndActivateNext({ dryRun = true, reason = '' } = {}) {
  if (tickLock) {
    try {
      await tickLock;
    } catch {
      /* */
    }
  }
  let release = null;
  tickLock = new Promise((res) => {
    release = res;
  });
  try {
    const r = loadRotate();
    const next = loadNextDapp();
    const live = loadDapp();
    const problems = [];
    if (!next?.address) problems.push('no next Q on disk');
    if (next && (!next.seats?.[1]?.P || !next.seats?.[2]?.P)) problems.push('next Q seats not both born');
    if (next && !next.dappShareHex) problems.push('next Q missing d_dapp');
    if (!live?.address) problems.push('no live Q on disk');
    if (r.last?.unboundInMachine) problems.push('previous activation still unbound');
    if (normQ(next?.address) === normQ(live?.address)) problems.push('next Q is already live');

    const feeNow = await wartMinFee().catch(() => 10000n);
    const nextAcct = next?.address ? await wartAccount(next.address).catch(() => null) : null;
    const liveAcct = live?.address ? await wartAccount(live.address).catch(() => null) : null;
    if (!(Number(nextAcct?.accountId) > 0)) problems.push('next Q has no Warthog account id');
    if ((nextAcct?.total ?? 0n) <= feeNow) problems.push('next Q holds nothing to pay from');

    const snap = await inspectPoolSnap().catch(() => null);
    const inspectLive = normQ(snap?.poolAddress);
    const inspectPending = normQ(snap?.pendingNext?.address || snap?.pendingNext);
    if (!snap) problems.push('inspect unreachable');
    if (snap && next?.address && inspectPending !== normQ(next.address)) {
      problems.push(`inspect pendingNext ${inspectPending.slice(0, 12) || 'null'}… is not the next Q`);
    }

    const userRooms = listOpenUserPool3pTickets();
    const plan = {
      ok: problems.length === 0,
      dryRun,
      reason: reason || 'strand-pay-from-next',
      problems,
      coordinatorLive: live?.address || null,
      machineLive: {
        address: inspectLive || null,
        accountId: Number(snap?.poolAccountId || 0) || null,
      },
      nextQ: next?.address || null,
      nextAccountId: Number(nextAcct?.accountId || 0) || null,
      nextBalanceE8: nextAcct ? nextAcct.total.toString() : null,
      liveBalanceE8: liveAcct ? liveAcct.total.toString() : null,
      pendingNext: inspectPending || null,
      openUserRooms: userRooms.map((t) => t.ticketId),
      willDo: [
        'close open user 3P rooms (rollup notice stays authorized)',
        'archive current Q and promote next to coordinator live (no set_address)',
        'mark unboundInMachine + strandedPrevious so inspect is not re-pinned and no new Q is born',
        'operator then reopens wart-pool-0:2 so prepare spends FROM next',
      ],
    };
    if (!plan.ok || dryRun) return plan;

    for (const t of userRooms) {
      await closePool3pRoom(t.ticketId, reason || 'strand-pay-from-next');
    }
    const act = await activateNextDapp({
      sweepTxHash: null,
      accountId: plan.nextAccountId,
      setTx: 'operator-strand-no-sweep',
    });
    const rot = loadRotate();
    rot.last = {
      ...(rot.last || {}),
      unboundInMachine: true,
      strandedPrevious: live.address,
      strandedBalanceE8: plan.liveBalanceE8,
      machineLive: plan.machineLive,
      activatedAt: new Date().toISOString(),
      activationReason: reason || 'strand-pay-from-next',
    };
    rot.lastError =
      'stranded previous Q — coordinator live is next; inspect stays on previous until a real sweep';
    await saveRotate(rot);
    console.warn(
      `[pool3pRotate] strandAndActivateNext: ${String(live.address).slice(0, 12)}… ` +
        `(${plan.liveBalanceE8} E8 stranded) → ${String(next.address).slice(0, 12)}… ` +
        `acct ${plan.nextAccountId} (${plan.nextBalanceE8} E8); inspect stays ` +
        `${String(plan.machineLive.address).slice(0, 12)}…`,
    );
    return { ...plan, applied: true, activate: act, phase: rot.phase };
  } finally {
    tickLock = null;
    if (release) release();
  }
}

export async function activateNextUnbound({ dryRun = true, reason = '' } = {}) {
  // Serialise with the driver: never run while a tick is mutating state.
  if (tickLock) {
    try {
      await tickLock;
    } catch {
      /* the tick's own failure is not ours */
    }
  }
  let release = null;
  tickLock = new Promise((res) => {
    release = res;
  });
  try {
    const r = loadRotate();
    const next = loadNextDapp();
    const live = loadDapp();
    const problems = [];
    if (r.phase !== 'cutover') problems.push(`phase is ${r.phase}, expected cutover`);
    if (!next?.address) problems.push('no next Q on disk');
    if (next && (!next.seats?.[1]?.P || !next.seats?.[2]?.P)) problems.push('next Q seats not both born');
    if (next && !next.dappShareHex) problems.push('next Q missing d_dapp');
    if (!live?.address) problems.push('no live Q on disk');
    if (r.last?.unboundInMachine) problems.push('previous activation still unbound — finish that rotation first');
    const userRooms = listOpenUserPool3pTickets();
    if (userRooms.length) problems.push(`${userRooms.length} user 3P room(s) open`);
    const rotateRooms = listOpenPool3pTickets().filter((t) => /rotate/i.test(String(t.ticketId || '')));
    if (rotateRooms.length) problems.push(`${rotateRooms.length} rotate room(s) open`);

    const feeNow = await wartMinFee().catch(() => 10000n);
    const nextAcct = next?.address ? await wartAccount(next.address).catch(() => null) : null;
    const liveAcct = live?.address ? await wartAccount(live.address).catch(() => null) : null;
    if (!(Number(nextAcct?.accountId) > 0)) problems.push('next Q has no Warthog account id');
    if ((nextAcct?.total ?? 0n) <= feeNow) problems.push('next Q holds nothing — nothing to recover');
    if ((liveAcct?.total ?? 0n) > feeNow) {
      problems.push(`live Q still holds ${liveAcct.total} E8 — sweep it first (normal cutover path)`);
    }

    const snap = await inspectPoolSnap().catch(() => null);
    const inspectLive = normQ(snap?.poolAddress);
    const inspectPending = normQ(snap?.pendingNext?.address || snap?.pendingNext);
    if (!snap) problems.push('inspect unreachable');
    if (snap && inspectLive !== normQ(live?.address)) {
      problems.push(`machine live ${inspectLive.slice(0, 12)}… is not the coordinator live Q`);
    }
    if (snap && next?.address && inspectPending !== normQ(next.address)) {
      problems.push(`machine pendingNext ${inspectPending.slice(0, 12) || 'null'}… is not the next Q`);
    }

    // Only for a bind the machine genuinely cannot verify.
    const bindTx = next?.address ? await pickBindSweepTx(r, next.address).catch(() => r.sweepTxHash) : null;
    const bindSt = bindTx ? await wartTxStatus(bindTx).catch(() => null) : null;
    const lcTip = Number(snap?.spv?.bestHeight || 0);
    const bindH = Number(bindSt?.height || 0);
    const belowTip = lcTip && bindH ? lcTip - bindH : null;
    if (!(bindH > 0)) problems.push('no mined account-creating sweep found for the next Q');
    if (belowTip != null && belowTip <= LC_WINDOW_HEADERS - 16) {
      problems.push(
        `bind block h=${bindH} is only ${belowTip} headers below the LC tip — the machine can still bind it; let cutover finish`,
      );
    }

    const plan = {
      ok: problems.length === 0,
      dryRun,
      reason: reason || null,
      problems,
      coordinatorLive: live?.address || null,
      machineLive: { address: inspectLive || null, accountId: Number(snap?.poolAccountId || 0) || null },
      nextQ: next?.address || null,
      nextAccountId: Number(nextAcct?.accountId || 0) || null,
      nextBalanceE8: nextAcct ? nextAcct.total.toString() : null,
      liveBalanceE8: liveAcct ? liveAcct.total.toString() : null,
      bindTx: bindTx || null,
      bindHeight: bindH || null,
      lcTip: lcTip || null,
      headersBelowTip: belowTip,
      lcWindow: LC_WINDOW_HEADERS,
      willDo: [
        'archive live Q to pool-3p-dapp-prev-<ts>.json and promote next Q to live (activateNextDapp)',
        'mark r.last.unboundInMachine=true with machineLive so inspect re-pin is suppressed',
        'create a fresh dapp-only next Q and enter need_birth so holders birth new seats',
        'normal cycle then sweeps the recovered balance into the new next Q and binds it with a fresh proof',
      ],
    };
    if (!plan.ok || dryRun) return plan;

    const act = await activateNextDapp({
      sweepTxHash: r.sweepTxHash,
      accountId: plan.nextAccountId,
      setTx: 'operator-activation-unbound',
    });
    const rot = loadRotate();
    rot.last = {
      ...(rot.last || {}),
      unboundInMachine: true,
      machineLive: plan.machineLive,
      bindTxHash: bindTx || null,
      activatedAt: new Date().toISOString(),
      activationReason: reason || null,
    };
    // Straight into a new rotation — do not sit in idle where the driver
    // would try to re-pin inspect to a Q the machine cannot bind.
    const { dapp } = await createDappOnlyPool();
    await writeNextDapp(dapp);
    rot.phase = 'need_birth';
    rot.nextStartedAt = new Date().toISOString();
    rot.lastError = null;
    rot.sweepTicketId = null;
    rot.sweepTxHash = null;
    rot.bindTxHash = null;
    rot.restartedSweeps = [];
    rot.announceTx = null;
    rot.setTx = null;
    rot.setTxAt = null;
    await saveRotate(rot);
    console.warn(
      `[pool3pRotate] activateNextUnbound: ${String(plan.coordinatorLive).slice(0, 12)}… → ` +
        `${String(plan.nextQ).slice(0, 12)}… (acct ${plan.nextAccountId}, ${plan.nextBalanceE8} E8) ` +
        `without machine bind; machine stays on ${String(plan.machineLive.address).slice(0, 12)}… ` +
        `acct ${plan.machineLive.accountId}; new next ${String(dapp.address).slice(0, 12)}… awaiting births`,
    );
    return { ...plan, applied: true, activate: act, newNext: dapp.address, phase: rot.phase };
  } finally {
    tickLock = null;
    if (release) release();
  }
}

function inspectPairOk(snap, addr, accountId = null) {
  if (!snap || normQ(snap.poolAddress) !== normQ(addr)) return false;
  const id = Number(snap.poolAccountId || 0);
  if (!(id > 0)) return false;
  if (accountId != null && Number(accountId) > 0 && id !== Number(accountId)) {
    return false;
  }
  return true;
}

async function buildAccountBindClaim({ txHash, poolAddress, destAccountId }) {
  const { buildPoolAccountIdClaim } = await import(
    '../../../../scripts/lib/wartSpvHost.mjs'
  );
  return buildPoolAccountIdClaim({
    txHash,
    poolAddress,
    destAccountId,
    minConfirmations: SWEEP_MIN_CONF,
    node: WART_NODE,
    bootstrap: false,
  });
}

async function postProvenPoolAccountId({ txHash, poolAddress, destAccountId }) {
  return submitPoolAdvance(
    await buildAccountBindClaim({ txHash, poolAddress, destAccountId }),
  );
}

/** Flip inspect hex and id in one InputBox payload. Machine rejects either half. */
async function postProvenSetAddress({
  txHash,
  address,
  destAccountId,
  sweepTxHash,
}) {
  const claim = await buildAccountBindClaim({
    txHash,
    poolAddress: address,
    destAccountId,
  });
  claim.type = 'pool_set_address';
  claim.address = normQ(address);
  claim.sweepTxHash = sweepTxHash || txHash;
  return submitPoolAdvance(claim);
}

export async function submitPoolAdvance(input) {
  if (rollupsIsV2()) {
    // rollups-node 2.x: same InputBox.addInput(app, payload), v2 InputBox +
    // Application addresses from env (CARTESI_INPUT_BOX_ADDRESS / CARTESI_APP_ADDRESS).
    const r = await rollupsAddInput(JSON.stringify(input));
    return { ok: true, txHash: r.txHash, type: input.type };
  }
  const { ethers } = await import('ethers-v6');
  const pk =
    env('RELAYER_PK') ||
    env('ANVIL_PK') ||
    '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
  const dapp = env('DAPP_ADDRESS', '0xab7528bb862fB57E8A2BCd567a2e929a0Be56a5e');
  const boxAddr = env('INPUT_BOX', '0x59b22D57D4f067708AB0c00552767405926dc768');
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(pk, provider);
  const box = new ethers.Contract(
    boxAddr,
    ['function addInput(address app, bytes input) returns (bytes32)'],
    wallet,
  );
  const bytes = ethers.toUtf8Bytes(JSON.stringify(input));
  const tx = await box.addInput(dapp, bytes);
  const rec = await tx.wait();
  return { ok: true, txHash: rec?.hash || tx.hash, type: input.type };
}
