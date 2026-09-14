/**
 * The one server module that speaks to the Cartesi rollup.
 *
 *   ROLLUPS_API=v1 (default)  Cartesi CLI 1.5: GraphQL + GET /inspect/<payload>,
 *                             Application.validateNotice / executeVoucher, History.getClaim.
 *   ROLLUPS_API=v2            rollups-node 2.x: JSON-RPC `cartesi_*` on CARTESI_V2_RPC_URL,
 *                             POST /inspect/<app>, Application.validateOutput / executeOutput,
 *                             proofs = (outputIndex, outputHashesSiblings), claims = epoch status.
 *
 * Every v1 code path here is the code that used to live in poolTicketVerify.mjs,
 * poolVerifySnapshot.mjs, inspectHub.mjs and pool3pRotate.mjs, moved verbatim.
 * With ROLLUPS_API unset nothing changes. See /opt/cartesi-v2/PORT-DESIGN.md.
 *
 * Normalised shapes (both versions):
 *   Notice  { outputIndex, inputIndex, epochIndex, payloadHex, rawDataHex, proof, hasProof }
 *     v1: outputIndex = notice index within its input, proof = { context, validity }
 *     v2: outputIndex = global output index,            proof = { outputIndex, outputHashesSiblings } | null
 *   Voucher { outputIndex, inputIndex, epochIndex, destination, value, payloadHex, rawDataHex, proof, hasProof, executed, txHash, msgSender, timestamp }
 *
 * Release-ticket lookups return the notice payload object decorated with the
 * legacy `_index/_inputIndex/_payloadHex/_proof/_hasProof` fields (+ `_rawDataHex`,
 * `_epochIndex` on v2) because pool3p.mjs and the browser signers read those.
 */
import nodeProcess from 'node:process';
import { Interface, JsonRpcProvider, Wallet, Contract, keccak256, toUtf8Bytes, getAddress } from 'ethers-v6';

function env(key, fallback = '') {
  try {
    const v = nodeProcess.env[key];
    return v == null || v === '' ? fallback : String(v);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

export function apiVersion() {
  return String(env('ROLLUPS_API', 'v1')).trim().toLowerCase() === 'v2' ? 'v2' : 'v1';
}
export function isV2() {
  return apiVersion() === 'v2';
}

const V1_DAPP_DEFAULT = '0xab7528bb862fB57E8A2BCd567a2e929a0Be56a5e';
const V1_INPUT_BOX_DEFAULT = '0x59b22D57D4f067708AB0c00552767405926dc768';
const V2_INPUT_BOX_DEFAULT = '0x346B3df038FE9f8380071eC6514D5a83aD143939';

/** Application (v2) / DApp (v1) address, checksummed when parseable. */
export function appAddress() {
  const raw = isV2()
    ? env('CARTESI_APP_ADDRESS') || env('DAPP_ADDRESS') || env('CARTESI_DAPP')
    : env('CARTESI_DAPP') || env('DAPP_ADDRESS') || V1_DAPP_DEFAULT;
  try {
    return raw ? getAddress(raw) : raw;
  } catch {
    return raw;
  }
}
/** v2 JSON-RPC `application` param: name when configured, else address. */
export function appRef() {
  return env('CARTESI_APP_NAME') || appAddress();
}
export function inputBoxAddress() {
  return isV2()
    ? env('CARTESI_INPUT_BOX_ADDRESS') || env('INPUT_BOX') || V2_INPUT_BOX_DEFAULT
    : env('INPUT_BOX', V1_INPUT_BOX_DEFAULT);
}
export function l1RpcUrl() {
  return env('CARTESI_RPC_URL') || env('PUBLIC_L1_RPC') || 'http://127.0.0.1:8545';
}
export function graphqlUrl() {
  return env('CARTESI_GRAPHQL_URL', 'http://127.0.0.1:8080/graphql');
}
export function inspectBase() {
  return (
    isV2()
      ? env('CARTESI_V2_INSPECT_URL', 'http://127.0.0.1:8090/inspect')
      : env('CARTESI_INSPECT_URL', 'http://127.0.0.1:8080/inspect')
  ).replace(/\/$/, '');
}
export function nodeRpcUrl() {
  return env('CARTESI_V2_RPC_URL', 'http://127.0.0.1:8090/rpc');
}

const PUBLIC_ORIGIN_DEFAULT = 'https://cartesi-bridge.duckdns.org';
function absolutePublic(pathOrUrl, fallbackPath) {
  const s = String(pathOrUrl || fallbackPath || '');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return s;
  const origin = env('PUBLIC_BRIDGE_ORIGIN', PUBLIC_ORIGIN_DEFAULT).replace(/\/$/, '');
  return `${origin}${s.startsWith('/') ? s : `/${s}`}`;
}

/**
 * What the coordinator advertises to browser signers in every snapshot
 * (`pool3p_status`, `eth3p_status`, `?verifyTicket=`, `?threshold=`).
 * Absent/`api:'v1'` → today's behaviour in the client.
 */
export function rollupsInfo() {
  return publicRollupsBlock();
}
export function publicRollupsBlock() {
  if (isV2()) {
    return {
      api: 'v2',
      app: appAddress() || null,
      appName: env('CARTESI_APP_NAME') || null,
      rpcUrl: absolutePublic(env('PUBLIC_V2_RPC_URL'), '/v2/rpc'),
      inspectUrl: absolutePublic(env('PUBLIC_V2_INSPECT_URL'), '/v2/inspect'),
      l1RpcUrl: absolutePublic(env('PUBLIC_L1_RPC'), '/rpc'),
      inputBox: inputBoxAddress(),
    };
  }
  return {
    api: 'v1',
    app: appAddress() || null,
    graphqlUrl: absolutePublic(env('PUBLIC_GRAPHQL_URL'), '/rollup/graphql'),
    inspectUrl: absolutePublic(env('PUBLIC_INSPECT_URL'), '/rollup/inspect'),
    l1RpcUrl: absolutePublic(env('PUBLIC_L1_RPC'), '/rpc'),
    inputBox: inputBoxAddress(),
  };
}

// ---------------------------------------------------------------------------
// pure helpers (unit-tested by scripts/test-rollups-api.mjs)
// ---------------------------------------------------------------------------

/** First 4 bytes of keccak256(canonical signature), 0x-prefixed. */
export function selectorOf(signature) {
  return keccak256(toUtf8Bytes(String(signature))).slice(0, 10);
}
export const NOTICE_SIG = 'Notice(bytes)';
export const VOUCHER_SIG = 'Voucher(address,uint256,bytes)';
export const DELEGATE_CALL_VOUCHER_SIG = 'DelegateCallVoucher(address,bytes)';
export const NOTICE_SELECTOR = selectorOf(NOTICE_SIG);
export const VOUCHER_SELECTOR = selectorOf(VOUCHER_SIG);
export const DELEGATE_CALL_VOUCHER_SELECTOR = selectorOf(DELEGATE_CALL_VOUCHER_SIG);

export const OUTPUTS_ABI = [
  'function Notice(bytes payload)',
  'function Voucher(address destination, uint256 value, bytes payload)',
  'function DelegateCallVoucher(address destination, bytes payload)',
];
const OUTPUTS_IFACE = new Interface(OUTPUTS_ABI);
export const APPLICATION_V2_ABI = [
  'function validateOutput(bytes output, (uint64 outputIndex, bytes32[] outputHashesSiblings) proof) view',
  'function validateOutputHash(bytes32 outputHash, (uint64 outputIndex, bytes32[] outputHashesSiblings) proof) view',
  'function executeOutput(bytes output, (uint64 outputIndex, bytes32[] outputHashesSiblings) proof)',
  'function wasOutputExecuted(uint256 outputIndex) view returns (bool)',
  'function getOutputsMerkleRootValidator() view returns (address)',
  'function getTemplateHash() view returns (bytes32)',
];
export const CONSENSUS_V2_ABI = [
  'function isOutputsMerkleRootValid(address appContract, bytes32 outputsMerkleRoot) view returns (bool)',
  'function getEpochLength() view returns (uint256)',
];
export const INPUT_BOX_ABI = ['function addInput(address app, bytes input) returns (bytes32)'];
export const APPLICATION_V1_ABI = [
  'function validateNotice(bytes notice, tuple(tuple(uint64 inputIndexWithinEpoch, uint64 outputIndexWithinInput, bytes32 outputHashesRootHash, bytes32 vouchersEpochRootHash, bytes32 noticesEpochRootHash, bytes32 machineStateHash, bytes32[] outputHashInOutputHashesSiblings, bytes32[] outputHashesInEpochSiblings) validity, bytes context) proof) view returns (bool)',
  'function getConsensus() view returns (address)',
];
const APP_V2_IFACE = new Interface(APPLICATION_V2_ABI);

function hex0x(h) {
  const s = String(h || '');
  if (!s) return '0x';
  return s.startsWith('0x') || s.startsWith('0X') ? `0x${s.slice(2)}` : `0x${s}`;
}
export function hexToUtf8(raw) {
  const s = String(raw || '');
  if (!s.startsWith('0x')) return s;
  try {
    return Buffer.from(s.slice(2), 'hex').toString('utf8');
  } catch {
    return '';
  }
}
export function decodeJsonPayload(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(hexToUtf8(raw));
  } catch {
    return null;
  }
}

/** v2 raw_data → { type: 'notice'|'voucher'|'delegatecall'|'unknown', payloadHex, destination?, value? } */
export function decodeOutputRawData(rawDataHex) {
  const raw = hex0x(rawDataHex);
  if (raw.length < 10) return { type: 'unknown', payloadHex: null };
  const sel = raw.slice(0, 10).toLowerCase();
  try {
    if (sel === NOTICE_SELECTOR) {
      const [payload] = OUTPUTS_IFACE.decodeFunctionData('Notice', raw);
      return { type: 'notice', payloadHex: String(payload) };
    }
    if (sel === VOUCHER_SELECTOR) {
      const [destination, value, payload] = OUTPUTS_IFACE.decodeFunctionData('Voucher', raw);
      return { type: 'voucher', destination: String(destination), value: BigInt(value).toString(), payloadHex: String(payload) };
    }
    if (sel === DELEGATE_CALL_VOUCHER_SELECTOR) {
      const [destination, payload] = OUTPUTS_IFACE.decodeFunctionData('DelegateCallVoucher', raw);
      return { type: 'delegatecall', destination: String(destination), payloadHex: String(payload) };
    }
  } catch {
    /* fall through */
  }
  return { type: 'unknown', payloadHex: null };
}
/** Inverse of decodeOutputRawData for notices (what the machine emits for POST /notice). */
export function encodeNoticeRawData(payloadHex) {
  return OUTPUTS_IFACE.encodeFunctionData('Notice', [hex0x(payloadHex)]);
}
export function encodeVoucherRawData(destination, value, payloadHex) {
  return OUTPUTS_IFACE.encodeFunctionData('Voucher', [destination, BigInt(value || 0), hex0x(payloadHex)]);
}

/** v2 proof tuple as ethers expects it. */
export function proofTupleV2(proof) {
  if (!proof) throw new Error('output has no proof yet (epoch not claimed)');
  const sibs = (proof.outputHashesSiblings || []).map((s) => {
    const h = hex0x(s).slice(2).padStart(64, '0');
    return `0x${h}`;
  });
  return { outputIndex: BigInt(proof.outputIndex ?? 0), outputHashesSiblings: sibs };
}
export function encodeValidateOutputCall(rawDataHex, proof) {
  return APP_V2_IFACE.encodeFunctionData('validateOutput', [hex0x(rawDataHex), proofTupleV2(proof)]);
}
export function encodeExecuteOutputCall(rawDataHex, proof) {
  return APP_V2_IFACE.encodeFunctionData('executeOutput', [hex0x(rawDataHex), proofTupleV2(proof)]);
}
export function proofV2Ready(proof) {
  return !!(proof && Array.isArray(proof.outputHashesSiblings) && proof.outputHashesSiblings.length > 0);
}

/** v1 epoch-proof completeness (moved from poolTicketVerify / poolVerifySnapshot). */
export function noticeHasEpochProofV1(proof) {
  const v = proof?.validity;
  if (!v?.outputHashesRootHash || !v?.noticesEpochRootHash || !v?.machineStateHash) return false;
  return (
    Array.isArray(v.outputHashInOutputHashesSiblings) &&
    v.outputHashInOutputHashesSiblings.length > 0 &&
    Array.isArray(v.outputHashesInEpochSiblings) &&
    v.outputHashesInEpochSiblings.length > 0
  );
}
/** Version-agnostic: does this notice carry a usable on-chain proof? */
export function noticeHasProof(noticeOrProof) {
  const proof = noticeOrProof && 'proof' in noticeOrProof && !('validity' in noticeOrProof)
    ? noticeOrProof.proof
    : noticeOrProof;
  if (!proof) return false;
  if (proof.validity || proof.context != null) return noticeHasEpochProofV1(proof);
  return proofV2Ready(proof);
}

function num(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

const REQ_MS = Number(env('ROLLUPS_API_REQ_MS', '12000')) || 12000;

export async function fetchWithTimeout(url, init = {}, ms = REQ_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { cache: 'no-store', ...init, signal: init.signal || ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

let rpcId = 0;
/** v2 node JSON-RPC (`cartesi_*`). Named params object. */
/** rollups-node 2.x JSON-RPC takes uint64 indices as 0x-hex strings, not JSON numbers. */
export function hexIndex(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`bad index ${v}`);
  return '0x' + Math.trunc(n).toString(16);
}

export async function rpcCall(method, params = {}, { timeoutMs } = {}) {
  const res = await fetchWithTimeout(
    nodeRpcUrl(),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    },
    timeoutMs || REQ_MS,
  );
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body?.error) {
    const e = new Error(`${method}: ${body.error.message || 'rpc error'}`);
    e.code = body.error.code;
    e.data = body.error.data;
    throw e;
  }
  return body?.result;
}

/** v1 GraphQL POST (moved from the callers). */
export async function graphqlQuery(query, { timeoutMs } = {}) {
  const res = await fetchWithTimeout(
    graphqlUrl(),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query }),
    },
    timeoutMs || REQ_MS,
  );
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json?.errors?.length) throw new Error(json.errors[0]?.message || 'GraphQL error');
  return json?.data;
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

/**
 * Raw inspect body for a payload path such as `pool` or `pool/<owner>`.
 * v1: GET  {inspect}/{payloadPath}
 * v2: POST {inspect}/{app}  body = payloadPath bytes
 * Returns the node's JSON as-is ({status, reports:[{payload}], processed_input_count, exception_payload}).
 */
export async function inspectFetch(payloadPath, { baseOverride = null, timeoutMs } = {}) {
  const path = String(payloadPath || '').replace(/^\//, '');
  if (isV2()) {
    const base = (baseOverride || inspectBase()).replace(/\/$/, '');
    const res = await fetchWithTimeout(
      `${base}/${appRef()}`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from(path, 'utf8') },
      timeoutMs || REQ_MS,
    );
    if (!res.ok) throw new Error(`inspect HTTP ${res.status}`);
    return res.json();
  }
  const base = (baseOverride || inspectBase()).replace(/\/$/, '');
  const res = await fetchWithTimeout(`${base}/${path}`, {}, timeoutMs || REQ_MS);
  if (!res.ok) throw new Error(`inspect HTTP ${res.status}`);
  return res.json();
}

/** Normalised inspect read. */
export async function inspectRead(payloadPath, opts = {}) {
  const raw = await inspectFetch(payloadPath, opts);
  return {
    status: raw?.status ?? null,
    reports: raw?.reports || [],
    processedInputCount: num(raw?.processed_input_count),
    exception: raw?.exception_payload ?? raw?.exception ?? null,
    decoded: decodeJsonPayload(raw?.reports?.[0]?.payload),
    raw,
  };
}

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

/** Total inputs the indexer knows (v1 `inputs.totalCount`, v2 `pagination.total_count`). */
export async function inputTotal() {
  if (isV2()) {
    const r = await rpcCall('cartesi_listInputs', { application: appRef(), limit: 1, offset: 0 });
    const n = num(r?.pagination?.total_count);
    if (n == null) throw new Error('cartesi_listInputs: no total_count');
    return n;
  }
  const data = await graphqlQuery('{ inputs { totalCount } }');
  const n = num(data?.inputs?.totalCount);
  if (n == null) throw new Error('inputs.totalCount missing');
  return n;
}

export async function processedInputCount() {
  if (isV2()) {
    const r = await rpcCall('cartesi_getProcessedInputCount', { application: appRef() });
    const d = r?.data ?? r;
    const n = num(typeof d === 'object' ? (d.processed_input_count ?? d.count ?? d.value) : d);
    if (n == null) throw new Error('cartesi_getProcessedInputCount: unexpected result');
    return n;
  }
  const r = await inspectRead('pool');
  return r.processedInputCount;
}

// ---------------------------------------------------------------------------
// notices
// ---------------------------------------------------------------------------

function noticeFromOutputV2(o) {
  const dec = o?.decoded_data && typeof o.decoded_data === 'object' ? o.decoded_data : null;
  const parsed = decodeOutputRawData(o?.raw_data);
  const payloadHex = dec?.payload ? hex0x(dec.payload) : parsed.payloadHex;
  const sibs = Array.isArray(o?.output_hashes_siblings) ? o.output_hashes_siblings : null;
  const proof = sibs && sibs.length ? { outputIndex: num(o.index, 0), outputHashesSiblings: sibs.map(hex0x) } : null;
  return {
    outputIndex: num(o?.index, 0),
    inputIndex: num(o?.input_index),
    epochIndex: num(o?.epoch_index),
    payloadHex,
    rawDataHex: hex0x(o?.raw_data),
    proof,
    hasProof: proofV2Ready(proof),
    executionTxHash: o?.execution_transaction_hash || null,
  };
}
function noticeFromEdgeV1(node) {
  const proof = node?.proof || null;
  return {
    outputIndex: num(node?.index, 0),
    inputIndex: num(node?.input?.index),
    epochIndex: null,
    payloadHex: node?.payload || null,
    rawDataHex: null,
    proof,
    hasProof: noticeHasEpochProofV1(proof),
  };
}

const V1_NOTICE_FIELDS =
  'index payload input { index } proof { context validity { inputIndexWithinEpoch outputIndexWithinInput outputHashesRootHash vouchersEpochRootHash noticesEpochRootHash machineStateHash outputHashInOutputHashesSiblings outputHashesInEpochSiblings } }';

/** Every notice produced by one input. */
export async function findNoticesByInput(inputIndex) {
  const idx = Number(inputIndex);
  if (!Number.isFinite(idx) || idx < 0) return [];
  if (isV2()) {
    const r = await rpcCall('cartesi_listOutputs', {
      application: appRef(),
      // rollups-node 2.x wants indices hex-encoded ("0x2fb"); a JSON number is "Invalid parameters".
      input_index: hexIndex(idx),
      output_type: NOTICE_SELECTOR,
      limit: 100,
      offset: 0,
    });
    return (r?.data || []).map(noticeFromOutputV2);
  }
  const data = await graphqlQuery(`{ input(index: ${idx}) { index notices { edges { node { ${V1_NOTICE_FIELDS} } } } } }`);
  return (data?.input?.notices?.edges || []).map((e) => noticeFromEdgeV1(e?.node));
}

/**
 * Newest-first page of notices.
 * v1: `before` is a GraphQL cursor; returns {notices, pageInfo}.
 * v2: `before` is an offset (number of newest outputs to skip); returns {notices, pageInfo:{hasPreviousPage,startCursor:<nextOffset>}}.
 */
export async function listRecentNotices({ limit = 100, before = null } = {}) {
  if (isV2()) {
    const offset = num(before, 0) || 0;
    const r = await rpcCall('cartesi_listOutputs', {
      application: appRef(),
      output_type: NOTICE_SELECTOR,
      limit,
      offset,
      descending: true,
    });
    const rows = (r?.data || []).map(noticeFromOutputV2);
    const total = num(r?.pagination?.total_count, 0);
    const next = offset + rows.length;
    return { notices: rows, pageInfo: { hasPreviousPage: next < total, startCursor: next < total ? String(next) : null }, totalCount: total };
  }
  const after = before ? `, before: ${JSON.stringify(before)}` : '';
  const data = await graphqlQuery(
    `{ notices(last: ${limit}${after}) { pageInfo { hasPreviousPage startCursor } edges { node { ${V1_NOTICE_FIELDS} } } } }`,
  );
  const conn = data?.notices || {};
  // GraphQL `last:` pages are oldest→newest inside the page; callers rank by index anyway.
  return {
    notices: (conn.edges || []).map((e) => noticeFromEdgeV1(e?.node)),
    pageInfo: conn.pageInfo || {},
    totalCount: null,
  };
}

/**
 * Oldest-first page for indexers (claimsIndexer).
 * v1 uses GraphQL `first/after` cursors; v2 uses offsets. Returns
 * {notices, totalCount, pageInfo:{hasNextPage, endCursor}}.
 */
export async function listNoticesAscending({ first = 200, after = null } = {}) {
  if (isV2()) {
    const offset = num(after, 0) || 0;
    const r = await rpcCall('cartesi_listOutputs', {
      application: appRef(),
      output_type: NOTICE_SELECTOR,
      limit: first,
      offset,
      descending: false,
    });
    const rows = (r?.data || []).map(noticeFromOutputV2);
    const total = num(r?.pagination?.total_count, 0);
    const next = offset + rows.length;
    return { notices: rows, totalCount: total, pageInfo: { hasNextPage: next < total, endCursor: next < total ? String(next) : null } };
  }
  const afterPart = after ? `, after: ${JSON.stringify(after)}` : '';
  const data = await graphqlQuery(`{ notices(first: ${first}${afterPart}) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges { cursor node { index input { index } payload } }
  } }`);
  const conn = data?.notices || {};
  return {
    notices: (conn.edges || []).map((e) => ({ ...noticeFromEdgeV1(e?.node), cursor: e?.cursor || null })),
    totalCount: num(conn.totalCount),
    pageInfo: conn.pageInfo || {},
    raw: conn,
  };
}

function rankReleaseNotice(obj) {
  const typ = String(obj?.type || '');
  if (typ === 'pool_release_authorized' || obj?.status === 'authorized') return 2;
  if (typ === 'pool_release_ticket') return 1;
  if (typ === 'pool_release_pending') return 0;
  return -1;
}

function decorateReleaseNotice(obj, n) {
  return {
    ...obj,
    _index: n.outputIndex,
    _inputIndex: n.inputIndex,
    _epochIndex: n.epochIndex ?? null,
    _payloadHex: n.payloadHex,
    _rawDataHex: n.rawDataHex ?? null,
    _proof: n.proof,
    _hasProof: n.hasProof,
  };
}

/**
 * Walk notices newest-first for the best pool_release_* notice of a ticket.
 * Moved from poolTicketVerify.findReleaseTicketNotice (v1 query byte-identical);
 * when the page carried no proof, the by-input lookup fills it (what
 * poolVerifySnapshot did for the signer fallback).
 */
export async function findReleaseTicketNotice(ticketId, { pages = 20, withProofByInput = true } = {}) {
  const id = String(ticketId || '').trim();
  if (!id) return null;
  let cursor = null;
  let best = null;
  for (let page = 0; page < Math.min(30, Number(pages) || 20); page++) {
    const { notices, pageInfo } = await listRecentNotices({ limit: 100, before: cursor });
    for (const n of notices) {
      const obj = decodeJsonPayload(n.payloadHex);
      if (!obj) continue;
      if (rankReleaseNotice(obj) < 0) continue;
      if (String(obj.ticketId || '') !== id) continue;
      const rank = rankReleaseNotice(obj);
      const bestRank = best ? rankReleaseNotice(best) : -1;
      if (!best || rank > bestRank || (rank === bestRank && n.outputIndex >= best._index)) {
        best = decorateReleaseNotice(obj, n);
      }
    }
    if (best) break;
    if (!pageInfo?.hasPreviousPage || !pageInfo?.startCursor) break;
    cursor = pageInfo.startCursor;
  }
  if (best && withProofByInput && !best._hasProof && best._inputIndex != null) {
    try {
      best = { ...best, ...(await fetchNoticeProofByInput(best._inputIndex, id)) };
    } catch {
      /* proof stays null — client reports it as waiting */
    }
  }
  return best;
}

/** Proof fields for the notice of `ticketId` inside one input (moved from poolVerifySnapshot). */
export async function fetchNoticeProofByInput(inputIndex, ticketId) {
  const rows = await findNoticesByInput(inputIndex);
  for (const n of rows) {
    const obj = decodeJsonPayload(n.payloadHex);
    if (String(obj?.ticketId || '') !== String(ticketId)) continue;
    return {
      _index: n.outputIndex,
      _payloadHex: n.payloadHex,
      _rawDataHex: n.rawDataHex ?? null,
      _epochIndex: n.epochIndex ?? null,
      _proof: n.proof,
      _hasProof: n.hasProof,
    };
  }
  return {};
}

// ---------------------------------------------------------------------------
// epochs / L1
// ---------------------------------------------------------------------------

export async function getEpoch(epochIndex) {
  const r = await rpcCall('cartesi_getEpoch', { application: appRef(), epoch_index: hexIndex(epochIndex) });
  return r?.data ?? r;
}

export async function getApplication() {
  const r = await rpcCall('cartesi_getApplication', { application: appRef() });
  return r?.data ?? r;
}

function toNoticeLike(x) {
  // accept a decorated release notice, a normalised Notice, or a Voucher
  if (!x) return null;
  if ('_proof' in x) {
    return { proof: x._proof, rawDataHex: x._rawDataHex, payloadHex: x._payloadHex, epochIndex: x._epochIndex, outputIndex: x._index };
  }
  return x;
}

let _historyAddr = null;
/** Has L1 accepted the claim covering this output? */
export async function epochClaimed(noticeOrVoucher) {
  const n = toNoticeLike(noticeOrVoucher);
  if (!n) return false;
  if (isV2()) {
    if (proofV2Ready(n.proof)) return true;
    if (n.epochIndex == null) return false;
    try {
      const ep = await getEpoch(n.epochIndex);
      return String(ep?.status || '') === 'CLAIM_ACCEPTED';
    } catch {
      return false;
    }
  }
  const ctx = n.proof?.context;
  if (!ctx) return false;
  try {
    const provider = new JsonRpcProvider(l1RpcUrl());
    if (!_historyAddr) {
      const app = new Contract(appAddress(), ['function getConsensus() view returns (address)'], provider);
      const consensus = await app.getConsensus();
      const cons = new Contract(consensus, ['function getHistory() view returns (address)'], provider);
      _historyAddr = await cons.getHistory();
    }
    const hist = new Contract(_historyAddr, ['function getClaim(address,bytes) view returns (bytes32,uint256,uint256)'], provider);
    await hist.getClaim(appAddress(), hex0x(ctx));
    return true;
  } catch {
    return false;
  }
}

/**
 * Prove the notice on L1.
 * v2: eth_call Application.validateOutput(raw_data, proof) — reverts on a bad proof.
 * v1: Application.validateNotice(payload, {validity, context}) → bool.
 */
export async function validateNoticeOnL1(noticeOrVoucher) {
  const n = toNoticeLike(noticeOrVoucher);
  if (!n) return { ok: false, error: 'no notice' };
  if (isV2()) {
    if (!proofV2Ready(n.proof)) return { ok: false, waiting: true, error: 'waiting for output proof (epoch not claimed)' };
    if (!n.rawDataHex) return { ok: false, error: 'notice has no raw_data' };
    try {
      const provider = new JsonRpcProvider(l1RpcUrl());
      await provider.call({ to: appAddress(), data: encodeValidateOutputCall(n.rawDataHex, n.proof) });
      return { ok: true, method: 'validateOutput' };
    } catch (e) {
      return { ok: false, error: e?.shortMessage || e?.reason || e?.message || String(e) };
    }
  }
  if (!noticeHasEpochProofV1(n.proof) || !n.payloadHex) {
    return { ok: false, waiting: true, error: 'waiting for Cartesi notice proof (epoch not claimed)' };
  }
  try {
    const provider = new JsonRpcProvider(l1RpcUrl());
    const app = new Contract(appAddress(), APPLICATION_V1_ABI, provider);
    const v = n.proof.validity;
    const proof = {
      validity: {
        inputIndexWithinEpoch: BigInt(v.inputIndexWithinEpoch),
        outputIndexWithinInput: BigInt(v.outputIndexWithinInput),
        outputHashesRootHash: v.outputHashesRootHash,
        vouchersEpochRootHash: v.vouchersEpochRootHash,
        noticesEpochRootHash: v.noticesEpochRootHash,
        machineStateHash: v.machineStateHash,
        outputHashInOutputHashesSiblings: v.outputHashInOutputHashesSiblings,
        outputHashesInEpochSiblings: v.outputHashesInEpochSiblings,
      },
      context: hex0x(n.proof.context || ''),
    };
    const ok = await app.validateNotice(n.payloadHex, proof);
    return ok ? { ok: true, method: 'validateNotice' } : { ok: false, error: 'validateNotice returned false' };
  } catch (e) {
    return { ok: false, error: e?.shortMessage || e?.message || String(e) };
  }
}

export async function wasOutputExecuted(outputIndex) {
  if (!isV2()) throw new Error('wasOutputExecuted is v2-only (v1 uses wasVoucherExecuted(inputIndex, outputIndexWithinInput))');
  const provider = new JsonRpcProvider(l1RpcUrl());
  const app = new Contract(appAddress(), APPLICATION_V2_ABI, provider);
  return app.wasOutputExecuted(BigInt(outputIndex));
}

// ---------------------------------------------------------------------------
// vouchers
// ---------------------------------------------------------------------------

function voucherFromOutputV2(o) {
  const dec = o?.decoded_data && typeof o.decoded_data === 'object' ? o.decoded_data : null;
  const parsed = decodeOutputRawData(o?.raw_data);
  const sibs = Array.isArray(o?.output_hashes_siblings) ? o.output_hashes_siblings : null;
  const proof = sibs && sibs.length ? { outputIndex: num(o.index, 0), outputHashesSiblings: sibs.map(hex0x) } : null;
  return {
    outputIndex: num(o?.index, 0),
    inputIndex: num(o?.input_index),
    epochIndex: num(o?.epoch_index),
    destination: dec?.destination || parsed.destination || null,
    value: dec?.value != null ? String(dec.value) : parsed.value ?? '0',
    payloadHex: dec?.payload ? hex0x(dec.payload) : parsed.payloadHex,
    rawDataHex: hex0x(o?.raw_data),
    proof,
    hasProof: proofV2Ready(proof),
    executed: !!o?.execution_transaction_hash,
    txHash: o?.execution_transaction_hash || null,
    msgSender: null,
    timestamp: null,
  };
}

export async function listVouchers({ limit = 40 } = {}) {
  if (isV2()) {
    const r = await rpcCall('cartesi_listOutputs', {
      application: appRef(),
      output_type: VOUCHER_SELECTOR,
      limit,
      offset: 0,
      descending: true,
    });
    return (r?.data || []).map(voucherFromOutputV2);
  }
  const data = await graphqlQuery(`{ vouchers(last: ${limit}) { edges { node { index destination payload input { index msgSender timestamp } proof { context validity { inputIndexWithinEpoch outputIndexWithinInput outputHashesRootHash vouchersEpochRootHash noticesEpochRootHash machineStateHash outputHashInOutputHashesSiblings outputHashesInEpochSiblings } } } } } }`);
  return (data?.vouchers?.edges || [])
    .map((e) => e?.node)
    .filter(Boolean)
    .map((n) => ({
      outputIndex: num(n.index, 0),
      inputIndex: num(n.input?.index),
      epochIndex: null,
      destination: n.destination,
      value: '0',
      payloadHex: n.payload,
      rawDataHex: null,
      proof: n.proof || null,
      hasProof: noticeHasEpochProofV1(n.proof),
      executed: null,
      txHash: null,
      msgSender: n.input?.msgSender || null,
      timestamp: n.input?.timestamp != null ? Number(n.input.timestamp) : null,
    }))
    .sort((a, b) => (b.inputIndex !== a.inputIndex ? b.inputIndex - a.inputIndex : b.outputIndex - a.outputIndex));
}

// ---------------------------------------------------------------------------
// inputs (write)
// ---------------------------------------------------------------------------

/**
 * InputBox.addInput(app, payload). Same call on both versions; only the
 * addresses differ. Payload may be a JSON object, a string, hex or bytes.
 */
export async function addInput(payload, { pk = null } = {}) {
  const key =
    pk ||
    env('RELAYER_PK') ||
    env('ANVIL_PK') ||
    '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
  const provider = new JsonRpcProvider(l1RpcUrl());
  const wallet = new Wallet(key, provider);
  const box = new Contract(inputBoxAddress(), INPUT_BOX_ABI, wallet);
  let bytes;
  if (payload instanceof Uint8Array) bytes = payload;
  else if (typeof payload === 'string' && /^0x[0-9a-fA-F]*$/.test(payload)) bytes = payload;
  else bytes = toUtf8Bytes(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const tx = await box.addInput(appAddress(), bytes);
  const rec = await tx.wait();
  return { ok: true, txHash: rec?.hash || tx.hash };
}
