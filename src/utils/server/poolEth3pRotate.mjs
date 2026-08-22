/**
 * ETH 3P Q rotation (e1/e2). No Cartesi inspect — custody is the Ethereum address.
 * Phases: idle → need_birth → next_ready → sweeping → cutover → idle
 */
import { readFileSync, existsSync } from 'node:fs';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
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

const DEFAULT_DATA = '/opt/cartesi-bridge/cartesi-bridge-frontend/.data';
const ROTATE_PATH =
  env('POOL_ETH3P_ROTATE') || path.join(DEFAULT_DATA, 'pool-eth-3p-rotate.json');
const INTERVAL = Number(env('POOL_ETH3P_ROTATE_EPOCHS', '200')) || 200;
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

async function saveRotate(r) {
  await mkdir(path.dirname(ROTATE_PATH), { recursive: true });
  await writeFile(ROTATE_PATH, JSON.stringify(r, null, 2));
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

function rotationView(r, block, extra = {}) {
  const interval = Number(r.intervalEpochs || INTERVAL);
  const elapsed =
    r.anchorBlock == null || block == null
      ? 0
      : Math.max(0, block - Number(r.anchorBlock));
  const dueIn = Math.max(0, interval - elapsed);
  const next = loadEthNext();
  const rooms = listOpenEthTickets().filter((t) => t.kind !== 'rotate-sweep');
  const deferred = rooms.length > 0;
  const need1 = !!(next && !next.seats?.[1]?.P);
  const need2 = !!(next && !next.seats?.[2]?.P);
  return {
    intervalEpochs: interval,
    anchorBlock: r.anchorBlock,
    block,
    elapsedEpochs: elapsed,
    dueInEpochs: dueIn,
    due: dueIn === 0,
    phase: r.phase || 'idle',
    sweepTicketId: r.sweepTicketId || null,
    sweepTxHash: r.sweepTxHash || extra.sweepTxHash || null,
    lastError: r.lastError || extra.lastError || null,
    deferredForRooms: deferred,
    next: next
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
      : null,
    last: r.last || null,
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
  if (r.anchorBlock == null || block < Number(r.anchorBlock)) {
    r.anchorBlock = block;
    await saveRotate(r);
    if (r.phase === 'idle') return rotationView(r, block);
  }
  const auto = envOn('POOL_ETH3P_AUTO_ROTATE', true);
  const elapsed = Math.max(0, block - Number(r.anchorBlock));
  const live = loadEthDapp();
  const rooms = listOpenEthTickets().filter((t) => t.kind !== 'rotate-sweep');

  if (auto && elapsed >= Number(r.intervalEpochs || INTERVAL) && r.phase === 'idle') {
    if (!live?.address || !live?.ckeyD1) {
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
      await writeEthNext(dapp);
      r.phase = 'need_birth';
      r.sweepTicketId = null;
      r.sweepTxHash = null;
      r.lastError = null;
      r.nextStartedAt = new Date().toISOString();
      await saveRotate(r);
    }
  }

  const next = loadEthNext();
  if (r.phase === 'need_birth' && next?.address && next.seats?.[1]?.P && next.seats?.[2]?.P) {
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

async function maybeSweep(r, next) {
  if (r.sweepTicketId) {
    const t = eth3pStatusTicket(r.sweepTicketId);
    if (t?.status === 'paid' && t.txHash) {
      r.sweepTxHash = t.txHash;
      r.phase = 'cutover';
      r.lastError = null;
      await saveRotate(r);
      return;
    }
    if (t?.ok && t.status !== 'abandoned') {
      r.lastError = `sweep wait: ${r.sweepTicketId} ${t.status}`;
      await saveRotate(r);
      return;
    }
  }
  try {
    const opened = await openEthSweepPayout({
      toAddress: next.address,
      ticketId: r.sweepTicketId || `eth-rotate-${Date.now()}`,
    });
    if (opened.skipped) {
      r.phase = 'cutover';
      r.lastError = null;
      await saveRotate(r);
      return;
    }
    r.phase = 'sweeping';
    r.sweepTicketId = opened.ticketId;
    r.lastError = null;
    await saveRotate(r);
  } catch (e) {
    r.lastError = `sweep: ${e.message || e}`;
    await saveRotate(r);
  }
}

async function activateNext(r, next) {
  const live = loadEthDapp();
  r.last = {
    address: live?.address || null,
    at: new Date().toISOString(),
    sweepTxHash: r.sweepTxHash || null,
  };
  await writeEthDapp(next);
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
  await mkdir(path.dirname(HOLDERS_PATH), { recursive: true });
  await writeFile(HOLDERS_PATH, JSON.stringify(holders, null, 2));
  try {
    await unlink(ETH_NEXT_PATH);
  } catch {
    /* */
  }
  r.phase = 'idle';
  r.anchorBlock = await anvilBlockNumber().catch(() => r.anchorBlock);
  r.sweepTicketId = null;
  r.lastError = null;
  await saveRotate(r);
}
