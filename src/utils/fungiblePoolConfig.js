/**
 * Path A fungible pool public fallback (no secrets).
 * Live Q is always inspect/pool.poolAddress or pool3p_status.address.
 * This value is last-known only — do not treat it as send-here if live status exists.
 */
export const FUNGIBLE_POOL = {
  poolId: 'wart-pool-0',
  address: 'd6d1d6e9c86c5b06014a12e6c2fd05e00b5de88e876c9982',
  scheme: 'wart-fungible-pool-v0',
  /** Lab hot-wallet custody; payouts via /api/pool after rollup ticket */
  custody: '3p-lindell',
};
