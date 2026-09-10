/**
 * Verify a pool_release_ticket against the rollup's notices before payout.
 * Prevents unauthenticated callers from inventing ticketId/amount/to.
 *
 * All rollup reads go through rollupsApi.mjs (Cartesi 1.5 GraphQL or
 * rollups-node 2.x JSON-RPC, per ROLLUPS_API). The v1 queries are the ones
 * that used to live here, byte for byte.
 */
import {
  findReleaseTicketNotice as apiFindReleaseTicketNotice,
  validateNoticeOnL1,
  isV2,
} from './rollupsApi.mjs';

function normAddr(a) {
  return String(a || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

/**
 * Walk notices newest-first. Header floods make a single last:N miss
 * older burns; ticket 8 is recent but later tickets will not be.
 * @returns {Promise<object|null>} ticket notice fields (+ _index/_inputIndex/_payloadHex/_proof/_hasProof)
 */
export async function findReleaseTicketNotice(ticketId, { pages = 20 } = {}) {
  return apiFindReleaseTicketNotice(ticketId, { pages });
}

/**
 * Assert request matches an on-rollup release ticket.
 * @param {{ ticketId: string, toAddress?: string, amountE8?: string|number|bigint, owner?: string }} args
 */
export async function assertPayoutMatchesTicket(args) {
  const ticketId = String(args.ticketId || '').trim();
  if (!ticketId) throw new Error('ticketId required');

  const notice = await findReleaseTicketNotice(ticketId);
  if (!notice) {
    throw new Error(
      `No pool_release_ticket notice for ${ticketId} — burn/redeem on rollup first`,
    );
  }

  const wantE8 = BigInt(String(args.amountE8 || 0));
  const noticeE8 = BigInt(String(notice.amountE8 || 0));
  if (wantE8 <= 0n) throw new Error('amountE8 must be > 0');
  if (wantE8 !== noticeE8) {
    throw new Error(
      `amountE8 mismatch request=${wantE8} ticket=${noticeE8} (ticketId=${ticketId})`,
    );
  }

  const reqTo = normAddr(args.toAddress);
  const noticeTo = normAddr(notice.toAddress);
  // If ticket fixed a destination, request must match.
  if (noticeTo) {
    if (!reqTo) {
      throw new Error('toAddress required (ticket has fixed redeem-to)');
    }
    // Allow 40-hex vs 48-hex if one contains the other core — compare last 40 of each
    const a = reqTo.length >= 40 ? reqTo.slice(-40) : reqTo;
    const b = noticeTo.length >= 40 ? noticeTo.slice(-40) : noticeTo;
    if (a !== b && reqTo !== noticeTo) {
      throw new Error(
        `toAddress mismatch request=${reqTo.slice(0, 12)}… ticket=${noticeTo.slice(0, 12)}…`,
      );
    }
  } else if (!reqTo) {
    throw new Error('toAddress required');
  }

  if (args.owner && notice.owner) {
    const o = String(args.owner).toLowerCase();
    const n = String(notice.owner).toLowerCase();
    // A-β: notice.owner is redeemer (burner), must match caller claim
    if (o !== n) {
      throw new Error(
        `owner mismatch request=${o.slice(0, 10)}… ticket owner=${n.slice(0, 10)}…`,
      );
    }
  }

  return {
    ok: true,
    notice,
    ticketId,
    amountE8: noticeE8.toString(),
    toAddress: noticeTo || reqTo,
    owner: notice.owner || args.owner || null,
    phase: notice.phase || null,
    reason: notice.reason || null,
  };
}

export function ticketNeedsNoticeProof(ticketId) {
  const id = String(ticketId || '');
  if (!id) return false;
  if (/^lab-demo-/.test(id)) return false;
  if (/^wart-pool-rotate-/.test(id)) return false;
  return true;
}

/**
 * Burn attestation for a release ticket.
 * Require the rollup's pool_release_ticket notice (+ proof when present).
 * L1 validation is best-effort: on 1.5 GraphQL can show the proof before
 * History claims the epoch, and that must not stall d1/d2. On v2 a proof
 * only appears once the epoch claim is accepted.
 */
export async function assertReleaseNoticeProof(ticketId, extra = {}) {
  const id = String(ticketId || '').trim();
  if (!ticketNeedsNoticeProof(id)) {
    return { ok: true, skipped: true, ticketId: id };
  }
  const notice = await findReleaseTicketNotice(id);
  if (!notice) {
    const err = new Error(
      `No pool_release_ticket notice for ${id} — burn/redeem on rollup first`,
    );
    err.code = 'NOTICE_PROOF';
    err.waiting = false;
    throw err;
  }
  if (extra.amountE8 != null && String(extra.amountE8) !== '' &&
      String(notice.amountE8) !== String(extra.amountE8)) {
    throw new Error(`amountE8 mismatch ticket=${notice.amountE8}`);
  }
  if (extra.toAddress && notice.toAddress) {
    const a = normAddr(extra.toAddress);
    const b = normAddr(notice.toAddress);
    const a40 = a.length >= 40 ? a.slice(-40) : a;
    const b40 = b.length >= 40 ? b.slice(-40) : b;
    if (a !== b && a40 !== b40) {
      throw new Error('toAddress mismatch vs release notice');
    }
  }
  const base = {
    ok: true,
    ticketId: id,
    noticeIndex: notice._index,
    inputIndex: notice._inputIndex,
    epochIndex: notice._epochIndex ?? null,
    amountE8: String(notice.amountE8),
    toAddress: notice.toAddress,
  };
  if (!notice._hasProof || !notice._proof || !notice._payloadHex) {
    // The rollup notice is the burn attestation. Epoch siblings must not stall
    // d1/d2 — rooms were expire-idle while signers skipped on this wait.
    return { ...base, proofSource: 'notice-without-epoch-siblings' };
  }
  const l1 = await validateNoticeOnL1(notice);
  return {
    ...base,
    proofSource: l1?.ok
      ? isV2() ? 'l1-validateOutput' : 'l1-validateNotice'
      : isV2() ? 'node-output-proof' : 'graphql-epoch-proof',
    l1,
  };
}
