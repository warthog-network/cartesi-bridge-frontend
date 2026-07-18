import { ensureBuffer } from './ensureBuffer.js';
import { shouldUseNodeProxy } from './nodeAccess.js';
import { createBrowserWarthogApi } from './browserWarthogApi.js';

/** Normalize a node base URL from user input. */
export function normalizeNodeUrl(nodeBase) {
  let normalized = String(nodeBase || '').trim().replace(/\/+$/, '');
  if (!normalized) return '';
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) {
    normalized = `http://${normalized}`;
  }
  return normalized;
}

/**
 * Create a WarthogApi client for browser use.
 * Loopback nodes on HTTP pages connect directly; everything else uses /api/proxy
 * (required for HTTP nodes when the wallet is served over HTTPS).
 */
export async function createWarthogApi(nodeBase) {
  await ensureBuffer();
  const { WarthogApi } = await import('warthog-js');
  const normalized = normalizeNodeUrl(nodeBase);
  return createBrowserWarthogApi(WarthogApi, normalized, {
    useProxy: shouldUseNodeProxy(normalized),
  });
}

/** Convert WarthogApi result to the `{ code, data, error }` shape UI components expect. */
export function toNodeResponse(result) {
  if (result.success) {
    return { code: 0, data: result.data };
  }
  return { code: result.code, error: result.error };
}

/** Shape a successful submit result for transaction result cards. */
export function formatSubmitResult(data) {
  return toNodeResponse({ success: true, data });
}

/** Shape a failed submit result for transaction result cards. */
export function formatSubmitError(message) {
  return { code: -1, error: message };
}

/** GET a node path and return the legacy `{ code, data, error }` response shape. */
export async function getNodeData(api, path) {
  return toNodeResponse(await api.getNodePath(path));
}

/** POST to transaction/add (or another path) and return the legacy response shape. */
export async function postNodeData(api, path, body) {
  const normalized = path.replace(/^\//, '');
  if (normalized === 'transaction/add') {
    return toNodeResponse(await api.submitTransaction(body));
  }
  throw new Error(`Unsupported POST path: ${path}`);
}

/** Parse a 40- or 48-char recipient address. */
export function parseRecipientAddress(Address, raw) {
  const trimmed = raw.trim().replace(/^0x/i, '');
  return Address.fromHex(trimmed) ?? Address.fromRaw(trimmed);
}

/** Normalize an asset hash to lowercase 64-char hex (no 0x). */
export function normalizeAssetHash(raw) {
  return raw.trim().replace(/^0x/i, '').toLowerCase();
}

/**
 * Fetch fee + chain pin, sign a tx, and submit via WarthogApi.
 * Prefer `buildSpec` (signing worker). `privateKey` + `buildTx` remain as legacy fallback.
 * @returns {{ nonce: number, data: unknown }}
 */
export async function signAndSubmitTransaction(api, { privateKey, nonceId, buildTx, buildSpec }) {
  const { Account, NonceId, RoundedFee, normalizeChainPin } = await import('warthog-js');

  const feeRes = await api.getMinFee();
  if (!feeRes.success) {
    throw new Error(feeRes.error || 'Could not fetch minimum fee');
  }

  const fee = RoundedFee.fromE8(BigInt(feeRes.data.minFee.E8), true);
  if (!fee) {
    throw new Error('Invalid fee from node');
  }

  const nonce = NonceId.fromNumber(nonceId);
  if (!nonce) {
    throw new Error('Invalid nonce');
  }

  let tx;
  if (buildSpec) {
    const headRes = await api.getChainHead();
    if (!headRes.success) {
      throw new Error(headRes.error || 'Failed to fetch chain head');
    }
    const { pinHash, pinHeight } = normalizeChainPin(headRes.data);
    const ctxSnapshot = {
      pinHash,
      pinHeight,
      feeE8: String(feeRes.data.minFee.E8),
      nonceId,
    };
    try {
      const { buildTransactionInWorker } = await import('./signingBridge.js');
      tx = await buildTransactionInWorker(ctxSnapshot, buildSpec);
    } catch (workerErr) {
      // Worker vault missing / not unlocked — fall back to in-memory private key
      if (!privateKey) throw workerErr;
      const { ensureWorkerCrypto } = await import('./ensureBuffer.js');
      await ensureWorkerCrypto();
      const { TransactionContext } = await import('warthog-js');
      const { executeBuildSpec } = await import('./txBuildHandlers.js');
      const { serializeTransaction } = await import('./warthogTx.js');
      const ctx = new TransactionContext(
        { pinHash: String(pinHash).replace(/^0x/i, ''), pinHeight: Number(pinHeight) },
        fee,
        nonce,
      );
      const account = Account.fromPrivateKeyHex(String(privateKey).replace(/^0x/i, ''));
      const built = await executeBuildSpec(ctx, account, buildSpec);
      tx = built?.hex != null ? built : serializeTransaction(built);
    }
  } else if (privateKey && buildTx) {
    const ctx = await api.createTransactionContext(fee, nonce);
    const account = Account.fromPrivateKeyHex(privateKey);
    tx = await buildTx(ctx, account);
  } else {
    throw new Error('Wallet is locked — unlock to sign transactions');
  }

  const submitResult = await api.submitTransaction(tx);

  if (!submitResult.success) {
    throw new Error(submitResult.error || 'Node rejected transaction');
  }

  return { nonce: nonce.value, data: submitResult.data };
}

/**
 * Fetch full block payloads for history pages (timestamps + authoritative bodies).
 * @returns {{ timestampMap: Record<number, unknown>, fullBlockMap: Record<number, unknown> }}
 */
export async function fetchBlockDetails(api, perBlock) {
  if (!perBlock?.length) {
    return { timestampMap: {}, fullBlockMap: {} };
  }

  const responses = await Promise.allSettled(
    perBlock.map((block) => api.getBlock(block.height)),
  );

  const timestampMap = {};
  const fullBlockMap = {};

  responses.forEach((res, idx) => {
    if (res.status === 'fulfilled' && res.value.success) {
      const b = res.value.data;
      const h = perBlock[idx].height;
      timestampMap[h] = b?.header?.time?.timestamp || b?.timestamp || b?.header?.time;
      fullBlockMap[h] = b;
    }
  });

  return { timestampMap, fullBlockMap };
}