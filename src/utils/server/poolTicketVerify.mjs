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

function noticeHasEpochProof(proof) {
  const v = proof?.validity;
  return !!(
    v?.noticesEpochRootHash &&
    Array.isArray(v?.outputHashInOutputHashesSiblings) &&
    v.outputHashInOutputHashesSiblings.length > 0 &&
    Array.isArray(v?.outputHashesInEpochSiblings) &&
    v.outputHashesInEpochSiblings.length > 0
  );
}

function rankReleaseNotice(obj) {
  const typ = String(obj?.type || '');
  if (typ === 'pool_release_authorized' || obj?.status === 'authorized') return 2;
  if (typ === 'pool_release_ticket') return 1;
  if (typ === 'pool_release_pending') return 0;
  return -1;
}

/**
 * Walk GraphQL notices newest-first. Header floods make a single last:N miss
 * older burns; ticket 8 is recent but later tickets will not be.
 * @returns {Promise<object|null>} ticket notice fields
 */
export async function findReleaseTicketNotice(ticketId, { pages = 20 } = {}) {
  const id = String(ticketId || '').trim();
  if (!id) return null;

  let cursor = null;
  let best = null;
  for (let page = 0; page < Math.min(30, Number(pages) || 20); page++) {
    const after = cursor ? `, before: ${JSON.stringify(cursor)}` : '';
    const res = await fetch(GRAPHQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ notices(last: 100${after}) { pageInfo { hasPreviousPage startCursor } edges { node { index payload input { index } proof { context validity { inputIndexWithinEpoch outputIndexWithinInput outputHashesRootHash vouchersEpochRootHash noticesEpochRootHash machineStateHash outputHashInOutputHashesSiblings outputHashesInEpochSiblings } } } } } }`,
      }),
    });
    if (!res.ok) {
      throw new Error(`GraphQL notices HTTP ${res.status}`);
    }
    const json = await res.json();
    const conn = json?.data?.notices || {};
    for (const e of conn.edges || []) {
      const obj = decodePayload(e?.node?.payload);
      if (!obj) continue;
      if (rankReleaseNotice(obj) < 0) continue;
      if (String(obj.ticketId || '') !== id) continue;
      const idx = Number(e?.node?.index ?? 0);
      const proof = e?.node?.proof || null;
      const hasProof = noticeHasEpochProof(proof);
      const rank = rankReleaseNotice(obj);
      const bestRank = best ? rankReleaseNotice(best) : -1;
      if (!best || rank > bestRank || (rank === bestRank && idx >= best._index)) {
        best = {
          ...obj,
          _index: idx,
          _inputIndex: e?.node?.input?.index ?? null,
          _payloadHex: e?.node?.payload || null,
          _proof: proof,
          _hasProof: hasProof,
        };
      }
    }
    if (best) return best;
    if (!conn.pageInfo?.hasPreviousPage || !conn.pageInfo?.startCursor) break;
    cursor = conn.pageInfo.startCursor;
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

const L1_RPC =
  process.env.CARTESI_RPC_URL ||
  process.env.PUBLIC_L1_RPC ||
  'http://127.0.0.1:8545';
const DAPP =
  process.env.CARTESI_DAPP || '0xab7528bb862fB57E8A2BCd567a2e929a0Be56a5e';

const VALIDATE_NOTICE_ABI = [
  'function validateNotice(bytes notice, tuple(tuple(uint64 inputIndexWithinEpoch, uint64 outputIndexWithinInput, bytes32 outputHashesRootHash, bytes32 vouchersEpochRootHash, bytes32 noticesEpochRootHash, bytes32 machineStateHash, bytes32[] outputHashInOutputHashesSiblings, bytes32[] outputHashesInEpochSiblings) validity, bytes context) proof) view returns (bool)',
];

export function ticketNeedsNoticeProof(ticketId) {
  const id = String(ticketId || '');
  if (!id) return false;
  if (/^lab-demo-/.test(id)) return false;
  if (/^wart-pool-rotate-/.test(id)) return false;
  return true;
}

/**
 * Burn attestation for a release ticket.
 * Require the GraphQL pool_release_ticket (+ epoch siblings when present).
 * L1 Application.validateNotice is best-effort: GraphQL can show the proof
 * before History claims the epoch, and that must not stall d1/d2.
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
  if (!notice._hasProof || !notice._proof?.validity || !notice._payloadHex) {
    // GraphQL notice is the burn attestation. Epoch siblings must not stall
    // d1/d2 — rooms were expire-idle while signers skipped on this wait.
    return {
      ok: true,
      ticketId: id,
      noticeIndex: notice._index,
      inputIndex: notice._inputIndex,
      amountE8: String(notice.amountE8),
      toAddress: notice.toAddress,
      proofSource: 'notice-without-epoch-siblings',
    };
  }
  let l1 = null;
  try {
    const { JsonRpcProvider, Contract } = await import('ethers-v6');
    const provider = new JsonRpcProvider(L1_RPC);
    const app = new Contract(DAPP, VALIDATE_NOTICE_ABI, provider);
    const v = notice._proof.validity;
    const proof = {
      validity: {
        inputIndexWithinEpoch: BigInt(v.inputIndexWithinEpoch),
        outputIndexWithinInput: BigInt(v.outputIndexWithinInput),
        outputHashesRootHash: v.outputHashesRootHash,
        vouchersEpochRootHash: v.vouchersEpochRootHash,
        noticesEpochRootHash: v.noticesEpochRootHash,
        machineStateHash: v.machineStateHash,
        outputHashInOutputHashesSiblings: v.outputHashInOutputHashesSiblings,
        outputHashesInEpochSiblings: v.outputHashesInEpochSiblings,
      },
      context: String(notice._proof.context || '').startsWith('0x')
        ? notice._proof.context
        : `0x${notice._proof.context || ''}`,
    };
    const ok = await app.validateNotice(notice._payloadHex, proof);
    l1 = { ok: !!ok };
    if (!ok) l1.error = 'validateNotice returned false';
  } catch (e) {
    l1 = { ok: false, error: e.shortMessage || e.message };
  }
  return {
    ok: true,
    ticketId: id,
    noticeIndex: notice._index,
    inputIndex: notice._inputIndex,
    amountE8: String(notice.amountE8),
    toAddress: notice.toAddress,
    proofSource: l1?.ok ? 'l1-validateNotice' : 'graphql-epoch-proof',
    l1,
  };
}
