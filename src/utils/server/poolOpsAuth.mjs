/**
 * Path A ops auth for dangerous pool API actions (lab ledger, optional ops-only).
 * Normal user payout uses rollup ticket verification instead (see poolTicketVerify).
 *
 * Env:
 *   POOL_OPS_TOKEN          shared secret (header x-pool-ops-token or Authorization: Bearer)
 *   POOL_LAB_MUTATIONS=1    allow lab deposit/mint/burn/redeem/reset without token (dev only)
 *   POOL_OPS_TOKEN_FILE     path to token file (default .data/pool-ops.token)
 */
import { readFileSync, existsSync, statSync } from 'node:fs';

const TOKEN_FILE =
  process.env.POOL_OPS_TOKEN_FILE ||
  '/opt/cartesi-bridge/cartesi-bridge-frontend/.data/pool-ops.token';

let cachedFileToken = null;
let cachedFileMtime = 0;

function readTokenFromFile() {
  try {
    if (!existsSync(TOKEN_FILE)) return '';
    const st = statSync(TOKEN_FILE);
    if (cachedFileToken != null && st.mtimeMs === cachedFileMtime) {
      return cachedFileToken;
    }
    const t = readFileSync(TOKEN_FILE, 'utf8').trim();
    cachedFileToken = t;
    cachedFileMtime = st.mtimeMs;
    return t;
  } catch {
    return '';
  }
}

export function getPoolOpsToken() {
  const env = String(process.env.POOL_OPS_TOKEN || '').trim();
  if (env) return env;
  return readTokenFromFile();
}

export function labMutationsAllowed() {
  return process.env.POOL_LAB_MUTATIONS === '1';
}

/**
 * Extract ops token from request headers or JSON body.
 * @param {Request} request
 * @param {object} [body]
 */
export function extractOpsToken(request, body = {}) {
  const h = request?.headers;
  if (h) {
    const x = h.get?.('x-pool-ops-token') || h.get?.('X-Pool-Ops-Token');
    if (x) return String(x).trim();
    const auth = h.get?.('authorization') || h.get?.('Authorization') || '';
    const m = String(auth).match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  if (body?.opsToken) return String(body.opsToken).trim();
  if (body?.token) return String(body.token).trim();
  return '';
}

/**
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function requirePoolOps(request, body = {}) {
  const expected = getPoolOpsToken();
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error:
        'Pool ops token not configured (set POOL_OPS_TOKEN or write .data/pool-ops.token)',
    };
  }
  const got = extractOpsToken(request, body);
  if (!got || got !== expected) {
    return {
      ok: false,
      status: 401,
      error: 'Unauthorized — valid x-pool-ops-token / Bearer required',
    };
  }
  return { ok: true };
}

/**
 * Lab mutations: allowed if POOL_LAB_MUTATIONS=1 OR valid ops token.
 */
export function allowLabMutation(request, body = {}) {
  if (labMutationsAllowed()) return { ok: true, mode: 'lab-env' };
  const auth = requirePoolOps(request, body);
  if (auth.ok) return { ok: true, mode: 'ops-token' };
  return {
    ok: false,
    status: auth.status || 403,
    error:
      auth.error ||
      'Lab ledger mutations disabled on public demo (set POOL_LAB_MUTATIONS=1 or pass ops token)',
  };
}
