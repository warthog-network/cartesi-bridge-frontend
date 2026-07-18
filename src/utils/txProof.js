/**
 * Normalize transaction/lookup payloads for Cartesi sub_lock / sweep_lock.
 *
 * Legacy public nodes return a flat transaction:
 *   { transaction: { txHash, fromAddress, toAddress, amountE8, blockHeight, confirmations } }
 *
 * DeFi testnet (v0.10+) returns nested data:
 *   { transaction: { hash, data: { toAddress, amount: { E8 } }, signedCommon: { originAddress } },
 *     confirmations, mined: { block: { height } } }
 */
export function normalizeTxLookup(lookupData) {
  if (!lookupData) return lookupData;

  const tx = lookupData.transaction;
  if (!tx) return lookupData;

  // Already legacy flat shape
  if (tx.toAddress != null && tx.amountE8 != null) {
    return lookupData;
  }

  const data = tx.data || {};
  const common = tx.signedCommon || tx.signingData || {};
  const amountObj = data.amount || {};

  const amountE8 =
    amountObj.E8 ??
    amountObj.u64 ??
    data.amountE8 ??
    tx.amountE8 ??
    0;

  const normalizedTransaction = {
    txHash: tx.hash || tx.txHash,
    fromAddress: common.originAddress || data.fromAddress || tx.fromAddress || null,
    toAddress: data.toAddress || tx.toAddress,
    amountE8: Number(amountE8),
    blockHeight: lookupData.mined?.block?.height ?? tx.blockHeight,
    confirmations: lookupData.confirmations ?? tx.confirmations,
    feeE8: common.fee?.E8 ?? tx.feeE8,
    nonceId: common.nonceId ?? tx.nonceId,
  };

  return {
    ...lookupData,
    transaction: normalizedTransaction,
  };
}

/** Convenience: extract flat tx fields used by confirmation polling. */
export function getTxConfirmationStatus(lookupData) {
  const proof = normalizeTxLookup(lookupData);
  const tx = proof.transaction || {};
  return {
    blockHeight: tx.blockHeight,
    confirmations: tx.confirmations ?? 0,
  };
}