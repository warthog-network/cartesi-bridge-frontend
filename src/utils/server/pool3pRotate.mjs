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
  ORBIT_VPS_ID,
} from './pool3p.mjs';

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
const ROTATE_PATH = env('POOL_3P_ROTATE') || path.join(DEFAULT_DATA, 'pool-3p-rotate.json');
export const NEXT_DAPP_PATH =
  env('POOL_3P_NEXT_DAPP') || path.join(DEFAULT_DATA, 'pool-3p-next.json');
const INTERVAL = Number(env('POOL_3P_ROTATE_EPOCHS', '2400')) || 2400;
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

async function saveRotate(r) {
  await mkdir(path.dirname(ROTATE_PATH), { recursive: true });
  await writeFile(ROTATE_PATH, JSON.stringify(r, null, 2));
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

function decodeInspectPayload(payload) {
  if (payload == null) return null;
  if (typeof payload === 'object') return payload;
  const s = String(payload);
  try {
    if (s.startsWith('0x')) {
      return JSON.parse(Buffer.from(s.slice(2), 'hex').toString('utf8'));
    }
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function inspectPoolSnap() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  try {
    const res = await fetch(`${INSPECT.replace(/\/$/, '')}/pool`, {
      cache: 'no-store',
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`inspect HTTP ${res.status}`);
    const data = await res.json();
    return decodeInspectPayload(data?.reports?.[0]?.payload);
  } finally {
    clearTimeout(timer);
  }
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
    due:
      dueIn === 0 ||
      ['need_birth', 'next_ready', 'announced', 'sweeping', 'cutover'].includes(r.phase),
    phase: r.phase || 'idle',
    machineReady: extra.machineReady ?? null,
    sweepTicketId: r.sweepTicketId || null,
    sweepTxHash: r.sweepTxHash || lastPaidRotate()?.txHash || null,
    announceTx: r.announceTx || null,
    setTx: r.setTx || null,
    lastError: r.lastError || extra.lastError || null,
    deferredForRooms,
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

export async function tickRotation() {
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
  await expireStaleUserRooms().catch(() => ({ closed: [] }));
  const rooms = userRoomsOpen();
  if (
    auto &&
    elapsed >= Number(r.intervalEpochs || INTERVAL) &&
    r.phase === 'idle'
  ) {
    if (rooms.length) {
      r.lastError = `rotate wait: ${rooms.length} user 3P room(s) open`;
      await saveRotate(r);
    } else {
      const { dapp } = await createDappOnlyPool();
      await writeNextDapp(dapp);
      r.phase = 'need_birth';
      r.nextStartedAt = new Date().toISOString();
      r.lastError = null;
      r.sweepTicketId = null;
      r.sweepTxHash = null;
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

  const machineReady = await machineSupportsSetAddress();
  if (!auto) return rotationView(loadRotate(), block, { machineReady });

  if (rooms.length && ['need_birth', 'next_ready'].includes(r.phase)) {
    r.lastError = `rotate wait: user 3P room still open`;
    await saveRotate(r);
    return rotationView(loadRotate(), block, { machineReady, userRooms: rooms });
  }

  if (r.phase === 'next_ready' && machineReady && next?.address) {
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
    await cutOver(r, next);
  }

  return rotationView(loadRotate(), block, { machineReady });
}

function openRotateRooms() {
  return listOpenPool3pTickets().filter((t) => /^wart-pool-rotate-/.test(String(t.ticketId || '')));
}

async function maybeOpenOrAdvanceSweep(r, next) {
  const paid = listPaidPool3pTickets(48).find(
    (p) =>
      p.ticketId === r.sweepTicketId ||
      (/^wart-pool-rotate-/.test(String(p.ticketId || '')) &&
        String(p.toAddress || '').toLowerCase() === String(next.address).toLowerCase()),
  );
  if (paid?.txHash) {
    r.phase = 'cutover';
    r.sweepTxHash = paid.txHash;
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
    r.lastError = 'sweep wait: user 3P room still open';
    await saveRotate(r);
    return;
  }

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
    r.lastError = null;
    await saveRotate(r);
    return;
  }

  if (r.sweepTicketId) {
    // Ticket id with no open room and no paid tx — do not mint another nonce.
    r.lastError = `sweep wait: ${r.sweepTicketId} not open`;
    r.phase = 'sweeping';
    await saveRotate(r);
    return;
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
    if (spendable <= fee) {
      r.phase = 'cutover';
      r.lastError = null;
      await saveRotate(r);
      return;
    }
    const amountE8 = spendable - fee;
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

async function cutOver(r, next) {
  try {
    let accountId = null;
    for (let i = 0; i < 8 && !accountId; i += 1) {
      const found = await wartAccount(next.address);
      if (found?.accountId) accountId = found.accountId;
      else await new Promise((res) => setTimeout(res, 400));
    }
    const posted = await submitPoolAdvance({
      type: 'pool_set_address',
      address: next.address,
      accountId,
      sweepTxHash: r.sweepTxHash || null,
    });
    r.setTx = posted.txHash;
    const act = await activateNextDapp({
      sweepTxHash: r.sweepTxHash,
      accountId,
    });
    r.lastError = null;
    return act;
  } catch (e) {
    r.lastError = `cutover: ${e.message || e}`;
    await saveRotate(r);
    return null;
  }
}

export async function birthNextSeat({ signerId, role, P, encD1, paillierN, paillierG }) {
  const r = Number(role);
  if (r !== 1 && r !== 2) throw new Error('role must be 1 or 2');
  const sid = String(signerId || '').trim();
  if (!sid) throw new Error('signerId required');
  if (sid === ORBIT_VPS_ID || /^pool-3p-signer-[12]$/.test(sid)) {
    throw new Error('VPS must not birth next Q');
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
  dapp.seats = dapp.seats || { 1: null, 2: null };
  if (dapp.seats[r]?.P && dapp.seats[r]?.signerId && dapp.seats[r].signerId !== sid) {
    throw new Error(`next d${r} already born by ${dapp.seats[r].signerId}`);
  }
  if (r === 1) {
    if (!encD1 || !paillierN || !paillierG) {
      throw new Error('d1 next-birth needs Enc(d1) + paillier keys');
    }
    dapp.seats[1] = {
      P: compressed,
      encD1: String(encD1),
      paillierN: String(paillierN),
      paillierG: String(paillierG),
      bornAt: new Date().toISOString(),
      signerId: sid,
    };
    dapp.ckeyD1 = String(encD1);
    dapp.paillierN = String(paillierN);
    dapp.paillierG = String(paillierG);
  } else {
    dapp.seats[2] = {
      P: compressed,
      bornAt: new Date().toISOString(),
      signerId: sid,
    };
  }
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

/** Promote next dapp to live after sweep + pool_set_address. */
export async function activateNextDapp({ sweepTxHash, accountId } = {}) {
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
  await writeDapp(next);
  await adoptHoldersFromDapp(next);
  await invalidateOpenLindell('q-rotate').catch(() => null);
  await clearPreshare('q-rotate').catch(() => null);
  rot.phase = 'idle';
  rot.anchorBlock = await anvilBlockNumber().catch(() => rot.anchorBlock);
  rot.last = {
    at: new Date().toISOString(),
    address: next.address,
    previous: live?.address || null,
    sweepTxHash: sweepTxHash || rot.sweepTxHash || null,
    accountId: accountId || null,
    setTx: rot.setTx || null,
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

export async function submitPoolAdvance(input) {
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
