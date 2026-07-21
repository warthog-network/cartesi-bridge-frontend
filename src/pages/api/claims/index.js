/**
 * GET /api/claims           — indexer status (disk snapshot)
 * GET /api/claims?force=1   — force GraphQL re-sync, then status
 *
 * (POST avoided: Astro node adapter blocks cross-site form POSTs.)
 */

import {
  getIndexStatus,
  syncClaimsIndex,
} from '../../../utils/server/claimsIndexer.js';

export const prerender = false;

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(),
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function GET(ctx) {
  try {
    const url = new URL(ctx.request.url);
    const force =
      url.searchParams.get('force') === '1' ||
      url.searchParams.get('sync') === '1';

    let sync = null;
    if (force) {
      sync = await syncClaimsIndex({ force: true });
    }

    const status = getIndexStatus();
    return json(200, {
      ok: true,
      ...status,
      ...(sync ? { sync } : {}),
    });
  } catch (e) {
    return json(500, {
      ok: false,
      error: String(e?.message || e),
    });
  }
}
