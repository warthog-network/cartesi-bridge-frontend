/**
 * One bridge health verdict for the UI, from five real signals.
 *
 * Every stall a tester hit this month had a server-side cause the page could
 * have named: Anvil not advancing, the claimer stuck (no epoch accepted for
 * hours), the deposit relayer wedged, a seat gone, the keep-alive timer dead.
 * This folds those into { level: ok | warn | down, summary, signals[] } so the
 * page can show one chip with a plain sentence and a tooltip of the parts.
 *
 * Read-only, cached 10 s, every probe bounded by a timeout. Never throws:
 * a probe that fails is reported as a failed signal.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { l1RpcUrl, appRef, rpcCall, isV2 } from './rollupsApi.mjs';
import { publicStatus as pool3pPublicStatus } from './pool3p.mjs';

const execFileP = promisify(execFile);
const CACHE_MS = 10_000;
const RELAYER_UNIT = process.env.HEALTH_RELAYER_UNIT || 'cartesi-bridge-v2-relayer.service';
const KEEPALIVE_UNIT = process.env.HEALTH_KEEPALIVE_UNIT || 'cartesi-bridge-epoch-keepalive.service';
const RELAYER_STALE_MS = 3 * 60_000; // idle heartbeat is once a minute
const KEEPALIVE_STALE_MS = 3 * 3600_000; // timer is every 2 h
const CLAIMS_WARN = 3; // epochs computed but not yet accepted on L1
const CLAIMS_DOWN = 8;

let cache = { at: 0, value: null };
const blockSamples = []; // { at, block }

async function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

async function probeChain() {
  const url = l1RpcUrl();
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    }),
    4000,
    'eth_blockNumber',
  );
  const j = await res.json();
  const block = parseInt(j?.result, 16);
  if (!Number.isFinite(block)) throw new Error('no block number');
  const now = Date.now();
  blockSamples.push({ at: now, block });
  while (blockSamples.length && now - blockSamples[0].at > 10 * 60_000) blockSamples.shift();
  const old = blockSamples.find((s) => now - s.at >= 45_000);
  if (old && block <= old.block) {
    return { ok: false, detail: `block ${block} unchanged for ${Math.round((now - old.at) / 1000)} s`, block };
  }
  return { ok: true, detail: `block ${block}`, block };
}

async function probeClaims() {
  if (!isV2()) return { ok: true, detail: 'rollups v1: not tracked', skipped: true };
  const first = await rpcCall('cartesi_listEpochs', { application: appRef(), limit: 1, offset: 0 }, { timeoutMs: 4000 });
  const total = Number(first?.pagination?.total_count || 0);
  if (!total) return { ok: true, detail: 'no epochs yet' };
  const take = Math.min(12, total);
  const page = await rpcCall(
    'cartesi_listEpochs',
    { application: appRef(), limit: take, offset: total - take },
    { timeoutMs: 4000 },
  );
  const epochs = (page?.data || []).slice().sort((a, b) => parseInt(a.index, 16) - parseInt(b.index, 16));
  // The newest epoch is normally still open or being processed; ignore it.
  const settled = epochs.slice(0, -1);
  const pending = settled.filter((e) => e.status !== 'CLAIM_ACCEPTED');
  const newestAccepted = [...epochs].reverse().find((e) => e.status === 'CLAIM_ACCEPTED');
  const detail = pending.length
    ? `${pending.length} of the last ${settled.length} epochs not yet accepted on L1 (oldest: ${pending[0].status} epoch ${parseInt(pending[0].index, 16)})`
    : `all recent epochs accepted (latest ${newestAccepted ? parseInt(newestAccepted.index, 16) : '?'})`;
  return { ok: pending.length < CLAIMS_WARN, down: pending.length >= CLAIMS_DOWN, pending: pending.length, detail };
}

async function unitLastLog(unit) {
  const { stdout } = await execFileP(
    'journalctl',
    ['-u', unit, '-n', '1', '-o', 'json', '--no-pager', '-q'],
    { timeout: 3000, maxBuffer: 1 << 20 },
  );
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  if (!line) return null;
  const j = JSON.parse(line);
  const us = Number(j.__REALTIME_TIMESTAMP || 0);
  return { at: us ? Math.floor(us / 1000) : null, message: String(j.MESSAGE || '').slice(0, 160) };
}

async function unitShow(unit, props) {
  const { stdout } = await execFileP('systemctl', ['show', unit, '-p', props.join(',')], { timeout: 3000 });
  const out = {};
  for (const l of stdout.split('\n')) {
    const i = l.indexOf('=');
    if (i > 0) out[l.slice(0, i)] = l.slice(i + 1);
  }
  return out;
}

async function probeRelayer() {
  const [show, last] = await Promise.all([
    unitShow(RELAYER_UNIT, ['ActiveState', 'SubState']),
    unitLastLog(RELAYER_UNIT).catch(() => null),
  ]);
  if (show.ActiveState !== 'active') {
    return { ok: false, detail: `${RELAYER_UNIT} is ${show.ActiveState || 'unknown'}` };
  }
  if (!last?.at) return { ok: false, detail: 'no journal line from the relayer' };
  const age = Date.now() - last.at;
  if (age > RELAYER_STALE_MS) {
    return { ok: false, detail: `relayer silent for ${Math.round(age / 60_000)} min (last: ${last.message})` };
  }
  return { ok: true, detail: `relayer logged ${Math.round(age / 1000)} s ago` };
}

async function probeKeepalive() {
  const show = await unitShow(KEEPALIVE_UNIT, ['Result', 'ExecMainExitTimestamp', 'ActiveState']);
  if (show.ActiveState === 'activating' || show.ActiveState === 'active') {
    return { ok: true, detail: 'keep-alive running now' };
  }
  // systemd prints "Sat 2026-09-12 01:40:11 CEST" in the unit's local zone,
  // which is this process's zone too; Date.parse cannot read the zone name.
  const m = String(show.ExecMainExitTimestamp || '').match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);
  const when = m ? new Date(`${m[1]}T${m[2]}`).getTime() : NaN;
  if (show.Result && show.Result !== 'success') {
    return { ok: false, detail: `last keep-alive run failed (${show.Result})` };
  }
  if (!Number.isFinite(when)) return { ok: false, detail: 'keep-alive has not run yet' };
  const age = Date.now() - when;
  if (age > KEEPALIVE_STALE_MS) {
    return { ok: false, detail: `keep-alive last ran ${Math.round(age / 3600_000)} h ago` };
  }
  return { ok: true, detail: `keep-alive ran ${Math.round(age / 60_000)} min ago` };
}

function probeSeats() {
  const p3 = pool3pPublicStatus() || {};
  if (!p3.configured) return { ok: true, detail: '3P pool not configured', skipped: true };
  const d1 = !!p3.d1Live;
  const d2 = !!p3.d2Live;
  if (d1 && d2) return { ok: true, detail: 'both signer seats live' };
  const missing = [!d1 && 'd1', !d2 && 'd2'].filter(Boolean).join(' and ');
  return { ok: false, detail: `signer seat ${missing} offline — withdrawals wait until it returns` };
}

async function settle(label, key, fn) {
  try {
    const r = await fn();
    return { key, label, ok: !!r.ok, down: !!r.down, skipped: !!r.skipped, detail: r.detail || '' };
  } catch (e) {
    return { key, label, ok: false, down: false, skipped: false, detail: String(e?.message || e).slice(0, 160) };
  }
}

export async function bridgeHealth() {
  const now = Date.now();
  if (cache.value && now - cache.at < CACHE_MS) return cache.value;
  const signals = await Promise.all([
    settle('Chain advancing', 'chain', probeChain),
    settle('Claims current', 'claims', probeClaims),
    settle('Deposit relayer', 'relayer', probeRelayer),
    settle('Signer seats', 'seats', () => Promise.resolve(probeSeats())),
    settle('Epoch keep-alive', 'keepalive', probeKeepalive),
  ]);
  const by = Object.fromEntries(signals.map((s) => [s.key, s]));
  let level = 'ok';
  let summary = 'Bridge ready';
  if (!by.chain.ok || by.claims.down || !by.seats.ok) {
    level = 'down';
    summary = !by.seats.ok
      ? 'Bridge paused · withdrawals wait for a signer'
      : 'Bridge paused · try again in a few minutes';
  } else if (!by.claims.ok || !by.relayer.ok || !by.keepalive.ok) {
    level = 'warn';
    summary = !by.relayer.ok
      ? 'Bridge busy · deposits may credit late'
      : 'Bridge busy · transfers may take longer';
  }
  const value = { ok: true, level, summary, at: new Date(now).toISOString(), signals };
  cache = { at: now, value };
  return value;
}
