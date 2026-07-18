import { rejectFakeMineIfRemote, rejectLocalNodeInProxy } from '../../utils/proxyGuards.js';

export const prerender = false;

const PROXY_TIMEOUT_MS = 10000;
const DEFAULT_NODE_BASE = process.env.NODE_BASE || 'https://warthog-defitestnet.duckdns.org';

function jsonError(status, error) {
  return new Response(JSON.stringify({ code: 1, error }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function forwardToNode({ nodeBase, nodePath, method = 'GET', body = null }) {
  const resolvedBase = nodeBase || DEFAULT_NODE_BASE;

  if (!nodePath) {
    return jsonError(400, 'Missing nodePath');
  }

  const localNodeRejection = rejectLocalNodeInProxy(resolvedBase);
  if (localNodeRejection) {
    return new Response(localNodeRejection.body, {
      status: localNodeRejection.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const fakeMineRejection = rejectFakeMineIfRemote(nodePath, resolvedBase);
  if (fakeMineRejection) {
    return new Response(fakeMineRejection.body, {
      status: fakeMineRejection.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const targetUrl = resolvedBase.replace(/\/$/, '') + '/' + nodePath.replace(/^\//, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  const fetchOptions = {
    method,
    signal: controller.signal,
    headers: { 'Cache-Control': 'no-cache' },
  };

  if (method !== 'GET' && method !== 'HEAD' && body != null) {
    fetchOptions.body = body;
    fetchOptions.headers['Content-Type'] = 'application/json';
  }

  try {
    const response = await fetch(targetUrl, fetchOptions);
    clearTimeout(timeoutId);
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      return jsonError(
        408,
        `Node request timed out after ${PROXY_TIMEOUT_MS / 1000}s (${resolvedBase}). `
          + 'The node may be offline or unreachable from the server proxy — try another node.',
      );
    }
    return jsonError(
      502,
      `Upstream fetch failed (${resolvedBase}): ${error.message || 'network error'}`,
    );
  }
}

export const GET = async ({ request }) => {
  const url = new URL(request.url);
  return forwardToNode({
    nodeBase: url.searchParams.get('nodeBase'),
    nodePath: url.searchParams.get('nodePath'),
    method: 'GET',
  });
};

export const POST = async ({ request }) => {
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      const envelope = await request.json();
      if (envelope?.nodeBase && envelope?.nodePath != null) {
        const forwardBody = envelope.body != null
          ? JSON.stringify(envelope.body)
          : null;
        return forwardToNode({
          nodeBase: envelope.nodeBase,
          nodePath: envelope.nodePath,
          method: envelope.method || 'GET',
          body: forwardBody,
        });
      }
    } catch {
      // fall through to legacy query-param POST
    }
  }

  const url = new URL(request.url);
  const nodePath = url.searchParams.get('nodePath');
  const nodeBase = url.searchParams.get('nodeBase');
  if (!nodePath) {
    return jsonError(400, 'Missing nodePath');
  }

  const body = await request.text();
  return forwardToNode({
    nodeBase,
    nodePath,
    method: 'POST',
    body: body || null,
  });
};

export const OPTIONS = async () =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
