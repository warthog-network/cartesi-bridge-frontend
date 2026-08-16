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
  resyncPoolHotNonce,
  listUnpaidPoolTickets,
  sweepUnpaidPoolTickets,
} from '../../utils/server/poolPayout.mjs';
import {
  requestPoolCredit,
  listPoolCredits,
} from '../../utils/server/poolCreditQueue.mjs';
import {
  checkWartOwnerBind,
  registerWartOwnerBind,
} from '../../utils/server/poolOwnerBind.mjs';
import {
  verifyPoolDepositTx,
  flattenWartLookup,
  lookupWartTx,
} from '../../utils/server/wartLookup.mjs';
import { FUNGIBLE_POOL } from '../../utils/fungiblePoolConfig.js';
import { submitPoolSignerInput } from '../../utils/server/poolOnchainSigners.mjs';
import {
  pool3pOn,
  publicStatus as pool3pPublicStatus,
  loadDapp as loadPool3pDapp,
  pool3pOfferR1,
  pool3pOfferD2,
  pool3pStatusTicket,
  enrollPool3pSigner,
  heartbeatPool3p,
  reissueToCurrentHolders,
  openPool3pPayout,
  listOpenPool3pTickets,
  rememberInspectTickets,
  birthClientSeat,
  rekeyClientD1Paillier,
  rebuildLindell,
  pool3pReuseOrPrepare,
  pool3pSubmitGuarded,
  paidRecordFor,
  resetPool3pR1,
  invalidateOpenLindell,
  claimBornSeat,
  putPreshare,
  getPresharePiece,
  collectPreshare,
  ORBIT_VPS_ID,

  abandonPool3pSeat,
  orbitAttest,
  orbitQuorumInfo,
  orbitSnapshot,
  refreshSeat,
  maybeAbandonStaleSeats,
  closePool3pRoom,
  expireStaleUserRooms,
} from '../../utils/server/pool3p.mjs';
import { preparePool3pTransfer, submitPool3pTransfer } from '../../utils/server/pool3pPay.mjs';
import { allowLabMutation } from '../../utils/server/poolOpsAuth.mjs';
import { assertPayoutMatchesTicket } from '../../utils/server/poolTicketVerify.mjs';
import {
  getThresholdStatus,
  openThresholdPayout,
  openLabDemoThreshold,
  contributeThresholdShare,
  listOpenThresholdRequests,
  heartbeatSigner,
  enrollThresholdSigner,
  getTicketVerifySnapshot,
} from '../../utils/server/poolThreshold.mjs';

export const prerender = false;

function corsHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Pool-Ops-Token',
    // Browser-node extension is COEP require-corp — allow the fetch.
    'Cross-Origin-Resource-Policy': 'cross-origin',
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

function decodeInspectHex(payload) {
  if (payload == null) return null;
  if (typeof payload === 'object') return payload;
  const s = String(payload);
  try {
    if (s.startsWith('0x')) {
      return JSON.parse(Buffer.from(s.slice(2), 'hex').toString('utf8'));
    }
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function fetchRollupPoolInspect(owner) {
  const base = String(
    process.env.CARTESI_INSPECT_URL || 'http://127.0.0.1:8080/inspect',
  ).replace(/\/$/, '');
  const path = owner
    ? `${base}/pool/${String(owner).replace(/^0x/i, '').toLowerCase()}`
    : `${base}/pool`;
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`inspect HTTP ${res.status}`);
  }
  const data = await res.json();
  const decoded = decodeInspectHex(data?.reports?.[0]?.payload);
  if (!decoded || decoded.error) {
    throw new Error(decoded?.error || 'inspect returned no pool report');
  }
  return decoded;
}

export async function GET({ request }) {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get('inspect') === '1') {
      const owner = url.searchParams.get('owner') || '';
      try {
        const decoded = await fetchRollupPoolInspect(owner);
        return json(200, { ok: true, source: 'server-inspect', ...decoded });
      } catch (e) {
        return json(502, {
          ok: false,
          error: e?.message || String(e),
          source: 'server-inspect',
        });
      }
    }
    if (url.searchParams.get('public') === '1') {
      const pub = await getPoolHotPublic();
      const p3 = pool3pOn() ? pool3pPublicStatus() : null;
      return json(200, {
        ok: true,
        ...pub,
        address: p3?.address || pub.address,
        custody: p3 ? '3p-lindell' : pub.custody,
      });
    }
    if (url.searchParams.get('nonce') === '1') {
      // Ops: show local nonce cursor (no secrets)
      const pub = await getPoolHotPublic();
      return json(200, { ok: true, ...pub });
    }
    if (url.searchParams.get('unpaid') === '1') {
      const list = await listUnpaidPoolTickets();
      return json(200, list);
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
    if (url.searchParams.get('bind') === '1') {
      const check = await checkWartOwnerBind({
        fromAddress: url.searchParams.get('from'),
        owner: url.searchParams.get('owner'),
      });
      return json(check.conflict ? 409 : 200, {
        ...check,
        mode: 'owner-bind',
      });
    }
    const verifyTicket = url.searchParams.get('verifyTicket');
    if (verifyTicket != null && verifyTicket !== '') {
      const snap = await getTicketVerifySnapshot(verifyTicket);
      return json(200, snap);
    }
    // Path A3 — 3-of-4 threshold pool status (no secrets)
    if (url.searchParams.get('threshold') === '1') {
      const ticketId = url.searchParams.get('ticket') || undefined;
      const st = await getThresholdStatus(ticketId);
      if (pool3pOn()) {
        const extra = listOpenPool3pTickets();
        const have = new Set((st.open || []).map((r) => String(r.ticketId)));
        st.open = [...(st.open || []), ...extra.filter((r) => !have.has(String(r.ticketId)))];
        st.openCount = (st.open || []).length;
      }
      return json(200, st);
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
    const p3 = pool3pOn() ? pool3pPublicStatus() : null;
    let inspected = null;
    try {
      inspected = await fetchRollupPoolInspect(owner || '');
    } catch {
      /* */
    }
    const liveAddress =
      p3?.address ||
      inspected?.poolAddress ||
      FUNGIBLE_POOL.address ||
      pub.address ||
      null;
    const credits = owner
      ? await listPoolCredits({ owner, limit: 20 })
      : { items: [] };
    return json(200, {
      ...lab,
      poolAddress: liveAddress || lab.poolAddress,
      livePool: {
        ...pub,
        address: liveAddress,
        custody: p3 ? '3p-lindell' : pub.custody,
        previous: p3?.rotation?.last?.previous || inspected?.previousAddress || null,
      },
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
      // Path A3: UI can toggle useThreshold (default true when server allows).
      // forceHot / useThreshold:false → single pool hot key (real WART).
      const thrAvailable =
        String(globalThis.process?.env?.['POOL_THRESHOLD_MODE'] || '') === '1';
      const wantThreshold =
        thrAvailable &&
        body.forceHot !== true &&
        body.useThreshold !== false &&
        String(body.useThreshold).toLowerCase() !== '0' &&
        String(body.useThreshold).toLowerCase() !== 'false';
      if (pool3pOn()) {
        rememberInspectTickets([verified]);
        const opened = await openPool3pPayout({
          ticketId: verified.ticketId,
          toAddress: verified.toAddress || body.toAddress,
          amountE8: verified.amountE8,
        });
        return json(200, {
          ok: true,
          ...opened,
          ticketId: verified.ticketId,
          toAddress: verified.toAddress || body.toAddress,
          amountE8: String(verified.amountE8),
          verifiedTicket: true,
          phase: verified.phase,
          mode: 'pool-3p',
          custody: '3p-d1-d2',
          note: 'Waiting for browser d1 + d2 Lindell (orbit n-of-n among live)',
        });
      }
      if (wantThreshold) {
        const pub = await getPoolHotPublic();
        const opened = await openThresholdPayout({
          ticketId: verified.ticketId,
          toAddress: verified.toAddress || body.toAddress,
          amountE8: verified.amountE8,
          owner: verified.owner || body.owner,
          poolAddress: pub.address || FUNGIBLE_POOL.address,
          noticeIndex: verified.notice?._index,
        });
        return json(200, {
          ...opened,
          verifiedTicket: true,
          phase: verified.phase,
          mode: 'threshold-3of4',
          custody: '3-of-4',
          note: 'Waiting for ≥3 of 4 signers — real WART leaves pool after assemble',
        });
      }
      const result = await payoutPoolTicket({
        ticketId: verified.ticketId,
        toAddress: verified.toAddress || body.toAddress,
        amountE8: verified.amountE8,
        owner: verified.owner || body.owner,
        verifiedFromNotice: true,
        noticeIndex: verified.notice?._index,
        forceHot: true,
      });
      return json(200, {
        ...result,
        verifiedTicket: true,
        phase: verified.phase,
        mode: 'hot-wallet',
        custody: 'hot-wallet',
      });
    }

    // Path A3 — open threshold payout (explicit; also used when mode off for lab)
    if (
      action === 'threshold_open' ||
      action === 'open_threshold' ||
      action === 'threshold_request'
    ) {
      const verified = await assertPayoutMatchesTicket({
        ticketId: body.ticketId,
        toAddress: body.toAddress,
        amountE8: body.amountE8,
        owner: body.owner,
      });
      const pub = await getPoolHotPublic();
      const opened = await openThresholdPayout({
        ticketId: verified.ticketId,
        toAddress: verified.toAddress || body.toAddress,
        amountE8: verified.amountE8,
        owner: verified.owner || body.owner,
        poolAddress: body.poolAddress || pub.address || FUNGIBLE_POOL.address,
        noticeIndex: verified.notice?._index,
      });
      return json(200, {
        ...opened,
        verifiedTicket: true,
        phase: verified.phase,
        mode: 'threshold-3of4',
      });
    }

    if (
      action === 'threshold_contribute' ||
      action === 'contribute_share' ||
      action === 'threshold_share'
    ) {
      const result = await contributeThresholdShare({
        ticketId: body.ticketId,
        shareIndex: body.shareIndex,
        shareHex: body.shareHex,
        signerId: body.signerId,
        verification: body.verification,
      });
      return json(200, { ...result, mode: 'threshold-3of4' });
    }

    if (action === 'threshold_status' || action === 'threshold') {
      const st = await getThresholdStatus(body.ticketId);
      return json(200, st);
    }

    if (action === 'threshold_heartbeat' || action === 'signer_heartbeat') {
      const idx = Number(body.shareIndex);
      if (pool3pOn() && !Number.isFinite(idx)) {
        return json(
          200,
          await heartbeatPool3p({
            signerId: body.signerId,
            seatEpoch: body.seatEpoch ?? body.epoch,
          }),
        );
      }
      const hb = await heartbeatSigner({
        signerId: body.signerId,
        shareIndex: body.shareIndex,
        epoch: body.epoch,
      });
      return json(200, hb);
    }

    if (action === 'pool3p_close_room' || action === 'pool3p_reset_room') {
      return json(200, await closePool3pRoom(body.ticketId, body.reason || 'manual-reset'));
    }
    if (action === 'pool3p_status') {
      await expireStaleUserRooms().catch(() => ({ closed: [] }));
      await maybeAbandonStaleSeats().catch(() => []);
      let rotation = null;
      try {
        const { tickRotation } = await import('../../utils/server/pool3pRotate.mjs');
        rotation = await tickRotation();
      } catch {
        /* */
      }
      return json(200, { ...pool3pPublicStatus(), orbit: orbitSnapshot(), rotation });
    }
    if (action === 'pool3p_birth_next') {
      const { birthNextSeat } = await import('../../utils/server/pool3pRotate.mjs');
      return json(200, await birthNextSeat({
        signerId: body.signerId,
        role: body.role,
        P: body.P,
        encD1: body.encD1,
        paillierN: body.paillierN,
        paillierG: body.paillierG,
      }));
    }
    if (action === 'pool3p_announce_next') {
      const { tickRotation, submitPoolAdvance } = await import('../../utils/server/pool3pRotate.mjs');
      const rot = await tickRotation();
      if (!rot.next?.address) return json(400, { error: 'next Q not ready' });
      return json(200, await submitPoolAdvance({
        type: 'pool_announce_next',
        address: rot.next.address,
        publicKey: rot.next.publicKey,
      }));
    }
    if (action === 'pool3p_set_address') {
      const {
        tickRotation,
        submitPoolAdvance,
        activateNextDapp,
      } = await import('../../utils/server/pool3pRotate.mjs');
      const rot = await tickRotation();
      const nextAddr = rot.next?.address;
      const addr = String(body.address || nextAddr || '')
        .replace(/^0x/i, '')
        .toLowerCase();
      if (!nextAddr || addr !== String(nextAddr).toLowerCase()) {
        return json(400, {
          error: 'pool_set_address only accepts the client-born next Q',
          next: nextAddr || null,
        });
      }
      const posted = await submitPoolAdvance({
        type: 'pool_set_address',
        address: addr,
        accountId: body.accountId || null,
        sweepTxHash: body.sweepTxHash || null,
      });
      const act = await activateNextDapp({
        sweepTxHash: body.sweepTxHash,
        accountId: body.accountId,
      }).catch((e) => ({ ok: false, error: e.message }));
      return json(200, { ...posted, activate: act });
    }
    if (action === 'pool3p_heartbeat' || action === 'orbit_heartbeat') {
      const hb = await heartbeatPool3p({
        signerId: body.signerId,
        seatEpoch: body.seatEpoch,
      });
      let rotation = null;
      try {
        const { tickRotation } = await import('../../utils/server/pool3pRotate.mjs');
        rotation = await tickRotation();
      } catch {
        /* */
      }
      return json(200, { ...hb, rotation });
    }
    if (action === 'pool3p_abandon' || action === 'abandon_seat') {
      return json(200, await abandonPool3pSeat({
        signerId: body.signerId,
        role: body.role,
      }));
    }
    if (action === 'pool3p_orbit_attest' || action === 'orbit_attest') {
      return json(200, await orbitAttest({
        signerId: body.signerId,
        ticketId: body.ticketId,
      }));
    }
    if (action === 'pool3p_orbit') {
      return json(200, {
        ...orbitSnapshot(),
        ticket: body.ticketId ? orbitQuorumInfo(body.ticketId) : null,
      });
    }
    if (action === 'pool3p_reissue_holders' || action === 'pool3p_epoch_rotate') {
      const rotated = await reissueToCurrentHolders(body.reason || 'epoch-rotate');
      return json(200, rotated);
    }
    if (action === 'pool3p_claim_born' || action === 'claim_born') {
      return json(200, await claimBornSeat({
        signerId: body.signerId,
        role: body.role,
        shareHex: body.shareHex || body.d1Hex || body.d2Hex,
      }));
    }
    if (action === 'pool3p_rekey_d1' || action === 'rekey_d1') {
      return json(200, await rekeyClientD1Paillier({
        signerId: body.signerId,
        d1Hex: body.d1Hex,
        encD1: body.encD1,
        paillierN: body.paillierN,
        paillierG: body.paillierG,
      }));
    }
    if (action === 'pool3p_birth') {
      const born = await birthClientSeat({
        signerId: body.signerId,
        role: body.role,
        P: body.P,
        encD1: body.encD1,
        paillierN: body.paillierN,
        paillierG: body.paillierG,
      });
      return json(200, born);
    }
    if (action === 'pool3p_preshare_put') {
      return json(200, await putPreshare(body));
    }
    if (action === 'pool3p_preshare_get') {
      return json(200, await getPresharePiece({ signerId: body.signerId, role: body.role }));
    }
    if (action === 'pool3p_preshare_collect') {
      return json(200, await collectPreshare({ signerId: body.signerId, role: body.role }));
    }
    if (action === 'pool3p_prepare') {
      const dapp = loadPool3pDapp();
      if (!dapp) return json(400, { error: '3P pool not configured' });
      const prep = await pool3pReuseOrPrepare(body.ticketId, {
        toAddress: body.toAddress,
        amountE8: body.amountE8,
        makePrep: () => preparePool3pTransfer({
          fromAddress: dapp.address,
          toAddress: body.toAddress,
          amountE8: body.amountE8,
        }),
      });
      if (prep?.alreadyPaid) return json(200, { ok: true, ...prep });
      return json(200, prep);
    }
    if (action === 'pool3p_relindell' || action === 'relindell') {
      return json(200, await rebuildLindell(body.ticketId));
    }
    if (action === 'pool3p_reset_r1' || action === 'reset_r1') {
      return json(200, await resetPool3pR1({
        ticketId: body.ticketId,
        signerId: body.signerId,
      }));
    }
    if (action === 'pool3p_r1') {
      const r = await pool3pOfferR1({
        ticketId: body.ticketId,
        signerId: body.signerId,
        R1Hex: body.R1Hex,
        hashHex: body.hashHex,
        amountE8: body.amountE8,
        toAddress: body.toAddress,
      });
      return json(200, r);
    }
    if (action === 'pool3p_d2') {
      const r = await pool3pOfferD2({
        ticketId: body.ticketId,
        signerId: body.signerId,
        d2Hex: body.d2Hex,
        amountE8: body.amountE8,
        toAddress: body.toAddress,
      });
      return json(200, r);
    }
    if (action === 'pool3p_ticket') {
      return json(200, await pool3pStatusTicket(body.ticketId));
    }
    if (action === 'pool3p_submit') {
      const dapp = loadPool3pDapp();
      if (!dapp) return json(400, { error: '3P pool not configured' });
      const already = paidRecordFor(body.ticketId, { amountE8: body.amountE8 });
      if (already) return json(200, { ok: true, alreadyPaid: true, ticketId: body.ticketId, ...already });
      const oq = orbitQuorumInfo(body.ticketId);
      if (!oq.ok) return json(403, { error: oq.message, orbit: oq });
      try {
        const paid = await pool3pSubmitGuarded(body.ticketId, {
          hashHex: body.hashHex,
          submitFn: (prep) => submitPool3pTransfer({
            ...prep,
            signature65: body.signature65,
          }),
        });
        return json(200, paid);
      } catch (e) {
        if (e?.code === 'HASH_MISMATCH') return json(409, { error: e.message });
        throw e;
      }
    }

    if (action === 'signer_onchain_enroll' || action === 'onchain_enroll') {
      const posted = await submitPoolSignerInput({
        type: 'pool_signer_enroll',
        signerId: body.signerId,
        pubkey: body.pubkey,
        shareIndex: body.shareIndex,
        signature: body.signature,
        poolId: body.poolId || 'wart-pool-0',
        epoch: body.epoch || 1,
      });
      return json(200, { ok: true, onchain: true, ...posted });
    }
    if (action === 'signer_onchain_attest' || action === 'onchain_attest') {
      const posted = await submitPoolSignerInput({
        type: 'pool_signer_attest',
        signerId: body.signerId,
        ticketId: body.ticketId,
        signature: body.signature,
      });
      return json(200, { ok: true, onchain: true, ...posted });
    }
    if (action === 'signer_onchain_policy' || action === 'onchain_policy') {
      const posted = await submitPoolSignerInput({
        type: 'pool_signer_policy',
        policyT: body.policyT,
        requireQuorum: body.requireQuorum,
      });
      return json(200, { ok: true, onchain: true, ...posted });
    }

    if (action === 'threshold_enroll' || action === 'enroll_signer' || action === 'pool3p_enroll') {
      const d3 = loadPool3pDapp();
      if (d3) {
        const enrolled = await enrollPool3pSigner({
          signerId: body.signerId,
          role: body.role,
        });
        return json(200, enrolled);
      }
      const enrolled = await enrollThresholdSigner({
        signerId: body.signerId,
        role: body.role,
      });
      return json(200, enrolled);
    }

    if (action === 'threshold_list' || action === 'list_threshold') {
      const st = await listOpenThresholdRequests();
      return json(200, st);
    }

    // Lab: open faux 3-of-4 request (no real burn) for UI + faux-signers demo
    if (
      action === 'threshold_lab_demo' ||
      action === 'threshold_demo' ||
      action === 'lab_threshold_demo'
    ) {
      // Allow on lab host without ops token when POOL_THRESHOLD_LAB=1 (default on for demo)
      const thrLab = String(globalThis.process?.env?.['POOL_THRESHOLD_LAB'] ?? '1');
      const thrMode = String(globalThis.process?.env?.['POOL_THRESHOLD_MODE'] || '');
      const labOk = thrLab !== '0' || thrMode === '1';
      if (!labOk) {
        const auth = (
          await import('../../utils/server/poolOpsAuth.mjs')
        ).requirePoolOps(request, body);
        if (!auth.ok) {
          return json(auth.status || 403, { ok: false, error: auth.error });
        }
      }
      const opened = await openLabDemoThreshold({
        amountE8: body.amountE8,
        poolAddress: body.poolAddress,
        toAddress: body.toAddress,
      });
      return json(200, {
        ...opened,
        mode: 'threshold-3of4-lab-demo',
        note: 'Faux request opened — run pool-threshold-faux-signers.mjs to contribute 3/4 shares',
      });
    }

    if (action === 'resync_nonce' || action === 'nonce_resync') {
      const gate = allowLabMutation(request, body);
      // Allow ops token OR lab env — same gate as lab mutations
      if (!gate.ok) {
        // Also allow if only ops token required
        const { requirePoolOps } = await import(
          '../../utils/server/poolOpsAuth.mjs'
        );
        const auth = requirePoolOps(request, body);
        if (!auth.ok) {
          return json(auth.status || 403, { ok: false, error: auth.error });
        }
      }
      const result = await resyncPoolHotNonce();
      return json(200, result);
    }

    if (action === 'list_unpaid' || action === 'unpaid') {
      const list = await listUnpaidPoolTickets();
      return json(200, list);
    }

    if (action === 'sweep_unpaid' || action === 'payout_unpaid') {
      // Paying real WART — require ops token (or lab gate)
      const gate = allowLabMutation(request, body);
      if (!gate.ok) {
        const { requirePoolOps } = await import(
          '../../utils/server/poolOpsAuth.mjs'
        );
        const auth = requirePoolOps(request, body);
        if (!auth.ok) {
          return json(auth.status || 403, { ok: false, error: auth.error });
        }
      }
      const result = await sweepUnpaidPoolTickets({
        limit: body.limit,
        dryRun: Boolean(body.dryRun),
      });
      return json(200, result);
    }

    if (action === 'register_bind' || action === 'bind') {
      try {
        const result = await registerWartOwnerBind({
          fromAddress: body.fromAddress,
          owner: body.owner,
          issuedAt: body.issuedAt,
          wartSig: body.wartSig,
          ownerSig: body.ownerSig,
        });
        return json(200, { ...result, mode: 'owner-bind' });
      } catch (e) {
        const msg = e?.message || String(e);
        const status = /already bound/i.test(msg) ? 409 : 400;
        return json(status, { ok: false, error: msg, mode: 'owner-bind' });
      }
    }

    if (action === 'anvil_pool_mint' || action === 'pool_mint_anvil') {
      const { submitAnvilPoolMint } = await import(
        '../../utils/server/anvilPoolMint.mjs'
      );
      return json(
        200,
        await submitAnvilPoolMint({
          owner: body.owner,
          amount: body.amount,
          tokenAddress: body.tokenAddress,
        }),
      );
    }
    if (action === 'anvil_pool_withdraw' || action === 'pool_withdraw_anvil') {
      const { submitAnvilPoolWithdraw } = await import(
        '../../utils/server/anvilPoolMint.mjs'
      );
      return json(
        200,
        await submitAnvilPoolWithdraw({
          owner: body.owner,
          amount: body.amount,
        }),
      );
    }

    if (action === 'request_credit' || action === 'credit') {
      const pub = await getPoolHotPublic();
      let inspected = null;
      try {
        inspected = await fetchRollupPoolInspect('');
      } catch {
        /* */
      }
      const pool3p = pool3pOn() ? pool3pPublicStatus() : null;
      const poolAddress =
        pool3p?.address ||
        inspected?.poolAddress ||
        body.poolAddress ||
        FUNGIBLE_POOL.address ||
        pub.address;
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
      error: `unknown action "${action}" (payout|threshold_open|threshold_contribute|threshold_status|resync_nonce|list_unpaid|sweep_unpaid|request_credit|status|lab*)`,
    });
  } catch (e) {
    const msg = e?.message || String(e);
    const status =
      /Unauthorized|No pool_release|mismatch|disabled/i.test(msg) ? 403 : 400;
    return json(status, { ok: false, error: msg });
  }
}
