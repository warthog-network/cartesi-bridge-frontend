/**
 * Path A ETH 3P — parallel to WART pool3p, not Path B 2P vaults.
 *
 * d = d_dapp + e1 + e2. Address is Ethereum (keccak), scheme eth-3p-ecdsa-lindell-v1.
 * Seats are e1/e2 (roles 1/2). Separate files so they never collide with d1/d2.
 *
 * Wrap: ETH lock → credit Warthog addr → user createAssets(supply=X) → register hash.
 * Unwrap: send that hash to the one burn bin → pay ETH to burner's bound 0x.
 * Recipient is the minter (no VPS Warthog issuer key). DApp/coordinator badges the hash.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  randomScalar,
  scalarToHex,
  ethAddressFromPubCompressedHex,
  assertPaillierModulus,
  schnorrVerifyDlog,
  seatPokContext,
  cosignerSignStep,
  clientSignRound1,
  clientSignFinish,
} from '../twoPartyEcdsa.js';
import {
  verifyRangeLindell,
  pdlVerifierChallenge,
  pdlChallengePublic,
  pdlVerifierOpen,
  pdlVerifierAccept,
  verifyEncEqualsDlog,
} from '../lindellZk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FE_ROOT = path.join(__dirname, '../../..');
const G = secp256k1.ProjectivePoint.BASE;

function env(key, fallback = '') {
  const e = globalThis.process?.env || {};
  const v = e[key];
  return v == null || v === '' ? fallback : String(v);
}

const DEFAULT_DATA = '/opt/cartesi-bridge/cartesi-bridge-frontend/.data';
export const ETH3P_SCHEME = 'eth-3p-ecdsa-lindell-v1';
export const ETH3P_ORBIT_VPS_ID = 'pool-eth-3p-orbit-vps';

export const ETH_DAPP_PATH =
  env('POOL_ETH3P_DAPP') || path.join(DEFAULT_DATA, 'pool-eth-3p-dapp.json');
const ETH_HOLDERS_PATH =
  env('POOL_ETH3P_HOLDERS') || path.join(DEFAULT_DATA, 'pool-eth-3p-holders.json');
const ETH_ORBIT_PATH =
  env('POOL_ETH3P_ORBIT') || path.join(DEFAULT_DATA, 'pool-eth-3p-orbit.json');
const ETH_WRAPS_PATH =
  env('POOL_ETH3P_WRAPS') || path.join(DEFAULT_DATA, 'pool-eth-3p-wraps.json');
const ETH_BIND_PATH =
  env('POOL_ETH3P_BIND') || path.join(DEFAULT_DATA, 'pool-eth-3p-bind.json');
const ETH_SESS_PATH =
  env('POOL_ETH3P_SESSIONS') || path.join(DEFAULT_DATA, 'pool-eth-3p-sessions.json');
const WART_NODE = env('WARTHOG_NODE_URL', 'http://127.0.0.1:3001');
const ETH_RPC = env('CARTESI_RPC_URL', 'http://127.0.0.1:8545');

/** Nothing-up-my-sleeve Warthog burn bin: SHA-256(seed)[0:20] + SHA-256 checksum (valid 48-hex). */
export const ETH_BURN_BIN = (() => {
  const payload = createHash('sha256')
    .update('cartesi-eth-3p-burn-bin-v1')
    .digest()
    .subarray(0, 20);
  const checksum = createHash('sha256').update(payload).digest().subarray(0, 4);
  return Buffer.concat([Buffer.from(payload), Buffer.from(checksum)]).toString('hex');
})();

const ORBIT_LIVE_MS = Number(env('POOL_ETH3P_ORBIT_LIVE_MS', '20000')) || 20000;
const SEAT_IDLE_MS = Number(env('POOL_ETH3P_SEAT_IDLE_MS', '35000')) || 35000;

export function eth3pOn() {
  const v = env('POOL_ETH3P_MODE', '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

function nowMs() {
  return Date.now();
}

/** Serialize orbit/holders/dapp writes — overlapping heartbeats were clobbering liveCount. */
let ethLock = Promise.resolve();
function withEthLock(fn) {
  const run = ethLock.then(fn, fn);
  ethLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function pointToCompressedHex(P) {
  return Buffer.from(P.toRawBytes(true)).toString('hex');
}

function compactPoint(hex) {
  return String(hex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

function loadJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

async function saveJson(p, obj) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

export function loadEthDapp() {
  return loadJson(ETH_DAPP_PATH, null);
}

export async function writeEthDapp(dapp) {
  await saveJson(ETH_DAPP_PATH, dapp);
}

function loadHolders() {
  return loadJson(ETH_HOLDERS_PATH, { roles: {} });
}

async function saveHolders(h) {
  await saveJson(ETH_HOLDERS_PATH, h);
}

function loadOrbit() {
  return loadJson(ETH_ORBIT_PATH, { members: {} });
}

async function saveOrbit(o) {
  await saveJson(ETH_ORBIT_PATH, o);
}

function loadWraps() {
  return loadJson(ETH_WRAPS_PATH, { credits: [], wraps: [], burns: [] });
}

async function saveWraps(w) {
  await saveJson(ETH_WRAPS_PATH, w);
}

function loadBinds() {
  return loadJson(ETH_BIND_PATH, { ownerByWart: {} });
}

async function saveBinds(b) {
  await saveJson(ETH_BIND_PATH, b);
}

export function finalizeEthClientBornQ(dapp) {
  const P1 = dapp.seats?.[1]?.P || dapp.seats?.['1']?.P;
  const P2 = dapp.seats?.[2]?.P || dapp.seats?.['2']?.P;
  const Pd = dapp.Pdapp;
  if (!P1 || !P2 || !Pd) return dapp;
  const Q = secp256k1.ProjectivePoint.fromHex(P1)
    .add(secp256k1.ProjectivePoint.fromHex(P2))
    .add(secp256k1.ProjectivePoint.fromHex(Pd));
  const publicKey = pointToCompressedHex(Q);
  const address = ethAddressFromPubCompressedHex(publicKey);
  dapp.publicKey = publicKey;
  dapp.address = address;
  dapp.seal = {
    v: 1,
    scheme: 'eth-3p-seal-v1',
    address,
    publicKey,
    P1,
    P2,
    Pdapp: Pd,
    seatEpoch: Number(dapp.seatEpoch || 0),
    dealerSawPlaintext: false,
    bind: createHash('sha256')
      .update(
        ['eth-3p-seal-v1', address, publicKey, P1, P2, Pd, String(Number(dapp.seatEpoch || 0))].join(
          '|',
        ),
      )
      .digest('hex'),
  };
  return dapp;
}

export async function ensureEth3pDapp() {
  let dapp = loadEthDapp();
  if (dapp?.Pdapp) return dapp;
  const dDapp = randomScalar();
  const Pdapp = pointToCompressedHex(G.multiply(dDapp));
  dapp = {
    scheme: ETH3P_SCHEME,
    clientBorn: true,
    dealerSawPlaintext: false,
    address: null,
    publicKey: null,
    dappShareHex: scalarToHex(dDapp),
    Pdapp,
    seats: { 1: null, 2: null },
    seatEpoch: 0,
    createdAt: new Date().toISOString(),
    note: 'ETH 3P client-born: VPS has d_dapp only. Browsers birth e1/e2. Ethereum address after both P.',
  };
  await writeEthDapp(dapp);
  return dapp;
}

function liveOrbitMembers(o = loadOrbit(), now = nowMs()) {
  const out = [];
  for (const [id, m] of Object.entries(o.members || {})) {
    const seen = Date.parse(m.lastSeen || 0);
    if (Number.isFinite(seen) && now - seen <= ORBIT_LIVE_MS) out.push(id);
  }
  return out.sort();
}

function currentHolderId(role) {
  return loadHolders().roles?.[String(role)]?.signerId || null;
}

function holderStale(rec, now = nowMs()) {
  if (!rec?.signerId) return true;
  const seen = Date.parse(rec.lastSeen || rec.assignedAt || 0);
  if (!Number.isFinite(seen)) return true;
  return now - seen > SEAT_IDLE_MS;
}

async function touchOrbit(sid) {
  const o = loadOrbit();
  o.members = o.members || {};
  o.members[sid] = { lastSeen: new Date().toISOString() };
  const keep = Math.max(ORBIT_LIVE_MS, SEAT_IDLE_MS) * 4;
  const now = nowMs();
  for (const [id, m] of Object.entries(o.members)) {
    const seen = Date.parse(m.lastSeen || 0);
    if (!Number.isFinite(seen) || now - seen > keep) delete o.members[id];
  }
  await saveOrbit(o);
}

export async function maybeAbandonEthSeats() {
  const h = loadHolders();
  const live = liveOrbitMembers();
  let changed = false;
  for (const r of ['1', '2']) {
    const rec = h.roles?.[r];
    if (!rec?.signerId || !holderStale(rec)) continue;
    if (live.includes(rec.signerId)) continue;
    delete h.roles[r];
    changed = true;
  }
  if (changed) await saveHolders(h);
}

const pdlRam = new Map();
function pdlKey(signerId) {
  return `eth-birth:${String(signerId || '')}`;
}

export async function birthEthSeat({
  signerId,
  role,
  P,
  encD1,
  paillierN,
  paillierG,
  pok,
  rangeProof,
}) {
  const r = Number(role);
  if (r !== 1 && r !== 2) throw new Error('role must be 1 (e1) or 2 (e2)');
  const sid = String(signerId || '').trim();
  if (currentHolderId(r) !== sid) {
    throw new Error(`birth denied — not the current e${r} holder`);
  }
  const compressed = compactPoint(P);
  if (!/^[0-9a-f]{66}$/.test(compressed)) throw new Error('P must be 33-byte compressed hex');
  secp256k1.ProjectivePoint.fromHex(compressed);
  schnorrVerifyDlog(pok, compressed, seatPokContext('birth', r, compressed));
  const dapp = await ensureEth3pDapp();
  dapp.seats = dapp.seats || { 1: null, 2: null };
  const existingP = compactPoint(dapp.seats?.[r]?.P || '');
  if (existingP && existingP !== compressed) {
    throw new Error(`birth denied — e${r} already born on this Pdapp`);
  }
  if (r === 1) {
    if (!encD1 || !paillierN || !paillierG) {
      throw new Error('e1 birth needs Enc(e1) + paillierN + paillierG');
    }
    assertPaillierModulus(paillierN, { what: 'e1 birth Paillier N' });
    verifyRangeLindell({
      c: encD1,
      paillierN,
      paillierG,
      Q1: compressed,
      proof: rangeProof,
      context: seatPokContext('birth', 1, compressed),
    });
    const ch = pdlVerifierChallenge({
      ckey: encD1,
      paillierN,
      paillierG,
      Q1: compressed,
    });
    pdlRam.set(pdlKey(sid), {
      ch,
      P: compressed,
      encD1: String(encD1),
      paillierN: String(paillierN),
      paillierG: String(paillierG),
      signerId: sid,
    });
    return { ok: true, role: 1, needPdl: true, pdl: pdlChallengePublic(ch), clientBorn: true };
  }
  dapp.seats[2] = {
    P: compressed,
    bornAt: new Date().toISOString(),
    signerId: sid,
    pokOk: true,
  };
  finalizeEthClientBornQ(dapp);
  await writeEthDapp(dapp);
  return {
    ok: true,
    role: 2,
    address: dapp.address || null,
    publicKey: dapp.publicKey || null,
    Pdapp: dapp.Pdapp,
    ready: !!(dapp.seats[1]?.P && dapp.seats[2]?.P),
    seal: dapp.seal || null,
    clientBorn: true,
  };
}

export function openEthSeatPdl({ signerId, comQ }) {
  const row = pdlRam.get(pdlKey(signerId));
  if (!row?.ch) throw new Error('LINDELL_PDL: no pending challenge — re-birth e1');
  if (!comQ) throw new Error('LINDELL_PDL: need com(Q̂)');
  row.comQ = String(comQ);
  return { ok: true, needPdl: true, ...pdlVerifierOpen(row.ch) };
}

export async function finishEthSeatPdl({ signerId, Qhat, nonceQ, comQ }) {
  const sid = String(signerId || '').trim();
  const row = pdlRam.get(pdlKey(sid));
  if (!row?.ch) throw new Error('LINDELL_PDL: no pending challenge — re-birth e1');
  pdlVerifierAccept({
    ch: row.ch,
    Qhat,
    nonceQ,
    comQ: comQ || row.comQ,
  });
  const dapp = await ensureEth3pDapp();
  dapp.seats = dapp.seats || { 1: null, 2: null };
  dapp.seats[1] = {
    P: row.P,
    encD1: row.encD1,
    paillierN: row.paillierN,
    paillierG: row.paillierG,
    bornAt: new Date().toISOString(),
    signerId: row.signerId || sid,
    pokOk: true,
    rangeOk: true,
    pdlOk: true,
  };
  dapp.ckeyD1 = row.encD1;
  dapp.paillierN = row.paillierN;
  dapp.paillierG = row.paillierG;
  finalizeEthClientBornQ(dapp);
  await writeEthDapp(dapp);
  pdlRam.delete(pdlKey(sid));
  return {
    ok: true,
    role: 1,
    address: dapp.address || null,
    publicKey: dapp.publicKey || null,
    Pdapp: dapp.Pdapp,
    ready: !!(dapp.seats[1]?.P && dapp.seats[2]?.P),
    seal: dapp.seal || null,
    clientBorn: true,
    pdlOk: true,
  };
}

function enrollPayload(role, signerId, already) {
  const dapp = loadEthDapp() || {};
  const born = !!(dapp.seats?.[role]?.P || dapp.seats?.[String(role)]?.P);
  const seat = dapp.seats?.[role] || dapp.seats?.[String(role)] || null;
  return {
    scheme: ETH3P_SCHEME,
    role,
    shareIndex: role,
    signerId,
    clientBorn: true,
    needBirth: !born,
    waitlist: false,
    already: !!already,
    poolAddress: dapp.address || null,
    publicKey: dapp.publicKey || null,
    Pdapp: dapp.Pdapp || null,
    P: seat?.P || null,
    expectedP: seat?.P || (role === 1 ? dapp.seal?.P1 : dapp.seal?.P2) || null,
    seatEpoch: Number(dapp.seatEpoch || 0),
    seal: dapp.seal || null,
    message: born
      ? `You are e${role}. Hex stays in this tab.`
      : `Birth e${role} in this tab (makeClientSeat). VPS stores the point` +
        (role === 1 ? ' + Enc(e1).' : '.'),
  };
}

async function enrollUnlocked(sid) {
  await ensureEth3pDapp();
  await maybeAbandonEthSeats();
  await touchOrbit(sid);
  const h = loadHolders();
  h.roles = h.roles || {};
  for (const r of ['1', '2']) {
    if (h.roles[r]?.signerId === sid) {
      h.roles[r].lastSeen = new Date().toISOString();
      await saveHolders(h);
      return enrollPayload(Number(r), sid, true);
    }
  }
  const dapp = loadEthDapp();
  for (const r of ['1', '2']) {
    if (!h.roles[r]?.signerId) {
      const born = dapp?.seats?.[r] || dapp?.seats?.[Number(r)];
      if (born?.P && born.signerId && born.signerId !== sid) continue;
      h.roles[r] = {
        signerId: sid,
        assignedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      };
      await saveHolders(h);
      return enrollPayload(Number(r), sid, false);
    }
  }
  return {
    scheme: ETH3P_SCHEME,
    role: 0,
    waitlist: true,
    signerId: sid,
    poolAddress: dapp?.address || null,
    publicKey: dapp?.publicKey || null,
    Pdapp: dapp?.Pdapp || null,
    seal: dapp?.seal || null,
    holders: {
      1: h.roles['1']?.signerId || null,
      2: h.roles['2']?.signerId || null,
    },
    clientBorn: true,
    message: 'Orbit voter only. ETH 3P seats e1/e2 are leased.',
  };
}

export async function enrollEth3pSigner({ signerId }) {
  const sid = String(signerId || '').trim();
  if (!sid) throw new Error('signerId required');
  return withEthLock(() => enrollUnlocked(sid));
}

export async function heartbeatEth3p({ signerId, seatEpoch } = {}) {
  const sid = String(signerId || '').trim();
  if (!sid) throw new Error('signerId required');
  return withEthLock(async () => {
    await ensureEth3pDapp();
    await maybeAbandonEthSeats();
    await touchOrbit(sid);
    const h = loadHolders();
    let role = 0;
    for (const r of ['1', '2']) {
      if (h.roles?.[r]?.signerId === sid) {
        role = Number(r);
        h.roles[r].lastSeen = new Date().toISOString();
        await saveHolders(h);
      }
    }
    let share = null;
    let justClaimed = false;
    if (role === 0) {
      const claimed = await enrollUnlocked(sid);
      if (claimed && !claimed.waitlist && (claimed.role === 1 || claimed.role === 2)) {
        role = Number(claimed.role);
        share = claimed;
        justClaimed = true;
      } else {
        share = claimed;
      }
    }
    const dapp = loadEthDapp();
    const curEpoch = Number(dapp?.seatEpoch || 0);
    if (role > 0) share = enrollPayload(role, sid, !justClaimed);
    const live = liveOrbitMembers();
    return {
      ok: true,
      role,
      seatEpoch: curEpoch,
      lostSeat: role === 0,
      share,
      shareUpdated: justClaimed,
      holder1: currentHolderId(1),
      holder2: currentHolderId(2),
      orbit: {
        liveCount: live.length,
        live,
        leaseMs: ORBIT_LIVE_MS,
        seatIdleMs: SEAT_IDLE_MS,
      },
      clientBorn: true,
      address: dapp?.address || null,
      Pdapp: dapp?.Pdapp || null,
      needBirth: !!(share?.needBirth),
      seal: dapp?.seal || null,
      open: listOpenEthTickets().map(ticketView),
    };
  });
}

export async function publicEth3pStatus() {
  await ensureEth3pDapp();
  const d = loadEthDapp() || {};
  const live = liveOrbitMembers();
  const wraps = loadWraps();
  return {
    ok: true,
    configured: true,
    scheme: ETH3P_SCHEME,
    asset: 'ETH',
    chain: 'anvil',
    address: d.address || null,
    publicKey: d.publicKey || null,
    clientBorn: true,
    dealerSawPlaintext: false,
    seatsReady: {
      1: !!(d.seats?.[1]?.P || d.seats?.['1']?.P),
      2: !!(d.seats?.[2]?.P || d.seats?.['2']?.P),
    },
    holder1: currentHolderId(1),
    holder2: currentHolderId(2),
    e1Live: !!(currentHolderId(1) && live.includes(currentHolderId(1))),
    e2Live: !!(currentHolderId(2) && live.includes(currentHolderId(2))),
    Pdapp: d.Pdapp || null,
    seal: d.seal || null,
    hasCkeyE1: !!(d.ckeyD1 || d.seats?.[1]?.encD1),
    hasFullKey: false,
    paillierN: d.paillierN || d.seats?.[1]?.paillierN || null,
    paillierG: d.paillierG || d.seats?.[1]?.paillierG || null,
    burnBin: ETH_BURN_BIN,
    wraps: (wraps.wraps || []).slice(-20),
    credits: (wraps.credits || []).slice(-20),
    burns: (wraps.burns || []).slice(-20),
    open: listOpenEthTickets().map(ticketView),
    orbit: {
      liveCount: live.length,
      live,
      leaseMs: ORBIT_LIVE_MS,
    },
  };
}

function weiToE8(wei) {
  const w = BigInt(String(wei || '0'));
  return w / 10n ** 10n;
}

/** Credit wrap quota after Anvil ETH landed on the 3P address. */
export async function creditEthLock({
  ethTxHash,
  amountWei,
  wartAddress,
  fromEth,
}) {
  const dapp = loadEthDapp();
  if (!dapp?.address) throw new Error('ETH 3P Q not sealed yet');
  const tx = String(ethTxHash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(tx)) throw new Error('ethTxHash required');
  const wart = String(wartAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{48}$/.test(wart)) throw new Error('wartAddress (48-hex) required');
  const wei = BigInt(String(amountWei || '0'));
  if (wei <= 0n) throw new Error('amountWei must be > 0');
  const wraps = loadWraps();
  if ((wraps.credits || []).some((c) => c.ethTxHash === tx)) {
    return { ok: true, already: true, credit: wraps.credits.find((c) => c.ethTxHash === tx) };
  }
  const credit = {
    id: `eth-lock-${tx.slice(0, 16)}`,
    ethTxHash: tx,
    fromEth: fromEth ? String(fromEth).toLowerCase() : null,
    wartAddress: wart,
    amountWei: wei.toString(),
    amountE8: weiToE8(wei).toString(),
    remainingE8: weiToE8(wei).toString(),
    at: new Date().toISOString(),
  };
  wraps.credits = wraps.credits || [];
  wraps.credits.push(credit);
  await saveWraps(wraps);
  return { ok: true, credit };
}

/**
 * Recipient-as-minter: register createAssets hash. Supply must match remaining
 * credit for this Warthog issuer. DApp/coordinator stamps the badge.
 */
export async function registerEthWrap({
  assetHash,
  supplyE8,
  issuerWart,
  assetTxHash,
  assetName,
}) {
  const hash = String(assetHash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('assetHash must be 32-byte hex');
  const issuer = String(issuerWart || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{48}$/.test(issuer)) throw new Error('issuerWart (48-hex) required');
  const supply = BigInt(String(supplyE8 || '0'));
  if (supply <= 0n) throw new Error('supplyE8 must be > 0');
  const wraps = loadWraps();
  if ((wraps.wraps || []).some((w) => w.assetHash === hash)) {
    throw new Error('assetHash already registered');
  }
  const credit = (wraps.credits || []).find(
    (c) => c.wartAddress === issuer && BigInt(c.remainingE8 || '0') >= supply,
  );
  if (!credit) {
    throw new Error(
      'no ETH lock credit for this Warthog address covering that supply — lock ETH first',
    );
  }
  credit.remainingE8 = (BigInt(credit.remainingE8) - supply).toString();
  const wrap = {
    assetHash: hash,
    assetName: String(assetName || 'WETH')
      .toUpperCase()
      .slice(0, 5),
    supplyE8: supply.toString(),
    outstandingE8: supply.toString(),
    issuerWart: issuer,
    creditId: credit.id,
    ethTxHash: credit.ethTxHash,
    assetTxHash: assetTxHash
      ? String(assetTxHash).replace(/^0x/i, '').toLowerCase()
      : null,
    badge: {
      scheme: 'eth-3p-wrap-badge-v1',
      pool: loadEthDapp()?.address || null,
      assetHash: hash,
      supplyE8: supply.toString(),
      issuerWart: issuer,
      lockTx: credit.ethTxHash,
    },
    at: new Date().toISOString(),
  };
  wraps.wraps = wraps.wraps || [];
  wraps.wraps.push(wrap);
  await saveWraps(wraps);
  return { ok: true, wrap, burnBin: ETH_BURN_BIN };
}

/** Burner sent Y of a registered hash to the burn bin. Record unwrap (ETH pay is next). */
export async function recordEthBurn({
  assetHash,
  amountE8,
  burnerWart,
  wartTxHash,
}) {
  const hash = String(assetHash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const burner = String(burnerWart || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const y = BigInt(String(amountE8 || '0'));
  const tx = String(wartTxHash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('assetHash required');
  if (!/^[0-9a-f]{48}$/.test(burner)) throw new Error('burnerWart required');
  if (y <= 0n) throw new Error('amountE8 must be > 0');
  if (!/^[0-9a-f]{64}$/.test(tx)) {
    throw new Error('wartTxHash required — send the receipt to the burn bin first');
  }
  const wraps = loadWraps();
  const wrap = (wraps.wraps || []).find((w) => w.assetHash === hash);
  if (!wrap) throw new Error('unknown wrap hash — not a credited ETH receipt');
  if (BigInt(wrap.outstandingE8 || '0') < y) {
    throw new Error(`burn ${y} exceeds outstanding ${wrap.outstandingE8}`);
  }
  if ((wraps.burns || []).some((b) => b.wartTxHash === tx)) {
    return { ok: true, already: true };
  }
  wrap.outstandingE8 = (BigInt(wrap.outstandingE8) - y).toString();
  const binds = loadBinds();
  const boundEth = binds.ownerByWart?.[burner] || null;
  const burn = {
    assetHash: hash,
    amountE8: y.toString(),
    amountWei: (y * 10n ** 10n).toString(),
    burnerWart: burner,
    boundEth,
    wartTxHash: tx || null,
    at: new Date().toISOString(),
    status: boundEth ? 'ready' : 'need-bind',
  };
  wraps.burns = wraps.burns || [];
  wraps.burns.push(burn);
  await saveWraps(wraps);
  return { ok: true, burn, wrap, burnBin: ETH_BURN_BIN };
}

export async function bindEthOwner({ wartAddress, ethAddress }) {
  const wart = String(wartAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const eth = String(ethAddress || '').toLowerCase();
  if (!/^[0-9a-f]{48}$/.test(wart)) throw new Error('wartAddress required');
  if (!/^0x[0-9a-f]{40}$/.test(eth)) throw new Error('ethAddress 0x… required');
  const b = loadBinds();
  b.ownerByWart = b.ownerByWart || {};
  b.ownerByWart[wart] = eth;
  await saveBinds(b);
  return { ok: true, wartAddress: wart, ethAddress: eth };
}

export function eth3pBurnBin() {
  return ETH_BURN_BIN;
}

const ETH_RAM_D2 = new Map();
function loadEthSess() {
  return loadJson(ETH_SESS_PATH, { tickets: {} });
}
async function saveEthSess(s) {
  await saveJson(ETH_SESS_PATH, s);
}

function pointFromHex(hex) {
  return secp256k1.ProjectivePoint.fromHex(
    String(hex || '')
      .replace(/^0x/i, '')
      .toLowerCase(),
  );
}

async function lookupWartTx(txHash) {
  const h = String(txHash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('wartTxHash required');
  const res = await fetch(`${WART_NODE.replace(/\/$/, '')}/transaction/lookup/${h}`);
  if (!res.ok) throw new Error(`Warthog lookup HTTP ${res.status}`);
  const body = await res.json();
  if (body.code != null && body.code !== 0) {
    throw new Error(body.error || `lookup code ${body.code}`);
  }
  const t = body.data?.transaction || body.data || {};
  const nested = t.data || {};
  const common = t.signedCommon || {};
  return {
    txHash: String(t.hash || h).replace(/^0x/i, '').toLowerCase(),
    fromAddress: String(common.originAddress || nested.fromAddress || '')
      .replace(/^0x/i, '')
      .toLowerCase(),
    toAddress: String(nested.toAddress || '')
      .replace(/^0x/i, '')
      .toLowerCase(),
    assetHash: String(nested.tokenHash || nested.assetHash || nested.tokenId || '')
      .replace(/^0x/i, '')
      .toLowerCase(),
    amountE8: String(nested.amount?.E8 ?? nested.tokenAmount?.E8 ?? nested.amountE8 ?? '0'),
    confirmations: Number(body.data?.confirmations ?? 0),
  };
}

async function buildEthUnsigned({ to, valueWei }) {
  const { JsonRpcProvider, Transaction } = await import('ethers-v6');
  const dapp = loadEthDapp();
  if (!dapp?.address) throw new Error('ETH 3P Q not sealed');
  const provider = new JsonRpcProvider(ETH_RPC);
  const from = String(dapp.address).toLowerCase();
  const nonce = await provider.getTransactionCount(from, 'pending');
  const net = await provider.getNetwork();
  const fee = await provider.getFeeData();
  const tx = {
    to: String(to).toLowerCase(),
    value: BigInt(valueWei),
    nonce,
    gasLimit: 21000n,
    chainId: Number(net.chainId),
    type: 0,
    gasPrice: fee.gasPrice || 1n,
  };
  const unsigned = Transaction.from(tx);
  const hashHex = unsigned.unsignedHash.replace(/^0x/i, '').toLowerCase();
  return {
    tx: {
      to: tx.to,
      value: tx.value.toString(),
      nonce: tx.nonce,
      gasLimit: tx.gasLimit.toString(),
      chainId: tx.chainId,
      type: 0,
      gasPrice: tx.gasPrice.toString(),
    },
    hashHex,
    from,
  };
}

function ticketView(t) {
  if (!t) return { ok: false };
  return {
    ok: true,
    ticketId: t.ticketId,
    status: t.status,
    haveR1: !!t.haveR1,
    haveD2: !!t.haveD2,
    hasPartial: !!t.ciphertext,
    rHex: t.rHex || null,
    ciphertext: t.ciphertext || null,
    R1Hex: t.R1Hex || null,
    RHex: t.RHex || null,
    R2Hex: t.R2Hex || null,
    Q2Hex: t.Q2Hex || null,
    ckeyAdj: t.ckeyAdj || null,
    pokR: t.pokR || null,
    pokC: t.pokC || null,
    hashHex: t.hashHex || t.prep?.hashHex || null,
    amountE8: t.amountE8,
    toAddress: t.toAddress,
    amountWei: t.amountWei,
    assetHash: t.assetHash,
    burnerWart: t.burnerWart,
    prep: t.prep || null,
    paillierN: loadEthDapp()?.paillierN || null,
    paillierG: loadEthDapp()?.paillierG || null,
    txHash: t.payout?.txHash || null,
    payout: t.payout || null,
  };
}

function listOpenEthTickets() {
  const s = loadEthSess();
  return Object.values(s.tickets || {}).filter(
    (t) => t && t.room !== false && t.status !== 'paid' && t.status !== 'abandoned',
  );
}

/**
 * Verify WETH was sent to the burn bin, then open an ETH 3P Lindell room
 * paying the burner's bound L1 address.
 */
export async function openEthRedeem({
  wartTxHash,
  assetHash,
  amountE8,
  burnerWart,
  ethAddress,
}) {
  const dapp = loadEthDapp();
  if (!dapp?.address || !dapp?.ckeyD1) {
    throw new Error('ETH 3P not ready (need sealed Q + Enc(e1))');
  }
  const looked = await lookupWartTx(wartTxHash);
  if (looked.toAddress !== ETH_BURN_BIN) {
    throw new Error(
      `burn tx to ${looked.toAddress || '∅'} is not the burn bin ${ETH_BURN_BIN}`,
    );
  }
  const hash = String(assetHash || looked.assetHash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('assetHash required');
  if (looked.assetHash && looked.assetHash !== hash) {
    throw new Error('lookup asset hash does not match wrap');
  }
  const burner = String(burnerWart || looked.fromAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (looked.fromAddress && looked.fromAddress !== burner) {
    throw new Error('burn tx from-address is not the claimed burner');
  }
  const y = BigInt(String(amountE8 || looked.amountE8 || '0'));
  if (y <= 0n) throw new Error('amountE8 must be > 0');
  if (ethAddress) {
    await bindEthOwner({ wartAddress: burner, ethAddress });
  }
  const rec = await recordEthBurn({
    assetHash: hash,
    amountE8: y.toString(),
    burnerWart: burner,
    wartTxHash: looked.txHash,
  });
  const bound = rec.burn?.boundEth;
  if (!bound) {
    throw new Error('bind this Warthog address to a MetaMask 0x before redeem');
  }
  const unsigned = await buildEthUnsigned({
    to: bound,
    valueWei: (y * 10n ** 10n).toString(),
  });
  const ticketId = `eth-redeem-${looked.txHash.slice(0, 16)}`;
  const s = loadEthSess();
  s.tickets = s.tickets || {};
  if (s.tickets[ticketId]?.status === 'paid') {
    return { ok: true, alreadyPaid: true, ticketId, ...ticketView(s.tickets[ticketId]) };
  }
  s.tickets[ticketId] = {
    ticketId,
    status: 'open',
    room: true,
    assetHash: hash,
    amountE8: y.toString(),
    amountWei: unsigned.tx.value,
    toAddress: bound,
    burnerWart: burner,
    wartTxHash: looked.txHash,
    hashHex: unsigned.hashHex,
    prep: { ...unsigned, hashHex: unsigned.hashHex },
    openedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveEthSess(s);
  return { ok: true, ticketId, burnBin: ETH_BURN_BIN, ...ticketView(s.tickets[ticketId]) };
}

export async function eth3pOfferR1({ ticketId, signerId, R1Hex, hashHex }) {
  const sid = String(signerId || '').trim();
  if (currentHolderId(1) !== sid) throw new Error('e1 R1 must come from the current e1 holder');
  const s = loadEthSess();
  const t = s.tickets[String(ticketId)];
  if (!t) throw new Error('unknown ETH redeem ticket');
  if (t.status === 'paid') return { ok: false, alreadyPaid: true, ...ticketView(t) };
  const nextHash = String(hashHex || t.hashHex || t.prep?.hashHex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const nextR1 = compactPoint(R1Hex);
  t.R1Hex = nextR1;
  t.hashHex = nextHash;
  t.r1SignerId = sid;
  t.haveR1 = true;
  t.status = t.haveD2 ? 'ready' : 'wait_d2';
  t.updatedAt = Date.now();
  if (t.haveR1 && ETH_RAM_D2.has(t.ticketId)) {
    t.haveD2 = true;
    runEthLindell(t);
  }
  await saveEthSess(s);
  return ticketView(t);
}

export async function eth3pOfferD2({
  ticketId,
  signerId,
  encD2,
  encDlogProof,
  rangeProof,
}) {
  const sid = String(signerId || '').trim();
  if (currentHolderId(2) !== sid) {
    return { ok: false, skipped: true, error: 'e2 must come from the current e2 holder' };
  }
  const dapp = loadEthDapp();
  const wantP2 = compactPoint(dapp.seats?.[2]?.P || dapp.seal?.P2);
  if (!encD2 || !encDlogProof) throw new Error('e2 offer needs Enc(e2)+encDlogProof');
  if (!dapp.paillierN || !dapp.paillierG) throw new Error('needs e1 Paillier N,g');
  const ctx = `${seatPokContext('offer-d2', 2, wantP2)}|${ticketId}`;
  verifyEncEqualsDlog({
    c: encD2,
    paillierN: dapp.paillierN,
    paillierG: dapp.paillierG,
    Qhex: wantP2,
    proof: encDlogProof,
    context: ctx,
  });
  if (rangeProof) {
    verifyRangeLindell({
      c: encD2,
      paillierN: dapp.paillierN,
      paillierG: dapp.paillierG,
      Q1: wantP2,
      proof: rangeProof,
      context: ctx,
    });
  }
  ETH_RAM_D2.set(String(ticketId), String(encD2));
  const s = loadEthSess();
  const t = s.tickets[String(ticketId)];
  if (!t) throw new Error('unknown ETH redeem ticket');
  t.haveD2 = true;
  t.status = t.haveR1 ? 'ready' : 'wait_r1';
  t.updatedAt = Date.now();
  if (t.haveR1 && t.haveD2) runEthLindell(t);
  await saveEthSess(s);
  return ticketView(t);
}

function runEthLindell(t) {
  const encD2 = ETH_RAM_D2.get(t.ticketId);
  const dapp = loadEthDapp();
  if (!encD2 || !t.R1Hex || !t.hashHex) return;
  const Pd = dapp.seal?.Pdapp || dapp.Pdapp;
  const step = cosignerSignStep({
    R1Hex: t.R1Hex,
    hashHex: t.hashHex,
    dappShareHex: dapp.dappShareHex,
    encD2Str: encD2,
    ckeyStr: dapp.ckeyD1,
    paillierN: dapp.paillierN,
    paillierG: dapp.paillierG,
    Q2Hex: compactPoint(Pd),
    sid: t.ticketId,
  });
  t.rHex = step.rHex;
  t.ciphertext = step.ciphertext;
  t.RHex = step.RHex;
  t.R2Hex = step.R2Hex;
  t.Q2Hex = step.Q2Hex;
  t.ckeyAdj = step.ckeyAdj;
  t.pokR = step.pokR;
  t.pokC = step.pokC;
  t.status = 'partial';
}

export function eth3pStatusTicket(ticketId) {
  const s = loadEthSess();
  return ticketView(s.tickets[String(ticketId)]);
}

export async function eth3pSubmit({ ticketId, signature65 }) {
  const s = loadEthSess();
  const t = s.tickets[String(ticketId)];
  if (!t) throw new Error('unknown ETH redeem ticket');
  if (t.status === 'paid' && t.payout?.txHash) {
    return { ok: true, alreadyPaid: true, txHash: t.payout.txHash };
  }
  const sig = String(signature65 || '').replace(/^0x/i, '');
  if (!/^[0-9a-f]{130}$/i.test(sig)) throw new Error('signature65 required');
  const { JsonRpcProvider, Transaction, Signature } = await import('ethers-v6');
  const r = '0x' + sig.slice(0, 64);
  const sHex = '0x' + sig.slice(64, 128);
  let v = parseInt(sig.slice(128, 130), 16);
  if (v === 0 || v === 1) v += 27;
  const signed = Transaction.from({
    ...t.prep.tx,
    value: BigInt(t.prep.tx.value),
    gasLimit: BigInt(t.prep.tx.gasLimit),
    gasPrice: BigInt(t.prep.tx.gasPrice),
    signature: Signature.from({ r, s: sHex, v }),
  });
  const provider = new JsonRpcProvider(ETH_RPC);
  const resp = await provider.broadcastTransaction(signed.serialized);
  const rec = await resp.wait();
  t.status = 'paid';
  t.room = false;
  t.payout = {
    ok: true,
    txHash: rec?.hash || resp.hash,
    at: Date.now(),
    scheme: ETH3P_SCHEME,
  };
  t.haveR1 = false;
  t.haveD2 = false;
  delete t.ciphertext;
  ETH_RAM_D2.delete(t.ticketId);
  await saveEthSess(s);
  return { ok: true, txHash: t.payout.txHash, ticketId: t.ticketId };
}

export { clientSignRound1, clientSignFinish, listOpenEthTickets };
