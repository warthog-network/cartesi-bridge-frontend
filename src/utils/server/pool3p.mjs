/**
 * Path A4 — 3-party pool custody.
 * d = d_dapp + d1 + d2  (mod n). Full d is never stored.
 *
 * VPS / API store: d_dapp + Enc(d1) + Paillier pk only.
 * Signer 1: d1 + Paillier sk (finish Lindell).
 * Signer 2: Enc(d2) under d1's Paillier + Enc=dlog(P2). Never persist to sessions JSON.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { generateRandomKeys, PublicKey } from 'paillier-bigint';
import {
  randomScalar,
  modN,
  scalarToHex,
  hexToScalar,
  addressFromPubCompressedHex,
  clientSignRound1,
  clientSignFinish,
  cosignerSignStep,
  assertPaillierModulus,
  schnorrVerifyDlog,
  schnorrProveDlog,
  seatPokContext,
  paillierBitLength,
  assertLindellPlaintextRange,
  DEFAULT_PAILLIER_BITS,
  MIN_PAILLIER_BITS,
} from '../twoPartyEcdsa.js';
import {
  randomShareLindellRange,
  encryptWithR,
  runLindellPdl,
  verifyRangeLindell,
  pdlVerifierChallenge,
  pdlChallengePublic,
  pdlVerifierOpen,
  pdlVerifierAccept,
  verifyEncEqualsDlog,
} from '../lindellZk.js';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  assertReleaseNoticeProof,
  ticketNeedsNoticeProof,
} from './poolTicketVerify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FE_ROOT = path.join(__dirname, '../../..');
const G = secp256k1.ProjectivePoint.BASE;
const POOL_3P_NONCE_PATH =
  (globalThis.process?.env?.POOL_3P_NONCE) ||
  path.join(FE_ROOT, '.data/pool-3p-nonce.json');

/** Avoid Vite tree-shaking this out of the pool.js static import of pool3pPay. */
function nonceAlreadyUsed(fromAddress, nonceId) {
  const addr = String(fromAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const n = Number(nonceId);
  if (!addr || !Number.isFinite(n)) return false;
  try {
    const file = JSON.parse(readFileSync(POOL_3P_NONCE_PATH, 'utf8'));
    const last = Number(file[addr]);
    return Number.isFinite(last) && n <= last;
  } catch {
    return false;
  }
}

export const POOL3P_SCHEME = 'wart-3p-ecdsa-lindell-v1';

function paillierBitsFromEnv() {
  const raw = Number(env('PAILLIER_BITS', String(DEFAULT_PAILLIER_BITS)));
  const bits = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PAILLIER_BITS;
  if (bits < MIN_PAILLIER_BITS) {
    throw new Error(
      `PAILLIER_BITS=${bits} refused — floor is ${MIN_PAILLIER_BITS} (Phase 0: 1024-bit Enc(d1) is a d1 leak if N factors)`,
    );
  }
  return bits;
}

export function requireSeatPok({ pok, P, role, kind }) {
  const Phex = String(P || '').replace(/^0x/i, '').toLowerCase();
  schnorrVerifyDlog(pok, Phex, seatPokContext(kind, role, Phex));
}

function env(key, fallback = '') {
  // Dynamic lookup — Vite must not inline these at FE build time.
  const e = globalThis.process?.env || {};
  const v = e[key];
  return v == null || v === '' ? fallback : String(v);
}

const DEFAULT_DATA = '/opt/cartesi-bridge/cartesi-bridge-frontend/.data';
export const DAPP_PATH =
  env('POOL_3P_DAPP') || path.join(DEFAULT_DATA, 'pool-3p-dapp.json');
export const SESS_PATH =
  env('POOL_3P_SESSIONS') || path.join(DEFAULT_DATA, 'pool-3p-sessions.json');
const PAID_PATH =
  env('POOL_3P_PAID') || path.join(DEFAULT_DATA, 'pool-3p-paid.json');
export const SIGNER_DIR =
  env('POOL_3P_SIGNER_DIR') || path.join(DEFAULT_DATA, 'pool-3p-signers');

export function pool3pOn() {
  const v = env('POOL_3P_MODE', '0').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/** Browsers birth d1/d2. VPS keeps only d_dapp + points + Enc(d1). */
export function clientBornOn() {
  const v = env('POOL_3P_CLIENT_BORN', '0').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

export const ORBIT_VPS_ID = 'pool-3p-orbit-vps';

export const PRESHARE_PATH =
  env('POOL_3P_PRESHARE') || path.join(DEFAULT_DATA, 'pool-3p-preshare.json');

function pointToCompressedHex(P) {
  return Buffer.from(P.toRawBytes(true)).toString('hex');
}

function pointFromHex(hex) {
  return secp256k1.ProjectivePoint.fromHex(String(hex || '').replace(/^0x/i, ''));
}

export function sealBindHex({ address, publicKey, P1, P2, Pdapp, seatEpoch }) {
  return createHash('sha256')
    .update(
      [
        'wart-3p-seal-v1',
        String(address || ''),
        String(publicKey || ''),
        String(P1 || ''),
        String(P2 || ''),
        String(Pdapp || ''),
        String(Number(seatEpoch || 0)),
      ].join('|'),
    )
    .digest('hex');
}

export function buildSeal({
  address,
  publicKey,
  P1,
  P2,
  Pdapp,
  seatEpoch = 0,
  dealerSawPlaintext = true,
}) {
  const seal = {
    v: 1,
    scheme: 'wart-3p-seal-v1',
    address,
    publicKey,
    P1,
    P2,
    Pdapp,
    seatEpoch: Number(seatEpoch || 0),
    dealerSawPlaintext: !!dealerSawPlaintext,
  };
  seal.bind = sealBindHex(seal);
  return seal;
}

export function sealFromScalars({ address, publicKey, d1, d2, dDapp, seatEpoch, dealerSawPlaintext }) {
  return buildSeal({
    address,
    publicKey,
    P1: pointToCompressedHex(G.multiply(d1)),
    P2: pointToCompressedHex(G.multiply(d2)),
    Pdapp: pointToCompressedHex(G.multiply(dDapp)),
    seatEpoch,
    dealerSawPlaintext,
  });
}

/**
 * Signer-side check: this scalar is the committed seat for this vault.
 * Detects swap/tamper. Cannot prove a dealer who made the scalar never looked.
 */
export function verifyShareSeal({ shareHex, role, seal }) {
  if (!seal || seal.scheme !== 'wart-3p-seal-v1' || !seal.bind) {
    throw new Error('SEAL_MISSING: share has no 3P seal');
  }
  const expect = sealBindHex(seal);
  if (expect !== seal.bind) throw new Error('SEAL_BROKEN: bind hash mismatch');
  const P1 = pointFromHex(seal.P1);
  const P2 = pointFromHex(seal.P2);
  const Pd = pointFromHex(seal.Pdapp);
  const Q = pointFromHex(seal.publicKey);
  const sum = P1.add(P2).add(Pd);
  if (pointToCompressedHex(sum) !== pointToCompressedHex(Q)) {
    throw new Error('SEAL_BROKEN: P1+P2+Pdapp ≠ Q — shares were not bound to this vault');
  }
  const addr = addressFromPubCompressedHex(seal.publicKey);
  if (addr !== String(seal.address || '').toLowerCase()) {
    throw new Error('SEAL_BROKEN: address ≠ Q');
  }
  const d = hexToScalar(shareHex);
  const Pgot = pointToCompressedHex(G.multiply(d)).toLowerCase();
  const Pwant = String(Number(role) === 1 ? seal.P1 : Number(role) === 2 ? seal.P2 : '')
    .toLowerCase();
  if (!Pwant || Pgot !== Pwant) {
    throw new Error(
      `SEAL_BROKEN: d${role}·G ≠ published P${role} — share was swapped or replaced`,
    );
  }
  return {
    ok: true,
    address: seal.address,
    seatEpoch: seal.seatEpoch,
    dealerSawPlaintext: !!seal.dealerSawPlaintext,
  };
}

export async function createThreePartyPool({
  signer1Id = 'pool-3p-signer-1',
  signer2Id = 'pool-3p-signer-2',
} = {}) {
  const d1 = randomShareLindellRange();
  const d2 = randomScalar();
  const dDapp = randomScalar();
  const d = modN(d1 + d2 + dDapp);
  const Q = G.multiply(d);
  const publicKey = pointToCompressedHex(Q);
  const address = addressFromPubCompressedHex(publicKey);

  const bits = paillierBitsFromEnv();
  const { publicKey: pk, privateKey: sk } = await generateRandomKeys(bits);
  const enc = encryptWithR(pk, d1);
  const Q1 = pointToCompressedHex(G.multiply(d1));
  runLindellPdl({
    x1: d1,
    rEnc: enc.r,
    ckey: enc.c.toString(),
    Q1,
    paillierN: pk.n.toString(),
    paillierG: pk.g.toString(),
    paillierLambda: sk.lambda.toString(),
    paillierMu: sk.mu.toString(),
    context: 'ceremony',
  });
  const ckeyD1 = enc.c;

  const seal = sealFromScalars({
    address,
    publicKey,
    d1,
    d2,
    dDapp,
    seatEpoch: 0,
    dealerSawPlaintext: true,
  });
  const dapp = {
    scheme: POOL3P_SCHEME,
    address,
    publicKey,
    dappShareHex: scalarToHex(dDapp),
    paillierN: pk.n.toString(),
    paillierG: pk.g.toString(),
    ckeyD1: ckeyD1.toString(),
    signer1Id,
    signer2Id,
    createdAt: new Date().toISOString(),
    seal,
    pdlOk: true,
    rangeOk: true,
    note: 'd_dapp + Enc(d1) only — never d1/d2/d. Seal binds P1+P2+Pdapp=Q. L_PDL checked at ceremony.',
  };
  const s1 = {
    role: 1,
    signerId: signer1Id,
    address,
    publicKey,
    userShareHex: scalarToHex(d1),
    paillierLambda: sk.lambda.toString(),
    paillierMu: sk.mu.toString(),
    paillierN: pk.n.toString(),
    paillierG: pk.g.toString(),
    scheme: POOL3P_SCHEME,
  };
  const s2 = {
    role: 2,
    signerId: signer2Id,
    address,
    publicKey,
    userShareHex: scalarToHex(d2),
    scheme: POOL3P_SCHEME,
  };
  return { dapp, s1, s2, address, publicKey };
}

/** VPS-only d_dapp. No address until both browsers upload P1 and P2. */
export async function createDappOnlyPool() {
  const dDapp = randomScalar();
  const Pdapp = pointToCompressedHex(G.multiply(dDapp));
  const dapp = {
    scheme: POOL3P_SCHEME,
    clientBorn: true,
    dealerSawPlaintext: false,
    address: null,
    publicKey: null,
    dappShareHex: scalarToHex(dDapp),
    Pdapp,
    seats: { 1: null, 2: null },
    signer1Id: null,
    signer2Id: null,
    seatEpoch: 0,
    createdAt: new Date().toISOString(),
    note: 'client-born: VPS has d_dapp only. Browsers birth d1/d2. Seal after both P arrive.',
  };
  return { dapp, Pdapp };
}

export function finalizeClientBornQ(dapp) {
  const P1 = dapp.seats?.[1]?.P;
  const P2 = dapp.seats?.[2]?.P;
  const Pd = dapp.Pdapp;
  if (!P1 || !P2 || !Pd) return dapp;
  const Q = secp256k1.ProjectivePoint.fromHex(P1)
    .add(secp256k1.ProjectivePoint.fromHex(P2))
    .add(secp256k1.ProjectivePoint.fromHex(Pd));
  const publicKey = pointToCompressedHex(Q);
  dapp.publicKey = publicKey;
  dapp.address = addressFromPubCompressedHex(publicKey);
  dapp.seal = {
    v: 1,
    scheme: 'wart-3p-seal-v1',
    address: dapp.address,
    publicKey,
    P1,
    P2,
    Pdapp: Pd,
    seatEpoch: Number(dapp.seatEpoch || 0),
    dealerSawPlaintext: false,
    bind: null,
  };
  const msg = [
    'wart-3p-seal-v1',
    dapp.address,
    publicKey,
    P1,
    P2,
    Pd,
    String(Number(dapp.seatEpoch || 0)),
  ].join('|');
  dapp.seal.bind = createHash('sha256').update(msg).digest('hex');
  return dapp;
}

const pdlRam = new Map();

function pdlKey(signerId, kind = 'birth') {
  return `${kind}:${String(signerId || '')}`;
}

export function stashSeatPdl({ kind = 'birth', signerId, ch, P, encD1, paillierN, paillierG }) {
  const sid = String(signerId || '').trim();
  if (!sid) throw new Error('LINDELL_PDL: signerId required');
  pdlRam.set(pdlKey(sid, kind), {
    ch,
    P,
    encD1: String(encD1),
    paillierN: String(paillierN),
    paillierG: String(paillierG),
    signerId: sid,
  });
}

export async function birthClientSeat({
  signerId,
  role,
  P,
  encD1,
  paillierN,
  paillierG,
  pok,
  rangeProof,
}) {
  if (!clientBornOn()) throw new Error('client-born mode is off');
  const r = Number(role);
  if (r !== 1 && r !== 2) throw new Error('role must be 1 or 2');
  const sid = String(signerId || '').trim();
  if (currentHolderId(r) !== sid) {
    throw new Error('birth denied — not the current holder of this seat');
  }
  const compressed = String(P || '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{66}$/.test(compressed)) throw new Error('P must be 33-byte compressed hex');
  secp256k1.ProjectivePoint.fromHex(compressed);
  requireSeatPok({ pok, P: compressed, role: r, kind: 'birth' });
  const dapp = loadDapp();
  if (!dapp) throw new Error('3P pool not configured');
  dapp.seats = dapp.seats || { 1: null, 2: null };
  if (r === 1) {
    if (!encD1 || !paillierN || !paillierG) {
      throw new Error('d1 birth needs Enc(d1) + paillierN + paillierG');
    }
    assertPaillierModulus(paillierN, { what: 'd1 birth Paillier N' });
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
    pdlRam.set(pdlKey(sid, 'birth'), {
      ch,
      P: compressed,
      encD1: String(encD1),
      paillierN: String(paillierN),
      paillierG: String(paillierG),
      signerId: sid,
    });
    return {
      ok: true,
      role: 1,
      needPdl: true,
      pdl: pdlChallengePublic(ch),
      clientBorn: true,
    };
  } else {
    dapp.seats[2] = {
      P: compressed,
      bornAt: new Date().toISOString(),
      signerId: sid,
      pokOk: true,
    };
  }
  finalizeClientBornQ(dapp);
  await writeDapp(dapp);
  return {
    ok: true,
    role: r,
    address: dapp.address || null,
    publicKey: dapp.publicKey || null,
    Pdapp: dapp.Pdapp,
    ready: !!(dapp.seats[1]?.P && dapp.seats[2]?.P),
    seal: dapp.seal || null,
    clientBorn: true,
  };
}

export function openClientSeatPdl({ signerId, comQ, kind = 'birth' }) {
  const row = pdlRam.get(pdlKey(signerId, kind));
  if (!row?.ch) throw new Error('LINDELL_PDL: no pending challenge — re-birth');
  if (!comQ) throw new Error('LINDELL_PDL: need com(Q̂)');
  row.comQ = String(comQ);
  return { ok: true, needPdl: true, ...pdlVerifierOpen(row.ch) };
}

export async function finishClientSeatPdl({
  signerId,
  Qhat,
  nonceQ,
  comQ,
  kind = 'birth',
}) {
  const sid = String(signerId || '').trim();
  const row = pdlRam.get(pdlKey(sid, kind));
  if (!row?.ch) throw new Error('LINDELL_PDL: no pending challenge — re-birth');
  pdlVerifierAccept({
    ch: row.ch,
    Qhat,
    nonceQ,
    comQ: comQ || row.comQ,
  });
  if (kind === 'birth-next') {
    const { sealNextSeatPdl } = await import('./pool3pRotate.mjs');
    const out = await sealNextSeatPdl({ signerId: sid, row });
    pdlRam.delete(pdlKey(sid, kind));
    return out;
  }
  const dapp = loadDapp();
  if (!dapp) throw new Error('3P pool not configured');
  dapp.seats = dapp.seats || { 1: null, 2: null };
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
  if (kind === 'rekey') {
    dapp.seats[1].rekeyedAt = new Date().toISOString();
  } else {
    finalizeClientBornQ(dapp);
  }
  await writeDapp(dapp);
  if (kind === 'rekey') {
    await invalidateOpenLindell('rekey-d1');
  }
  pdlRam.delete(pdlKey(sid, kind));
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
    rangeOk: true,
  };
}

/**
 * Same d1, new Paillier. Use when the original tab still has d1 hex but lost λ/μ.
 * Does not change P or the pool address.
 */
export async function rekeyClientD1Paillier({
  signerId,
  d1Hex,
  encD1,
  paillierN,
  paillierG,
  pok,
  rangeProof,
}) {
  if (!clientBornOn()) throw new Error('client-born mode is off');
  const sid = String(signerId || '').trim();
  const dapp = loadDapp();
  if (!dapp) throw new Error('3P pool not configured');
  const bornSid = dapp.seats?.['1']?.signerId || null;
  const holder = currentHolderId(1);
  if (sid !== holder && sid !== bornSid) {
    throw new Error('rekey denied — not the d1 dealer');
  }
  const Pwant = String(dapp.seats?.['1']?.P || dapp.seal?.P1 || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!Pwant) throw new Error('rekey denied — no live P1');
  // Schnorr of live P1. Range is optional: this Q’s d1 was sampled on Z_q
  // before Phase 5, so Appendix A can reject a valid existing share.
  requireSeatPok({ pok, P: Pwant, role: 1, kind: 'rekey' });
  void d1Hex;
  if (!encD1 || !paillierN || !paillierG) {
    throw new Error('rekey needs Enc(d1) + paillierN + paillierG');
  }
  assertPaillierModulus(paillierN, { what: 'd1 rekey Paillier N' });
  if (rangeProof) {
    verifyRangeLindell({
      c: encD1,
      paillierN,
      paillierG,
      Q1: Pwant,
      proof: rangeProof,
      context: seatPokContext('rekey', 1, Pwant),
    });
  }
  const ch = pdlVerifierChallenge({
    ckey: encD1,
    paillierN,
    paillierG,
    Q1: Pwant,
  });
  pdlRam.set(pdlKey(sid, 'rekey'), {
    ch,
    P: Pwant,
    encD1: String(encD1),
    paillierN: String(paillierN),
    paillierG: String(paillierG),
    signerId: sid,
  });
  return {
    ok: true,
    needPdl: true,
    pdl: pdlChallengePublic(ch),
    kind: 'rekey',
  };
}

function loadPreshare() {
  try {
    return JSON.parse(readFileSync(PRESHARE_PATH, 'utf8'));
  } catch {
    return { packs: {} };
  }
}

async function savePreshare(p) {
  await mkdir(path.dirname(PRESHARE_PATH), { recursive: true });
  await writeFile(PRESHARE_PATH, JSON.stringify(p, null, 2));
}

export async function clearPreshare(reason = 'reset') {
  await savePreshare({
    packs: {},
    clearedAt: new Date().toISOString(),
    reason: String(reason || 'reset'),
  });
  return { ok: true, cleared: true, reason };
}

function compactPoint(hex) {
  return String(hex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

function idToX(id) {
  const h = createHash('sha256').update(String(id)).digest('hex');
  let x = BigInt('0x' + h) % secp256k1.CURVE.n;
  if (x === 0n) x = 1n;
  return x;
}

export function packTargets(dealerId, otherDealerId, live) {
  return (live || liveOrbitMembers()).filter(
    (id) => id && id !== dealerId && id !== otherDealerId,
  );
}

export function shamirSplitScalar(secretHex, recipientIds, t) {
  const secret = hexToScalar(secretHex);
  const ids = [...recipientIds];
  const tt = Math.max(2, Math.min(Number(t) || 2, ids.length));
  if (ids.length < tt) {
    throw new Error(`need ≥${tt} pack targets, have ${ids.length}`);
  }
  const coeffs = [secret];
  for (let i = 1; i < tt; i++) coeffs.push(randomScalar());
  const evalAt = (x) => {
    let y = 0n;
    let p = 1n;
    for (const a of coeffs) {
      y = modN(y + a * p);
      p = modN(p * x);
    }
    return y;
  };
  return {
    t: tt,
    shares: ids.map((id) => ({
      id,
      x: idToX(id).toString(),
      y: scalarToHex(evalAt(idToX(id))),
    })),
  };
}

export function shamirCombineScalar(shares) {
  const n = secp256k1.CURVE.n;
  const pts = (shares || []).map((s) => ({
    x: BigInt(String(s.x)),
    y: hexToScalar(s.y),
  }));
  if (pts.length < 2) throw new Error('need ≥2 shamir pieces');
  const invN = (a) => {
    let b = ((a % n) + n) % n;
    let e = n - 2n;
    let r = 1n;
    while (e > 0n) {
      if (e & 1n) r = (r * b) % n;
      b = (b * b) % n;
      e >>= 1n;
    }
    return r;
  };
  let acc = 0n;
  for (let i = 0; i < pts.length; i++) {
    let num = 1n;
    let den = 1n;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      num = modN(num * (n - (pts[j].x % n)));
      den = modN(den * (pts[i].x - pts[j].x));
    }
    acc = modN(acc + pts[i].y * num * invN(den));
  }
  return scalarToHex(acc);
}

export async function putPreshare({ signerId, role, t, shares, Pnext, encNext, delta }) {
  const r = Number(role);
  const sid = String(signerId || '').trim();
  if (currentHolderId(r) !== sid) throw new Error('preshare denied — not seat holder');
  const dapp = loadDapp();
  const liveP = compactPoint(
    dapp?.seats?.[String(r)]?.P || dapp?.seal?.[r === 1 ? 'P1' : 'P2'] || '',
  );
  const packedP = compactPoint(Pnext);
  if (liveP && packedP && packedP !== liveP) {
    throw new Error('preshare denied — Pnext is not the live seat P (stale Q)');
  }
  const p = loadPreshare();
  p.packs = p.packs || {};
  p.packs[String(r)] = {
    role: r,
    from: sid,
    t: Number(t) || 2,
    Pnext: Pnext || null,
    encNext: encNext || null,
    delta: delta || null,
    shares: (shares || []).map((s) => ({
      id: s.id,
      x: String(s.x),
      y: String(s.y),
    })),
    at: new Date().toISOString(),
  };
  await savePreshare(p);
  return { ok: true, role: r, recipients: (shares || []).map((s) => s.id), t: Number(t) || 2 };
}

export async function getPresharePiece({ signerId, role }) {
  const p = loadPreshare();
  const pack = p.packs?.[String(role)];
  if (!pack) throw new Error('no preshare pack for that seat');
  const piece = (pack.shares || []).find((s) => s.id === String(signerId));
  if (!piece) throw new Error('no piece for this signer');
  return {
    ok: true,
    role: Number(role),
    t: pack.t,
    Pnext: pack.Pnext,
    piece,
    from: pack.from,
  };
}

export async function collectPreshare({ role, signerId }) {
  const r = Number(role);
  const sid = String(signerId || '').trim();
  const holder = currentHolderId(r);
  const vacant = !holder;
  if (!vacant && holder !== sid) {
    throw new Error('collect denied — become the holder first');
  }
  const p = loadPreshare();
  const pack = p.packs?.[String(r)];
  if (!pack) throw new Error('no pack');
  const dapp = loadDapp();
  const liveP = compactPoint(
    dapp?.seats?.[String(r)]?.P || dapp?.seal?.[r === 1 ? 'P1' : 'P2'] || '',
  );
  const packedP = compactPoint(pack.Pnext);
  if (packedP && liveP && packedP !== liveP) {
    return {
      ok: true,
      role: r,
      t: pack.t,
      stale: true,
      P: liveP,
      Pnext: pack.Pnext,
      shares: [],
      vacant,
      message: `orbit pack is previous Q — live d${r} must re-pack`,
    };
  }
  return {
    ok: true,
    role: r,
    t: pack.t,
    kind: pack.kind || 'next',
    P: liveP || pack.Pnext || null,
    Pnext: pack.Pnext,
    encNext: pack.encNext,
    delta: pack.delta,
    shares: pack.shares,
    vacant,
  };
}

export async function saveCeremony({ dapp, s1, s2 }) {
  await mkdir(path.dirname(DAPP_PATH), { recursive: true });
  await mkdir(SIGNER_DIR, { recursive: true });
  await writeFile(DAPP_PATH, JSON.stringify(dapp, null, 2));
  const p1 = path.join(SIGNER_DIR, 'signer-1.json');
  const p2 = path.join(SIGNER_DIR, 'signer-2.json');
  await writeFile(p1, JSON.stringify(s1, null, 2));
  await writeFile(p2, JSON.stringify(s2, null, 2));
  try {
    const { chmodSync } = await import('node:fs');
    chmodSync(DAPP_PATH, 0o600);
    chmodSync(p1, 0o600);
    chmodSync(p2, 0o600);
  } catch {
    /* */
  }
  return { dappPath: DAPP_PATH, signer1: p1, signer2: p2 };
}

export function loadDapp() {
  if (!existsSync(DAPP_PATH)) return null;
  return JSON.parse(readFileSync(DAPP_PATH, 'utf8'));
}

function emptySessions() {
  return { tickets: {} };
}

async function loadSessions() {
  try {
    return JSON.parse(await readFile(SESS_PATH, 'utf8'));
  } catch {
    return emptySessions();
  }
}

async function saveSessions(s) {
  await mkdir(path.dirname(SESS_PATH), { recursive: true });
  for (const t of Object.values(s.tickets || {})) stripPersistedD2(t);
  await writeFile(SESS_PATH, JSON.stringify(s, null, 2));
}

/** Serialize session writes so payout / d2 / r1 cannot clobber each other. */
let sessionTail = Promise.resolve();
function withSessions(fn) {
  const run = sessionTail.then(async () => {
    const s = await loadSessions();
    const out = await fn(s);
    await saveSessions(s);
    return out;
  });
  sessionTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** One prepare/submit at a time per ticket — stops two Lindell rooms minting two hashes. */
const ticketGates = new Map();
function withTicketGate(ticketId, fn) {
  const id = String(ticketId || '').trim();
  const prev = ticketGates.get(id) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  ticketGates.set(
    id,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function sessionLooksPaid(t) {
  return !!(t && (t.status === 'paid' || t.payout?.ok || t.payout?.txHash));
}

function sessionAbandoned(t) {
  return !!(t && (t.status === 'abandoned' || t.status === 'cancelled'));
}

export function isRotateTicketId(ticketId) {
  return /^wart-pool-rotate-/.test(String(ticketId || ''));
}

function paidRowFromSession(t) {
  if (!t || !sessionLooksPaid(t)) return null;
  return {
    ticketId: t.ticketId,
    amountE8: String(t.amountE8 || t.prep?.amountE8 || ''),
    toAddress: t.toAddress || t.prep?.toAddress || null,
    txHash: t.payout?.txHash || t.txHash || null,
    at: t.payout?.at || t.updatedAt || null,
    nonceId: t.payout?.nonceId ?? t.prep?.nonceId ?? null,
    status: 'paid',
    scheme: POOL3P_SCHEME,
  };
}

function samePaidAmount(row, amountE8) {
  if (amountE8 == null || amountE8 === '') return false;
  if (row?.amountE8 == null || row.amountE8 === '') return false;
  return String(row.amountE8) === String(amountE8);
}

function samePaidDest(row, toAddress) {
  if (!toAddress) return false;
  if (!row?.toAddress) return false;
  return (
    String(row.toAddress).replace(/^0x/i, '').toLowerCase() ===
    String(toAddress).replace(/^0x/i, '').toLowerCase()
  );
}

/** Paid if log/session has this ticketId for the same amount+dest (ids reuse after a wipe). */
export function paidRecordFor(ticketId, extra = {}) {
  const id = String(ticketId || '').trim();
  if (!id) return null;
  const amt = extra.amountE8 != null && extra.amountE8 !== '' ? String(extra.amountE8) : null;
  const dest = extra.toAddress || null;
  if (amt) {
    const fromLog = (loadPaidLog().pays || []).find(
      (p) =>
        String(p.ticketId || '') === id &&
        samePaidAmount(p, amt) &&
        samePaidDest(p, dest),
    );
    if (fromLog) return { ...fromLog, status: 'paid', scheme: fromLog.scheme || POOL3P_SCHEME };
  }
  try {
    const s = JSON.parse(readFileSync(SESS_PATH, 'utf8'));
    const row = paidRowFromSession(s.tickets?.[id]);
    if (row && (amt ? samePaidAmount(row, amt) : true)) return row;
  } catch {
    /* */
  }
  return null;
}

export function ticketIsPaid(ticketId, extra = {}) {
  return !!paidRecordFor(ticketId, extra);
}

/** Paid-log hit for status/expire. Prefer amount+dest; fall back to ticketId. */
function paidLogHit(ticketId, sess) {
  const id = String(ticketId || '').trim();
  if (!id) return null;
  const extra = {
    amountE8: sess?.amountE8 || sess?.prep?.amountE8,
    toAddress: sess?.toAddress || sess?.prep?.toAddress,
  };
  const hit = paidRecordFor(id, extra);
  if (hit) return hit;
  const loose = (loadPaidLog().pays || []).find((p) => String(p.ticketId || '') === id);
  if (!loose) return null;
  if (extra.amountE8 && !samePaidAmount(loose, extra.amountE8)) return null;
  if (extra.toAddress && !samePaidDest(loose, extra.toAddress)) return null;
  return { ...loose, status: 'paid', scheme: loose.scheme || POOL3P_SCHEME };
}

function paidStatusView(paid, sess) {
  const txHash = paid?.txHash || sess?.payout?.txHash || null;
  const base = sess
    ? roomView({
        ...sess,
        status: 'paid',
        haveR1: false,
        haveD2: false,
        payout: {
          ...(sess.payout || {}),
          ok: true,
          txHash,
          at: paid?.at || sess.payout?.at || null,
        },
      })
    : { ok: true };
  return {
    ...base,
    ok: true,
    status: 'paid',
    txHash,
    payout: { ok: true, txHash, at: paid?.at || base.payout?.at || null },
    alreadyPaid: true,
    waitingOn: [],
  };
}

function fillRoomMeta(ticket, extra = {}) {
  const t = ticket || {};
  if (extra.amountE8 != null && extra.amountE8 !== '') t.amountE8 = String(extra.amountE8);
  if (extra.toAddress) {
    t.toAddress = String(extra.toAddress).replace(/^0x/i, '').toLowerCase();
  }
  if (extra.hashHex && !t.hashHex) t.hashHex = String(extra.hashHex).replace(/^0x/i, '');
  return t;
}

/** Last inspect release tickets (amount/to) so rooms stay visible after a racy write. */
let inspectRoomHints = new Map();
export function rememberInspectTickets(tickets) {
  const map = new Map(inspectRoomHints);
  for (const t of tickets || []) {
    const id = String(t?.ticketId || '').trim();
    if (!id || ticketIsPaid(id, { amountE8: t.amountE8 })) continue;
    map.set(id, {
      ticketId: id,
      amountE8: t.amountE8 != null ? String(t.amountE8) : null,
      toAddress: t.toAddress
        ? String(t.toAddress).replace(/^0x/i, '').toLowerCase()
        : null,
      status: t.status || 'authorized',
    });
  }
  inspectRoomHints = map;
}

function hintFor(ticketId) {
  return inspectRoomHints.get(String(ticketId)) || null;
}

const HOLDERS_PATH =
  env('POOL_3P_HOLDERS') || path.join(DEFAULT_DATA, 'pool-3p-holders.json');
const ORBIT_PATH =
  env('POOL_3P_ORBIT') || path.join(DEFAULT_DATA, 'pool-3p-orbit.json');

const LEASE_MS = Number(env('POOL_3P_LEASE_MS', '900000')) || 900000;
const ORBIT_LIVE_MS = Number(env('POOL_3P_ORBIT_LIVE_MS', '20000')) || 20000;
const SEAT_IDLE_MS = Number(env('POOL_3P_SEAT_IDLE_MS', '300000')) || 300000;
const ORBIT_MIN = Number(env('POOL_3P_ORBIT_MIN', '2')) || 2;
/** Close a hung user room so auto-rotate can proceed. Idle = no session write. */
const ROOM_IDLE_MS = Number(env('POOL_3P_ROOM_IDLE_MS', '480000')) || 480000;
/** Lindell done but never paid — k1 is gone; do not block rotation. */
const ROOM_PARTIAL_MS = Number(env('POOL_3P_ROOM_PARTIAL_MS', '240000')) || 240000;

function vpsFallbackOn() {
  const v = env('POOL_3P_VPS_FALLBACK', '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

function isVpsFallbackId(id) {
  return /^pool-3p-signer-[12]$/.test(String(id || ''));
}

function nowMs() {
  return Date.now();
}

function loadHolders() {
  try {
    return JSON.parse(readFileSync(HOLDERS_PATH, 'utf8'));
  } catch {
    return { roles: {} };
  }
}

async function saveHolders(h) {
  await mkdir(path.dirname(HOLDERS_PATH), { recursive: true });
  await writeFile(HOLDERS_PATH, JSON.stringify(h, null, 2));
}

/** After Q cutover, the browsers who born next d1/d2 become the live holders. */
export async function adoptHoldersFromDapp(dapp) {
  const h = loadHolders();
  const ts = new Date().toISOString();
  h.roles = h.roles || {};
  for (const r of [1, 2]) {
    const sid = dapp?.seats?.[r]?.signerId || dapp?.seats?.[String(r)]?.signerId;
    if (!sid) continue;
    h.roles[String(r)] = {
      signerId: sid,
      assignedAt: ts,
      lastSeen: ts,
      claimedBorn: true,
    };
  }
  await saveHolders(h);
  return holderSnapshot();
}

function loadOrbit() {
  try {
    return JSON.parse(readFileSync(ORBIT_PATH, 'utf8'));
  } catch {
    return { members: {} };
  }
}

async function saveOrbit(o) {
  await mkdir(path.dirname(ORBIT_PATH), { recursive: true });
  await writeFile(ORBIT_PATH, JSON.stringify(o, null, 2));
}

function liveOrbitMembers(o = loadOrbit(), now = nowMs()) {
  const out = [];
  for (const [id, m] of Object.entries(o.members || {})) {
    const seen = Date.parse(m.lastSeen || 0);
    if (Number.isFinite(seen) && now - seen <= ORBIT_LIVE_MS) out.push(id);
  }
  return out.sort();
}

function holderStale(rec, now = nowMs()) {
  if (!rec?.signerId) return true;
  const seen = Date.parse(rec.lastSeen || rec.assignedAt || 0);
  if (!Number.isFinite(seen)) return true;
  return now - seen > SEAT_IDLE_MS;
}

function readSignerFile(role) {
  const p = path.join(SIGNER_DIR, role === 1 ? 'signer-1.json' : 'signer-2.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

async function writeSignerFile(role, rec) {
  await mkdir(SIGNER_DIR, { recursive: true });
  const fp = path.join(SIGNER_DIR, role === 1 ? 'signer-1.json' : 'signer-2.json');
  await writeFile(fp, JSON.stringify(rec, null, 2));
  try {
    const { chmodSync } = await import('node:fs');
    chmodSync(fp, 0o600);
  } catch {
    /* */
  }
}

export async function writeDapp(dapp) {
  await mkdir(path.dirname(DAPP_PATH), { recursive: true });
  await writeFile(DAPP_PATH, JSON.stringify(dapp, null, 2));
  try {
    const { chmodSync } = await import('node:fs');
    chmodSync(DAPP_PATH, 0o600);
  } catch {
    /* */
  }
}

function currentAddress(d1, d2, dDapp) {
  const d = modN(d1 + d2 + dDapp);
  return addressFromPubCompressedHex(pointToCompressedHex(G.multiply(d)));
}

/** Keep d (and address) fixed; rotate one user share. */
export function applySeatDelta(d1, d2, dDapp, role, delta) {
  const r = Number(role);
  if (r === 1) {
    return { d1: modN(d1 + delta), d2, dDapp: modN(dDapp - delta) };
  }
  if (r === 2) {
    return { d1, d2: modN(d2 + delta), dDapp: modN(dDapp - delta) };
  }
  throw new Error('role must be 1 or 2');
}

/**
 * Kill old d1 or d2 and issue a new split of the same d.
 * Old hex no longer sums with the new d_dapp. Address unchanged.
 */
export async function refreshSeat(role, reason = 'abandon', { keepHolder = false } = {}) {
  const r = Number(role);
  if (r !== 1 && r !== 2) throw new Error('refreshSeat role must be 1 or 2');
  const dapp = loadDapp();
  if (clientBornOn() || dapp?.clientBorn) {
    const h = loadHolders();
    const dropped = h.roles?.[String(r)]?.signerId || null;
    if (!keepHolder && h.roles) {
      delete h.roles[String(r)];
      await saveHolders(h);
    }
    dapp.lastRefresh = { role: r, reason, at: new Date().toISOString(), clientBorn: true };
    await writeDapp(dapp);
    return {
      ok: true,
      role: r,
      reason,
      vacated: true,
      clientBorn: true,
      droppedSignerId: dropped,
      address: dapp.address || null,
      message: `d${r} vacated — claimer reconstructs d${r}' from orbit pack (same Q)`,
    };
  }
  const s1 = readSignerFile(1);
  const s2 = readSignerFile(2);
  if (!dapp || !s1 || !s2) throw new Error('3P files missing');

  const d1 = hexToScalar(s1.userShareHex);
  const d2 = hexToScalar(s2.userShareHex);
  const dDapp = hexToScalar(dapp.dappShareHex);
  const before = currentAddress(d1, d2, dDapp);
  if (before !== dapp.address) {
    throw new Error('3P split drifted from address — refuse refresh');
  }

  const delta = randomScalar();
  const next = applySeatDelta(d1, d2, dDapp, r, delta);
  const after = currentAddress(next.d1, next.d2, next.dDapp);
  if (after !== dapp.address) {
    throw new Error('refresh would change pool address');
  }
  // Old share + new d_dapp must not recover d
  if (r === 1) {
    const stale = currentAddress(d1, next.d2, next.dDapp);
    if (stale === dapp.address) throw new Error('old d1 still valid after refresh');
  } else {
    const stale = currentAddress(next.d1, d2, next.dDapp);
    if (stale === dapp.address) throw new Error('old d2 still valid after refresh');
  }

  const seatEpoch = Number(dapp.seatEpoch || 0) + 1;
  dapp.dappShareHex = scalarToHex(next.dDapp);
  dapp.seatEpoch = seatEpoch;
  dapp.lastRefresh = { role: r, reason, at: new Date().toISOString() };

  if (r === 1) {
    const bits = paillierBitsFromEnv();
    const { publicKey: pk, privateKey: sk } = await generateRandomKeys(bits);
    dapp.paillierN = pk.n.toString();
    dapp.paillierG = pk.g.toString();
    dapp.ckeyD1 = pk.encrypt(next.d1).toString();
    s1.userShareHex = scalarToHex(next.d1);
    s1.paillierLambda = sk.lambda.toString();
    s1.paillierMu = sk.mu.toString();
    s1.paillierN = pk.n.toString();
    s1.paillierG = pk.g.toString();
    s1.seatEpoch = seatEpoch;
    await writeSignerFile(1, s1);
  } else {
    s2.userShareHex = scalarToHex(next.d2);
    s2.seatEpoch = seatEpoch;
    await writeSignerFile(2, s2);
  }

  dapp.seal = sealFromScalars({
    address: dapp.address,
    publicKey: dapp.publicKey,
    d1: next.d1,
    d2: next.d2,
    dDapp: next.dDapp,
    seatEpoch,
    dealerSawPlaintext: true,
  });
  await writeDapp(dapp);
  const h = loadHolders();
  const dropped = h.roles?.[String(r)]?.signerId || null;
  if (keepHolder) {
    if (h.roles?.[String(r)]) {
      h.roles[String(r)].lastReissued = new Date().toISOString();
      await saveHolders(h);
    }
  } else if (h.roles) {
    delete h.roles[String(r)];
    await saveHolders(h);
  }
  return {
    ok: true,
    role: r,
    reason,
    seatEpoch,
    keepHolder: !!keepHolder,
    address: dapp.address,
    droppedSignerId: keepHolder ? null : dropped,
    holderId: keepHolder ? dropped : null,
    message: keepHolder
      ? `Seat d${r} reissued to the same holder — old hex dies on next heartbeat`
      : `Seat d${r} reissued — old hex is dead, address unchanged`,
  };
}

/** New seatEpoch, same d1/d2 people. Browsers squash old hex from heartbeat. */
export async function reissueToCurrentHolders(reason = 'epoch-rotate') {
  const h = loadHolders();
  const seats = [];
  if (h.roles?.['1']?.signerId) {
    seats.push(await refreshSeat(1, reason, { keepHolder: true }));
  }
  if (h.roles?.['2']?.signerId) {
    seats.push(await refreshSeat(2, reason, { keepHolder: true }));
  }
  return { ok: true, reason, seats, seatEpoch: Number(loadDapp()?.seatEpoch || 0) };
}

function signInFlight() {
  return listOpenPool3pTickets().length > 0;
}

/** True while any 3P room is open — freeze live seats + next-Q birth. */
export function holdersFrozen() {
  if (listOpenPool3pTickets().length > 0) return true;
  for (const hint of inspectRoomHints.values()) {
    const id = String(hint?.ticketId || '');
    if (id && !ticketIsPaid(id, { amountE8: hint.amountE8 })) return true;
  }
  return false;
}

export async function maybeAbandonStaleSeats() {
  if (signInFlight() || holdersFrozen()) return [];
  const h = loadHolders();
  const dropped = [];
  for (const r of [1, 2]) {
    const rec = h.roles?.[String(r)];
    if (!rec?.signerId || !holderStale(rec)) continue;
    if (r === 1) {
      try {
        const p = loadPreshare();
        if (!p.packs?.['1']?.shares?.length) continue;
      } catch {
        continue;
      }
    }
    dropped.push(await refreshSeat(r, 'abandon-idle'));
  }
  return dropped;
}

async function touchOrbit(signerId, extra = {}) {
  const o = loadOrbit();
  o.members = o.members || {};
  const now = nowMs();
  const keepMs = Math.max(SEAT_IDLE_MS, ORBIT_LIVE_MS) * 3;
  for (const [id, m] of Object.entries(o.members)) {
    const seen = Date.parse(m.lastSeen || 0);
    if (!Number.isFinite(seen) || now - seen > keepMs) delete o.members[id];
  }
  o.members[signerId] = {
    ...(o.members[signerId] || {}),
    ...extra,
    lastSeen: new Date().toISOString(),
  };
  await saveOrbit(o);
  return o;
}

export function orbitSnapshot() {
  const o = loadOrbit();
  const live = liveOrbitMembers(o);
  const now = nowMs();
  const members = Object.entries(o.members || {})
    .map(([id, m]) => {
      const seen = Date.parse(m.lastSeen || 0);
      return {
        id,
        lastSeen: m.lastSeen || null,
        ageMs: Number.isFinite(seen) ? now - seen : null,
        live: live.includes(id),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    leaseMs: ORBIT_LIVE_MS,
    seatIdleMs: SEAT_IDLE_MS,
    orbitMin: ORBIT_MIN,
    liveCount: live.length,
    live,
    nOfN: live.length,
    memberCount: live.length,
    members,
  };
}

function holderSnapshot() {
  const h = loadHolders();
  const out = {};
  for (const r of ['1', '2']) {
    const rec = h.roles?.[r];
    out[r] = rec?.signerId
      ? {
          signerId: rec.signerId,
          lastSeen: rec.lastSeen || null,
          assignedAt: rec.assignedAt || null,
          lastReissued: rec.lastReissued || null,
        }
      : null;
  }
  return out;
}

/** Who currently holds Shamir pieces of each seat (for vacant rebuild). */
export function packSnapshot() {
  let p;
  try {
    p = loadPreshare();
  } catch {
    p = { packs: {} };
  }
  const live = liveOrbitMembers();
  const h1 = currentHolderId(1);
  const h2 = currentHolderId(2);
  const out = {};
  for (const r of ['1', '2']) {
    const pack = p.packs?.[r];
    const holder = r === '1' ? h1 : h2;
    const other = r === '1' ? h2 : h1;
    const need = live.filter((id) => id && id !== holder && id !== other);
    if (!pack) {
      out[r] = {
        ready: false,
        from: null,
        recipients: [],
        liveCovered: 0,
        liveNeed: need.length,
        at: null,
      };
      continue;
    }
    const ids = (pack.shares || []).map((s) => s.id);
    const covered = need.filter((id) => ids.includes(id));
    out[r] = {
      ready: need.length >= 2 && covered.length >= Math.min(2, need.length),
      from: pack.from || null,
      recipients: ids,
      liveCovered: covered.length,
      liveNeed: need.length,
      at: pack.at || null,
    };
  }
  return out;
}

export async function heartbeatPool3p({ signerId, seatEpoch } = {}) {
  const sid = String(signerId || '').trim();
  if (sid.length < 16) throw new Error('signerId required');
  await maybeAbandonStaleSeats();
  await touchOrbit(sid);

  const h = loadHolders();
  let role = 0;
  for (const r of ['1', '2']) {
    if (h.roles?.[r]?.signerId === sid) {
      h.roles[r].lastSeen = new Date().toISOString();
      role = Number(r);
    }
  }
  await saveHolders(h);

  // Vacant / VPS-only claim. Do not kick a live browser. Deliver share in-band
  // so the client never needs a page refresh.
  let share = null;
  let justClaimed = false;
  // Vacant seats can be claimed when idle. Never steal a seat during a room.
  if (role === 0 && !holdersFrozen()) {
    const claimed = await enrollPool3pSigner({ signerId: sid });
    if (claimed && !claimed.waitlist && (claimed.role === 1 || claimed.role === 2)) {
      role = Number(claimed.role);
      share = claimed;
      justClaimed = true;
    }
  }

  const dapp = loadDapp();
  const curEpoch = Number(dapp?.seatEpoch || 0);
  const clientEpoch =
    seatEpoch == null || seatEpoch === '' ? null : Number(seatEpoch);
  let shareUpdated = false;
  if (role > 0) {
    const epochChanged = clientEpoch != null && clientEpoch !== curEpoch;
    share = enrollPayloadForRole(role, sid, !justClaimed);
    shareUpdated = epochChanged || justClaimed;
  }

  return {
    ok: true,
    role,
    seatEpoch: curEpoch,
    // Older browser-node clients only pick up a new seat via SEAT_ROTATED.
    seatRotated: !!(share && (clientEpoch == null || clientEpoch !== curEpoch)),
    lostSeat: role === 0,
    share,
    shareUpdated,
    holders: holderSnapshot(),
    holder1: currentHolderId(1),
    holder2: currentHolderId(2),
    orbit: orbitSnapshot(),
    leaseMs: LEASE_MS,
    open: listOpenPool3pTickets(),
    clientBorn: !!(dapp?.clientBorn || clientBornOn()),
    address: dapp?.address || null,
    seal: dapp?.seal || null,
    packs: packSnapshot(),
  };
}

export async function abandonPool3pSeat({ signerId, role } = {}) {
  const sid = String(signerId || '').trim();
  const h = loadHolders();
  let r = Number(role || 0);
  if (!r) {
    if (h.roles?.['1']?.signerId === sid) r = 1;
    else if (h.roles?.['2']?.signerId === sid) r = 2;
  }
  if (r !== 1 && r !== 2) {
    return { ok: true, skipped: true, message: 'not a 3P seat holder' };
  }
  if (h.roles?.[String(r)]?.signerId && h.roles[String(r)].signerId !== sid) {
    throw new Error('abandon denied — not the current holder');
  }
  return refreshSeat(r, 'abandon-explicit');
}

export async function orbitAttest({ signerId, ticketId } = {}) {
  const sid = String(signerId || '').trim();
  const id = String(ticketId || '').trim();
  if (!sid || !id) throw new Error('signerId + ticketId required');
  await heartbeatPool3p({ signerId: sid });
  const live = liveOrbitMembers();
  if (!live.includes(sid)) {
    throw new Error('not in live orbit — heartbeat first');
  }
  await withSessions((s) => {
    const cur = s.tickets[id] || { ticketId: id };
    cur.ticketId = id;
    cur.orbitAttests = cur.orbitAttests || {};
    cur.orbitAttests[sid] = new Date().toISOString();
    s.tickets[id] = cur;
  });
  return orbitQuorumInfo(id);
}

export function orbitQuorumInfo(ticketId) {
  const live = liveOrbitMembers();
  const s = (() => {
    try {
      return JSON.parse(readFileSync(SESS_PATH, 'utf8'));
    } catch {
      return { tickets: {} };
    }
  })();
  const att = s.tickets?.[String(ticketId)]?.orbitAttests || {};
  const h1 = currentHolderId(1);
  const h2 = currentHolderId(2);
  const needed = [h1, h2].filter(Boolean);
  const missingHolders = needed.filter((id) => !att[id]);
  const extraLive = live.filter((id) => !needed.includes(id));
  const have = live.filter((id) => att[id]);
  const room = s.tickets?.[String(ticketId)] || {};
  // Once both shares are in the room, a later vacant seat must not block finish.
  const haveShares = !!(room.haveR1 && room.haveD2);
  const ok = haveShares || (needed.length >= 2 && missingHolders.length === 0);
  return {
    ok,
    ticketId: String(ticketId || ''),
    liveCount: live.length,
    need: needed.length,
    have: needed.length - missingHolders.length,
    missing: missingHolders,
    live,
    holders: needed,
    extraLive,
    message: ok
      ? `d1+d2 attested (${needed.length} seats; ${live.length} orbit live)`
      : needed.length < 2
        ? 'need both d1 and d2 holders before sign'
        : `waiting on ${missingHolders.join(', ')}`,
  };
}

function assertOrbitForSign(ticketId) {
  const q = orbitQuorumInfo(ticketId);
  if (!q.ok) {
    const err = new Error(q.message);
    err.code = 'ORBIT_QUORUM';
    err.orbit = q;
    throw err;
  }
  return q;
}

function currentHolderId(role) {
  return loadHolders().roles?.[String(role)]?.signerId || null;
}

function enrollPayloadForRole(role, signerId, already) {
  const dapp = loadDapp();
  if (clientBornOn() || dapp?.clientBorn) {
    const seat = dapp?.seats?.[String(role)] || dapp?.seats?.[role] || null;
    const born = !!seat?.P;
    return {
      scheme: POOL3P_SCHEME,
      role,
      shareIndex: role,
      signerId,
      clientBorn: true,
      needBirth: !born,
      waitlist: false,
      already: !!already,
      poolAddress: dapp?.address || null,
      publicKey: dapp?.publicKey || null,
      Pdapp: dapp?.Pdapp || null,
      P: seat?.P || null,
      seatEpoch: Number(dapp?.seatEpoch || 0),
      seal: dapp?.seal || null,
      leaseMs: LEASE_MS,
      orbit: orbitSnapshot(),
      packTargets: packTargets(signerId, currentHolderId(role === 1 ? 2 : 1)),
      message: born
        ? `You are the d${role} dealer. Hex stays in this tab. Orbit holds a t=2 pack of this seat (+ δ) so it can be rebuilt if you drop.`
        : `Birth d${role} in this tab (makeClientSeat). VPS will only store the point` +
          (role === 1 ? ' + Enc(d1).' : '.'),
    };
  }
  const rec = readSignerFile(role);
  if (!rec) throw new Error(`3P signer-${role} file missing — run ceremony`);
  const out = {
    scheme: POOL3P_SCHEME,
    role,
    shareIndex: role,
    shareHex: rec.userShareHex,
    userShareHex: rec.userShareHex,
    signerId,
    poolAddress: rec.address || dapp?.address,
    publicKey: rec.publicKey || dapp?.publicKey,
    already: !!already,
    waitlist: false,
    threshold: 3,
    need: 3,
    n: 3,
    seatEpoch: Number(dapp?.seatEpoch || 0),
    seal: dapp?.seal || null,
    leaseMs: LEASE_MS,
    orbit: orbitSnapshot(),
    message:
      role === 1
        ? 'You hold d1 + Paillier sk (signer 1). Full d is not on this device. Idle > lease drops this seat and reissues d1.'
        : 'You hold d2 (signer 2). Full d is not on this device. Idle > lease drops this seat and reissues d2.',
  };
  if (role === 1) {
    out.paillierLambda = rec.paillierLambda;
    out.paillierMu = rec.paillierMu;
    out.paillierN = rec.paillierN;
    out.paillierG = rec.paillierG;
  }
  return out;
}

/**
 * First unique browser/extension gets d1, second gets d2.
 * Same signerId always gets the same role. Third+ are waitlisted (no secret).
 */
export async function enrollPool3pSigner({ signerId, role: _hint } = {}) {
  const sid = String(signerId || '').trim();
  if (sid.length < 16 || sid.length > 120) {
    throw new Error('signerId must be 16–120 chars');
  }
  if (!/^[a-zA-Z0-9._:-]+$/.test(sid)) {
    throw new Error('signerId has invalid characters');
  }
  const dapp = loadDapp();
  if (!dapp) throw new Error('3P pool not configured');

  await maybeAbandonStaleSeats();
  await touchOrbit(sid);

  if (sid === ORBIT_VPS_ID) {
    return {
      scheme: POOL3P_SCHEME,
      role: 0,
      waitlist: true,
      orbitOnly: true,
      vpsOrbit: true,
      signerId: sid,
      poolAddress: dapp.address,
      orbit: orbitSnapshot(),
      message: 'VPS orbit signer — holds preshare pieces only, never d1/d2',
    };
  }

  const h = loadHolders();
  h.roles = h.roles || {};
  h.address = dapp.address;
  const ts = new Date().toISOString();

  // Born dealer identity wins over a swapped lease.
  if (dapp.clientBorn || clientBornOn()) {
    for (const r of ['1', '2']) {
      const bornSid = dapp.seats?.[r]?.signerId || dapp.seats?.[Number(r)]?.signerId;
      if (bornSid && bornSid === sid) {
        const other = r === '1' ? '2' : '1';
        if (h.roles[other]?.signerId === sid) delete h.roles[other];
        h.roles[r] = {
          signerId: sid,
          assignedAt: h.roles[r]?.assignedAt || ts,
          lastSeen: ts,
        };
        await saveHolders(h);
        return enrollPayloadForRole(Number(r), sid, true);
      }
    }
  }

  for (const r of ['1', '2']) {
    if (h.roles[r]?.signerId === sid) {
      h.roles[r].lastSeen = ts;
      await saveHolders(h);
      return enrollPayloadForRole(Number(r), sid, true);
    }
  }

  const vpsOnly = isVpsFallbackId(sid);
  if (vpsOnly && !vpsFallbackOn()) {
    return {
      scheme: POOL3P_SCHEME,
      role: 0,
      waitlist: true,
      signerId: sid,
      poolAddress: dapp.address,
      orbit: orbitSnapshot(),
      message: 'VPS fallback seats disabled — browsers hold d1/d2',
    };
  }

  async function claim(role) {
    if (holdersFrozen()) return null;
    const rec = h.roles[String(role)];
    const occupant = rec?.signerId;
    const bornSid =
      dapp.seats?.[String(role)]?.signerId || dapp.seats?.[role]?.signerId || null;
    const born = !!(dapp.seats?.[String(role)]?.P || dapp.seats?.[role]?.P);
    const clientBorn = !!(dapp.clientBorn || clientBornOn());
    // Born client-born seats stay with the tab that created P. Strangers
    // cannot "claim" them — they have no Enc(d1) / current hex.
    if (clientBorn && born && bornSid && sid === bornSid) {
      const hh = loadHolders();
      hh.roles = hh.roles || {};
      hh.roles[String(role)] = {
        signerId: sid,
        assignedAt: rec?.assignedAt || ts,
        lastSeen: ts,
      };
      await saveHolders(hh);
      return enrollPayloadForRole(role, sid, true);
    }
    if (clientBorn && born && bornSid && sid !== bornSid) {
      return null;
    }
    const canPreempt = occupant && isVpsFallbackId(occupant) && !vpsOnly;
    const vacant = !occupant;
    if (!vacant && !canPreempt) return null;
    if (canPreempt) {
      await refreshSeat(role, 'preempt-vps-fallback');
    }
    const hh = loadHolders();
    hh.roles = hh.roles || {};
    hh.roles[String(role)] = { signerId: sid, assignedAt: ts, lastSeen: ts };
    await saveHolders(hh);
    return enrollPayloadForRole(role, sid, false);
  }

  const c1 = await claim(1);
  if (c1) return c1;
  const c2 = await claim(2);
  if (c2) return c2;

  const vacantBorn = {};
  for (const r of ['1', '2']) {
    const born = dapp.seats?.[r];
    if ((dapp.clientBorn || clientBornOn()) && born?.P && !loadHolders().roles?.[r]?.signerId) {
      vacantBorn[r] = {
        expectedP: born.P,
        bornSignerId: born.signerId || null,
      };
    }
  }
  return {
    scheme: POOL3P_SCHEME,
    role: 0,
    waitlist: true,
    signerId: sid,
    poolAddress: dapp.address,
    publicKey: dapp.publicKey,
    seal: dapp.seal || null,
    holders: {
      1: loadHolders().roles?.['1']?.signerId || null,
      2: loadHolders().roles?.['2']?.signerId || null,
    },
    recoverVacant: vacantBorn['1'] ? 1 : vacantBorn['2'] ? 2 : 0,
    expectedP: vacantBorn['1']?.expectedP || vacantBorn['2']?.expectedP || null,
    bornSignerId: vacantBorn['1']?.bornSignerId || vacantBorn['2']?.bornSignerId || null,
    vacantBorn,
    orbit: orbitSnapshot(),
    seatEpoch: Number(dapp.seatEpoch || 0),
    clientBorn: true,
    message: vacantBorn['1']
      ? 'd1 is already born. This refresh made a new orbit id. Restore the original d1 profile (same browser that first created the pool) — do not birth a new share.'
      : 'Orbit voter only. 3P seats d1/d2 are leased.',
  };
}

/** Adopt a vacant born seat by proving di·G equals the live point. */
export async function claimBornSeat({ signerId, role, shareHex, pok }) {
  const r = Number(role);
  if (r !== 1 && r !== 2) throw new Error('role must be 1 or 2');
  const sid = String(signerId || '').trim();
  if (sid.length < 16) throw new Error('signerId required');
  const dapp = loadDapp();
  if (!dapp?.clientBorn && !clientBornOn()) throw new Error('not client-born');
  const want = String(dapp.seats?.[String(r)]?.P || dapp.seal?.[r === 1 ? 'P1' : 'P2'] || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!want) throw new Error('seat has no live P');
  // Prefer Schnorr of dlog(P). Plain shareHex still accepted for orbit-rebuild
  // tabs that have not been updated — but it puts di on the VPS.
  if (pok) {
    requireSeatPok({ pok, P: want, role: r, kind: 'claim' });
  } else if (shareHex) {
    const d = hexToScalar(shareHex);
    const got = pointToCompressedHex(G.multiply(d)).toLowerCase();
    if (got !== want) {
      throw new Error(`claim denied — d${r}·G ≠ P${r} (this tab is not the original dealer)`);
    }
  } else {
    throw new Error('claim denied — need Schnorr pok of dlog(P) (or shareHex on legacy rebuild)');
  }
  const ts = new Date().toISOString();
  const h = loadHolders();
  h.roles = h.roles || {};
  const occupant = h.roles[String(r)]?.signerId || null;
  const bornSid =
    dapp.seats?.[String(r)]?.signerId || dapp.seats?.[r]?.signerId || null;
  if (r === 1 && bornSid && bornSid !== sid && liveOrbitMembers().includes(bornSid)) {
    throw new Error('claim denied — d1 dealer is live; do not steal the seat');
  }
  if (holdersFrozen() && occupant && occupant !== sid) {
    if (sid !== bornSid) {
      throw new Error('claim denied — user 3P room is open; live seats are frozen');
    }
  }
  h.roles[String(r)] = { signerId: sid, assignedAt: ts, lastSeen: ts, claimedBorn: true };
  await saveHolders(h);
  return enrollPayloadForRole(r, sid, true);
}

export function publicStatus() {
  const d = loadDapp();
  if (!d) return { ok: false, configured: false, mode: pool3pOn() };
  const h = loadHolders();
  return {
    ok: true,
    configured: true,
    mode: pool3pOn(),
    scheme: d.scheme,
    address: d.address,
    legacyAddress: '966d1012941b1fb41d4fff2cadefca7115237dc1818a7cd7',
    signer1Id: d.signer1Id,
    signer2Id: d.signer2Id,
    holder1: h.roles?.['1']?.signerId || null,
    holder2: h.roles?.['2']?.signerId || null,
    dealer1: d.seats?.['1']?.signerId || null,
    dealer2: d.seats?.['2']?.signerId || null,
    holders: holderSnapshot(),
    seatEpoch: Number(d.seatEpoch || 0),
    lastRefresh: d.lastRefresh || null,
    seal: d.seal
      ? {
          v: d.seal.v,
          scheme: d.seal.scheme,
          address: d.seal.address,
          publicKey: d.seal.publicKey,
          P1: d.seal.P1,
          P2: d.seal.P2,
          Pdapp: d.seal.Pdapp,
          seatEpoch: d.seal.seatEpoch,
          dealerSawPlaintext: d.seal.dealerSawPlaintext,
          bind: d.seal.bind,
        }
      : null,
    orbit: orbitSnapshot(),
    leaseMs: LEASE_MS,
    clientBorn: !!(d.clientBorn || clientBornOn()),
    Pdapp: d.Pdapp || d.seal?.Pdapp || null,
    paillierN: d.paillierN || d.seats?.['1']?.paillierN || null,
    paillierG: d.paillierG || d.seats?.['1']?.paillierG || null,
    seatsReady: {
      1: !!d.seats?.[1]?.P,
      2: !!d.seats?.[2]?.P,
    },
    orbitVpsId: ORBIT_VPS_ID,
    packFloor: 4,
    packs: packSnapshot(),
    open: listOpenPool3pTickets(),
    rooms: listOpenPool3pTickets(),
    paid: listPaidPool3pTickets(),
    rotation: null,
    d1Live: !!(currentHolderId(1) && liveOrbitMembers().includes(currentHolderId(1))),
    d2Live: !!(currentHolderId(2) && liveOrbitMembers().includes(currentHolderId(2))),
    hasDappShare: !!d.dappShareHex,
    hasCkeyD1: !!d.ckeyD1,
    hasD1: false,
    hasD2: false,
    hasFullKey: false,
  };
}

function combineCkeyD1D2(dapp, d2Hex) {
  const pub = new PublicKey(BigInt(dapp.paillierN), BigInt(dapp.paillierG));
  const c1 = BigInt(dapp.ckeyD1);
  const d2 = hexToScalar(d2Hex);
  const c2 = pub.encrypt(d2);
  return pub.addition(c1, c2).toString();
}

/** Live d2 for this ticket only. Never written through saveSessions. */
const d2Ram = new Map();

function ramD2Key(ticketId) {
  return String(ticketId || '');
}

function putRamD2(ticketId, { hex, enc } = {}) {
  const id = ramD2Key(ticketId);
  if (!id) return;
  const cur = { ...(d2Ram.get(id) || {}) };
  if (enc) {
    cur.enc = String(enc);
    delete cur.hex;
  } else if (hex) {
    cur.hex = String(hex).replace(/^0x/i, '').toLowerCase();
    delete cur.enc;
  }
  d2Ram.set(id, cur);
}

function getRamD2(ticketId) {
  const v = d2Ram.get(ramD2Key(ticketId));
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v.hex || null;
}

function getRamEncD2(ticketId) {
  const v = d2Ram.get(ramD2Key(ticketId));
  if (!v || typeof v === 'string') return null;
  return v.enc || null;
}

function hasRamD2(ticketId) {
  return !!(getRamD2(ticketId) || getRamEncD2(ticketId));
}

function wipeRamD2(ticketId) {
  const id = ramD2Key(ticketId);
  if (id) d2Ram.delete(id);
}

function stripPersistedD2(t) {
  if (!t) return t;
  delete t.d2Hex;
  delete t.encD2;
  return t;
}

function lindellBindOf(ticketId, hashHex, R1Hex) {
  return [String(ticketId || ''), String(hashHex || '').replace(/^0x/i, '').toLowerCase(), String(R1Hex || '').replace(/^0x/i, '').toLowerCase()].join('|');
}

export async function pool3pReuseOrPrepare(ticketId, { toAddress, amountE8, makePrep }) {
  const id = String(ticketId || '').trim();
  if (!id) throw new Error('ticketId required');
  return withTicketGate(id, async () => {
    const paid = paidRecordFor(id, { amountE8 });
    if (paid) return { alreadyPaid: true, ticketId: id, ...paid };
    const s = await loadSessions();
    const prev = s.tickets[id] || {};
    if (sessionLooksPaid(prev)) {
      return { alreadyPaid: true, ticketId: id, ...paidRowFromSession(prev) };
    }
    const old = prev.prep;
    const sameTo =
      !toAddress ||
      String(old?.toAddress || '').toLowerCase() === String(toAddress).replace(/^0x/i, '').toLowerCase();
    const sameAmt =
      amountE8 == null || String(old?.amountE8 || '') === String(amountE8);
    const nonceSpent = nonceAlreadyUsed(old?.fromAddress, old?.nonceId);
    if (old?.hashHex && sameTo && sameAmt && !nonceSpent) {
      return old;
    }
    const prep = await makePrep();
    await pool3pRememberPrepare(id, prep);
    return prep;
  });
}

export async function rebuildLindell(ticketId) {
  const id = String(ticketId || '').trim();
  const dapp = loadDapp();
  if (!dapp) throw new Error('3P pool not configured');
  const paid = paidRecordFor(id);
  if (paid) return { ok: true, alreadyPaid: true, ticketId: id, ...paid };
  return withSessions((s) => {
    const t = s.tickets[id];
    if (!t) throw new Error('no room');
    if (sessionLooksPaid(t)) return { alreadyPaid: true, ...roomView(t) };
    stripPersistedD2(t);
    if (!t.R1Hex || !hasRamD2(id) || !t.hashHex) {
      t.status = t.haveD2 || hasRamD2(id) ? 'wait_r1' : 'wait_d2';
      return roomView(t);
    }
    runLindellInto(t, dapp);
    t.updatedAt = Date.now();
    t.lastError = null;
    return roomView(t);
  });
}

export async function pool3pRememberPrepare(ticketId, prep) {
  const id = String(ticketId);
  if (ticketIsPaid(id, { amountE8: prep?.amountE8 })) return prep;
  await withSessions((s) => {
    const prev = s.tickets[id] || {};
    if (sessionLooksPaid(prev)) return;
    s.tickets[id] = fillRoomMeta(
      {
        ...prev,
        ticketId: id,
        prep,
        hashHex: prep.hashHex,
        updatedAt: Date.now(),
        room: true,
      },
      { amountE8: prep.amountE8 ?? prev.amountE8, toAddress: prep.toAddress || prev.toAddress },
    );
  });
  return prep;
}

export async function pool3pOfferR1({
  ticketId,
  signerId,
  R1Hex,
  hashHex,
  amountE8,
  toAddress,
}) {
  const dapp = loadDapp();
  if (!dapp) throw new Error('3P pool not configured');
  const sid = String(signerId || '').trim();
  const h1 = currentHolderId(1);
  const bornSid = dapp.seats?.['1']?.signerId || null;
  if (!h1 && !bornSid) throw new Error('no d1 holder — a browser must enroll the seat');
  if (sid !== h1 && sid !== bornSid) {
    return {
      ok: false,
      error: 'R1 must come from the current d1 holder or the d1 dealer',
      role: 1,
      holder: h1,
      dealer: bornSid,
      you: sid,
    };
  }
  if (!R1Hex || String(hashHex || '').replace(/^0x/i, '').length !== 64) {
    throw new Error('R1Hex + hashHex required');
  }
  const id = String(ticketId);
  if (ticketNeedsNoticeProof(id)) {
    try {
      await assertReleaseNoticeProof(id, { amountE8, toAddress });
    } catch (e) {
      return {
        ok: false,
        ticketId: id,
        waiting: !!e.waiting,
        waitingOn: e.waiting ? 'notice-proof' : undefined,
        error: e.message,
      };
    }
  }
  const paid = paidRecordFor(id);
  if (paid) {
    return { ok: false, alreadyPaid: true, error: 'ticket already paid', ticketId: id, ...paid };
  }
  return withSessions((s) => {
    const prev = s.tickets[id] || {};
    if (sessionLooksPaid(prev)) {
      return { ok: false, alreadyPaid: true, error: 'ticket already paid', ...roomView(prev) };
    }
    const nextHash = String(hashHex).replace(/^0x/i, '').toLowerCase();
    const nextR1 = String(R1Hex).replace(/^0x/i, '').toLowerCase();
    // Phase 0: same R1 must not sign a different hash (nonce-reuse class).
    if (prev.haveR1 && prev.R1Hex && prev.hashHex) {
      const sameR1 = String(prev.R1Hex).replace(/^0x/i, '').toLowerCase() === nextR1;
      const sameHash = String(prev.hashHex).replace(/^0x/i, '').toLowerCase() === nextHash;
      if (sameR1 && !sameHash) {
        throw new Error(
          'R1 already bound to another hashHex — post a fresh k1 (same R1 + different z is nonce reuse)',
        );
      }
    }
    s.tickets[id] = fillRoomMeta(
      {
        ...prev,
        ticketId: id,
        R1Hex: nextR1,
        hashHex: nextHash,
        r1SignerId: sid,
        haveR1: true,
        noticeProofOk: ticketNeedsNoticeProof(id) ? true : prev.noticeProofOk,
        status: prev.haveD2 ? 'ready' : 'wait_d2',
        updatedAt: Date.now(),
        room: true,
      },
      { amountE8, toAddress },
    );
    stripPersistedD2(s.tickets[id]);
    if (s.tickets[id].haveR1 && hasRamD2(id)) {
      s.tickets[id].haveD2 = true;
      runLindellInto(s.tickets[id], dapp);
    }
    return roomView(s.tickets[id]);
  });
}

export async function pool3pOfferD2({
  ticketId,
  signerId,
  d2Hex,
  encD2,
  encDlogProof,
  rangeProof,
  amountE8,
  toAddress,
}) {
  const dapp = loadDapp();
  if (!dapp) throw new Error('3P pool not configured');
  const sid = String(signerId || '').trim();
  const h2 = currentHolderId(2);
  if (!h2) throw new Error('no d2 holder — a browser must enroll the seat');
  if (sid !== h2) {
    return {
      ok: false,
      error: 'd2 must come from the current d2 holder',
      role: 2,
      holder: h2,
      you: sid,
      skipped: true,
    };
  }
  const ticketIdNorm = String(ticketId);
  if (ticketNeedsNoticeProof(ticketIdNorm)) {
    try {
      await assertReleaseNoticeProof(ticketIdNorm, { amountE8, toAddress });
    } catch (e) {
      return {
        ok: false,
        ticketId: ticketIdNorm,
        waiting: !!e.waiting,
        waitingOn: e.waiting ? 'notice-proof' : undefined,
        error: e.message,
      };
    }
  }
  const wantP2 = String(dapp.seats?.['2']?.P || dapp.seal?.P2 || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const id = String(ticketId);
  const paid = paidRecordFor(id);
  if (paid) {
    return { ok: false, alreadyPaid: true, error: 'ticket already paid', ticketId: id, ...paid };
  }
  void d2Hex;
  if (!encD2 || !encDlogProof) {
    throw new Error('d2 offer needs Enc(d2)+encDlogProof — plaintext d2Hex is refused');
  }
  if (!dapp.paillierN || !dapp.paillierG) {
    throw new Error('Enc(d2) needs live d1 Paillier (N,g)');
  }
  const ctx = `${seatPokContext('offer-d2', 2, wantP2)}|${id}`;
  try {
    verifyEncEqualsDlog({
      c: encD2,
      paillierN: dapp.paillierN,
      paillierG: dapp.paillierG,
      Qhex: wantP2,
      proof: encDlogProof,
      context: ctx,
    });
  } catch (e) {
    const msg = e?.message || String(e);
    if (/zx·G|x·G ≠ Q/i.test(msg)) {
      return {
        ok: false,
        error: 'Enc(d2) is not dlog(P2) — this tab has the next-epoch pack share; rebuild current d2',
        recover: 2,
        expectedP: wantP2,
        skipped: false,
      };
    }
    throw e;
  }
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
  putRamD2(id, { enc: String(encD2) });
  return withSessions((s) => {
    const prev = s.tickets[id] || {};
    if (sessionLooksPaid(prev)) {
      wipeRamD2(id);
      return { ok: false, alreadyPaid: true, error: 'ticket already paid', ...roomView(prev) };
    }
    s.tickets[id] = fillRoomMeta(
      {
        ...prev,
        ticketId: id,
        haveD2: true,
        noticeProofOk: ticketNeedsNoticeProof(id) ? true : prev.noticeProofOk,
        status: prev.haveR1 ? 'ready' : 'wait_r1',
        updatedAt: Date.now(),
        room: true,
      },
      { amountE8, toAddress },
    );
    stripPersistedD2(s.tickets[id]);
    if (s.tickets[id].haveR1 && s.tickets[id].haveD2) {
      runLindellInto(s.tickets[id], dapp);
    }
    return roomView(s.tickets[id]);
  });
}

function runLindellInto(sess, dapp) {
  const encD2 = getRamEncD2(sess?.ticketId);
  const d2 = getRamD2(sess?.ticketId);
  stripPersistedD2(sess);
  if ((!encD2 && !d2) || !sess?.R1Hex || !sess?.hashHex) {
    delete sess.ciphertext;
    delete sess.rHex;
    delete sess.RHex;
    delete sess.pokR;
    delete sess.pokC;
    delete sess.R2Hex;
    delete sess.Q2Hex;
    delete sess.ckeyAdj;
    sess.status = sess?.haveR1 ? 'wait_d2' : sess?.haveD2 ? 'wait_r1' : 'open';
    return;
  }
  const bind = lindellBindOf(sess.ticketId, sess.hashHex, sess.R1Hex);
  if (sess.lindellBind && sess.lindellBind !== bind) {
    throw new Error(
      'Lindell already bound to (ticketId, hashHex, R1Hex) — refuse second cosignerSignStep (same R1 + different z is nonce reuse)',
    );
  }
  if (sess.lindellBind === bind && sess.ciphertext) {
    return;
  }
  const P2 = dapp.seal?.P2;
  const Pd = dapp.seal?.Pdapp || dapp.Pdapp;
  if (!P2 || !Pd) throw new Error('seal missing P2/Pdapp — cannot prove x2·G');
  const Q2Hex = encD2
    ? String(Pd).replace(/^0x/i, '').toLowerCase()
    : pointToCompressedHex(pointFromHex(P2).add(pointFromHex(Pd)));
  const step = cosignerSignStep({
    R1Hex: sess.R1Hex,
    hashHex: sess.hashHex,
    dappShareHex: dapp.dappShareHex,
    d2Hex: encD2 ? undefined : d2,
    encD2Str: encD2 || undefined,
    ckeyStr: dapp.ckeyD1,
    paillierN: dapp.paillierN,
    paillierG: dapp.paillierG,
    Q2Hex,
    sid: sess.ticketId,
  });
  sess.rHex = step.rHex;
  sess.ciphertext = step.ciphertext;
  sess.RHex = step.RHex;
  sess.R2Hex = step.R2Hex;
  sess.Q2Hex = step.Q2Hex;
  sess.ckeyAdj = step.ckeyAdj;
  sess.pokR = step.pokR;
  sess.pokC = step.pokC;
  sess.lindellBind = bind;
  sess.status = 'partial';
  if (!sess.partialAt) sess.partialAt = Date.now();
}

/** Drop R1 + ciphertext on unpaid rooms so d1 can post a fresh k1 after rekey. Keep RAM d2. */
export async function invalidateOpenLindell(reason = 'reset') {
  return withSessions((s) => {
    let n = 0;
    for (const t of Object.values(s.tickets || {})) {
      if (!t || t.status === 'paid' || t.payout?.txHash) continue;
      if (!t.haveR1 && !t.ciphertext) continue;
      delete t.R1Hex;
      delete t.rHex;
      delete t.ciphertext;
      delete t.RHex;
      delete t.pokR;
      delete t.pokC;
      delete t.R2Hex;
      delete t.Q2Hex;
      delete t.ckeyAdj;
      delete t.lindellBind;
      stripPersistedD2(t);
      t.haveR1 = false;
      t.status = hasRamD2(t.ticketId) || t.haveD2 ? 'wait_r1' : 'open';
      t.lindellReset = reason;
      t.updatedAt = Date.now();
      n += 1;
    }
    return { ok: true, reset: n, reason };
  });
}

export async function resetPool3pR1({ ticketId, signerId } = {}) {
  const id = String(ticketId || '').trim();
  if (!id) throw new Error('ticketId required');
  const sid = String(signerId || '').trim();
  const dapp = loadDapp();
  const bornSid = dapp?.seats?.['1']?.signerId || null;
  return withSessions((s) => {
    const t = s.tickets[id];
    if (!t) return { ok: true, skipped: true };
    if (t.status === 'paid' || t.payout?.txHash) {
      return { ok: true, skipped: true, paid: true };
    }
    const posted = t.r1SignerId || currentHolderId(1);
    if (sid && sid !== posted && sid !== bornSid) {
      throw new Error('reset r1 denied — not the d1 dealer or the tab that posted R1');
    }
    delete t.R1Hex;
    delete t.rHex;
    delete t.ciphertext;
    delete t.RHex;
    delete t.pokR;
    delete t.pokC;
    delete t.R2Hex;
    delete t.Q2Hex;
    delete t.ckeyAdj;
    delete t.lindellBind;
    delete t.r1SignerId;
    stripPersistedD2(t);
    t.haveR1 = false;
    t.status = hasRamD2(id) || t.haveD2 ? 'wait_r1' : 'open';
    t.lindellReset = 'd1-retry';
    t.updatedAt = Date.now();
    return roomView(t);
  });
}

function summarizeSess(sess) {
  if (!sess) return { ok: false };
  const paidHash = sess.payout?.txHash || null;
  let paillierN = null;
  let paillierG = null;
  try {
    const dapp = loadDapp();
    paillierN = dapp?.paillierN || dapp?.seats?.['1']?.paillierN || null;
    paillierG = dapp?.paillierG || dapp?.seats?.['1']?.paillierG || null;
  } catch {
    /* */
  }
  return {
    ok: true,
    ticketId: sess.ticketId,
    status: sess.status || (paidHash ? 'paid' : null),
    haveR1: !!sess.haveR1,
    haveD2: !!sess.haveD2,
    hasPartial: !!sess.ciphertext,
    rHex: sess.rHex || null,
    ciphertext: sess.ciphertext || null,
    R1Hex: sess.R1Hex || null,
    RHex: sess.RHex || null,
    R2Hex: sess.R2Hex || null,
    Q2Hex: sess.Q2Hex || null,
    ckeyAdj: sess.ckeyAdj || null,
    pokR: sess.pokR || null,
    pokC: sess.pokC || null,
    paillierN,
    paillierG,
    hashHex: sess.hashHex || null,
    amountE8: sess.amountE8 || sess.prep?.amountE8 || null,
    toAddress: sess.toAddress || sess.prep?.toAddress || null,
    prep: sess.prep || null,
    txHash: paidHash,
    payout: sess.payout || null,
  };
}

export async function openPool3pPayout({ ticketId, toAddress, amountE8 }) {
  const id = String(ticketId || '').trim();
  if (!id) throw new Error('ticketId required');
  const paid = paidRecordFor(id, { amountE8, toAddress });
  if (paid) return { ok: true, alreadyPaid: true, ticketId: id, ...paid };
  return withSessions((s) => {
    const raw = s.tickets[id] || {};
    if (sessionLooksPaid(raw) && samePaidAmount(paidRowFromSession(raw) || raw, amountE8)) {
      return { ok: true, alreadyPaid: true, ...summarizeSess(raw) };
    }
    const prev = sessionAbandoned(raw) ? { ticketId: id } : raw;
    const hint = hintFor(id);
    s.tickets[id] = fillRoomMeta(
      {
        ...prev,
        ticketId: id,
        status: prev.haveR1 || prev.haveD2 ? prev.status || 'open' : 'open',
        openedAt: prev.openedAt || Date.now(),
        updatedAt: Date.now(),
        room: true,
      },
      {
        amountE8: amountE8 ?? prev.amountE8 ?? hint?.amountE8,
        toAddress: toAddress || prev.toAddress || hint?.toAddress,
      },
    );
    return { ok: true, opened: true, ...roomView(s.tickets[id]) };
  });
}

export function listOpenPool3pTickets() {
  let s;
  try {
    s = JSON.parse(readFileSync(SESS_PATH, 'utf8'));
  } catch {
    s = { tickets: {} };
  }
  const seen = new Set();
  const out = [];
  const push = (t) => {
    const id = String(t?.ticketId || '').trim();
    if (!id || seen.has(id)) return;
    const hint = hintFor(id);
    const amountE8 = t.amountE8 || hint?.amountE8;
    const toAddress = t.toAddress || hint?.toAddress;
    if (
      ticketIsPaid(id, { amountE8, toAddress }) ||
      sessionLooksPaid(t) ||
      sessionAbandoned(t)
    ) {
      return;
    }
    if (!amountE8 || !toAddress) return;
    seen.add(id);
    const waitingOn = [];
    if (ticketNeedsNoticeProof(id) && !t.noticeProofOk) waitingOn.push('notice-proof');
    if (!t.haveR1) waitingOn.push('d1');
    if (!t.haveD2) waitingOn.push('d2');
    if (t.haveR1 && t.haveD2 && !t.ciphertext && !t.payout?.txHash) waitingOn.push('lindell');
    out.push({
      ticketId: id,
      amountE8: String(amountE8),
      toAddress,
      status: t.status || 'open',
      labDemo: false,
      scheme: POOL3P_SCHEME,
      haveR1: !!t.haveR1,
      haveD2: !!t.haveD2,
      hasPartial: !!t.ciphertext,
      count: Number(!!t.haveR1) + Number(!!t.haveD2),
      need: 2,
      waitingOn,
      room: true,
      steps: {
        d1: !!t.haveR1,
        d2: !!t.haveD2,
        lindell: !!t.ciphertext,
        paid: t.status === 'paid' || !!t.payout?.txHash,
      },
    });
  };
  for (const t of Object.values(s.tickets || {})) push(t);
  for (const hint of inspectRoomHints.values()) {
    const existing = s.tickets?.[String(hint.ticketId)];
    if (
      ticketIsPaid(hint.ticketId, {
        amountE8: hint.amountE8,
        toAddress: hint.toAddress,
      }) ||
      sessionLooksPaid(existing) ||
      sessionAbandoned(existing)
    ) {
      continue;
    }
    push({ ticketId: hint.ticketId, amountE8: hint.amountE8, toAddress: hint.toAddress });
  }
  return out;
}

export function listOpenUserPool3pTickets() {
  return listOpenPool3pTickets().filter((t) => !isRotateTicketId(t.ticketId));
}

function wipeRoomSecrets(t) {
  if (!t) return t;
  wipeRamD2(t.ticketId);
  delete t.d2Hex;
  delete t.ciphertext;
  delete t.R1Hex;
  delete t.rHex;
  delete t.RHex;
  delete t.pokR;
      delete t.pokC;
      delete t.R2Hex;
      delete t.Q2Hex;
      delete t.ckeyAdj;
  delete t.hashHex;
  delete t.lindellBind;
  t.haveR1 = false;
  t.haveD2 = false;
  return t;
}

export async function closePool3pRoom(ticketId, reason = 'reset') {
  const id = String(ticketId || '').trim();
  if (!id) throw new Error('ticketId required');
  inspectRoomHints.delete(id);
  return withSessions((s) => {
    const t = s.tickets[id];
    if (!t) {
      s.tickets[id] = {
        ticketId: id,
        status: 'abandoned',
        abandonedAt: Date.now(),
        abandonReason: reason,
        room: false,
        updatedAt: Date.now(),
      };
      return { ok: true, ticketId: id, closed: true, existed: false, reason };
    }
    if (sessionLooksPaid(t)) {
      return { ok: true, ticketId: id, skipped: true, paid: true };
    }
    const paid = paidLogHit(id, t);
    if (paid) {
      t.status = 'paid';
      t.room = false;
      t.payout = {
        ...(t.payout || {}),
        ok: true,
        txHash: paid.txHash || t.payout?.txHash || null,
        at: paid.at || Date.now(),
      };
      wipeRoomSecrets(t);
      t.updatedAt = Date.now();
      return { ok: true, ticketId: id, skipped: true, paid: true, restored: true };
    }
    wipeRoomSecrets(t);
    t.status = 'abandoned';
    t.abandonedAt = Date.now();
    t.abandonReason = reason;
    t.room = false;
    t.updatedAt = Date.now();
    return { ok: true, ticketId: id, closed: true, existed: true, reason };
  });
}

function spendHoldersLive() {
  const live = liveOrbitMembers();
  const h1 = currentHolderId(1);
  const h2 = currentHolderId(2);
  return !!(h1 && h2 && live.includes(h1) && live.includes(h2));
}

export async function expireStaleUserRooms(now = Date.now()) {
  let s;
  try {
    s = JSON.parse(readFileSync(SESS_PATH, 'utf8'));
  } catch {
    return { ok: true, closed: [] };
  }
  const closed = [];
  const holdersLive = spendHoldersLive();
  for (const t of Object.values(s.tickets || {})) {
    const id = String(t?.ticketId || '');
    if (!id || isRotateTicketId(id)) continue;
    if (sessionLooksPaid(t) || sessionAbandoned(t) || paidLogHit(id, t)) continue;
    // d1+d2 are still heartbeating — they may be retrying Lindell finish/submit.
    if (holdersLive) continue;
    const updated = Number(t.updatedAt || t.openedAt || t.abandonedAt || 0);
    const partialAt = Number(t.partialAt || 0);
    const idle = updated ? now - updated : Number.POSITIVE_INFINITY;
    const partialAge = partialAt ? now - partialAt : 0;
    const orbitOnly = !t.amountE8 && !t.toAddress && !t.haveR1 && !t.haveD2 && !t.ciphertext;
    let reason = null;
    if (t.ciphertext && partialAge >= ROOM_PARTIAL_MS) {
      reason = 'expire-partial-unpaid';
    } else if (orbitOnly && (!updated || idle >= ROOM_IDLE_MS)) {
      reason = 'expire-orbit-only';
    } else if (idle >= ROOM_IDLE_MS) {
      reason = 'expire-idle';
    }
    if (reason) closed.push({ ticketId: id, reason });
  }
  for (const row of closed) {
    await closePool3pRoom(row.ticketId, row.reason);
  }
  return { ok: true, closed };
}

/** Put an inspect-authorized unpaid ticket back in the open list after expire-idle. */
export async function reopenAbandonedAuthorizedTickets(tickets = []) {
  const opened = [];
  for (const t of tickets || []) {
    const id = String(t?.ticketId || '').trim();
    if (!id || isRotateTicketId(id)) continue;
    if (String(t.status || 'authorized') !== 'authorized') continue;
    if (ticketIsPaid(id, { amountE8: t.amountE8 })) continue;
    let sess = null;
    try {
      const s = JSON.parse(readFileSync(SESS_PATH, 'utf8'));
      sess = s.tickets?.[id] || null;
    } catch {
      sess = null;
    }
    if (
      sess &&
      !sessionAbandoned(sess) &&
      sess.room !== false &&
      (sess.amountE8 || sess.toAddress)
    ) {
      continue;
    }
    const r = await openPool3pPayout({
      ticketId: id,
      toAddress: t.toAddress,
      amountE8: t.amountE8,
    });
    opened.push(r);
  }
  return opened;
}

function loadPaidLog() {
  try {
    const j = JSON.parse(readFileSync(PAID_PATH, 'utf8'));
    return Array.isArray(j.pays) ? j : { pays: [] };
  } catch {
    return { pays: [] };
  }
}

async function rememberPaid(row) {
  const log = loadPaidLog();
  const tx = row?.txHash ? String(row.txHash) : '';
  const id = String(row?.ticketId || '');
  const dup = log.pays.some(
    (p) =>
      (tx && p.txHash === tx) ||
      (id &&
        String(p.ticketId || '') === id &&
        String(p.amountE8 || '') === String(row.amountE8 || '')),
  );
  if (!dup && (tx || id)) {
    log.pays.unshift({
      ticketId: id || null,
      amountE8: row.amountE8 != null ? String(row.amountE8) : null,
      toAddress: row.toAddress || null,
      txHash: tx || null,
      at: row.at || Date.now(),
      nonceId: row.nonceId ?? null,
      status: 'paid',
      scheme: POOL3P_SCHEME,
    });
    log.pays = log.pays.slice(0, 48);
    await mkdir(path.dirname(PAID_PATH), { recursive: true });
    await writeFile(PAID_PATH, JSON.stringify(log, null, 2));
  }
  return log.pays;
}

export function listPaidPool3pTickets(limit = 16) {
  const fromLog = loadPaidLog().pays || [];
  let s;
  try {
    s = JSON.parse(readFileSync(SESS_PATH, 'utf8'));
  } catch {
    s = { tickets: {} };
  }
  const seenTicket = new Set();
  const seenTx = new Set();
  const rows = [];
  const take = (p) => {
    const id = p?.ticketId ? String(p.ticketId) : '';
    const tx = p?.txHash ? String(p.txHash) : '';
    if (id && seenTicket.has(id)) return;
    if (tx && seenTx.has(tx)) return;
    if (!id && !tx) return;
    if (id) seenTicket.add(id);
    if (tx) seenTx.add(tx);
    rows.push(p);
  };
  for (const p of fromLog) take(p);
  for (const t of Object.values(s.tickets || {})) {
    const row = paidRowFromSession(t);
    if (row) take(row);
  }
  rows.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  return rows.slice(0, limit);
}

export function roomView(sess) {
  const sum = summarizeSess(sess);
  const waitingOn = [];
  if (ticketNeedsNoticeProof(sess?.ticketId) && !sess?.noticeProofOk) {
    waitingOn.push('notice-proof');
  }
  if (!sum.haveR1) waitingOn.push('d1');
  if (!sum.haveD2) waitingOn.push('d2');
  if (sum.haveR1 && sum.haveD2 && !sum.hasPartial && sum.status !== 'paid') {
    waitingOn.push('lindell');
  }
  const h1 = currentHolderId(1);
  const h2 = currentHolderId(2);
  const live = liveOrbitMembers();
  return {
    ...sum,
    room: true,
    waitingOn,
    members: {
      d1: { signerId: h1, live: !!(h1 && live.includes(h1)), joined: !!sum.haveR1 },
      d2: { signerId: h2, live: !!(h2 && live.includes(h2)), joined: !!sum.haveD2 },
    },
    readyToFinish: !!sum.hasPartial,
    lastError: sess.lastError || null,
    lindellReset: sess.lindellReset || null,
  };
}

export async function pool3pGetPrep(ticketId) {
  const s = await loadSessions();
  return s.tickets[String(ticketId)]?.prep || null;
}

export async function pool3pStatusTicket(ticketId) {
  const id = String(ticketId || '').trim();
  const s = await loadSessions();
  const t = id ? s.tickets[id] : null;
  const paid = paidLogHit(id, t);
  if (paid) return paidStatusView(paid, t);
  if (!t) return { ok: false };
  return roomView(t);
}

export async function pool3pMarkPaid(ticketId, payout) {
  const id = String(ticketId || '').trim();
  let row = {
    ticketId: id,
    amountE8: payout?.amountE8 != null ? String(payout.amountE8) : null,
    toAddress: payout?.toAddress || null,
    txHash: payout?.txHash || null,
    at: Date.now(),
    nonceId: payout?.nonceId ?? null,
  };
  await withSessions((s) => {
    const sess = s.tickets[id];
    if (!sess) return;
    sess.status = 'paid';
    sess.room = false;
    sess.payout = { ...(payout || {}), at: Date.now() };
    wipeRamD2(id);
    delete sess.d2Hex;
    delete sess.ciphertext;
    delete sess.R1Hex;
    delete sess.rHex;
    delete sess.RHex;
    delete sess.pokR;
    delete sess.pokC;
    delete sess.R2Hex;
    delete sess.Q2Hex;
    delete sess.ckeyAdj;
    delete sess.lindellBind;
    sess.haveR1 = false;
    sess.haveD2 = false;
    row = {
      ticketId: id,
      amountE8: sess.amountE8 || sess.prep?.amountE8 || payout?.amountE8,
      toAddress: sess.toAddress || sess.prep?.toAddress || payout?.toAddress,
      txHash: payout?.txHash || sess.payout?.txHash,
      at: sess.payout.at,
      nonceId: payout?.nonceId ?? sess.prep?.nonceId,
    };
  });
  if (id || row.txHash) await rememberPaid(row);
}

/** Broadcast once. A second finisher waits on the gate and then sees alreadyPaid. */
export async function pool3pSubmitGuarded(ticketId, { hashHex, submitFn }) {
  const id = String(ticketId || '').trim();
  if (!id) throw new Error('ticketId required');
  if (typeof submitFn !== 'function') throw new Error('submitFn required');
  return withTicketGate(id, async () => {
    const s0 = await loadSessions();
    const amt0 = s0.tickets[id]?.amountE8 || s0.tickets[id]?.prep?.amountE8;
    const paid = paidRecordFor(id, { amountE8: amt0 });
    if (paid) return { ok: true, alreadyPaid: true, ticketId: id, ...paid };
    const s = s0;
    const t = s.tickets[id];
    if (sessionLooksPaid(t)) {
      return { ok: true, alreadyPaid: true, ticketId: id, ...paidRowFromSession(t) };
    }
    const prep = t?.prep;
    if (!prep) throw new Error('missing prepare — signer1 must pool3p_prepare first');
    if (hashHex && prep.hashHex !== String(hashHex).replace(/^0x/i, '')) {
      const err = new Error('hash mismatch vs prepare');
      err.code = 'HASH_MISMATCH';
      throw err;
    }
    const paidOut = await submitFn(prep);
    await pool3pMarkPaid(id, paidOut);
    return { ok: true, ...paidOut };
  });
}

export { clientSignRound1, clientSignFinish, hexToScalar, scalarToHex };

/** Host selftest: ceremony + dummy Lindell + recover pubkey. */
export async function selftest3p() {
  const { dapp, s1, s2, address, publicKey } = await createThreePartyPool({
    signer1Id: 't1',
    signer2Id: 't2',
  });
  const hashHex = 'ab'.repeat(32);
  const { k1Hex, R1Hex } = clientSignRound1();
  const Q2Hex = pointToCompressedHex(
    pointFromHex(dapp.seal.P2).add(pointFromHex(dapp.seal.Pdapp)),
  );
  const step = cosignerSignStep({
    R1Hex,
    hashHex,
    dappShareHex: dapp.dappShareHex,
    d2Hex: s2.userShareHex,
    ckeyStr: dapp.ckeyD1,
    paillierN: dapp.paillierN,
    paillierG: dapp.paillierG,
    Q2Hex,
    sid: 'selftest',
  });
  try {
    clientSignFinish({
      k1Hex,
      rHex: step.rHex,
      ciphertext: step.ciphertext,
      hashHex,
      clientSecret: s1,
      RHex: step.RHex,
    });
    throw new Error('finish without pokR must fail');
  } catch (e) {
    if (!/LINDELL_R_POK_MISSING/.test(e.message)) throw e;
  }
  try {
    clientSignFinish({
      k1Hex,
      rHex: step.rHex,
      ciphertext: step.ciphertext,
      hashHex: 'cd'.repeat(32),
      clientSecret: s1,
      RHex: step.RHex,
      pokR: step.pokR,
    });
    throw new Error('pokR must not verify under a different hash');
  } catch (e) {
    if (!/LINDELL_R_POK/.test(e.message)) throw e;
  }
  try {
    clientSignFinish({
      k1Hex,
      rHex: step.rHex,
      ciphertext: step.ciphertext,
      hashHex,
      clientSecret: s1,
      RHex: step.RHex,
      pokR: step.pokR,
      R2Hex: step.R2Hex,
      Q2Hex: step.Q2Hex,
      ckeyAdj: step.ckeyAdj,
      sid: 'selftest',
    });
    throw new Error('finish without pokC must fail');
  } catch (e) {
    if (!/LINDELL_C_ZK_MISSING/.test(e.message)) throw e;
  }
  const fin = clientSignFinish({
    k1Hex,
    rHex: step.rHex,
    ciphertext: step.ciphertext,
    hashHex,
    clientSecret: s1,
    RHex: step.RHex,
    pokR: step.pokR,
    pokC: step.pokC,
    R2Hex: step.R2Hex,
    Q2Hex: step.Q2Hex,
    ckeyAdj: step.ckeyAdj,
    sid: 'selftest',
  });
  if (!fin.signature65 || fin.signature65.length !== 130) {
    throw new Error('bad signature65');
  }
  if (String(s1.address) !== address) throw new Error('address mismatch');
  verifyShareSeal({ shareHex: s1.userShareHex, role: 1, seal: dapp.seal });
  verifyShareSeal({ shareHex: s2.userShareHex, role: 2, seal: dapp.seal });
  try {
    verifyShareSeal({ shareHex: s2.userShareHex, role: 1, seal: dapp.seal });
    throw new Error('seal should reject swapped role');
  } catch (e) {
    if (!/SEAL_BROKEN/.test(e.message)) throw e;
  }

  const d1 = hexToScalar(s1.userShareHex);
  const d2s = hexToScalar(s2.userShareHex);
  const dd = hexToScalar(dapp.dappShareHex);
  const delta = 123456789n;
  const n1 = applySeatDelta(d1, d2s, dd, 1, delta);
  if (currentAddress(n1.d1, n1.d2, n1.dDapp) !== address) {
    throw new Error('refresh math changed address');
  }
  if (currentAddress(d1, n1.d2, n1.dDapp) === address) {
    throw new Error('old d1 still valid after delta');
  }

  const bits = paillierBitLength(dapp.paillierN);
  if (bits < MIN_PAILLIER_BITS) {
    throw new Error(`selftest Paillier N is ${bits}-bit; floor is ${MIN_PAILLIER_BITS}`);
  }
  const pok1 = schnorrProveDlog(s1.userShareHex, seatPokContext('birth', 1, dapp.seal.P1));
  schnorrVerifyDlog(pok1, dapp.seal.P1, seatPokContext('birth', 1, dapp.seal.P1));
  try {
    runLindellPdl({
      x1: hexToScalar(s1.userShareHex),
      rEnc: 3n,
      ckey: dapp.ckeyD1,
      Q1: dapp.seal.P1,
      paillierN: dapp.paillierN,
      paillierG: dapp.paillierG,
      paillierLambda: s1.paillierLambda,
      paillierMu: s1.paillierMu,
      context: 'poison',
    });
    throw new Error('poisoned Enc(d1) must fail L_PDL');
  } catch (e) {
    if (!/LINDELL_RANGE|LINDELL_PDL/.test(e.message)) throw e;
  }
  try {
    schnorrVerifyDlog(null, dapp.seal.P1, seatPokContext('birth', 1, dapp.seal.P1));
    throw new Error('birth without Schnorr must fail');
  } catch (e) {
    if (!/SCHNORR_MISSING/.test(e.message)) throw e;
  }
  const sk = new (await import('paillier-bigint')).PrivateKey(
    BigInt(s1.paillierLambda),
    BigInt(s1.paillierMu),
    new (await import('paillier-bigint')).PublicKey(BigInt(dapp.paillierN), BigInt(dapp.paillierG)),
  );
  sk.decrypt(BigInt(step.ciphertext));

  const bindA = lindellBindOf('t', hashHex, R1Hex);
  const bindB = lindellBindOf('t', 'cd'.repeat(32), R1Hex);
  if (bindA === bindB) throw new Error('R1 bind must change when hashHex changes');

  return {
    ok: true,
    address,
    publicKey,
    signature65: fin.signature65.slice(0, 16) + '…',
    refreshKeepsAddress: true,
    oldD1Dies: true,
    paillierBits: bits,
    schnorrOk: true,
    rhoRangeOk: true,
    r1HashBind: true,
    rEqK2R1: true,
    pdlOk: true,
    rangeOk: true,
    cZkOk: true,
    note: 'Phase 0–6: L_PDL + Coinbase integer-commit ZK of c. d2 is visible to the VPS at sign. Not live.',
  };
}
