/**
 * Path A fungible pool public fallback (no secrets).
 * Live Q is always inspect/pool.poolAddress or pool3p_status.address.
 * This value is last-known only — do not treat it as send-here if live status exists.
 */
export const FUNGIBLE_POOL = {
  poolId: 'wart-pool-0',
  address: '4028c1c9ecb55dda63f68e23d7a205a2e0e49c36315dba1d',
  scheme: 'wart-fungible-pool-v0',
  /** Lab hot-wallet custody; payouts via /api/pool after rollup ticket */
  custody: '3p-lindell',
};
