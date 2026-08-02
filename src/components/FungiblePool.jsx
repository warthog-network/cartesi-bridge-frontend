/**
 * Path A — Fungible shared pool (real WART + real wWART mint/burn/redeem).
 * Independent of SubWallet / 2P cosigner personal vaults.
 *
 * Deposit is 1-button (atomic feel): Warthog send → credit queue → relayer
 * posts pool_deposit (no second MetaMask in happy path). Resume via pending
 * store / tx hash if credit never lands. Phase 3 SPV is the trust north star.
 */
import { useCallback, useEffect, useState } from 'react';
import { Droplets, RefreshCw, Layers } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { FUNGIBLE_POOL } from '../utils/fungiblePoolConfig.js';
import { LOCAL_WWART } from '../utils/localTokens.js';
import { getInspectUrl, getRollupGraphqlUrl } from '../utils/bridgeConfig.js';
import { normalizeTxLookup } from '../utils/txProof.js';
import {
  listPendingForOwner,
  upsertPendingDeposit,
  updatePendingStatus,
  removePendingDeposit,
  isOpenPendingStatus,
} from '../utils/poolPendingStore.js';
import {
  FLOW_STEPS,
  listOpenFlows,
  upsertFlow,
  advanceFlowForOwner,
  completeFlow,
  cancelFlow,
  reconcileFlowsFromInspect,
  stepMeta,
  flowProgress,
} from '../utils/poolFlowTracker.js';

function humanFrom18(raw) {
  try {
    const bn = BigInt(raw || 0);
    if (bn === 0n) return '0';
    const whole = bn / 10n ** 18n;
    let frac = (bn % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
  } catch {
    return '0';
  }
}

function humanFromE8(raw) {
  try {
    const bn = BigInt(raw || 0);
    if (bn === 0n) return '0';
    const whole = bn / 10n ** 8n;
    let frac = (bn % 10n ** 8n).toString().padStart(8, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
  } catch {
    return '0';
  }
}

async function poolApi(path, init) {
  const res = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `pool API ${res.status}`);
  }
  return data;
}

function decodeInspectPayload(payload) {
  if (payload == null) return null;
  if (typeof payload === 'object') return payload;
  const s = String(payload);
  try {
    if (s.startsWith('0x')) {
      const hex = s.slice(2);
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** fetch with hard timeout so GraphQL never blocks deposit forever. */
async function fetchWithTimeout(url, init = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function decodeNoticePayload(raw) {
  if (raw == null) return null;
  let text = raw;
  if (String(raw).startsWith('0x')) {
    try {
      const hex = String(raw).slice(2);
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      text = new TextDecoder().decode(bytes);
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

/**
 * Slim Warthog lookup proof to fields the rollup normalizeWarthogTx needs.
 * Full lookup objects are fine size-wise today, but keeping InputBox payload
 * small avoids MetaMask / gas surprises if the node ever returns fat proofs.
 */
function slimDepositProof(proof) {
  const normalized = normalizeTxLookup(proof);
  const tx = normalized?.transaction || {};
  return {
    transaction: {
      txHash: tx.txHash || tx.hash || null,
      fromAddress: tx.fromAddress || null,
      toAddress: tx.toAddress || null,
      amountE8: Number(tx.amountE8 ?? 0),
      blockHeight: tx.blockHeight ?? null,
      confirmations: tx.confirmations ?? normalized?.confirmations ?? 0,
    },
    confirmations: normalized?.confirmations ?? tx.confirmations ?? 0,
    mined: normalized?.mined || undefined,
  };
}

/** Notices use top-level `owner`, string `user`, or nested `user.owner` (poolSnapshot overwrites). */
function extractNoticeOwner(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (typeof obj.owner === 'string' && obj.owner) {
    return obj.owner.toLowerCase();
  }
  if (typeof obj.user === 'string' && obj.user) {
    return obj.user.toLowerCase();
  }
  if (obj.user && typeof obj.user === 'object' && obj.user.owner) {
    return String(obj.user.owner).toLowerCase();
  }
  return '';
}

/** Stable unique id for a GraphQL notice edge — raw payload, not field fingerprint. */
function noticePayloadKey(rawPayload) {
  return String(rawPayload || '').toLowerCase();
}

async function fetchNoticeEdges(last = 50) {
  const res = await fetchWithTimeout(
    getRollupGraphqlUrl(),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ notices(last: ${last}) { edges { node { payload } } } }`,
      }),
    },
    10000,
  );
  const json = await res.json();
  return json?.data?.notices?.edges || [];
}

/** Snapshot of raw notice payloads currently in GraphQL (before L1 submit). */
async function snapshotNoticePayloads({ last = 50 } = {}) {
  const seen = new Set();
  try {
    for (const e of await fetchNoticeEdges(last)) {
      const key = noticePayloadKey(e?.node?.payload);
      if (key) seen.add(key);
    }
  } catch {
    /* empty — may match once */
  }
  return seen;
}

/**
 * Wait for a NEW notice (payload not in seenRaw). Prefer inspect-based waits for actions.
 * Reject types throw immediately when they match owner.
 */
async function waitForNotice(
  typeMatch,
  {
    timeoutMs = 30000,
    rejectType = null,
    matchTxHash = null,
    matchOwner = null,
    seenPayloads = null,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  const seen = seenPayloads || new Set();
  const wantTx = matchTxHash ? String(matchTxHash).toLowerCase() : null;
  const wantOwner = matchOwner ? String(matchOwner).toLowerCase() : null;
  const types = Array.isArray(typeMatch) ? typeMatch : [typeMatch];
  const rejectTypes = rejectType
    ? Array.isArray(rejectType)
      ? rejectType
      : [rejectType]
    : [];

  while (Date.now() < deadline) {
    try {
      const edges = await fetchNoticeEdges(50);
      for (const e of edges.slice().reverse()) {
        const raw = e?.node?.payload;
        const key = noticePayloadKey(raw);
        if (key && seen.has(key)) continue;
        const obj = decodeNoticePayload(raw);
        if (!obj?.type) continue;
        if (key) seen.add(key);

        const noticeOwner = extractNoticeOwner(obj);
        if (rejectTypes.includes(obj.type)) {
          if (wantOwner && noticeOwner && noticeOwner !== wantOwner) continue;
          const reason = obj.reason || obj.message || obj.type;
          const err = new Error(`Rollup rejected: ${reason}`);
          err.notice = obj;
          throw err;
        }
        if (!types.includes(obj.type)) continue;
        if (wantTx && obj.txHash && String(obj.txHash).toLowerCase() !== wantTx) {
          continue;
        }
        if (wantOwner && noticeOwner && noticeOwner !== wantOwner) continue;
        return obj;
      }
    } catch (e) {
      if (e?.notice || String(e?.message || '').startsWith('Rollup rejected')) throw e;
    }
    await sleep(1500);
  }
  return null;
}

/** @deprecated alias — older call sites */
async function snapshotNoticeFingerprints(opts) {
  return snapshotNoticePayloads(opts);
}

/**
 * Primary confirmation path: poll pool inspect until `ok(before, after)` is true.
 * Notices are secondary and flaky on mobile; inspect is rollup truth.
 */
async function waitForPoolState(owner, ok, { timeoutMs = 45000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fetchPoolInspect(owner);
      if (last && !last.error && ok(last)) return last;
    } catch {
      /* retry */
    }
    await sleep(intervalMs);
  }
  return last;
}

function userBn(insp, field) {
  try {
    return BigInt(String(insp?.user?.[field] ?? 0));
  } catch {
    return 0n;
  }
}

function poolBn(insp, field) {
  try {
    return BigInt(String(insp?.[field] ?? 0));
  } catch {
    return 0n;
  }
}

/** Count GraphQL vouchers for this L1 owner (msgSender). */
async function countOwnerVouchers(owner) {
  const want = String(owner || '').toLowerCase();
  try {
    const res = await fetchWithTimeout(
      getRollupGraphqlUrl(),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `{ vouchers(last: 40) { edges { node { input { msgSender } } } } }`,
        }),
      },
      10000,
    );
    const json = await res.json();
    let n = 0;
    for (const e of json?.data?.vouchers?.edges || []) {
      const s = String(e?.node?.input?.msgSender || '').toLowerCase();
      if (!want || s === want) n += 1;
    }
    return n;
  } catch {
    return -1;
  }
}

/** Read pool inspect for owner (rollup truth after deposit). */
async function fetchPoolInspect(owner) {
  const base = getInspectUrl().replace(/\/$/, '');
  const path = owner
    ? `pool/${String(owner).replace(/^0x/i, '').toLowerCase()}`
    : 'pool';
  const res = await fetchWithTimeout(`${base}/${path}`, { cache: 'no-store' }, 12000);
  const data = await res.json();
  if (!data.reports?.length) return null;
  return decodeInspectPayload(data.reports[0].payload);
}

export default function FungiblePool({
  ownerAddress,
  send,
  wartBridgeApi,
  onRefreshL1Vault,
  /** Live MetaMask ERC-20 wWART balance (human string) — same source as Warthog Overview */
  mmWwartBal = null,
  onRefreshMmWwart,
}) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [snap, setSnap] = useState(null);
  const [amount, setAmount] = useState('1');
  const [toAddress, setToAddress] = useState('');
  const [lastTicket, setLastTicket] = useState(null);
  const [mode, setMode] = useState('live'); // live | lab
  const [pendingList, setPendingList] = useState([]);
  const [openFlows, setOpenFlows] = useState([]);
  const [resumeTxHash, setResumeTxHash] = useState('');
  /** Lab mode only when PUBLIC_POOL_LAB=1 or ?lab=1 — public demo hides it. */
  const labUiEnabled =
    String(import.meta.env.PUBLIC_POOL_LAB || '') === '1' ||
    (typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('lab') === '1');

  const owner = ownerAddress || '';
  const poolAddr = snap?.poolAddress || FUNGIBLE_POOL.address;
  const wwartToken = LOCAL_WWART?.address;
  const spv = snap?.spv || null;

  const refreshPending = useCallback(() => {
    setPendingList(
      listPendingForOwner(owner).filter((p) => isOpenPendingStatus(p.status)),
    );
  }, [owner]);

  /**
   * Clear browser "stranded" rows once the server queue or rollup already
   * credited them (avoids false Resume prompts after a successful relayer fix).
   */
  const reconcilePendingWithServer = useCallback(async () => {
    if (!owner || mode !== 'live') return;
    const open = listPendingForOwner(owner).filter((p) =>
      isOpenPendingStatus(p.status),
    );
    if (!open.length) {
      setPendingList([]);
      return;
    }
    try {
      const credits = await poolApi(
        `/api/pool?credits=1&owner=${encodeURIComponent(owner)}&limit=50`,
      );
      const byHash = new Map(
        (credits.items || []).map((i) => [
          String(i.txHash || '')
            .replace(/^0x/i, '')
            .toLowerCase(),
          i,
        ]),
      );
      let cleared = 0;
      for (const p of open) {
        const h = String(p.txHash || '')
          .replace(/^0x/i, '')
          .toLowerCase();
        const row = byHash.get(h);
        if (row?.status === 'credited') {
          removePendingDeposit(p.txHash);
          cleared += 1;
        }
      }
      if (cleared) {
        toast.success(
          cleared === 1
            ? 'Cleared 1 deposit already credited on the rollup'
            : `Cleared ${cleared} deposits already credited on the rollup`,
          { id: 'pool-pending-clear', duration: 4000 },
        );
      }
    } catch {
      /* offline / API — leave local list */
    }
    refreshPending();
  }, [owner, mode, refreshPending]);

  const refreshFlows = useCallback(
    (inspectSnap = null) => {
      const insp = inspectSnap || snap;
      const open = reconcileFlowsFromInspect(owner, insp, {
        mmWwartHuman: mmWwartBal,
      });
      setOpenFlows(open.length ? open : listOpenFlows(owner));
    },
    [owner, snap, mmWwartBal],
  );

  useEffect(() => {
    refreshPending();
    refreshFlows();
    // Drop local stranded markers once server has credited
    void reconcilePendingWithServer();
  }, [
    refreshPending,
    refreshFlows,
    reconcilePendingWithServer,
    snap?.user?.depositedE8,
    snap?.user?.claim18,
    snap?.user?.portable18,
    mmWwartBal,
  ]);

  // Poll inspect while a flow is open (same idea as mempool pending)
  useEffect(() => {
    if (!owner || mode !== 'live' || openFlows.length === 0) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const insp = await fetchPoolInspect(owner);
        if (cancelled || !insp) return;
        reconcileFlowsFromInspect(owner, insp, { mmWwartHuman: mmWwartBal });
        if (!cancelled) {
          setOpenFlows(listOpenFlows(owner));
          // Keep main snap loosely in sync for step display
          setSnap((prev) => {
            if (!insp) return prev;
            return {
              ...(prev || {}),
              lockedE8: insp.lockedE8,
              lockedHuman: humanFromE8(insp.lockedE8),
              capacity18: insp.capacity18,
              claimed18: insp.claimed18,
              available18: insp.available18,
              availableHuman: humanFrom18(insp.available18),
              user: insp.user
                ? {
                    ...insp.user,
                    depositedHuman: humanFromE8(insp.user.depositedE8),
                    claimHuman: humanFrom18(insp.user.claim18),
                    portableHuman: humanFrom18(insp.user.portable18),
                    freeableHuman: humanFromE8(insp.user.freeableE8),
                  }
                : prev?.user,
              source: 'inspect-poll',
            };
          });
        }
      } catch {
        /* ignore */
      }
    };
    const id = setInterval(tick, 8000);
    tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [owner, mode, openFlows.length, mmWwartBal]);

  const mmWwartLabel =
    mmWwartBal != null
      ? Number(mmWwartBal).toLocaleString(undefined, {
          maximumFractionDigits: 4,
        })
      : '—';

  const refresh = useCallback(async () => {
    // Prefer rollup inspect
    try {
      const base = getInspectUrl().replace(/\/$/, '');
      const path = owner
        ? `pool/${String(owner).replace(/^0x/i, '').toLowerCase()}`
        : 'pool';
      const res = await fetch(`${base}/${path}`, { cache: 'no-store' });
      const data = await res.json();
      if (data.reports?.length) {
        const json = decodeInspectPayload(data.reports[0].payload);
        if (json && !json.error) {
          const user = json.user || null;
          setSnap({
            poolId: json.poolId,
            poolAddress: json.poolAddress || FUNGIBLE_POOL.address,
            lockedHuman: humanFromE8(json.lockedE8),
            capacityHuman: humanFrom18(json.capacity18),
            claimedHuman: humanFrom18(json.claimed18),
            availableHuman: humanFrom18(json.available18),
            redeemedHuman: humanFromE8(json.redeemedE8),
            freeableHuman: humanFromE8(json.freeableE8),
            holderRedeem: json.holderRedeem !== false,
            redeemPhase: json.redeemPhase || 'A-beta',
            spv: json.spv || null,
            user: user
              ? {
                  depositedHuman: humanFromE8(user.depositedE8),
                  claimHuman: humanFrom18(user.claim18),
                  portableHuman: humanFrom18(user.portable18),
                  redeemedHuman: humanFromE8(user.redeemedE8),
                  freeableHuman: humanFromE8(user.freeableE8),
                }
              : null,
            recentTickets: json.recentTickets || [],
            source: 'rollup',
          });
          return;
        }
      }
    } catch (e) {
      console.warn('[FungiblePool] inspect', e?.message || e);
    }
    // Fallback API public + lab
    try {
      const q = owner ? `?owner=${encodeURIComponent(owner)}` : '';
      const s = await poolApi(`/api/pool${q}`);
      setSnap({
        poolId: s.poolId,
        poolAddress: s.livePool?.address || s.poolAddress || FUNGIBLE_POOL.address,
        lockedHuman: s.lockedHuman,
        capacityHuman: s.capacityHuman,
        claimedHuman: s.claimedHuman,
        availableHuman: s.availableHuman,
        redeemedHuman: s.redeemedHuman,
        user: s.user
          ? {
              depositedHuman: s.user.depositedHuman,
              claimHuman: s.user.claimHuman,
              portableHuman: s.user.portableHuman,
              redeemedHuman: s.user.redeemedHuman,
            }
          : null,
        recentEvents: s.recentEvents,
        source: s.mode || 'api',
      });
    } catch (e) {
      console.warn('[FungiblePool] api', e?.message || e);
    }
  }, [owner]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20000);
    return () => clearInterval(t);
  }, [refresh]);

  const pollConfirm = async (txHash, need = 1) => {
    if (!wartBridgeApi?.getWartTxProof) return null;
    for (let i = 0; i < 40; i++) {
      try {
        const proof = await wartBridgeApi.getWartTxProof(txHash);
        const conf = proof?.transaction?.confirmations ?? proof?.confirmations ?? 0;
        if (Number(conf) >= need) return proof;
      } catch {
        /* retry */
      }
      await sleep(3000);
    }
    // last try
    return wartBridgeApi.getWartTxProof(txHash);
  };

  /** Enqueue server credit + local pending (relayer posts InputBox). */
  const enqueueCredit = async ({
    txHash,
    amountE8,
    fromAddress,
    confirmations,
  }) => {
    upsertPendingDeposit({
      txHash,
      owner,
      amountE8: amountE8 != null ? String(amountE8) : null,
      fromAddress: fromAddress || wartBridgeApi?.address || null,
      poolAddress: poolAddr,
      status: 'credit_requested',
      amountHuman: amountE8 != null ? humanFromE8(amountE8) : null,
    });
    upsertFlow({
      id: String(txHash).toLowerCase(),
      owner,
      depositTxHash: txHash,
      amountE8: amountE8 != null ? String(amountE8) : null,
      amountHuman: amountE8 != null ? humanFromE8(amountE8) : null,
      step: 'credit_pending',
      replaceOpen: true,
    });
    refreshPending();
    refreshFlows();
    const res = await poolApi('/api/pool', {
      method: 'POST',
      body: JSON.stringify({
        action: 'request_credit',
        txHash,
        owner,
        fromAddress: fromAddress || wartBridgeApi?.address || undefined,
        amountE8: amountE8 != null ? String(amountE8) : undefined,
        poolAddress: poolAddr,
        confirmations,
        source: 'fe',
      }),
    });
    return res;
  };

  /**
   * Wait for rollup credit via inspect (relayer or self-submit).
   * Returns true if deposited/locked increased or server marks credited.
   * Extends wait while queue shows conf/LC catch-up / submitted (relayer working).
   */
  const waitForRollupCredit = async ({
    txHash,
    prevDeposited,
    prevLocked,
    timeoutMs = 120000,
  }) => {
    const hardDeadline = Date.now() + Math.max(timeoutMs, 180000);
    let softDeadline = Date.now() + timeoutMs;
    updatePendingStatus(txHash, 'awaiting_rollup');
    advanceFlowForOwner(owner, 'credit_pending', { depositTxHash: txHash });
    refreshPending();
    refreshFlows();
    let lastStatusNote = '';
    while (Date.now() < softDeadline && Date.now() < hardDeadline) {
      try {
        const insp = await fetchPoolInspect(owner);
        if (insp && !insp.error) {
          const locked = BigInt(String(insp.lockedE8 || 0));
          const deposited = BigInt(String(insp.user?.depositedE8 || 0));
          if (deposited > prevDeposited || locked > prevLocked) {
            return { ok: true, source: 'inspect', deposited, locked };
          }
        }
      } catch {
        /* retry */
      }
      try {
        const credits = await poolApi(
          `/api/pool?credits=1&owner=${encodeURIComponent(owner)}&limit=30`,
        );
        const row = (credits.items || []).find(
          (i) =>
            String(i.txHash || '').toLowerCase() ===
            String(txHash).replace(/^0x/i, '').toLowerCase(),
        );
        if (row?.status === 'credited') {
          return { ok: true, source: 'queue', row };
        }
        if (row?.status === 'rejected' || row?.status === 'failed') {
          const err = new Error(row.error || 'Credit rejected by relayer');
          err.row = row;
          throw err;
        }
        // Surface relayer progress so UI does not look hung
        const note =
          row?.error ||
          row?.note ||
          (row?.status === 'submitted'
            ? 'L1 input in; waiting rollup notice…'
            : row?.status === 'pending'
              ? 'queued for relayer…'
              : row?.status === 'processing'
                ? 'relayer processing (SPV / LC catch-up)…'
                : '');
        if (note && note !== lastStatusNote) {
          lastStatusNote = note;
          toast.loading(`Pool credit: ${note}`, { id: 'pool' });
        }
        // Relayer still working — give more time (up to hardDeadline)
        if (
          row &&
          ['pending', 'processing', 'submitted'].includes(row.status) &&
          softDeadline < hardDeadline
        ) {
          softDeadline = Math.min(Date.now() + 45000, hardDeadline);
        }
      } catch (e) {
        if (e?.row) throw e;
      }
      await sleep(2500);
    }
    return { ok: false };
  };

  /** Ensure MetaMask is on Anvil (31337) before optional wallet credit. */
  const ensureAnvilForOptionalCredit = async () => {
    if (typeof window === 'undefined' || !window.ethereum) {
      throw new Error(
        'No browser wallet for optional credit. Wait for the relayer, or connect MetaMask on Anvil (chainId 31337).',
      );
    }
    let chainId;
    try {
      chainId = await window.ethereum.request({ method: 'eth_chainId' });
    } catch (e) {
      throw new Error(
        `Wallet RPC failed (cannot reach chain): ${e?.message || e}. Check MetaMask → Anvil ${typeof window !== 'undefined' ? window.location?.host || '' : ''} RPC.`,
      );
    }
    const n = Number.parseInt(String(chainId), 16);
    if (n !== 31337) {
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0x7a69' }],
        });
      } catch (e) {
        throw new Error(
          `Switch MetaMask to Cartesi Bridge Anvil (chainId 31337 / 0x7a69). Currently ${chainId}. ${e?.message || ''}`,
        );
      }
    }
    // Probe Anvil via wallet
    try {
      const id = await window.ethereum.request({ method: 'eth_chainId' });
      if (Number.parseInt(String(id), 16) !== 31337) {
        throw new Error(`still on chainId ${id}`);
      }
    } catch (e) {
      throw new Error(
        `Anvil not reachable via wallet: ${e?.message || e}. RPC should be https://cartesi-bridge.duckdns.org/rpc`,
      );
    }
  };

  /**
   * Credit only (no Warthog send) — resume stranded deposits.
   * Prefer relayer; optional MetaMask self-submit as fallback.
   */
  const creditExistingTx = async (txHashRaw, { allowSelfSubmit = true } = {}) => {
    if (!owner) throw new Error('Connect L1 wallet');
    const txHash = String(txHashRaw || '')
      .replace(/^0x/i, '')
      .trim();
    if (!txHash || txHash.length < 16) throw new Error('Enter Warthog deposit tx hash');

    const poolNorm = String(poolAddr || '')
      .replace(/^0x/i, '')
      .toLowerCase();

    let prevDeposited = 0n;
    let prevLocked = 0n;
    try {
      const before = await fetchPoolInspect(owner);
      if (before && !before.error) {
        prevLocked = BigInt(String(before.lockedE8 || 0));
        prevDeposited = BigInt(String(before.user?.depositedE8 || 0));
      }
    } catch {
      /* */
    }

    toast.loading('Verifying Warthog deposit…', { id: 'pool' });
    let proof = await pollConfirm(txHash, 1);
    if (!proof && wartBridgeApi?.getWartTxProof) {
      proof = await wartBridgeApi.getWartTxProof(txHash);
    }
    // Server-side lookup as backup
    let slim = proof ? slimDepositProof(proof) : null;
    let amtE8 = Number(slim?.transaction?.amountE8 || 0);
    let toNorm = String(slim?.transaction?.toAddress || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    let fromAddr = slim?.transaction?.fromAddress || null;

    if (!amtE8 || !toNorm) {
      const looked = await poolApi(
        `/api/pool?lookup=${encodeURIComponent(txHash)}&pool=${encodeURIComponent(poolNorm)}`,
      );
      if (looked.verified && looked.tx) {
        amtE8 = Number(looked.tx.amountE8 || 0);
        toNorm = String(looked.tx.toAddress || '')
          .replace(/^0x/i, '')
          .toLowerCase();
        fromAddr = looked.tx.fromAddress;
        slim = {
          transaction: {
            txHash: looked.tx.txHash,
            fromAddress: looked.tx.fromAddress,
            toAddress: looked.tx.toAddress,
            amountE8: looked.tx.amountE8,
            blockHeight: looked.tx.blockHeight,
            confirmations: looked.tx.confirmations,
          },
          confirmations: looked.tx.confirmations,
          mined: looked.tx.mined,
        };
      }
    }

    if (!toNorm || amtE8 <= 0) {
      throw new Error(
        'Could not load deposit proof yet. Wait for confirmations, then Resume again — WART is not re-sent.',
      );
    }
    if (toNorm !== poolNorm) {
      throw new Error(
        `Tx to=${toNorm.slice(0, 12)}… is not the pool (${poolNorm.slice(0, 12)}…).`,
      );
    }

    toast.loading('Queueing credit (relayer, no MetaMask)…', { id: 'pool' });
    await enqueueCredit({
      txHash,
      amountE8: amtE8,
      fromAddress: fromAddr,
      confirmations: slim?.confirmations || slim?.transaction?.confirmations,
    });

    toast.loading('Waiting for pool credit…', { id: 'pool' });
    let result = await waitForRollupCredit({
      txHash,
      prevDeposited,
      prevLocked,
      timeoutMs: 90000,
    });

    // Optional self-submit if relayer lagging and send() available
    if (!result.ok && allowSelfSubmit && send && slim) {
      toast.loading('Relayer slow — checking Anvil + optional wallet credit…', {
        id: 'pool',
      });
      try {
        await ensureAnvilForOptionalCredit();
        toast.loading('Confirm pool_deposit in MetaMask (Anvil)…', { id: 'pool' });
        const seen = await snapshotNoticePayloads();
        await send({
          type: 'pool_deposit',
          owner,
          depositProof: slim,
        });
        void waitForNotice('pool_deposit', {
          timeoutMs: 20000,
          rejectType: 'pool_deposit_rejected',
          matchTxHash: txHash,
          matchOwner: owner,
          seenPayloads: seen,
        }).catch(() => null);
        result = await waitForRollupCredit({
          txHash,
          prevDeposited,
          prevLocked,
          timeoutMs: 45000,
        });
      } catch (e) {
        updatePendingStatus(txHash, 'stranded', {
          error: e?.message || String(e),
        });
        refreshPending();
        // Prefer clear Anvil/wallet error over generic timeout
        throw new Error(
          `Optional wallet credit failed: ${e?.message || e}. ` +
            'WART is still on the pool — use Resume (relayer will retry). Do not Deposit again.',
        );
      }
    }

    if (!result.ok) {
      updatePendingStatus(txHash, 'stranded', {
        error: 'rollup credit timeout — use Resume (no re-send)',
      });
      refreshPending();
      throw new Error(
        `WART is on the pool but rollup credit is pending. Use Resume with tx ${txHash.slice(0, 12)}… — do not Deposit again.`,
      );
    }

    updatePendingStatus(txHash, 'credited');
    removePendingDeposit(txHash);
    advanceFlowForOwner(owner, 'credited', {
      depositTxHash: txHash,
      amountE8: String(amtE8),
    });
    refreshPending();
    refreshFlows();
    toast.success(
      `Credited ${humanFromE8(amtE8)} WART to pool`,
      { id: 'pool' },
    );
  };

  /**
   * 1-button live deposit: send WART once → relayer credits rollup.
   * Never re-sends WART on credit failure — surfaces Resume instead.
   */
  const liveDeposit = async () => {
    if (!owner) throw new Error('Connect L1 wallet');
    if (!wartBridgeApi?.sendTransaction || !wartBridgeApi?.getWartTxProof) {
      throw new Error('Unlock Warthog wallet first (needed to send real WART)');
    }
    const amt = String(amount || '').trim();
    if (!amt) throw new Error('Enter amount');
    const poolNorm = String(poolAddr || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    if (!poolNorm || poolNorm.length < 40) {
      throw new Error('Pool address missing — refresh and try again');
    }

    let prevDeposited = 0n;
    let prevLocked = 0n;
    try {
      const before = await fetchPoolInspect(owner);
      if (before && !before.error) {
        prevLocked = BigInt(String(before.lockedE8 || 0));
        prevDeposited = BigInt(String(before.user?.depositedE8 || 0));
      }
    } catch {
      /* first deposit / inspect lag */
    }

    toast.loading(`Sending ${amt} WART → pool…`, { id: 'pool' });
    const txData = await wartBridgeApi.sendTransaction(
      undefined,
      undefined,
      poolAddr,
      amt,
      '',
    );
    const txHash =
      txData?.data?.txHash ||
      txData?.txHash ||
      txData?.hash ||
      txData?.data?.hash;
    if (!txHash) throw new Error('No Warthog tx hash from send');

    upsertPendingDeposit({
      txHash,
      owner,
      poolAddress: poolAddr,
      status: 'awaiting_confirm',
      amountHuman: amt,
      fromAddress: wartBridgeApi?.address || null,
    });
    upsertFlow({
      id: String(txHash).toLowerCase(),
      owner,
      depositTxHash: txHash,
      amountHuman: amt,
      step: 'deposit_pending',
      note: 'Warthog mempool / confirming',
      replaceOpen: true,
    });
    refreshPending();
    refreshFlows();

    toast.loading('Waiting for Warthog confirmations…', { id: 'pool' });
    let proof = await pollConfirm(txHash, 1);
    if (!proof) {
      updatePendingStatus(txHash, 'stranded', {
        error: 'proof incomplete — Resume when confirmed',
      });
      refreshPending();
      throw new Error(
        `Warthog tx ${String(txHash).slice(0, 12)}… sent but proof not ready. ` +
          'Do not Deposit again — use Resume credit with this tx hash.',
      );
    }
    const slim = slimDepositProof(proof);
    const toNorm = String(slim.transaction?.toAddress || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    const amtE8 = Number(slim.transaction?.amountE8 || 0);
    if (!toNorm || amtE8 <= 0) {
      updatePendingStatus(txHash, 'stranded', { error: 'incomplete proof' });
      refreshPending();
      throw new Error(
        'Deposit proof incomplete. WART may already be on the pool — use Resume (no re-send).',
      );
    }
    if (toNorm !== poolNorm) {
      updatePendingStatus(txHash, 'failed_send', { error: 'wrong destination' });
      refreshPending();
      throw new Error(
        `Proof to=${toNorm.slice(0, 12)}… is not the pool (${poolNorm.slice(0, 12)}…).`,
      );
    }

    toast.loading('Queueing automatic credit (no MetaMask)…', { id: 'pool' });
    await enqueueCredit({
      txHash,
      amountE8: amtE8,
      fromAddress: slim.transaction?.fromAddress || wartBridgeApi?.address,
      confirmations: slim.confirmations || slim.transaction?.confirmations,
    });

    toast.loading('Waiting for pool credit…', { id: 'pool' });
    const result = await waitForRollupCredit({
      txHash,
      prevDeposited,
      prevLocked,
      timeoutMs: 120000,
    });

    if (!result.ok) {
      // One optional self-submit attempt, then stranded with resume
      let optionalErr = null;
      if (send) {
        try {
          toast.loading('Relayer slow — checking Anvil + optional wallet…', {
            id: 'pool',
          });
          await ensureAnvilForOptionalCredit();
          toast.loading('Confirm pool_deposit in MetaMask (Anvil)…', {
            id: 'pool',
          });
          const seen = await snapshotNoticePayloads();
          await send({
            type: 'pool_deposit',
            owner,
            depositProof: slim,
          });
          void waitForNotice('pool_deposit', {
            timeoutMs: 20000,
            rejectType: 'pool_deposit_rejected',
            matchTxHash: txHash,
            matchOwner: owner,
            seenPayloads: seen,
          }).catch(() => null);
          const again = await waitForRollupCredit({
            txHash,
            prevDeposited,
            prevLocked,
            timeoutMs: 45000,
          });
          if (again.ok) {
            updatePendingStatus(txHash, 'credited');
            removePendingDeposit(txHash);
            advanceFlowForOwner(owner, 'credited', {
              depositTxHash: txHash,
              amountE8: String(amtE8),
              amountHuman: humanFromE8(amtE8),
            });
            refreshPending();
            refreshFlows();
            toast.success(`Deposited ${humanFromE8(amtE8)} WART to pool`, {
              id: 'pool',
            });
            return;
          }
        } catch (e) {
          optionalErr = e?.message || String(e);
        }
      }
      updatePendingStatus(txHash, 'stranded', {
        amountE8: String(amtE8),
        error: optionalErr || 'awaiting rollup credit',
      });
      refreshPending();
      throw new Error(
        `Sent ${humanFromE8(amtE8)} WART (tx ${String(txHash).slice(0, 12)}…) but credit is still pending` +
          (optionalErr ? ` (wallet: ${optionalErr})` : '') +
          '. Use Resume credit below — do not press Deposit again. Relayer will retry after SPV LC catch-up.',
      );
    }

    updatePendingStatus(txHash, 'credited');
    removePendingDeposit(txHash);
    advanceFlowForOwner(owner, 'credited', {
      depositTxHash: txHash,
      amountE8: String(amtE8),
      amountHuman: humanFromE8(amtE8),
    });
    refreshPending();
    refreshFlows();
    toast.success(`Deposited ${humanFromE8(amtE8)} WART to pool`, { id: 'pool' });
  };

  const liveMint = async () => {
    if (!send) throw new Error('Rollup send unavailable');
    const amt = String(amount || '').trim();
    if (!amt) throw new Error('Enter amount');
    if (!wwartToken) throw new Error('wWART token not configured');

    const before = (await fetchPoolInspect(owner).catch(() => null)) || {};
    const prevClaim = userBn(before, 'claim18');
    const prevPortable = userBn(before, 'portable18');
    const seen = await snapshotNoticePayloads();

    toast.loading('Confirm mint in wallet…', { id: 'pool' });
    await send({
      type: 'pool_mint_wwart',
      amount: amt,
      tokenAddress: wwartToken,
    });
    toast.loading('Confirming mint on rollup…', { id: 'pool' });

    // Inspect is source of truth (notices are best-effort)
    void waitForNotice('pool_wwart_minted', {
      timeoutMs: 25000,
      matchOwner: owner,
      seenPayloads: seen,
    }).catch(() => null);

    const after = await waitForPoolState(
      owner,
      (s) =>
        userBn(s, 'claim18') > prevClaim || userBn(s, 'portable18') > prevPortable,
      { timeoutMs: 45000 },
    );
    if (
      after &&
      (userBn(after, 'claim18') > prevClaim ||
        userBn(after, 'portable18') > prevPortable)
    ) {
      advanceFlowForOwner(owner, 'minted', { amountHuman: amt });
      refreshFlows();
      toast.success(`Minted pool claim ${amt}`, { id: 'pool' });
      return;
    }
    throw new Error(
      'Mint not confirmed on inspect. Refresh — if Your claim increased it worked. RPC: https://cartesi-bridge.duckdns.org/rpc',
    );
  };

  const liveWithdraw = async () => {
    if (!send) throw new Error('Rollup send unavailable');
    const amt = String(amount || '').trim();
    if (!amt) throw new Error('Enter amount');

    const before = (await fetchPoolInspect(owner).catch(() => null)) || {};
    const prevPortable = userBn(before, 'portable18');
    const prevVouchers = await countOwnerVouchers(owner);
    const seen = await snapshotNoticePayloads();

    toast.loading('Confirm withdraw in wallet…', { id: 'pool' });
    await send({ type: 'pool_withdraw_wwart', amount: amt });
    toast.loading('Confirming voucher on rollup…', { id: 'pool' });

    void waitForNotice('pool_wwart_withdrawn', {
      timeoutMs: 25000,
      matchOwner: owner,
      seenPayloads: seen,
    }).catch(() => null);

    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      try {
        const s = await fetchPoolInspect(owner);
        const portable = userBn(s, 'portable18');
        if (prevPortable > 0n && portable < prevPortable) {
          advanceFlowForOwner(owner, 'voucher_ready', { amountHuman: amt });
          refreshFlows();
          toast.success(
            `Voucher ready for ${amt} wWART — open Vouchers → Execute`,
            { id: 'pool', duration: 9000 },
          );
          return;
        }
        const vc = await countOwnerVouchers(owner);
        if (vc >= 0 && prevVouchers >= 0 && vc > prevVouchers) {
          advanceFlowForOwner(owner, 'voucher_ready', { amountHuman: amt });
          refreshFlows();
          toast.success(`Voucher ready — open Vouchers → Execute`, {
            id: 'pool',
            duration: 9000,
          });
          return;
        }
      } catch {
        /* */
      }
      await sleep(1500);
    }
    const vc = await countOwnerVouchers(owner);
    if (vc > 0) {
      advanceFlowForOwner(owner, 'voucher_ready');
      refreshFlows();
      toast.success('Open Vouchers and Execute (may already be listed)', {
        id: 'pool',
        duration: 10000,
      });
      return;
    }
    throw new Error(
      'Withdraw not confirmed. Open Vouchers tab and refresh. RPC: https://cartesi-bridge.duckdns.org/rpc',
    );
  };

  /** Hot-wallet payout after pool_release_ticket (redeem or burn auto-unlock). */
  const payoutTicket = async (ticket, fallbackTo, amtLabel) => {
    if (!ticket?.ticketId) throw new Error('Missing release ticket id');
    setLastTicket(ticket);
    const to = ticket.toAddress || fallbackTo || '';
    toast.loading(`Payout ticket ${ticket.ticketId}…`, { id: 'pool' });
    const pay = await poolApi('/api/pool', {
      method: 'POST',
      body: JSON.stringify({
        action: 'payout',
        ticketId: ticket.ticketId,
        toAddress: to,
        amountE8: ticket.amountE8,
        owner,
      }),
    });
    toast.success(
      pay.alreadyPaid
        ? `Already paid ${pay.amountHuman || amtLabel || ''} WART`
        : `Paid ${pay.amountHuman || amtLabel || ''} WART · tx ${String(pay.txHash || '').slice(0, 12)}…`,
      { id: 'pool', duration: 10000 },
    );
    return pay;
  };

  /**
   * Burn pool claim (A-α minter) or A-β holder redeem.
   * Filled claims / bearer wWART need portal inventory first.
   * Success = personal claim drops OR global claimed/locked drops (holder).
   * Then hot-wallet payout if release ticket found.
   */
  const liveBurn = async () => {
    if (!send) throw new Error('Rollup send unavailable');
    const amt = String(amount || '').trim();
    if (!amt) throw new Error('Enter amount');
    const to =
      String(toAddress || '').trim() ||
      wartBridgeApi?.address ||
      '';

    const before = (await fetchPoolInspect(owner).catch(() => null)) || {};
    const prevClaim = userBn(before, 'claim18');
    const prevDeposited = userBn(before, 'depositedE8');
    const prevLocked = poolBn(before, 'lockedE8');
    const prevGlobalClaim = poolBn(before, 'claimed18');
    const seen = await snapshotNoticePayloads();

    toast.loading(
      to
        ? 'Confirm burn / holder redeem in wallet…'
        : 'Confirm burn in wallet…',
      { id: 'pool' },
    );
    await send({
      type: 'pool_burn_wwart',
      amount: amt,
      ...(to ? { toAddress: to, autoUnlock: true } : { autoUnlock: true }),
    });
    toast.loading('Confirming burn on rollup…', { id: 'pool' });

    // Collect ticket/reject from notices without blocking success on them
    const noticeP = waitForNotice(['pool_wwart_burned', 'pool_release_ticket'], {
      timeoutMs: 30000,
      rejectType: 'pool_wwart_burn_rejected',
      matchOwner: owner,
      seenPayloads: seen,
    }).catch((e) => {
      if (e?.notice || String(e?.message || '').startsWith('Rollup rejected')) throw e;
      return null;
    });

    const after = await waitForPoolState(
      owner,
      (s) =>
        userBn(s, 'claim18') < prevClaim ||
        userBn(s, 'depositedE8') < prevDeposited ||
        poolBn(s, 'lockedE8') < prevLocked ||
        poolBn(s, 'claimed18') < prevGlobalClaim ||
        userBn(s, 'redeemedE8') > userBn(before, 'redeemedE8'),
      { timeoutMs: 45000 },
    );

    const burned =
      after &&
      (userBn(after, 'claim18') < prevClaim ||
        userBn(after, 'depositedE8') < prevDeposited ||
        poolBn(after, 'lockedE8') < prevLocked ||
        poolBn(after, 'claimed18') < prevGlobalClaim ||
        userBn(after, 'redeemedE8') > userBn(before, 'redeemedE8'));
    if (!burned) {
      // Maybe reject notice
      await noticeP.catch(() => null);
      throw new Error(
        'Burn not confirmed. Deposit MetaMask wWART via portal first (Path A), then Burn. Holders: open pool claims must exist to redeem against. Refresh inspect.',
      );
    }

    let ticket = null;
    try {
      const n = await Promise.race([
        noticeP,
        sleep(3000).then(() => null),
      ]);
      if (n?.unlockTicketId || n?.ticketId) {
        ticket = {
          ticketId: n.unlockTicketId || n.ticketId,
          amountE8: n.unlockAmountE8 || n.amountE8,
          toAddress: n.toAddress || to || null,
          owner,
        };
      } else if (n?.type === 'pool_release_ticket' && n.ticketId) {
        ticket = {
          ticketId: n.ticketId,
          amountE8: n.amountE8,
          toAddress: n.toAddress || to || null,
          owner,
        };
      }
    } catch (e) {
      if (String(e?.message || '').startsWith('Rollup rejected')) throw e;
    }

    // Pull latest release ticket notice if not yet
    if (!ticket?.ticketId) {
      try {
        const t = await waitForNotice('pool_release_ticket', {
          timeoutMs: 8000,
          matchOwner: owner,
          seenPayloads: seen,
        });
        if (t?.ticketId) {
          ticket = {
            ticketId: t.ticketId,
            amountE8: t.amountE8,
            toAddress: t.toAddress || to || null,
            owner,
          };
        }
      } catch {
        /* no ticket */
      }
    }

    advanceFlowForOwner(owner, 'burned', {
      amountHuman: amt,
      ticketId: ticket?.ticketId || null,
    });
    refreshFlows();

    if (ticket?.ticketId && to) {
      advanceFlowForOwner(owner, 'payout_pending', { ticketId: ticket.ticketId });
      refreshFlows();
      await payoutTicket(ticket, to, humanFromE8(ticket.amountE8) || amt);
      advanceFlowForOwner(owner, 'complete', {
        ticketId: ticket.ticketId,
        note: 'WART payout submitted',
      });
      // Mark complete
      listOpenFlows(owner).forEach((f) => {
        if (f.step === 'complete' || f.ticketId === ticket.ticketId) {
          completeFlow(f.id, { payoutTxHash: null });
        }
      });
      refreshFlows();
      return;
    }
    if (ticket?.ticketId) {
      setLastTicket(ticket);
      advanceFlowForOwner(owner, 'payout_pending', { ticketId: ticket.ticketId });
      refreshFlows();
      toast.success(
        `Burned ${amt} — ticket ${ticket.ticketId}. Unlock Warthog / set redeem-to, then Redeem to payout`,
        { id: 'pool', duration: 10000 },
      );
      return;
    }
    toast.success(
      `Burned ${amt}. If WART still locked, Redeem freeable or check payout logs.`,
      { id: 'pool', duration: 8000 },
    );
  };

  /**
   * Redeem WART (portable claim or freeable deposit) → release ticket → payout.
   */
  const liveRedeem = async () => {
    if (!send) throw new Error('Rollup send unavailable');
    const amt = String(amount || '').trim();
    if (!amt) throw new Error('Enter amount');
    const to =
      String(toAddress || '').trim() ||
      wartBridgeApi?.address ||
      '';
    if (!to) throw new Error('Set redeem-to Warthog address (or unlock Warthog)');

    const before = (await fetchPoolInspect(owner).catch(() => null)) || {};
    const prevDeposited = userBn(before, 'depositedE8');
    const prevPortable = userBn(before, 'portable18');
    const prevRedeemed = userBn(before, 'redeemedE8');
    const seen = await snapshotNoticePayloads();

    toast.loading('Confirm redeem in wallet…', { id: 'pool' });
    await send({
      type: 'pool_redeem',
      amount: amt,
      toAddress: to,
    });
    toast.loading('Confirming redeem on rollup…', { id: 'pool' });

    const ticketP = waitForNotice('pool_release_ticket', {
      timeoutMs: 30000,
      rejectType: ['pool_redeem_rejected', 'pool_unlock_rejected'],
      matchOwner: owner,
      seenPayloads: seen,
    }).catch((e) => {
      if (e?.notice || String(e?.message || '').startsWith('Rollup rejected')) throw e;
      return null;
    });

    const after = await waitForPoolState(
      owner,
      (s) =>
        userBn(s, 'depositedE8') < prevDeposited ||
        userBn(s, 'portable18') < prevPortable ||
        userBn(s, 'redeemedE8') > prevRedeemed,
      { timeoutMs: 45000 },
    );
    const ok =
      after &&
      (userBn(after, 'depositedE8') < prevDeposited ||
        userBn(after, 'portable18') < prevPortable ||
        userBn(after, 'redeemedE8') > prevRedeemed);
    if (!ok) {
      await ticketP.catch(() => null);
      throw new Error(
        'Redeem not confirmed. Need portable claim or freeable deposit. Check Your freeable / claim rows.',
      );
    }

    let ticket = null;
    try {
      ticket = await Promise.race([ticketP, sleep(5000).then(() => null)]);
    } catch (e) {
      if (String(e?.message || '').startsWith('Rollup rejected')) throw e;
    }
    if (ticket?.ticketId) {
      advanceFlowForOwner(owner, 'payout_pending', { ticketId: ticket.ticketId });
      refreshFlows();
      await payoutTicket(ticket, to, amt);
      listOpenFlows(owner).forEach((f) => completeFlow(f.id, { ticketId: ticket.ticketId }));
      refreshFlows();
      return;
    }
    advanceFlowForOwner(owner, 'burned');
    refreshFlows();
    // Inspect-confirmed but no ticket in GraphQL — still success for rollup accounting
    toast.success(
      `Redeem confirmed on rollup. If WART did not arrive, check pool payout / ticket logs.`,
      { id: 'pool', duration: 10000 },
    );
  };

  const labAction = async (action) => {
    if (!labUiEnabled) {
      throw new Error('Lab mode disabled on public demo');
    }
    if (!owner) throw new Error('Connect L1');
    const amt = String(amount || '').trim();
    const body = { action, owner, amount: amt };
    if (action === 'redeem' && toAddress.trim()) body.toAddress = toAddress.trim();
    // Ops may paste token in sessionStorage for lab work
    let opsToken = null;
    try {
      opsToken = sessionStorage.getItem('poolOpsToken');
    } catch {
      /* */
    }
    const s = await poolApi('/api/pool', {
      method: 'POST',
      headers: opsToken ? { 'X-Pool-Ops-Token': opsToken } : {},
      body: JSON.stringify(body),
    });
    if (s.lastTicket) setLastTicket(s.lastTicket);
    toast.success(`Lab ${action} ok`, { id: 'pool' });
  };

  const run = async (action) => {
    setBusy(true);
    try {
      if (mode === 'lab') {
        await labAction(action);
      } else if (action === 'deposit') await liveDeposit();
      else if (action === 'credit_resume') {
        const h = String(resumeTxHash || '').trim();
        if (!h) throw new Error('Paste Warthog tx hash to resume credit');
        await creditExistingTx(h);
      } else if (action === 'mint') await liveMint();
      else if (action === 'withdraw') await liveWithdraw();
      else if (action === 'burn') await liveBurn();
      else if (action === 'redeem') await liveRedeem();
      await refresh();
      onRefreshL1Vault?.();
      onRefreshMmWwart?.();
      refreshPending();
    } catch (e) {
      toast.error(e?.message || String(e), { id: 'pool', duration: 12000 });
      refreshPending();
    } finally {
      setBusy(false);
    }
  };

  const resumePendingRow = async (txHash) => {
    setResumeTxHash(txHash);
    setBusy(true);
    try {
      await creditExistingTx(txHash);
      await refresh();
      onRefreshL1Vault?.();
      refreshPending();
    } catch (e) {
      toast.error(e?.message || String(e), { id: 'pool', duration: 12000 });
      refreshPending();
    } finally {
      setBusy(false);
    }
  };

  const u = snap?.user;

  return (
    <section
      className="wi-panel fungible-pool"
      style={{
        marginBottom: '1rem',
        border: '1px solid rgba(0, 255, 204, 0.35)',
        background:
          'linear-gradient(165deg, rgba(0,40,36,0.55) 0%, rgba(0,0,0,0.35) 100%)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.5rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
          <Droplets size={18} color="#00ffcc" aria-hidden />
          <h3 style={{ margin: 0, fontSize: '1rem', color: '#e8fff9' }}>
            Fungible pool
          </h3>
          <span
            style={{
              fontSize: '0.68rem',
              padding: '0.12rem 0.4rem',
              borderRadius: 6,
              background: 'rgba(0,255,204,0.15)',
              color: '#00ffcc',
              fontWeight: 700,
            }}
          >
            Path A · real WART
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
          {labUiEnabled ? (
            <select
              className="input"
              style={{ fontSize: '0.75rem', padding: '0.2rem 0.35rem' }}
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              disabled={busy}
              title="Live = rollup + real WART; Lab = local ledger only (ops)"
            >
              <option value="live">Live</option>
              <option value="lab">Lab only</option>
            </select>
          ) : null}
          <button
            type="button"
            className="btn secondary small"
            disabled={busy}
            onClick={() =>
              Promise.all([refresh(), Promise.resolve(onRefreshMmWwart?.())]).then(() =>
                toast.success('Pool refreshed'),
              )
            }
          >
            <RefreshCw size={14} style={{ verticalAlign: -2 }} />
          </button>
          <button
            type="button"
            className="btn secondary small"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide' : 'Show'}
          </button>
        </div>
      </header>

      <p
        className="wi-muted"
        style={{ margin: '0.45rem 0 0.65rem', fontSize: '0.8rem', lineHeight: 1.45 }}
      >
        <strong>Live:</strong> <strong>Deposit WART</strong> is one button (send → SPV
        credit via relayer). If credit never lands, <strong>Resume credit</strong> with the
        Warthog tx hash — never re-send. Then Mint → Withdraw wWART or{' '}
        <strong>Redeem WART</strong>.{' '}
        <strong>A-β holder redeem:</strong> any holder with portal pool-wWART can burn;
        payout comes from <em>shared pool collateral</em> (FIFO across depositors — not only
        your own deposit). <strong>No cosigner / personal vaults</strong>.
      </p>
      {snap?.redeemPhase === 'A-beta' || snap?.holderRedeem ? (
        <p
          style={{
            margin: '0 0 0.65rem',
            fontSize: '0.75rem',
            lineHeight: 1.4,
            color: '#f0c674',
            padding: '0.4rem 0.55rem',
            borderRadius: 6,
            background: 'rgba(240,198,116,0.1)',
            border: '1px solid rgba(240,198,116,0.35)',
          }}
        >
          Holder redeem spends pool-wide locked WART. Buying wWART and redeeming can debit
          another depositor’s share if your own deposit is insufficient.
        </p>
      ) : null}

      {open && (
        <>
          <div
            className="wi-stat-grid wi-stat-grid--focus"
            style={{ marginBottom: '0.75rem' }}
          >
            <div className="wi-stat wi-stat--liquid">
              <Layers size={16} className="wi-stat-icon" />
              <span className="wi-stat-k">Pool available</span>
              <span className="wi-stat-v">{snap?.availableHuman ?? '…'}</span>
              <span className="wi-stat-hint">mint headroom</span>
            </div>
            <div className="wi-stat">
              <span className="wi-stat-k">Locked</span>
              <span className="wi-stat-v">{snap?.lockedHuman ?? '…'}</span>
              <span className="wi-stat-hint">WART in pool</span>
            </div>
            <div className="wi-stat">
              <span className="wi-stat-k">Used</span>
              <span className="wi-stat-v">{snap?.claimedHuman ?? '…'}</span>
              <span className="wi-stat-hint">open claims</span>
            </div>
            <div className="wi-stat wi-stat--spoof">
              <span className="wi-stat-k">MetaMask wWART</span>
              <span className="wi-stat-v">{mmWwartLabel}</span>
              <span className="wi-stat-hint">L1 ERC-20 (after voucher)</span>
            </div>
          </div>

          <div
            className="sw-card-meta"
            style={{ marginBottom: '0.65rem', fontSize: '0.78rem' }}
          >
            <div className="sw-meta-row">
              <span className="sw-meta-k">Pool address</span>
              <span
                className="sw-meta-v"
                style={{
                  fontFamily: 'monospace',
                  fontSize: '0.7rem',
                  wordBreak: 'break-all',
                }}
                title={poolAddr}
              >
                {poolAddr}
              </span>
            </div>
            <div className="sw-meta-row">
              <span className="sw-meta-k">Data</span>
              <span className="sw-meta-v">{snap?.source || '—'}</span>
            </div>
            {spv && (
              <>
                <div className="sw-meta-row">
                  <span className="sw-meta-k">SPV</span>
                  <span className="sw-meta-v" style={{ color: spv.bootstrapped ? '#7dffa3' : '#f0c674' }}>
                    {spv.bootstrapped ? 'bootstrapped' : 'not ready'}
                    {spv.requireSpv ? ' · SPV-only' : ' · legacy allowed'}
                    {spv.minConfirmations != null
                      ? ` · conf≥${spv.minConfirmations}`
                      : ''}
                  </span>
                </div>
                <div className="sw-meta-row">
                  <span className="sw-meta-k">LC tip</span>
                  <span
                    className="sw-meta-v"
                    style={{ fontFamily: 'monospace', fontSize: '0.7rem' }}
                    title={spv.bestHash || ''}
                  >
                    h={spv.bestHeight ?? '—'} · headers={spv.headersStored ?? '—'}
                  </span>
                </div>
              </>
            )}
            {u && (
              <>
                <div className="sw-meta-row">
                  <span className="sw-meta-k">Your deposit</span>
                  <span className="sw-meta-v">{u.depositedHuman} WART</span>
                </div>
                <div className="sw-meta-row">
                  <span className="sw-meta-k">Your freeable</span>
                  <span className="sw-meta-v" title="Deposit not backing open claims — Redeem pays this">
                    {u.freeableHuman ?? '0'} WART
                  </span>
                </div>
                <div className="sw-meta-row">
                  <span className="sw-meta-k">Your claim / portable</span>
                  <span className="sw-meta-v">
                    {u.claimHuman} / {u.portableHuman}
                  </span>
                </div>
              </>
            )}
          </div>

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.4rem',
              alignItems: 'center',
              marginBottom: '0.5rem',
            }}
          >
            <input
              type="text"
              inputMode="decimal"
              className="input wi-portal-input"
              style={{ maxWidth: '7rem' }}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount"
              disabled={busy || !owner}
            />
            <button
              type="button"
              className="btn primary small"
              disabled={busy || !owner}
              onClick={() => run('deposit')}
              title="Send WART once; relayer credits rollup automatically"
            >
              Deposit WART
            </button>
            <button
              type="button"
              className="btn secondary small"
              disabled={busy || !owner}
              onClick={() => run('mint')}
            >
              Mint claim
            </button>
            {mode === 'live' && (
              <button
                type="button"
                className="btn secondary small"
                disabled={busy || !owner}
                onClick={() => run('withdraw')}
                title="L1 mint voucher for MetaMask wWART"
              >
                Withdraw wWART
              </button>
            )}
            <button
              type="button"
              className="btn secondary small"
              disabled={busy || !owner}
              onClick={() => run('burn')}
              title="A-α: burn your claim. A-β: any holder with portal wWART burns against the pool peg → WART to redeem-to"
            >
              Burn / holder redeem
            </button>
            <button
              type="button"
              className="btn danger small"
              disabled={busy || !owner}
              onClick={() => run('redeem')}
              title="Portable claim OR freeable deposit → release ticket → hot-wallet WART payout"
            >
              Redeem WART
            </button>
          </div>

          <input
            type="text"
            className="input wi-portal-input"
            style={{ width: '100%', marginBottom: '0.55rem', fontSize: '0.8rem' }}
            value={toAddress}
            onChange={(e) => setToAddress(e.target.value)}
            placeholder={
              wartBridgeApi?.address
                ? `Redeem to (default: your Warthog ${String(wartBridgeApi.address).slice(0, 10)}…)`
                : 'Redeem to Warthog address'
            }
            disabled={busy || !owner}
          />

          {!owner && (
            <p className="wi-muted" style={{ fontSize: '0.78rem' }}>
              Connect L1 wallet so credits attach to your address.
            </p>
          )}
          {owner && mode === 'live' && !wartBridgeApi?.address && (
            <p className="wi-muted" style={{ fontSize: '0.78rem', color: '#f0c674' }}>
              Unlock Warthog below to deposit real WART into the pool.
            </p>
          )}

          {mode === 'live' && owner && openFlows.length > 0 && (
            <div
              style={{
                marginTop: '0.65rem',
                padding: '0.65rem 0.75rem',
                borderRadius: 8,
                border: '1px solid rgba(0, 255, 204, 0.4)',
                background: 'rgba(0, 40, 36, 0.45)',
              }}
            >
              <div
                style={{
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  color: '#00ffcc',
                  marginBottom: '0.35rem',
                }}
              >
                Pending pool cycle
                <span className="wi-muted" style={{ fontWeight: 500, marginLeft: 6 }}>
                  (like mempool — stays until WART is back)
                </span>
              </div>
              {openFlows.map((flow) => {
                const cur = stepMeta(flow.step);
                const prog = flowProgress(flow.step);
                const curIdx = FLOW_STEPS.findIndex((s) => s.id === flow.step);
                return (
                  <div key={flow.id} style={{ marginBottom: '0.65rem' }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: '0.5rem',
                        flexWrap: 'wrap',
                        fontSize: '0.78rem',
                        marginBottom: '0.35rem',
                      }}
                    >
                      <span>
                        <strong>{cur.label}</strong>
                        {flow.amountHuman ? ` · ${flow.amountHuman} WART` : ''}
                        {flow.depositTxHash ? (
                          <span
                            className="wi-muted"
                            title={flow.depositTxHash}
                            style={{ fontFamily: 'monospace', marginLeft: 6 }}
                          >
                            tx {String(flow.depositTxHash).slice(0, 10)}…
                          </span>
                        ) : null}
                      </span>
                      <button
                        type="button"
                        className="btn secondary small"
                        style={{ fontSize: '0.65rem', padding: '0.1rem 0.35rem' }}
                        disabled={busy}
                        onClick={() => {
                          cancelFlow(flow.id);
                          refreshFlows();
                          toast('Dismissed tracker (funds unchanged)');
                        }}
                      >
                        Dismiss
                      </button>
                    </div>
                    <p className="wi-muted" style={{ fontSize: '0.72rem', margin: '0 0 0.4rem' }}>
                      {cur.hint}
                      {flow.note ? ` · ${flow.note}` : ''}
                    </p>
                    <div
                      style={{
                        height: 6,
                        borderRadius: 4,
                        background: 'rgba(255,255,255,0.08)',
                        overflow: 'hidden',
                        marginBottom: '0.45rem',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.round(prog * 100)}%`,
                          background:
                            'linear-gradient(90deg, #00ffcc, #f0c674)',
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '0.25rem',
                        fontSize: '0.62rem',
                      }}
                    >
                      {FLOW_STEPS.filter((s) => s.id !== 'complete').map((s, i) => {
                        const done = curIdx > i || flow.step === 'complete';
                        const active = s.id === flow.step;
                        return (
                          <span
                            key={s.id}
                            title={s.hint}
                            style={{
                              padding: '0.12rem 0.35rem',
                              borderRadius: 4,
                              border: active
                                ? '1px solid #f0c674'
                                : '1px solid transparent',
                              background: done
                                ? 'rgba(0,255,204,0.15)'
                                : active
                                  ? 'rgba(240,198,116,0.2)'
                                  : 'rgba(255,255,255,0.04)',
                              color: done || active ? '#e8fff9' : '#8899aa',
                              fontWeight: active ? 700 : 500,
                            }}
                          >
                            {s.label}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {mode === 'live' && owner && (
            <div
              style={{
                marginTop: '0.65rem',
                padding: '0.55rem 0.65rem',
                borderRadius: 8,
                border: '1px solid rgba(240, 198, 116, 0.35)',
                background: 'rgba(40, 30, 0, 0.35)',
              }}
            >
              <div
                style={{
                  fontSize: '0.78rem',
                  fontWeight: 700,
                  color: '#f0c674',
                  marginBottom: '0.35rem',
                }}
              >
                Resume credit (no re-send)
              </div>
              <p className="wi-muted" style={{ fontSize: '0.72rem', margin: '0 0 0.4rem' }}>
                If Deposit sent WART but the pool balance never moved, paste the Warthog tx
                hash. Relayer credits the rollup; optional wallet only if relayer is down.
                Rows below are browser reminders — if capacity already moved, dismiss them
                (no need to Resume).
              </p>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.35rem',
                  alignItems: 'center',
                }}
              >
                <input
                  type="text"
                  className="input wi-portal-input"
                  style={{ flex: '1 1 12rem', fontSize: '0.75rem', fontFamily: 'monospace' }}
                  value={resumeTxHash}
                  onChange={(e) => setResumeTxHash(e.target.value)}
                  placeholder="Warthog tx hash"
                  disabled={busy}
                />
                <button
                  type="button"
                  className="btn secondary small"
                  disabled={busy || !resumeTxHash.trim()}
                  onClick={() => run('credit_resume')}
                >
                  Resume credit
                </button>
                {pendingList.length > 0 && (
                  <button
                    type="button"
                    className="btn secondary small"
                    disabled={busy}
                    title="Clear local stranded list if credits already landed"
                    onClick={() => {
                      void reconcilePendingWithServer();
                    }}
                  >
                    Refresh / clear credited
                  </button>
                )}
              </div>
              {pendingList.length > 0 && (
                <ul
                  style={{
                    margin: '0.5rem 0 0',
                    padding: 0,
                    listStyle: 'none',
                    fontSize: '0.72rem',
                  }}
                >
                  {pendingList.map((p) => (
                    <li
                      key={p.txHash}
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '0.35rem',
                        alignItems: 'center',
                        marginBottom: '0.3rem',
                        fontFamily: 'monospace',
                      }}
                    >
                      <span title={p.txHash}>
                        {String(p.txHash).slice(0, 12)}… · {p.status}
                        {p.amountHuman ? ` · ${p.amountHuman}` : ''}
                      </span>
                      <button
                        type="button"
                        className="btn secondary small"
                        disabled={busy}
                        style={{ fontSize: '0.68rem', padding: '0.1rem 0.35rem' }}
                        onClick={() => resumePendingRow(p.txHash)}
                      >
                        Resume
                      </button>
                      <button
                        type="button"
                        className="btn secondary small"
                        disabled={busy}
                        style={{ fontSize: '0.68rem', padding: '0.1rem 0.35rem' }}
                        title="Remove this browser reminder (does not move WART)"
                        onClick={() => {
                          removePendingDeposit(p.txHash);
                          refreshPending();
                          toast.success('Dismissed local reminder', {
                            id: 'pool-dismiss',
                            duration: 2500,
                          });
                        }}
                      >
                        Dismiss
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {lastTicket && (
            <p className="wi-muted" style={{ fontSize: '0.75rem' }}>
              Last ticket: <code>{lastTicket.ticketId}</code>
              {lastTicket.amountE8 ? ` · ${humanFromE8(lastTicket.amountE8)} WART` : ''}
            </p>
          )}
        </>
      )}
    </section>
  );
}
