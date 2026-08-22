/**
 * Path A fungible pool public fallback (no secrets).
 * Live Q is always inspect/pool.poolAddress or pool3p_status.address.
 * This value is last-known only — do not treat it as send-here if live status exists.
 */
export const FUNGIBLE_POOL = {
  poolId: 'wart-pool-0',
  address: 'e070c46e3bae9372e4798b6a1709f7108bfb58fd19417424',
  scheme: 'wart-fungible-pool-v0',
  /** Lab hot-wallet custody; payouts via /api/pool after rollup ticket */
  custody: '3p-lindell',
};
