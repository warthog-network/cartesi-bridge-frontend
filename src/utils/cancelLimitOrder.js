import { signAndSubmitTransaction } from './warthogClient.js';

/** Next nonce for signing — mirrors DEX page persistent nonce tracking. */
export function getSmartNonce(walletAddress, contextNextNonce) {
  if (!walletAddress) return contextNextNonce ?? 0;
  try {
    const stored = localStorage.getItem(`warthogNextNonce_${walletAddress}`);
    const persistentNonce = stored ? Number(stored) : 0;
    return Math.max(persistentNonce, contextNextNonce ?? 0, 0);
  } catch {
    return contextNextNonce ?? 0;
  }
}

export function bumpNonceAfterSuccess(walletAddress, usedNonce, contextNextNonce) {
  if (!walletAddress) return;
  const newNonce = Math.max(getSmartNonce(walletAddress, contextNextNonce), usedNonce + 1);
  try {
    localStorage.setItem(`warthogNextNonce_${walletAddress}`, String(newNonce));
  } catch {
    // ignore storage errors
  }
}

async function findInMempool(api, address, txHash) {
  const res = await api.getAccountMempool(address);
  if (!res.success || !Array.isArray(res.data)) return null;

  const normalized = txHash.toLowerCase();
  for (const entry of res.data) {
    const hash = entry?.transaction?.hash;
    if (hash?.toLowerCase() !== normalized) continue;

    const signedCommon = entry.transaction?.signedCommon;
    if (signedCommon?.pinHeight != null && signedCommon?.nonceId != null) {
      return {
        cancelHeight: Number(signedCommon.pinHeight),
        cancelNonceId: Number(signedCommon.nonceId),
      };
    }
  }
  return null;
}

/**
 * Resolve pinHeight + nonceId for the original limit order tx (required by cancelation).
 * Open order entries only include txHash — look up via node API.
 */
export async function resolveOrderCancelTarget(api, txHash, accountAddress) {
  const normalized = txHash?.trim().toLowerCase();
  if (!normalized) {
    throw new Error('Missing order transaction hash');
  }

  const lookup = await api.getNodePath(`transaction/lookup/${normalized}`);
  if (lookup.success) {
    const signedCommon = lookup.data?.transaction?.signedCommon;
    if (signedCommon?.pinHeight != null && signedCommon?.nonceId != null) {
      return {
        cancelHeight: Number(signedCommon.pinHeight),
        cancelNonceId: Number(signedCommon.nonceId),
      };
    }
  }

  if (accountAddress) {
    const fromMempool = await findInMempool(api, accountAddress, normalized);
    if (fromMempool) return fromMempool;
  }

  throw new Error(lookup.error || 'Could not resolve order details for cancel');
}

/** Sign and submit a cancelation for one open limit order. */
export async function cancelLimitOrder({
  api,
  txHash,
  accountAddress,
  nonceId,
}) {
  const target = await resolveOrderCancelTarget(api, txHash, accountAddress);

  const { nonce, data } = await signAndSubmitTransaction(api, {
    nonceId,
    buildSpec: {
      type: 'CANCEL_TX',
      cancelHeight: target.cancelHeight,
      cancelNonceId: target.cancelNonceId,
    },
  });

  return { nonce, data, target };
}