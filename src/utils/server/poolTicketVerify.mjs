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
      query: `{ notices(last: ${Math.min(500, Number(last) || 400)}) { edges { node { index payload input { index } proof { context validity { inputIndexWithinEpoch outputIndexWithinInput outputHashesRootHash vouchersEpochRootHash noticesEpochRootHash machineStateHash outputHashInOutputHashesSiblings outputHashesInEpochSiblings } } } } } }`,
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
    const proof = e?.node?.proof || null;
    const v = proof?.validity;
    const hasProof = !!(
      v?.noticesEpochRootHash &&
      Array.isArray(v?.outputHashInOutputHashesSiblings) &&
      v.outputHashInOutputHashesSiblings.length > 0 &&
      Array.isArray(v?.outputHashesInEpochSiblings) &&
      v.outputHashesInEpochSiblings.length > 0
    );
    if (!best || idx >= best._index) {
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
 * L1 Application.validateNotice for a release ticket.
 * Signers must pass this before r1/d2; coordinator re-checks.
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
    const err = new Error('waiting for Cartesi notice proof (epoch not claimed)');
    err.code = 'NOTICE_PROOF';
    err.waiting = true;
    throw err;
  }
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
  let ok = false;
  try {
    ok = await app.validateNotice(notice._payloadHex, proof);
  } catch (e) {
    const err = new Error(`validateNotice failed: ${e.shortMessage || e.message}`);
    err.code = 'NOTICE_PROOF';
    throw err;
  }
  if (!ok) {
    const err = new Error('validateNotice returned false');
    err.code = 'NOTICE_PROOF';
    throw err;
  }
  return {
    ok: true,
    ticketId: id,
    noticeIndex: notice._index,
    inputIndex: notice._inputIndex,
    amountE8: String(notice.amountE8),
    toAddress: notice.toAddress,
  };
}
