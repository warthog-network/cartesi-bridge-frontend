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
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
import { createSealedPreshareStore } from './sealedPreshare.mjs';
import { ETH3P_ADAPTER_ABI } from '../eth3pAdapter.js';

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
const ETH_PAID_PATH =
  env('POOL_ETH3P_PAID') || path.join(DEFAULT_DATA, 'pool-eth-3p-paid.json');
const ETH_ROTATE_PATH =
  env('POOL_ETH3P_ROTATE') || path.join(DEFAULT_DATA, 'pool-eth-3p-rotate.json');
export const ETH_NEXT_PATH =
  env('POOL_ETH3P_NEXT') || path.join(DEFAULT_DATA, 'pool-eth-3p-next.json');
const WART_NODE = env('WARTHOG_NODE_URL', 'http://127.0.0.1:3001');
const ETH_RPC = env('CARTESI_RPC_URL', 'http://127.0.0.1:8545');
const INSPECT = env('CARTESI_INSPECT_URL', 'http://127.0.0.1:8080/inspect');

/** Anvil genesis block hash = L1 session. Cache so a blip does not orphan wraps. */
let genesisCache = { at: 0, hash: null };

async function fetchAnvilGenesis() {
  const now = Date.now();
  if (genesisCache.hash && now - genesisCache.at < 30_000) return genesisCache.hash;
  try {
    const { JsonRpcProvider } = await import('ethers-v6');
    const provider = new JsonRpcProvider(ETH_RPC);
    const b = await provider.getBlock(0);
    const hash = b?.hash ? String(b.hash).toLowerCase() : null;
    if (!hash || hash === '0x' || hash === '0x0') return genesisCache.hash;
    genesisCache = { at: now, hash };
    return hash;
  } catch {
    return genesisCache.hash;
  }
}

function wrapEpochBacking(row, liveEpoch) {
  const stamped = row?.l1Epoch ? String(row.l1Epoch).toLowerCase() : null;
  const live = liveEpoch ? String(liveEpoch).toLowerCase() : null;
  if (!live) return 'unknown';
  if (!stamped || stamped !== live) return 'orphaned';
  return 'backed';
}

/**
 * Wraps/credits from before l1Epoch was recorded look orphaned even when the
 * lock tx is still on this Anvil. Stamp them once the receipt is still mined
 * here; leave them unstamped (orphaned) if the lock is gone.
 */
async function stampUnstampedWrapEpochs() {
  const liveEpoch = await fetchAnvilGenesis();
  if (!liveEpoch) return { stamped: 0 };
  const wraps = loadWraps();
  const rows = [...(wraps.credits || []), ...(wraps.wraps || [])].filter(
    (row) => row && !row.l1Epoch && String(row.ethTxHash || '').replace(/^0x/i, '').length === 64,
  );
  if (!rows.length) return { stamped: 0 };
  const { JsonRpcProvider } = await import('ethers-v6');
  const provider = new JsonRpcProvider(ETH_RPC);
  let stamped = 0;
  for (const row of rows) {
    const tx = String(row.ethTxHash).replace(/^0x/i, '').toLowerCase();
    const rcpt = await provider.getTransactionReceipt(`0x${tx}`).catch(() => null);
    if (rcpt && Number(rcpt.status) === 1) {
      row.l1Epoch = liveEpoch;
      stamped += 1;
    }
  }
  if (stamped) await saveWraps(wraps);
  return { stamped };
}

/** Status view: orphaned wraps keep supply but outstandingE8 is 0 for this L1. */
function wrapStatusView(row, liveEpoch) {
  const backing = wrapEpochBacking(row, liveEpoch);
  const out = String(row.outstandingE8 || '0');
  if (backing === 'orphaned') {
    return {
      ...row,
      backing,
      outstandingE8: '0',
      orphanedE8: out,
      l1Epoch: row.l1Epoch || null,
    };
  }
  return {
    ...row,
    backing,
    l1Epoch: row.l1Epoch || null,
    orphanedE8: '0',
  };
}
const ADAPTER_FILE =
  env('ETH3P_ADAPTER_FILE') ||
  path.join(FE_ROOT, '..', 'contracts/eth3p-adapter.address.json');
/** Well-known Anvil #2 — Mode A setPool only. Override with ETH3P_ADAPTER_OWNER_PK. */
const ANVIL_ADAPTER_PK =
  env('ETH3P_ADAPTER_OWNER_PK') ||
  env('ANVIL_PK') ||
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

/**
 * Bridge fee, taken at deposit and left in the Q. There is no separate gas
 * account: the ETH never leaves custody, only the mintable quota shrinks.
 *
 * The pool is therefore over-collateralised by exactly the fee, and that
 * surplus is what pays gas — for the redeem payout itself and for every
 * rotation sweep in between. Without it the pool holds precisely what it owes,
 * so assertLiveEthCanPay's `value + fee` can never be met and the last holder
 * can never exit. On 2026-08-27 a 500 WETH burn stranded exactly that way:
 * three sweeps at ~0.000021 ETH each had already taken the pool below its own
 * debt, and the burn is irreversible on Warthog before we are ever called.
 *
 * Because the surplus also funds rotation sweeps, it drains while a position is
 * held (~0.000021 ETH per rotation). The floor exists so small deposits still
 * carry enough runway to be redeemable later, not just immediately.
 */
const ETH3P_FEE_BPS = BigInt(env('ETH3P_FEE_BPS', '10'));
const ETH3P_FEE_MIN_E8 = BigInt(env('ETH3P_FEE_MIN_E8', '100000'));

/** Fee for a deposit, in E8. Percentage, floored at ETH3P_FEE_MIN_E8. */
function ethDepositFeeE8(amountE8) {
  const pct = (amountE8 * ETH3P_FEE_BPS) / 10000n;
  return pct > ETH3P_FEE_MIN_E8 ? pct : ETH3P_FEE_MIN_E8;
}

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
/** Unborn e1/e2 lease: heartbeat is not a birth. After this, another live tab may take the seat. */
const BIRTH_GRACE_MS = Number(env('POOL_ETH3P_BIRTH_GRACE_MS', '180000')) || 180000;
/**
 * Recovery lease on a born-but-vacant seat. The tab gets the seat so it can run
 * the sealed-preshare reseal round; if it reports a seat fault and still cannot
 * sign after this long, the lease is released so the next live tab may try.
 * Without the release the first candidate squats the seat and the real owner —
 * the tab that actually holds the share — never gets offered it.
 */
const RECOVER_GRACE_MS = Number(env('POOL_ETH3P_RECOVER_GRACE_MS', '120000')) || 120000;
/** How long a failed recovery candidate is passed over before it is retried. */
const RECOVER_RETRY_MS = Number(env('POOL_ETH3P_RECOVER_RETRY_MS', '600000')) || 600000;
/**
 * Backstop for a recovery lease that never says anything. A client too old to
 * report a seat fault would otherwise hold a seat it cannot sign for forever,
 * since the staleness check only frees tabs that have actually gone away.
 */
const RECOVER_SILENT_MS = Number(env('POOL_ETH3P_RECOVER_SILENT_MS', '480000')) || 480000;

/**
 * A burn only becomes irreversible once it is in a Warthog block. While the
 * receipt sits in the mempool it can still be dropped or replaced, and the ETH
 * leg cannot be undone — so paying against an unmined burn hands out L1 funds
 * for a transfer that may never happen. Gate the room AND the broadcast.
 *
 * POOL_ETH3P_BURN_MIN_CONF=0 restores the old pay-on-submit behaviour.
 */
const BURN_MIN_CONF = Math.max(0, Number(env('POOL_ETH3P_BURN_MIN_CONF', '1')) || 0);
/** Absorb the usual ~30s block inline so the caller rarely has to come back. */
const BURN_WAIT_MS = Math.max(0, Number(env('POOL_ETH3P_BURN_WAIT_MS', '25000')) || 0);
const BURN_POLL_MS = 3000;

/**
 * Same idea on the wrap leg: registerEthWrap SPV-proves a createAssets that the
 * client broadcast moments earlier, so it is normally still in the mempool.
 * Wait for its block inline instead of bouncing `createAssets tx not mined yet`
 * back at an asset that is already on Warthog and must never be minted twice.
 */
const WRAP_WAIT_MS = Math.max(0, Number(env('POOL_ETH3P_WRAP_WAIT_MS', '25000')) || 0);

export function eth3pOn() {
  const v = env('POOL_ETH3P_MODE', '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

export function loadEth3pAdapterFile() {
  try {
    const j = JSON.parse(readFileSync(ADAPTER_FILE, 'utf8'));
    const address = String(j?.address || env('ETH3P_ADAPTER') || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
    return {
      address,
      pool: j?.pool ? String(j.pool).toLowerCase() : null,
      dapp: j?.dapp ? String(j.dapp).toLowerCase() : null,
      inputBox: j?.inputBox ? String(j.inputBox).toLowerCase() : null,
      custody: j?.custody || 'eth-3p-eoa',
    };
  } catch {
    const address = String(env('ETH3P_ADAPTER') || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
    return { address, pool: null, dapp: null, inputBox: null, custody: 'eth-3p-eoa' };
  }
}

async function adapterIface() {
  const { Interface } = await import('ethers-v6');
  return new Interface(ETH3P_ADAPTER_ABI);
}

async function parseAdapterDepositEthers(receipt, adapterAddr) {
  const iface = await adapterIface();
  const want = String(adapterAddr || '').toLowerCase();
  for (const log of receipt?.logs || []) {
    if (String(log.address || '').toLowerCase() !== want) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name !== 'Deposited') continue;
      return {
        depositor: String(parsed.args.depositor || '').toLowerCase(),
        pool: String(parsed.args.pool || '').toLowerCase(),
        amountWei: BigInt(parsed.args.amountWei),
        wartAddress: String(parsed.args.wartAddress || '')
          .replace(/^0x/i, '')
          .toLowerCase(),
        inputHash: parsed.args.inputHash ? String(parsed.args.inputHash) : null,
      };
    } catch {
      /* next log */
    }
  }
  return null;
}

/**
 * Point the adapter at the live ETH 3P Q. Called on rotation cutover and
 * whenever status sees a mismatch. Mode A uses Anvil #2 (the deployer).
 */
export async function syncEth3pAdapterPool(nextAddress = null) {
  const cfg = loadEth3pAdapterFile();
  if (!cfg?.address) return { ok: false, error: 'adapter not deployed' };
  const q = String(nextAddress || loadEthDapp()?.address || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(q)) return { ok: false, error: 'no live ETH 3P Q' };
  const { JsonRpcProvider, Wallet, Contract } = await import('ethers-v6');
  const provider = new JsonRpcProvider(ETH_RPC);
  const c = new Contract(cfg.address, ETH3P_ADAPTER_ABI, provider);
  const onPool = String(await c.pool()).toLowerCase();
  if (onPool === q) return { ok: true, already: true, address: cfg.address, pool: q };
  const wallet = new Wallet(ANVIL_ADAPTER_PK, provider);
  const owner = String(await c.owner()).toLowerCase();
  if (owner !== wallet.address.toLowerCase()) {
    return {
      ok: false,
      error: `adapter owner ${owner} is not ${wallet.address} — set ETH3P_ADAPTER_OWNER_PK`,
      address: cfg.address,
      pool: onPool,
    };
  }
  const tx = await c.connect(wallet).setPool(q);
  await tx.wait();
  try {
    const rec = JSON.parse(readFileSync(ADAPTER_FILE, 'utf8'));
    rec.pool = q;
    rec.lastSetPool = { to: q, tx: tx.hash, at: new Date().toISOString() };
    await saveJson(ADAPTER_FILE, rec);
  } catch {
    /* address file is convenience; chain is truth */
  }
  return { ok: true, address: cfg.address, pool: q, tx: tx.hash };
}

let lastAdapterSyncAt = 0;
export async function maybeSyncEth3pAdapter() {
  const now = Date.now();
  if (now - lastAdapterSyncAt < 15_000) return null;
  lastAdapterSyncAt = now;
  try {
    return await syncEth3pAdapterPool();
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
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

/**
 * Write state atomically.
 *
 * This used to writeFile() straight onto the destination, which is not one
 * operation: a reader that lands mid-write sees a truncated file, and two
 * writers that overlap interleave into a file that is neither. loadJson()
 * swallows the resulting parse error and hands back the fallback, so the
 * damage surfaces somewhere far away as "there is no dapp" — see the guard in
 * ensureEth3pDapp(). On 2026-08-25 that chain silently minted a new d_dapp and
 * moved the ETH pool address mid-session.
 *
 * Temp-then-rename makes the swap atomic: a reader sees the old file or the new
 * one, never a half-written one. The temp name carries a counter as well as the
 * pid because two writes in this process can be in flight at once — one shared
 * name and the loser's rename fails with ENOENT after the winner moves it away.
 */
let saveSeq = 0;
async function saveJson(p, obj) {
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${++saveSeq}`;
  await writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  await rename(tmp, p);
}

export function loadEthDapp() {
  return loadJson(ETH_DAPP_PATH, null);
}

export function loadEthNext() {
  return loadJson(ETH_NEXT_PATH, null);
}

/**
 * Address the in-flight sweep is bound to, or null when no sweep is open.
 *
 * Read straight off the rotate file rather than importing poolEth3pRotate —
 * that module imports this one, and a cycle here would be loaded lazily on the
 * cutover path, which is the last place that should surprise us.
 */
function sweepBoundNextAddress() {
  try {
    const r = JSON.parse(readFileSync(ETH_ROTATE_PATH, 'utf8'));
    if (!r?.sweepTicketId) return null;
    return String(r.sweepToAddress || '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Refuse to move the announced next Q while a sweep is in flight.
 *
 * openEthSweepPayout() freezes its destination into the ticket when the ticket
 * opens, then waits on browser signer contributions. If `next` is re-birthed in
 * that window the sweep pays the old address while activateNext() installs the
 * new one, and the cutover unlink of ETH_NEXT_PATH destroys the only copy of
 * the paid Q's key material. That is exactly how 237.999895 ETH was orphaned on
 * 0x72a9415ed00eac71f294af753b03d424a2bd5555 at 2026-08-27T01:44Z — 18 seconds
 * between ticket open and pay was enough.
 *
 * Seat births during need_birth still write freely: the lock only engages once
 * a sweep ticket exists, and only against a change of address.
 */
export async function writeEthNext(dapp, { replaceClosed = false } = {}) {
  const bound = sweepBoundNextAddress();
  const incoming = String(dapp?.address || '').toLowerCase();
  if (bound && incoming && incoming !== bound) {
    throw new Error(
      `next Q is locked to ${bound} while its sweep is in flight — refusing to ` +
        `move it to ${incoming} (would orphan the swept balance)`,
    );
  }
  /**
   * File-boundary enforcement of the closed-record invariant. This catches ANY
   * writer rather than one caller, which is the entire point: the 2026-08-27 and
   * 2026-08-31 fixes each guarded a single path and the next incident came in
   * through another. Only the rotation driver starting a fresh cycle may replace
   * a closed record, and it says so explicitly.
   */
  if (!replaceClosed) {
    const existing = loadEthNext();
    const closedAt = existing?.nextClosed?.at;
    const closedAddr = String(
      existing?.nextClosed?.address || existing?.address || '',
    ).toLowerCase();
    if (closedAt && closedAddr && incoming && incoming !== closedAddr) {
      throw new Error(
        `next Q ${closedAddr} was closed at ${closedAt} — refusing to overwrite it with ` +
          `${incoming} (would move the pool address out from under the rotation)`,
      );
    }
  }
  await saveJson(ETH_NEXT_PATH, dapp);
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

/**
 * Digest of the accounting itself — credits, wraps, burns and nothing else.
 *
 * Deliberately excludes `integrity`, `voided`, `resetReason` and friends: the
 * first would be self-referential, and the rest are operator annotations that
 * must stay editable without invalidating the chain.
 */
function ethLedgerDigest(w) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        credits: w?.credits || [],
        wraps: w?.wraps || [],
        burns: w?.burns || [],
      }),
    )
    .digest('hex');
}

/**
 * Head of the ledger's hash chain: head_n = H(prev || digest_n || seq_n).
 *
 * Why a chain rather than a plain checksum: a checksum only says "this file is
 * self-consistent", which a rewrite trivially restores. Chaining each state to
 * its predecessor means a rewrite has to reproduce every prior head too, so a
 * single retained older head — in a backup, in a log line, or anchored off-box —
 * is enough to expose it.
 *
 * Be honest about the limit: this is *detection*, not prevention. Root can
 * recompute the whole chain. Its real value is (a) catching accidental
 * corruption and partial hand-edits, which is what has actually bitten this
 * ledger, and (b) producing a single 32-byte value that is worth anchoring
 * somewhere the VPS does not control. See docs/ETH-LEDGER-INTEGRITY.md.
 */
function ethLedgerHead(prev, digest, seq) {
  return createHash('sha256')
    .update(`eth-3p-ledger-chain-v1|${prev || 'genesis'}|${digest}|${seq}`)
    .digest('hex');
}

/** How many past heads to retain for continuity checks. */
const ETH_LEDGER_CHAIN_KEEP = 200;

async function saveWraps(w) {
  const prevHead = w?.integrity?.head || null;
  const seq = Number(w?.integrity?.seq || 0) + 1;
  const digest = ethLedgerDigest(w);
  const head = ethLedgerHead(prevHead, digest, seq);
  const chain = Array.isArray(w?.integrity?.chain) ? w.integrity.chain.slice() : [];
  chain.push({ seq, head, at: new Date().toISOString() });
  w.integrity = {
    v: 1,
    scheme: 'eth-3p-ledger-chain-v1',
    seq,
    prev: prevHead,
    digest,
    head,
    at: new Date().toISOString(),
    chain: chain.slice(-ETH_LEDGER_CHAIN_KEEP),
  };
  await saveJson(ETH_WRAPS_PATH, w);
}

/**
 * Ops-side write for scripts/eth-ledger-audit.mjs --fix.
 *
 * Exists so a repair goes through the same choke point as every normal
 * mutation and advances the hash chain. A raw writeFile would leave the
 * integrity block describing the pre-repair state, and the next audit would
 * then report the repair itself as tampering.
 */
export async function saveWrapsForOps(w) {
  await saveWraps(w);
}

/**
 * Recompute the chain over a ledger and report whether it holds.
 * Exported so scripts/eth-ledger-audit.mjs can check it without duplicating
 * the hashing rules.
 */
export function verifyEthLedgerChain(w) {
  const integ = w?.integrity;
  if (!integ) {
    return { ok: false, reason: 'no integrity block — ledger predates chaining or was replaced' };
  }
  if (integ.scheme !== 'eth-3p-ledger-chain-v1') {
    return { ok: false, reason: `unknown chain scheme ${integ.scheme}` };
  }
  const digest = ethLedgerDigest(w);
  if (digest !== integ.digest) {
    return {
      ok: false,
      reason: 'CONTENT EDITED: credits/wraps/burns do not hash to the recorded digest',
      expected: integ.digest,
      actual: digest,
    };
  }
  const head = ethLedgerHead(integ.prev, digest, integ.seq);
  if (head !== integ.head) {
    return { ok: false, reason: 'HEAD BROKEN: recorded head is not H(prev||digest||seq)', expected: integ.head, actual: head };
  }
  const last = (integ.chain || [])[integ.chain.length - 1];
  if (last && last.head !== integ.head) {
    return { ok: false, reason: 'CHAIN TIP MISMATCH: last retained head != current head' };
  }
  return { ok: true, seq: integ.seq, head: integ.head, digest };
}

export { ethLedgerDigest, ethLedgerHead };

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

/**
 * The pool's own key share, minted once.
 *
 * Minting is how a pool begins, and it is also how a pool is destroyed: a new
 * d_dapp means a new Q = Pdapp + P1 + P2, which means a new address, which
 * means whatever sits at the old one is stranded with no sweep. So the only
 * question that matters here is "is there already a dapp?" — and `loadEthDapp()
 * returned nothing` is not that question. It conflates *absent* with
 * *unreadable*, and answers "mint" to both.
 *
 * Absent is legitimate and rare: first run, or eth-3p-fresh-start.mjs, which
 * unlinks the file precisely so this mints. Unreadable is a damaged file, and
 * the right answer is to stop and say so. Failing loudly takes the ETH pool
 * offline until someone restores the file; minting quietly moves the pool
 * address and looks like nothing happened until the balance is gone.
 */
export async function ensureEth3pDapp() {
  if (existsSync(ETH_DAPP_PATH)) {
    let dapp;
    try {
      dapp = JSON.parse(readFileSync(ETH_DAPP_PATH, 'utf8'));
    } catch (e) {
      throw new Error(
        `ETH 3P dapp at ${ETH_DAPP_PATH} exists but will not parse (${e.message}). ` +
          'Refusing to mint a new d_dapp: that moves the pool address and strands the ' +
          'balance at the old one. Restore the file from a backup, or park it on purpose ' +
          'with eth-3p-fresh-start.mjs.',
      );
    }
    if (dapp?.Pdapp) return dapp;
    throw new Error(
      `ETH 3P dapp at ${ETH_DAPP_PATH} exists but carries no Pdapp. Refusing to mint over ` +
        'it — a dapp without its own share is a damaged file, not an empty pool. Restore it, ' +
        'or park it on purpose with eth-3p-fresh-start.mjs.',
    );
  }
  const dDapp = randomScalar();
  const Pdapp = pointToCompressedHex(G.multiply(dDapp));
  const dapp = {
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

/**
 * Sealed preshare packs for e1/e2. The coordinator relays pieces it cannot
 * open: recovery needs t holders to reseal to the asking tab.
 */
const ethPreshare = createSealedPreshareStore({
  file: env('POOL_ETH3P_SEALED') || path.join(DEFAULT_DATA, 'pool-eth-3p-sealed-preshare.json'),
  pool: 'eth',
  ctx: {
    currentHolderId: (role) => currentHolderId(role),
    bornSignerId: (role) => loadEthDapp()?.seats?.[String(role)]?.signerId || null,
    holderProven: (role, signerId) => ethHolderProven(role, signerId),
    liveP: (role) =>
      compactPoint(
        loadEthDapp()?.seats?.[String(role)]?.P ||
          loadEthDapp()?.seal?.[Number(role) === 1 ? 'P1' : 'P2'] ||
          '',
      ),
    nextP: (role) =>
      compactPoint(
        loadEthNext()?.seats?.[String(role)]?.P ||
          loadEthNext()?.seats?.[role]?.P ||
          loadEthNext()?.seal?.[Number(role) === 1 ? 'P1' : 'P2'] ||
          '',
      ),
    nextBornSignerId: (role) =>
      loadEthNext()?.seats?.[String(role)]?.signerId ||
      loadEthNext()?.seats?.[role]?.signerId ||
      null,
  },
});

export const ethSealedPreshare = ethPreshare;

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

/**
 * Born seat whose birthing signer is no longer live. The share exists only in
 * that tab, and seats[r].P pins the seat to its signerId, so no other node can
 * take it — it is unfillable rather than merely unfilled. See `stranded` in
 * eth3pStatus().
 */
function seatStranded(dapp, role, live = liveOrbitMembers()) {
  const seat = dapp?.seats?.[role] || dapp?.seats?.[String(role)];
  if (!seat?.P || !seat.signerId) return false;
  // Owner is sitting in its own seat — nothing wrong.
  if (currentHolderId(role) === seat.signerId) return false;
  // Owner is gone; the share went with the tab.
  if (!live.includes(seat.signerId)) return true;
  // Owner is live but parked on the other seat. A signer only ever holds one
  // role (enrollUnlocked returns on first match), so it can never come back
  // here — this is the shape seat 2 was left in on 2026-08-23. Unfillable.
  const otherRole = String(role) === '1' ? '2' : '1';
  return currentHolderId(otherRole) === seat.signerId;
}

/**
 * Born seats nobody live is sitting in — pickup is a recovery claim, never a
 * new birth.
 *
 * seats[r].P is a term of Q = Pdapp + P1 + P2, so re-birthing a born seat moves
 * the pool address and strands the balance at the old one. The only safe pickup
 * is a tab that already holds d_r (its own stale copy, or one rebuilt from the
 * sealed preshare pack) proving dlog(P) and taking the seat with P untouched.
 *
 * This is the ETH twin of pool3p's recoverableBornSeats(). Its absence is what
 * deadlocked e2: enrollUnlocked would only ever hand seat r back to the exact
 * signerId in the birth record, so once that id was gone — a closed tab, or a
 * profile that regenerated its signerId — the seat could not be offered to
 * anyone, while the sealed pack that would have restored it sat unused. Every
 * redeem then parked at wait_d2 forever and rotation jammed behind the open
 * room, which reads as "e1 is stuck" even though e1 is perfectly healthy.
 */
function recoverableEthBornSeats(live = liveOrbitMembers()) {
  const dapp = loadEthDapp();
  const out = {};
  for (const r of ['1', '2']) {
    const born = dapp?.seats?.[r] || dapp?.seats?.[Number(r)];
    const P = born?.P || dapp?.seal?.[r === '1' ? 'P1' : 'P2'];
    if (!P) continue;
    const occupant = currentHolderId(r);
    if (occupant && live.includes(occupant)) continue;
    out[r] = {
      expectedP: compactPoint(P),
      bornSignerId: born?.signerId || null,
      ghost: !!occupant,
    };
  }
  return out;
}

function ethRecoverVacantView(vacantBorn = recoverableEthBornSeats()) {
  return {
    recoverVacant: vacantBorn['1'] ? 1 : vacantBorn['2'] ? 2 : 0,
    expectedP: vacantBorn['1']?.expectedP || vacantBorn['2']?.expectedP || null,
    bornSignerId: vacantBorn['1']?.bornSignerId || vacantBorn['2']?.bornSignerId || null,
    vacantBorn,
  };
}

/**
 * Has this holder shown it actually has the share for the seat it sits in?
 *
 * True for the tab that birthed the seat and for one that passed claim_born.
 * False for an unproven recovery lease — that tab is still trying to rebuild
 * the share, so it must not be treated as an authority on the seat.
 */
function ethHolderProven(role, signerId) {
  const sid = String(signerId || '');
  if (!sid) return false;
  const seat = loadEthDapp()?.seats?.[String(role)];
  if (seat?.signerId && seat.signerId === sid) return true;
  const rec = loadHolders().roles?.[String(role)];
  return !!(rec?.signerId === sid && rec.claimedBorn);
}

/**
 * A seat can be born, leased, and heartbeating and still be unable to sign: the
 * point lives here but the secret lives only in the holder's tab, and once that
 * copy goes stale nothing in `stranded`, `holder*` or the orbit shows it. The
 * signer is the only party that can know, so it reports the fault on its next
 * heartbeat and we hang it on the holder record. Cleared as soon as that signer
 * contributes anything, so a fault never outlives the condition.
 */
function recordSeatFault(rec, fault) {
  if (!rec) return;
  const reason = String(fault?.reason || '').slice(0, 300).trim();
  if (!reason) return;
  const at = new Date().toISOString();
  /**
   * `at` is the last beat that reported the fault; `since` is the first.
   *
   * A faulting tab re-reports every beat, so `at` is always a second or two old
   * and is useless for asking "how long has this been broken?". Anything that
   * times a fault out — releasing a stuck recovery lease, say — has to measure
   * from `since`, or the timer resets on every heartbeat and never fires.
   */
  const carry = rec.fault?.reason === reason ? rec.fault.since || rec.fault.at : null;
  rec.fault = { reason, at, since: carry || at };
}

async function clearSeatFault(signerId) {
  const h = loadHolders();
  let changed = false;
  for (const r of ['1', '2']) {
    if (h.roles?.[r]?.signerId === signerId && h.roles[r].fault) {
      delete h.roles[r].fault;
      changed = true;
    }
  }
  if (changed) await saveHolders(h);
}

function seatFaultOf(role) {
  return loadHolders().roles?.[String(role)]?.fault || null;
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

/**
 * One tab, both seats — undo it.
 *
 * Nothing should reach this state and the guard in enrollUnlocked now stops it
 * happening again, but a pool already in it cannot sign at all: the heartbeat
 * resolves that tab to one role, so the other seat is leased and permanently
 * unserved. Left alone it stays that way until the seat lease expires, which it
 * does not, because the tab is right there beating.
 *
 * Which seat to give up is not arbitrary. Release the one the orbit can rebuild
 * and keep the one it cannot: a seat with a live sealed pack can be handed to
 * another node and recovered, while a seat with no pack exists only in this tab
 * and taking it away would strand Q. When neither is recoverable, keep seat 1 —
 * it is the one that has to post R1 for a sweep.
 */
async function splitDoubleHeldEthSeats() {
  const h = loadHolders();
  const one = h.roles?.['1']?.signerId;
  if (!one || one !== h.roles?.['2']?.signerId) return false;
  // summary() reports shape only — never pack contents — and marks each pack
  // live or not against the seat's current P.
  const packs = ethPreshare.summary().packs || {};
  const recoverable = (r) => !!packs[String(r)]?.live;
  const give = recoverable('2') ? '2' : recoverable('1') ? '1' : '2';
  delete h.roles[give];
  await saveHolders(h);
  return true;
}

export async function maybeAbandonEthSeats() {
  await splitDoubleHeldEthSeats();
  const h = loadHolders();
  const live = liveOrbitMembers();
  const now = nowMs();
  let changed = false;
  for (const r of ['1', '2']) {
    const rec = h.roles?.[r];
    if (!rec?.signerId) continue;
    if (holderStale(rec) && !live.includes(rec.signerId)) {
      delete h.roles[r];
      changed = true;
      continue;
    }
    /**
     * A recovery lease that has gone nowhere.
     *
     * The tab took a vacant born seat to rebuild the share and has told us it
     * cannot sign. It is live, so the staleness check above will never free it,
     * and while it sits there nobody else is offered the seat — including the
     * tab that actually holds the share. Release it after the grace and note
     * the attempt so the offer moves on to the next candidate.
     */
    if (!rec.recovering || rec.claimedBorn) continue;
    /**
     * Timed from the FIRST fault report, not the latest. The tab re-reports on
     * every beat, so measuring from rec.fault.at restarts the clock each time
     * and the lease is never released — which is exactly how the first cut of
     * this let a candidate squat e2 indefinitely.
     *
     * Note the explicit '' fallbacks: Date.parse(0) is not NaN, it is the year
     * 2000, so a lease that has not reported anything yet would look infinitely
     * old and be released on its very first beat.
     */
    const faultSince = Date.parse(rec.fault?.since || rec.fault?.at || '');
    const recSince = Date.parse(rec.recoveringSince || rec.assignedAt || '');
    const failedLongEnough =
      Number.isFinite(faultSince) && now - faultSince > RECOVER_GRACE_MS;
    const silentTooLong = Number.isFinite(recSince) && now - recSince > RECOVER_SILENT_MS;
    if (!failedLongEnough && !silentTooLong) continue;
    h.recoverTried = h.recoverTried || {};
    h.recoverTried[r] = { ...(h.recoverTried[r] || {}), [rec.signerId]: new Date().toISOString() };
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

function pdlNextKey(signerId) {
  return `eth-birth-next:${String(signerId || '')}`;
}

/**
 * One signer must not birth both seats of the next Q.
 *
 * A seat is served by exactly one signer and a signer serves exactly one seat —
 * enrollUnlocked returns on its first match. So a next Q whose seats were both
 * birthed by the same tab is unsignable the instant it goes live: the cutover
 * stamps that tab into both roles, its heartbeat resolves to one of them, and
 * the other seat is leased to somebody who is busy being the first seat. That
 * is what parked the 2026-08-25 sweep at wait_r1 with encD2 already in hand.
 *
 * Refusing costs a rotation, not a pool. The next Q simply does not complete
 * until a second tab births the other seat; the current Q keeps signing the
 * whole time. Cutting over into a pool that cannot sign is the worse outcome by
 * a wide margin, and it is not self-correcting — at cutover the new seats have
 * no sealed packs yet, so the seat that gets released cannot be rebuilt by
 * anyone and the tab holding its share is busy serving the other role.
 */
/**
 * (1) Close the next Q once both seats are in.
 *
 * `address` is not stored, it is DERIVED — finalizeEthClientBornQ() recomputes
 * Q = Pdapp + P1 + P2 on every seat write, so refilling a seat silently turns
 * the next Q into a different address using the same record. The rotation phase
 * that would know better (`sweeping`) lives in pool-eth-3p-rotate.json, a file
 * the birth paths never read, which is why two lock-shaped fixes both failed to
 * stop it (2026-08-27, 2026-08-31).
 *
 * So the invariant is stamped into the record it protects: once complete, the
 * record is closed and every writer refuses it. No cross-file lock, no ordering
 * dependency, and a crash leaves it closed rather than unguarded.
 */
function closeNextIfComplete(dapp) {
  if (dapp?.seats?.[1]?.P && dapp?.seats?.[2]?.P && dapp?.address && !dapp.nextClosed) {
    dapp.nextClosed = { at: new Date().toISOString(), address: dapp.address };
  }
  return dapp;
}

function assertNextOpen(dapp) {
  if (dapp?.nextClosed?.at) {
    throw new Error(
      `next Q ${dapp.nextClosed.address} closed at ${dapp.nextClosed.at} — refusing to ` +
        'modify a completed next Q (would move the pool address). Discard it with ' +
        'eth-3p-fresh-start.mjs, or let the rotation announce a fresh one.',
    );
  }
}

/**
 * (2) One in-flight birth per next seat.
 *
 * Role 1 is a two-step handshake: birthEthSeatNext() stashes a PDL challenge and
 * returns WITHOUT writing the seat, which stays empty until finishEthSeatPdlNext().
 * pdlRam is keyed per signer, so two tabs could both see a vacant seat 1, both run
 * the ceremony, and both finish — the second overwriting the first and moving Q.
 * That is precisely the 2026-08-31 sequence.
 *
 * Deliberately in-memory: a restart should clear stale claims, and the durable
 * record is the seat itself, now protected by nextClosed above.
 */
const nextSeatClaims = new Map();
const NEXT_SEAT_CLAIM_MS = 120000;

function claimNextSeat(role, sid) {
  const k = String(role);
  const cur = nextSeatClaims.get(k);
  if (cur && cur.signerId !== sid && Date.now() - cur.at < NEXT_SEAT_CLAIM_MS) {
    const held = Math.round((Date.now() - cur.at) / 1000);
    throw new Error(
      `next e${Number(role)} is already being birthed by ${cur.signerId} (${held}s ago) — ` +
        'one birth per seat at a time; wait for it to finish or for the claim to expire',
    );
  }
  nextSeatClaims.set(k, { signerId: sid, at: Date.now() });
}

function releaseNextSeat(role, sid) {
  const k = String(role);
  const cur = nextSeatClaims.get(k);
  if (cur && cur.signerId === sid) nextSeatClaims.delete(k);
}

export function resetNextSeatClaims() {
  nextSeatClaims.clear();
}

function assertNotBothNextSeats(dapp, role, sid) {
  const other = Number(role) === 1 ? '2' : '1';
  const seat = dapp?.seats?.[other] || dapp?.seats?.[Number(other)];
  if (seat?.P && seat.signerId && seat.signerId === sid) {
    throw new Error(
      `next e${other} was already birthed by this signer — one tab cannot hold both seats ` +
        'of the next Q, because it can only ever serve one of them. Another node must birth ' +
        `next e${Number(role)}.`,
    );
  }
}

export async function birthEthSeatNext({
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
  const dapp = loadEthNext();
  if (!dapp?.Pdapp) throw new Error('no next ETH 3P dapp');
  assertNextOpen(dapp);
  dapp.seats = dapp.seats || { 1: null, 2: null };
  const compressed = compactPoint(P);
  secp256k1.ProjectivePoint.fromHex(compressed);
  schnorrVerifyDlog(pok, compressed, seatPokContext('birth-next', r, compressed));
  const existingP = compactPoint(dapp.seats?.[r]?.P || '');
  if (existingP && existingP !== compressed) {
    throw new Error(`next e${r} already born`);
  }
  assertNotBothNextSeats(dapp, r, sid);
  claimNextSeat(r, sid);
  if (r === 1) {
    if (!encD1 || !paillierN || !paillierG) {
      throw new Error('next e1 needs Enc(e1) + Paillier');
    }
    assertPaillierModulus(paillierN, { what: 'next e1 Paillier N' });
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
    pdlRam.set(pdlNextKey(sid), {
      ch,
      P: compressed,
      encD1: String(encD1),
      paillierN: String(paillierN),
      paillierG: String(paillierG),
      signerId: sid,
    });
    return { ok: true, role: 1, nextQ: true, needPdl: true, pdl: pdlChallengePublic(ch) };
  }
  dapp.seats[2] = { P: compressed, bornAt: new Date().toISOString(), signerId: sid, pokOk: true };
  finalizeEthClientBornQ(dapp);
  closeNextIfComplete(dapp);
  await writeEthNext(dapp);
  releaseNextSeat(2, sid);
  return {
    ok: true,
    role: 2,
    nextQ: true,
    address: dapp.address || null,
    ready: !!(dapp.seats[1]?.P && dapp.seats[2]?.P),
    seal: dapp.seal || null,
  };
}

export function openEthSeatPdlNext({ signerId, comQ }) {
  const row = pdlRam.get(pdlNextKey(signerId));
  if (!row?.ch) throw new Error('LINDELL_PDL: no pending next-e1 challenge');
  row.comQ = String(comQ);
  return { ok: true, nextQ: true, needPdl: true, ...pdlVerifierOpen(row.ch) };
}

export async function finishEthSeatPdlNext({ signerId, Qhat, nonceQ, comQ }) {
  const sid = String(signerId || '').trim();
  const row = pdlRam.get(pdlNextKey(sid));
  if (!row?.ch) throw new Error('LINDELL_PDL: no pending next-e1 challenge');
  pdlVerifierAccept({ ch: row.ch, Qhat, nonceQ, comQ: comQ || row.comQ });
  const dapp = loadEthNext();
  if (!dapp) throw new Error('no next ETH 3P dapp');
  assertNextOpen(dapp);
  dapp.seats = dapp.seats || { 1: null, 2: null };
  // seats[1] is not written until this point, so the check in birthEthSeatNext
  // saw a seat that did not exist yet. A tab that opened e1, birthed e2 while
  // the challenge was outstanding, and came back here would otherwise land both.
  assertNotBothNextSeats(dapp, 1, row.signerId || sid);
  /**
   * Same reasoning as the line above, for the seat this call is about to write.
   *
   * birthEthSeatNext() rejects a re-birth with `next e${r} already born`, but
   * that check ran when the PDL challenge was issued — seats[1] can have been
   * filled by another node while the challenge was outstanding. Writing it
   * anyway makes finalizeEthClientBornQ() recompute Q and silently move the
   * next pool address, which is how the 2026-08-31 sweep/next mismatch stranded
   * a swept balance. A next Q that is genuinely stuck is discarded with
   * eth-3p-fresh-start.mjs, never by overwriting a seat that is already born.
   */
  const bornP = compactPoint(dapp.seats?.[1]?.P || '');
  if (bornP && bornP !== compactPoint(row.P)) {
    throw new Error(
      `next e1 was already birthed by ${dapp.seats[1]?.signerId || 'another node'} — ` +
        'refusing to replace it (would move the next pool address out from under ' +
        'an in-flight sweep)',
    );
  }
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
  closeNextIfComplete(dapp);
  await writeEthNext(dapp);
  releaseNextSeat(1, row.signerId || sid);
  pdlRam.delete(pdlNextKey(sid));
  return {
    ok: true,
    role: 1,
    nextQ: true,
    address: dapp.address || null,
    ready: !!(dapp.seats[1]?.P && dapp.seats[2]?.P),
    seal: dapp.seal || null,
    pdlOk: true,
  };
}

export async function openEthSweepPayout({ toAddress, ticketId }) {
  const dapp = loadEthDapp();
  if (!dapp?.address || !dapp?.ckeyD1) throw new Error('live ETH 3P not ready');
  const to = String(toAddress || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(to)) throw new Error('sweep toAddress 0x… required');
  const { JsonRpcProvider } = await import('ethers-v6');
  const provider = new JsonRpcProvider(ETH_RPC);
  const bal = await provider.getBalance(dapp.address);
  const gas = 21000n;
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || 1n;
  const fee = gas * gasPrice;
  if (bal <= fee) {
    return { ok: true, skipped: true, reason: 'dust only', liveBalanceWei: bal.toString() };
  }
  const valueWei = bal - fee;
  // Same gasPrice snapshot as the value shrink — a second getFeeData() in
  // buildEthUnsigned is how a sweep froze 1 gwei leftover against a 3 gwei
  // gasPrice and then failed assertLiveEthCanPay forever (2026-08-30).
  const unsigned = await buildEthUnsigned({
    to,
    valueWei: valueWei.toString(),
    gasPrice,
  });
  const id = String(ticketId || `eth-rotate-${Date.now()}`);
  const s = loadEthSess();
  s.tickets = s.tickets || {};
  if (s.tickets[id]?.status === 'paid') {
    return { ok: true, alreadyPaid: true, ticketId: id, ...ticketView(s.tickets[id]) };
  }
  s.tickets[id] = {
    ticketId: id,
    status: 'open',
    room: true,
    kind: 'rotate-sweep',
    amountWei: unsigned.tx.value,
    amountE8: (BigInt(unsigned.tx.value) / 10n ** 10n).toString(),
    toAddress: to,
    hashHex: unsigned.hashHex,
    prep: { ...unsigned, hashHex: unsigned.hashHex },
    openedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveEthSess(s);
  return { ok: true, ticketId: id, ...ticketView(s.tickets[id]) };
}

/**
 * Rebuild a rotate-sweep's unsigned tx from the live Q's current balance and
 * gas. Clears R1/D2 so e1 posts a fresh k1 (old R1 + new hash is nonce reuse).
 *
 * The 2026-08-30 sweep sat at `partial` for hours because e1 *did* finish:
 * eth3pSubmit then refused a 3 gwei fee on a value sized for 1 gwei leftover.
 */
export async function refreshEthSweepTicket(ticketId) {
  const s = loadEthSess();
  const t = s.tickets?.[String(ticketId)];
  if (!t || t.status === 'paid' || t.status === 'abandoned') return { ok: false, skipped: true };
  if (t.kind !== 'rotate-sweep' && !String(t.ticketId || '').startsWith('eth-rotate')) {
    return { ok: false, skipped: true };
  }
  const dapp = loadEthDapp();
  const from = String(t.prep?.from || dapp?.address || '').toLowerCase();
  if (!from) return { ok: false, skipped: true };
  const { JsonRpcProvider } = await import('ethers-v6');
  const provider = new JsonRpcProvider(ETH_RPC);
  const bal = await provider.getBalance(from);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || 1n;
  const gasLimit = BigInt(t.prep?.tx?.gasLimit || 21000);
  const frozenPrice = BigInt(t.prep?.tx?.gasPrice || 0);
  const frozenValue = BigInt(t.prep?.tx?.value || t.amountWei || 0);
  const need = frozenValue + gasLimit * frozenPrice;
  if (bal >= need && frozenPrice === gasPrice) return { ok: true, unchanged: true, ticketId: t.ticketId };
  const fee = 21000n * gasPrice;
  if (bal <= fee) return { ok: true, skipped: true, reason: 'dust only', liveBalanceWei: bal.toString() };
  const unsigned = await buildEthUnsigned({
    to: t.toAddress,
    valueWei: (bal - fee).toString(),
    gasPrice,
  });
  t.amountWei = unsigned.tx.value;
  t.amountE8 = (BigInt(unsigned.tx.value) / 10n ** 10n).toString();
  t.hashHex = unsigned.hashHex;
  t.prep = { ...unsigned, hashHex: unsigned.hashHex };
  t.haveR1 = false;
  t.haveD2 = false;
  t.status = 'open';
  t.room = true;
  delete t.R1Hex;
  delete t.rHex;
  delete t.RHex;
  delete t.R2Hex;
  delete t.Q2Hex;
  delete t.ciphertext;
  delete t.ckeyAdj;
  delete t.pokR;
  delete t.pokC;
  delete t.r1SignerId;
  t.updatedAt = Date.now();
  ETH_RAM_D2.delete(t.ticketId);
  await saveEthSess(s);
  return { ok: true, repriced: true, ticketId: t.ticketId, amountWei: t.amountWei };
}

function enrollPayload(role, signerId, already, recover = false) {
  const dapp = loadEthDapp() || {};
  const born = !!(dapp.seats?.[role]?.P || dapp.seats?.[String(role)]?.P);
  const seat = dapp.seats?.[role] || dapp.seats?.[String(role)] || null;
  return {
    /**
     * The seat was handed over vacant and the tab is not its birther: it must
     * rebuild d_r (stale local copy, or sealed-preshare reseal) and prove it
     * with claim_born. needBirth stays false — birthing here would move Q.
     */
    recover: !!recover,
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
      ? recover
        ? `e${role} was vacant. Rebuild its share and claim_born — do NOT birth (that moves Q).`
        : `You are e${role}. Hex stays in this tab.`
      : `Birth e${role} in this tab (makeClientSeat). VPS stores the point` +
        (role === 1 ? ' + Enc(e1).' : '.'),
  };
}

function unbornLeaseExpired(rec, born) {
  if (born?.P) return false;
  if (!rec?.signerId) return true;
  const assigned = Date.parse(rec.assignedAt || rec.lastSeen || 0);
  if (!Number.isFinite(assigned)) return true;
  return nowMs() - assigned > BIRTH_GRACE_MS;
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

  /**
   * Durable seat ownership beats fresh assignment.
   *
   * `dapp.seats[r].signerId` is the birth record and outlives the holder lease,
   * which maybeAbandonEthSeats() deletes as soon as a tab misses SEAT_IDLE_MS.
   * Without this pass a returning owner falls through to the generic loop below,
   * which walks roles in order '1','2' — so the tab that birthed e2 gets handed
   * a vacant e1, births a second share, and e2 is stranded forever: its point P
   * still pins the seat to that signerId, but the tab is now serving role 1 and
   * the loop returns before it can ever be offered its own seat back.
   *
   * That is exactly how seat 2 died on 2026-08-23 (both seats ended up stamped
   * eth-node-0d02881d, holder2 null, 4 live nodes, nobody able to claim it).
   *
   * Re-attaching the owner to its own seat is the only safe repair: seats[r].P
   * is a term of the aggregate key (Q = Pdapp + P1 + P2), so deleting a born
   * seat and re-birthing it silently MOVES THE POOL ADDRESS and strands any
   * funds sitting at the old one. Never auto-clear a born seat here — parking
   * the whole Q via eth-3p-fresh-start.mjs is the only correct way to discard
   * one, and that is a deliberate operator action.
   */
  const liveOnReattach = liveOrbitMembers();
  for (const r of ['1', '2']) {
    const seat = dapp?.seats?.[r] || dapp?.seats?.[Number(r)];
    if (!seat?.P || !seat.signerId || seat.signerId !== sid) continue;
    const rec = h.roles[r];
    const takingItBack = !!(rec?.signerId && rec.signerId !== sid);
    if (takingItBack) {
      /**
       * Yield only to an occupant that can actually sign.
       *
       * "Let them finish" was right when every lease meant a tab that had the
       * share. Recovery leases broke that: they are handed to a tab that does
       * *not* have it yet, on the chance it can rebuild one — so deferring to
       * them locks the seat's real owner, the one node certain to have had the
       * share, out of its own seat for the whole grace period. Seen live on
       * 2026-08-25: 775bd5cc held a working e2 and beat every few seconds while
       * d6da686d sat on the lease unable to sign a thing.
       *
       * A proven occupant still wins — that is either this seat's own dealer or
       * a tab that passed claim_born, and taking the seat off one of those is
       * how you strand a share that is signing perfectly well.
       */
      if (liveOnReattach.includes(rec.signerId) && ethHolderProven(Number(r), rec.signerId)) {
        continue;
      }
      /**
       * Unless we are the one who just failed. maybeAbandonEthSeats() releases
       * a faulting lease at the top of the very heartbeat that re-enrolls us,
       * so without this an owner whose own share has gone stale takes the seat
       * straight back every grace period and no candidate is ever offered it.
       */
      const failedAt = Date.parse(h.recoverTried?.[r]?.[sid] || '');
      if (Number.isFinite(failedAt) && nowMs() - failedAt < RECOVER_RETRY_MS) continue;
    }
    const ts = new Date().toISOString();
    h.roles[r] = {
      signerId: sid,
      assignedAt: takingItBack ? ts : rec?.assignedAt || ts,
      lastSeen: ts,
      /**
       * Taking a seat back is a claim, not a proof. The owner is the best bet
       * available, but its copy of the share can be stale — that is the whole
       * reason the seat was up for grabs. Carrying the recovery marks puts it
       * on the same clock as any other candidate, so an owner that also cannot
       * sign is released and rotated instead of squatting a seat nobody else
       * can be offered.
       */
      ...(takingItBack ? { recovering: true, recoveringSince: ts, tookBackFrom: rec.signerId } : {}),
    };
    await saveHolders(h);
    return enrollPayload(Number(r), sid, true, takingItBack);
  }

  /**
   * Recovery lease on a born seat whose owner is not here.
   *
   * Reaching this point means the birth record names someone else, so the pass
   * above declined and the generic loop below will skip the seat outright — a
   * born seat is never offered to a different signerId. That guard is right
   * against re-birthing (P is a term of Q; a second birth moves the pool
   * address) but it also made a vacated seat permanently unfillable: e2's
   * birther closed its tab, so nothing could take the seat, no redeem could
   * reach wait_d2 -> signed, and rotation jammed behind the open room.
   *
   * The seat is handed over *vacant and unproven*: P and the birth record are
   * untouched, so Q cannot move, and enrollPayload carries recover:true so the
   * tab rebuilds d_r (its own stale copy, or the sealed preshare pack) and
   * proves it through claim_born rather than birthing anything. Until it does,
   * ethHolderProven() keeps it from repacking the seat's recovery material.
   *
   * Candidates are tried one at a time and passed over once they report they
   * cannot sign (see maybeAbandonEthSeats), so a wrong tab cannot squat the
   * seat and lock out the one that actually holds the share.
   */
  const liveNow = liveOrbitMembers();
  for (const r of ['1', '2']) {
    const seat = dapp?.seats?.[r] || dapp?.seats?.[Number(r)];
    if (!seat?.P) continue;
    if (!seat.signerId || seat.signerId === sid) continue;
    // Someone is already sitting in it (or actively recovering it).
    const rec = h.roles[r];
    if (rec?.signerId && (rec.signerId === sid || liveNow.includes(rec.signerId))) continue;
    /**
     * Its real owner is live — it reattaches on its own beat and now takes the
     * seat back off an unproven lease, so stepping in here just loses it again
     * one beat later. The exception is an owner that was itself released for
     * failing to sign: it is live but has shown it cannot serve the seat, and
     * deferring to it forever would leave the seat empty with nobody eligible.
     */
    const ownerFailedAt = Date.parse(h.recoverTried?.[r]?.[seat.signerId] || '');
    const ownerJustFailed =
      Number.isFinite(ownerFailedAt) && nowMs() - ownerFailedAt < RECOVER_RETRY_MS;
    /**
     * An owner sitting in the *other* seat is never coming back for this one:
     * enrollUnlocked returns on its first match, so it is serving that role and
     * only that role. seatStranded() already calls this out; deferring to it
     * here anyway is what would leave the seat vacant with nobody allowed in.
     */
    const otherRole = r === '1' ? '2' : '1';
    const ownerParkedElsewhere = h.roles[otherRole]?.signerId === seat.signerId;
    if (liveNow.includes(seat.signerId) && !ownerJustFailed && !ownerParkedElsewhere) continue;
    /**
     * One seat per signer: taking a second would orphan the one we hold d for.
     * This is also what makes a node ineligible as a *candidate*, which the
     * fairness check below depends on.
     */
    const eligible = (id) => {
      if (!id || id === ETH3P_ORBIT_VPS_ID) return false;
      return !['1', '2'].some((x) => {
        if (x === r) return false;
        const o = dapp?.seats?.[x] || dapp?.seats?.[Number(x)];
        return !!(o?.P && o.signerId === id) || h.roles[x]?.signerId === id;
      });
    };
    if (!eligible(sid)) continue;
    // Recently tried and reported it cannot sign — let another tab have a turn.
    const triedRecently = (id) => {
      const t = Date.parse(h.recoverTried?.[r]?.[id] || '');
      return Number.isFinite(t) && nowMs() - t < RECOVER_RETRY_MS;
    };
    if (triedRecently(sid)) {
      /**
       * Only defer to a node that could actually take the seat. Counting an
       * ineligible one — the holder of the other seat, say — as "waiting for a
       * turn" deadlocks the rotation: every real candidate steps aside for a
       * node that can never step forward, and the seat stays vacant forever.
       * Once every eligible node has had a turn the round starts over, so a tab
       * that gains the share later still gets offered the seat.
       */
      const others = liveNow.filter((id) => id !== sid && eligible(id));
      if (others.some((id) => !triedRecently(id))) continue;
      /**
       * Every eligible tab has had a turn, so a new round starts — but not with
       * the tab that just failed. maybeAbandonEthSeats() releases the lease at
       * the top of the very heartbeat that then re-enrolls the same signer, so
       * without this the released tab retakes the seat within one call and no
       * other tab is ever offered it again. Going in least-recently-tried order
       * makes the rotation fair and keeps every tab reachable.
       */
      const mine = Date.parse(h.recoverTried?.[r]?.[sid] || '');
      const staler = others.some((id) => {
        const t = Date.parse(h.recoverTried?.[r]?.[id] || '');
        return Number.isFinite(t) && Number.isFinite(mine) && t < mine;
      });
      if (staler) continue;
    }
    const ts = new Date().toISOString();
    h.roles[r] = { signerId: sid, assignedAt: ts, lastSeen: ts, recovering: true, recoveringSince: ts };
    await saveHolders(h);
    return enrollPayload(Number(r), sid, false, true);
  }

  for (const r of ['1', '2']) {
    const born = dapp?.seats?.[r] || dapp?.seats?.[Number(r)];
    if (born?.P && born.signerId && born.signerId !== sid) continue;
    // Never let a signer that already owns a born seat take a second one. The
    // reattach pass above has already returned if this sid owns a seat, so
    // reaching here with ownership means its own seat is leased elsewhere —
    // taking a different seat would orphan the one it holds the secret for.
    const ownsOtherSeat = ['1', '2'].some((x) => {
      if (x === r) return false;
      const s = dapp?.seats?.[x] || dapp?.seats?.[Number(x)];
      return !!(s?.P && s.signerId && s.signerId === sid);
    });
    if (ownsOtherSeat) continue;
    const rec = h.roles[r];
    if (rec?.signerId && rec.signerId !== sid && !unbornLeaseExpired(rec, born)) {
      continue;
    }
    h.roles[r] = {
      signerId: sid,
      assignedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    await saveHolders(h);
    return enrollPayload(Number(r), sid, false);
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

/**
 * Take a born seat by proving possession of its share — the ETH twin of
 * pool3p's claimBornSeat(), and the only safe way to repopulate e1/e2.
 *
 * The seat's P is left exactly as it is, so Q = Pdapp + P1 + P2 does not move
 * and the pool address and its balance stay put. All that changes is who is
 * recognised as holding d_r, and the claim is only granted to a tab that can
 * show dlog(P) — a Schnorr proof, so the share itself never leaves the browser.
 *
 * The birth record follows the proof: a profile that regenerated its signerId
 * (or a tab that rebuilt the share from the sealed pack) becomes the seat's
 * durable owner, so the next reconnect reattaches normally instead of falling
 * back into the recovery path. The previous id is kept for audit.
 */
export async function claimBornEthSeat({ signerId, role, shareHex, pok }) {
  const r = Number(role);
  if (r !== 1 && r !== 2) throw new Error('role must be 1 or 2');
  const sid = String(signerId || '').trim();
  if (sid.length < 16) throw new Error('signerId required');
  return withEthLock(async () => {
    await ensureEth3pDapp();
    const dapp = loadEthDapp() || {};
    const want = compactPoint(
      dapp.seats?.[String(r)]?.P || dapp.seal?.[r === 1 ? 'P1' : 'P2'] || '',
    );
    if (!want) throw new Error('seat has no live P');
    if (pok) {
      schnorrVerifyDlog(pok, want, seatPokContext('claim', r, want));
    } else if (shareHex) {
      // Legacy path for tabs without the proof. It puts e_r on the VPS, so it
      // stays available only because a stranded seat is worse.
      const d = BigInt('0x' + String(shareHex).replace(/^0x/i, ''));
      if (!(d > 0n)) throw new Error('claim denied — bad shareHex');
      const got = pointToCompressedHex(G.multiply(d)).toLowerCase();
      if (got !== want) {
        throw new Error(`claim denied — e${r}·G ≠ P${r} (this tab is not the seat's dealer)`);
      }
    } else {
      throw new Error('claim denied — need Schnorr pok of dlog(P) (or shareHex on legacy rebuild)');
    }

    const h = loadHolders();
    h.roles = h.roles || {};
    const occupant = h.roles[String(r)]?.signerId || null;
    const live = liveOrbitMembers();
    // A live *proven* holder outranks a claim; an unproven recovery lease does
    // not — the whole point is that the tab with the share takes it back.
    if (occupant && occupant !== sid && live.includes(occupant) && ethHolderProven(r, occupant)) {
      throw new Error(`claim denied — current e${r} holder is live`);
    }
    const ts = new Date().toISOString();
    h.roles[String(r)] = { signerId: sid, assignedAt: ts, lastSeen: ts, claimedBorn: true };
    if (h.recoverTried?.[String(r)]) delete h.recoverTried[String(r)];
    await saveHolders(h);

    const seat = dapp.seats?.[String(r)];
    if (seat && seat.signerId !== sid) {
      seat.signerIdPrev = seat.signerId || null;
      seat.signerId = sid;
      seat.claimedBornAt = ts;
      // P is deliberately untouched — rewriting it is what moves Q.
      await writeEthDapp(dapp);
    }
    return enrollPayload(r, sid, true);
  });
}

export async function heartbeatEth3p({ signerId, seatEpoch, seatFault, nodePubHex, attestation } = {}) {
  const sid = String(signerId || '').trim();
  if (!sid) throw new Error('signerId required');
  return withEthLock(async () => {
    await ensureEth3pDapp();
    await maybeAbandonEthSeats();
    await touchOrbit(sid);
    // Public key so other seats can seal pieces to this node, and its signed
    // presence claim. Stored verbatim and never trusted here.
    if (nodePubHex) {
      await ethPreshare.rememberNode({ signerId: sid, pubHex: nodePubHex, attestation }).catch(() => null);
    }
    const h = loadHolders();
    let role = 0;
    for (const r of ['1', '2']) {
      // First match wins, matching enrollUnlocked. Without the break a signer
      // holding both leases silently reports the *last* one, so seat 1 looks
      // occupied while nothing on the wire ever serves it.
      if (role) break;
      if (h.roles?.[r]?.signerId === sid) {
        role = Number(r);
        h.roles[r].lastSeen = new Date().toISOString();
        if (seatFault) {
          recordSeatFault(h.roles[r], seatFault);
        } else {
          delete h.roles[r].fault;
          /**
           * A fault-free beat from a holder that is proven for this seat ends
           * the probation a take-back put it on. Without this the marks stay
           * forever and one transient fault months later — a rotate, a reload —
           * would hand the seat away from a tab that has been signing all along.
           */
          if (h.roles[r].recovering && ethHolderProven(Number(r), sid)) {
            delete h.roles[r].recovering;
            delete h.roles[r].recoveringSince;
            delete h.roles[r].tookBackFrom;
          }
        }
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
    if (role > 0) {
      // Keep telling a recovery holder to recover: it must rebuild the share
      // and claim_born, never birth, or the pool address moves.
      const rec = loadHolders().roles?.[String(role)];
      share = enrollPayload(role, sid, !justClaimed, !!(rec?.recovering && !rec?.claimedBorn));
    }
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
      orbitKeys: ethPreshare.orbitKeys(live),
      // Born seat sitting empty that this tab may take and prove with
      // eth3p_claim_born. Nothing offered a pickup before, so a vacated seat
      // stayed vacant while its sealed pack went unused.
      ...ethRecoverVacantView(),
      // Pieces this node should reseal for a tab trying to recover a seat.
      resealRequests: ethPreshare.pendingFor(sid),
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
      lastPaid: lastPaidEthTicket(),
      signed: lastPaidEthTickets(),
    };
  });
}

export async function publicEth3pStatus() {
  await ensureEth3pDapp();
  const d = loadEthDapp() || {};
  const live = liveOrbitMembers();
  await stampUnstampedWrapEpochs().catch(() => null);
  const wraps = loadWraps();
  const liveEpoch = await fetchAnvilGenesis();
  const wrapViews = (wraps.wraps || []).map((w) => wrapStatusView(w, liveEpoch));
  let wrapOutstandingE8 = 0n;
  let wrapOrphanedE8 = 0n;
  for (const w of wrapViews) {
    wrapOutstandingE8 += BigInt(w.outstandingE8 || '0');
    wrapOrphanedE8 += BigInt(w.orphanedE8 || '0');
  }
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
    e1Born: !!(d.seats?.[1]?.P || d.seats?.['1']?.P),
    e2Born: !!(d.seats?.[2]?.P || d.seats?.['2']?.P),
    needBirth: {
      1: !(d.seats?.[1]?.P || d.seats?.['1']?.P),
      2: !(d.seats?.[2]?.P || d.seats?.['2']?.P),
    },
    e1Live: !!(
      (d.seats?.[1]?.P || d.seats?.['1']?.P) &&
      currentHolderId(1) &&
      live.includes(currentHolderId(1))
    ),
    e2Live: !!(
      (d.seats?.[2]?.P || d.seats?.['2']?.P) &&
      currentHolderId(2) &&
      live.includes(currentHolderId(2))
    ),
    /**
     * A seat is stranded when it is born (its P is a term of the aggregate key,
     * so the seat cannot be reassigned or discarded) but the signer that birthed
     * it is not in the live orbit — the secret share exists only in that tab.
     *
     * Without this, the condition reads as an ordinary vacancy: seatsReady true,
     * needBirth false, holder null. Nothing asks anyone to birth it and nobody
     * can claim it, so it just sits empty. Surfacing it tells the operator the
     * only real remedy is bringing that exact browser profile back, or parking
     * the Q with eth-3p-fresh-start.mjs and re-birthing both seats.
     */
    stranded: {
      1: seatStranded(d, 1, live),
      2: seatStranded(d, 2, live),
    },
    // Which born seat is free for a proven pickup, and the P a claimant must
    // prove dlog of. A stranded seat is only fatal if nothing can claim it.
    ...ethRecoverVacantView(recoverableEthBornSeats(live)),
    /**
     * Reported by the seat holder itself when it cannot sign for the live Q —
     * the one failure the coordinator cannot infer. A seat with a fault looks
     * healthy by every other measure, so treat this as the authoritative
     * "e1/e2 will never answer" signal.
     */
    seatFault: {
      1: seatFaultOf(1),
      2: seatFaultOf(2),
    },
    Pdapp: d.Pdapp || null,
    seal: d.seal || null,
    hasCkeyE1: !!(d.ckeyD1 || d.seats?.[1]?.encD1),
    hasFullKey: false,
    paillierN: d.paillierN || d.seats?.[1]?.paillierN || null,
    paillierG: d.paillierG || d.seats?.[1]?.paillierG || null,
    burnBin: ETH_BURN_BIN,
    l1Epoch: liveEpoch,
    wraps: wrapViews.slice(-20),
    wrapOutstandingE8: wrapOutstandingE8.toString(),
    wrapOrphanedE8: wrapOrphanedE8.toString(),
    credits: (wraps.credits || []).slice(-20),
    burns: (wraps.burns || []).slice(-20),
    open: listOpenEthTickets().map(ticketView),
    lastPaid: lastPaidEthTicket(),
    signed: lastPaidEthTickets(),
    orbit: {
      liveCount: live.length,
      live,
      leaseMs: ORBIT_LIVE_MS,
    },
    adapter: await eth3pAdapterStatus(),
  };
}

async function eth3pAdapterStatus() {
  const cfg = loadEth3pAdapterFile();
  if (!cfg?.address) {
    return { ok: false, deployed: false, error: 'not deployed' };
  }
  const sync = await maybeSyncEth3pAdapter();
  try {
    const { JsonRpcProvider, Contract } = await import('ethers-v6');
    const provider = new JsonRpcProvider(ETH_RPC);
    const c = new Contract(cfg.address, ETH3P_ADAPTER_ABI, provider);
    const [pool, bal] = await Promise.all([c.pool(), provider.getBalance(cfg.address)]);
    return {
      ok: true,
      deployed: true,
      address: cfg.address,
      pool: String(pool).toLowerCase(),
      liveQ: String(loadEthDapp()?.address || '').toLowerCase() || null,
      poolMatch: String(pool).toLowerCase() === String(loadEthDapp()?.address || '').toLowerCase(),
      adapterWei: bal.toString(),
      custody: 'eth-3p-eoa',
      sync: sync || null,
    };
  } catch (e) {
    return {
      ok: false,
      deployed: true,
      address: cfg.address,
      error: e?.message || String(e),
      sync: sync || null,
    };
  }
}

function weiToE8(wei) {
  const w = BigInt(String(wei || '0'));
  return w / 10n ** 10n;
}

function weiToEthLabel(wei) {
  const w = BigInt(String(wei || '0'));
  const whole = w / 10n ** 18n;
  const frac = (w % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

async function assertLiveEthCanPay({ from, valueWei, gasLimit, gasPrice }) {
  const { JsonRpcProvider } = await import('ethers-v6');
  const provider = new JsonRpcProvider(ETH_RPC);
  const addr = String(from || loadEthDapp()?.address || '');
  if (!addr) throw new Error('live ETH 3P address missing');
  const bal = await provider.getBalance(addr);
  const value = BigInt(String(valueWei || '0'));
  const fee = BigInt(String(gasLimit || 21000)) * BigInt(String(gasPrice || 0) || 0);
  const need = value + fee;
  if (bal < need) {
    throw new Error(
      `live ETH Q ${addr} has ${weiToEthLabel(bal)} ETH, need ${weiToEthLabel(need)} ` +
        `(short ${weiToEthLabel(need - bal)}) — frozen sweep gas/value no longer fits`,
    );
  }
  return { addr, bal, need };
}

/**
 * Every address that has been a pool Q — live, pending, previous, and the
 * retired ones parked as leftover-eth3p-*.json by each rotation.
 *
 * Used to decide whether a lock paid "the pool", which is a different question
 * from whether it paid the address that happens to be live right now.
 */
export function knownPoolQAddresses() {
  const set = new Set();
  const add = (a) => {
    const s = String(a || '').toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(s)) set.add(s);
  };
  add(loadEthDapp()?.address);
  add(loadEthNext()?.address);
  const rot = loadJson(ETH_ROTATE_PATH, null);
  for (const k of ['address', 'previous', 'pending']) add(rot?.[k]);
  add(rot?.last?.address);
  add(rot?.last?.previous);
  for (const r of rot?.history || []) {
    add(r?.address);
    add(r?.previous);
  }
  try {
    for (const f of readdirSync(path.dirname(ETH_DAPP_PATH))) {
      if (/^leftover-eth3p-.*\.json$/.test(f)) {
        add(loadJson(path.join(path.dirname(ETH_DAPP_PATH), f), null)?.address);
      }
    }
  } catch {
    /* best effort — the live/rotate addresses above are the important ones */
  }
  return set;
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

  // ── the lock must actually exist on chain, via the deposit adapter ──────
  // Direct sends to the 3P Q are no longer credited. The adapter forwards
  // msg.value to the Q in the same tx and posts InputBox, so Cartesi (once
  // baked) and this host both see an L1-authenticated deposit. Adapter
  // balance stays 0; spend is still e1+e2.
  const { JsonRpcProvider } = await import('ethers-v6');
  const provider = new JsonRpcProvider(ETH_RPC);
  const onchain = await provider.getTransaction(`0x${tx}`).catch(() => null);
  if (!onchain) {
    throw new Error(`ETH tx ${tx.slice(0, 12)}… not found on ${ETH_RPC} — nothing was locked`);
  }
  const qAddr = String(dapp.address || '').toLowerCase();
  const knownQs = knownPoolQAddresses();
  const paidTo = String(onchain.to || '').toLowerCase();
  const adapter = loadEth3pAdapterFile();
  if (!adapter?.address) {
    throw new Error(
      'ETH deposit adapter is not deployed — cannot credit a lock (run scripts/deploy-eth3p-adapter.mjs)',
    );
  }
  if (paidTo !== adapter.address) {
    throw new Error(
      `ETH deposits go through the adapter (${adapter.address}), not the 3P Q. ` +
        `tx ${tx.slice(0, 12)}… paid ${paidTo || '<contract creation>'} ` +
        `(live Q is ${qAddr}). Direct sends are not credited.`,
    );
  }
  const onchainWei = BigInt(onchain.value ?? 0n);
  if (onchainWei !== wei) {
    throw new Error(
      `claimed ${wei} wei but tx ${tx.slice(0, 12)}… carried ${onchainWei} wei`,
    );
  }
  const rcpt = await provider.getTransactionReceipt(`0x${tx}`).catch(() => null);
  if (!rcpt) {
    throw new Error(
      `ETH tx ${tx.slice(0, 12)}… is not mined yet — wait for a confirmation and retry`,
    );
  }
  if (Number(rcpt.status) !== 1) {
    throw new Error(`ETH tx ${tx.slice(0, 12)}… reverted — no ETH reached the Q`);
  }
  const ev = await parseAdapterDepositEthers(rcpt, adapter.address);
  if (!ev) {
    throw new Error(
      `ETH tx ${tx.slice(0, 12)}… hit the adapter but emitted no Deposited event`,
    );
  }
  if (!knownQs.has(ev.pool)) {
    throw new Error(
      `adapter forwarded to ${ev.pool}, which is not a pool Q (live Q is ${qAddr})`,
    );
  }
  if (ev.amountWei !== wei) {
    throw new Error(
      `claimed ${wei} wei but adapter Deposited ${ev.amountWei} wei`,
    );
  }
  if (ev.wartAddress && ev.wartAddress !== wart) {
    throw new Error(
      `tx locked for Warthog ${ev.wartAddress}, not ${wart}`,
    );
  }
  const adapterBal = await provider.getBalance(adapter.address);
  if (adapterBal !== 0n) {
    throw new Error(
      `adapter ${adapter.address} holds ${adapterBal} wei after deposit — it must not custody ETH`,
    );
  }
  // Prefer the chain's sender over the caller's claim: it is the same field,
  // but one of them is attested and the other is a request body.
  const senderEth = ev.depositor || String(onchain.from || '').toLowerCase() || null;

  // The full `wei` stays in the Q; only what may be minted against it is
  // reduced. remainingE8 is the mint quota, amountE8 the ETH actually held.
  // Dust deposits credit zero headroom rather than throwing — the ETH has
  // already been forwarded and rejecting would strand it with no row.
  const grossE8 = weiToE8(wei);
  const feeE8 = ethDepositFeeE8(grossE8);
  const creditableE8 = grossE8 > feeE8 ? grossE8 - feeE8 : 0n;
  const feeTakenE8 = grossE8 > feeE8 ? feeE8 : grossE8;
  const credit = {
    id: `eth-lock-${tx.slice(0, 16)}`,
    ethTxHash: tx,
    fromEth: senderEth || (fromEth ? String(fromEth).toLowerCase() : null),
    via: 'eth3p-adapter',
    // `to` is the Q that actually received the forward, which is not always
    // the live one — a lock placed just before a rotation pays the outgoing Q
    // and is swept forward.
    verified: {
      to: ev.pool,
      adapter: adapter.address,
      liveQAtCredit: qAddr,
      valueWei: onchainWei.toString(),
      block: rcpt.blockNumber ?? null,
      inputHash: ev.inputHash,
    },
    wartAddress: wart,
    amountWei: wei.toString(),
    amountE8: grossE8.toString(),
    feeE8: feeTakenE8.toString(),
    remainingE8: creditableE8.toString(),
    l1Epoch: await fetchAnvilGenesis(),
    at: new Date().toISOString(),
  };
  wraps.credits = wraps.credits || [];
  wraps.credits.push(credit);
  await saveWraps(wraps);
  return { ok: true, credit };
}

async function inspectEth3pSnap() {
  const res = await fetch(`${INSPECT.replace(/\/$/, '')}/eth3p`);
  if (!res.ok) throw new Error(`inspect/eth3p HTTP ${res.status}`);
  const j = await res.json();
  const p = j?.reports?.[0]?.payload;
  if (!p) return null;
  const text = String(p).startsWith('0x')
    ? Buffer.from(String(p).slice(2), 'hex').toString('utf8')
    : String(p);
  return JSON.parse(text);
}

async function waitMachineWrap(assetHash, tries = 24, ms = 1500) {
  const want = String(assetHash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  for (let i = 0; i < tries; i += 1) {
    const snap = await inspectEth3pSnap().catch(() => null);
    const hit = (snap?.wraps || []).find(
      (w) => String(w.assetHash || '').toLowerCase() === want,
    );
    if (hit) return { snap, wrap: hit };
    await new Promise((r) => setTimeout(r, ms));
  }
  return null;
}

async function waitMachineBurn(assetHash, outstandingMax, tries = 24, ms = 1500) {
  const want = String(assetHash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const cap = BigInt(String(outstandingMax));
  for (let i = 0; i < tries; i += 1) {
    const snap = await inspectEth3pSnap().catch(() => null);
    const hit = (snap?.wraps || []).find(
      (w) => String(w.assetHash || '').toLowerCase() === want,
    );
    if (hit && BigInt(hit.outstandingE8 || '0') <= cap) return { snap, wrap: hit };
    await new Promise((r) => setTimeout(r, ms));
  }
  return null;
}

async function burnBinAccountId() {
  try {
    const snap = await inspectEth3pSnap();
    if (Number(snap?.burnBinAccountId) > 0) return Number(snap.burnBinAccountId);
  } catch {
    /* */
  }
  const res = await fetch(
    `${WART_NODE.replace(/\/$/, '')}/account/${ETH_BURN_BIN}/wart_balance`,
  );
  const j = await res.json();
  const id = Number(j?.data?.account?.accountId || j?.account?.accountId || 0);
  if (!(id > 0)) throw new Error('burn bin has no Warthog accountId yet');
  return id;
}

/**
 * Recipient-as-minter: SPV-prove createAssets and register the wrap in-machine.
 * Host JSON is a cache of inspect/eth3p — never the wrap authority.
 */
export async function registerEthWrap({
  assetHash,
  supplyE8,
  issuerWart,
  assetTxHash,
  assetName,
}) {
  const hash = String(assetTxHash || assetHash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('assetHash / assetTxHash required');
  const issuer = String(issuerWart || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{48}$/.test(issuer)) throw new Error('issuerWart (48-hex) required');
  const supply = BigInt(String(supplyE8 || '0'));
  if (supply <= 0n) throw new Error('supplyE8 must be > 0');
  const wraps = loadWraps();
  if ((wraps.wraps || []).some((w) => w.assetHash === hash)) {
    return {
      ok: true,
      already: true,
      wrap: wraps.wraps.find((w) => w.assetHash === hash),
      burnBin: ETH_BURN_BIN,
    };
  }
  const { buildWrapClaim } = await import('../../../../scripts/lib/wartSpvHost.mjs');
  const { submitPoolAdvance } = await import('./pool3pRotate.mjs');
  const claim = await buildWrapClaim({
    txHash: hash,
    issuerWart: issuer,
    supplyE8: supply.toString(),
    assetName: assetName || 'WETH',
    minConfirmations: 1,
    node: WART_NODE,
    minedWaitMs: WRAP_WAIT_MS,
  });
  delete claim._hostVerified;
  const posted = await submitPoolAdvance(claim);
  const landed = await waitMachineWrap(hash);
  if (!landed) {
    throw new Error(
      `wrap claim posted (${posted.txHash}) but inspect/eth3p has no wrap — machine rejected or lag`,
    );
  }
  const liveEpoch = await fetchAnvilGenesis();
  const credit = (wraps.credits || []).find(
    (c) =>
      c.wartAddress === issuer &&
      BigInt(c.remainingE8 || '0') >= supply &&
      wrapEpochBacking(c, liveEpoch) !== 'orphaned',
  );
  if (credit) {
    credit.remainingE8 = (BigInt(credit.remainingE8) - supply).toString();
  }
  const wrap = {
    assetHash: hash,
    assetName: 'WETH',
    supplyE8: supply.toString(),
    outstandingE8: String(landed.wrap.outstandingE8 || supply.toString()),
    issuerWart: issuer,
    creditId: credit?.id || null,
    ethTxHash: credit?.ethTxHash || null,
    assetTxHash: hash,
    source: 'spv-createAssets',
    machineTx: posted.txHash,
    badge: {
      scheme: 'eth-3p-wrap-claim-v1',
      pool: loadEthDapp()?.address || null,
      assetHash: hash,
      supplyE8: supply.toString(),
      issuerWart: issuer,
      lockTx: credit?.ethTxHash || null,
    },
    l1Epoch: credit?.l1Epoch || liveEpoch,
    at: new Date().toISOString(),
  };
  wraps.wraps = wraps.wraps || [];
  wraps.wraps.push(wrap);
  await saveWraps(wraps);
  return { ok: true, wrap, burnBin: ETH_BURN_BIN, machine: landed.wrap };
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
  let wrap = (wraps.wraps || []).find((w) => w.assetHash === hash);
  /**
   * Idempotency first, quota second — this order matters.
   *
   * A burn we have already recorded consumed its own quota when we first saw
   * it, so checking the quota first rejects the retry with
   * `burn N exceeds outstanding 0` and never reaches the dup branch. That is
   * what stranded a 500 WETH burn on 2026-08-27: openEthRedeem() records the
   * burn (recordEthBurn) before it checks the pool can pay
   * (assertLiveEthCanPay), so a redeem refused for gas left the ledger
   * decremented with no ticket — and every retry then died on a quota the
   * first attempt had already spent. The tokens are burnt on Warthog before
   * this function is ever called, so refusing the retry does not protect
   * anything; it only makes a real debt unrecoverable.
   */
  const dup = (wraps.burns || []).find((b) => b.wartTxHash === tx);
  if (dup) {
    return { ok: true, already: true, burn: dup, wrap, burnBin: ETH_BURN_BIN };
  }
  const destId = await burnBinAccountId();
  const { buildWrapBurnClaim } = await import('../../../../scripts/lib/wartSpvHost.mjs');
  const { submitPoolAdvance } = await import('./pool3pRotate.mjs');
  const claim = await buildWrapBurnClaim({
    txHash: tx,
    assetHash: hash,
    amountE8: y.toString(),
    destAccountId: destId,
    minConfirmations: 1,
    node: WART_NODE,
  });
  delete claim._hostVerified;
  const beforeOut = wrap ? BigInt(wrap.outstandingE8 || '0') : null;
  const posted = await submitPoolAdvance(claim);
  const wantMax = beforeOut != null ? beforeOut - y : null;
  const landed = await waitMachineBurn(
    hash,
    wantMax != null ? wantMax : 1n << 255n,
  );
  if (!landed) {
    throw new Error(
      `burn claim posted (${posted.txHash}) but inspect/eth3p outstanding did not drop`,
    );
  }
  if (!wrap) {
    wrap = {
      assetHash: hash,
      assetName: 'WETH',
      supplyE8: String(landed.wrap.supplyE8 || y.toString()),
      outstandingE8: String(landed.wrap.outstandingE8),
      issuerWart: burner,
      source: 'spv-createAssets',
    };
    wraps.wraps = wraps.wraps || [];
    wraps.wraps.push(wrap);
  } else {
    wrap.outstandingE8 = String(landed.wrap.outstandingE8);
  }
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
    source: 'spv-tokenTransfer',
    machineTx: posted.txHash,
  };
  wraps.burns = wraps.burns || [];
  wraps.burns.push(burn);
  await saveWraps(wraps);
  return { ok: true, burn, wrap, burnBin: ETH_BURN_BIN, machine: landed.wrap };
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

/**
 * Full wrap registry keyed by asset hash — the authority on which Warthog WETH
 * assets are still redeemable.
 *
 * Every wrap mints a BRAND-NEW Warthog L1 asset (recipient-as-minter, see
 * registerEthWrap), and they all display as "WETH". A ledger reset rewrites
 * pool-eth-3p-wraps.json but cannot touch Warthog L1, so un-burned balances from
 * wiped generations stay in the wallet forever, unbacked. Anything absent from
 * this index is an orphan: burning it destroys the tokens and releases no ETH.
 *
 * ethStatus() truncates `wraps` to the last 20 for its snapshot — never classify
 * from that list, use this one.
 */
/**
 * What this issuer may mint right now, in E8.
 *
 * registerEthWrap() matches ONE credit with remainingE8 >= supply, so the
 * ceiling for a single createAssets is the largest single credit — not the sum
 * of them. The UI needs this because the deposit fee makes the mintable amount
 * smaller than the amount locked, and it has no other way to learn the fee:
 * ethStatus() does not expose credits at all. Without it the UI mints the gross
 * deposit, registerEthWrap rejects the lot, and the asset has already been
 * created on Warthog by then.
 */
export function ethMintable({ issuerWart } = {}) {
  const issuer = String(issuerWart || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{48}$/.test(issuer)) throw new Error('issuerWart (48-hex) required');
  const live = genesisCache.hash;
  const credits = (loadWraps().credits || []).filter((c) => {
    if (c.wartAddress !== issuer) return false;
    if (!live) return true;
    return wrapEpochBacking(c, live) === 'backed';
  });
  const each = credits.map((c) => ({
    id: c.id,
    ethTxHash: c.ethTxHash || null,
    amountE8: String(c.amountE8 || '0'),
    feeE8: String(c.feeE8 || '0'),
    remainingE8: String(c.remainingE8 || '0'),
  }));
  const rems = each.map((c) => BigInt(c.remainingE8));
  const largest = rems.reduce((a, b) => (b > a ? b : a), 0n);
  const total = rems.reduce((a, b) => a + b, 0n);
  return {
    ok: true,
    issuerWart: issuer,
    mintableE8: largest.toString(),
    totalRemainingE8: total.toString(),
    credits: each,
  };
}

export function ethWrapIndex() {
  const wraps = loadWraps();
  const live = genesisCache.hash;
  const byHash = {};
  for (const w of wraps.wraps || []) {
    if (!w?.assetHash) continue;
    const backing = wrapEpochBacking(w, live);
    const out = String(w.outstandingE8 || '0');
    byHash[w.assetHash] = {
      assetHash: w.assetHash,
      assetName: w.assetName || 'WETH',
      supplyE8: String(w.supplyE8 || '0'),
      outstandingE8: backing === 'orphaned' ? '0' : out,
      orphanedE8: backing === 'orphaned' ? out : '0',
      backing,
      l1Epoch: w.l1Epoch || null,
      issuerWart: w.issuerWart || null,
      ethTxHash: w.ethTxHash || null,
      at: w.at || null,
    };
  }
  return {
    ok: true,
    burnBin: ETH_BURN_BIN,
    l1Epoch: live || null,
    byHash,
    hashes: Object.keys(byHash),
    count: Object.keys(byHash).length,
  };
}

/**
 * Precheck a burn WITHOUT mutating anything.
 *
 * recordEthBurn() already rejects an unregistered hash — but only after the
 * receipt has moved to the burn bin, and a Warthog transfer is irreversible.
 * That is exactly how 15 WETH of the wiped `cad85802…` asset was destroyed on
 * 2026-08-26. The UI must call this BEFORE it signs the transfer.
 */
export async function classifyEthBurn({ assetHash, amountE8 } = {}) {
  const hash = String(assetHash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return { ok: false, redeemable: false, reason: 'bad-hash', message: 'assetHash must be 32-byte hex' };
  }
  await stampUnstampedWrapEpochs().catch(() => null);
  const wrap = (loadWraps().wraps || []).find((w) => w.assetHash === hash);
  if (!wrap) {
    return {
      ok: false,
      redeemable: false,
      reason: 'not-registered',
      message:
        'This WETH is not a credited ETH receipt on the current bridge ledger — ' +
        'it is an orphan from a wiped generation. Burning it destroys the tokens ' +
        'and releases no ETH.',
    };
  }
  const liveEpoch = await fetchAnvilGenesis();
  if (wrapEpochBacking(wrap, liveEpoch) === 'orphaned') {
    return {
      ok: false,
      redeemable: false,
      reason: 'orphaned-epoch',
      error:
        'This WETH was wrapped against a previous Anvil session. The ETH lock is gone. ' +
        'Untrack it in the L1 WETH filter — burning it destroys the tokens and releases no ETH.',
      message:
        'This WETH was wrapped against a previous Anvil session. The ETH lock is gone. ' +
        'Untrack it in the L1 WETH filter — burning it destroys the tokens and releases no ETH.',
    };
  }
  const rotatePhase = ethRotatePhaseNow();
  if (ETH_ROTATE_COMMITTED.has(rotatePhase)) {
    const msg =
      `ETH pool is rotating (${rotatePhase}) — wait until the sweep finishes before burning. ` +
      'A burn now would send WETH to the bin with no ETH payout until rotation completes.';
    return {
      ok: false,
      redeemable: false,
      reason: 'pool-rotating',
      error: msg,
      message: msg,
    };
  }
  /** Trimmed view — the raw wrap carries the badge and credit id, which the client has no use for. */
  const view = {
    assetHash: wrap.assetHash,
    assetName: wrap.assetName || 'WETH',
    supplyE8: String(wrap.supplyE8 || '0'),
    outstandingE8: String(wrap.outstandingE8 || '0'),
    ethTxHash: wrap.ethTxHash || null,
    at: wrap.at || null,
  };
  const outstanding = BigInt(wrap.outstandingE8 || '0');
  if (outstanding <= 0n) {
    return {
      ok: false,
      redeemable: false,
      reason: 'fully-burned',
      wrap: view,
      message: 'This wrap is fully redeemed — nothing left to unwrap against it.',
    };
  }
  const want = amountE8 == null ? null : BigInt(String(amountE8));
  if (want != null && want <= 0n) {
    return { ok: false, redeemable: false, reason: 'bad-amount', wrap: view, message: 'amountE8 must be > 0' };
  }
  if (want != null && want > outstanding) {
    return {
      ok: false,
      redeemable: false,
      reason: 'exceeds-outstanding',
      wrap: view,
      maxE8: outstanding.toString(),
      message: `Amount exceeds the ${outstanding} E8 still outstanding on this wrap.`,
    };
  }
  /**
   * Solvency, not just bookkeeping.
   *
   * Everything above validates the receipt. None of it asks whether the Q can
   * actually pay, which is what let a 500 WETH burn go ahead against a pool
   * holding 499.999937 on 2026-08-27. The burn lands on Warthog before
   * openEthRedeem is ever called and cannot be undone, so this has to be
   * answered here, before the user burns.
   *
   * Fails closed: if the RPC cannot be reached we report not-redeemable rather
   * than green-lighting a burn we could not verify. A blocked burn is
   * retryable; a burn against an insolvent pool is not.
   */
  const payE8 = want != null ? want : outstanding;
  const q = loadEthDapp()?.address || null;
  try {
    const { JsonRpcProvider } = await import('ethers-v6');
    const provider = new JsonRpcProvider(ETH_RPC);
    const bal = await provider.getBalance(q);
    const feeData = await provider.getFeeData();
    const gas = 21000n * (feeData.gasPrice || 1n);
    const need = payE8 * 10n ** 10n + gas;
    if (bal < need) {
      const payable = bal > gas ? (bal - gas) / 10n ** 10n : 0n;
      return {
        ok: false,
        redeemable: false,
        reason: 'pool-insolvent',
        wrap: view,
        maxE8: (payable < outstanding ? payable : outstanding).toString(),
        poolBalanceWei: bal.toString(),
        neededWei: need.toString(),
        message:
          `The pool holds ${weiToEthLabel(bal)} ETH but needs ` +
          `${weiToEthLabel(need)} to pay this redeem and its gas. Burning now ` +
          `would destroy the tokens and release nothing. Redeem at most ` +
          `${weiToEthLabel(payable * 10n ** 10n)} ETH, or wait for the pool to be topped up.`,
      };
    }
  } catch (e) {
    return {
      ok: false,
      redeemable: false,
      reason: 'solvency-unknown',
      wrap: view,
      maxE8: outstanding.toString(),
      message:
        `Cannot confirm the pool can pay right now (${e.message || e}). ` +
        'Not burning: the burn is irreversible and the payout is not.',
    };
  }
  return {
    ok: true,
    redeemable: true,
    reason: 'ok',
    wrap: view,
    maxE8: outstanding.toString(),
    burnBin: ETH_BURN_BIN,
  };
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

/**
 * Hold until the burn is in a block. Returns the refreshed lookup.
 *
 * Waits inline for BURN_WAIT_MS — a Warthog block is ~30s, so most callers just
 * see a slightly slower request. Past that it throws BURN_UNCONFIRMED, which is
 * a *retry*, not a failure: the burn is already on-chain and must never be sent
 * a second time. Nothing has been recorded when this throws.
 */
async function awaitBurnMined(looked) {
  if (BURN_MIN_CONF <= 0) return looked;
  let cur = looked;
  const deadline = Date.now() + BURN_WAIT_MS;
  while (cur.confirmations < BURN_MIN_CONF && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, BURN_POLL_MS));
    cur = await lookupWartTx(cur.txHash).catch(() => cur);
  }
  if (cur.confirmations < BURN_MIN_CONF) {
    throw new Error(
      `BURN_UNCONFIRMED: burn ${cur.txHash.slice(0, 12)}… is not in a Warthog block yet ` +
        `(${cur.confirmations}/${BURN_MIN_CONF} confirmations). ETH is released only after the ` +
        `burn block is mined — retry, the burn is already sent and must not be repeated.`,
    );
  }
  return cur;
}

async function buildEthUnsigned({ to, valueWei, gasPrice: gasPriceIn } = {}) {
  const { JsonRpcProvider, Transaction } = await import('ethers-v6');
  const dapp = loadEthDapp();
  if (!dapp?.address) throw new Error('ETH 3P Q not sealed');
  const provider = new JsonRpcProvider(ETH_RPC);
  const from = String(dapp.address).toLowerCase();
  const nonce = await provider.getTransactionCount(from, 'pending');
  const net = await provider.getNetwork();
  const fee = await provider.getFeeData();
  const gasPrice = gasPriceIn != null ? BigInt(gasPriceIn) : fee.gasPrice || 1n;
  const tx = {
    to: String(to).toLowerCase(),
    value: BigInt(valueWei),
    nonce,
    gasLimit: 21000n,
    chainId: Number(net.chainId),
    type: 0,
    gasPrice,
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
    kind: t.kind || (String(t.ticketId || '').startsWith('eth-rotate') ? 'rotate-sweep' : 'redeem'),
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
    lastError: t.lastError || null,
    // Which seat the round is waiting on, and whether that seat has told us it
    // cannot answer. Without this a stalled ticket is indistinguishable from a
    // slow one.
    blockedOn: t.status === 'wait_d2' ? 2 : t.status === 'wait_r1' ? 1 : null,
    blockedFault:
      t.status === 'wait_d2'
        ? seatFaultOf(2)
        : t.status === 'wait_r1'
          ? seatFaultOf(1)
          : null,
    assetHash: t.assetHash,
    burnerWart: t.burnerWart,
    wartTxHash: t.wartTxHash || null,
    prep: t.prep || null,
    paillierN: loadEthDapp()?.paillierN || null,
    paillierG: loadEthDapp()?.paillierG || null,
    P2Hex: compactPoint(loadEthDapp()?.seats?.[2]?.P || loadEthDapp()?.seal?.P2 || ''),
    publicKey: loadEthDapp()?.publicKey || loadEthDapp()?.seal?.publicKey || null,
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

function lastPaidEthTicket() {
  const s = loadEthSess();
  const paid = Object.values(s.tickets || {}).filter(
    (t) => t?.status === 'paid' && t.payout?.txHash,
  );
  paid.sort((a, b) => Number(b.payout?.at || 0) - Number(a.payout?.at || 0));
  return paid[0] ? ticketView(paid[0]) : null;
}

function loadEthPaidLog() {
  try {
    return JSON.parse(readFileSync(ETH_PAID_PATH, 'utf8'));
  } catch {
    return { pays: [] };
  }
}

function compactSignedRow(t) {
  if (!t) return null;
  const id = String(t.ticketId || '');
  const kind =
    t.kind ||
    (id.startsWith('eth-rotate') ? 'rotate-sweep' : id ? 'redeem' : null);
  return {
    ticketId: id || null,
    kind,
    txHash: t.txHash || t.payout?.txHash || null,
    amountE8: t.amountE8 != null ? String(t.amountE8) : null,
    amountWei: t.amountWei != null ? String(t.amountWei) : null,
    fromAddress: t.fromAddress || null,
    toAddress: t.toAddress || null,
    at: t.at || t.payout?.at || t.updatedAt || t.openedAt || 0,
  };
}

/** ETH has no announce step, so the sweep is the point of no return. */
const ETH_ROTATE_COMMITTED = new Set(['sweeping', 'cutover']);

/** ETH rotation phase off disk — poolEth3pRotate imports this module. */
function ethRotatePhaseNow() {
  try {
    return String(JSON.parse(readFileSync(ETH_ROTATE_PATH, 'utf8')).phase || 'idle');
  } catch {
    return 'idle';
  }
}

function seedLastRotateRow() {
  try {
    const r = JSON.parse(readFileSync(ETH_ROTATE_PATH, 'utf8'));
    const last = r?.last;
    if (!last?.address) return null;
    const at = Date.parse(last.at) || 0;
    return {
      ticketId: last.ticketId || `eth-rotate-${at || Date.now()}`,
      kind: last.sweepTxHash ? 'rotate-sweep' : 'rotate-skip',
      txHash: last.sweepTxHash || null,
      amountE8: last.amountE8 != null ? String(last.amountE8) : '0',
      amountWei: last.amountWei != null ? String(last.amountWei) : '0',
      fromAddress: last.address,
      toAddress: last.to || loadEthDapp()?.address || null,
      at,
    };
  } catch {
    return null;
  }
}

export async function rememberEthPaid(row) {
  const compact = compactSignedRow(row);
  if (!compact || (!compact.ticketId && !compact.txHash && compact.kind !== 'rotate-skip')) {
    return compact;
  }
  const log = loadEthPaidLog();
  log.pays = Array.isArray(log.pays) ? log.pays : [];
  const key = compact.ticketId || compact.txHash;
  log.pays = log.pays.filter((p) => (p.ticketId || p.txHash) !== key);
  log.pays.unshift(compact);
  log.pays = log.pays.slice(0, 32);
  await mkdir(path.dirname(ETH_PAID_PATH), { recursive: true });
  await writeFile(ETH_PAID_PATH, JSON.stringify(log, null, 2));
  return compact;
}

function lastPaidEthTickets() {
  const seen = new Set();
  const rows = [];
  const take = (p) => {
    const row = compactSignedRow(p);
    if (!row) return;
    const key = row.ticketId || row.txHash;
    if (!key || seen.has(key)) return;
    if (!row.txHash && row.kind !== 'rotate-skip') return;
    seen.add(key);
    rows.push(row);
  };
  for (const p of loadEthPaidLog().pays || []) take(p);
  try {
    const s = JSON.parse(readFileSync(ETH_SESS_PATH, 'utf8'));
    for (const t of Object.values(s.tickets || {})) {
      if (t?.status === 'paid' && t.payout?.txHash) take(t);
    }
  } catch {
    /* */
  }
  if (!rows.some((r) => String(r.kind || '').startsWith('rotate'))) {
    take(seedLastRotateRow());
  }
  rows.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  return rows.slice(0, 16);
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
  let looked = await lookupWartTx(wartTxHash);
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
  // Everything above is a cheap reject on a malformed request. Only once the
  // burn is genuinely ours do we hold for its block — and nothing below this
  // line may run against a mempool-only burn.
  looked = await awaitBurnMined(looked);
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
  await assertLiveEthCanPay({
    from: unsigned.from,
    valueWei: unsigned.tx.value,
    gasLimit: unsigned.tx.gasLimit,
    gasPrice: unsigned.tx.gasPrice,
  });
  const ticketId = `eth-redeem-${looked.txHash.slice(0, 16)}`;
  const s = loadEthSess();
  s.tickets = s.tickets || {};
  if (s.tickets[ticketId]?.status === 'paid') {
    return { ok: true, alreadyPaid: true, ticketId, ...ticketView(s.tickets[ticketId]) };
  }
  // Drain gate — see the WART twin in pool3p.mjs. Only a brand-new redeem is
  // refused; an open one keeps its room so it can finish.
  if (!s.tickets[ticketId] || s.tickets[ticketId].status === 'abandoned') {
    const phase = ethRotatePhaseNow();
    if (ETH_ROTATE_COMMITTED.has(phase)) {
      throw new Error(
        `POOL_ROTATING: ETH pool is rotating (${phase}) — retry in a few seconds`,
      );
    }
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
  const prevR1 = compactPoint(t.R1Hex || '');
  const prevHash = String(t.hashHex || t.prep?.hashHex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (t.haveR1 && prevR1 && prevR1 === nextR1 && prevHash && prevHash !== nextHash) {
    throw new Error(
      'R1 already bound to another hashHex — post a fresh k1 (same R1 + different z is nonce reuse)',
    );
  }
  await clearSeatFault(sid);
  t.R1Hex = nextR1;
  t.hashHex = nextHash;
  t.r1SignerId = sid;
  t.haveR1 = true;
  delete t.ciphertext;
  t.haveD2 = false;
  t.status = 'wait_d2';
  t.updatedAt = Date.now();
  if (ETH_RAM_D2.has(t.ticketId) || t.encD2) {
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
    throw new Error(`e2 Enc denied — holder is ${currentHolderId(2) || 'empty'}, not ${sid}`);
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
  await clearSeatFault(sid);
  const s = loadEthSess();
  const t = s.tickets[String(ticketId)];
  if (!t) throw new Error('unknown ETH redeem ticket');
  /**
   * The twin of the guard in eth3pOfferR1 — a late D2 must not touch a ticket
   * that already paid.
   *
   * eth3pSubmit resets haveR1/haveD2 to false once the payout lands. Without
   * this check a retrying e2 tab falls through to the assignment below, reads
   * haveR1 === false, and rewrites a paid ticket's status back to 'wait_r1'
   * while payout.txHash sits right beside it. Nothing recovers from that on its
   * own: maybeSweep needs `status === 'paid' && t.txHash`, so a paid sweep
   * wedges the rotation in 'sweeping' forever, and a paid redeem keeps its room
   * open and blocks rotation the same way. Both happened on 2026-08-27, and the
   * bogus wait_r1 is what made rotate.json report a null sweepTxHash for a
   * sweep that had in fact paid.
   *
   * Placed before the ETH_RAM_D2.set below so a paid ticket does not get a
   * stale ciphertext parked in the RAM map either.
   */
  if (t.status === 'paid') return { ok: false, alreadyPaid: true, ...ticketView(t) };
  ETH_RAM_D2.set(String(ticketId), String(encD2));
  t.encD2 = String(encD2);
  t.haveD2 = true;
  t.status = t.haveR1 ? 'ready' : 'wait_r1';
  t.updatedAt = Date.now();
  if (t.haveR1 && t.haveD2) runEthLindell(t);
  await saveEthSess(s);
  return ticketView(t);
}

function runEthLindell(t) {
  const encD2 = ETH_RAM_D2.get(t.ticketId) || t.encD2;
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
  try {
    await assertLiveEthCanPay({
      from: t.prep?.from,
      valueWei: t.prep?.tx?.value || t.amountWei,
      gasLimit: t.prep?.tx?.gasLimit,
      gasPrice: t.prep?.tx?.gasPrice,
    });
  } catch (e) {
    if (t.kind === 'rotate-sweep' || String(t.ticketId || '').startsWith('eth-rotate')) {
      const refreshed = await refreshEthSweepTicket(t.ticketId).catch(() => null);
      if (refreshed?.repriced) {
        throw new Error(
          `SWEEP_REPRICED: ${t.ticketId} no longer fits the live Q (${e.message}). ` +
            'e1 must sign again — do not retry this signature.',
        );
      }
    }
    throw e;
  }
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
  // Last gate before L1 funds move: a redeem pays out only against a burn that
  // is in a Warthog block. Rotate-sweep tickets have no burn and skip this.
  if (t.wartTxHash) {
    await awaitBurnMined(await lookupWartTx(t.wartTxHash));
  }
  /**
   * The same gate, for the other kind of ticket. A redeem cannot pay unless its
   * burn is mined; until now a rotate-sweep had no last-moment check at all — it
   * went from "e1 signed this 20 seconds ago" straight to the wire, which is how
   * both orphans happened.
   *
   * Verify at the point of no return instead of trusting that nothing moved:
   * this does not care WHY next changed, which writer changed it, or whether any
   * lock was armed. Refusing is safe — the ETH stays in the live Q, which is
   * fully signable and fully recorded, so the sweep can simply be re-opened.
   *
   * An empty next file means cutover already ran; a late retry then legitimately
   * pays what is now the live Q, so accept that rather than wedging the retry.
   */
  if (t.kind === 'rotate-sweep' || String(t.ticketId || '').startsWith('eth-rotate')) {
    const to = String(t.prep?.tx?.to || '').toLowerCase();
    const nextAddr = String(loadEthNext()?.address || '').toLowerCase();
    const liveAddr = String(loadEthDapp()?.address || '').toLowerCase();
    const destOk = to && (nextAddr ? to === nextAddr : to === liveAddr);
    if (!destOk) {
      throw new Error(
        `SWEEP_DEST_STALE: ${t.ticketId} pays ${to || '(none)'} but the next Q is now ` +
          `${nextAddr || '(none, cutover done)'} and live is ${liveAddr} — refusing to ` +
          'broadcast. The ETH stays in the live Q; re-open the sweep against the current Q.',
      );
    }
  }
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
  await rememberEthPaid({
    ticketId: t.ticketId,
    kind: t.kind || (String(t.ticketId || '').startsWith('eth-rotate') ? 'rotate-sweep' : 'redeem'),
    txHash: t.payout.txHash,
    amountE8: t.amountE8,
    amountWei: t.amountWei,
    toAddress: t.toAddress,
    at: t.payout.at,
  });
  return { ok: true, txHash: t.payout.txHash, ticketId: t.ticketId };
}

export { clientSignRound1, clientSignFinish, listOpenEthTickets };
