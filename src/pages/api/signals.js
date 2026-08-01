/**
 * S3 — signal aggregator API (vault-sign-signal-v0).
 *
 *   POST /api/signals          — ingest one envelope (or { signals: [...] })
 *   GET  /api/signals?vault=   — list signals for vault
 *   GET  /api/signals?vault=&policyDigest=&quorum=1 — quorum status
 *
 * Does NOT gate cosigner sign (S4). COSIGNER_REQUIRE_SIGNALS stays off on live.
 * Lab allowlist = Anvil #10–12 unless SIGNAL_ALLOWLIST=comma addresses.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const prerender = false;

const ROOT = process.env.BRIDGE_ROOT || '/opt/cartesi-bridge';

function corsHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}

async function loadStore() {
  const modPath = path.join(ROOT, 'scripts/lib/signalStore.mjs');
  const mod = await import(pathToFileURL(modPath).href);
  // Optional allowlist override without restarting module cache incorrectly
  if (process.env.SIGNAL_ALLOWLIST) {
    const list = process.env.SIGNAL_ALLOWLIST.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return mod.createSignalStore({
      allowlist: list,
      persistPath:
        process.env.SIGNAL_STORE_PATH ||
        path.join(ROOT, 'cartesi-bridge-frontend/.data/signals.json'),
    });
  }
  return mod.getSharedSignalStore();
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function GET({ request }) {
  try {
    const url = new URL(request.url);
    const vault = url.searchParams.get('vault') || '';
    if (!vault) {
      const store = await loadStore();
      return json(200, {
        ok: true,
        service: 'cartesi-bridge-signals',
        ...store.stats(),
        requireSignals:
          process.env.COSIGNER_REQUIRE_SIGNALS === '1' ? true : false,
        note: 'POST envelope or GET ?vault=0x… ; quorum via &policyDigest=&quorum=1',
      });
    }
    const store = await loadStore();
    const policyDigest = url.searchParams.get('policyDigest') || '';
    if (url.searchParams.get('quorum') === '1') {
      if (!policyDigest) {
        return json(400, { ok: false, error: 'policyDigest required for quorum' });
      }
      const q = store.quorum(vault, policyDigest);
      return json(200, { ok: true, ...q });
    }
    const signals = store.list(vault, {
      policyDigest: policyDigest || undefined,
      includeStale: url.searchParams.get('stale') === '1',
    });
    return json(200, {
      ok: true,
      vault: vault.toLowerCase(),
      count: signals.length,
      signals,
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }
}

export async function POST({ request }) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { ok: false, error: 'invalid JSON' });
    }
    const store = await loadStore();
    const batch = Array.isArray(body?.signals)
      ? body.signals
      : body?.type
        ? [body]
        : body?.envelope
          ? [body.envelope]
          : null;
    if (!batch || batch.length === 0) {
      return json(400, {
        ok: false,
        error: 'expected signal envelope or { signals: [...] }',
      });
    }
    const results = [];
    let allOk = true;
    for (const env of batch) {
      const r = store.ingest(env);
      results.push(r);
      if (!r.ok) allOk = false;
    }
    if (batch.length === 1) {
      const r = results[0];
      return json(r.status || (r.ok ? 200 : 400), r);
    }
    return json(allOk ? 200 : 207, {
      ok: allOk,
      results,
      accepted: results.filter((r) => r.ok).length,
      rejected: results.filter((r) => !r.ok).length,
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }
}
