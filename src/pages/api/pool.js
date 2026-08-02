/**
 * Path A — fungible pool API
 * - status / lab ledger helpers
 * - payout: hot-wallet real WART from pool (after rollup pool_release_ticket)
 * - request_credit / credits: atomic-feel deposit queue for relayer
 * Does not touch cosigner personal vault stores.
 */
import { applyPoolAction } from '../../utils/server/poolLedger.mjs';
import {
  getPoolHotPublic,
  payoutPoolTicket,
} from '../../utils/server/poolPayout.mjs';
import {
  requestPoolCredit,
  listPoolCredits,
} from '../../utils/server/poolCreditQueue.mjs';
import {
  verifyPoolDepositTx,
  flattenWartLookup,
  lookupWartTx,
} from '../../utils/server/wartLookup.mjs';
import { FUNGIBLE_POOL } from '../../utils/fungiblePoolConfig.js';

export const prerender = false;

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
  return new Response(
    JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    { status, headers: corsHeaders() },
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function GET({ request }) {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get('public') === '1') {
      return json(200, { ok: true, ...(await getPoolHotPublic()) });
    }
    if (url.searchParams.get('credits') === '1') {
      const owner = url.searchParams.get('owner') || undefined;
      const status = url.searchParams.get('status') || undefined;
      const limit = url.searchParams.get('limit') || 50;
      const credits = await listPoolCredits({ owner, status, limit });
      return json(200, {
        ...credits,
        mode: 'credit-queue',
        note: 'Relayer posts wart_deposit_claim (SPV) by default; legacy pool_deposit if SPV fails.',
      });
    }
    if (url.searchParams.get('lookup')) {
      const txHash = url.searchParams.get('lookup');
      const pool =
        url.searchParams.get('pool') ||
        FUNGIBLE_POOL.address ||
        (await getPoolHotPublic()).address;
      try {
        const flat = await verifyPoolDepositTx(txHash, pool);
        return json(200, { ok: true, verified: true, tx: flat, poolAddress: pool });
      } catch (e) {
        const raw = await lookupWartTx(txHash).catch(() => null);
        return json(200, {
          ok: true,
          verified: false,
          error: e?.message || String(e),
          tx: raw ? flattenWartLookup(raw) : null,
          poolAddress: pool,
        });
      }
    }
    const owner = url.searchParams.get('owner') || undefined;
    const lab = await applyPoolAction({ action: 'status', owner });
    const pub = await getPoolHotPublic();
    const credits = owner
      ? await listPoolCredits({ owner, limit: 20 })
      : { items: [] };
    return json(200, {
      ...lab,
      livePool: pub,
      pendingCredits: credits.items || [],
      mode: 'rollup+hot-payout+relayer',
      note:
        'Deposit is 1-button (WART send → credit queue → relayer). Resume via request_credit / credits. Phase 3 SPV is north star.',
    });
  } catch (e) {
    return json(400, { ok: false, error: e?.message || String(e) });
  }
}

export async function POST({ request }) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || '').toLowerCase();

    if (action === 'payout') {
      const result = await payoutPoolTicket({
        ticketId: body.ticketId,
        toAddress: body.toAddress,
        amountE8: body.amountE8,
        owner: body.owner,
      });
      return json(200, result);
    }

    if (action === 'request_credit' || action === 'credit') {
      const pub = await getPoolHotPublic();
      const poolAddress =
        body.poolAddress || pub.address || FUNGIBLE_POOL.address;
      // Host re-verify when possible (Phase 1); still enqueue if node lags
      let verified = null;
      let verifyError = null;
      if (body.txHash) {
        try {
          verified = await verifyPoolDepositTx(body.txHash, poolAddress);
        } catch (e) {
          verifyError = e?.message || String(e);
        }
      }
      const result = await requestPoolCredit({
        txHash: body.txHash,
        owner: body.owner,
        fromAddress: body.fromAddress || verified?.fromAddress,
        amountE8: body.amountE8 ?? verified?.amountE8,
        poolAddress,
        confirmations: body.confirmations ?? verified?.confirmations,
        source: body.source || 'fe',
      });
      return json(200, {
        ...result,
        verified: Boolean(verified),
        verifyError,
        tx: verified,
        mode: 'credit-queue',
        note: verified
          ? 'Queued for relayer (host-verified against Warthog).'
          : 'Queued; relayer will re-verify before InputBox submit.',
      });
    }

    // Lab ledger still available for offline demos
    if (
      action === 'deposit' ||
      action === 'mint' ||
      action === 'burn' ||
      action === 'redeem' ||
      action === 'status' ||
      action === 'reset_lab'
    ) {
      const result = await applyPoolAction(body || {});
      return json(200, { ...result, mode: 'lab-ledger' });
    }

    return json(400, {
      ok: false,
      error: `unknown action "${action}" (payout|request_credit|status|lab deposit/mint/burn/redeem)`,
    });
  } catch (e) {
    return json(400, { ok: false, error: e?.message || String(e) });
  }
}
