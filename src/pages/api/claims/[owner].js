/**
 * GET /api/claims/:owner
 *
 * Returns WLIQ / wWART claim balances rebuilt from indexed Cartesi notices.
 * Prefer this over browser localStorage for the liquid tab.
 *
 * Query:
 *   ?force=1  — force GraphQL re-sync
 *   ?raw=1    — include per-notice rows for this owner
 */

import {
  getClaimsForOwner,
  normOwner,
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
    const params = ctx.params || {};
    const url = new URL(ctx.request.url);
    // Astro dynamic segment; also accept ?owner= for convenience
    const rawOwner =
      params.owner ||
      url.searchParams.get('owner') ||
      '';
    // Strip accidental path noise
    const ownerParam = decodeURIComponent(String(rawOwner)).replace(/\/+$/, '');

    if (!normOwner(ownerParam)) {
      return json(400, {
        ok: false,
        error: 'invalid_owner',
        hint: 'Pass 0x + 40 hex (MetaMask address)',
        owner: ownerParam,
      });
    }

    const forceSync =
      url.searchParams.get('force') === '1' ||
      url.searchParams.get('sync') === '1';
    const includeRaw = url.searchParams.get('raw') === '1';

    const result = await getClaimsForOwner(ownerParam, { forceSync });

    if (!result.ok) {
      return json(400, result);
    }

    const body = {
      ok: true,
      found: result.found,
      owner: result.owner,
      // Flatten claim fields at top level for easy liquid-tab merge
      ...result.claims,
      claims: result.claims,
      meta: result.meta,
      sync: {
        ok: result.sync?.ok,
        skipped: result.sync?.skipped,
        added: result.sync?.added,
        wipe: result.sync?.wipe,
        error: result.sync?.error || null,
      },
      _source: 'claims_index',
    };

    if (includeRaw) {
      body.notices = result.notices;
    } else {
      body.noticeCount = result.notices?.length ?? 0;
    }

    return json(200, body);
  } catch (e) {
    console.error('[api/claims/:owner]', e);
    return json(500, {
      ok: false,
      error: 'claims_handler_failed',
      detail: String(e?.message || e),
    });
  }
}
