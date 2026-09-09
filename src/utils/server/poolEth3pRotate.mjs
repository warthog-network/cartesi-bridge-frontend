/**
 * ETH 3P Q rotation (e1/e2). No Cartesi inspect — custody is the Ethereum address.
 * Phases: idle → need_birth → next_ready → sweeping → cutover → idle
 */
import { readFileSync, existsSync } from 'node:fs';
import { writeFile, mkdir, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { createDappOnlyPool } from './pool3p.mjs';
import {
  loadEthDapp,
  writeEthDapp,
  loadEthNext,
  writeEthNext,
  ETH_NEXT_PATH,
  ETH_DAPP_PATH,
  listOpenEthTickets,
  openEthSweepPayout,
  eth3pStatusTicket,
  rememberEthPaid,
  syncEth3pAdapterPool,
  ethSealedPreshare,
  refreshEthSweepTicket,
} from './poolEth3p.mjs';

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
const ROTATE_PATH =
  env('POOL_ETH3P_ROTATE') || path.join(DEFAULT_DATA, 'pool-eth-3p-rotate.json');
const INTERVAL = Number(env('POOL_ETH3P_ROTATE_EPOCHS', '1000')) || 1000;
const RPC = env('CARTESI_RPC_URL', 'http://127.0.0.1:8545');
const HOLDERS_PATH =
  env('POOL_ETH3P_HOLDERS') || path.join(DEFAULT_DATA, 'pool-eth-3p-holders.json');

function emptyRotate() {
  return {
    intervalEpochs: INTERVAL,
    anchorBlock: null,
    phase: 'idle',
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

/**
 * Temp-then-rename, for the same reason poolEth3p's saveJson does it: a bare
 * writeFile onto the destination is not atomic, so a reader can catch a
 * truncated file and every loader here swallows the parse error and falls back.
 * This module drives the rotation state machine and owns the cutover write that
 * installs the holders file — a torn write in either is expensive.
 */
let rotSeq = 0;
async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++rotSeq}`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}

async function saveRotate(r) {
  await atomicWrite(ROTATE_PATH, JSON.stringify(r, null, 2));
}

async function anvilBlockNumber() {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  const j = await res.json();
  return parseInt(j.result, 16);
}

function ethSealed(live) {
  const d = live || loadEthDapp() || {};
  const s1 = d.seats?.[1]?.P || d.seats?.['1']?.P;
  const s2 = d.seats?.[2]?.P || d.seats?.['2']?.P;
  return !!(d.address && s1 && s2 && (d.ckeyD1 || d.seats?.[1]?.encD1 || d.seats?.['1']?.encD1));
}

function rotationView(r, block, extra = {}) {
  const interval = Number(r.intervalEpochs || INTERVAL);
  const live = extra.live || loadEthDapp();
  const sealed = extra.sealed ?? ethSealed(live);
  const next = loadEthNext();
  const rooms = listOpenEthTickets().filter((t) => t.kind !== 'rotate-sweep');
  const deferred = rooms.length > 0;
  const need1 = !!(next && !next.seats?.[1]?.P);
  const need2 = !!(next && !next.seats?.[2]?.P);
  const nextView = next
    ? {
        address: next.address || null,
        publicKey: next.publicKey || null,
        Pdapp: next.Pdapp || null,
        seatsReady: { 1: !!next.seats?.[1]?.P, 2: !!next.seats?.[2]?.P },
        needBirth: { 1: !deferred && need1, 2: !deferred && need2 },
        bornBy: {
          1: next.seats?.[1]?.signerId || null,
          2: next.seats?.[2]?.signerId || null,
        },
      }
    : null;
  const base = {
    intervalEpochs: interval,
    anchorBlock: r.anchorBlock,
    block,
    phase: r.phase || 'idle',
    paused: !!r.paused,
    sweepTicketId: r.sweepTicketId || null,
    sweepToAddress: r.sweepToAddress || null,
    sweepTxHash: r.sweepTxHash || extra.sweepTxHash || null,
    lastError: r.lastError || extra.lastError || null,
    deferredForRooms: deferred,
    next: nextView,
    last: r.last || null,
  };
  if (!sealed) {
    return {
      ...base,
      elapsedEpochs: 0,
      dueInEpochs: null,
      due: false,
      clock: 'waiting-seal',
      lastError: extra.lastError || r.lastError || 'rotate wait: live ETH 3P not sealed',
    };
  }
  const elapsed =
    r.anchorBlock == null || block == null
      ? 0
      : Math.max(0, block - Number(r.anchorBlock));
  const dueIn = Math.max(0, interval - elapsed);
  const phase = r.phase || 'idle';
  return {
    ...base,
    elapsedEpochs: elapsed,
    dueInEpochs: dueIn,
    due: dueIn === 0 && phase === 'idle',
    clock: phase === 'idle' ? (dueIn === 0 ? 'due' : 'running') : 'rotating',
  };
}

let tickLock = null;

export async function tickEthRotation() {
  if (tickLock) {
    try {
      await tickLock;
    } catch {
      /* */
    }
    let block = null;
    try {
      block = await anvilBlockNumber();
    } catch {
      /* */
    }
    return rotationView(loadRotate(), block);
  }
  tickLock = tickEthRotationInner();
  try {
    return await tickLock;
  } finally {
    tickLock = null;
  }
}

async function tickEthRotationInner() {
  const r = loadRotate();
  let block = null;
  try {
    block = await anvilBlockNumber();
  } catch {
    return rotationView(r, null);
  }
  /**
   * Operator pause, held in the rotate file rather than the environment so it
   * can be set and cleared without restarting the frontend — a restart drops
   * browser seat leases past POOL_3P_SEAT_IDLE_MS, which is its own fund-safety
   * event. Freezes the whole state machine, in-flight rotations included.
   */
  if (r.paused) {
    return rotationView(r, block);
  }
  if (r.anchorBlock == null || block < Number(r.anchorBlock)) {
    r.anchorBlock = block;
    await saveRotate(r);
    if (r.phase === 'idle') return rotationView(r, block);
  }
  const auto = envOn('POOL_ETH3P_AUTO_ROTATE', true);
  const elapsed = Math.max(0, block - Number(r.anchorBlock));
  const live = loadEthDapp();
  const rooms = listOpenEthTickets().filter((t) => t.kind !== 'rotate-sweep');

  if (!ethSealed(live)) {
    if (r.lastError !== 'rotate wait: live ETH 3P not sealed') {
      r.lastError = 'rotate wait: live ETH 3P not sealed';
      await saveRotate(r);
    }
    return rotationView(r, block, { live, sealed: false });
  }
  if (r.lastError && String(r.lastError).includes('not sealed')) {
    r.anchorBlock = block;
    r.lastError = null;
    await saveRotate(r);
    return rotationView(r, block, { live, sealed: true });
  }

  if (auto && elapsed >= Number(r.intervalEpochs || INTERVAL) && r.phase === 'idle') {
    if (!ethSealed(live)) {
      r.lastError = 'rotate wait: live ETH 3P not sealed';
      await saveRotate(r);
    } else if (rooms.length) {
      r.lastError = `rotate wait: ${rooms.length} ETH redeem room(s) open`;
      await saveRotate(r);
    } else {
      const { dapp } = await createDappOnlyPool();
      dapp.scheme = 'eth-3p-ecdsa-lindell-v1';
      dapp.clientBorn = true;
      dapp.dealerSawPlaintext = false;
      dapp.address = null;
      dapp.publicKey = null;
      dapp.seats = { 1: null, 2: null };
      dapp.note = 'Next ETH 3P — browsers birth e1/e2';
      // The one legitimate replacement of a closed next record: a fresh rotation
      // cycle. Every other writer is refused by writeEthNext().
      await writeEthNext(dapp, { replaceClosed: true });
      r.phase = 'need_birth';
      r.sweepTicketId = null;
      r.sweepTxHash = null;
      r.lastError = null;
      r.nextStartedAt = new Date().toISOString();
      await saveRotate(r);
    }
  }

  // Backstop for a redeem that slipped in on the idle→need_birth edge: hold
  // before the sweep so it can finish. Deliberately not extended to 'sweeping' —
  // ETH rooms have no staleness expiry (WART has expireStaleUserRooms), so a
  // wedged room there would stall rotation with nothing to clear it. The drain
  // gate in openEthRedeem is what keeps new rooms out once rotation starts.
  if (rooms.length && ['need_birth', 'next_ready'].includes(r.phase)) {
    r.lastError = `rotate wait: ${rooms.length} ETH redeem room(s) open`;
    await saveRotate(r);
    return rotationView(r, block);
  }

  const next = loadEthNext();
  /**
   * Both next seats birthed by the same tab is not a ready Q — it is a pool
   * that cannot sign. activateNext() below copies next.seats[r].signerId into
   * both roles in one write, and a signer only ever serves one role, so the
   * other seat goes live leased to a tab that is busy being the first one. The
   * sweep then waits on a contribution that will never come. That is exactly
   * how the 2026-08-25 23:59 cutover parked its sweep at wait_r1.
   *
   * birthEthSeatNext() now refuses to create this, so reaching here means a
   * next Q that predates that guard. Hold in need_birth and say why: the
   * current Q keeps signing, and the rotation resumes the moment a second tab
   * births the other seat.
   */
  const oneTabBirthedBoth = !!(
    next?.seats?.[1]?.signerId &&
    next.seats[1].signerId === next?.seats?.[2]?.signerId
  );
  if (r.phase === 'need_birth' && oneTabBirthedBoth) {
    const held =
      `next Q has both seats birthed by ${next.seats[1].signerId} — holding rotation ` +
      'until a second tab births one of them (a one-tab Q cannot sign after cutover)';
    // Only write when the message actually changes. tickEthRotation() runs on
    // every status poll, and re-saving an unchanged hold several times a second
    // is pure write amplification on the file that drives this state machine.
    if (r.lastError !== held) {
      r.lastError = held;
      await saveRotate(r);
    }
  } else if (r.phase === 'need_birth' && next?.address && next.seats?.[1]?.P && next.seats?.[2]?.P) {
    r.phase = 'next_ready';
    await saveRotate(r);
  }

  if (r.phase === 'next_ready' && next?.address) {
    r.phase = 'sweeping';
    await saveRotate(r);
  }

  if ((r.phase === 'sweeping' || r.phase === 'next_ready') && next?.address) {
    await maybeSweep(r, next);
  }

  if (r.phase === 'cutover' && next?.address) {
    await activateNext(r, next);
  }

  return rotationView(loadRotate(), block);
}

/**
 * Archive the record we are about to send money to.
 *
 * The WART side archives the outgoing Q at cutover (`pool-3p-dapp-prev-*.json`,
 * pool3pRotate.mjs); the ETH side had no Q archive at all. That asymmetry is
 * what turned both wrong payments — 2026-08-27 and 2026-08-31 — from recoverable
 * into permanent: the paid address existed only in pool-eth-3p-next.json, and
 * saveJson() is a bare temp-then-rename with no backup.
 *
 * Cheap insurance, deliberately best-effort: a failed archive must never block a
 * rotation, and `r.archivedNext` keeps it to one write per candidate rather than
 * one per 60s tick.
 */
async function archiveEthNextOnce(r, next) {
  const addr = String(next?.address || '').toLowerCase();
  if (!addr || r.archivedNext === addr) return;
  try {
    const arch = path.join(
      path.dirname(ETH_NEXT_PATH),
      `pool-eth-3p-dapp-prev-${Date.now()}.json`,
    );
    await writeFile(arch, JSON.stringify(next, null, 2), { mode: 0o600 });
    r.archivedNext = addr;
    await saveRotate(r);
  } catch {
    /* never block a rotation on bookkeeping */
  }
}

async function maybeSweep(r, next) {
  const nextAddr = String(next?.address || '').toLowerCase();
  if (r.sweepTicketId) {
    const t = eth3pStatusTicket(r.sweepTicketId);
    /**
     * The ticket's destination was frozen when it opened. If `next` has moved
     * since, the sweep is paying — or has already paid — an address that
     * cutover is no longer going to install. Halt rather than let the two
     * diverge any further; writeEthNext() should have made this unreachable,
     * so reaching it means a next that predates the lock.
     */
    const boundTo = String(t?.toAddress || r.sweepToAddress || '').toLowerCase();
    if (boundTo && nextAddr && boundTo !== nextAddr) {
      const held =
        `sweep/next mismatch — ticket ${r.sweepTicketId} pays ${boundTo} but next Q is ` +
        `${nextAddr}; rotation halted so the swept balance is not orphaned`;
      if (r.lastError !== held) {
        r.phase = 'sweeping';
        r.lastError = held;
        await saveRotate(r);
      }
      return;
    }
    if (t?.status === 'paid' && t.txHash) {
      r.sweepTxHash = t.txHash;
      r.phase = 'cutover';
      r.lastError = null;
      await saveRotate(r);
      return;
    }
    if (t?.ok && t.status !== 'abandoned') {
      const refreshed = await refreshEthSweepTicket(r.sweepTicketId).catch(() => null);
      if (refreshed?.repriced) {
        r.lastError = `sweep repriced ${r.sweepTicketId} — e1/e2 must re-sign`;
        await saveRotate(r);
        return;
      }
      r.lastError = `sweep wait: ${r.sweepTicketId} ${t.status}`;
      await saveRotate(r);
      return;
    }
  }
  /**
   * Arm the lock BEFORE the ticket opens.
   *
   * openEthSweepPayout() signs and broadcasts, which takes tens of seconds.
   * writeEthNext() refuses to move `next` only while sweepBoundNextAddress()
   * reports a binding, and that reads sweepTicketId + sweepToAddress back off
   * this file — so persisting them only after the await left the entire
   * broadcast window unguarded. On 2026-08-31 a late e1 finished its PDL
   * inside that window, finalizeEthClientBornQ() recomputed Q, and the sweep
   * paid 0x0d537c8a… while `next` had already moved to 0x88a38cd2…; the
   * mismatch guard above then halted rotation with the balance orphaned.
   *
   * Reserve under the same ticketId we are about to open so the two agree, and
   * release again on any path that does not leave a live ticket behind — a
   * binding with no ticket would block every future birth.
   */
  await archiveEthNextOnce(r, next);
  const ticketId = r.sweepTicketId || `eth-rotate-${Date.now()}`;
  const priorTicketId = r.sweepTicketId ?? null;
  const priorToAddress = r.sweepToAddress ?? null;
  const releaseReservation = () => {
    r.sweepTicketId = priorTicketId;
    r.sweepToAddress = priorToAddress;
  };
  r.phase = 'sweeping';
  r.sweepTicketId = ticketId;
  r.sweepToAddress = nextAddr;
  await saveRotate(r);
  try {
    const opened = await openEthSweepPayout({ toAddress: next.address, ticketId });
    if (opened.skipped) {
      releaseReservation();
      const liveBal = BigInt(opened.liveBalanceWei || '0');
      const liveAddr = loadEthDapp()?.address || null;
      if (liveAddr && liveBal > 0n && opened.reason !== 'dust only') {
        r.phase = 'sweeping';
        r.lastError = `sweep skip refused — live Q ${liveAddr} still has ETH`;
        await saveRotate(r);
        return;
      }
      if (liveAddr && opened.reason === 'dust only') {
        const { JsonRpcProvider } = await import('ethers-v6');
        const provider = new JsonRpcProvider(RPC);
        const onChain = await provider.getBalance(liveAddr);
        const feeData = await provider.getFeeData();
        const dust = 21000n * (feeData.gasPrice || 1n);
        if (onChain > dust) {
          r.phase = 'sweeping';
          r.lastError = `cutover blocked — live Q still has ${onChain.toString()} wei`;
          await saveRotate(r);
          return;
        }
      }
      r.phase = 'cutover';
      r.lastError = null;
      await saveRotate(r);
      return;
    }
    r.phase = 'sweeping';
    r.sweepTicketId = opened.ticketId;
    // Bind the rotation to the address this ticket actually pays. writeEthNext()
    // reads this back to refuse a re-birth, and activateNext() checks it before
    // installing anything.
    r.sweepToAddress = String(opened.toAddress || next.address || '').toLowerCase();
    r.lastError = null;
    await saveRotate(r);
  } catch (e) {
    releaseReservation();
    r.lastError = `sweep: ${e.message || e}`;
    await saveRotate(r);
  }
}

async function activateNext(r, next) {
  const live = loadEthDapp();
  const from = live?.address || null;
  const to = next.address || null;
  /**
   * The decisive gate. Cutover installs `next` as live and then unlinks
   * ETH_NEXT_PATH — the only copy of its key material. If the sweep paid some
   * other address, that unlink is what turns a recoverable mistake into an
   * orphaned balance. Refuse, keep the next file, and say which address holds
   * the money.
   *
   * Checked against the ticket rather than r.sweepToAddress alone: the ticket
   * is what was signed and broadcast, so it is the only authority on where the
   * ETH went.
   */
  if (r.sweepTxHash) {
    const swept = String(
      (r.sweepTicketId ? eth3pStatusTicket(r.sweepTicketId)?.toAddress : null) ||
        r.sweepToAddress ||
        '',
    ).toLowerCase();
    const target = String(to || '').toLowerCase();
    if (swept && target && swept !== target) {
      r.phase = 'sweeping';
      r.lastError =
        `cutover refused — sweep ${r.sweepTxHash} paid ${swept} but next Q is ${target}; ` +
        'not activating an unfunded Q (next file kept so its seats stay signable)';
      await saveRotate(r);
      return;
    }
  }
  if (from && !r.sweepTxHash) {
    const { JsonRpcProvider } = await import('ethers-v6');
    const provider = new JsonRpcProvider(RPC);
    const onChain = await provider.getBalance(from);
    const feeData = await provider.getFeeData();
    const dust = 21000n * (feeData.gasPrice || 1n);
    if (onChain > dust) {
      r.phase = 'sweeping';
      r.lastError = `cutover blocked — live Q ${from} still has ${onChain.toString()} wei (sweep must pay first)`;
      await saveRotate(r);
      return;
    }
  }
  let amountE8 = r.sweepAmountE8 || '0';
  let amountWei = r.sweepAmountWei || '0';
  if (r.sweepTicketId) {
    const t = eth3pStatusTicket(r.sweepTicketId);
    if (t?.amountE8) amountE8 = String(t.amountE8);
    if (t?.amountWei) amountWei = String(t.amountWei);
  }
  const paidRow = {
    ticketId: r.sweepTicketId || `eth-rotate-${Date.now()}`,
    kind: r.sweepTxHash ? 'rotate-sweep' : 'rotate-skip',
    txHash: r.sweepTxHash || null,
    amountE8,
    amountWei,
    fromAddress: from,
    toAddress: to,
    at: Date.now(),
  };
  await rememberEthPaid(paidRow).catch(() => null);
  r.last = {
    address: from,
    to,
    at: new Date().toISOString(),
    sweepTxHash: r.sweepTxHash || null,
    ticketId: paidRow.ticketId,
    amountE8,
    amountWei,
  };
  r.history = [r.last, ...(r.history || [])].slice(0, 16);
  await writeEthDapp(next);
  await ethSealedPreshare.promoteOnCutover().catch(() => null);
  // Adapter must follow the live Q. Deposits during the new epoch would
  // otherwise forward to the retired address, which e1/e2 can no longer spend.
  const adapterSync = await syncEth3pAdapterPool(to).catch((e) => ({
    ok: false,
    error: e?.message || String(e),
  }));
  if (adapterSync && adapterSync.ok === false) {
    r.lastError = `adapter setPool: ${adapterSync.error}`;
  }
  const ts = new Date().toISOString();
  const holders = {
    address: next.address,
    roles: {
      1: next.seats?.[1]?.signerId
        ? { signerId: next.seats[1].signerId, assignedAt: ts, lastSeen: ts }
        : undefined,
      2: next.seats?.[2]?.signerId
        ? { signerId: next.seats[2].signerId, assignedAt: ts, lastSeen: ts }
        : undefined,
    },
  };
  await atomicWrite(HOLDERS_PATH, JSON.stringify(holders, null, 2));
  try {
    await unlink(ETH_NEXT_PATH);
  } catch {
    /* */
  }
  r.phase = 'idle';
  r.anchorBlock = await anvilBlockNumber().catch(() => r.anchorBlock);
  r.sweepTicketId = null;
  r.sweepToAddress = null;
  r.lastError = null;
  await saveRotate(r);
}
