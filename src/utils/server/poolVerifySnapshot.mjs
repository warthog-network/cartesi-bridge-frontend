/**
 * Coordinator-side verify snapshot for browser signers.
 *
 * `GET /api/pool?verifyTicket=<id>` (or `=1` for inspect + head only). Browser
 * signers read this when their own rollup / inspect fetch fails, so it must
 * carry everything they would have fetched themselves — including the proof
 * of the release notice. Rollup reads go through rollupsApi.mjs; the `rollups`
 * block tells the signer which API (v1 GraphQL or v2 JSON-RPC) and which app
 * address to use for its own reads.
 */
import nodeProcess from 'node:process';
import { getInspect, machineView } from './inspectHub.mjs';
import { findReleaseTicketNotice, rollupsInfo, isV2 } from './rollupsApi.mjs';

function env(key, fallback = '') {
  try {
    const v = nodeProcess.env[key];
    return v == null || v === '' ? fallback : String(v);
  } catch {
    return fallback;
  }
}

const WART_HEAD_URL = env(
  'POOL_WART_HEAD_URL',
  'https://warthog-defitestnet.duckdns.org/chain/head',
);

function extractWartHead(j) {
  const head = j?.data?.chainHead || j?.chainHead || j?.data || j;
  if (!head || typeof head !== 'object') return null;
  const height = Number(head.height ?? head.blockHeight);
  if (!Number.isFinite(height) || height <= 0) return null;
  return {
    height,
    hash: String(head.hash || head.blockHash || '')
      .replace(/^0x/i, '')
      .toLowerCase(),
  };
}

async function fetchInspectPoolLocal() {
  const r = await getInspect('pool');
  if (!r.decoded?.ok) throw new Error('inspect/pool not ok');
  return { raw: r.raw, pool: r.decoded, stale: r.stale, ageMs: r.ageMs };
}

/**
 * Release notice for the signer fallback. v1 keeps the legacy `_proof.validity/
 * context` shape. v2 adds the plain shape the signer's v2 path reads:
 * { index, inputIndex, rawData, payloadHex, proof: { outputIndex, outputHashesSiblings|null } }.
 */
async function fetchReleaseNoticeLocal(ticketId) {
  const best = await findReleaseTicketNotice(ticketId, { pages: 20 });
  if (!best) return null;
  if (!isV2()) return best;
  return {
    ...best,
    index: best._index,
    inputIndex: best._inputIndex,
    epochIndex: best._epochIndex ?? null,
    rawData: best._rawDataHex || null,
    payloadHex: best._payloadHex || null,
    proof: best._proof || { outputIndex: best._index, outputHashesSiblings: null },
  };
}

async function fetchWartHeadLocal() {
  const res = await fetch(WART_HEAD_URL, { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`wart head HTTP ${res.status}`);
  const head = extractWartHead(body);
  if (!head) throw new Error('wart head missing height');
  return { source: 'defi-head', ...head };
}

export async function getTicketVerifySnapshot(ticketId) {
  const id = String(ticketId || '').trim();
  const [inspect, notice, wartHead] = await Promise.all([
    fetchInspectPoolLocal().catch((e) => ({ error: e.message })),
    id && id !== '1'
      ? fetchReleaseNoticeLocal(id).catch((e) => ({ error: e.message }))
      : Promise.resolve(null),
    fetchWartHeadLocal().catch((e) => ({ error: e.message })),
  ]);
  const inspectTicket =
    inspect?.pool && id
      ? (inspect.pool.recentTickets || []).find((t) => String(t.ticketId) === id) ||
        null
      : null;
  return {
    ok: true,
    ticketId: id || null,
    rollups: rollupsInfo(),
    notice: notice && !notice.error ? notice : null,
    noticeError: notice?.error || null,
    inspect: inspect?.error
      ? { error: inspect.error }
      : {
          pool: inspect.pool,
          processedInputCount: inspect.pool?.processedInputCount,
        },
    inspectTicket,
    wartHead: wartHead?.error ? { error: wartHead.error } : wartHead,
    voucherCount: 0,
    // Browser signers must not verify against a ledger that is hours behind.
    machine: machineView(),
  };
}
