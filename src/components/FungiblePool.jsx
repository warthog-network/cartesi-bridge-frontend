/**
 * Path A — Fungible shared pool (real WART + real wWART mint/burn/redeem).
 * Independent of SubWallet / 2P cosigner personal vaults.
 *
 * Deposit is 1-button (atomic feel): Warthog send → credit queue → relayer
 * posts pool_deposit (no second MetaMask in happy path). Resume via pending
 * store / tx hash if credit never lands. Phase 3 SPV is the trust north star.
 *
 * Optional **Get wWART (1-click)** may resume leftover tracker/claim.
 * **WART → wWART** / **wWART → WART** always move the entered amount
 * (fresh cycle — they do not pick up a hung tracker).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Droplets,
  RefreshCw,
  Layers,
  Zap,
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { ethers } from 'ethers-v6';
import { FUNGIBLE_POOL } from '../utils/fungiblePoolConfig.js';
import { LOCAL_WWART } from '../utils/localTokens.js';
import {
  getInspectUrl,
  getRollupGraphqlUrl,
  getAddresses,
  LOCAL_ADDRESSES,
} from '../utils/bridgeConfig.js';
import { normalizeTxLookup } from '../utils/txProof.js';
import {
  fetchVouchers,
  executeVoucherOnL1,
  wasVoucherExecuted,
  formatVoucherExecuteError,
  isVoucherClaimedOnL1,
} from '../utils/vouchers.js';
import {
  listPendingForOwner,
  upsertPendingDeposit,
  updatePendingStatus,
  removePendingDeposit,
  clearPendingForOwner,
  isOpenPendingStatus,
} from '../utils/poolPendingStore.js';
import {
  FLOW_STEPS,
  listOpenFlows,
  upsertFlow,
  advanceFlowForOwner,
  completeFlow,
  cancelFlow,
  clearOpenFlowsForOwner,
  wipeFlowsForOwner,
  reconcileFlowsFromInspect,
  stepMeta,
  flowProgress,
} from '../utils/poolFlowTracker.js';
import { buildPoolBindMessage } from '../utils/poolBindMessage.js';

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

function humanTo18(human) {
  const s = String(human || '').trim();
  if (!s) return 0n;
  const neg = s.startsWith('-');
  const raw = neg ? s.slice(1) : s;
  const [w, f = ''] = raw.split('.');
  const frac = `${f}000000000000000000`.slice(0, 18);
  const n = BigInt(w || '0') * 10n ** 18n + BigInt(frac || '0');
  return neg ? -n : n;
}

const ERC20_PORTAL_ABI = [
  'function depositERC20Tokens(address _erc20, address _dapp, uint256 _amount, bytes calldata _execLayerData) external',
];
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

/** Portal-deposit MetaMask wWART into Path A (needed before burn → native WART). */
async function portalDepositPoolWwart(signer, amountHuman) {
  const addrs = getAddresses() || LOCAL_ADDRESSES;
  const portalAddr = addrs.erc20Portal || LOCAL_ADDRESSES.erc20Portal;
  const dapp = addrs.dapp || LOCAL_ADDRESSES.dapp;
  const token = LOCAL_WWART?.address;
  if (!signer) throw new Error('Connect MetaMask to portal-deposit wWART');
  if (!portalAddr || !dapp || !token) {
    throw new Error('Portal / dApp / wWART address missing');
  }
  const amt = ethers.parseUnits(String(amountHuman || '').trim() || '0', 18);
  if (amt <= 0n) throw new Error('Amount must be > 0');
  try {
    const net = await signer.provider?.getNetwork?.();
    const chainId = net?.chainId != null ? Number(net.chainId) : null;
    if (chainId != null && chainId !== 31337 && typeof window !== 'undefined' && window.ethereum) {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x7a69' }],
      });
    }
  } catch {
    /* switch is best-effort; deposit will fail clearly if still wrong chain */
  }
  const tokenC = new ethers.Contract(token, ERC20_ABI, signer);
  const portal = new ethers.Contract(portalAddr, ERC20_PORTAL_ABI, signer);
  const from = await signer.getAddress();
  const allowance = await tokenC.allowance(from, portalAddr);
  if (allowance < amt) {
    const txA = await tokenC.approve(portalAddr, amt);
    await txA.wait();
  }
  const tx = await portal.depositERC20Tokens(token, dapp, amt, '0x', {
    gasLimit: 500_000n,
  });
  await tx.wait();
  return tx.hash;
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

/** Host-queue bind lookup. Does not throw on conflict (409). */
async function fetchWartOwnerBind({ fromAddress, owner }) {
  const from = String(fromAddress || '').replace(/^0x/i, '').trim();
  const own = String(owner || '').trim();
  if (!from || !own) return null;
  const url = `/api/pool?bind=1&from=${encodeURIComponent(from)}&owner=${encodeURIComponent(own)}`;
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const data = await res.json().catch(() => ({}));
  return data;
}

/**
 * Bind must exist before send/credit. Mismatch → abort.
 * Unbound → Warthog + MetaMask personal_sign, then persist (no first-writer).
 */
async function ensureWartOwnerBind({
  fromAddress,
  owner,
  signer,
  signWartMessage,
}) {
  const from = String(fromAddress || '').trim();
  const own = String(owner || '').trim();
  if (!from || !own) {
    throw new Error('Unlock Warthog and connect MetaMask before depositing');
  }
  let check;
  try {
    check = await fetchWartOwnerBind({ fromAddress: from, owner: own });
  } catch (e) {
    throw new Error(
      `Could not verify WART↔ETH bind (${e?.message || e}) — not sending WART`,
    );
  }
  if (!check) {
    throw new Error('Could not verify WART↔ETH bind — not sending WART');
  }
  if (check.conflict || check.status === 'mismatch') {
    throw new Error(
      check.error ||
        `This Warthog wallet is already bound to ${check.boundOwner || 'another L1 address'} — switch MetaMask. WART was not sent.`,
    );
  }
  if (check.status === 'match') return check;
  if (!signWartMessage) {
    throw new Error('Unlock Warthog to bind this wallet to MetaMask before sending');
  }
  if (!signer?.signMessage) {
    throw new Error(
      'Connect MetaMask (signer) to bind this Warthog wallet before sending. WART was not sent.',
    );
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const message = buildPoolBindMessage({
    fromAddress: from,
    owner: own,
    issuedAt,
  });
  toast.loading('Sign Warthog bind…', { id: 'pool' });
  const wartSig = await signWartMessage(message);
  toast.loading('Sign MetaMask bind…', { id: 'pool' });
  const ownerSig = await signer.signMessage(message);
  return poolApi('/api/pool', {
    method: 'POST',
    body: JSON.stringify({
      action: 'register_bind',
      fromAddress: from,
      owner: own,
      issuedAt,
      wartSig,
      ownerSig,
    }),
  });
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
  // getWartTxProof may already return normalizeTxLookup(); also accept raw lookup.
  const normalized = normalizeTxLookup(proof) || proof || {};
  const tx = normalized.transaction || {};
  const nested = tx.data || {};
  const common = tx.signedCommon || tx.signingData || {};
  const amountObj = nested.amount || {};
  // v0.10+ uses amount.E8; never drop deposits because of shape drift
  const amountE8 = Number(
    tx.amountE8 ??
      amountObj.E8 ??
      amountObj.u64 ??
      nested.amountE8 ??
      0,
  );
  const toAddress =
    tx.toAddress || nested.toAddress || null;
  const fromAddress =
    tx.fromAddress ||
    common.originAddress ||
    nested.fromAddress ||
    null;
  const txHash = tx.txHash || tx.hash || null;
  return {
    transaction: {
      txHash,
      fromAddress,
      toAddress,
      amountE8,
      blockHeight:
        tx.blockHeight ?? normalized.mined?.block?.height ?? null,
      confirmations:
        tx.confirmations ?? normalized.confirmations ?? 0,
    },
    confirmations: tx.confirmations ?? normalized.confirmations ?? 0,
    mined: normalized.mined || undefined,
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
    await sleep(700);
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
async function waitForPoolState(owner, ok, { timeoutMs = 45000, intervalMs = 700 } = {}) {
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

function humanToE8(human) {
  const s = String(human || '').trim().replace(/,/g, '');
  if (!s) return null;
  const [w, f = ''] = s.split('.');
  const frac = `${f}00000000`.slice(0, 8);
  try {
    return (BigInt(w || '0') * 100000000n + BigInt(frac || '0')).toString();
  } catch {
    return null;
  }
}

function pickReleaseTicket(src, { owner, amountE8, toAddress } = {}) {
  if (!src) return null;
  const tid = src.unlockTicketId || src.ticketId;
  if (tid && (src.amountE8 || src.unlockAmountE8 || src.type === 'pool_release_ticket')) {
    return {
      ticketId: tid,
      amountE8: src.unlockAmountE8 || src.amountE8 || amountE8 || null,
      toAddress: src.toAddress || toAddress || null,
      owner: src.owner || owner || null,
    };
  }
  const list = Array.isArray(src.recentTickets) ? src.recentTickets : [];
  const wantOwner = owner ? String(owner).toLowerCase() : '';
  const wantAmt = amountE8 != null ? String(amountE8) : null;
  const wantTo = toAddress
    ? String(toAddress).replace(/^0x/i, '').toLowerCase()
    : '';
  const matches = list.filter((t) => {
    if (!t?.ticketId) return false;
    if (t.type && t.type !== 'pool_release_ticket') return false;
    if (wantOwner && String(t.owner || '').toLowerCase() !== wantOwner) return false;
    if (
      wantTo &&
      String(t.toAddress || '')
        .replace(/^0x/i, '')
        .toLowerCase() !== wantTo
    ) {
      return false;
    }
    if (wantAmt && String(t.amountE8 || '') !== wantAmt) return false;
    return true;
  });
  const t = matches.length ? matches[matches.length - 1] : null;
  if (!t) return null;
  return {
    ticketId: t.ticketId,
    amountE8: t.amountE8 || amountE8 || null,
    toAddress: t.toAddress || toAddress || null,
    owner: t.owner || owner || null,
  };
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
  const want = owner
    ? `pool/${String(owner).replace(/^0x/i, '').toLowerCase()}`
    : 'pool';
  try {
    const base = getInspectUrl().replace(/\/$/, '');
    const res = await fetchWithTimeout(
      `${base}/${want}`,
      { cache: 'no-store' },
      8000,
    );
    if (res.ok) {
      const data = await res.json();
      if (data.reports?.length) {
        const decoded = decodeInspectPayload(data.reports[0].payload);
        if (decoded && !decoded.error) return decoded;
      }
    }
  } catch {
    /* nginx /rollup/inspect can 404 on the Node port or lock under load */
  }
  // Same-origin API talks to 127.0.0.1:8080 — does not depend on the
  // browser hitting /rollup/inspect.
  const q = owner ? `?inspect=1&owner=${encodeURIComponent(owner)}` : '?inspect=1';
  const res = await fetchWithTimeout(`/api/pool${q}`, { cache: 'no-store' }, 12000);
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `pool inspect ${res.status}`);
  }
  return data;
}

/**
 * Wait for a new executable wWART (or owner-bound) voucher, then execute on L1.
 * Prefers vouchers with inputIndex > minInputIndex (from just before withdraw).
 * @param {import('ethers-v6').Signer} signer
 * @param {{ owner: string, minInputIndex?: number, amountHint?: string, timeoutMs?: number }} opts
 */
async function waitAndExecuteWwartVoucher(signer, opts = {}) {
  const owner = String(opts.owner || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!signer) throw new Error('Connect MetaMask to execute the mint voucher');
  if (!owner) throw new Error('L1 owner required for voucher execute');

  // Ensure MetaMask is on Anvil before execute (Mode A demo)
  try {
    const net = await signer.provider?.getNetwork?.();
    const chainId = net?.chainId != null ? Number(net.chainId) : null;
    if (chainId != null && chainId !== 31337) {
      if (typeof window !== 'undefined' && window.ethereum) {
        try {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0x7a69' }],
          });
        } catch {
          throw new Error(
            `MetaMask is on chainId ${chainId}, need Anvil 31337 for executeVoucher. Switch network then open Vouchers → Execute.`,
          );
        }
      } else {
        throw new Error(
          `Wrong L1 chain (${chainId}). Switch to Anvil 31337, then Vouchers → Execute.`,
        );
      }
    }
  } catch (e) {
    if (String(e?.message || '').includes('Anvil') || String(e?.message || '').includes('chain')) {
      throw e;
    }
    /* provider getNetwork flaky — continue */
  }

  const wwart = String(LOCAL_WWART?.address || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const timeoutMs = opts.timeoutMs ?? 180000;
  const deadline = Date.now() + timeoutMs;
  const minInputIndex =
    typeof opts.minInputIndex === 'number' && Number.isFinite(opts.minInputIndex)
      ? opts.minInputIndex
      : -1;
  let hintAmt = null;
  try {
    if (opts.amountHint != null && String(opts.amountHint).trim() !== '') {
      hintAmt = Number(opts.amountHint);
      if (!Number.isFinite(hintAmt)) hintAmt = null;
    }
  } catch {
    hintAmt = null;
  }

  const matchesOwner = (v) => {
    const to = String(v?.decoded?.to || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    const sender = String(v?.msgSender || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    if (to && to === owner) return true;
    if (sender && sender === owner) return true;
    return false;
  };

  const isWwartish = (v) => {
    const dest = String(v?.destination || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    if (wwart && dest === wwart) return true;
    if (v?.token === 'wWART') return true;
    if (v?.decoded?.kind === 'mint' || v?.decoded?.kind === 'transfer') return true;
    return false;
  };

  const score = (v) => {
    let s = 0;
    if (matchesOwner(v)) s += 10;
    if (isWwartish(v)) s += 5;
    if (v.hasProof) s += 3;
    if (minInputIndex >= 0 && Number(v.inputIndex) > minInputIndex) s += 20;
    if (hintAmt != null && v?.decoded?.amountHuman != null) {
      const a = Number(v.decoded.amountHuman);
      if (Number.isFinite(a) && Math.abs(a - hintAmt) < 1e-6) s += 8;
    }
    // Prefer newer inputs
    s += Math.min(Number(v.inputIndex) || 0, 1000) / 1000;
    return s;
  };

  let lastNote = '';
  let lastExecErr = null;
  while (Date.now() < deadline) {
    let list = [];
    try {
      list = await fetchVouchers({ last: 50 });
    } catch {
      await sleep(2500);
      continue;
    }

    const ownerVouchers = list.filter((v) => matchesOwner(v));

    // Prefer NEW (inputIndex > min) complete proofs for this owner / wWART.
    // Never auto-pick old already-executed rows first (they cause estimateGas
    // "missing revert data" noise on Anvil/MetaMask).
    let candidates = ownerVouchers
      .filter((v) => v.hasProof && isWwartish(v))
      .filter((v) => minInputIndex < 0 || Number(v.inputIndex) > minInputIndex)
      .sort((a, b) => score(b) - score(a) || b.inputIndex - a.inputIndex);

    // Fallback: newest unexecuted owner wWART only (max 2)
    if (!candidates.length) {
      candidates = ownerVouchers
        .filter((v) => v.hasProof && isWwartish(v))
        .sort((a, b) => b.inputIndex - a.inputIndex)
        .slice(0, 2);
    }

    for (const v of candidates) {
      try {
        const onL1 = await isVoucherClaimedOnL1(signer, v).catch(() => false);
        if (!onL1) continue;
        const done = await wasVoucherExecuted(signer, v);
        if (done) continue;
      } catch {
        /* try execute anyway */
      }
      toast.loading(
        `Voucher #${v.inputIndex} ready — confirm executeVoucher in MetaMask…`,
        { id: 'pool' },
      );
      try {
        const { hash } = await executeVoucherOnL1(signer, v);
        return { voucher: v, hash };
      } catch (e) {
        lastExecErr = e;
        const msg = formatVoucherExecuteError(e);
        // User reject — stop immediately
        if (/rejected/i.test(msg)) {
          throw new Error(msg);
        }
        // Already executed — try newer candidate only
        if (/Already executed|wWART balance/i.test(msg)) {
          console.warn('[1-click execute] skip executed', v.inputIndex);
          continue;
        }
        // missing revert data on stale voucher — try next; don't spam same error forever
        if (/missing revert data|estimateGas|gas estimate failed/i.test(msg)) {
          console.warn('[1-click execute] skip bad gas estimate', v.inputIndex, msg);
          continue;
        }
        console.warn('[1-click execute]', v.inputIndex, msg);
      }
    }

    const pendingProof = ownerVouchers.some((v) => !v.hasProof);
    const newest = ownerVouchers[0];
    const note = pendingProof
      ? 'Waiting for voucher epoch proof…'
      : newest
        ? `Waiting for new voucher (have input #${newest.inputIndex}${minInputIndex >= 0 ? `, need >${minInputIndex}` : ''})…`
        : 'Waiting for withdraw voucher…';
    if (note !== lastNote) {
      lastNote = note;
      toast.loading(note, { id: 'pool' });
    }
    await sleep(3000);
  }

  if (lastExecErr) {
    throw new Error(
      `${formatVoucherExecuteError(lastExecErr)} — open Vouchers → Execute (do not re-deposit)`,
    );
  }
  throw new Error(
    'Voucher not ready in time. Open Vouchers → Execute when proof shows ready (do not re-deposit).',
  );
}

/** Highest GraphQL voucher input index for owner (or -1). */
async function maxOwnerVoucherInputIndex(owner) {
  const want = String(owner || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  try {
    const list = await fetchVouchers({ last: 50 });
    let max = -1;
    for (const v of list) {
      const to = String(v?.decoded?.to || '')
        .replace(/^0x/i, '')
        .toLowerCase();
      const sender = String(v?.msgSender || '')
        .replace(/^0x/i, '')
        .toLowerCase();
      if (to === want || sender === want) {
        const idx = Number(v.inputIndex);
        if (Number.isFinite(idx) && idx > max) max = idx;
      }
    }
    return max;
  } catch {
    return -1;
  }
}

export default function FungiblePool({
  ownerAddress,
  send,
  /** MetaMask / L1 signer — required for 1-click auto voucher execute */
  signer = null,
  /** Same MmTxConfirm preview used for withdraw / InputBox */
  confirmMmTx = null,
  wartBridgeApi,
  onRefreshL1Vault,
  /** Live MetaMask ERC-20 wWART balance (human string) — same source as Warthog Overview */
  mmWwartBal = null,
  onRefreshMmWwart,
}) {
  const [open, setOpen] = useState(true);
  const [showManual, setShowManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snap, setSnap] = useState(null);
  const [amount, setAmount] = useState('1');
  const [toAddress, setToAddress] = useState('');
  const [lastTicket, setLastTicket] = useState(null);
  const [mode, setMode] = useState('live'); // live | lab
  /** Path A3 threshold pool status (3-of-4 browser signers) */
  const [thresholdSt, setThresholdSt] = useState(null);
  const [pool3pSt, setPool3pSt] = useState(null);
  /**
   * UI custody toggle — same fungible deposit/mint flow either way;
   * only WART *release* uses 3-of-4 signers when on.
   */
  const THRESH_PREF_KEY = 'cartesi.pool.useThreshold3of4.v1';
  const [useThreshold3of4, setUseThreshold3of4] = useState(() => {
    try {
      const v = localStorage.getItem(THRESH_PREF_KEY);
      if (v === '0' || v === 'false') return false;
      if (v === '1' || v === 'true') return true;
    } catch {
      /* */
    }
    return true; // default ON for testnet demo
  });
  const setThresholdToggle = (on) => {
    setUseThreshold3of4(on);
    try {
      localStorage.setItem(THRESH_PREF_KEY, on ? '1' : '0');
    } catch {
      /* */
    }
  };
  const [pendingList, setPendingList] = useState([]);
  const [openFlows, setOpenFlows] = useState([]);
  const [resumeTxHash, setResumeTxHash] = useState('');
  /** Sticky action line — toasts expire; this does not. */
  const [actionStatus, setActionStatus] = useState(null);
  /** Host-queue WART→L1 bind. Conflict means do not send WART. */
  const [wartBind, setWartBind] = useState(null);
  /** Lab mode only when PUBLIC_POOL_LAB=1 or ?lab=1 — public demo hides it. */
  const labUiEnabled =
    String(import.meta.env.PUBLIC_POOL_LAB || '') === '1' ||
    (typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('lab') === '1');

  const owner = ownerAddress || '';
  const wartFrom = wartBridgeApi?.address || '';
  const bindBlocked = Boolean(wartBind?.conflict);
  const poolAddr =
    pool3pSt?.address ||
    pool3pSt?.seal?.address ||
    snap?.livePool?.address ||
    snap?.poolAddress ||
    FUNGIBLE_POOL.address;
  const previousQ =
    pool3pSt?.rotation?.last?.previous ||
    snap?.previousAddress ||
    null;
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
    // Path A3 threshold status (public, no secrets)
    try {
      const tres = await poolApi('/api/pool?threshold=1');
      if (tres?.ok !== false) setThresholdSt(tres);
    } catch {
      /* optional */
    }
    try {
      const p3 = await poolApi('/api/pool', {
        method: 'POST',
        body: JSON.stringify({ action: 'pool3p_status' }),
      });
      if (p3) setPool3pSt(p3);
    } catch {
      /* optional */
    }
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
            lockedE8: json.lockedE8,
            claimed18: json.claimed18,
            available18: json.available18,
            redeemedE8: json.redeemedE8,
            freeableE8: json.freeableE8,
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
                  ...user,
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
        livePool: s.livePool || null,
        previousAddress: s.livePool?.previous || s.previousAddress || null,
        poolAddress: s.livePool?.address || s.poolAddress || FUNGIBLE_POOL.address,
        lockedE8: s.lockedE8,
        claimed18: s.claimed18,
        available18: s.available18,
        redeemedE8: s.redeemedE8,
        lockedHuman: s.lockedHuman,
        capacityHuman: s.capacityHuman,
        claimedHuman: s.claimedHuman,
        availableHuman: s.availableHuman,
        redeemedHuman: s.redeemedHuman,
        user: s.user
          ? {
              ...s.user,
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

  useEffect(() => {
    let cancelled = false;
    if (!owner || !wartFrom) {
      setWartBind(null);
      return undefined;
    }
    fetchWartOwnerBind({ fromAddress: wartFrom, owner })
      .then((b) => {
        if (!cancelled) setWartBind(b);
      })
      .catch(() => {
        if (!cancelled) setWartBind(null);
      });
    return () => {
      cancelled = true;
    };
  }, [owner, wartFrom]);

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
    baselineDepositedE8,
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
      baselineDepositedE8:
        baselineDepositedE8 != null ? String(baselineDepositedE8) : undefined,
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
    const hardDeadline = Date.now() + Math.max(timeoutMs, 300000);
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
          // Queue truth: credit already applied (or duplicate). Always succeed
          // even if inspect deposited did not *increase* this wait cycle.
          return { ok: true, source: 'queue-credited', row };
        }
        if (row?.status === 'rejected' || row?.status === 'failed') {
          const err = new Error(row.error || 'Credit rejected by relayer');
          err.row = row;
          throw err;
        }
        // Surface relayer progress so UI does not look hung.
        // Confirmation waits used to be written as "SPV failed: need 2 confs,
        // have 1" even though the next tick credited.
        const rawNote = String(row?.error || row?.note || '');
        const note = /need \d+ confs, have \d+|waiting conf/i.test(rawNote)
          ? 'waiting for Warthog confirmations…'
          : rawNote ||
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
    // Last look — credit often lands a second after the wait window.
    try {
      const insp = await fetchPoolInspect(owner);
      if (insp && !insp.error) {
        const locked = BigInt(String(insp.lockedE8 || 0));
        const deposited = BigInt(String(insp.user?.depositedE8 || 0));
        if (deposited > prevDeposited || locked > prevLocked) {
          return { ok: true, source: 'inspect-late', deposited, locked };
        }
      }
    } catch {
      /* */
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
        return { ok: true, source: 'queue-credited-late', row };
      }
    } catch {
      /* */
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

    toast.loading('Checking WART↔ETH bind…', { id: 'pool' });
    const bound = await ensureWartOwnerBind({
      fromAddress: fromAddr || wartBridgeApi?.address,
      owner,
      signer,
      signWartMessage: wartBridgeApi?.signMessage,
    });
    setWartBind(bound);

    toast.loading('Queueing credit (relayer, no MetaMask)…', { id: 'pool' });
    const enq = await enqueueCredit({
      txHash,
      amountE8: amtE8,
      fromAddress: fromAddr,
      confirmations: slim?.confirmations || slim?.transaction?.confirmations,
      baselineDepositedE8: String(prevDeposited),
    });

    // Already credited on server/rollup — do not wait for a *new* deposit bump
    // (that was the "Resume hangs forever" bug when credit already landed).
    if (enq?.alreadyCredited || enq?.item?.status === 'credited') {
      try {
        const insp = await fetchPoolInspect(owner);
        const dep = BigInt(String(insp?.user?.depositedE8 || 0));
        const locked = BigInt(String(insp?.lockedE8 || 0));
        if (dep > 0n || locked > 0n || prevDeposited > 0n || prevLocked > 0n) {
          updatePendingStatus(txHash, 'credited');
          removePendingDeposit(txHash);
          advanceFlowForOwner(owner, 'credited', {
            depositTxHash: txHash,
            amountE8: String(amtE8),
          });
          refreshPending();
          refreshFlows();
          toast.success(
            `Already credited on rollup · ${humanFromE8(amtE8)} WART (cleared local tracker)`,
            { id: 'pool', duration: 8000 },
          );
          return;
        }
      } catch {
        /* fall through to wait */
      }
    }

    // If inspect already shows this owner's deposit (common after SPV success),
    // treat as done even when waiting for increase would no-op.
    try {
      const insp0 = await fetchPoolInspect(owner);
      if (insp0 && !insp0.error) {
        const dep = BigInt(String(insp0.user?.depositedE8 || 0));
        const locked = BigInt(String(insp0.lockedE8 || 0));
        if (
          (dep > 0n && dep >= prevDeposited && prevDeposited > 0n) ||
          (dep >= BigInt(amtE8) && amtE8 > 0) ||
          (locked > 0n && locked >= prevLocked && prevLocked > 0n)
        ) {
          // If we already had capacity before this resume and queue says credited, done
          if (enq?.alreadyCredited || dep >= BigInt(amtE8)) {
            updatePendingStatus(txHash, 'credited');
            removePendingDeposit(txHash);
            advanceFlowForOwner(owner, 'credited', {
              depositTxHash: txHash,
              amountE8: String(amtE8),
            });
            refreshPending();
            refreshFlows();
            toast.success(
              `Pool credit OK · deposited ${humanFromE8(dep)} WART on rollup`,
              { id: 'pool', duration: 8000 },
            );
            return;
          }
        }
      }
    } catch {
      /* */
    }

    toast.loading('Waiting for pool credit (relayer + SPV LC)…', { id: 'pool' });
    let result = await waitForRollupCredit({
      txHash,
      prevDeposited,
      prevLocked,
      timeoutMs: 120000,
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

  const confirmStyled = async (desc) => {
    if (typeof confirmMmTx !== 'function') return true;
    const ok = await confirmMmTx(desc);
    if (!ok) throw new Error('Cancelled — nothing sent');
    return true;
  };

  /**
   * 1-button live deposit: send WART once → relayer credits rollup.
   * Never re-sends WART on credit failure — surfaces Resume instead.
   * @param {{ timeoutMs?: number, preview?: boolean }} [opts]
   */
  const liveDeposit = async (opts = {}) => {
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

    // Bind must exist before send. Unbound → dual-sig register (not first-writer).
    toast.loading('Checking WART↔ETH bind…', { id: 'pool' });
    const bound = await ensureWartOwnerBind({
      fromAddress: wartBridgeApi.address,
      owner,
      signer,
      signWartMessage: wartBridgeApi.signMessage,
    });
    setWartBind(bound);

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

    if (opts.preview !== false) {
      await confirmStyled({
        title: 'Send WART to pool',
        method: 'Warthog transfer to 3P pool',
        summary: [
          `You pay: ${amt} WART`,
          `You receive: ${amt} wWART`,
          `To pool: ${String(poolAddr).slice(0, 12)}…`,
        ].join('\n'),
        sections: [
          {
            label: 'Deposit',
            json: {
              youPay: `${amt} WART`,
              youReceive: `${amt} wWART`,
              poolAddress: poolAddr,
              from: wartBridgeApi.address,
              owner,
            },
          },
        ],
      });
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

    // Convert human amount → E8 early so we can queue even if proof parsing lags
    let earlyE8 = null;
    try {
      const n = Number(amt);
      if (Number.isFinite(n) && n > 0) earlyE8 = Math.round(n * 1e8);
    } catch {
      /* */
    }

    upsertPendingDeposit({
      txHash,
      owner,
      poolAddress: poolAddr,
      status: 'awaiting_confirm',
      amountHuman: amt,
      amountE8: earlyE8 != null ? String(earlyE8) : null,
      fromAddress: wartBridgeApi?.address || null,
    });
    upsertFlow({
      id: String(txHash).toLowerCase(),
      owner,
      depositTxHash: txHash,
      amountHuman: amt,
      amountE8: earlyE8 != null ? String(earlyE8) : null,
      step: 'deposit_pending',
      baselineDepositedE8: String(prevDeposited),
      note: 'Warthog mempool / confirming',
      replaceOpen: true,
    });
    refreshPending();
    refreshFlows();

    // CRITICAL: enqueue as soon as we have a hash so a tab close / proof lag
    // cannot leave WART on the pool with no relayer job (the "5 never credited" bug).
    try {
      toast.loading('Queueing credit (relayer)…', { id: 'pool' });
      await enqueueCredit({
        txHash,
        amountE8: earlyE8,
        fromAddress: wartBridgeApi?.address,
        confirmations: 0,
        baselineDepositedE8: String(prevDeposited),
      });
    } catch (e) {
      console.warn('[pool] early enqueue failed', e);
      // Continue — proof path will re-enqueue; still surface hash for Resume
    }

    toast.loading('Waiting for Warthog confirmations…', { id: 'pool' });
    let proof = await pollConfirm(txHash, 1);
    if (!proof) {
      updatePendingStatus(txHash, 'stranded', {
        error: 'proof incomplete — Resume when confirmed',
      });
      refreshPending();
      throw new Error(
        `Warthog tx ${String(txHash).slice(0, 12)}… sent and queued. ` +
          'Proof not ready yet — wait, then Resume if Available does not rise. Do not Deposit again.',
      );
    }
    const slim = slimDepositProof(proof);
    const toNorm = String(slim.transaction?.toAddress || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    const amtE8 = Number(slim.transaction?.amountE8 || earlyE8 || 0);
    if (!toNorm || amtE8 <= 0) {
      updatePendingStatus(txHash, 'stranded', { error: 'incomplete proof' });
      refreshPending();
      throw new Error(
        `Deposit proof incomplete for ${String(txHash).slice(0, 12)}… — already queued; use Resume (no re-send).`,
      );
    }
    if (toNorm !== poolNorm) {
      updatePendingStatus(txHash, 'failed_send', { error: 'wrong destination' });
      refreshPending();
      throw new Error(
        `Proof to=${toNorm.slice(0, 12)}… is not the pool (${poolNorm.slice(0, 12)}…).`,
      );
    }

    toast.loading('Refreshing credit queue with confirmed proof…', { id: 'pool' });
    await enqueueCredit({
      txHash,
      amountE8: amtE8,
      fromAddress: slim.transaction?.fromAddress || wartBridgeApi?.address,
      confirmations: slim.confirmations || slim.transaction?.confirmations,
      baselineDepositedE8: String(prevDeposited),
    });

    toast.loading('Waiting for pool credit…', { id: 'pool' });
    const result = await waitForRollupCredit({
      txHash,
      prevDeposited,
      prevLocked,
      timeoutMs: opts.timeoutMs || 240000,
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

    setActionStatus({ kind: 'info', text: 'Checking pool credit…' });
    toast.loading('Checking pool credit…', { id: 'pool', duration: Infinity });

    let before = (await fetchPoolInspect(owner).catch(() => null)) || {};
    if (!before.available18 && !before.user && snap) before = snap;
    const prevClaim = userBn(before, 'claim18');
    const prevPortable = userBn(before, 'portable18');
    const avail = poolBn(before, 'available18');
    const deposited = userBn(before, 'depositedE8');
    const want18 = humanTo18(amt);
    if (avail <= 0n) {
      throw new Error(
        prevClaim > 0n || deposited > 0n
          ? `No mint headroom left (your claim ${humanFrom18(prevClaim)}, pool available 0). Withdraw that claim or wait for more pool deposits.`
          : 'No credited pool deposit yet. Wait until Your deposit / Pool available rises (Warthog confirmations + relayer) — do not send WART again. Then Mint claim.',
      );
    }
    // Explicit Mint always adds `amount` (capped to remaining available).
    // Do not skip just because an earlier claim already matches the box.
    const mint18 = want18 > avail ? avail : want18;
    const mintAmt = humanFrom18(mint18);
    if (mint18 < want18) {
      toast(
        `Capping mint to ${mintAmt} (pool available). You already hold claim ${humanFrom18(prevClaim)}.`,
        { id: 'pool-mint-cap', duration: 8000 },
      );
    }

    const seen = await snapshotNoticePayloads();
    let rejectErr = null;

    setActionStatus({
      kind: 'info',
      text: `Minting ${mintAmt} claim (deposit already credited)…`,
    });
    toast.loading(`Minting ${mintAmt} claim via Anvil InputBox…`, {
      id: 'pool',
      duration: Infinity,
    });
    // Mode A: same as deposit credit — host posts InputBox from the demo
    // key. Wallet addInput has not reached this Anvil since the last wipe.
    let mintedVia = 'wallet';
    try {
      const relayed = await poolApi('/api/pool', {
        method: 'POST',
        body: JSON.stringify({
          action: 'anvil_pool_mint',
          owner,
          amount: mintAmt,
          tokenAddress: String(wwartToken).toLowerCase(),
        }),
      });
      if (relayed?.ok && relayed.txHash) {
        mintedVia = 'anvil';
        toast.loading(`Mint InputBox ${String(relayed.txHash).slice(0, 12)}… waiting rollup`, {
          id: 'pool',
          duration: Infinity,
        });
      } else {
        throw new Error(relayed?.error || 'anvil mint declined');
      }
    } catch {
      mintedVia = 'wallet';
      toast.loading(
        `Sign mint of ${mintAmt} in the wallet (InputBox.addInput on 31337)`,
        { id: 'pool', duration: Infinity },
      );
      await send(
        {
          type: 'pool_mint_wwart',
          amount: mintAmt,
          tokenAddress: String(wwartToken).toLowerCase(),
        },
        { quiet: true },
      );
    }
    setActionStatus({
      kind: 'info',
      text: 'Mint submitted to Anvil — waiting for rollup inspect (up to ~45s)…',
    });
    toast.loading('Mint submitted — waiting for rollup…', {
      id: 'pool',
      duration: Infinity,
    });

    void waitForNotice('pool_wwart_minted', {
      timeoutMs: 45000,
      rejectType: ['pool_mint_rejected', 'wwart_mint_rejected'],
      matchOwner: owner,
      seenPayloads: seen,
    }).catch((e) => {
      if (e?.notice || String(e?.message || '').startsWith('Rollup rejected')) {
        rejectErr = e;
      }
      return null;
    });

    const after = await waitForPoolState(
      owner,
      (s) =>
        rejectErr ||
        userBn(s, 'claim18') > prevClaim ||
        userBn(s, 'portable18') > prevPortable,
      { timeoutMs: 45000 },
    );
    if (rejectErr) throw rejectErr;
    if (
      after &&
      (userBn(after, 'claim18') > prevClaim ||
        userBn(after, 'portable18') > prevPortable)
    ) {
      advanceFlowForOwner(owner, 'minted', { amountHuman: mintAmt });
      refreshFlows();
      setActionStatus({
        kind: 'ok',
        text: `Minted ${mintAmt} more (claim now ${humanFrom18(userBn(after, 'claim18'))}). Withdraw when you want wWART.`,
      });
      toast.success(
        `Minted ${mintAmt} more pool claim${mintedVia === 'anvil' ? ' (Anvil InputBox)' : ''}`,
        {
          id: 'pool',
          duration: 10000,
        },
      );
      return;
    }
    throw new Error(
      'Mint InputBox was sent (or timed out) but inspect still shows claim 0. Refresh. If claim is still 0 the wallet tx never landed — MetaMask → Advanced → Clear activity tab data, stay on Anvil 31337, mint again. Do not re-deposit WART.',
    );
  };

  /**
   * @param {{ silentSuccess?: boolean, minInputIndex?: number }} [opts]
   *   silentSuccess — for 1-click (caller executes voucher next)
   * @returns {Promise<{ prevVoucherCount: number, minInputIndex: number }>}
   */
  const liveWithdraw = async (opts = {}) => {
    if (!send) throw new Error('Rollup send unavailable');
    const amt = String(amount || '').trim();
    if (!amt) throw new Error('Enter amount');

    const before = (await fetchPoolInspect(owner).catch(() => null)) || {};
    const prevPortable = userBn(before, 'portable18');
    const prevVouchers = await countOwnerVouchers(owner);
    const minInputIndex =
      opts.minInputIndex != null
        ? opts.minInputIndex
        : await maxOwnerVoucherInputIndex(owner);
    const seen = await snapshotNoticePayloads();

    toast.loading(`Withdrawing ${amt} (InputBox → voucher)…`, {
      id: 'pool',
      duration: Infinity,
    });
    try {
      const relayed = await poolApi('/api/pool', {
        method: 'POST',
        body: JSON.stringify({
          action: 'anvil_pool_withdraw',
          owner,
          amount: amt,
        }),
      });
      if (!relayed?.ok || !relayed.txHash) {
        throw new Error(relayed?.error || 'anvil withdraw declined');
      }
      toast.loading(
        `Withdraw InputBox ${String(relayed.txHash).slice(0, 12)}… waiting voucher`,
        { id: 'pool', duration: Infinity },
      );
    } catch {
      toast.loading(
        `Sign withdraw of ${amt} in the wallet (InputBox on 31337)`,
        { id: 'pool', duration: Infinity },
      );
      await send({ type: 'pool_withdraw_wwart', amount: amt }, { quiet: true });
    }
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
          if (!opts.silentSuccess) {
            toast.success(
              `Voucher ready for ${amt} wWART — open Vouchers → Execute`,
              { id: 'pool', duration: 9000 },
            );
          }
          return { prevVoucherCount: prevVouchers, minInputIndex };
        }
        const vc = await countOwnerVouchers(owner);
        if (vc >= 0 && prevVouchers >= 0 && vc > prevVouchers) {
          advanceFlowForOwner(owner, 'voucher_ready', { amountHuman: amt });
          refreshFlows();
          if (!opts.silentSuccess) {
            toast.success(`Voucher ready — open Vouchers → Execute`, {
              id: 'pool',
              duration: 9000,
            });
          }
          return { prevVoucherCount: prevVouchers, minInputIndex };
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
      if (!opts.silentSuccess) {
        toast.success('Open Vouchers and Execute (may already be listed)', {
          id: 'pool',
          duration: 10000,
        });
      }
      return { prevVoucherCount: prevVouchers, minInputIndex };
    }
    throw new Error(
      'Withdraw not confirmed. Open Vouchers tab and refresh. RPC: https://cartesi-bridge.duckdns.org/rpc',
    );
  };

  /**
   * One-click Path A: Deposit WART → mint claim → withdraw voucher → execute on L1.
   * Manual step buttons remain for partial / recovery flows.
   * MetaMask prompts: mint InputBox, withdraw InputBox, executeVoucher (+ Warthog send).
   */
  const liveOneClickToWwart = async () => {
    if (!owner) throw new Error('Connect L1 wallet');
    if (!signer) {
      throw new Error(
        'Connect MetaMask (L1 signer) for auto voucher execute — or use Deposit → Mint → Withdraw → Vouchers manually',
      );
    }
    if (!send) throw new Error('Rollup send unavailable');
    const amt = String(amount || '').trim();
    if (!amt) throw new Error('Enter amount');

    // Resume from *this owner's* rollup truth — never skip deposit just because
    // the shared pool still has someone else's available headroom.
    const want18 = humanTo18(amt);
    let insp = (await fetchPoolInspect(owner).catch(() => null)) || {};
    let claim = userBn(insp, 'claim18');
    let portable = userBn(insp, 'portable18');
    let userDep18 = userBn(insp, 'depositedE8') * 10n ** 10n;

    if (claim >= want18 || portable >= want18 || userDep18 >= want18) {
      toast.loading(
        '1-click: already credited on rollup — skipping deposit…',
        { id: 'pool' },
      );
    } else {
      if (!wartBridgeApi?.sendTransaction || !wartBridgeApi?.getWartTxProof) {
        throw new Error('Unlock Warthog wallet first (needed to send real WART)');
      }
      toast.loading(`1-click: depositing ${amt} WART…`, { id: 'pool' });
      await liveDeposit();
      insp = (await fetchPoolInspect(owner).catch(() => null)) || {};
      claim = userBn(insp, 'claim18');
      portable = userBn(insp, 'portable18');
      userDep18 = userBn(insp, 'depositedE8') * 10n ** 10n;
    }

    if (claim >= want18 || portable >= want18) {
      toast.loading('1-click: claim already minted — skipping mint…', { id: 'pool' });
    } else {
      toast.loading('1-click: mint claim…', { id: 'pool' });
      await liveMint();
      insp = (await fetchPoolInspect(owner).catch(() => null)) || {};
      claim = userBn(insp, 'claim18');
      portable = userBn(insp, 'portable18');
    }

    const minInputIndex = await maxOwnerVoucherInputIndex(owner);
    toast.loading('1-click: withdraw voucher…', { id: 'pool' });
    const w = await liveWithdraw({ silentSuccess: true, minInputIndex });

    toast.loading('1-click: waiting for voucher proof…', { id: 'pool' });
    try {
      const { hash } = await waitAndExecuteWwartVoucher(signer, {
        owner,
        minInputIndex: w?.minInputIndex ?? minInputIndex,
        amountHint: amt,
        timeoutMs: 180000,
      });

      advanceFlowForOwner(owner, 'wwart_on_l1', { amountHuman: amt });
      refreshFlows();
      toast.success(
        `wWART on MetaMask · execute tx ${String(hash).slice(0, 10)}…`,
        { id: 'pool', duration: 10000 },
      );
      onRefreshMmWwart?.();
    } catch (e) {
      // Deposit/mint/withdraw already done — never ask user to re-deposit
      advanceFlowForOwner(owner, 'voucher_ready', { amountHuman: amt });
      refreshFlows();
      throw new Error(
        `${formatVoucherExecuteError(e)}. Rollup steps finished — use Vouchers → Execute (do not re-deposit).`,
      );
    }
  };

  /**
   * Atomic WART → wWART for the entered amount only.
   * Always sends that WART and always mints that deposit. Ignores leftover
   * tracker / leftover claim so a hung 1-click cannot skip the send or mint.
   */
  const liveAtomicToWwart = async () => {
    if (!owner) throw new Error('Connect L1 wallet');
    if (!signer) {
      throw new Error('Connect MetaMask (L1 signer) to execute the wWART voucher');
    }
    if (!wartBridgeApi?.sendTransaction || !wartBridgeApi?.getWartTxProof) {
      throw new Error('Unlock Warthog wallet first (needed to send real WART)');
    }
    const amt = String(amount || '').trim();
    if (!amt) throw new Error('Enter amount');

    wipeFlowsForOwner(owner);
    refreshFlows();
    setActionStatus({
      kind: 'info',
      text: `Swapping ${amt} WART → wWART…`,
    });

    toast.loading(`Sending ${amt} WART…`, {
      id: 'pool',
      duration: Infinity,
    });
    try {
      await liveDeposit({ timeoutMs: 240000, preview: true });
    } catch (e) {
      const insp = await fetchPoolInspect(owner).catch(() => null);
      const dep = userBn(insp, 'depositedE8');
      if (!(insp && dep > 0n)) throw e;
      toast.loading('Deposit already credited — minting…', { id: 'pool' });
    }

    toast.loading(`Minting ${amt}…`, {
      id: 'pool',
      duration: Infinity,
    });
    await liveMint();

    const minInputIndex = await maxOwnerVoucherInputIndex(owner);
    toast.loading('Atomic: withdraw voucher…', { id: 'pool', duration: Infinity });
    const w = await liveWithdraw({ silentSuccess: true, minInputIndex });

    toast.loading('Atomic: execute voucher → MetaMask wWART…', {
      id: 'pool',
      duration: Infinity,
    });
    try {
      const { hash } = await waitAndExecuteWwartVoucher(signer, {
        owner,
        minInputIndex: w?.minInputIndex ?? minInputIndex,
        amountHint: amt,
        timeoutMs: 180000,
      });
      setActionStatus({
        kind: 'ok',
        text: `Atomic WART → wWART ${amt} landed on MetaMask.`,
      });
      toast.success(
        `Atomic WART → wWART · execute ${String(hash).slice(0, 10)}…`,
        { id: 'pool', duration: 10000 },
      );
      onRefreshMmWwart?.();
    } catch (e) {
      throw new Error(
        `${formatVoucherExecuteError(e)}. Deposit+mint+withdraw finished — Vouchers → Execute (do not re-send WART).`,
      );
    }
  };

  /**
   * Atomic wWART → WART: portal the entered MetaMask wWART, burn, 3P pay native WART.
   * Fresh cycle — does not resume a leftover redeem ticket.
   */
  const liveAtomicToWart = async () => {
    if (!owner) throw new Error('Connect L1 wallet');
    if (!signer) {
      throw new Error('Connect MetaMask to portal-deposit wWART');
    }
    const amt = String(amount || '').trim();
    if (!amt) throw new Error('Enter amount');
    const to =
      String(toAddress || '').trim() || wartBridgeApi?.address || '';
    if (!to) {
      throw new Error('Unlock Warthog or set redeem-to for the WART payout');
    }

    wipeFlowsForOwner(owner);
    refreshFlows();
    setActionStatus({
      kind: 'info',
      text: `Atomic wWART → WART ${amt} (portal + burn + 3P pay)…`,
    });

    await confirmStyled({
      title: 'Swap wWART → WART',
      method: 'ERC20Portal.depositERC20Tokens + burn + 3P pay',
      summary: [
        `You pay: ${amt} wWART`,
        `You receive: ${amt} WART`,
        `Payout to: ${String(to).slice(0, 12)}…`,
      ].join('\n'),
      sections: [
        {
          label: 'Redeem',
          json: { youPay: `${amt} wWART`, youReceive: `${amt} WART`, to, owner },
        },
      ],
    });

    toast.loading(`Portal-deposit ${amt} wWART…`, {
      id: 'pool',
      duration: Infinity,
    });
    await portalDepositPoolWwart(signer, amt);

    toast.loading(`Atomic: burn ${amt} and 3P-pay WART…`, {
      id: 'pool',
      duration: Infinity,
    });
    await liveBurn();

    setActionStatus({
      kind: 'ok',
      text: `Atomic wWART → WART ${amt} submitted to ${String(to).slice(0, 12)}…`,
    });
    toast.success(`Atomic wWART → WART ${amt}`, { id: 'pool', duration: 10000 });
    onRefreshMmWwart?.();
  };

  /**
   * Release-ticket payout: under Path A3 opens 3-of-4 threshold request, then
   * waits for faux/browser signers to assemble a real Warthog transfer.
   * Single-key hot path still works if POOL_THRESHOLD_MODE is off.
   */
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
        useThreshold: true,
        forceHot: false,
      }),
    });

    // Immediate single-key (toggle OFF) or already paid
    if (pay.txHash || pay.alreadyPaid || pay.skipped || pay.mode === 'hot-wallet') {
      toast.success(
        pay.alreadyPaid
          ? `Already paid ${pay.amountHuman || amtLabel || ''} WART`
          : pay.skipped
            ? `Payout skipped: ${pay.skipReason || 'policy'}`
            : `Paid ${pay.amountHuman || amtLabel || ''} WART · hot wallet · tx ${String(pay.txHash || '').slice(0, 12)}…`,
        { id: 'pool', duration: 10000 },
      );
      await refresh();
      return pay;
    }

    // Path A4: 3P Lindell — poll pool3p_ticket until paid
    const ticketId = pay.ticketId || ticket.ticketId;
    if (pay.mode === 'pool-3p' || pay.custody === '3p-d1-d2') {
      toast.loading(`3P pool: waiting for d1 + d2 on ${ticketId}…`, { id: 'pool' });
      const deadline = Date.now() + 180000;
      let first = true;
      while (Date.now() < deadline) {
        if (!first) await new Promise((r) => setTimeout(r, 700));
        first = false;
        let st = null;
        try {
          st = await poolApi('/api/pool', {
            method: 'POST',
            body: JSON.stringify({ action: 'pool3p_ticket', ticketId }),
          });
        } catch {
          continue;
        }
        const status = String(st.status || '');
        const rawTx = st.txHash || st.payout?.txHash;
        const sighash = st.hashHex || st.prep?.hashHex;
        const realTx =
          rawTx && String(rawTx).toLowerCase() !== String(sighash || '').toLowerCase()
            ? rawTx
            : null;
        if (realTx || status === 'paid' || st.payout?.ok) {
          toast.success(
            `Released ${amtLabel || humanFromE8(ticket.amountE8) || ''} WART via 3P Lindell` +
              (realTx ? ` · ${realTx}` : ''),
            { id: 'pool', duration: 14000 },
          );
          await refresh();
          return { ok: true, ticketId, mode: 'pool-3p', txHash: realTx, ...st };
        }
        const wait = (st.waitingOn || []).join('+') || (status || 'signing');
        toast.loading(
          `3P Lindell · ${wait} · d1 ${st.haveR1 ? 'in' : '…'} · d2 ${st.haveD2 ? 'in' : '…'}`,
          { id: 'pool' },
        );
      }
      throw new Error(
        `3P payout timeout for ${ticketId} — keep both browser d1 and d2 tabs signed in`,
      );
    }

    // Path A3: opened for 3-of-4 signers — poll until real transfer lands
    const isThreshold =
      pay.mode === 'threshold-3of4' || pay.opened || pay.alreadyOpen;
    if (!isThreshold) {
      toast.success(
        pay.note || `Payout accepted for ${amtLabel || ticketId}`,
        { id: 'pool', duration: 8000 },
      );
      return pay;
    }

    toast.loading(
      `3-of-4 threshold: waiting for signers on ${ticketId}…`,
      { id: 'pool' },
    );
    const deadline = Date.now() + 90000;
    let lastCount = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      let st = null;
      try {
        st = await poolApi(
          `/api/pool?threshold=1&ticket=${encodeURIComponent(ticketId)}`,
        );
      } catch {
        continue;
      }
      setThresholdSt((prev) => ({ ...(prev || {}), ...st, open: prev?.open }));
      const count = Number(st.count || 0);
      const need = Number(st.need || 3);
      if (count !== lastCount && st.status !== 'paid' && st.status !== 'lab_paid') {
        lastCount = count;
        toast.loading(
          `3-of-4 signers: ${count}/${need} shares for ${ticketId}…`,
          { id: 'pool' },
        );
      }
      if (st.status === 'paid' || st.paid?.txHash) {
        const tx = st.paid?.txHash || st.payout?.txHash;
        toast.success(
          `Released ${amtLabel || humanFromE8(ticket.amountE8) || ''} WART via 3-of-4` +
            (tx ? ` · tx ${String(tx).slice(0, 12)}…` : ''),
          { id: 'pool', duration: 12000 },
        );
        await refresh();
        return { ok: true, ...st.paid, ticketId, mode: 'threshold-3of4', txHash: tx };
      }
      if (st.status === 'lab_paid') {
        toast.success(`Lab 3-of-4 complete (no chain transfer)`, {
          id: 'pool',
          duration: 8000,
        });
        await refresh();
        return { ok: true, labDemo: true, ticketId, ...st.paid };
      }
      if (st.status === 'failed') {
        throw new Error(
          st.error ||
            '3-of-4 assemble failed — check faux-signers logs / pool balance',
        );
      }
    }
    throw new Error(
      `3-of-4 payout timeout for ${ticketId} — signers may be down (systemctl status cartesi-bridge-pool-faux-signers)`,
    );
  };

  /**
   * Burn pool claim (A-α minter) or A-β holder redeem.
   * Filled claims / bearer wWART need portal inventory first.
   * Success = personal claim drops OR global claimed/locked drops (holder).
   * Then 3-of-4 (or hot) payout if release ticket found.
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
        ? 'Burn/redeem: confirm the preview dialog, then MetaMask…'
        : 'Burn: confirm the preview dialog, then MetaMask…',
      { id: 'pool', duration: 20000 },
    );
    await send(
      {
        type: 'pool_burn_wwart',
        amount: amt,
        ...(to ? { toAddress: to, autoUnlock: true } : { autoUnlock: true }),
      },
      { quiet: true },
    );
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
      { timeoutMs: 20000, intervalMs: 700 },
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

    let ticket = pickReleaseTicket(await noticeP.catch(() => null), {
      owner,
      amountE8: humanToE8(amt),
      toAddress: to,
    });
    if (!ticket?.ticketId) {
      ticket = pickReleaseTicket(after, {
        owner,
        amountE8: humanToE8(amt),
        toAddress: to,
      });
    }
    if (!ticket?.ticketId) {
      try {
        const t = await waitForNotice('pool_release_ticket', {
          timeoutMs: 4000,
          matchOwner: owner,
          seenPayloads: seen,
        });
        ticket = pickReleaseTicket(t, { owner, amountE8: humanToE8(amt), toAddress: to });
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

    toast.loading(
      'Redeem: confirm the preview dialog, then MetaMask…',
      { id: 'pool', duration: 20000 },
    );
    await send(
      {
        type: 'pool_redeem',
        amount: amt,
        toAddress: to,
      },
      { quiet: true },
    );
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
      { timeoutMs: 20000, intervalMs: 700 },
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

    let ticket = pickReleaseTicket(await Promise.race([ticketP, sleep(50)]), {
      owner,
      amountE8: humanToE8(amt),
      toAddress: to,
    });
    if (!ticket?.ticketId) {
      ticket = pickReleaseTicket(after, {
        owner,
        amountE8: humanToE8(amt),
        toAddress: to,
      });
    }
    if (!ticket?.ticketId) {
      try {
        ticket = pickReleaseTicket(await ticketP, {
          owner,
          amountE8: humanToE8(amt),
          toAddress: to,
        });
      } catch (e) {
        if (String(e?.message || '').startsWith('Rollup rejected')) throw e;
      }
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
        if (
          action === 'one_click_wwart' ||
          action === 'atomic_to_wwart' ||
          action === 'atomic_to_wart'
        ) {
          throw new Error('Atomic / 1-click is live-only (real WART ↔ real wWART)');
        }
        await labAction(action);
      } else if (action === 'one_click_wwart') await liveOneClickToWwart();
      else if (action === 'atomic_to_wwart') await liveAtomicToWwart();
      else if (action === 'atomic_to_wart') await liveAtomicToWart();
      else if (action === 'deposit') await liveDeposit();
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
      const msg = e?.message || String(e);
      setActionStatus({ kind: 'err', text: msg });
      toast.error(msg, { id: 'pool', duration: 20000 });
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
        border: '1px solid rgba(0, 255, 204, 0.4)',
        // Near-solid so tropical page bg doesn't wash out pool copy (desktop Chrome/Brave)
        background:
          'linear-gradient(165deg, rgba(6, 28, 26, 0.96) 0%, rgba(8, 10, 12, 0.97) 100%)',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.55)',
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
          <span
            title="Release needs d_dapp + browser d1 + browser d2 (3P ECDSA). Hot key retired."
            style={{
              fontSize: '0.68rem',
              padding: '0.12rem 0.4rem',
              borderRadius: 6,
              background: 'rgba(253,185,19,0.22)',
              color: '#FDB913',
              fontWeight: 700,
            }}
          >
            3P pool · d_dapp + d1 + d2
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

      <p className="fp-status-line">
        1:1 pool swap. Native WART in → MetaMask wWART out, or the reverse via 3P payout.
        {pool3pSt?.configured ? (
          <>
            {' '}
            Signers {pool3pSt.d1Live ? 'd1 live' : 'd1 waiting'} ·{' '}
            {pool3pSt.d2Live ? 'd2 live' : 'd2 waiting'}
            {pool3pSt.orbit ? ` · orbit ${pool3pSt.orbit.liveCount || 0}` : ''}.
          </>
        ) : null}
      </p>

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

          {mode === 'live' && (
            <>
              <div className="fp-swap">
                <div className="fp-swap-head">
                  <span className="fp-swap-title">WART → wWART</span>
                  <span className="fp-swap-peg">1 = 1</span>
                </div>
                <div className="fp-swap-leg">
                  <div className="fp-swap-leg-top">
                    <span>You pay</span>
                    <span>from Warthog</span>
                  </div>
                  <div className="fp-swap-row">
                    <input
                      type="text"
                      inputMode="decimal"
                      className="fp-swap-input"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.0"
                      disabled={busy || !owner}
                      aria-label="WART amount to swap in"
                    />
                    <span className="fp-swap-asset">WART</span>
                  </div>
                </div>
                <div className="fp-swap-flip" aria-hidden>
                  <span className="fp-swap-flip-mark">
                    <ArrowDownUp size={16} />
                  </span>
                </div>
                <div className="fp-swap-leg">
                  <div className="fp-swap-leg-top">
                    <span>You receive</span>
                    <span>to MetaMask</span>
                  </div>
                  <div className="fp-swap-row">
                    <input
                      type="text"
                      inputMode="decimal"
                      className="fp-swap-input"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.0"
                      disabled={busy || !owner}
                      aria-label="wWART amount you receive"
                    />
                    <span className="fp-swap-asset is-out">wWART</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn primary fp-swap-go"
                  disabled={
                    busy ||
                    !owner ||
                    !signer ||
                    !wartBridgeApi?.sendTransaction ||
                    bindBlocked
                  }
                  onClick={() => run('atomic_to_wwart')}
                  title={
                    bindBlocked
                      ? wartBind?.error ||
                        'This Warthog wallet is bound to another L1 address'
                      : 'Send this WART, mint that deposit, execute wWART'
                  }
                >
                  Swap WART → wWART
                </button>
              </div>

              <div className="fp-swap">
                <div className="fp-swap-head">
                  <span className="fp-swap-title">wWART → WART</span>
                  <span className="fp-swap-peg">1 = 1</span>
                </div>
                <div className="fp-swap-leg">
                  <div className="fp-swap-leg-top">
                    <span>You pay</span>
                    <span>
                      {mmWwartLabel ? `wallet ${mmWwartLabel}` : 'from MetaMask'}
                    </span>
                  </div>
                  <div className="fp-swap-row">
                    <input
                      type="text"
                      inputMode="decimal"
                      className="fp-swap-input"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.0"
                      disabled={busy || !owner}
                      aria-label="wWART amount to swap in"
                    />
                    <span className="fp-swap-asset">wWART</span>
                  </div>
                </div>
                <div className="fp-swap-flip" aria-hidden>
                  <span className="fp-swap-flip-mark">
                    <ArrowDownUp size={16} />
                  </span>
                </div>
                <div className="fp-swap-leg">
                  <div className="fp-swap-leg-top">
                    <span>You receive</span>
                    <span>to Warthog</span>
                  </div>
                  <div className="fp-swap-row">
                    <input
                      type="text"
                      inputMode="decimal"
                      className="fp-swap-input"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.0"
                      disabled={busy || !owner}
                      aria-label="WART amount you receive"
                    />
                    <span className="fp-swap-asset is-out">WART</span>
                  </div>
                </div>
                <input
                  type="text"
                  className="fp-swap-to"
                  value={toAddress}
                  onChange={(e) => setToAddress(e.target.value)}
                  placeholder={
                    wartBridgeApi?.address
                      ? `WART pays to ${String(wartBridgeApi.address).slice(0, 12)}… (or paste another)`
                      : 'Warthog address to receive WART'
                  }
                  disabled={busy || !owner}
                  aria-label="Warthog address for WART payout"
                />
                <button
                  type="button"
                  className="btn primary fp-swap-go"
                  disabled={
                    busy ||
                    !owner ||
                    !signer ||
                    !(toAddress || wartBridgeApi?.address)
                  }
                  onClick={() => run('atomic_to_wart')}
                  title="Portal this wWART, burn, 3P-pay native WART"
                >
                  Swap wWART → WART
                </button>
              </div>
              {!signer && owner ? (
                <p className="fp-swap-hint" style={{ color: '#f0c674' }}>
                  Connect MetaMask to finish the swap.
                </p>
              ) : null}
            </>
          )}

          {actionStatus ? (
            <div
              role="status"
              style={{
                margin: '0 0 0.65rem',
                padding: '0.5rem 0.65rem',
                borderRadius: 8,
                fontSize: '0.78rem',
                lineHeight: 1.4,
                border:
                  actionStatus.kind === 'err'
                    ? '1px solid rgba(255,120,100,0.55)'
                    : actionStatus.kind === 'ok'
                      ? '1px solid rgba(0,255,204,0.45)'
                      : '1px solid rgba(240,198,116,0.5)',
                background:
                  actionStatus.kind === 'err'
                    ? 'rgba(60,16,12,0.85)'
                    : actionStatus.kind === 'ok'
                      ? 'rgba(0,40,36,0.85)'
                      : 'rgba(40,30,0,0.85)',
                color:
                  actionStatus.kind === 'err'
                    ? '#ffb4a2'
                    : actionStatus.kind === 'ok'
                      ? '#7dffa3'
                      : '#ffe6a8',
              }}
            >
              {actionStatus.text}
            </div>
          ) : null}

          {!owner && (
            <p className="wi-muted" style={{ fontSize: '0.78rem' }}>
              Connect L1 wallet so credits attach to your address.
            </p>
          )}
          {owner && mode === 'live' && !wartBridgeApi?.address && (
            <p className="wi-muted" style={{ fontSize: '0.78rem', color: '#f0c674' }}>
              Unlock Warthog below to swap real WART.
            </p>
          )}
          {bindBlocked && (
            <p
              className="wi-muted"
              style={{ fontSize: '0.8rem', color: '#ffb4a2', marginTop: '0.45rem' }}
            >
              {wartBind?.error ||
                'This Warthog wallet is already bound to another L1 address. Switch MetaMask to that account — WART will not be sent from here.'}
            </p>
          )}
          {!bindBlocked && wartBind?.needsRegister && owner && wartFrom && (
            <p
              className="wi-muted"
              style={{ fontSize: '0.8rem', color: '#f0c674', marginTop: '0.45rem' }}
            >
              First swap will bind this Warthog wallet to {String(owner).slice(0, 10)}…
              (Warthog + MetaMask signatures).
            </p>
          )}

          <button
            type="button"
            className="fp-manual-toggle"
            onClick={() => setShowManual((v) => !v)}
            aria-expanded={showManual}
          >
            {showManual ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Manual steps
          </button>

          {showManual ? (
          <div>
          <div
            className="sw-card-meta"
            style={{ marginBottom: '0.65rem', fontSize: '0.78rem' }}
          >
            <div className="sw-meta-row">
              <span className="sw-meta-k">3P pool (send here)</span>
              <span
                className="sw-meta-v"
                style={{
                  fontFamily: 'monospace',
                  fontSize: '0.7rem',
                  wordBreak: 'break-all',
                  color: '#FDB913',
                }}
                title={poolAddr}
              >
                {poolAddr}
              </span>
            </div>
            {previousQ &&
            String(previousQ).toLowerCase() !== String(poolAddr || '').toLowerCase() ? (
              <div className="sw-meta-row">
                <span className="sw-meta-k">Previous Q (swept)</span>
                <span
                  className="sw-meta-v"
                  style={{
                    fontFamily: 'monospace',
                    fontSize: '0.7rem',
                    wordBreak: 'break-all',
                    opacity: 0.75,
                  }}
                  title="Old 3P address after rotation — do not send here"
                >
                  {previousQ}
                </span>
              </div>
            ) : null}
            {spv && (
              <div className="sw-meta-row">
                <span className="sw-meta-k">SPV</span>
                <span className="sw-meta-v" style={{ color: spv.bootstrapped ? '#7dffa3' : '#f0c674' }}>
                  {spv.bootstrapped ? 'bootstrapped' : 'not ready'}
                  {spv.minConfirmations != null ? ` · conf≥${spv.minConfirmations}` : ''}
                  {spv.bestHeight != null ? ` · h=${spv.bestHeight}` : ''}
                </span>
              </div>
            )}
            {u && (
              <>
                <div className="sw-meta-row">
                  <span className="sw-meta-k">Your deposit</span>
                  <span className="sw-meta-v">{u.depositedHuman} WART</span>
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
            {mode !== 'live' && (
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
            )}
            <span
              className="wi-muted"
              style={{
                fontSize: '0.68rem',
                fontWeight: 700,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                width: '100%',
                marginBottom: '0.1rem',
              }}
            >
              Recovery / step-by-step
            </span>
            <button
              type="button"
              className="btn secondary small"
              disabled={
                busy ||
                !owner ||
                !signer ||
                !wartBridgeApi?.sendTransaction ||
                bindBlocked
              }
              onClick={() => run('one_click_wwart')}
              title="Legacy 1-click — may skip deposit/mint if inspect already shows credit"
            >
              <Zap size={14} aria-hidden style={{ verticalAlign: -2 }} /> Get wWART (1-click)
            </button>
            <button
              type="button"
              className="btn primary small"
              disabled={busy || !owner || bindBlocked}
              onClick={() => run('deposit')}
              title={
                bindBlocked
                  ? wartBind?.error ||
                    'This Warthog wallet is bound to another L1 address'
                  : 'Send WART once; relayer credits rollup automatically'
              }
            >
              Deposit WART
            </button>
            <button
              type="button"
              className="btn secondary small"
              disabled={busy || !owner || !send || !signer}
              onClick={() => run('mint')}
              title={
                !signer
                  ? 'Connect MetaMask first — mint must come from your L1 address'
                  : 'Mint a pool claim against your credited WART'
              }
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

          {mode === 'live' && owner && (openFlows.length > 0 || pendingList.length > 0) && (
            <div
              style={{
                marginTop: '0.65rem',
                padding: '0.65rem 0.75rem',
                borderRadius: 8,
                border: '1px solid rgba(0, 255, 204, 0.4)',
                background: 'rgba(0, 40, 36, 0.92)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.4rem',
                  marginBottom: '0.35rem',
                }}
              >
                <div
                  style={{
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    color: '#00ffcc',
                  }}
                >
                  Pending pool cycle
                  <span className="wi-muted" style={{ fontWeight: 500, marginLeft: 6 }}>
                    (browser tracker — dismiss if 1-click hung)
                  </span>
                </div>
                <button
                  type="button"
                  className="btn secondary small"
                  disabled={busy}
                  title="Clear stuck 1-click / deposit trackers in this browser. Does not move WART or change rollup Available/Used/Locked."
                  onClick={() => {
                    const nFlow = wipeFlowsForOwner(owner);
                    const nPend = clearPendingForOwner(owner);
                    refreshFlows();
                    refreshPending();
                    void refresh();
                    toast.success(
                      `Cleared pipeline tracker (${nFlow} cycle row${nFlow === 1 ? '' : 's'}, ${nPend} pending)`,
                      { id: 'pool-clear-pipeline', duration: 4500 },
                    );
                  }}
                >
                  Clear stuck pipeline
                </button>
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
                      {flow.step === 'deposit_pending' ||
                      flow.step === 'credit_pending'
                        ? ' · Confirmations first — mint is the next button after Your deposit rises.'
                        : ''}
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
          </div>
          ) : null}
        </>
      )}
    </section>
  );
}
