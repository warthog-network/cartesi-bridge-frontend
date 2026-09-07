/**
 * Coordinator-side verify snapshot for browser signers.
 *
 * `GET /api/pool?verifyTicket=<id>` (or `=1` for inspect + head only). Browser
 * signers read this when their own GraphQL / inspect fetch fails, so it must
 * carry everything they would have fetched themselves — including the epoch
 * proof of the release notice. Carved out of the retired Path A3 module; the
 * A3 request-store field it used to carry is gone with A3.
 */
import nodeProcess from 'node:process';

function env(key, fallback = '') {
  try {
    const v = nodeProcess.env[key];
    return v == null || v === '' ? fallback : String(v);
  } catch {
    return fallback;
  }
}

const GRAPHQL_URL =
  env('CARTESI_GRAPHQL_URL', 'http://127.0.0.1:8080/graphql');
const INSPECT_POOL_URL =
  env('CARTESI_INSPECT_POOL_URL') ||
  `${env('CARTESI_INSPECT_URL', 'http://127.0.0.1:8080/inspect').replace(/\/$/, '')}/pool`;
const WART_HEAD_URL = env(
  'POOL_WART_HEAD_URL',
  'https://warthog-defitestnet.duckdns.org/chain/head',
);

function hexToUtf8(raw) {
  const s = String(raw || '');
  if (!s.startsWith('0x')) return s;
  try {
    return Buffer.from(s.slice(2), 'hex').toString('utf8');
  } catch {
    return '';
  }
}

function decodeInspectBody(body) {
  if (!body || typeof body !== 'object') return null;
  for (const r of body.reports || []) {
    try {
      const obj = JSON.parse(hexToUtf8(r?.payload));
      if (obj && typeof obj === 'object') {
        return {
          ...obj,
          processedInputCount: Number(
            body.processed_input_count ?? obj.processedInputCount ?? 0,
          ),
        };
      }
    } catch {
      /* next */
    }
  }
  return null;
}

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


let inspectLocalCache = { at: 0, value: null };
const INSPECT_LOCAL_TTL_MS = 8000;

async function fetchInspectPoolLocal() {
  if (inspectLocalCache.value && Date.now() - inspectLocalCache.at < INSPECT_LOCAL_TTL_MS) {
    return inspectLocalCache.value;
  }
  const res = await fetch(INSPECT_POOL_URL, { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`inspect HTTP ${res.status}`);
  const pool = decodeInspectBody(body);
  if (!pool?.ok) throw new Error('inspect/pool not ok');
  const value = { raw: body, pool };
  inspectLocalCache = { at: Date.now(), value };
  return value;
}

async function fetchReleaseNoticeLocal(ticketId) {
  const id = String(ticketId || '').trim();
  if (!id) return null;
  let cursor = null;
  let best = null;
  for (let page = 0; page < 20; page++) {
    const after = cursor ? `, before: "${cursor}"` : '';
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ notices(last: 100${after}) { pageInfo { hasPreviousPage startCursor } edges { node { index payload input { index } } } } }`,
      }),
    });
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    const json = await res.json();
    const conn = json?.data?.notices || {};
    for (const e of conn.edges || []) {
      let obj = null;
      try {
        obj = JSON.parse(hexToUtf8(e?.node?.payload));
      } catch {
        continue;
      }
      const typ = String(obj.type || '');
      if (
        typ !== 'pool_release_ticket' &&
        typ !== 'pool_release_authorized' &&
        typ !== 'pool_release_pending'
      ) {
        continue;
      }
      if (String(obj.ticketId || '') !== id) continue;
      const idx = Number(e?.node?.index ?? 0);
      const rank =
        typ === 'pool_release_authorized' || obj.status === 'authorized'
          ? 2
          : typ === 'pool_release_ticket'
            ? 1
            : 0;
      const bestRank = best
        ? best.type === 'pool_release_authorized' || best.status === 'authorized'
          ? 2
          : best.type === 'pool_release_ticket'
            ? 1
            : 0
        : -1;
      if (!best || rank > bestRank || (rank === bestRank && idx >= best._index)) {
        best = {
          ...obj,
          _index: idx,
          _inputIndex: e?.node?.input?.index ?? null,
          _payloadHex: e?.node?.payload || null,
          _proof: null,
          _hasProof: false,
        };
      }
    }
    if (best) break;
    if (!conn.pageInfo?.hasPreviousPage || !conn.pageInfo?.startCursor) break;
    cursor = conn.pageInfo.startCursor;
  }
  // Browser signers fall back to this snapshot when their GraphQL call fails
  // and then need the epoch proof to pass validateNotice — without it every
  // fallback read as "epoch not claimed". Same input-index lookup as the client.
  if (best && best._inputIndex != null) {
    try {
      best = { ...best, ...(await fetchNoticeProofByInput(best._inputIndex, id)) };
    } catch {
      /* proof stays null — client reports it as waiting */
    }
  }
  return best;
}

function noticeHasEpochProof(proof) {
  const v = proof?.validity;
  if (!v?.outputHashesRootHash || !v?.noticesEpochRootHash || !v?.machineStateHash) return false;
  return (
    Array.isArray(v.outputHashInOutputHashesSiblings) &&
    v.outputHashInOutputHashesSiblings.length > 0 &&
    Array.isArray(v.outputHashesInEpochSiblings) &&
    v.outputHashesInEpochSiblings.length > 0
  );
}

async function fetchNoticeProofByInput(inputIndex, ticketId) {
  const idx = Number(inputIndex);
  if (!Number.isFinite(idx) || idx < 0) return {};
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `{ input(index: ${idx}) { index notices { edges { node { index payload input { index } proof { context validity { inputIndexWithinEpoch outputIndexWithinInput outputHashesRootHash vouchersEpochRootHash noticesEpochRootHash machineStateHash outputHashInOutputHashesSiblings outputHashesInEpochSiblings } } } } } } }`,
    }),
  });
  if (!res.ok) throw new Error(`GraphQL input HTTP ${res.status}`);
  const json = await res.json();
  for (const e of json?.data?.input?.notices?.edges || []) {
    let obj = null;
    try {
      obj = JSON.parse(hexToUtf8(e?.node?.payload));
    } catch {
      continue;
    }
    if (String(obj?.ticketId || '') !== String(ticketId)) continue;
    const proof = e?.node?.proof || null;
    return {
      _index: Number(e?.node?.index ?? 0),
      _payloadHex: e?.node?.payload || null,
      _proof: proof,
      _hasProof: noticeHasEpochProof(proof),
    };
  }
  return {};
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
  };
}
