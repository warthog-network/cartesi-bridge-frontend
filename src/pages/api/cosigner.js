/**
 * Cosigner API route — proxies to Rust/Node cosigner.
 *
 * IMPORTANT: resolve COSIGNER_UPSTREAM at **request time**. Vite/Astro may
 * replace process.env.* at build time with empty strings if the var was not
 * set during `npm run build`, which forced the broken in-process local
 * fallback (secureStore crypto shim → "Unknown vault" / createCipheriv fails).
 */

export const prerender = false;

function getUpstream() {
  // Dynamic key access — avoid static env inlining of empty COSIGNER_UPSTREAM
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  const raw =
    env['COSIGNER_UPSTREAM'] ||
    env['PUBLIC_COSIGNER_UPSTREAM'] ||
    'http://127.0.0.1:8791';
  return String(raw).replace(/\/$/, '');
}

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(),
  });
}

async function proxyToUpstream(request, upstream) {
  const url = new URL(request.url);
  // Rust listens on / and /api/cosigner — pass query through
  const target = `${upstream}/${url.search || ''}`.replace(/\/\?/, '?');
  // Prefer path /api/cosigner when client hit that shape
  const path = url.pathname.includes('/api/cosigner')
    ? `${upstream}/api/cosigner${url.search || ''}`
    : `${upstream}${url.search || ''}`;

  const init = {
    method: request.method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    cache: 'no-store',
  };
  if (request.method === 'POST' || request.method === 'PUT') {
    init.body = await request.text();
  }
  const res = await fetch(path, init);
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: corsHeaders(),
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function GET(ctx) {
  const upstream = getUpstream();
  if (!upstream) {
    return json(503, {
      error: 'COSIGNER_UPSTREAM not configured',
      hint: 'Set COSIGNER_UPSTREAM=http://127.0.0.1:8791 for the Rust cosigner',
    });
  }
  try {
    return await proxyToUpstream(ctx.request, upstream);
  } catch (e) {
    return json(502, {
      error: 'Cosigner upstream unreachable',
      upstream,
      detail: String(e.message || e),
    });
  }
}

export async function POST(ctx) {
  const upstream = getUpstream();
  if (!upstream) {
    return json(503, {
      error: 'COSIGNER_UPSTREAM not configured',
      hint: 'Set COSIGNER_UPSTREAM=http://127.0.0.1:8791 for the Rust cosigner',
    });
  }
  try {
    return await proxyToUpstream(ctx.request, upstream);
  } catch (e) {
    return json(502, {
      error: 'Cosigner upstream unreachable',
      upstream,
      detail: String(e.message || e),
    });
  }
}
