/**
 * Path A — fungible pool API
 * - status / public info
 * - payout: hot-wallet WART after verified rollup pool_release_ticket
 * - request_credit / credits: deposit queue for SPV relayer
 * - lab ledger: read-only status (mutations retired with Path A3)
 */
import { applyPoolAction } from '../../utils/server/poolLedger.mjs';
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
  openClientSeatPdl,
  finishClientSeatPdl,
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
  reopenAbandonedAuthorizedTickets,
  wartSealedPreshare,
  sealedPreshareFieldsFor,
  rememberWartNode,
  pool3pNoteSkip,
} from '../../utils/server/pool3p.mjs';
import {
  eth3pOn,
  publicEth3pStatus,
  enrollEth3pSigner,
  heartbeatEth3p,
  birthEthSeat,
  openEthSeatPdl,
  finishEthSeatPdl,
  creditEthLock,
  registerEthWrap,
  recordEthBurn,
  bindEthOwner,
  ETH_BURN_BIN,
  openEthRedeem,
  eth3pOfferR1,
  eth3pOfferD2,
  eth3pStatusTicket,
  eth3pSubmit,
  birthEthSeatNext,
  openEthSeatPdlNext,
  finishEthSeatPdlNext,
  ethSealedPreshare,
  claimBornEthSeat,
  ethWrapIndex,
  ethMintable,
  classifyEthBurn,
} from '../../utils/server/poolEth3p.mjs';
import { tickEthRotation } from '../../utils/server/poolEth3pRotate.mjs';
import { preparePool3pTransfer, submitPool3pTransfer } from '../../utils/server/pool3pPay.mjs';
import { assertPayoutMatchesTicket } from '../../utils/server/poolTicketVerify.mjs';
import { getTicketVerifySnapshot } from '../../utils/server/poolVerifySnapshot.mjs';
import { notePackReport } from '../../utils/server/packReports.mjs';
import { getInspect, machineView, isReplaying } from '../../utils/server/inspectHub.mjs';
import { rollupsInfo } from '../../utils/server/rollupsApi.mjs';

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

/** Inspect through the hub — one cached machine read per TTL for the whole fleet. */
async function fetchRollupPoolInspect(owner) {
  const r = await getInspect('pool', { owner: owner || null });
  if (!r.decoded || r.decoded.error) {
    throw new Error(r.decoded?.error || 'inspect returned no pool report');
  }
  return r.decoded;
}

/**
 * Path A3 (Shamir 3-of-n) and the hot wallet were retired when 3P Lindell
 * became custody. Their actions answer 410 so an old client or ops script
 * learns why instead of hitting a generic "unknown action".
 */
const RETIRED_ACTIONS = new Set([
  'threshold_open', 'open_threshold', 'threshold_request',
  'threshold_contribute', 'contribute_share', 'threshold_share',
  'threshold_list', 'list_threshold',
  'threshold_lab_demo', 'threshold_demo', 'lab_threshold_demo',
  'resync_nonce', 'nonce_resync', 'list_unpaid', 'unpaid',
  'sweep_unpaid', 'payout_unpaid',
  'deposit', 'mint', 'burn', 'redeem', 'reset_lab',
]);

/** What `?threshold=1` / `threshold_status` mean now: the 3P rooms. */
async function threshold3pView(ticketId) {
  const p3 = pool3pPublicStatus() || {};
  const open = listOpenPool3pTickets();
  const base = {
    ok: true,
    custody: '3p-lindell',
    thresholdMode: false,
    rollups: rollupsInfo(),
    poolAddress: p3.address || null,
    open,
    openCount: open.length,
    signers: {
      poolAddress: p3.address || null,
      holder1: p3.holder1 || null,
      holder2: p3.holder2 || null,
      live: p3.orbit?.liveCount ?? null,
    },
  };
  if (!ticketId) return base;
  const t = await pool3pStatusTicket(ticketId);
  return { ...base, ticketId: String(ticketId), found: !!t?.ok, ...(t?.ok ? t : {}) };
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
      const p3 = pool3pPublicStatus();
      return json(200, {
        ok: true,
        address: p3?.address || null,
        custody: '3p-lindell',
        poolId: p3?.poolId || FUNGIBLE_POOL.poolId || 'wart-pool-0',
        ...(p3 && typeof p3 === 'object' ? p3 : {}),
      });
    }
    if (url.searchParams.get('nonce') === '1' || url.searchParams.get('unpaid') === '1') {
      return json(410, {
        ok: false,
        retired: true,
        error: 'hot-wallet nonce/unpaid views are retired — custody is 3P Lindell',
      });
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
      return json(200, await threshold3pView(url.searchParams.get('ticket') || undefined));
    }
    if (url.searchParams.get('lookup')) {
      const txHash = url.searchParams.get('lookup');
      const pool =
        url.searchParams.get('pool') ||
        FUNGIBLE_POOL.address ||
        pool3pPublicStatus()?.address;
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
    const p3 = pool3pPublicStatus();
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
      null;
    const credits = owner
      ? await listPoolCredits({ owner, limit: 20 })
      : { items: [] };
    const livePool = {
      address: liveAddress,
      custody: '3p-lindell',
      poolId: p3?.poolId || FUNGIBLE_POOL.poolId || undefined,
      previous: p3?.rotation?.last?.previous || inspected?.previousAddress || null,
    };
    return json(200, {
      ...lab,
      poolAddress: liveAddress || lab.poolAddress,
      livePool,
      pendingCredits: credits.items || [],
      mode: 'rollup+3p-payout+relayer',
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
    try {
      request.__bodyForLog = { action, signerId: body?.signerId, ticketId: body?.ticketId };
    } catch {
      /* Request may be frozen; logging then falls back to '?' */
    }

    if (RETIRED_ACTIONS.has(action)) {
      return json(410, {
        ok: false,
        retired: true,
        error: `"${action}" was Path A3 / hot-wallet and is retired — custody is 3P Lindell (use payout / pool3p_*)`,
      });
    }

    if (action === 'payout') {
      // Ticket must exist on the rollup with matching amount/to/owner.
      const verified = await assertPayoutMatchesTicket({
        ticketId: body.ticketId,
        toAddress: body.toAddress,
        amountE8: body.amountE8,
        owner: body.owner,
      });
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

    if (action === 'threshold_status' || action === 'threshold') {
      return json(200, await threshold3pView(body.ticketId));
    }

    if (action === 'threshold_heartbeat' || action === 'signer_heartbeat') {
      return json(
        200,
        await heartbeatPool3p({
          signerId: body.signerId,
          seatEpoch: body.seatEpoch ?? body.epoch,
          clientVersion: body.clientVersion,
        }),
      );
    }

    if (action === 'pool3p_close_room' || action === 'pool3p_reset_room') {
      return json(200, await closePool3pRoom(body.ticketId, body.reason || 'manual-reset'));
    }
    if (action === 'pool3p_status') {
      await expireStaleUserRooms().catch(() => ({ closed: [] }));
      try {
        const inspected = await fetchRollupPoolInspect('');
        const recent = inspected?.recentTickets || [];
        // A replaying machine reports yesterday's tickets as authorized —
        // reopening rooms off that ledger would re-pay them.
        if (!isReplaying()) {
          rememberInspectTickets(recent);
          await reopenAbandonedAuthorizedTickets(recent);
        }
      } catch (e) {
        console.warn('[pool3p] inspect/reopen', e?.message || e);
      }
      await maybeAbandonStaleSeats().catch(() => []);
      let rotation = null;
      try {
        const { tickRotation, rotationView } = await import(
          '../../utils/server/pool3pRotate.mjs'
        );
        rotation = await Promise.race([
          tickRotation(),
          new Promise((resolve) =>
            setTimeout(() => resolve(rotationView()), 5000),
          ),
        ]);
      } catch {
        /* */
      }
      // orbitKeys here too, not just on the heartbeat: packCachedSeat reads the
      // status endpoint to pick who to seal to, and without keys every target
      // is dropped as unsealable and the seat silently never packs.
      const wartOrbit = orbitSnapshot();
      return json(200, {
        ...pool3pPublicStatus(),
        rollups: rollupsInfo(),
        orbit: wartOrbit,
        orbitKeys: wartSealedPreshare.orbitKeys(wartOrbit?.live),
        rotation,
        machine: machineView(),
      });
    }

    if (action === 'eth3p_status') {
      if (!eth3pOn()) return json(200, { ok: false, configured: false, error: 'ETH 3P off' });
      const st = await publicEth3pStatus();
      const rotation = await tickEthRotation().catch((e) => ({ lastError: String(e?.message || e) }));
      return json(200, { ...st, rollups: rollupsInfo(), rotation, machine: machineView() });
    }
    if (action === 'eth3p_enroll') {
      return json(200, await enrollEth3pSigner({ signerId: body.signerId }));
    }
    if (action === 'eth3p_heartbeat') {
      const hb = await heartbeatEth3p({
        signerId: body.signerId,
        seatEpoch: body.seatEpoch,
        seatFault: body.seatFault,
        nodePubHex: body.nodePubHex,
        attestation: body.attestation,
        clientVersion: body.clientVersion,
      });
      const rotation = await tickEthRotation().catch((e) => ({
        lastError: String(e?.message || e),
      }));
      return json(200, { ...hb, rotation });
    }
    // Take a born-but-vacant e1/e2 by proving dlog(P). Never births — the seat's
    // P stays put, so the pool address cannot move. See claimBornEthSeat().
    if (action === 'eth3p_claim_born') {
      return json(200, await claimBornEthSeat({
        signerId: body.signerId,
        role: body.role,
        shareHex: body.pok ? undefined : (body.shareHex || body.e1Hex || body.e2Hex),
        pok: body.pok,
      }));
    }
    if (action === 'eth3p_birth') {
      return json(
        200,
        await birthEthSeat({
          signerId: body.signerId,
          role: body.role,
          P: body.P,
          encD1: body.encD1,
          paillierN: body.paillierN,
          paillierG: body.paillierG,
          pok: body.pok,
          rangeProof: body.rangeProof,
        }),
      );
    }
    if (action === 'eth3p_pdl_commit') {
      return json(200, openEthSeatPdl({ signerId: body.signerId, comQ: body.comQ }));
    }
    if (action === 'eth3p_pdl_finish') {
      return json(
        200,
        await finishEthSeatPdl({
          signerId: body.signerId,
          Qhat: body.Qhat,
          nonceQ: body.nonceQ,
          comQ: body.comQ,
        }),
      );
    }
    if (action === 'eth3p_credit') {
      return json(
        200,
        await creditEthLock({
          ethTxHash: body.ethTxHash || body.txHash,
          amountWei: body.amountWei,
          wartAddress: body.wartAddress,
          fromEth: body.fromEth,
        }),
      );
    }
    if (action === 'eth3p_register_wrap') {
      return json(
        200,
        await registerEthWrap({
          assetHash: body.assetHash,
          supplyE8: body.supplyE8,
          issuerWart: body.issuerWart || body.wartAddress,
          assetTxHash: body.assetTxHash,
          assetName: body.assetName,
        }),
      );
    }
    if (action === 'eth3p_burn') {
      return json(
        200,
        await recordEthBurn({
          assetHash: body.assetHash,
          amountE8: body.amountE8,
          burnerWart: body.burnerWart || body.wartAddress,
          wartTxHash: body.wartTxHash,
        }),
      );
    }
    if (action === 'eth3p_bind') {
      return json(
        200,
        await bindEthOwner({
          wartAddress: body.wartAddress,
          ethAddress: body.ethAddress,
        }),
      );
    }
    if (action === 'eth3p_burn_bin') {
      return json(200, { ok: true, burnBin: ETH_BURN_BIN });
    }
    /**
     * Which Warthog WETH assets the current ledger still backs. Every wrap mints
     * a new asset that displays as "WETH", and a reset orphans the old ones, so
     * the UI must classify holdings against this rather than by name.
     */
    if (action === 'eth3p_mintable') {
      return json(
        200,
        ethMintable({ issuerWart: body.issuerWart || body.wartAddress }),
      );
    }
    if (action === 'eth3p_assets') {
      return json(200, ethWrapIndex());
    }
    /**
     * Read-only burn precheck. Must be called BEFORE signing the transfer to the
     * burn bin — a Warthog transfer is irreversible, and recordEthBurn() can only
     * reject an orphan after the tokens are already gone.
     */
    if (action === 'eth3p_precheck_burn') {
      return json(
        200,
        await classifyEthBurn({ assetHash: body.assetHash, amountE8: body.amountE8 }),
      );
    }
    if (action === 'eth3p_open_redeem' || action === 'eth3p_redeem') {
      return json(
        200,
        await openEthRedeem({
          wartTxHash: body.wartTxHash || body.txHash,
          assetHash: body.assetHash,
          amountE8: body.amountE8,
          burnerWart: body.burnerWart || body.wartAddress,
          ethAddress: body.ethAddress,
        }),
      );
    }
    if (action === 'eth3p_r1') {
      return json(
        200,
        await eth3pOfferR1({
          ticketId: body.ticketId,
          signerId: body.signerId,
          R1Hex: body.R1Hex,
          hashHex: body.hashHex,
        }),
      );
    }
    if (action === 'eth3p_d2') {
      return json(
        200,
        await eth3pOfferD2({
          ticketId: body.ticketId,
          signerId: body.signerId,
          encD2: body.encD2,
          encDlogProof: body.encDlogProof,
          rangeProof: body.rangeProof,
        }),
      );
    }
    if (action === 'eth3p_ticket') {
      return json(200, eth3pStatusTicket(body.ticketId));
    }
    if (action === 'eth3p_submit') {
      return json(
        200,
        await eth3pSubmit({
          ticketId: body.ticketId,
          signature65: body.signature65,
        }),
      );
    }
    if (action === 'eth3p_birth_next') {
      return json(
        200,
        await birthEthSeatNext({
          signerId: body.signerId,
          role: body.role,
          P: body.P,
          encD1: body.encD1,
          paillierN: body.paillierN,
          paillierG: body.paillierG,
          pok: body.pok,
          rangeProof: body.rangeProof,
        }),
      );
    }
    if (action === 'eth3p_pdl_commit_next') {
      return json(200, openEthSeatPdlNext({ signerId: body.signerId, comQ: body.comQ }));
    }
    if (action === 'eth3p_pdl_finish_next') {
      return json(
        200,
        await finishEthSeatPdlNext({
          signerId: body.signerId,
          Qhat: body.Qhat,
          nonceQ: body.nonceQ,
          comQ: body.comQ,
        }),
      );
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
        pok: body.pok,
        rangeProof: body.rangeProof,
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
        clientVersion: body.clientVersion,
      });
      // Remember this node's key so other seats can seal pieces to it, and hand
      // back any pieces it should reseal for a tab trying to recover a seat.
      await rememberWartNode({
        signerId: body.signerId,
        nodePubHex: body.nodePubHex,
        attestation: body.attestation,
      }).catch(() => null);
      const sealedFields = sealedPreshareFieldsFor(body.signerId, hb?.orbit?.live);
      let rotation = null;
      try {
        const { tickRotation } = await import('../../utils/server/pool3pRotate.mjs');
        rotation = await tickRotation();
      } catch {
        /* */
      }
      return json(200, { ...hb, ...sealedFields, rotation });
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
        shareHex: body.pok ? undefined : (body.shareHex || body.d1Hex || body.d2Hex),
        pok: body.pok,
      }));
    }
    if (action === 'pool3p_rekey_d1' || action === 'rekey_d1') {
      return json(200, await rekeyClientD1Paillier({
        signerId: body.signerId,
        encD1: body.encD1,
        paillierN: body.paillierN,
        paillierG: body.paillierG,
        pok: body.pok,
        rangeProof: body.rangeProof,
      }));
    }
    if (action === 'pool3p_pdl_commit') {
      return json(200, openClientSeatPdl({
        signerId: body.signerId,
        comQ: body.comQ,
        kind: body.kind || 'birth',
      }));
    }
    if (action === 'pool3p_pdl_finish') {
      return json(200, await finishClientSeatPdl({
        signerId: body.signerId,
        Qhat: body.Qhat,
        nonceQ: body.nonceQ,
        comQ: body.comQ,
        kind: body.kind || 'birth',
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
        pok: body.pok,
        rangeProof: body.rangeProof,
      });
      return json(200, born);
    }
    // --- sealed preshare packs -------------------------------------------
    // The coordinator relays these; it cannot open any of them.
    if (action === 'eth3p_preshare_put') {
      return json(200, await ethSealedPreshare.putPack(body));
    }
    if (action === 'eth3p_preshare_reseal_request') {
      return json(200, await ethSealedPreshare.requestReseal(body));
    }
    if (action === 'eth3p_preshare_reseal_put') {
      return json(200, await ethSealedPreshare.putResealed(body));
    }
    if (action === 'eth3p_preshare_collect') {
      return json(200, ethSealedPreshare.collect({ signerId: body.signerId, role: body.role }));
    }
    if (action === 'eth3p_preshare_status') {
      return json(200, ethSealedPreshare.summary());
    }
    if (action === 'pool3p_preshare_reseal_request') {
      return json(200, await wartSealedPreshare.requestReseal(body));
    }
    if (action === 'pool3p_preshare_reseal_put') {
      return json(200, await wartSealedPreshare.putResealed(body));
    }
    if (action === 'pool3p_preshare_status') {
      return json(200, wartSealedPreshare.summary());
    }
    if (action === 'pool3p_preshare_put') {
      return json(
        200,
        body.pack ? await wartSealedPreshare.putPack(body) : await putPreshare(body),
      );
    }
    if (action === 'pool3p_preshare_get') {
      return json(200, await getPresharePiece({ signerId: body.signerId, role: body.role }));
    }
    if (action === 'pool3p_preshare_collect') {
      const sealed = wartSealedPreshare.collect({ signerId: body.signerId, role: body.role });
      if (sealed?.pack) return json(200, sealed);
      return json(200, await collectPreshare({ signerId: body.signerId, role: body.role }));
    }
    if (action === 'pool3p_prepare') {
      const dapp = loadPool3pDapp();
      if (!dapp) return json(400, { error: '3P pool not configured' });
      let prep;
      try {
        prep = await pool3pReuseOrPrepare(body.ticketId, {
          toAddress: body.toAddress,
          amountE8: body.amountE8,
          makePrep: () => preparePool3pTransfer({
            fromAddress: dapp.address,
            toAddress: body.toAddress,
            amountE8: body.amountE8,
          }),
        });
      } catch (e) {
        // A failed prepare used to die in the 400 body — d1 stalled with no journal line.
        console.warn(
          `[pool3p] prepare failed ticket=${body.ticketId || '?'} signer=${String(body.signerId || '?').slice(0, 20)}: ${e?.message || e}`,
        );
        throw e;
      }
      if (prep?.alreadyPaid) return json(200, { ok: true, ...prep });
      return json(200, prep);
    }
    if (action === 'pool3p_pack_report' || action === 'eth3p_pack_report') {
      return json(200, notePackReport(action.startsWith('eth3p') ? 'eth' : 'wart', {
        signerId: body.signerId,
        role: body.role,
        packed: body.packed,
        reason: body.reason,
        targets: body.targets,
        need: body.need,
        live: body.live,
        client: body.client,
      }));
    }
    if (action === 'pool3p_skip') {
      return json(200, pool3pNoteSkip({
        signerId: body.signerId,
        role: body.role,
        ticketId: body.ticketId,
        reasons: body.reasons,
        checks: body.checks,
        sources: body.sources,
        local: body.local,
        gqlError: body.gqlError,
        network: body.network,
        client: body.client,
      }));
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
        encD2: body.encD2,
        encDlogProof: body.encDlogProof,
        rangeProof: body.rangeProof,
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
      const already = paidRecordFor(body.ticketId, {
        amountE8: body.amountE8,
        toAddress: body.toAddress,
      });
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
        const msg = e?.message || String(e);
        try {
          const { writeFileSync, appendFileSync } = await import('node:fs');
          appendFileSync(
            '/opt/cartesi-bridge/cartesi-bridge-frontend/.data/pool-submit-err.log',
            `${new Date().toISOString()} ${body.ticketId} ${msg}\n`,
          );
        } catch {
          /* */
        }
        if (e?.code === 'HASH_MISMATCH') return json(409, { error: msg });
        return json(400, { ok: false, error: msg });
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
      return json(200, await enrollPool3pSigner({
        signerId: body.signerId,
        role: body.role,
      }));
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
      const pool3p = pool3pPublicStatus();
      let inspected = null;
      try {
        inspected = await fetchRollupPoolInspect('');
      } catch {
        /* */
      }
      const poolAddress =
        pool3p?.address ||
        inspected?.poolAddress ||
        body.poolAddress ||
        FUNGIBLE_POOL.address;
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
        requireVerified: globalThis.process?.env?.POOL_CREDIT_REQUIRE_VERIFY === '1',
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

    if (action === 'status') {
      const result = await applyPoolAction(body || {});
      return json(200, { ...result, mode: 'lab-ledger' });
    }

    return json(400, {
      ok: false,
      error: `unknown action "${action}" (payout|pool3p_*|eth3p_*|request_credit|register_bind|status)`,
    });
  } catch (e) {
    const msg = e?.message || String(e);
    const status =
      /Unauthorized|No pool_release|mismatch|disabled/i.test(msg) ? 403 : 400;
    noteActionError(request, status, msg);
    return json(status, { ok: false, error: msg });
  }
}

/**
 * A thrown action used to die in the 4xx body and nowhere else: nginx showed
 * "400 ×130 per 5 min" and nothing said which action, which signer, or why.
 * Journal one line per (action, message, signer) per minute.
 */
const actionErrSeen = new Map();
function noteActionError(request, status, msg) {
  let action = '?';
  let signer = '?';
  let ticket = '';
  try {
    const b = request?.__bodyForLog || {};
    action = String(b.action || '?');
    signer = String(b.signerId || '?').slice(0, 20);
    ticket = b.ticketId ? ` ticket=${String(b.ticketId).slice(0, 40)}` : '';
  } catch {
    /* */
  }
  const key = `${action}|${signer}|${msg}`;
  const now = Date.now();
  if (now - (actionErrSeen.get(key) || 0) < 60000) return;
  actionErrSeen.set(key, now);
  if (actionErrSeen.size > 512) {
    for (const [k, at] of actionErrSeen) if (now - at > 600000) actionErrSeen.delete(k);
  }
  console.warn(`[pool] ${status} action=${action} signer=${signer}${ticket}: ${msg}`);
}
