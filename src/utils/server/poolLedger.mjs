/**
 * Path A — fungible shared pool ledger (lab / ops file store).
 *
 * Completely separate from personal 2P cosigner vaults and sub-wallets.
 * Survives FE restarts; does not touch threshold-shares or Cartesi machine state.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const POOL_ID = 'wart-pool-0';
/** Demo receive address label (not a live cosigner vault). */
export const POOL_ADDRESS =
  process.env.FUNGIBLE_POOL_ADDRESS ||
  'wartpool00000000000000000000000000000001';

const DEFAULT_PATH =
  process.env.FUNGIBLE_POOL_LEDGER ||
  '/opt/cartesi-bridge/cartesi-bridge-frontend/.data/fungible-pool.json';

const E8 = 10n ** 8n;
const E18 = 10n ** 18n;
/** E8 → 18-dec capacity units (same scale as personal mintCapacity18). */
const E8_TO_18 = 10n ** 10n;

function emptyState() {
  return {
    version: 1,
    poolId: POOL_ID,
    poolAddress: POOL_ADDRESS,
    scheme: 'wart-fungible-pool-v0',
    lockedE8: '0',
    claimed18: '0',
    redeemedE8: '0',
    nextNonce: 1,
    users: {},
    events: [],
    updatedAt: null,
  };
}

function ensureUser(state, owner) {
  const o = normOwner(owner);
  if (!state.users[o]) {
    state.users[o] = {
      depositedE8: '0',
      claim18: '0',
      portable18: '0',
      redeemedE8: '0',
    };
  }
  return state.users[o];
}

export function normOwner(owner) {
  const s = String(owner || '').trim().toLowerCase();
  if (!s) throw new Error('owner required');
  const bare = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^[a-f0-9]{40}$/.test(bare)) {
    throw new Error('owner must be 0x + 40 hex (L1 address)');
  }
  return '0x' + bare;
}

export function parseHumanToE8(human) {
  const raw = String(human ?? '').trim().replace(/,/g, '');
  if (!raw || raw.startsWith('-')) throw new Error('invalid amount');
  const [w, f = ''] = raw.split('.');
  if (!/^\d+$/.test(w || '0') || (f && !/^\d+$/.test(f))) {
    throw new Error('invalid amount');
  }
  const frac = (f + '00000000').slice(0, 8);
  return BigInt(w || '0') * E8 + BigInt(frac || '0');
}

export function parseHumanTo18(human) {
  const raw = String(human ?? '').trim().replace(/,/g, '');
  if (!raw || raw.startsWith('-')) throw new Error('invalid amount');
  const [w, f = ''] = raw.split('.');
  if (!/^\d+$/.test(w || '0') || (f && !/^\d+$/.test(f))) {
    throw new Error('invalid amount');
  }
  const frac = (f + '000000000000000000').slice(0, 18);
  return BigInt(w || '0') * E18 + BigInt(frac || '0');
}

export function formatE8(e8) {
  const n = typeof e8 === 'bigint' ? e8 : BigInt(e8 || 0);
  const neg = n < 0n;
  const x = neg ? -n : n;
  const whole = x / E8;
  let frac = (x % E8).toString().padStart(8, '0').replace(/0+$/, '');
  const body = frac ? `${whole}.${frac}` : whole.toString();
  return neg ? `-${body}` : body;
}

export function format18(v) {
  const n = typeof v === 'bigint' ? v : BigInt(v || 0);
  const neg = n < 0n;
  const x = neg ? -n : n;
  const whole = x / E18;
  let frac = (x % E18).toString().padStart(18, '0').replace(/0+$/, '');
  const body = frac ? `${whole}.${frac}` : whole.toString();
  return neg ? `-${body}` : body;
}

function bi(s) {
  try {
    return BigInt(s || 0);
  } catch {
    return 0n;
  }
}

function pushEvent(state, ev) {
  state.events.push({
    id: randomBytes(8).toString('hex'),
    ts: new Date().toISOString(),
    ...ev,
  });
  if (state.events.length > 200) state.events = state.events.slice(-200);
}

export async function loadPool(path = DEFAULT_PATH) {
  try {
    const raw = await readFile(path, 'utf8');
    const j = JSON.parse(raw);
    if (!j || j.poolId !== POOL_ID) return emptyState();
    j.users = j.users || {};
    j.events = Array.isArray(j.events) ? j.events : [];
    return j;
  } catch {
    return emptyState();
  }
}

async function savePool(state, path = DEFAULT_PATH) {
  state.updatedAt = new Date().toISOString();
  await mkdir(dirname(resolve(path)), { recursive: true });
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, path);
  return state;
}

function snapshot(state, owner = null) {
  const lockedE8 = bi(state.lockedE8);
  const claimed18 = bi(state.claimed18);
  const capacity18 = lockedE8 * E8_TO_18;
  const available18 = capacity18 > claimed18 ? capacity18 - claimed18 : 0n;

  const out = {
    ok: true,
    path: 'A',
    pathLabel: 'Fungible pool',
    note:
      'Path A lab ledger — shared pool. Does not use personal multi-sig vaults or cosigner shares.',
    poolId: state.poolId,
    poolAddress: state.poolAddress,
    scheme: state.scheme,
    lockedE8: lockedE8.toString(),
    lockedHuman: formatE8(lockedE8),
    capacity18: capacity18.toString(),
    capacityHuman: format18(capacity18),
    claimed18: claimed18.toString(),
    claimedHuman: format18(claimed18),
    available18: available18.toString(),
    availableHuman: format18(available18),
    redeemedE8: bi(state.redeemedE8).toString(),
    redeemedHuman: formatE8(bi(state.redeemedE8)),
    nextNonce: state.nextNonce,
    updatedAt: state.updatedAt,
    recentEvents: (state.events || []).slice(-25).reverse(),
  };

  if (owner) {
    try {
      const o = normOwner(owner);
      const u = state.users[o] || {
        depositedE8: '0',
        claim18: '0',
        portable18: '0',
        redeemedE8: '0',
      };
      out.user = {
        owner: o,
        depositedE8: bi(u.depositedE8).toString(),
        depositedHuman: formatE8(bi(u.depositedE8)),
        claim18: bi(u.claim18).toString(),
        claimHuman: format18(bi(u.claim18)),
        portable18: bi(u.portable18).toString(),
        portableHuman: format18(bi(u.portable18)),
        redeemedE8: bi(u.redeemedE8).toString(),
        redeemedHuman: formatE8(bi(u.redeemedE8)),
      };
    } catch {
      out.user = null;
    }
  }
  return out;
}

/**
 * @param {{ action: string, owner?: string, amount?: string, toAddress?: string, note?: string }} body
 */
export async function applyPoolAction(body, path = DEFAULT_PATH) {
  const action = String(body?.action || '').toLowerCase().trim();
  const state = await loadPool(path);

  if (action === 'status' || action === 'get') {
    return snapshot(state, body?.owner);
  }

  if (action === 'deposit') {
    const owner = normOwner(body.owner);
    const amtE8 = parseHumanToE8(body.amount);
    if (amtE8 <= 0n) throw new Error('amount must be > 0');
    const u = ensureUser(state, owner);
    state.lockedE8 = (bi(state.lockedE8) + amtE8).toString();
    u.depositedE8 = (bi(u.depositedE8) + amtE8).toString();
    pushEvent(state, {
      type: 'pool_deposit',
      owner,
      amountE8: amtE8.toString(),
      amountHuman: formatE8(amtE8),
      attestation: 'lab-owner-attested',
      note: body.note || 'Lab deposit — credits pool capacity (no cosigner vault)',
    });
    await savePool(state, path);
    return snapshot(state, owner);
  }

  if (action === 'mint') {
    const owner = normOwner(body.owner);
    const req18 = parseHumanTo18(body.amount);
    if (req18 <= 0n) throw new Error('amount must be > 0');
    const lockedE8 = bi(state.lockedE8);
    const capacity18 = lockedE8 * E8_TO_18;
    const claimed18 = bi(state.claimed18);
    const available = capacity18 > claimed18 ? capacity18 - claimed18 : 0n;
    if (available <= 0n) {
      throw new Error('no pool capacity — deposit WART (lab) first');
    }
    const mintAmt = req18 > available ? available : req18;
    const u = ensureUser(state, owner);
    state.claimed18 = (claimed18 + mintAmt).toString();
    u.claim18 = (bi(u.claim18) + mintAmt).toString();
    u.portable18 = (bi(u.portable18) + mintAmt).toString();
    pushEvent(state, {
      type: 'pool_mint',
      owner,
      amount18: mintAmt.toString(),
      amountHuman: format18(mintAmt),
      source: 'pool',
      note: 'Fungible pool claim (source=pool). Not personal vault capacity.',
    });
    await savePool(state, path);
    return snapshot(state, owner);
  }

  if (action === 'burn') {
    const owner = normOwner(body.owner);
    const amt18 = parseHumanTo18(body.amount);
    if (amt18 <= 0n) throw new Error('amount must be > 0');
    const u = ensureUser(state, owner);
    const claim = bi(u.claim18);
    const portable = bi(u.portable18);
    if (claim < amt18) throw new Error('insufficient pool claim');
    if (portable < amt18) throw new Error('insufficient portable claim (already redeemed?)');
    u.claim18 = (claim - amt18).toString();
    u.portable18 = (portable - amt18).toString();
    const g = bi(state.claimed18);
    state.claimed18 = (g > amt18 ? g - amt18 : 0n).toString();
    pushEvent(state, {
      type: 'pool_burn',
      owner,
      amount18: amt18.toString(),
      amountHuman: format18(amt18),
      note: 'Burn pool claim — capacity Available ↑ (collateral still locked until redeem)',
    });
    await savePool(state, path);
    return snapshot(state, owner);
  }

  /**
   * A-α redeem: minter-only — burn claim + release collateral from pool locked.
   * Lab records payout intent; does not call cosigner or move real WART.
   */
  if (action === 'redeem') {
    const owner = normOwner(body.owner);
    const amt18 = parseHumanTo18(body.amount);
    if (amt18 <= 0n) throw new Error('amount must be > 0');
    // Convert 18-dec claim → E8 WART (truncate to 8 dec)
    const amtE8 = amt18 / E8_TO_18;
    if (amtE8 <= 0n) throw new Error('amount too small (need ≥ 1e-8 WART)');
    const u = ensureUser(state, owner);
    const claim = bi(u.claim18);
    const portable = bi(u.portable18);
    if (claim < amt18) throw new Error('insufficient pool claim to redeem');
    if (portable < amt18) throw new Error('insufficient portable claim');
    const locked = bi(state.lockedE8);
    if (locked < amtE8) throw new Error('pool locked below redeem amount');

    u.claim18 = (claim - amt18).toString();
    u.portable18 = (portable - amt18).toString();
    u.redeemedE8 = (bi(u.redeemedE8) + amtE8).toString();
    state.claimed18 = (bi(state.claimed18) > amt18
      ? bi(state.claimed18) - amt18
      : 0n
    ).toString();
    state.lockedE8 = (locked - amtE8).toString();
    state.redeemedE8 = (bi(state.redeemedE8) + amtE8).toString();
    // Reduce depositor credit proportionally from this user if possible
    const dep = bi(u.depositedE8);
    u.depositedE8 = (dep > amtE8 ? dep - amtE8 : 0n).toString();

    const nonce = state.nextNonce++;
    const ticketId = `${POOL_ID}:${nonce}`;
    const toAddress =
      String(body.toAddress || '').trim() || 'lab-redeemer-main';
    pushEvent(state, {
      type: 'pool_release_ticket',
      ticketId,
      nonce,
      owner,
      toAddress,
      amountE8: amtE8.toString(),
      amountHuman: formatE8(amtE8),
      amount18: amt18.toString(),
      phase: 'A-alpha',
      payout: 'lab-recorded',
      note:
        'A-α redeem: minter-only. Lab recorded pool release (no cosigner, no personal vault).',
    });
    await savePool(state, path);
    return {
      ...snapshot(state, owner),
      lastTicket: {
        ticketId,
        nonce,
        amountE8: amtE8.toString(),
        amountHuman: formatE8(amtE8),
        toAddress,
        phase: 'A-alpha',
      },
    };
  }

  if (action === 'reset_lab') {
    // Ops-only soft reset of pool ledger (does not touch cosigner stores)
    const fresh = emptyState();
    pushEvent(fresh, {
      type: 'pool_reset',
      note: 'Lab ledger reset — personal vaults untouched',
    });
    await savePool(fresh, path);
    return snapshot(fresh, body?.owner);
  }

  throw new Error(
    `unknown action "${action}" (use deposit|mint|burn|redeem|status)`,
  );
}

export { DEFAULT_PATH as POOL_LEDGER_PATH };
