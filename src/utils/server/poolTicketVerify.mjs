/**
 * Verify a pool_release_ticket against Cartesi GraphQL notices before hot payout.
 * Prevents unauthenticated callers from inventing ticketId/amount/to.
 */
const GRAPHQL =
  process.env.CARTESI_GRAPHQL_URL || 'http://127.0.0.1:8080/graphql';

function decodePayload(raw) {
  if (raw == null) return null;
  let text = raw;
  if (String(raw).startsWith('0x')) {
    try {
      text = Buffer.from(String(raw).slice(2), 'hex').toString('utf8');
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normAddr(a) {
  return String(a || '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

/**
 * Scan recent notices for matching pool_release_ticket.
 * @returns {Promise<object|null>} ticket notice fields
 */
export async function findReleaseTicketNotice(ticketId, { last = 400 } = {}) {
  const id = String(ticketId || '').trim();
  if (!id) return null;

  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `{ notices(last: ${Math.min(500, Number(last) || 400)}) { edges { node { index payload } } } }`,
    }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL notices HTTP ${res.status}`);
  }
  const json = await res.json();
  const edges = json?.data?.notices?.edges || [];
  // newest last in many Cartesi setups — scan all, prefer highest index
  let best = null;
  for (const e of edges) {
    const obj = decodePayload(e?.node?.payload);
    if (!obj) continue;
    if (obj.type !== 'pool_release_ticket') continue;
    if (String(obj.ticketId || '') !== id) continue;
    const idx = Number(e?.node?.index ?? 0);
    if (!best || idx >= best._index) {
      best = { ...obj, _index: idx };
    }
  }
  return best;
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
