/**
 * Cosigner API route — Phase 4.
 *
 * If COSIGNER_UPSTREAM is set (e.g. http://127.0.0.1:8791), proxy all traffic
 * to the extracted cosigner service (Node or Rust).
 *
 * Otherwise fall back to local in-process implementation (dev only).
 */

export const prerender = false;

const UPSTREAM = (process.env.COSIGNER_UPSTREAM || '').replace(/\/$/, '');

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

async function proxyToUpstream(request) {
  const url = new URL(request.url);
  const target = `${UPSTREAM}${url.search || ''}`;
  const init = {
    method: request.method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    cache: 'no-store',
  };
  if (request.method === 'POST' || request.method === 'PUT') {
    init.body = await request.text();
  }
  const res = await fetch(target, init);
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
  if (UPSTREAM) {
    try {
      return await proxyToUpstream(ctx.request);
    } catch (e) {
      return json(502, {
        error: 'Cosigner upstream unreachable',
        upstream: UPSTREAM,
        detail: String(e.message || e),
      });
    }
  }
  // Lazy-load local fallback only when no upstream
  const local = await import('./cosigner.local.js');
  return local.GET(ctx);
}

export async function POST(ctx) {
  if (UPSTREAM) {
    try {
      return await proxyToUpstream(ctx.request);
    } catch (e) {
      return json(502, {
        error: 'Cosigner upstream unreachable',
        upstream: UPSTREAM,
        detail: String(e.message || e),
      });
    }
  }
  const local = await import('./cosigner.local.js');
  return local.POST(ctx);
}
