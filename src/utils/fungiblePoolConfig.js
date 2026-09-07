/**
 * Path A fungible pool public fallback (no secrets).
 * Live Q is always inspect/pool.poolAddress or pool3p_status.address.
 * This value is last-known only — do not treat it as send-here if live status exists.
 */
export const FUNGIBLE_POOL = {
  poolId: 'wart-pool-0',
  address: '8676b914aa1ff0c5719efd6fdf64cfdd89b1dd5c649083f8',
  scheme: 'wart-fungible-pool-v0',
  /** Lab hot-wallet custody; payouts via /api/pool after rollup ticket */
  custody: '3p-lindell',
};
