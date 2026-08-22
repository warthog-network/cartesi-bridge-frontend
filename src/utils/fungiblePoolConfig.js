/**
 * Path A fungible pool public fallback (no secrets).
 * Live Q is always inspect/pool.poolAddress or pool3p_status.address.
 * This value is last-known only — do not treat it as send-here if live status exists.
 */
export const FUNGIBLE_POOL = {
  poolId: 'wart-pool-0',
  address: 'ee3b25e31b9922346bb9d2d37afaa0341c237f4c62bf56cb',
  scheme: 'wart-fungible-pool-v0',
  /** Lab hot-wallet custody; payouts via /api/pool after rollup ticket */
  custody: '3p-lindell',
};
