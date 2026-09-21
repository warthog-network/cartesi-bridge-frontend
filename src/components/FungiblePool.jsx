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
  Copy,
  Check,
  Flame,
} from 'lucide-react';
import { toast } from '../utils/trackedToast.js';
import { setPipeline } from '../utils/bridgeProgress.js';
import { useUiMode } from '../utils/uiMode.js';
import { ethers } from 'ethers-v6';
import { FUNGIBLE_POOL } from '../utils/fungiblePoolConfig.js';
import { LOCAL_WWART } from '../utils/localTokens.js';
import {
  getInspectUrl,
  getRollupGraphqlUrl,
  getAddresses,
  LOCAL_ADDRESSES,
} from '../utils/bridgeConfig.js';
import {
  isV2 as rollupsIsV2,
  fetchNoticeEdges as rollupsFetchNoticeEdges,
  inspectRaw,
} from '../utils/rollupsClient.js';
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
import {
  createWarthogEthAsset,
  normalizeEthSupplyAmount,
  fetchWartAssetHoldings,
  setWethPoolScope,
  forgetUnusableWethLinks,
} from '../utils/mintEthWarthogAsset.js';
import { depositEthThroughAdapter } from '../utils/eth3pAdapter.js';

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

/** Inverse of humanFromE8. Throws on anything that is not a plain decimal. */
function e8FromHuman(raw) {
  const t = String(raw ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`Not an amount: ${t || '(empty)'}`);
  const [w, f = ''] = t.split('.');
  return BigInt(w || '0') * 10n ** 8n + BigInt((f + '00000000').slice(0, 8));
}

/**
 * "Deposited 10 WART — 9.99 credited, 0.01 bridge fee held in the Q for payout gas"
 *
 * The Q keeps the whole send; only mint headroom pays the fee (WART_FEE_BPS in
 * the machine), so a bare "Deposited 10" leaves the user to work out on their
 * own why headroom rose by less than they sent.
 *
 * Derived from the headroom delta rather than the pool_deposit notice. The
 * notice now carries feeE8/creditedE8 too, but notices can be missed, and
 * inspect is what the credit wait already returned — no extra round trip.
 * Falls back to the plain line whenever the wait came back without a deposited
 * figure (the queue-credited-late path) or the fee works out to zero.
 */
function depositToastText(amtE8, waitResult, prevDeposited, verb = 'Deposited') {
  const now = waitResult?.deposited;
  const plain = `${verb} ${humanFromE8(amtE8)} WART to pool`;
  if (now == null) return plain;
  try {
    const credited = now > prevDeposited ? now - prevDeposited : 0n;
    const fee = amtE8 > credited ? amtE8 - credited : 0n;
    if (fee <= 0n || credited <= 0n) return plain;
    return (
      `${verb} ${humanFromE8(amtE8)} WART — ${humanFromE8(credited)} credited, ` +
      `${humanFromE8(fee)} bridge fee held in the Q for payout gas`
    );
  } catch {
    return plain;
  }
}

function shortHex(v, head = 8, tail = 6) {
  const s = String(v || '').replace(/^0x/i, '');
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

async function copyText(value) {
  const s = String(value || '');
  if (!s) return false;
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real reason a 3P ticket is waiting, verbatim from the signers.
 *
 * Every browser node that declines to sign posts pool3p_skip with its reasons
 * ("waiting for Cartesi notice proof (epoch not claimed)", "local WASM is not
 * synced", …); the server keeps the latest per signer on pool3p_ticket.skips
 * and journals the same text. Until 2026-09-12 the UI never read it and said
 * "d2 is vacant" for every stall, including a server-side claimer outage.
 * Seat holders first, then orbit extras; recent entries only; deduped.
 */
function signerWaitSummary(st, { maxAgeMs = 180000, max = 3 } = {}) {
  const skips = st?.skips && typeof st.skips === 'object' ? st.skips : null;
  if (!skips) return '';
  const now = Date.now();
  const h1 = st?.members?.d1?.signerId || null;
  const h2 = st?.members?.d2?.signerId || null;
  const rank = (sid) => (sid === h1 ? 0 : sid === h2 ? 1 : 2);
  const rows = Object.entries(skips)
    .filter(
      ([, r]) =>
        r && Array.isArray(r.reasons) && r.reasons.length && now - Number(r.at || 0) <= maxAgeMs,
    )
    .sort((a, b) => rank(a[0]) - rank(b[0]) || Number(b[1].at || 0) - Number(a[1].at || 0));
  const seen = new Set();
  const out = [];
  for (const [sid, r] of rows) {
    const seat = sid === h1 ? 'd1' : sid === h2 ? 'd2' : r.role ? `orbit d${r.role}` : 'orbit';
    const text = r.reasons.join('; ');
    const key = `${seat}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${seat} ${r.client || 'signer'}: ${text}`);
    if (out.length >= max) break;
  }
  return out.join(' · ');
}

/** Timeout text built from the last observed room state, not a fixed guess. */
function payoutTimeoutMessage(ticketId, st) {
  const why = signerWaitSummary(st, { maxAgeMs: 600000, max: 4 });
  const wait = (st?.waitingOn || []).join('+') || 'signatures';
  const tail = ' The ticket stays open and pays as soon as both seats can sign; use “Report” to copy this state when asking for help.';
  if (st?.members?.d2?.live === false) {
    return `3P payout timeout for ${ticketId} — the d2 seat is vacant. Reopen the browser profile that birthed d2 (orbit extras cannot fill it).${why ? ` Signers said: ${why}.` : ''}${tail}`;
  }
  if (st?.members?.d1?.live === false) {
    return `3P payout timeout for ${ticketId} — the d1 seat is vacant. Reopen the browser profile that holds d1.${why ? ` Signers said: ${why}.` : ''}${tail}`;
  }
  if (why) {
    return `3P payout timeout for ${ticketId} — both seats are live but still waiting on ${wait}. Signers said: ${why}.${tail}`;
  }
  return `3P payout timeout for ${ticketId} — both seats are live, still waiting on ${wait}.${tail}`;
}

/**
 * Everything a maintainer asked for when a ticket stalled this week, in one
 * JSON blob: ticket state with the signers' own reasons, seat liveness, orbit
 * build versions, rotation phase, machine lag, SPV tip, and which frontend
 * build the tester was on. No secrets: pool3p_status is the public view and
 * signer ids are truncated.
 */
function buildDiagReport({ p3, ticketSt, lastTicket, owner, wartFrom, snap, eth3pSt, swapAsset }) {
  const short = (v) => (v ? String(v).slice(0, 13) : null);
  const members = (p3?.orbit?.members || []).map((m) => ({
    id: short(m.id),
    live: !!m.live,
    ageMs: m.ageMs ?? null,
    version: m.version || null,
  }));
  let ticket = null;
  if (ticketSt) {
    const id = ticketSt.ticketId || lastTicket?.ticketId || null;
    const skips = {};
    for (const [sid, r] of Object.entries(ticketSt.skips || {})) {
      skips[short(sid)] = {
        at: r?.at ? new Date(r.at).toISOString() : null,
        role: r?.role ?? null,
        client: r?.client || null,
        network: r?.network || null,
        reasons: r?.reasons || [],
        checks: r?.checks || null,
      };
    }
    ticket = {
      ticketId: id,
      ok: ticketSt.ok ?? null,
      status: ticketSt.status ?? null,
      waitingOn: ticketSt.waitingOn || null,
      haveR1: !!ticketSt.haveR1,
      haveD2: !!ticketSt.haveD2,
      members: ticketSt.members
        ? {
            d1: { ...ticketSt.members.d1, signerId: short(ticketSt.members.d1?.signerId) },
            d2: { ...ticketSt.members.d2, signerId: short(ticketSt.members.d2?.signerId) },
          }
        : null,
      lastError: ticketSt.lastError || null,
      payout: ticketSt.payout || null,
      paid: Array.isArray(ticketSt.paid)
        ? ticketSt.paid.filter((r) => r?.ticketId === id)
        : (ticketSt.paid ?? null),
      skips,
      error: ticketSt.error || null,
    };
  }
  const r = p3?.rotation || null;
  return {
    kind: 'cartesi-bridge-report',
    v: 1,
    at: new Date().toISOString(),
    build: {
      sha: import.meta.env.PUBLIC_BUILD_SHA || null,
      at: import.meta.env.PUBLIC_BUILD_AT || null,
      server: p3?.build || null,
    },
    page: typeof location !== 'undefined' ? location.href : null,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    asset: swapAsset || null,
    wallet: { l1: owner || null, warthog: wartFrom || null },
    lastTicket: lastTicket
      ? {
          ticketId: lastTicket.ticketId,
          amountE8: lastTicket.amountE8 ?? null,
          toAddress: lastTicket.toAddress || null,
        }
      : null,
    ticket,
    seats: {
      d1Live: p3?.d1Live ?? null,
      d2Live: p3?.d2Live ?? null,
      holder1: short(p3?.holder1),
      holder2: short(p3?.holder2),
      seatEpoch: p3?.seatEpoch ?? null,
      poolQ: p3?.address || null,
    },
    orbit: { liveCount: p3?.orbit?.liveCount ?? null, members },
    rotation: r
      ? {
          phase: r.phase ?? null,
          block: r.block ?? null,
          due: r.due ?? null,
          dueInEpochs: r.dueInEpochs ?? null,
          clock: r.clock ?? null,
          sweepTicketId: r.sweepTicketId ?? null,
          openUserRooms: r.openUserRooms ?? null,
          deferredForRooms: r.deferredForRooms ?? null,
          lastError: r.lastError ?? null,
          lastAt: r.last?.at ?? null,
        }
      : null,
    machine: p3?.machine || null,
    rollups: p3?.rollups
      ? { api: p3.rollups.api, app: p3.rollups.app, appName: p3.rollups.appName }
      : null,
    spv: snap?.spv
      ? {
          bootstrapped: !!snap.spv.bootstrapped,
          bestHeight: snap.spv.bestHeight ?? null,
          bestHash: snap.spv.bestHash ?? null,
        }
      : null,
    recovery: p3?.recovery
      ? { recoverable: p3.recovery.recoverable ?? null, atRisk: p3.recovery.atRisk ?? null }
      : null,
    eth3p:
      swapAsset === 'ETH' && eth3pSt
        ? { e1Live: eth3pSt.e1Live ?? null, e2Live: eth3pSt.e2Live ?? null, adapter: eth3pSt.adapter || null }
        : null,
  };
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
  // A stale bundle (built without PUBLIC_*) points at the rollups 1.x portal,
  // which has no code on the v2 Anvil: the deposit "succeeds" and moves nothing.
  try {
    const code = await signer.provider.getCode(portalAddr);
    if (!code || code === '0x') {
      throw new Error(
        `No ERC20Portal contract at ${portalAddr} on this chain — the site is serving a stale contract set. Nothing sent; hard-reload, and if it persists the frontend must be rebuilt with the v2 addresses.`,
      );
    }
  } catch (e) {
    if (/No ERC20Portal contract/.test(String(e?.message || ''))) throw e;
    /* RPC hiccup: let the deposit itself report */
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
    const err = new Error(data.error || `pool API ${res.status}`);
    // Structured hints from the server (see pool.js catch): retry loops key on
    // these rather than on message prose.
    if (data.code) err.code = String(data.code);
    if (data.retry != null) err.retry = !!data.retry;
    if (data.queued) err.queued = true;
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * The WETH asset is already on Warthog L1 by the time we register it — the SPV
 * claim is only waiting for its block. So TX_UNCONFIRMED is a wait, not a
 * failure: retry the *register* call, never the mint. A second createAssets
 * would put a second, separately-backed WETH asset on chain.
 */
const WRAP_WAIT_RE = /TX_UNCONFIRMED|not mined yet|need \d+ confs, have \d+/i;
// fetch() rejections and gateway errors: the request may never have reached the
// server, or the server was mid-wait when nginx gave up. Retry, never re-mint.
const WRAP_TRANSIENT_RE =
  /Failed to fetch|Load failed|NetworkError|network request failed|ECONN|socket|timed? ?out|pool API (0|5\d\d)/i;

async function registerWrapWhenMined(send, note) {
  const deadline = Date.now() + 600000;
  let backoff = 3000;
  for (;;) {
    try {
      return await send();
    } catch (e) {
      const msg = e?.message || String(e);
      if (e?.code === 'RECEIPT_TOO_OLD' || e?.retry === false) throw e;
      // Same three-layer confirmation vocabulary as the redeem path — a bare
      // `need N confs, have M` from the claim builder is a wait, not a failure.
      const waiting = e?.code === 'TX_UNCONFIRMED' || e?.retry === true || WRAP_WAIT_RE.test(msg);
      const transient = !waiting && WRAP_TRANSIENT_RE.test(msg);
      if ((!waiting && !transient) || Date.now() > deadline) throw e;
      if (waiting) {
        note?.(
          e?.queued
            ? 'Receipt minted; the bridge server has queued the registration and will finish it even if this tab closes. Waiting for the createAssets block…'
            : 'Waiting for the createAssets block — the receipt is minted, do not mint again…',
        );
        backoff = 3000;
      } else {
        note?.('Network hiccup while registering the receipt — retrying. The receipt is minted, do not mint again…');
        backoff = Math.min(Math.round(backoff * 1.6), 15000);
      }
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

/**
 * A minted-but-unregistered receipt outlives the tab that minted it (mobile
 * browsers freeze and discard background tabs within seconds). Remember it per
 * issuer so a reload prefills "Register wrap" instead of inviting a second mint.
 */
const ethPendingWrapKey = (issuer) =>
  `cartesi.pool.eth3p.pendingWrap.v1.${String(issuer || '').toLowerCase()}`;
function rememberPendingEthWrap(issuer, rec) {
  try {
    localStorage.setItem(ethPendingWrapKey(issuer), JSON.stringify({ ...rec, at: new Date().toISOString() }));
  } catch {
    /* storage unavailable — the server queue still covers us */
  }
}
function readPendingEthWrap(issuer) {
  try {
    const r = JSON.parse(localStorage.getItem(ethPendingWrapKey(issuer)) || 'null');
    return r && typeof r.assetTxHash === 'string' ? r : null;
  } catch {
    return null;
  }
}
function forgetPendingEthWrap(issuer) {
  try {
    localStorage.removeItem(ethPendingWrapKey(issuer));
  } catch {
    /* */
  }
}

/**
 * The burn is already on-chain and irreversible; ETH is released only once its
 * Warthog block is mined. So an unconfirmed burn is a wait, not a failure —
 * retry rather than surfacing a scary error over a burn the user cannot take
 * back. A second burn must never be sent.
 *
 * Three different messages mean the same "not deep enough yet", from three
 * layers, and all three must be caught here:
 *   BURN_UNCONFIRMED         poolEth3p.awaitBurnMined  (node's confirmations)
 *   TX_UNCONFIRMED           wartSpvHost.awaitMinedLookup
 *   need N confs, have M     wartSpvHost claim builders (depth past block)
 * The last one used to escape and toast as a hard failure — the node counts the
 * containing block while the claim builder counts depth past it, so a burn
 * mined into the head block satisfied awaitBurnMined and then died one line
 * later on `need 1 confs, have 0`. Same shape the WART relayer already treats
 * as transient (see isWaitingConfs in scripts/pool-deposit-relayer.mjs).
 */
const REDEEM_WAIT_RE = /BURN_UNCONFIRMED|TX_UNCONFIRMED|need \d+ confs, have \d+|waiting conf/i;

async function openRedeemWhenMined(body, note) {
  const deadline = Date.now() + 300000;
  let waited = 0;
  for (;;) {
    try {
      return await poolApi('/api/pool', {
        method: 'POST',
        body: JSON.stringify({ action: 'eth3p_open_redeem', ...body }),
      });
    } catch (e) {
      const msg = e?.message || String(e);
      if (!REDEEM_WAIT_RE.test(msg) || Date.now() > deadline) throw e;
      waited += 1;
      const secs = Math.round((Date.now() - (deadline - 300000)) / 1000);
      note?.(
        `Waiting for the burn block on Warthog (~30s each, ${secs}s so far) — ` +
          'the burn is already sent, no second burn needed…',
      );
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
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
    throw new Error(
      from
        ? 'Warthog is unlocked but cannot sign the bind yet — refresh the page, then retry the swap (you will sign once in Warthog and once in MetaMask)'
        : 'Unlock Warthog to bind this wallet to MetaMask before sending',
    );
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

const WART_TX_HASH_RE = /^[0-9a-f]{64}$/i;

function shortTx(hash) {
  const h = String(hash || '').replace(/^0x/i, '');
  return h ? `${h.slice(0, 12)}…` : '';
}

/** Mempool / broadcast accepted — yellow until the first Warthog confirmation. */
function toastWartSent(msg) {
  return toast(msg, {
    id: 'pool',
    duration: Infinity,
    icon: '🟡',
    style: {
      background: '#f5c518',
      color: '#111',
      border: '1px solid #c9a20a',
      fontWeight: 650,
    },
  });
}

function toastWartConfirmed(msg) {
  return toast.success(msg, {
    id: 'pool',
    duration: 12000,
    iconTheme: { primary: '#22c55e', secondary: '#052e16' },
    style: {
      background: 'rgba(6, 46, 22, 0.96)',
      color: '#bbf7d0',
      border: '1px solid #22c55e',
    },
  });
}

/**
 * Broadcast tx hash only. On Warthog the signed hashHex equals the txid, but
 * prep.hashHex exists before submit — do not treat that as a send by itself.
 */
function payoutMatchesTicket(proof, ticket) {
  if (!proof || !ticket) return true;
  const to = String(proof.toAddress || proof.transaction?.toAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const want = String(ticket.toAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (want && to && to !== want) return false;
  const amt = Number(proof.amountE8 ?? proof.transaction?.amountE8 ?? 0);
  const wantAmt = Number(ticket.amountE8 ?? 0);
  if (wantAmt > 0 && amt > 0 && amt !== wantAmt) return false;
  return true;
}

function extractBroadcastTx(st, ticket) {
  if (!st) return null;
  const status = String(st.status || '').toLowerCase();
  const paid =
    status === 'paid' ||
    st.alreadyPaid === true ||
    st.paid === true ||
    st.payout?.ok === true;
  const raw = st.txHash || st.payout?.txHash || null;
  const hex = raw ? String(raw).replace(/^0x/i, '').toLowerCase() : '';
  if (!WART_TX_HASH_RE.test(hex) || !(paid || st.payout?.txHash)) return null;
  if (ticket && !payoutMatchesTicket(st.payout || st, ticket)) return null;
  return hex;
}

async function lookupPayoutTx(txHash) {
  const h = String(txHash || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!WART_TX_HASH_RE.test(h)) return null;
  const res = await fetch(`/api/pool?lookup=${encodeURIComponent(h)}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const data = await res.json().catch(() => ({}));
  const tx = data.tx || null;
  if (!tx) return null;
  return {
    txHash: tx.txHash || h,
    confirmations: Number(tx.confirmations ?? 0),
    blockHeight: tx.blockHeight ?? null,
    toAddress: tx.toAddress || null,
    amountE8: tx.amountE8 ?? null,
  };
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
  if (rollupsIsV2()) return rollupsFetchNoticeEdges(last, { timeoutMs: 10000 });
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

/** This owner's unused credited WART (18-dec). 0 if inspect has no user. */
function ownerUnminted18(insp) {
  const dep18 = userBn(insp, 'depositedE8') * 10n ** 10n;
  const claim = userBn(insp, 'claim18');
  return dep18 > claim ? dep18 - claim : 0n;
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
  if (rollupsIsV2()) {
    try {
      const list = await fetchVouchers({ last: 40 });
      let n = 0;
      for (const v of list) {
        const s = String(v?.msgSender || '').toLowerCase();
        if (!want || s === want) n += 1;
      }
      return n;
    } catch {
      return -1;
    }
  }
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
    const data = await inspectRaw(want, { timeoutMs: 8000 });
    if (data.reports?.length) {
      const decoded = decodeInspectPayload(data.reports[0].payload);
      if (decoded && !decoded.error) return decoded;
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

function voucherAmount18(v) {
  try {
    if (v?.decoded?.amount != null) return BigInt(v.decoded.amount);
  } catch {
    /* */
  }
  try {
    const h = Number(v?.decoded?.amountHuman);
    if (Number.isFinite(h) && h > 0) return humanTo18(String(h));
  } catch {
    /* */
  }
  return 0n;
}

/**
 * Execute every ready, unexecuted wWART voucher for this owner.
 * Unclogs leftover withdraws sitting in GraphQL while 1-click tries to mint again.
 */
async function executeLeftoverOwnerVouchers(signer, owner) {
  const want = String(owner || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!signer || !want) return { amount18: 0n, hashes: [], count: 0 };
  let list = [];
  try {
    list = await fetchVouchers({ last: 50 });
  } catch {
    return { amount18: 0n, hashes: [], count: 0 };
  }
  const mine = list.filter((v) => {
    const to = String(v?.decoded?.to || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    const sender = String(v?.msgSender || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    return to === want || sender === want;
  });
  const hashes = [];
  let amount18 = 0n;
  for (const v of mine.sort((a, b) => b.inputIndex - a.inputIndex)) {
    if (!v.hasProof) continue;
    try {
      const onL1 = await isVoucherClaimedOnL1(signer, v).catch(() => false);
      if (!onL1) continue;
      const done = await wasVoucherExecuted(signer, v);
      if (done) continue;
    } catch {
      /* try execute */
    }
    try {
      const { hash } = await executeVoucherOnL1(signer, v);
      hashes.push(hash);
      amount18 += voucherAmount18(v);
    } catch (e) {
      const msg = formatVoucherExecuteError(e);
      if (/Already executed|wWART balance/i.test(msg)) continue;
      if (/rejected/i.test(msg)) throw new Error(msg);
      console.warn('[leftover voucher]', v.inputIndex, msg);
    }
  }
  return { amount18, hashes, count: hashes.length };
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
  const [swapDir, setSwapDir] = useState('to_wwart'); // to_wwart | to_wart
  const [swapAsset, setSwapAsset] = useState('WART'); // WART | ETH
  const [eth3pSt, setEth3pSt] = useState(null);
  const [mmEthBal, setMmEthBal] = useState(null);
  const [ethWartL1E8, setEthWartL1E8] = useState(null);
  /**
   * The per-receipt rows behind the WART L1 wETH total, largest first.
   *
   * The sum on its own hides the one fact that decides whether an unwrap can
   * go through: wETH is minted as separate Warthog assets and sendAsset spends
   * exactly one of them, so a wallet holding 3 + 2 cannot unwrap 5 even though
   * the total says it can. Same fetch that produces the total — no extra round
   * trip, we were already throwing the breakdown away.
   */
  const [ethReceipts, setEthReceipts] = useState([]);

  /**
   * ETH manual-steps inputs.
   *
   * Deliberately NOT the swap's `amount` / `toAddress`. The swap box takes a
   * quantity of ETH to move; these take Warthog transaction hashes for work
   * that is already half-done on chain, and mixing the two invites pasting a
   * tx hash into a field that then tries to send that much ETH. Separate
   * state, separate labels, separate placeholders.
   */
  const [ethManualAssetTx, setEthManualAssetTx] = useState('');
  const [ethManualSupply, setEthManualSupply] = useState('');
  const [ethManualBurnTx, setEthManualBurnTx] = useState('');
  const [ethMintable, setEthMintable] = useState(null);
  /** Receipt minted from this browser and not yet proved (localStorage-backed). */
  const [ethPendingWrap, setEthPendingWrap] = useState(null);
  const [swapFlipTick, setSwapFlipTick] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!swapFlipTick) return undefined;
    const t = setTimeout(() => setSwapFlipTick(0), 520);
    return () => clearTimeout(t);
  }, [swapFlipTick]);
  const [snap, setSnap] = useState(null);
  const [amount, setAmount] = useState('1');
  const [toAddress, setToAddress] = useState('');
  const [lastTicket, setLastTicket] = useState(null);
  const [mode, setMode] = useState('live'); // live | lab
  /** Path A3 threshold pool status (3-of-4 browser signers) */
  const [thresholdSt, setThresholdSt] = useState(null);
  const [pool3pSt, setPool3pSt] = useState(null);
  // Simple (default) hides operator vocabulary; Advanced is the full cockpit.
  const [uiMode, setUiMode] = useUiMode();
  const simple = uiMode !== 'advanced';
  // One verdict from five server-side signals (utils/server/bridgeHealth.mjs).
  const [health, setHealth] = useState(null);
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
  const [copiedKey, setCopiedKey] = useState('');
  const [refreshedAt, setRefreshedAt] = useState(null);
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

  // Mirror the persistent round-trip rows into the Bridge activity tracker
  // so the stage rail is visible outside this (collapsed) legacy section.
  useEffect(() => {
    setPipeline(openFlows);
  }, [openFlows]);

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
              lockedE8: insp.user?.depositedE8 ?? insp.lockedE8,
              lockedHuman: humanFromE8(insp.user?.depositedE8 ?? insp.lockedE8),
              capacity18: insp.capacity18,
              claimed18: insp.user?.claim18 ?? insp.claimed18,
              available18: insp.user?.available18 ?? insp.available18,
              availableHuman: humanFrom18(
                insp.user?.available18 ?? insp.available18,
              ),
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
    let e3 = null;
    try {
      e3 = await poolApi('/api/pool', {
        method: 'POST',
        body: JSON.stringify({ action: 'eth3p_status' }),
      });
      if (e3?.ok) setEth3pSt(e3);
    // Stamp new entries with the live Q. Does not forget anything: receipts
    // survive rotation, so the Q is provenance, not an expiry date.
    if (e3?.address) setWethPoolScope(e3.address);
    } catch {
      /* optional */
    }
    try {
      if (signer?.provider && owner) {
        const wei = await signer.provider.getBalance(owner);
        setMmEthBal(ethers.formatEther(wei));
      }
    } catch {
      /* optional */
    }
    try {
      const wart = String(wartBridgeApi?.address || '')
        .replace(/^0x/i, '')
        .toLowerCase();
      if (wart) {
        const extra = (e3?.wraps || []).map((w) => w.assetHash);
        const hold = await fetchWartAssetHoldings(
          wart,
          extra,
          wartBridgeApi?.selectedNode,
        );
        let sum = 0n;
        const rows = [];
        for (const h of hold) {
          const name = String(h.name || '').toUpperCase();
          if (name !== 'WETH' && !extra.includes(h.hash)) continue;
          const e8 = BigInt(h.e8 || 0);
          sum += e8;
          if (e8 > 0n) {
            const wrap = (e3?.wraps || []).find((w) => w.assetHash === h.hash);
            rows.push({
              hash: h.hash,
              name: name || 'WETH',
              e8: e8.toString(),
              // Only set for receipts this pool minted; a receipt someone sent
              // us from another Q is still spendable and still ours to show.
              mine: !!wrap && String(wrap.issuerWart || '').toLowerCase() === wart,
              lockTx: wrap?.ethTxHash || null,
            });
          }
        }
        rows.sort((a, b) => (BigInt(a.e8) < BigInt(b.e8) ? 1 : BigInt(a.e8) > BigInt(b.e8) ? -1 : 0));
        /**
         * Now that we know what is actually held and what the coordinator still
         * lists, drop the local entries that are neither. This runs here rather
         * than on the status read because those two lists are the only evidence
         * that separates a dead receipt from one that simply outlived its Q.
         */
        const gone = forgetUnusableWethLinks({
          heldHashes: rows.map((r) => r.hash),
          knownHashes: extra,
        });
        if (gone.forgotten) {
          console.info(`[eth3p] forgot ${gone.forgotten} unusable WETH link(s)`);
        }
        setEthReceipts(rows);
        setEthWartL1E8(sum.toString());
      } else {
        setEthReceipts([]);
        setEthWartL1E8(null);
      }
    } catch {
      /* optional */
    }
    // Prefer rollup inspect
    try {
      const path = owner
        ? `pool/${String(owner).replace(/^0x/i, '').toLowerCase()}`
        : 'pool';
      const data = await inspectRaw(path, { timeoutMs: 8000 });
      if (data.reports?.length) {
        const json = decodeInspectPayload(data.reports[0].payload);
        if (json && !json.error) {
          const user = json.user || null;
          const lockedE8 = user?.depositedE8 ?? (owner ? '0' : json.lockedE8);
          const claimed18 = user?.claim18 ?? (owner ? '0' : json.claimed18);
          const available18 =
            user?.available18 ??
            (owner ? '0' : json.available18);
          setSnap({
            poolId: json.poolId,
            poolAddress: json.poolAddress || FUNGIBLE_POOL.address,
            reservedMint: json.reservedMint !== false,
            globalLockedE8: json.globalLockedE8 ?? json.lockedE8,
            globalClaimed18: json.globalClaimed18 ?? json.claimed18,
            lockedE8,
            claimed18,
            available18,
            redeemedE8: user?.redeemedE8 ?? json.redeemedE8,
            freeableE8: user?.freeableE8 ?? json.freeableE8,
            lockedHuman: humanFromE8(lockedE8),
            capacityHuman: humanFrom18(json.capacity18),
            claimedHuman: humanFrom18(claimed18),
            availableHuman: humanFrom18(available18),
            redeemedHuman: humanFromE8(user?.redeemedE8 ?? json.redeemedE8),
            freeableHuman: humanFromE8(user?.freeableE8 ?? json.freeableE8),
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
          setRefreshedAt(Date.now());
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
      setRefreshedAt(Date.now());
    } catch (e) {
      console.warn('[FungiblePool] api', e?.message || e);
    }
  }, [owner, signer, wartBridgeApi?.address, wartBridgeApi?.selectedNode]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const h = await poolApi('/api/pool', {
          method: 'POST',
          body: JSON.stringify({ action: 'bridge_health' }),
        });
        if (!stop && h?.level) setHealth(h);
      } catch {
        /* keep the last verdict */
      }
    };
    tick();
    const t = setInterval(tick, 20000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

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

  const pollConfirm = async (txHash, need = 1, { timeoutMs } = {}) => {
    if (!wartBridgeApi?.getWartTxProof) return null;
    const deadline = Date.now() + Math.max(timeoutMs || (need > 1 ? 360000 : 180000), 30000);
    let last = null;
    while (Date.now() < deadline) {
      try {
        const proof = await wartBridgeApi.getWartTxProof(txHash);
        last = proof;
        const conf = proof?.transaction?.confirmations ?? proof?.confirmations ?? 0;
        if (Number(conf) >= need) return proof;
      } catch {
        /* retry */
      }
      await sleep(3000);
    }
    return last || wartBridgeApi.getWartTxProof(txHash);
  };

  const pollPayoutConfirm = async (txHash, { timeoutMs = 180000, expect } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        if (wartBridgeApi?.getWartTxProof) {
          const proof = slimDepositProof(await wartBridgeApi.getWartTxProof(txHash));
          last = {
            txHash,
            confirmations: Number(
              proof?.confirmations ?? proof?.transaction?.confirmations ?? 0,
            ),
            blockHeight: proof?.transaction?.blockHeight ?? null,
            toAddress: proof?.transaction?.toAddress || null,
            amountE8: proof?.transaction?.amountE8 ?? null,
          };
        } else {
          last = await lookupPayoutTx(txHash);
        }
        if (expect && last && !payoutMatchesTicket(last, expect)) {
          last = { ...last, confirmations: 0, mismatch: true };
        } else if (Number(last?.confirmations || 0) >= 1) {
          return last;
        }
      } catch {
        try {
          last = await lookupPayoutTx(txHash);
          if (expect && last && !payoutMatchesTicket(last, expect)) {
            last = { ...last, confirmations: 0, mismatch: true };
          } else if (Number(last?.confirmations || 0) >= 1) {
            return last;
          }
        } catch {
          /* retry */
        }
      }
      await sleep(3000);
    }
    if (Number(last?.confirmations || 0) < 1 && !last?.mismatch) {
      last = (await lookupPayoutTx(txHash).catch(() => null)) || last;
      if (expect && last && !payoutMatchesTicket(last, expect)) {
        last = { ...last, confirmations: 0, mismatch: true };
      }
    }
    return last;
  };

  const finishPayoutToast = async (txHash, label, expect) => {
    const amt = label ? `${label} ` : '';
    const hash = WART_TX_HASH_RE.test(String(txHash || '').replace(/^0x/i, ''))
      ? String(txHash).replace(/^0x/i, '').toLowerCase()
      : null;
    if (!hash) {
      toastWartSent(`Released ${amt}WART — waiting for broadcast hash…`);
      return { confirmations: 0, missingHash: true };
    }
    toastWartSent(`Sent ${amt}WART · ${shortTx(hash)} — waiting for block…`);
    const proof = await pollPayoutConfirm(hash, { expect });
    if (proof?.mismatch) {
      toastWartSent(
        `Coordinator cited a previous tx for this ticket id — waiting for this ${amt}payout. Do not retry.`,
      );
      return { confirmations: 0, mismatch: true, txHash: hash };
    }
    const conf = Number(proof?.confirmations || 0);
    if (conf >= 1) {
      toastWartConfirmed(`Confirmed ${amt}WART · ${shortTx(hash)} · ${conf} conf`);
      return { confirmations: conf, txHash: hash, ...proof };
    }
    toastWartSent(
      `Sent ${amt}WART · ${shortTx(hash)} — still unconfirmed. Do not retry.`,
    );
    return { confirmations: 0, txHash: hash, ...proof };
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
          // Only THIS owner's deposited balance. Global locked can rise from
          // someone else's credit and must not mark this wait as done.
          if (deposited > prevDeposited) {
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
          // Queue can flip to credited from a GraphQL notice a beat before
          // inspect shows user.depositedE8. Do not return yet — 1-click used
          // that stale 0 as "fully minted" and skipped mint.
          if (softDeadline < hardDeadline) {
            softDeadline = Math.min(Date.now() + 45000, hardDeadline);
          }
          const catchUp = 'credit landed — waiting for Your deposit on inspect…';
          if (catchUp !== lastStatusNote) {
            lastStatusNote = catchUp;
            toast.loading(`Pool credit: ${catchUp}`, { id: 'pool' });
          }
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
        if (row?.status !== 'credited' && note && note !== lastStatusNote) {
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
        if (deposited > prevDeposited) {
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
        // Last resort: queue is truth that WART was credited. Callers must
        // still poll inspect before deciding there is nothing to mint.
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
        `Anvil not reachable via wallet: ${e?.message || e}. Stay on Cartesi Bridge Anvil (31337).`,
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
      depositToastText(amtE8, result, prevDeposited, 'Credited'),
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
   * @param {{
   *   timeoutMs?: number,
   *   preview?: boolean,
   *   creditConfirm?: number,
   *   proceedConfirm?: number,
   * }} [opts]
   * creditConfirm: inclusive Warthog confs before treating proof as ready
   *   (relayer credits at 1). proceedConfirm: extra wait (atomic mint uses 2)
   *   so rollup credit is already applied before mint/withdraw.
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

    // Convert human amount → E8 early so we can queue even if proof parsing lags.
    // Integer path — do not use Number*1e8 (float drift).
    let earlyE8 = null;
    try {
      const s = humanToE8(amt);
      if (s != null && BigInt(s) > 0n) earlyE8 = Number(s);
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

    const creditAt = Math.max(1, Number(opts.creditConfirm ?? 1));
    const proceedAt = Math.max(creditAt, Number(opts.proceedConfirm ?? creditAt));

    toast.loading(
      creditAt === 1
        ? 'Waiting for 1 Warthog confirmation (rollup credits now)…'
        : `Waiting for ${creditAt} Warthog confirmations…`,
      { id: 'pool' },
    );
    let proof = await pollConfirm(txHash, creditAt);
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

    if (proceedAt > creditAt) {
      toast.loading(
        `Rollup crediting at ${creditAt} conf — waiting for confirmation ${proceedAt} before mint…`,
        { id: 'pool' },
      );
      await pollConfirm(txHash, proceedAt, { timeoutMs: 360000 });
    }

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
            toast.success(depositToastText(amtE8, again, prevDeposited), {
              id: 'pool',
            });
            return { amountE8: amtE8, txHash, source: 'optional-wallet' };
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
    toast.success(depositToastText(amtE8, result, prevDeposited), { id: 'pool' });
    return { amountE8: amtE8, txHash, source: result.source || 'inspect' };
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
    let prevClaim = userBn(before, 'claim18');
    let prevPortable = userBn(before, 'portable18');
    let avail = poolBn(before, 'available18');
    let deposited = userBn(before, 'depositedE8');
    const want18 = humanTo18(amt);
    let ownerUnminted =
      deposited * 10n ** 10n > prevClaim ? deposited * 10n ** 10n - prevClaim : 0n;
    // Cap to this owner's unused deposit. Global available can belong to
    // someone else's credited WART — do not mint it out from under them.
    let mintCap = ownerUnminted < avail ? ownerUnminted : avail;
    if (mintCap <= 0n && prevPortable <= 0n && deposited === 0n && prevClaim === 0n) {
      // Credit just landed (queue / notice) but inspect is still empty.
      toast.loading('Waiting for Your deposit on inspect before mint…', {
        id: 'pool',
        duration: Infinity,
      });
      const waited = await waitForPoolState(
        owner,
        (s) => ownerUnminted18(s) > 0n || userBn(s, 'portable18') > 0n,
        { timeoutMs: 60000, intervalMs: 1500 },
      );
      if (waited && !waited.error) {
        before = waited;
        prevClaim = userBn(before, 'claim18');
        prevPortable = userBn(before, 'portable18');
        avail = poolBn(before, 'available18');
        deposited = userBn(before, 'depositedE8');
        ownerUnminted =
          deposited * 10n ** 10n > prevClaim
            ? deposited * 10n ** 10n - prevClaim
            : 0n;
        mintCap = ownerUnminted < avail ? ownerUnminted : avail;
      }
    }
    if (mintCap <= 0n) {
      if (prevPortable > 0n) {
        toast.success(
          `Already portable ${humanFrom18(prevPortable)} — withdrawing that instead of minting`,
          { id: 'pool', duration: 8000 },
        );
        return { skipped: true, reason: 'portable', portable: prevPortable };
      }
      throw new Error(
        ownerUnminted <= 0n && (prevClaim > 0n || deposited > 0n)
          ? `Your deposit is fully minted (claim ${humanFrom18(prevClaim)}). Withdraw portable or deposit more WART — do not mint against someone else's credit.`
          : avail <= 0n && (prevClaim > 0n || deposited > 0n)
            ? `No new mint headroom (available 0). Your claim ${humanFrom18(prevClaim)} is already minted. Finish Vouchers → Execute, or deposit more WART.`
            : 'No credited pool deposit yet. Wait until Your deposit rises (Warthog confirmations + relayer) — do not send WART again. Then Mint claim.',
      );
    }
    // Explicit Mint always adds `amount` (capped to this owner's unused deposit).
    const mint18 = want18 > mintCap ? mintCap : want18;
    const mintAmt = humanFrom18(mint18);
    if (mint18 < want18) {
      toast(
        `Capping mint to ${mintAmt} (your unused deposit ${humanFrom18(ownerUnminted)}). You already hold claim ${humanFrom18(prevClaim)}.`,
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
    const rawAmt = String(amount || '').trim();
    if (!rawAmt) throw new Error('Enter amount');

    const before = (await fetchPoolInspect(owner).catch(() => null)) || {};
    const prevPortable = userBn(before, 'portable18');
    const want18 = humanTo18(rawAmt);
    if (prevPortable <= 0n) {
      throw new Error(
        'Nothing portable to withdraw. Mint a claim first. If you already withdrew, open Vouchers → Execute the ready row — do not withdraw again.',
      );
    }
    // Rollup rejects amount > portable with no new voucher. Cap so we do not
    // leave the UI pointing at an old already-listed row.
    const wd18 = want18 > prevPortable ? prevPortable : want18;
    const amt = humanFrom18(wd18);
    if (wd18 < want18) {
      toast(
        `Capping withdraw to ${amt} (portable). Extra ${humanFrom18(want18 - wd18)} has no voucher.`,
        { id: 'pool-wd-cap', duration: 9000 },
      );
    }
    const prevVouchers = await countOwnerVouchers(owner);
    const minInputIndex =
      opts.minInputIndex != null
        ? opts.minInputIndex
        : await maxOwnerVoucherInputIndex(owner);
    const seen = await snapshotNoticePayloads();
    let rejectErr = null;

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
      rejectType: ['pool_withdraw_rejected'],
      matchOwner: owner,
      seenPayloads: seen,
    }).catch((e) => {
      if (e?.notice || String(e?.message || '').startsWith('Rollup rejected')) {
        rejectErr = e;
      }
      return null;
    });

    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (rejectErr) throw rejectErr;
      try {
        const s = await fetchPoolInspect(owner);
        const portable = userBn(s, 'portable18');
        if (prevPortable > 0n && portable < prevPortable) {
          advanceFlowForOwner(owner, 'voucher_ready', { amountHuman: amt });
          refreshFlows();
          if (!opts.silentSuccess) {
            toast.success(
              `Voucher ready for ${amt} wWART — open Vouchers → Execute the newest row`,
              { id: 'pool', duration: 9000 },
            );
          }
          return { prevVoucherCount: prevVouchers, minInputIndex };
        }
        const newest = await maxOwnerVoucherInputIndex(owner);
        if (newest > minInputIndex) {
          advanceFlowForOwner(owner, 'voucher_ready', { amountHuman: amt });
          refreshFlows();
          if (!opts.silentSuccess) {
            toast.success(`New voucher #${newest} — open Vouchers → Execute`, {
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
    if (rejectErr) throw rejectErr;
    const after = (await fetchPoolInspect(owner).catch(() => null)) || {};
    const stillPortable = userBn(after, 'portable18');
    const newest = await maxOwnerVoucherInputIndex(owner);
    if (newest > minInputIndex) {
      advanceFlowForOwner(owner, 'voucher_ready', { amountHuman: amt });
      refreshFlows();
      if (!opts.silentSuccess) {
        toast.success(`New voucher #${newest} — open Vouchers → Execute`, {
          id: 'pool',
          duration: 10000,
        });
      }
      return { prevVoucherCount: prevVouchers, minInputIndex };
    }
    throw new Error(
      stillPortable >= prevPortable && prevPortable > 0n
        ? `Withdraw not accepted. Portable is still ${humanFrom18(stillPortable)} — you can only withdraw up to that. The old voucher on the list is from an earlier withdraw; Execute that if it says ready. Do not withdraw ${rawAmt} again.`
        : 'Withdraw not confirmed. Open Vouchers → Refresh and Execute the newest ready row.',
    );
  };

  /**
   * One-click Path A: finish leftover vouchers/portable first, then
   * deposit/mint/withdraw only the shortfall.
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

    const want18 = humanTo18(amt);
    toast.loading('1-click: checking leftover vouchers…', { id: 'pool' });
    const leftover = await executeLeftoverOwnerVouchers(signer, owner);
    let delivered = leftover.amount18;
    if (leftover.count) {
      toast.loading(
        `Finished ${leftover.count} leftover voucher(s) · ${humanFrom18(delivered)} wWART`,
        { id: 'pool' },
      );
      onRefreshMmWwart?.();
    }

    let insp = (await fetchPoolInspect(owner).catch(() => null)) || {};
    let claim = userBn(insp, 'claim18');
    let portable = userBn(insp, 'portable18');
    let userDep18 = userBn(insp, 'depositedE8') * 10n ** 10n;
    const avail = poolBn(insp, 'available18');

    if (delivered >= want18) {
      advanceFlowForOwner(owner, 'wwart_on_l1', { amountHuman: humanFrom18(delivered) });
      refreshFlows();
      toast.success(
        `Pipeline cleared — ${humanFrom18(delivered)} wWART already executed`,
        { id: 'pool', duration: 10000 },
      );
      return;
    }

    // Portable still sitting on the rollup — withdraw it instead of minting again.
    if (portable > 0n) {
      const minInputIndex = await maxOwnerVoucherInputIndex(owner);
      toast.loading('1-click: withdrawing leftover portable…', { id: 'pool' });
      const w = await liveWithdraw({ silentSuccess: true, minInputIndex });
      try {
        const { hash } = await waitAndExecuteWwartVoucher(signer, {
          owner,
          minInputIndex: w?.minInputIndex ?? minInputIndex,
          amountHint: humanFrom18(portable > want18 ? want18 : portable),
          timeoutMs: 180000,
        });
        delivered += portable > want18 - delivered ? want18 - delivered : portable;
        onRefreshMmWwart?.();
        if (delivered >= want18) {
          advanceFlowForOwner(owner, 'wwart_on_l1', { amountHuman: amt });
          refreshFlows();
          toast.success(
            `wWART on MetaMask · ${String(hash).slice(0, 10)}…`,
            { id: 'pool', duration: 10000 },
          );
          return;
        }
      } catch (e) {
        throw new Error(
          `${formatVoucherExecuteError(e)}. Leftover withdraw is in Vouchers — Execute that row.`,
        );
      }
      insp = (await fetchPoolInspect(owner).catch(() => null)) || {};
      claim = userBn(insp, 'claim18');
      portable = userBn(insp, 'portable18');
      userDep18 = userBn(insp, 'depositedE8') * 10n ** 10n;
    }

    const stillWant = want18 > delivered ? want18 - delivered : 0n;
    if (stillWant <= 0n) {
      advanceFlowForOwner(owner, 'wwart_on_l1', { amountHuman: amt });
      refreshFlows();
      toast.success(`wWART on MetaMask · ${humanFrom18(delivered)}`, {
        id: 'pool',
        duration: 10000,
      });
      return;
    }

    // Only deposit if this owner has no unused credit of their own.
    const unminted = userDep18 > claim ? userDep18 - claim : 0n;
    let justDeposited = false;
    if (unminted < stillWant) {
      if (!wartBridgeApi?.sendTransaction || !wartBridgeApi?.getWartTxProof) {
        throw new Error('Unlock Warthog wallet first (needed to send real WART)');
      }
      toast.loading(`1-click: depositing ${amt} WART…`, { id: 'pool' });
      await liveDeposit();
      justDeposited = true;
    } else {
      toast.loading('1-click: using your unused deposit…', { id: 'pool' });
    }

    toast.loading(
      justDeposited
        ? '1-click: waiting for Your deposit on inspect…'
        : '1-click: checking unused deposit…',
      { id: 'pool' },
    );
    insp =
      (await waitForPoolState(
        owner,
        (s) =>
          ownerUnminted18(s) > 0n ||
          userBn(s, 'portable18') >= stillWant ||
          (!justDeposited && ownerUnminted18(s) >= stillWant),
        { timeoutMs: justDeposited ? 60000 : 8000, intervalMs: 1500 },
      )) ||
      (await fetchPoolInspect(owner).catch(() => null)) ||
      {};
    portable = userBn(insp, 'portable18');
    claim = userBn(insp, 'claim18');
    userDep18 = userBn(insp, 'depositedE8') * 10n ** 10n;
    const unmintedNow = ownerUnminted18(insp);

    // Mint only this owner's unused deposit. Do not spend another user's credit.
    // A just-credited deposit must proceed to mint even if inspect is still 0.
    if (portable < stillWant && (unmintedNow > 0n || justDeposited)) {
      toast.loading('1-click: mint claim…', { id: 'pool' });
      const minted = await liveMint();
      if (minted?.skipped) {
        toast.loading('1-click: mint skipped — withdrawing portable…', { id: 'pool' });
      }
      insp = (await fetchPoolInspect(owner).catch(() => null)) || {};
      portable = userBn(insp, 'portable18');
    } else if (portable < stillWant && unmintedNow <= 0n) {
      throw new Error(
        leftover.count || delivered > 0n
          ? `Finished leftover pipeline (${humanFrom18(delivered)} wWART). Your deposit is fully minted — deposit more to swap another ${humanFrom18(stillWant)}.`
          : `Nothing left in the pipeline to swap. Your deposit is fully minted. Deposit more WART before swapping again.`,
      );
    }

    if (portable <= 0n) {
      if (delivered > 0n) {
        advanceFlowForOwner(owner, 'wwart_on_l1', { amountHuman: humanFrom18(delivered) });
        refreshFlows();
        toast.success(`Pipeline cleared — ${humanFrom18(delivered)} wWART on MetaMask`, {
          id: 'pool',
          duration: 10000,
        });
        return;
      }
      throw new Error('Nothing portable to withdraw after mint — refresh and retry');
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
    toast.loading('WART → wWART: withdraw voucher…', { id: 'pool', duration: Infinity });
    const w = await liveWithdraw({ silentSuccess: true, minInputIndex });

    toast.loading('WART → wWART: execute voucher…', {
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
        text: `WART → wWART ${amt} landed on MetaMask.`,
      });
      toast.success(`WART → wWART ${amt}`, { id: 'pool', duration: 10000 });
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
      text: `wWART → WART ${amt}…`,
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

    toast.loading(`wWART → WART: burn ${amt} and pay…`, {
      id: 'pool',
      duration: Infinity,
    });
    await liveBurn();

    setActionStatus({
      kind: 'ok',
      text: `wWART → WART ${amt} submitted to ${String(to).slice(0, 12)}…`,
    });
    toast.success(`wWART → WART ${amt}`, { id: 'pool', duration: 10000 });
    onRefreshMmWwart?.();
  };

  const liveAtomicToWeth = async () => {
    if (!owner) throw new Error('Connect L1 wallet');
    if (!signer) throw new Error('Connect MetaMask to send Anvil ETH');
    const q = eth3pSt?.address;
    if (!q) throw new Error('ETH 3P Q not sealed — turn e1 and e2 Signing ON');
    if (!wartFrom) throw new Error('Unlock Warthog wallet to mint the receipt');
    const amt = String(amount || '').trim();
    if (!amt) throw new Error('Enter amount');
    const wei = ethers.parseEther(amt);
    if (wei <= 0n) throw new Error('Amount must be > 0');

    setActionStatus({ kind: 'info', text: `ETH → wETH ${amt}…` });
    toast.loading(`Sending ${amt} ETH through the deposit adapter…`, { id: 'pool', duration: Infinity });
    const adapter = eth3pSt?.adapter;
    if (!adapter?.address) {
      throw new Error('ETH deposit adapter is not live — cannot lock');
    }
    const sent = await depositEthThroughAdapter({
      signer,
      adapter: { address: adapter.address, pool: q },
      wartAddress: wartFrom,
      value: wei,
    });
    const credited = await poolApi('/api/pool', {
      method: 'POST',
      body: JSON.stringify({
        action: 'eth3p_credit',
        ethTxHash: sent.hash,
        amountWei: wei.toString(),
        wartAddress: wartFrom,
        fromEth: owner,
      }),
    });
    await poolApi('/api/pool', {
      method: 'POST',
      body: JSON.stringify({
        action: 'eth3p_bind',
        wartAddress: wartFrom,
        ethAddress: owner,
      }),
    }).catch(() => null);

    toast.loading('Minting Warthog WETH receipt…', { id: 'pool', duration: Infinity });
    /**
     * Mint what the credit backs, not what was sent.
     *
     * The bridge fee stays in the Q to pay redeem gas (see ETH3P_FEE_BPS in
     * poolEth3p.mjs), so creditEthLock records remainingE8 = amount − fee and
     * registerEthWrap only matches a credit with remainingE8 >= supply.
     * Minting the gross figure makes it reject — but only *after* createAssets
     * has already put a brand-new WETH asset on Warthog L1, where it sits
     * orphaned and unbacked with no way to burn it for ETH.
     *
     * Prefer the credit we just created; fall back to the server's quota when
     * the credit was a replay (`already`) or the response shape surprises us.
     */
    let e8 = BigInt(credited?.credit?.remainingE8 || '0');
    if (e8 <= 0n) {
      const quota = await poolApi('/api/pool', {
        method: 'POST',
        body: JSON.stringify({ action: 'eth3p_mintable', issuerWart: wartFrom }),
      });
      e8 = BigInt(quota?.mintableE8 || '0');
    }
    if (e8 <= 0n) {
      throw new Error(
        `ETH is locked on the Q (tx ${String(sent.hash).slice(0, 12)}…) but the mintable quota is 0 — do not send ETH again; unwrap an existing receipt or contact ops.`,
      );
    }
    const supply = humanFromE8(e8);
    const minted = await createWarthogEthAsset({
      amount: supply,
      wartAddress: wartFrom,
      ownerL1: owner,
    });
    const hash = minted?.assetHash || minted?.hash;
    if (!hash) throw new Error('createAssets returned no assetHash');
    {
      const rec = { assetTxHash: minted?.txHash || hash, assetHash: hash, supplyE8: e8.toString(), supplyHuman: supply };
      rememberPendingEthWrap(wartFrom, rec);
      setEthPendingWrap(rec);
      setEthManualAssetTx(rec.assetTxHash);
      setEthManualSupply(supply);
    }
    await registerWrapWhenMined(
      () =>
        poolApi('/api/pool', {
          method: 'POST',
          keepalive: true,
          body: JSON.stringify({
            action: 'eth3p_register_wrap',
            assetHash: hash,
            supplyE8: e8.toString(),
            issuerWart: wartFrom,
            assetTxHash: minted?.txHash,
            assetName: 'WETH',
          }),
        }),
      (text) => {
        toast.loading(text, { id: 'pool', duration: Infinity });
        setActionStatus({ kind: 'info', text });
      },
    );
    forgetPendingEthWrap(wartFrom);
    setEthPendingWrap(null);
    setEthManualAssetTx('');
    setEthManualSupply('');
    const feeHuman = humanFromE8(BigInt(credited?.credit?.feeE8 || '0'));
    setActionStatus({
      kind: 'ok',
      text: `ETH → wETH ${supply} (${feeHuman} bridge fee held in the Q for redeem gas). Receipt ${String(hash).slice(0, 12)}… on Warthog.`,
    });
    toast.success(`ETH → wETH ${supply}`, { id: 'pool', duration: 10000 });
  };

  /**
   * Burn one wETH receipt into the 3P burn bin. Returns the burn hash.
   *
   * Split out of liveAtomicToEth so the step-by-step row can burn without
   * opening the redeem — the burn is the irreversible half, so its hash must
   * reach the caller (and the recover input) the moment it exists.
   */
  const burnWethToBin = async () => {
    if (!wartFrom) throw new Error('Unlock Warthog (burner of the receipt)');
    const amt = String(amount || '').trim();
    if (!amt) throw new Error('Enter amount');
    const wraps = eth3pSt?.wraps || [];
    const hold = await fetchWartAssetHoldings(
      wartFrom,
      wraps.map((w) => w.assetHash),
      wartBridgeApi?.selectedNode,
    );
    const supply = normalizeEthSupplyAmount(amt);
    const [w, f = ''] = String(supply).split('.');
    const e8 = BigInt(w || '0') * 10n ** 8n + BigInt((f + '00000000').slice(0, 8));
    const holdings = (hold || [])
      .map((h) => ({ assetHash: h.hash, e8: BigInt(h.e8 || 0) }))
      .filter((h) => h.e8 > 0n)
      .sort((a, b) => (a.e8 < b.e8 ? 1 : a.e8 > b.e8 ? -1 : 0));
    const covering = holdings.find((h) => h.e8 >= e8);
    const largest = holdings[0];
    const mine = covering || largest;
    if (!mine?.assetHash) {
      throw new Error('No wETH on this Warthog address to unwrap');
    }
    if (mine.e8 < e8) {
      throw new Error(
        `WETH is split across receipts. Largest free receipt is ${humanFromE8(mine.e8)}; you asked for ${amt}. Unwrap that amount first.`,
      );
    }
    const bin = eth3pSt?.burnBin;
    if (!bin) throw new Error('ETH 3P burn bin missing');
    if (!wartBridgeApi?.sendAsset) {
      throw new Error(
        wartFrom
          ? 'Warthog is unlocked for viewing but cannot sign a token send yet — refresh, then unlock again in this tab'
          : 'Unlock Warthog wallet (sendAsset) to burn the receipt',
      );
    }
    /**
     * Precheck BEFORE signing. sendAsset to the burn bin is irreversible; this
     * is the only point an orphaned/unbacked hash can still be refused for free.
     */
    const pre = await fetch('/api/pool', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'eth3p_precheck_burn',
        assetHash: mine.assetHash,
        amountE8: e8.toString(),
      }),
    })
      .then((r) => r.json().catch(() => ({})))
      .catch((e) => ({ ok: false, message: e?.message || String(e) }));
    if (!pre?.ok || !pre.redeemable) {
      throw new Error(
        pre?.message || pre?.error || `This WETH is not redeemable (${pre?.reason || 'unknown'})`,
      );
    }
    if (owner) {
      await poolApi('/api/pool', {
        method: 'POST',
        body: JSON.stringify({
          action: 'eth3p_bind',
          wartAddress: wartFrom,
          ethAddress: owner,
        }),
      }).catch(() => null);
    }
    toast.loading(`Sending wETH to burn bin…`, { id: 'pool', duration: Infinity });
    let sent;
    try {
      sent = await wartBridgeApi.sendAsset({
        assetHash: mine.assetHash,
        toAddress: bin,
        amount: supply,
        decimals: 8,
      });
    } catch (e) {
      const msg = e?.message || String(e);
      if (/insufficient\s+(token\s+)?balance/i.test(msg)) {
        throw new Error(
          `Only ${humanFromE8(mine.e8)} free on this WETH receipt (WART L1 is the sum of separate receipts).`,
        );
      }
      throw e;
    }
    const wartTx =
      sent?.txHash ||
      sent?.hash ||
      sent?.data?.txHash ||
      sent?.data?.hash;
    if (!wartTx) throw new Error('Burn tx submitted but no hash returned');
    return { wartTx, assetHash: mine.assetHash, e8, supply, amt };
  };

  /** wETH → ETH in one press: burn the receipt, then open and watch the redeem. */
  const liveAtomicToEth = async () => {
    const { wartTx, assetHash, e8, amt } = await burnWethToBin();
    setEthManualBurnTx(wartTx);
    toast.loading('Opening ETH 3P redeem…', { id: 'pool', duration: Infinity });
    const opened = await openRedeemWhenMined(
      {
        wartTxHash: wartTx,
        assetHash,
        amountE8: e8.toString(),
        burnerWart: wartFrom,
        ethAddress: owner,
      },
      (m) => toast.loading(m, { id: 'pool', duration: Infinity }),
    );
    const ticketId = opened.ticketId;
    toast.loading(`ETH 3P: waiting for e1 + e2 on ${ticketId}…`, {
      id: 'pool',
      duration: Infinity,
    });
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const t = await poolApi('/api/pool', {
        method: 'POST',
        body: JSON.stringify({ action: 'eth3p_ticket', ticketId }),
      });
      if (t?.status === 'paid' && t.txHash) {
        setEthManualBurnTx('');
        setActionStatus({
          kind: 'ok',
          text: `wETH → ETH ${amt}. Paid ${t.txHash.slice(0, 12)}… to ${owner?.slice(0, 10)}…`,
        });
        toast.success(`wETH → ETH ${amt}`, { id: 'pool', duration: 10000 });
        return;
      }
      const st = await poolApi('/api/pool', {
        method: 'POST',
        body: JSON.stringify({ action: 'eth3p_status' }),
      }).catch(() => null);
      const wait = [
        st?.e1Live ? 'e1 live' : 'e1 missing — ETH Signing ON on the original e1 tab',
        st?.e2Live ? 'e2 live' : 'e2 missing — ETH Signing ON on the original e2 tab',
        t?.haveR1 ? 'R1 in' : 'waiting R1',
        t?.haveD2 ? 'Enc(e2) in' : 'waiting Enc(e2)',
      ].join(' · ');
      toast.loading(`ETH 3P ${ticketId}: ${wait}`, { id: 'pool', duration: Infinity });
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(
      'ETH 3P redeem still open — original e1 and e2 tabs must have ETH Signing ON (not WART d1/d2)',
    );
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

    const expect = { toAddress: to, amountE8: ticket.amountE8 };
    const ticketId = pay.ticketId || ticket.ticketId;
    const label = pay.amountHuman || amtLabel || humanFromE8(ticket.amountE8);
    const finishThis = async (hash, extra = {}) => {
      const done = await finishPayoutToast(hash, label, expect);
      if (done?.mismatch || done?.missingHash) return null;
      await refresh();
      return { ok: true, ticketId, txHash: hash, ...extra, ...done };
    };

    if (pay.skipped) {
      toast.success(`Payout skipped: ${pay.skipReason || 'policy'}`, {
        id: 'pool',
        duration: 10000,
      });
      await refresh();
      return pay;
    }

    const firstHash = extractBroadcastTx(pay, ticket);
    if (firstHash && (pay.alreadyPaid || pay.mode === 'hot-wallet' || pay.txHash)) {
      const finished = await finishThis(firstHash, pay);
      if (finished) return finished;
    }

    // Path A4: 3P Lindell — poll pool3p_ticket until paid
    if (pay.mode === 'pool-3p' || pay.custody === '3p-d1-d2') {
      toast.loading(`3P pool: waiting for d1 + d2 on ${ticketId}…`, { id: 'pool' });
      const deadline = Date.now() + 180000;
      let first = true;
      let lastSt = null;
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
        const realTx = extractBroadcastTx(st, ticket);
        if (realTx) {
          const finished = await finishThis(realTx, { mode: 'pool-3p', ...st });
          if (finished) return finished;
          continue;
        }
        if (status === 'paid' || st.payout?.ok || st.alreadyPaid) {
          toast.loading(
            `3P Lindell · ignored old ${ticketId} hash — waiting for this payout…`,
            { id: 'pool' },
          );
          continue;
        }
        const wait = (st.waitingOn || []).join('+') || (status || 'signing');
        const d2Who = st.members?.d2?.signerId
          ? `${String(st.members.d2.signerId).slice(0, 12)}…`
          : 'no holder';
        const line = `3P Lindell · ${wait} · d1 ${st.haveR1 ? 'in' : '…'} · d2 ${st.haveD2 ? 'in' : `… (${d2Who})`}`;
        lastSt = st;
        // Say what the signers themselves reported (pool3p_ticket.skips) before
        // guessing from waitingOn; "d2 vacant" only when the seat really is.
        const why = signerWaitSummary(st);
        if (why) {
          toast.loading(`${line} — ${why}`, { id: 'pool' });
        } else if ((st.waitingOn || []).includes('notice-proof')) {
          toastWartSent(`${line} — waiting for Cartesi notice proof (L1 epoch claim)`);
        } else if (st.members?.d2?.live === false) {
          toast.loading(
            `${line} — d2 seat vacant; reopen the original d2 tab (orbit extras cannot fill it)`,
            { id: 'pool' },
          );
        } else if (st.members?.d1?.live === false) {
          toast.loading(`${line} — d1 seat vacant; reopen the original d1 tab`, { id: 'pool' });
        } else {
          toast.loading(line, { id: 'pool' });
        }
      }
      throw new Error(payoutTimeoutMessage(ticketId, lastSt));
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
        const finished = await finishThis(tx, { mode: 'threshold-3of4', ...st.paid });
        if (finished) return finished;
        continue;
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
    const prevLocked = poolBn(before, 'globalLockedE8') || poolBn(before, 'lockedE8');
    const prevGlobalClaim =
      poolBn(before, 'globalClaimed18') || poolBn(before, 'claimed18');
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

    // The rollups v2 node reflects an input in inspect ~8–15 s after it is
    // mined (longer while an epoch snapshot is being written), so the old 20 s
    // window produced "Burn not confirmed" for burns that had already gone
    // through and paid. Wait up to 60 s, and accept the burn/ticket notice as
    // proof on its own — a reject notice still throws.
    const BURN_CONFIRM_MS = 60000;
    const noticeP = waitForNotice(['pool_wwart_burned', 'pool_release_ticket'], {
      timeoutMs: BURN_CONFIRM_MS,
      rejectType: 'pool_wwart_burn_rejected',
      matchOwner: owner,
      seenPayloads: seen,
    }).catch((e) => {
      if (e?.notice || String(e?.message || '').startsWith('Rollup rejected')) throw e;
      return null;
    });

    const progressed = (s) =>
      !!s &&
      (userBn(s, 'claim18') < prevClaim ||
        userBn(s, 'depositedE8') < prevDeposited ||
        (poolBn(s, 'globalLockedE8') || poolBn(s, 'lockedE8')) < prevLocked ||
        (poolBn(s, 'globalClaimed18') || poolBn(s, 'claimed18')) <
          prevGlobalClaim ||
        userBn(s, 'redeemedE8') > userBn(before, 'redeemedE8'));

    // Race ledger polling against the notice so whichever lands first wins.
    let noticeObj = null;
    let noticeDone = false;
    noticeP.then((n) => { noticeObj = n; noticeDone = true; }, () => { noticeDone = true; });
    const after = await waitForPoolState(
      owner,
      (s) => progressed(s) || (noticeDone && !!noticeObj),
      { timeoutMs: BURN_CONFIRM_MS, intervalMs: 700 },
    );

    let burned = progressed(after);
    if (!burned) {
      // Surfaces "Rollup rejected: …" from a reject notice, or the burn notice.
      noticeObj = await noticeP;
      if (noticeObj) burned = true;
    }
    if (!burned) {
      throw new Error(
        `Burn not confirmed after ${Math.round(BURN_CONFIRM_MS / 1000)} s — the rollup has not recorded it. ` +
          'Do not resend yet: refresh and check Used — if it already dropped, the burn went through and WART is on its way. ' +
          'If MetaMask signed but Used never moves, MetaMask is on a different chain 31337; set its RPC to this site\'s /rpc and retry.',
      );
    }

    let ticket = pickReleaseTicket(noticeObj || (await noticeP.catch(() => null)), {
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
      const paid = await payoutTicket(ticket, to, humanFromE8(ticket.amountE8) || amt);
      if (Number(paid?.confirmations || 0) >= 1) {
        advanceFlowForOwner(owner, 'complete', {
          ticketId: ticket.ticketId,
          note: 'WART payout confirmed',
        });
        listOpenFlows(owner).forEach((f) => {
          if (f.step === 'complete' || f.ticketId === ticket.ticketId) {
            completeFlow(f.id, { payoutTxHash: paid?.txHash || null });
          }
        });
      } else {
        advanceFlowForOwner(owner, 'payout_pending', {
          ticketId: ticket.ticketId,
          payoutTxHash: paid?.txHash || null,
          note: 'waiting for Warthog confirmation',
        });
      }
      refreshFlows();
      return paid;
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
        'Redeem not confirmed. That step is only for your unfinished mint (portable / unused deposit). If you already hold wWART, use wWART → WART (portal + burn) — completed tokens are unbound.',
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
      const paid = await payoutTicket(ticket, to, amt);
      if (Number(paid?.confirmations || 0) >= 1) {
        listOpenFlows(owner).forEach((f) =>
          completeFlow(f.id, { ticketId: ticket.ticketId, payoutTxHash: paid?.txHash || null }),
        );
      } else {
        advanceFlowForOwner(owner, 'payout_pending', {
          ticketId: ticket.ticketId,
          payoutTxHash: paid?.txHash || null,
          note: 'waiting for Warthog confirmation',
        });
      }
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

  /**
   * Unwrapped ETH credit, per deposit.
   *
   * `mintableE8` is the LARGEST single credit, not the sum — registerEthWrap
   * decrements one credit whose remainder covers the supply, so a receipt has
   * to be minted per deposit. `totalRemainingE8` is the real stuck total, and
   * showing only the former is why a stuck balance reads smaller than it is.
   */
  const refreshEthMintable = useCallback(async () => {
    if (!wartFrom) {
      setEthMintable(null);
      return;
    }
    try {
      const m = await poolApi('/api/pool', {
        method: 'POST',
        body: JSON.stringify({ action: 'eth3p_mintable', issuerWart: wartFrom }),
      });
      setEthMintable(m?.ok ? m : null);
      // The server says this receipt is registered — drop the local reminder.
      const rec = readPendingEthWrap(wartFrom);
      if (rec && Array.isArray(m?.registeredHashes) && m.registeredHashes.includes(rec.assetTxHash)) {
        forgetPendingEthWrap(wartFrom);
        setEthPendingWrap(null);
      }
    } catch {
      setEthMintable(null);
    }
  }, [wartFrom]);

  useEffect(() => {
    void refreshEthMintable();
  }, [refreshEthMintable, eth3pSt?.address]);

  // Reload / new tab: surface a receipt this wallet minted but never registered.
  useEffect(() => {
    if (!wartFrom) {
      setEthPendingWrap(null);
      return;
    }
    const rec = readPendingEthWrap(wartFrom);
    setEthPendingWrap(rec);
    if (rec) {
      setEthManualAssetTx((cur) => cur || rec.assetTxHash);
      if (rec.supplyHuman) setEthManualSupply((cur) => cur || rec.supplyHuman);
    }
  }, [wartFrom]);

  /**
   * Step 2 of a deposit whose receipt is already minted: SPV-prove the
   * createAssets to the machine. Safe to retry — the machine keys the wrap on
   * the asset hash, so a second call cannot double-credit. Never re-mint.
   */
  const ethRegisterReceipt = async () => {
    const tx = String(ethManualAssetTx || '').replace(/^0x/i, '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(tx)) {
      throw new Error('Paste the createAssets transaction hash (64 hex)');
    }
    if (!wartFrom) throw new Error('Unlock Warthog wallet (the receipt issuer)');
    const amt = String(ethManualSupply || '').trim();
    if (!amt) throw new Error('Enter the receipt amount in wETH');
    const e8v = e8FromHuman(amt);
    if (e8v <= 0n) throw new Error('Receipt amount must be > 0');
    setActionStatus({ kind: 'info', text: `Registering ${amt} wETH receipt…` });
    toast.loading('Proving the receipt to the machine…', { id: 'pool', duration: Infinity });
    await registerWrapWhenMined(
      () =>
        poolApi('/api/pool', {
          method: 'POST',
          keepalive: true,
          body: JSON.stringify({
            action: 'eth3p_register_wrap',
            assetHash: tx,
            assetTxHash: tx,
            supplyE8: e8v.toString(),
            issuerWart: wartFrom,
            assetName: 'WETH',
          }),
        }),
      (text) => {
        toast.loading(text, { id: 'pool', duration: Infinity });
        setActionStatus({ kind: 'info', text });
      },
    );
    forgetPendingEthWrap(wartFrom);
    setEthPendingWrap(null);
    setEthManualAssetTx('');
    setEthManualSupply('');
    await refreshEthMintable();
    setActionStatus({ kind: 'ok', text: `wETH receipt ${amt} registered.` });
    toast.success(`Registered ${amt} wETH`, { id: 'pool', duration: 8000 });
  };

  /**
   * Recover a burn that reached the burn bin but never released its ETH.
   *
   * liveAtomicToEth() burns first and opens the redeem second, so anything that
   * throws in between leaves the wETH gone with no ETH and no record. Pressing
   * wETH -> ETH again would burn MORE; this claims the burn that already
   * happened. Idempotent — the ticket id derives from the burn tx hash.
   */
  const ethRecoverBurn = async () => {
    const tx = String(ethManualBurnTx || '').replace(/^0x/i, '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(tx)) {
      throw new Error('Paste the burn transaction hash (64 hex)');
    }
    if (!owner) throw new Error('Connect L1 wallet — ETH is paid to it');
    setActionStatus({ kind: 'info', text: 'Recovering stranded burn…' });
    toast.loading('Claiming the burn…', { id: 'pool', duration: Infinity });
    const opened = await openRedeemWhenMined(
      { wartTxHash: tx, burnerWart: wartFrom || undefined, ethAddress: owner },
      (m) => toast.loading(m, { id: 'pool', duration: Infinity }),
    );
    const ticketId = opened.ticketId;
    if (opened.alreadyPaid) {
      setActionStatus({ kind: 'ok', text: `Already paid (${ticketId}).` });
      toast.success('Already paid', { id: 'pool', duration: 6000 });
      return;
    }
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const t = await poolApi('/api/pool', {
        method: 'POST',
        body: JSON.stringify({ action: 'eth3p_ticket', ticketId }),
      });
      if (t?.status === 'paid' && (t.txHash || t.payout?.txHash)) {
        const h = t.txHash || t.payout?.txHash;
        setEthManualBurnTx('');
        setActionStatus({
          kind: 'ok',
          text: `Recovered. ETH paid ${String(h).slice(0, 12)}… to ${String(owner).slice(0, 10)}…`,
        });
        toast.success('Stranded burn recovered', { id: 'pool', duration: 10000 });
        void refresh();
        return;
      }
      toast.loading(
        `Ticket ${ticketId}: waiting for e1 + e2 signing…`,
        { id: 'pool', duration: Infinity },
      );
      await new Promise((r) => setTimeout(r, 2500));
    }
    throw new Error(
      `Ticket ${ticketId} is open and safe — turn ETH Signing ON in the original e1 and e2 tabs to finish it.`,
    );
  };

  /**
   * Open credits for this Warthog address, read fresh.
   *
   * Not the `ethMintable` state: the steps below chain inside one click
   * (lock → mint → register) and setState is not visible to the next line.
   */
  const fetchEthOpenCredits = async () => {
    if (!wartFrom) throw new Error('Unlock Warthog wallet (the receipt issuer)');
    const m = await poolApi('/api/pool', {
      method: 'POST',
      body: JSON.stringify({ action: 'eth3p_mintable', issuerWart: wartFrom }),
    });
    setEthMintable(m?.ok ? m : null);
    return (m?.credits || [])
      .map((c) => ({ ...c, e8: BigInt(c.remainingE8 || '0') }))
      .filter((c) => c.e8 > 0n)
      .sort((a, b) => (a.e8 < b.e8 ? 1 : a.e8 > b.e8 ? -1 : 0));
  };

  /**
   * One whole credit, exactly — never a sum and never a part.
   *
   * registerEthWrap decrements a SINGLE credit whose remainder covers the
   * supply, while the machine checks the issuer's aggregate. So a receipt
   * minted across two deposits is accepted in-machine and then matches no host
   * credit: nothing decrements and the quota keeps being offered for ETH that
   * is already spent. By the time register can complain the WETH is on Warthog
   * L1 for good, so the refusal has to happen here, before the mint.
   */
  const pickEthCredit = (open, wantE8) => {
    if (!open.length) {
      throw new Error(
        'No unwrapped ETH credit for this Warthog address — nothing to finish. Lock ETH first.',
      );
    }
    if (wantE8 == null) return open[0];
    const exact = open.find((c) => c.e8 === wantE8);
    if (!exact) {
      throw new Error(
        `No open credit of exactly ${humanFromE8(wantE8)} wETH — press "use" on one of the ` +
          'amounts listed above. A receipt spanning two deposits mints WETH nothing can back.',
      );
    }
    return exact;
  };

  /** Amount the receipt steps act on: the typed one, else the largest credit. */
  const ethWantedE8 = () => {
    const typed = String(ethManualSupply || '').trim();
    return typed ? e8FromHuman(typed) : null;
  };

  /** Stage 3: createAssets WETH for exactly `credit`, from the user's own wallet. */
  const ethMintFor = async (credit) => {
    const supply = humanFromE8(credit.e8);
    toast.loading(`Minting ${supply} wETH receipt on Warthog…`, { id: 'pool', duration: Infinity });
    const minted = await createWarthogEthAsset({
      amount: supply,
      wartAddress: wartFrom,
      ownerL1: owner,
    });
    const assetHash = minted?.assetHash || minted?.hash;
    if (!assetHash) throw new Error('createAssets returned no assetHash');
    const txHash = minted?.txHash || assetHash;
    setEthManualAssetTx(txHash);
    setEthManualSupply(supply);
    const rec = { assetTxHash: txHash, assetHash, supplyE8: credit.e8.toString(), supplyHuman: supply };
    rememberPendingEthWrap(wartFrom, rec);
    setEthPendingWrap(rec);
    return { assetHash, txHash, supply };
  };

  /** Stage 4: SPV-prove a minted receipt. Safe to retry; keyed on the asset hash. */
  const ethRegisterMinted = async ({ assetHash, txHash, e8 }) => {
    const out = await registerWrapWhenMined(
      () =>
        poolApi('/api/pool', {
          method: 'POST',
          keepalive: true,
          body: JSON.stringify({
            action: 'eth3p_register_wrap',
            assetHash,
            assetTxHash: txHash,
            supplyE8: e8.toString(),
            issuerWart: wartFrom,
            assetName: 'WETH',
          }),
        }),
      (text) => {
        toast.loading(text, { id: 'pool', duration: Infinity });
        setActionStatus({ kind: 'info', text });
      },
    );
    forgetPendingEthWrap(wartFrom);
    setEthPendingWrap(null);
    return out;
  };

  /**
   * Step 1 alone: lock ETH on the Q and credit it — no receipt.
   *
   * The only step here that moves new money. Stops one short of the mint so a
   * deposit can be made from a tab that cannot sign Warthog; the credit waits.
   */
  const ethLock = async () => {
    if (!owner) throw new Error('Connect L1 wallet');
    if (!signer) throw new Error('Connect MetaMask to send Anvil ETH');
    if (!wartFrom) throw new Error('Unlock Warthog wallet — the credit is keyed to it');
    const q = eth3pSt?.address;
    if (!q) throw new Error('ETH 3P Q not sealed — turn e1 and e2 Signing ON');
    const adapter = eth3pSt?.adapter;
    if (!adapter?.address) throw new Error('ETH deposit adapter is not live — cannot lock');
    const amt = String(amount || '').trim();
    if (!amt) throw new Error('Enter amount');
    const wei = ethers.parseEther(amt);
    if (wei <= 0n) throw new Error('Amount must be > 0');

    setActionStatus({ kind: 'info', text: `Locking ${amt} ETH on the 3P Q…` });
    toast.loading(`Sending ${amt} ETH through the deposit adapter…`, {
      id: 'pool',
      duration: Infinity,
    });
    const sent = await depositEthThroughAdapter({
      signer,
      adapter: { address: adapter.address, pool: q },
      wartAddress: wartFrom,
      value: wei,
    });
    const credited = await poolApi('/api/pool', {
      method: 'POST',
      body: JSON.stringify({
        action: 'eth3p_credit',
        ethTxHash: sent.hash,
        amountWei: wei.toString(),
        wartAddress: wartFrom,
        fromEth: owner,
      }),
    });
    await poolApi('/api/pool', {
      method: 'POST',
      body: JSON.stringify({ action: 'eth3p_bind', wartAddress: wartFrom, ethAddress: owner }),
    }).catch(() => null);
    const e8 = BigInt(credited?.credit?.remainingE8 || '0');
    // Pre-fill what the receipt must be: the credit backs amount − bridge fee,
    // and minting the gross figure is the one mistake that cannot be undone.
    if (e8 > 0n) setEthManualSupply(humanFromE8(e8));
    await refreshEthMintable();
    const label = e8 > 0n ? humanFromE8(e8) : '?';
    setActionStatus({
      kind: 'ok',
      text: `Locked ${amt} ETH (tx ${String(sent.hash).slice(0, 12)}…). Next: mint a ${label} wETH receipt.`,
    });
    toast.success(`Locked ${amt} ETH — receipt not minted yet`, { id: 'pool', duration: 10000 });
  };

  /**
   * Step 2 alone: mint the receipt, leave it unregistered.
   *
   * Fills the register input with the hash it just created, so the half-done
   * state is on screen rather than only on chain.
   */
  const ethMintReceiptOnly = async () => {
    const open = await fetchEthOpenCredits();
    const credit = pickEthCredit(open, ethWantedE8());
    const { txHash, supply } = await ethMintFor(credit);
    await refreshEthMintable();
    setActionStatus({
      kind: 'ok',
      text: `Minted ${supply} wETH receipt ${String(txHash).slice(0, 12)}… — not proved yet. Press Register wrap.`,
    });
    toast.success(`Receipt minted — now Register wrap`, { id: 'pool', duration: 10000 });
  };

  /**
   * Steps 2 + 3 for one credit: the ETH twin of Get wWART (1-click).
   *
   * Sends no ETH — it finishes a deposit already locked on the Q, which is the
   * state a closed tab leaves behind. A failure after the mint is safe: the
   * hash is in the register input and re-registering cannot double-credit.
   */
  const ethFinishWrap = async () => {
    const open = await fetchEthOpenCredits();
    const credit = pickEthCredit(open, ethWantedE8());
    setActionStatus({ kind: 'info', text: `Finishing ${humanFromE8(credit.e8)} wETH…` });
    const { assetHash, txHash, supply } = await ethMintFor(credit);
    await ethRegisterMinted({ assetHash, txHash, e8: credit.e8 });
    setEthManualAssetTx('');
    setEthManualSupply('');
    await refreshEthMintable();
    setActionStatus({
      kind: 'ok',
      text: `wETH ${supply} finished — receipt ${String(assetHash).slice(0, 12)}… registered.`,
    });
    toast.success(`Deposit finished · ${supply} wETH`, { id: 'pool', duration: 10000 });
  };

  /**
   * Step 4 alone: burn a receipt into the bin without opening the redeem.
   *
   * The burn is irreversible, so the hash goes straight into the recover input
   * — that field plus Redeem ETH is the whole recovery, and pressing burn twice
   * is what it exists to prevent.
   */
  const ethBurnReceipt = async () => {
    const { wartTx, supply } = await burnWethToBin();
    setEthManualBurnTx(wartTx);
    setActionStatus({
      kind: 'ok',
      text: `Burned ${supply} wETH (${String(wartTx).slice(0, 12)}…). No ETH yet — press Redeem ETH. Do not burn again.`,
    });
    toast.success('wETH burned — now Redeem ETH', { id: 'pool', duration: 12000 });
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
          throw new Error('Swap is live-only');
        }
        // The ETH bridge has no lab twin — labAction would answer "unknown
        // action" for every step in that block. Say why instead.
        if (action.startsWith('eth_')) {
          throw new Error('ETH · wETH steps are live-only');
        }
        await labAction(action);
      } else if (action === 'one_click_wwart') await liveOneClickToWwart();
      else if (action === 'atomic_to_wwart') await liveAtomicToWwart();
      else if (action === 'atomic_to_wart') await liveAtomicToWart();
      else if (action === 'atomic_to_weth') await liveAtomicToWeth();
      else if (action === 'atomic_to_eth') await liveAtomicToEth();
      else if (action === 'eth_lock') await ethLock();
      else if (action === 'eth_mint_receipt') await ethMintReceiptOnly();
      else if (action === 'eth_finish_wrap') await ethFinishWrap();
      else if (action === 'eth_register_receipt') await ethRegisterReceipt();
      else if (action === 'eth_burn') await ethBurnReceipt();
      else if (action === 'eth_recover_burn') await ethRecoverBurn();
      else if (action === 'bind') {
        if (!wartFrom) throw new Error('Unlock Warthog first');
        if (!owner) throw new Error('Connect MetaMask first');
        toast.loading('Sign Warthog + MetaMask to bind…', { id: 'pool' });
        const bound = await ensureWartOwnerBind({
          fromAddress: wartFrom,
          owner,
          signer,
          signWartMessage: wartBridgeApi?.signMessage,
        });
        setWartBind(bound);
        const ok = bound?.status === 'match' || bound?.ok;
        setActionStatus({
          kind: ok ? 'ok' : 'err',
          text: ok
            ? `Bound ${String(wartFrom).slice(0, 12)}… → ${String(owner).slice(0, 10)}…`
            : bound?.error || 'Bind failed',
        });
        if (ok) toast.success('WART↔ETH bound', { id: 'pool' });
        else throw new Error(bound?.error || 'Bind failed');
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
  const flashCopy = async (key, value) => {
    const ok = await copyText(value);
    if (!ok) {
      toast.error('Copy failed');
      return;
    }
    setCopiedKey(key);
    toast.success('Copied', { id: 'fp-copy', duration: 1400 });
    setTimeout(() => setCopiedKey((k) => (k === key ? '' : k)), 1600);
  };
  // "Report" chip: fresh pool3p_status + the last ticket's room (with the
  // signers' own skip reasons) + build ids, as one JSON blob on the clipboard.
  const copyReport = async () => {
    toast.loading('Collecting report…', { id: 'fp-copy' });
    let p3 = pool3pSt;
    let ticketSt = null;
    try {
      const fresh = await poolApi('/api/pool', {
        method: 'POST',
        body: JSON.stringify({ action: 'pool3p_status' }),
      });
      if (fresh) p3 = fresh;
    } catch {
      /* use the last polled status */
    }
    if (lastTicket?.ticketId) {
      try {
        ticketSt = await poolApi('/api/pool', {
          method: 'POST',
          body: JSON.stringify({ action: 'pool3p_ticket', ticketId: lastTicket.ticketId }),
        });
      } catch (e) {
        ticketSt = { error: String(e?.message || e) };
      }
    }
    const report = buildDiagReport({ p3, ticketSt, lastTicket, owner, wartFrom, snap, eth3pSt, swapAsset });
    const ok = await copyText(JSON.stringify(report, null, 2));
    if (!ok) {
      toast.error('Copy failed', { id: 'fp-copy' });
      return;
    }
    setCopiedKey('report');
    toast.success('Report copied — paste it where you ask for help', { id: 'fp-copy', duration: 2500 });
    setTimeout(() => setCopiedKey((k) => (k === 'report' ? '' : k)), 1600);
  };
  const ethUnwrapMaxE8 = (() => {
    let m = 0n;
    const wartKey = String(wartFrom || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    for (const w of eth3pSt?.wraps || []) {
      if (wartKey && String(w.issuerWart || '').toLowerCase() !== wartKey) continue;
      const o = BigInt(w.outstandingE8 || 0);
      if (o > m) m = o;
    }
    return m;
  })();
  const maxPay =
    swapAsset === 'ETH'
      ? swapDir === 'to_wwart' && mmEthBal != null && Number(mmEthBal) > 0
        ? String(mmEthBal).trim()
        : swapDir === 'to_wart' && ethUnwrapMaxE8 > 0n
          ? humanFromE8(ethUnwrapMaxE8)
          : ''
      : swapDir === 'to_wart' && mmWwartBal != null && Number(mmWwartBal) > 0
        ? String(mmWwartBal).trim()
        : '';
  const payAsset =
    swapAsset === 'ETH'
      ? swapDir === 'to_wwart'
        ? 'ETH'
        : 'wETH'
      : swapDir === 'to_wwart'
        ? 'WART'
        : 'wWART';
  const recvAsset =
    swapAsset === 'ETH'
      ? swapDir === 'to_wwart'
        ? 'wETH'
        : 'ETH'
      : swapDir === 'to_wwart'
        ? 'wWART'
        : 'WART';
  const swapTitle =
    swapAsset === 'ETH'
      ? swapDir === 'to_wwart'
        ? 'ETH → wETH'
        : 'wETH → ETH'
      : swapDir === 'to_wwart'
        ? 'WART → wWART'
        : 'wWART → WART';
  const ethQ = eth3pSt?.address || '';
  /** Is there ETH locked on the Q that never became a receipt? Gates the mint steps. */
  const ethOpenCredit = (ethMintable?.credits || []).some(
    (c) => BigInt(c.remainingE8 || '0') > 0n,
  );
  const ethLedger = (() => {
    const empty = {
      availableHuman: '0',
      lockedHuman: '0',
      usedHuman: '0',
      wartL1Human: '0',
    };
    const ownerEth = String(owner || '').toLowerCase();
    const wartKey = String(wartFrom || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    if (!ownerEth && !wartKey) return empty;
    const credits = (eth3pSt?.credits || []).filter((c) => {
      const from = String(c.fromEth || '').toLowerCase();
      const wart = String(c.wartAddress || '').toLowerCase();
      if (ownerEth && from && from === ownerEth) return true;
      if (wartKey && wart === wartKey) return true;
      return false;
    });
    const wartSet = new Set(
      credits.map((c) => String(c.wartAddress || '').toLowerCase()).filter(Boolean),
    );
    if (wartKey) wartSet.add(wartKey);
    const wraps = (eth3pSt?.wraps || []).filter((w) =>
      wartSet.has(String(w.issuerWart || '').toLowerCase()),
    );
    let available = 0n;
    for (const c of credits) {
      available += BigInt(c.remainingE8 || 0);
    }
    let used = 0n;
    for (const w of wraps) used += BigInt(w.outstandingE8 || 0);
    // Same shape as WART inspect: Locked = unused lock + still-minted claim.
    // Redeem/burn drops outstandingE8, so Locked and Used fall together.
    const locked = available + used;
    let wartL1 = used;
    // Only a real balance read can say how much is elsewhere; while wartL1
    // is just the wrap sum the gap is zero by construction.
    let elsewhere = null;
    if (ethWartL1E8 != null && ethWartL1E8 !== '') {
      try {
        wartL1 = BigInt(ethWartL1E8);
        if (used > wartL1) elsewhere = used - wartL1;
      } catch {
        /* keep wrap sum */
      }
    }
    return {
      availableHuman: humanFromE8(available),
      lockedHuman: humanFromE8(locked),
      usedHuman: humanFromE8(used),
      wartL1Human: humanFromE8(wartL1),
      /**
       * Bridge-outstanding wETH this wallet does not hold: sent, sold on the
       * DEX or deposited as liquidity. Without this line "Bridge converted"
       * and the wallet total disagree and it reads as a bug.
       */
      elsewhereHuman: elsewhere ? humanFromE8(elsewhere) : null,
    };
  })();
  /**
   * Count and largest-single-receipt, for the line under the wETH total.
   *
   * Largest is the number that actually bounds an unwrap — liveAtomicToEth
   * picks one receipt and spends it, so anything above this figure fails no
   * matter what the total reads. Showing it next to the total is what turns
   * "insufficient balance" from a surprise into something you saw coming.
   */
  const ethReceiptSummary = (() => {
    if (!ethReceipts.length) return null;
    let largest = 0n;
    let total = 0n;
    for (const r of ethReceipts) {
      const e8 = BigInt(r.e8 || 0);
      total += e8;
      if (e8 > largest) largest = e8;
    }
    return {
      count: ethReceipts.length,
      totalHuman: humanFromE8(total),
      largestHuman: humanFromE8(largest),
      split: ethReceipts.length > 1,
    };
  })();
  /**
   * What this Warthog wallet has already put in the burn bin, and how far each
   * burn got.
   *
   * The bin is keyless: once a receipt lands there it is gone whether or not
   * the ETH leg ever finishes. From the wallet's side a burn waiting on an
   * owner bind, a burn waiting on e1/e2, and a burn that already paid out look
   * identical — the receipt is simply missing. Separating them is the
   * difference between "my ETH is on the way" and "my ETH is stuck and here is
   * on what".
   *
   * Sourced from the status payload, which returns the last 20 burns. When we
   * are sitting on exactly that many the history is probably clipped, so the
   * totals get flagged as partial rather than quietly under-reporting.
   */
  const ethBinLedger = (() => {
    const wartKey = String(wartFrom || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    if (!wartKey) return null;
    const burns = (eth3pSt?.burns || []).filter(
      (b) => String(b.burnerWart || '').toLowerCase() === wartKey,
    );
    const open = (eth3pSt?.open || []).filter(
      (t) => String(t.burnerWart || '').toLowerCase() === wartKey,
    );
    if (!burns.length && !open.length) return null;
    let binned = 0n;
    let needBind = 0n;
    let needBindCount = 0;
    for (const b of burns) {
      const e8 = BigInt(b.amountE8 || 0);
      binned += e8;
      if (b.status === 'need-bind') {
        needBind += e8;
        needBindCount += 1;
      }
    }
    let pending = 0n;
    for (const t of open) pending += BigInt(t.amountE8 || 0);
    // A blocked seat is why an open ticket is not moving; ticketView already
    // works it out per ticket, so surface the first one rather than a count.
    const blocked = open.find((t) => t.blockedOn);
    return {
      count: burns.length,
      binnedHuman: humanFromE8(binned),
      pendingCount: open.length,
      pendingHuman: humanFromE8(pending),
      needBindCount,
      needBindHuman: humanFromE8(needBind),
      blockedOn: blocked?.blockedOn || null,
      blockedFault: blocked?.blockedFault || null,
      partial: (eth3pSt?.burns || []).length >= 20,
      rows: burns.slice(-6).reverse(),
    };
  })();
  const ageLabel = (() => {
    if (!refreshedAt) return null;
    const sec = Math.max(0, Math.round((Date.now() - refreshedAt) / 1000));
    if (sec < 8) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    return `${Math.round(sec / 60)}m ago`;
  })();

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
            {simple ? (swapAsset === 'ETH' ? 'ETH bridge' : 'WART bridge') : 'Fungible pool'}
          </h3>
          <span
            className="adv-only"
            style={{
              fontSize: '0.68rem',
              padding: '0.12rem 0.4rem',
              borderRadius: 6,
              background: 'rgba(0,255,204,0.15)',
              color: '#00ffcc',
              fontWeight: 700,
            }}
          >
            Path A · {swapAsset === 'ETH' ? 'ETH 3P' : 'real WART'}
          </span>
          <span
            className="adv-only"
            title={
              swapAsset === 'ETH'
                ? 'ETH lock needs d_dapp + e1 + e2. Receipt is Warthog WETH you mint.'
                : 'Release needs d_dapp + browser d1 + browser d2 (3P ECDSA). Hot key retired.'
            }
            style={{
              fontSize: '0.68rem',
              padding: '0.12rem 0.4rem',
              borderRadius: 6,
              background:
                swapAsset === 'ETH'
                  ? 'rgba(88,166,255,0.22)'
                  : 'rgba(253,185,19,0.22)',
              color: swapAsset === 'ETH' ? '#58a6ff' : '#FDB913',
              fontWeight: 700,
            }}
          >
            {swapAsset === 'ETH' ? '3P pool · e1 + e2' : '3P pool · d_dapp + d1 + d2'}
          </span>
          <span style={{ display: 'inline-flex', gap: 4, marginLeft: 4 }}>
            {['WART', 'ETH'].map((a) => (
              <button
                key={a}
                type="button"
                className={`fp-amt${swapAsset === a ? ' is-on' : ''}`}
                disabled={busy}
                onClick={() => setSwapAsset(a)}
                title={a === 'ETH' ? 'Swap Anvil ETH ↔ Warthog wETH receipt' : 'Swap WART ↔ wWART'}
              >
                {a}
              </button>
            ))}
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
          <button
            type="button"
            className="btn secondary small"
            onClick={() => setUiMode(simple ? 'advanced' : 'simple')}
            title={
              simple
                ? 'Show operator details: seats, orbit, pool address, protocol labels'
                : 'Hide operator details and use plain-language labels'
            }
          >
            {simple ? 'Advanced' : 'Simple'}
          </button>
        </div>
      </header>

      <p className="fp-status-line">
        {simple
          ? swapAsset === 'ETH'
            ? 'Lock ETH here and get the same amount of wETH on Warthog. Send wETH back to get your ETH.'
            : 'Send WART here and get the same amount of wWART on Ethereum. Send wWART back to get your WART.'
          : swapAsset === 'ETH'
            ? '1:1 ETH lock in the e1/e2 3P. You mint the Warthog wETH receipt; anyone holding it can redeem ETH.'
            : '1:1 reserved mint. Until you hold wWART, only you can mint or withdraw your deposit. After that, anyone holding the token can redeem WART.'}
        {ageLabel && !simple ? <span className="fp-status-age"> · pool {ageLabel}</span> : null}
      </p>
      <div className="fp-chip-row" aria-label="Pool status">
        {health ? (
          <span
            className={`fp-chip fp-chip-health${
              health.level === 'ok' ? ' is-ok' : health.level === 'warn' ? ' is-wait' : ' is-bad'
            }`}
            title={(health.signals || [])
              .map((s) => `${s.skipped ? '–' : s.ok ? '✓' : '✗'} ${s.label}${s.detail ? ` — ${s.detail}` : ''}`)
              .join('\n')}
          >
            {health.summary}
          </span>
        ) : null}
        <button
          type="button"
          className="fp-chip fp-chip-q adv-only"
          title={(swapAsset === 'ETH' ? ethQ : poolAddr) || 'pool address'}
          disabled={!(swapAsset === 'ETH' ? ethQ : poolAddr)}
          onClick={() => flashCopy('q', swapAsset === 'ETH' ? ethQ : poolAddr)}
        >
          {copiedKey === 'q' ? <Check size={12} /> : <Copy size={12} />}
          Q{' '}
          {swapAsset === 'ETH'
            ? ethQ
              ? shortHex(ethQ, 6, 4)
              : 'unsealed'
            : poolAddr
              ? shortHex(poolAddr, 6, 4)
              : '…'}
        </button>
        <button
          type="button"
          className="fp-chip"
          title="Copy a diagnostic report (last ticket, signer reasons, seats, orbit versions, build) to paste when asking for help"
          onClick={copyReport}
        >
          {copiedKey === 'report' ? <Check size={12} /> : <Copy size={12} />}
          Report
        </button>
        <span
          className={`fp-chip${wartBind?.status === 'match' ? ' is-ok' : bindBlocked ? ' is-bad' : ' is-wait'}`}
        >
          {wartBind?.status === 'match'
            ? simple
              ? 'Wallets linked'
              : 'Bound'
            : bindBlocked
              ? simple
                ? 'Wallet link clash'
                : 'Bind clash'
              : owner && wartFrom
                ? simple
                  ? 'Link wallets'
                  : 'Bind needed'
                : simple
                  ? 'Wallets not linked'
                  : 'Unbound'}
        </span>
        {simple ? null : swapAsset === 'ETH' && eth3pSt?.ok ? (
          <>
            <span className={`fp-chip${eth3pSt.e1Live ? ' is-ok' : ' is-wait'}`}>
              {eth3pSt.e1Live ? 'e1 live' : 'e1 wait'}
            </span>
            <span className={`fp-chip${eth3pSt.e2Live ? ' is-ok' : ' is-wait'}`}>
              {eth3pSt.e2Live ? 'e2 live' : 'e2 vacant'}
            </span>
            <span className={`fp-chip${eth3pSt.adapter?.ok && eth3pSt.adapter?.poolMatch ? ' is-ok' : ' is-wait'}`}>
              {eth3pSt.adapter?.ok && eth3pSt.adapter?.poolMatch
                ? 'adapter'
                : eth3pSt.adapter?.deployed
                  ? 'adapter sync'
                  : 'no adapter'}
            </span>
          </>
        ) : pool3pSt?.configured ? (
          <>
            <span className={`fp-chip${pool3pSt.d1Live ? ' is-ok' : ' is-wait'}`}>
              {pool3pSt.d1Live ? 'd1 live' : 'd1 wait'}
            </span>
            <span className={`fp-chip${pool3pSt.d2Live ? ' is-ok' : ' is-wait'}`}>
              {pool3pSt.d2Live ? 'd2 live' : 'd2 vacant'}
            </span>
            {pool3pSt.orbit ? (
              <span className={`fp-chip${Number(pool3pSt.orbit.liveCount) >= 4 ? ' is-ok' : ' is-wait'}`}>
                orbit {pool3pSt.orbit.liveCount || 0}
              </span>
            ) : null}
          </>
        ) : null}
        {!simple && spv ? (
          <span className={`fp-chip${spv.bootstrapped ? ' is-ok' : ' is-wait'}`}>
            SPV {spv.bootstrapped ? 'on' : 'off'}
            {spv.bestHeight != null ? ` · ${spv.bestHeight}` : ''}
          </span>
        ) : null}
      </div>

      {open && (
        <>
          <div
            className="wi-stat-grid wi-stat-grid--focus"
            style={{ marginBottom: '0.75rem' }}
          >
            <div className="wi-stat wi-stat--liquid">
              <Layers size={16} className="wi-stat-icon" />
              <span className="wi-stat-k">{simple ? 'Ready to convert' : 'Available'}</span>
              <span className="wi-stat-v">
                {swapAsset === 'ETH'
                  ? ethLedger.availableHuman
                  : (snap?.availableHuman ?? '…')}
              </span>
              <span className="wi-stat-hint">
                {simple
                  ? swapAsset === 'ETH'
                    ? 'ETH you locked, not yet turned into wETH'
                    : 'WART you sent, not yet turned into wWART'
                  : swapAsset === 'ETH'
                    ? 'your unused ETH lock'
                    : 'your unused deposit'}
              </span>
            </div>
            <div className="wi-stat">
              <span className="wi-stat-k">{simple ? 'In the bridge' : 'Locked'}</span>
              <span className="wi-stat-v">
                {swapAsset === 'ETH'
                  ? ethLedger.lockedHuman
                  : (snap?.lockedHuman ?? '…')}
              </span>
              <span className="wi-stat-hint">
                {simple
                  ? swapAsset === 'ETH'
                    ? 'ETH the bridge holds for you'
                    : 'WART the bridge holds for you'
                  : swapAsset === 'ETH'
                    ? 'your ETH still in 3P'
                    : 'your WART credited'}
              </span>
            </div>
            <div className="wi-stat">
              <span className="wi-stat-k">{simple ? 'Bridge converted' : 'Used'}</span>
              <span className="wi-stat-v">
                {swapAsset === 'ETH'
                  ? ethLedger.usedHuman
                  : (snap?.claimedHuman ?? '…')}
              </span>
              <span className="wi-stat-hint">
                {simple
                  ? swapAsset === 'ETH'
                    ? 'wETH minted from your ETH and not yet burned back, wherever it sits now'
                    : 'wWART minted from your WART and not yet burned back, wherever it sits now'
                  : swapAsset === 'ETH'
                    ? 'your unburned wETH'
                    : 'your minted claim'}
              </span>
            </div>
            <div className="wi-stat wi-stat--spoof">
              <span className="wi-stat-k">
                {simple
                  ? swapAsset === 'ETH'
                    ? 'In your Warthog wallet'
                    : 'In your Ethereum wallet'
                  : swapAsset === 'ETH'
                    ? 'WART L1 wETH'
                    : 'MetaMask wWART'}
              </span>
              <span className="wi-stat-v">
                {swapAsset === 'ETH'
                  ? ethLedger.wartL1Human
                  : mmWwartLabel}
              </span>
              <span className="wi-stat-hint">
                {swapAsset === 'ETH'
                  ? ethReceiptSummary
                    ? `${ethReceiptSummary.count} receipt${ethReceiptSummary.count === 1 ? '' : 's'}` +
                      (ethReceiptSummary.split
                        ? ` · largest ${ethReceiptSummary.largestHuman} (unwrap cap)`
                        : ' · unwrap one at a time')
                    : 'no receipts on this Warthog address'
                  : simple
                    ? 'wWART you hold right now'
                    : 'your L1 token'}
              </span>
              {swapAsset === 'ETH' && ethLedger.elsewhereHuman ? (
                <span className="wi-stat-hint wi-stat-hint--note">
                  {ethLedger.elsewhereHuman} wETH is outside your wallet (in a pool, sent, or sold)
                </span>
              ) : null}
            </div>
          </div>

          {swapAsset === 'ETH' && (ethReceiptSummary || ethBinLedger) ? (
            <div className="fp-receipts">
              <div className="fp-receipts-head">
                <span className="fp-receipts-title">
                  <Layers size={13} aria-hidden /> wETH receipts
                </span>
                <span className="fp-receipts-total">
                  {ethReceiptSummary ? `${ethReceiptSummary.totalHuman} wETH` : '0 wETH'}
                  <em>
                    {ethReceiptSummary
                      ? `across ${ethReceiptSummary.count}`
                      : 'none held'}
                  </em>
                </span>
              </div>
              {ethReceiptSummary ? (
                <ul className="fp-receipts-list">
                  {ethReceipts.map((r) => (
                    <li key={r.hash} className="fp-receipt-row">
                      <button
                        type="button"
                        className="fp-pending-hash"
                        title={`Asset ${r.hash}${r.lockTx ? ` · lock tx ${r.lockTx}` : ''}`}
                        onClick={() => flashCopy(`rcpt-${r.hash}`, r.hash)}
                      >
                        {copiedKey === `rcpt-${r.hash}` ? (
                          <Check size={12} />
                        ) : (
                          <Copy size={12} />
                        )}
                        {shortHex(r.hash, 8, 6)}
                      </button>
                      {r.mine ? null : (
                        <span className="fp-chip" title="Minted by another Warthog address and sent to you — still yours to burn">
                          received
                        </span>
                      )}
                      <span className="fp-receipt-amt">{humanFromE8(r.e8)}</span>
                      <button
                        type="button"
                        className="fp-max"
                        disabled={busy || !owner}
                        title="Unwrap exactly this receipt"
                        onClick={() => {
                          setSwapAsset('ETH');
                          setSwapDir('to_wart');
                          setAmount(humanFromE8(r.e8));
                        }}
                      >
                        UNWRAP
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="fp-receipts-empty">
                  Nothing on {wartFrom ? shortHex(wartFrom, 8, 6) : 'this Warthog address'} yet
                  — lock ETH and mint a receipt to see it here.
                </p>
              )}
              {ethReceiptSummary?.split ? (
                <p className="fp-receipts-note">
                  Separate Warthog assets, not one balance. A single unwrap spends one
                  receipt, so {ethReceiptSummary.largestHuman} is the most you can redeem in
                  one go.
                </p>
              ) : null}
              {ethBinLedger ? (
                <div className="fp-bin">
                  <div className="fp-bin-head">
                    <span className="fp-bin-title">
                      <Flame size={13} aria-hidden /> In the burn bin
                    </span>
                    <span className="fp-bin-total">
                      {ethBinLedger.binnedHuman} wETH
                      <em>
                        {ethBinLedger.count} burn{ethBinLedger.count === 1 ? '' : 's'}
                        {ethBinLedger.partial ? ' (recent)' : ''}
                      </em>
                    </span>
                  </div>
                  <div className="fp-chip-row fp-bin-chips">
                    {ethBinLedger.pendingCount ? (
                      <span className="fp-chip is-wait">
                        {ethBinLedger.pendingHuman} awaiting ETH
                        {ethBinLedger.blockedOn ? ` · blocked on e${ethBinLedger.blockedOn}` : ''}
                      </span>
                    ) : (
                      <span className="fp-chip is-ok">no redeem in flight</span>
                    )}
                    {ethBinLedger.needBindCount ? (
                      <span
                        className="fp-chip is-bad"
                        title="These burns have no 0x bound to this Warthog address, so there is nowhere to pay the ETH. Connect the wallet you want paid."
                      >
                        {ethBinLedger.needBindHuman} needs a bound 0x
                      </span>
                    ) : null}
                  </div>
                  {ethBinLedger.blockedFault ? (
                    <p className="fp-receipts-note">
                      e{ethBinLedger.blockedOn} reported: {String(ethBinLedger.blockedFault)}
                    </p>
                  ) : null}
                  {ethBinLedger.rows.length ? (
                    <ul className="fp-receipts-list fp-bin-list">
                      {ethBinLedger.rows.map((b) => (
                        <li key={b.wartTxHash || `${b.assetHash}-${b.at}`} className="fp-receipt-row">
                          <button
                            type="button"
                            className="fp-pending-hash"
                            title={`Burn tx ${b.wartTxHash || '—'} · asset ${b.assetHash}`}
                            onClick={() =>
                              flashCopy(`burn-${b.wartTxHash}`, b.wartTxHash || b.assetHash)
                            }
                          >
                            {copiedKey === `burn-${b.wartTxHash}` ? (
                              <Check size={12} />
                            ) : (
                              <Copy size={12} />
                            )}
                            {shortHex(b.wartTxHash || b.assetHash, 8, 6)}
                          </button>
                          <span
                            className={`fp-chip fp-chip-status is-${b.status === 'need-bind' ? 'pending' : 'credited'}`}
                          >
                            {b.status}
                          </span>
                          <span className="fp-receipt-amt">{humanFromE8(b.amountE8)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {mode === 'live' && (
            <div className={`fp-swap${swapFlipTick ? ' is-flipping' : ''}`}>
              <div className="fp-swap-head">
                <span className="fp-swap-title">{swapTitle}</span>
                <span className="fp-swap-peg">1 = 1</span>
              </div>
              <div className="fp-swap-leg">
                <div className="fp-swap-leg-top">
                  <span>You pay</span>
                  <span className="fp-swap-leg-meta">
                    {swapAsset === 'ETH'
                      ? swapDir === 'to_wwart'
                        ? mmEthBal
                          ? `wallet ${Number(mmEthBal).toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH`
                          : 'from MetaMask'
                        : 'from Warthog receipt'
                      : swapDir === 'to_wwart'
                        ? 'from Warthog'
                        : mmWwartLabel
                          ? `wallet ${mmWwartLabel}`
                          : 'from MetaMask'}
                    {maxPay ? (
                      <button
                        type="button"
                        className="fp-max"
                        disabled={busy || !owner}
                        onClick={() => setAmount(maxPay)}
                      >
                        MAX
                      </button>
                    ) : null}
                  </span>
                </div>
                <div className="fp-swap-row">
                  <input
                    type="text"
                    inputMode="decimal"
                    className="fp-swap-input"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !busy && owner) {
                        e.preventDefault();
                        run(
                          swapAsset === 'ETH'
                            ? swapDir === 'to_wwart'
                              ? 'atomic_to_weth'
                              : 'atomic_to_eth'
                            : swapDir === 'to_wwart'
                              ? 'atomic_to_wwart'
                              : 'atomic_to_wart',
                        );
                      }
                    }}
                    placeholder="0.0"
                    disabled={busy || !owner}
                    aria-label="Amount you pay"
                  />
                  <span
                    className={`fp-swap-asset${payAsset === 'WART' || payAsset === 'ETH' ? (payAsset === 'ETH' ? ' is-eth' : ' is-wart') : ''}`}
                  >
                    {payAsset}
                  </span>
                </div>
              </div>
              <div
                className={`fp-swap-flip${swapDir === 'to_wart' ? ' is-reverse' : ''}${swapFlipTick ? ' is-spinning' : ''}`}
                style={{
                  '--fp-from': swapDir === 'to_wart' ? '0deg' : '180deg',
                  '--fp-to': swapDir === 'to_wart' ? '180deg' : '360deg',
                }}
              >
                <button
                  type="button"
                  title="Flip direction"
                  disabled={busy}
                  onClick={() => {
                    setSwapDir((d) => (d === 'to_wwart' ? 'to_wart' : 'to_wwart'));
                    setSwapFlipTick((n) => n + 1);
                  }}
                >
                  <ArrowDownUp size={16} aria-hidden />
                </button>
              </div>
              <div className="fp-swap-leg">
                <div className="fp-swap-leg-top">
                  <span>You receive</span>
                  <span>
                    {swapAsset === 'ETH'
                      ? swapDir === 'to_wwart'
                        ? 'to Warthog'
                        : 'to MetaMask'
                      : swapDir === 'to_wwart'
                        ? 'to MetaMask'
                        : 'to Warthog'}
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
                    aria-label="Amount you receive"
                  />
                  <span
                    className={`fp-swap-asset${recvAsset === 'WART' || recvAsset === 'ETH' ? (recvAsset === 'ETH' ? ' is-eth' : ' is-wart') : ''}`}
                  >
                    {recvAsset}
                  </span>
                </div>
              </div>
              {swapDir === 'to_wart' ? (
                <div className="fp-swap-to-wrap">
                  <input
                    type="text"
                    className="fp-swap-to"
                    value={
                      swapAsset === 'ETH'
                        ? eth3pSt?.burnBin || ''
                        : toAddress
                    }
                    onChange={(e) => {
                      if (swapAsset !== 'ETH') setToAddress(e.target.value);
                    }}
                    readOnly={swapAsset === 'ETH'}
                    placeholder={
                      swapAsset === 'ETH'
                        ? 'Burn bin (Warthog, no key) — send the receipt here to redeem ETH'
                        : wartBridgeApi?.address
                          ? `WART pays to ${shortHex(wartBridgeApi.address, 10, 6)} (or paste another)`
                          : 'Warthog address to receive WART'
                    }
                    disabled={busy || !owner}
                    aria-label="Warthog address for WART payout"
                  />
                  {wartBridgeApi?.address ? (
                    <button
                      type="button"
                      className="fp-icon-btn"
                      title="Use unlocked Warthog address"
                      onClick={() => {
                        setToAddress(String(wartBridgeApi.address));
                        void flashCopy('to', wartBridgeApi.address);
                      }}
                    >
                      {copiedKey === 'to' ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {swapDir === 'to_wart' && swapAsset === 'ETH' ? (
                <p className="fp-burn-ctx">
                  {ethBinLedger ? (
                    <>
                      <strong>{wartFrom ? shortHex(wartFrom, 6, 4) : 'This wallet'}</strong> has
                      put <strong>{ethBinLedger.binnedHuman} wETH</strong> in this bin over{' '}
                      {ethBinLedger.count} burn{ethBinLedger.count === 1 ? '' : 's'}
                      {ethBinLedger.partial ? ' (recent history)' : ''}
                      {ethBinLedger.pendingCount
                        ? ` · ${ethBinLedger.pendingHuman} still awaiting ETH`
                        : ' · all settled'}
                      .
                    </>
                  ) : wartFrom ? (
                    <>
                      <strong>{shortHex(wartFrom, 6, 4)}</strong> has not burned anything into
                      this bin yet.
                    </>
                  ) : (
                    <>Unlock a Warthog wallet to see what it has burned here.</>
                  )}
                  {ethReceiptSummary?.split ? (
                    <> Max in one burn is {ethReceiptSummary.largestHuman} (largest receipt).</>
                  ) : null}
                </p>
              ) : null}
              <div className="fp-amt-chips" aria-label="Quick amounts">
                {['1', '5', '15'].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`fp-amt${amount === n ? ' is-on' : ''}`}
                    disabled={busy || !owner}
                    onClick={() => setAmount(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn secondary fp-swap-go"
                disabled={busy || !owner || !signer || !wartFrom || bindBlocked}
                onClick={() => run('bind')}
                title="Dual-sign: bind this Warthog address to the connected MetaMask account. Required before deposit/withdraw on a fresh stack."
              >
                {wartBind?.status === 'match'
                  ? simple
                    ? 'Wallets linked'
                    : `Bound ${String(wartFrom).slice(0, 8)}… → ${String(owner).slice(0, 8)}…`
                  : simple
                    ? 'Link my two wallets'
                    : 'Bind WART ↔ ETH'}
              </button>
              <p className="fp-swap-hint" style={{ marginTop: '-0.2rem' }}>
                {!owner
                  ? simple
                    ? 'Connect your Ethereum wallet (MetaMask) first.'
                    : 'Connect MetaMask to bind.'
                  : !wartFrom
                    ? simple
                      ? 'Unlock your Warthog wallet first.'
                      : 'Unlock Warthog to bind.'
                    : bindBlocked
                      ? simple
                        ? 'This Warthog wallet is already linked to a different Ethereum account.'
                        : wartBind?.error || 'This Warthog wallet is bound to another L1 account.'
                      : wartBind?.status === 'match'
                        ? simple
                          ? 'Your wallets are linked. You can swap.'
                          : 'This pair is bound. You can swap.'
                        : simple
                          ? 'One-time step: you sign once in each wallet, then you can send either way.'
                          : 'Bind once (Warthog sig + MetaMask sig), then deposit or withdraw.'}
              </p>
              <button
                type="button"
                className="btn primary fp-swap-go"
                disabled={
                  busy ||
                  !owner ||
                  !signer ||
                  (swapAsset === 'ETH'
                    ? !wartFrom || (swapDir === 'to_wwart' && !ethQ)
                    : swapDir === 'to_wwart'
                      ? !wartBridgeApi?.sendTransaction || bindBlocked
                      : !(toAddress || wartBridgeApi?.address))
                }
                onClick={() =>
                  run(
                    swapAsset === 'ETH'
                      ? swapDir === 'to_wwart'
                        ? 'atomic_to_weth'
                        : 'atomic_to_eth'
                      : swapDir === 'to_wwart'
                        ? 'atomic_to_wwart'
                        : 'atomic_to_wart',
                  )
                }
                title={
                  bindBlocked && swapDir === 'to_wwart'
                    ? wartBind?.error ||
                      'This Warthog wallet is bound to another L1 address'
                    : 'Swap the amount above'
                }
              >
                Swap
              </button>
              {!signer && owner ? (
                <p className="fp-swap-hint" style={{ color: '#f0c674' }}>
                  Connect MetaMask to finish the swap.
                </p>
              ) : null}
            </div>
          )}

          {actionStatus ? (
            <div
              role="status"
              className={`fp-banner fp-banner-${actionStatus.kind || 'info'}`}
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

          <details className="fp-legacy">
            <summary>
              Legacy paths · {swapAsset === 'ETH' ? 'ETH' : 'WART'}
              <span className="fp-legacy-tag">manual steps</span>
            </summary>
          {/*
            Recovery steps follow the asset toggle in the header: the WART
            block below (deposit → mint → withdraw → burn/redeem) and the ETH
            block after it are different bridges with different half-done
            states, so only the selected one is shown. Pressing a WART step
            while thinking in ETH is the mistake this guards against.
          */}
          {swapAsset !== 'ETH' && (
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
              title="Deposit (if needed) → mint → withdraw → execute. Uses your unused credit; will not skip mint after a successful deposit."
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
                    <li key={p.txHash} className="fp-pending-row">
                      <button
                        type="button"
                        className="fp-pending-hash"
                        title={p.txHash}
                        onClick={() => flashCopy(`tx-${p.txHash}`, p.txHash)}
                      >
                        {copiedKey === `tx-${p.txHash}` ? (
                          <Check size={12} />
                        ) : (
                          <Copy size={12} />
                        )}
                        {shortHex(p.txHash, 10, 6)}
                      </button>
                      <span className={`fp-chip fp-chip-status is-${String(p.status || 'pending')}`}>
                        {p.status}
                      </span>
                      {p.amountHuman ? (
                        <span className="fp-pending-amt">{p.amountHuman} WART</span>
                      ) : null}
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
          {import.meta.env.PUBLIC_BUILD_SHA ? (
            <p className="wi-muted" style={{ fontSize: '0.7rem' }}>
              build <code>{import.meta.env.PUBLIC_BUILD_SHA}</code>
              {pool3pSt?.build?.head && pool3pSt.build.head !== import.meta.env.PUBLIC_BUILD_SHA
                ? ` · server ${pool3pSt.build.head} — reload the page`
                : ''}
            </p>
          ) : null}
          </div>
          )}
          {/*
            ETH manual steps.

            Kept in ETH vocabulary throughout — ETH, wETH, receipt, burn bin —
            because the WART block above talks about claims, portals and
            vouchers, and the two are different bridges. Its inputs are its own:
            these take Warthog tx hashes for work already half-done on chain,
            not a quantity to send like the swap box does.

            The step row mirrors the WART one above (1-click first, then each
            stage on its own), but the stages are the ETH tunnel's four, not
            WART's: lock → mint receipt → register wrap → burn → redeem. Only
            Lock ETH moves new money; every other step finishes something the
            chain already holds.
          */}
          {swapAsset === 'ETH' && (
          <div className="fp-eth-manual">
            <div className="fp-eth-manual-head">
              ETH · wETH manual steps
              <span className="wi-muted" style={{ fontWeight: 500, marginLeft: 6 }}>
                (finish a half-done deposit or unwrap — never repeats an on-chain step)
              </span>
            </div>
            <p className="wi-muted" style={{ fontSize: '0.72rem', margin: '0 0 0.5rem' }}>
              <b>Finish wETH (1-click)</b> sends no ETH — it mints and proves the receipt for
              a deposit already locked on the Q, which is what a closed tab leaves behind.
              Starting a <i>new</i> deposit is <b>ETH → wETH</b> in the swap box above, or
              Lock ETH here.
            </p>

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0.4rem',
                alignItems: 'center',
                marginBottom: '0.55rem',
              }}
            >
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
                disabled={busy || !wartFrom || !ethOpenCredit}
                onClick={() => run('eth_finish_wrap')}
                title={
                  ethOpenCredit
                    ? 'Mint the receipt for one credited deposit and SPV-prove it. Sends no ETH; never mints twice for the same credit.'
                    : 'Nothing to finish — no ETH locked on the Q without a receipt'
                }
              >
                <Zap size={14} aria-hidden style={{ verticalAlign: -2 }} /> Finish wETH (1-click)
              </button>
              <button
                type="button"
                className="btn primary small"
                disabled={busy || !owner || !signer || !wartFrom || !eth3pSt?.adapter?.address}
                onClick={() => run('eth_lock')}
                title={`Sends ${amount || '0'} ETH to the 3P Q and credits it — the only step here that moves new money. Stops before the receipt.`}
              >
                Lock ETH
              </button>
              <button
                type="button"
                className="btn secondary small"
                disabled={busy || !wartFrom || !ethOpenCredit}
                onClick={() => run('eth_mint_receipt')}
                title="createAssets WETH for one credit, exactly. Leaves it unregistered and fills the hash in below."
              >
                Mint receipt
              </button>
              <button
                type="button"
                className="btn secondary small"
                disabled={busy || !wartFrom || !ethManualAssetTx || !ethManualSupply}
                onClick={() => run('eth_register_receipt')}
                title="SPV-prove the receipt in step 1 below to the machine. Safe to retry."
              >
                Register wrap
              </button>
              <button
                type="button"
                className="btn secondary small"
                disabled={busy || !wartFrom || !eth3pSt?.burnBin || !wartBridgeApi?.sendAsset}
                onClick={() => run('eth_burn')}
                title={`Sends ${amount || '0'} wETH to the burn bin without opening the redeem. Irreversible — the hash lands in step 2 below.`}
              >
                Burn wETH
              </button>
              <button
                type="button"
                className="btn danger small"
                disabled={busy || !owner || !ethManualBurnTx}
                onClick={() => run('eth_recover_burn')}
                title="Open (or re-open) the redeem for the burn hash in step 2 below and wait for e1 + e2. Cannot pay twice."
              >
                Redeem ETH
              </button>
              <span className="wi-muted" style={{ fontSize: '0.68rem', width: '100%' }}>
                Lock ETH and Burn wETH use the swap-box amount above
                {amount ? ` (${amount})` : ''}; the receipt steps always use one whole credit.
              </span>
            </div>

            <div className="sw-card-meta" style={{ marginBottom: '0.6rem', fontSize: '0.78rem' }}>
              <div className="sw-meta-row">
                <span className="sw-meta-k">ETH 3P pool (Q)</span>
                <span
                  className="sw-meta-v"
                  style={{ fontFamily: 'monospace', fontSize: '0.7rem', wordBreak: 'break-all', color: '#FDB913' }}
                  title={eth3pSt?.address || ''}
                >
                  {eth3pSt?.address || '—'}
                </span>
              </div>
              <div className="sw-meta-row">
                <span className="sw-meta-k">wETH burn bin</span>
                <span
                  className="sw-meta-v"
                  style={{ fontFamily: 'monospace', fontSize: '0.7rem', wordBreak: 'break-all' }}
                  title={eth3pSt?.burnBin || ''}
                >
                  {eth3pSt?.burnBin || '—'}
                </span>
              </div>
              <div className="sw-meta-row">
                <span className="sw-meta-k">Signers</span>
                <span
                  className="sw-meta-v"
                  style={{ color: eth3pSt?.e1Live && eth3pSt?.e2Live ? '#7dffa3' : '#f0c674' }}
                >
                  {eth3pSt?.e1Live ? 'e1 live' : 'e1 missing'} · {eth3pSt?.e2Live ? 'e2 live' : 'e2 missing'}
                </span>
              </div>
              {ethMintable && BigInt(ethMintable.totalRemainingE8 || '0') > 0n ? (
                <div className="sw-meta-row">
                  <span className="sw-meta-k">Deposited ETH not yet wrapped</span>
                  <span className="sw-meta-v" style={{ color: '#f0c674' }}>
                    {humanFromE8(BigInt(ethMintable.totalRemainingE8))} ETH
                  </span>
                </div>
              ) : null}
            </div>

            {ethMintable && (ethMintable.credits || []).some((c) => BigInt(c.remainingE8) > 0n) ? (
              <div className="fp-eth-manual-note">
                One receipt per deposit — mint each amount exactly, not the total:
                <ul style={{ margin: '0.3rem 0 0', paddingLeft: '1.1rem' }}>
                  {(ethMintable.credits || [])
                    .filter((c) => BigInt(c.remainingE8) > 0n)
                    .map((c) => (
                      <li key={c.id} style={{ fontSize: '0.75rem' }}>
                        <button
                          type="button"
                          className="btn secondary small"
                          style={{ padding: '0 6px', marginRight: 6 }}
                          disabled={busy}
                          title="Use this amount for the receipt below"
                          onClick={() => setEthManualSupply(humanFromE8(BigInt(c.remainingE8)))}
                        >
                          use
                        </button>
                        <b>{humanFromE8(BigInt(c.remainingE8))} wETH</b>
                        <span className="wi-muted"> — from ETH deposit {String(c.ethTxHash || '').slice(0, 12)}…</span>
                      </li>
                    ))}
                </ul>
              </div>
            ) : null}

            <div className="fp-eth-manual-step">
              <div className="fp-eth-manual-step-title">1 · Register a minted wETH receipt</div>
              <p className="wi-muted" style={{ fontSize: '0.75rem', margin: '0 0 0.4rem' }}>
                Your ETH is locked and credited but the receipt was never proved to the
                machine. Mint WETH (decimals 8) for one deposit amount in your Warthog
                wallet, then paste that createAssets hash here. Safe to retry —
                <b> never mint a second time</b>, each mint is a new unbacked asset.
              </p>
              {ethPendingWrap || (ethMintable?.pending || []).length > 0 ? (
                <p
                  className="wi-muted"
                  style={{ fontSize: '0.75rem', margin: '0 0 0.4rem', color: '#b8860b' }}
                >
                  <b>Receipt minted, not registered yet.</b>{' '}
                  {(ethMintable?.pending || []).length > 0
                    ? (ethMintable.pending || []).map((p) => (
                        <span key={p.assetTxHash}>
                          {String(p.assetTxHash).slice(0, 12)}… ({humanFromE8(BigInt(p.supplyE8 || '0'))}{' '}
                          wETH):{' '}
                          {p.state === 'expired' || p.state === 'gave-up'
                            ? `could not be registered — ${p.lastError || 'contact ops'}. `
                            : 'the bridge server has it queued and will finish it once the block is mined. '}
                        </span>
                      ))
                    : `${String(ethPendingWrap.assetTxHash).slice(0, 12)}… — press Register wrap below. `}
                  Do <b>not</b> mint again.
                </p>
              ) : null}
              <input
                type="text"
                className="input wi-portal-input"
                style={{ width: '100%', marginBottom: '0.4rem', fontSize: '0.8rem' }}
                value={ethManualAssetTx}
                onChange={(e) => setEthManualAssetTx(e.target.value)}
                placeholder="createAssets tx hash (Warthog, 64 hex)"
                disabled={busy}
              />
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  inputMode="decimal"
                  className="input wi-portal-input"
                  style={{ flex: '1 1 9rem', fontSize: '0.8rem' }}
                  value={ethManualSupply}
                  onChange={(e) => setEthManualSupply(e.target.value)}
                  placeholder="receipt amount in wETH"
                  disabled={busy}
                />
                <button
                  type="button"
                  className="btn primary small"
                  disabled={busy || !wartFrom || !ethManualAssetTx || !ethManualSupply}
                  onClick={() => run('eth_register_receipt')}
                  title="SPV-prove the createAssets to the machine and consume the ETH credit"
                >
                  Register wETH receipt
                </button>
              </div>
            </div>

            <div className="fp-eth-manual-step">
              <div className="fp-eth-manual-step-title">2 · Recover a stranded wETH burn</div>
              <p className="wi-muted" style={{ fontSize: '0.75rem', margin: '0 0 0.4rem' }}>
                Your wETH reached the burn bin but no ETH came back — the unwrap failed
                after the burn. Paste that burn hash to claim the ETH.
                <b> Do not press wETH → ETH again</b>, that burns more.
              </p>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  className="input wi-portal-input"
                  style={{ flex: '1 1 14rem', fontSize: '0.8rem' }}
                  value={ethManualBurnTx}
                  onChange={(e) => setEthManualBurnTx(e.target.value)}
                  placeholder="burn tx hash (Warthog, 64 hex)"
                  disabled={busy}
                />
                <button
                  type="button"
                  className="btn danger small"
                  disabled={busy || !owner || !ethManualBurnTx}
                  onClick={() => run('eth_recover_burn')}
                  title="Re-open the redeem for a burn already on chain — idempotent, cannot pay twice"
                >
                  Recover burn → ETH
                </button>
              </div>
            </div>
          </div>
          )}

          </details>
        </>
      )}
    </section>
  );
}
