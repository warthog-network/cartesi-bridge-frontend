/**
 * Path A — fungible pool API
 * - status / public info
 * - payout: hot-wallet WART after verified rollup pool_release_ticket
 * - request_credit / credits: deposit queue for SPV relayer
 * - lab ledger: ops-token or POOL_LAB_MUTATIONS=1 only
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
import { allowLabMutation } from '../../utils/server/poolOpsAuth.mjs';
import { assertPayoutMatchesTicket } from '../../utils/server/poolTicketVerify.mjs';

export const prerender = false;

function corsHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Pool-Ops-Token',
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
        note: 'Relayer posts wart_deposit_claim (SPV) by default; legacy only if POOL_SPV_FALLBACK=1.',
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
        return json(200, {
          ok: true,
          verified: true,
          tx: flat,
          poolAddress: pool,
        });
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
    // Prefer not advertising lab ledger as truth — status is secondary
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
      labMutations: process.env.POOL_LAB_MUTATIONS === '1' ? 'open' : 'ops-token',
      note:
        'Deposit is 1-button (WART send → credit queue → SPV relayer). Prefer /inspect/pool for balances. Payout requires matching release ticket notice.',
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
      // Harden: ticket must exist on rollup with matching amount/to/owner
      const verified = await assertPayoutMatchesTicket({
        ticketId: body.ticketId,
        toAddress: body.toAddress,
        amountE8: body.amountE8,
        owner: body.owner,
      });
      const result = await payoutPoolTicket({
        ticketId: verified.ticketId,
        toAddress: verified.toAddress || body.toAddress,
        amountE8: verified.amountE8,
        owner: verified.owner || body.owner,
        verifiedFromNotice: true,
        noticeIndex: verified.notice?._index,
      });
      return json(200, {
        ...result,
        verifiedTicket: true,
        phase: verified.phase,
      });
    }

    if (action === 'request_credit' || action === 'credit') {
      const pub = await getPoolHotPublic();
      const poolAddress =
        body.poolAddress || pub.address || FUNGIBLE_POOL.address;
      let verified = null;
      let verifyError = null;
      if (body.txHash) {
        try {
          verified = await verifyPoolDepositTx(body.txHash, poolAddress);
        } catch (e) {
          verifyError = e?.message || String(e);
        }
      }
      // Prefer chain-truth fromAddress for owner binding
      const fromAddress = verified?.fromAddress || body.fromAddress;
      const result = await requestPoolCredit({
        txHash: body.txHash,
        owner: body.owner,
        fromAddress,
        amountE8: body.amountE8 ?? verified?.amountE8,
        poolAddress,
        confirmations: body.confirmations ?? verified?.confirmations,
        source: body.source || 'fe',
        requireVerified: process.env.POOL_CREDIT_REQUIRE_VERIFY === '1',
        verified: Boolean(verified),
      });
      return json(200, {
        ...result,
        verified: Boolean(verified),
        verifyError,
        tx: verified,
        mode: 'credit-queue',
        note: verified
          ? 'Queued for SPV relayer (host-verified against Warthog).'
          : 'Queued; relayer will re-verify before InputBox submit.',
      });
    }

    // Lab ledger — blocked on public demo without ops token
    if (
      action === 'deposit' ||
      action === 'mint' ||
      action === 'burn' ||
      action === 'redeem' ||
      action === 'reset_lab'
    ) {
      const gate = allowLabMutation(request, body);
      if (!gate.ok) {
        return json(gate.status || 403, { ok: false, error: gate.error });
      }
      const result = await applyPoolAction(body || {});
      return json(200, {
        ...result,
        mode: 'lab-ledger',
        authMode: gate.mode,
      });
    }

    if (action === 'status') {
      const result = await applyPoolAction(body || {});
      return json(200, { ...result, mode: 'lab-ledger' });
    }

    return json(400, {
      ok: false,
      error: `unknown action "${action}" (payout|request_credit|status|lab*)`,
    });
  } catch (e) {
    const msg = e?.message || String(e);
    const status =
      /Unauthorized|No pool_release|mismatch|disabled/i.test(msg) ? 403 : 400;
    return json(status, { ok: false, error: msg });
  }
}
