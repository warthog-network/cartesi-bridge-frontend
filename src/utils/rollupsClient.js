/**
 * Browser-side rollup reads, version-switched like the server's rollupsApi.mjs.
 *
 *   PUBLIC_ROLLUPS_API=v1 (default)  Cartesi 1.5: GraphQL (/rollup/graphql) + GET /rollup/inspect/<payload>
 *   PUBLIC_ROLLUPS_API=v2            rollups-node 2.x: JSON-RPC cartesi_* (/v2/rpc) + POST /v2/inspect/<app>
 *
 * v1 callers keep their exact requests; this module only adds the v2 branch
 * and a few shared helpers. Selectors are derived, not typed in — see
 * scripts/test-rollups-api.mjs for the expected values.
 */
import { keccak256, toUtf8Bytes, Interface } from 'ethers-v6';
import {
  isRollupsV2,
  getV2RpcUrl,
  getV2InspectUrl,
  getRollupGraphqlUrl,
  getInspectUrl,
  getAppRef,
} from './bridgeConfig.js';

export function selectorOf(signature) {
  return keccak256(toUtf8Bytes(String(signature))).slice(0, 10);
}
export const NOTICE_SELECTOR = selectorOf('Notice(bytes)');
export const VOUCHER_SELECTOR = selectorOf('Voucher(address,uint256,bytes)');
export const DELEGATE_CALL_VOUCHER_SELECTOR = selectorOf('DelegateCallVoucher(address,bytes)');

const OUTPUTS_IFACE = new Interface([
  'function Notice(bytes payload)',
  'function Voucher(address destination, uint256 value, bytes payload)',
  'function DelegateCallVoucher(address destination, bytes payload)',
]);

export const isV2 = isRollupsV2;

function hex0x(h) {
  const s = String(h || '');
  if (!s) return '0x';
  return s.startsWith('0x') || s.startsWith('0X') ? `0x${s.slice(2)}` : `0x${s}`;
}

/** v2 raw_data → { type, payloadHex, destination?, value? } */
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

async function fetchWithTimeout(url, init = {}, ms = 12000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const onAbort = () => ac.abort();
  if (init.signal) init.signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { cache: 'no-store', ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
    if (init.signal) init.signal.removeEventListener('abort', onAbort);
  }
}

let rpcId = 0;
/** v2 node JSON-RPC (`cartesi_*`), named params. */
export async function rpcCall(method, params = {}, { signal, timeoutMs = 12000 } = {}) {
  const res = await fetchWithTimeout(
    getV2RpcUrl(),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal,
    },
    timeoutMs,
  );
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body?.error) throw new Error(`${method}: ${body.error.message || 'rpc error'}`);
  return body?.result;
}

/** v1 GraphQL POST. */
export async function graphqlQuery(query, { signal, timeoutMs = 12000 } = {}) {
  const res = await fetchWithTimeout(
    getRollupGraphqlUrl(),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query }),
      signal,
    },
    timeoutMs,
  );
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json?.errors?.length) throw new Error(json.errors[0]?.message || 'GraphQL error');
  return json?.data;
}

/**
 * Raw inspect JSON for a payload path (`pool`, `pool/<owner>`, `vault/<hex>`).
 * v1: GET  {inspect}/{path}     v2: POST {inspect}/{app} body=path
 * Same `{status, reports:[{payload}], processed_input_count}` shape on both.
 */
export async function inspectRaw(payloadPath, { signal, timeoutMs = 8000, base = null } = {}) {
  const path = String(payloadPath || '').replace(/^\//, '');
  if (isV2()) {
    const b = (base || getV2InspectUrl()).replace(/\/$/, '');
    const res = await fetchWithTimeout(
      `${b}/${getAppRef()}`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: path, signal },
      timeoutMs,
    );
    if (!res.ok) throw new Error(`inspect ${res.status}`);
    return res.json();
  }
  const b = (base || getInspectUrl()).replace(/\/$/, '');
  const res = await fetchWithTimeout(`${b}/${path}`, { signal }, timeoutMs);
  if (!res.ok) throw new Error(`inspect ${res.status}`);
  return res.json();
}

function num(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** v2 output row → normalised {outputIndex, inputIndex, epochIndex, type, payloadHex, rawData, destination, value, proof, hasProof, executed, txHash} */
export function normalizeOutputV2(o) {
  const dec = o?.decoded_data && typeof o.decoded_data === 'object' ? o.decoded_data : null;
  const parsed = decodeOutputRawData(o?.raw_data);
  const sibs = Array.isArray(o?.output_hashes_siblings) ? o.output_hashes_siblings : null;
  const proof = sibs && sibs.length ? { outputIndex: num(o.index, 0), outputHashesSiblings: sibs.map(hex0x) } : null;
  return {
    outputIndex: num(o?.index, 0),
    inputIndex: num(o?.input_index),
    epochIndex: num(o?.epoch_index),
    type: parsed.type,
    payloadHex: dec?.payload ? hex0x(dec.payload) : parsed.payloadHex,
    rawData: hex0x(o?.raw_data),
    destination: dec?.destination || parsed.destination || null,
    value: dec?.value != null ? String(dec.value) : parsed.value ?? '0',
    proof,
    hasProof: !!proof,
    executed: !!o?.execution_transaction_hash,
    txHash: o?.execution_transaction_hash || null,
  };
}

/** v2: newest-first outputs of one type. */
export async function listOutputsV2({ outputType, limit = 50, offset = 0, inputIndex = null, descending = true, signal } = {}) {
  const params = { application: getAppRef(), limit, offset, descending };
  if (outputType) params.output_type = outputType;
  if (inputIndex != null) params.input_index = Number(inputIndex);
  const r = await rpcCall('cartesi_listOutputs', params, { signal });
  return { rows: (r?.data || []).map(normalizeOutputV2), totalCount: num(r?.pagination?.total_count, 0) };
}

/**
 * The `notices(last: N)` read every island does: returns edges `[{node:{payload,index,inputIndex}}]`
 * oldest→newest within the last N, so v1 callers keep their semantics.
 */
export async function fetchNoticeEdges(last = 50, { signal, timeoutMs = 10000 } = {}) {
  if (isV2()) {
    const { rows } = await listOutputsV2({ outputType: NOTICE_SELECTOR, limit: last, descending: true, signal });
    return rows
      .slice()
      .reverse()
      .map((n) => ({ node: { payload: n.payloadHex, index: n.outputIndex, inputIndex: n.inputIndex, input: { index: n.inputIndex } } }));
  }
  const data = await graphqlQuery(`{ notices(last: ${last}) { edges { node { payload } } } }`, { signal, timeoutMs });
  return data?.notices?.edges || [];
}

const senderCache = new Map();
/** v2: msgSender of an input (cached; vouchers carry no sender). */
export async function inputSenderV2(inputIndex, { signal } = {}) {
  const k = Number(inputIndex);
  if (!Number.isFinite(k)) return null;
  if (senderCache.has(k)) return senderCache.get(k);
  try {
    const r = await rpcCall('cartesi_getInput', { application: getAppRef(), input_index: k }, { signal });
    const d = r?.data ?? r;
    const sender = d?.decoded_data?.sender || null;
    const ts = d?.decoded_data?.block_timestamp != null ? Number(d.decoded_data.block_timestamp) : null;
    const v = { sender, timestamp: ts };
    senderCache.set(k, v);
    return v;
  } catch {
    return null;
  }
}

export async function getEpochV2(epochIndex, { signal } = {}) {
  const r = await rpcCall('cartesi_getEpoch', { application: getAppRef(), epoch_index: Number(epochIndex) }, { signal });
  return r?.data ?? r;
}

/** Is the rollup reachable? v2 asks the node for the application; v1 callers keep their own probes. */
export async function probeV2({ signal } = {}) {
  try {
    const r = await rpcCall('cartesi_getApplication', { application: getAppRef() }, { signal, timeoutMs: 5000 });
    return !!(r?.data ?? r);
  } catch {
    return false;
  }
}
