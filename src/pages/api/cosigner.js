/**
 * 2-of-2 multi-sig co-signer — holds d_dapp + Enc(d_user) only.
 * Full private key is NEVER assembled. Sign via Lindell 2P-ECDSA partial.
 *
 * POST action:
 *   register — dappShare + Paillier pub + ckey
 *   sign     — GraphQL pin check, then return r + ciphertext (not privateKey)
 *   policy   — outstanding only
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes as nodeRandom } from 'crypto';
import { PublicKey } from 'paillier-bigint';
import { secp256k1 } from '@noble/curves/secp256k1';

export const prerender = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../../.data');
const STORE_PATH = path.join(DATA_DIR, 'threshold-shares.json');
const CURVE_N = secp256k1.CURVE.n;

const GRAPHQL_URL =
  process.env.CARTESI_GRAPHQL_URL ||
  process.env.PUBLIC_GRAPHQL_URL ||
  'http://127.0.0.1:8080/graphql';
const INSPECT_URL =
  process.env.CARTESI_INSPECT_URL ||
  process.env.PUBLIC_INSPECT_URL ||
  'http://127.0.0.1:8080/inspect';

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify({ vaults: {} }, null, 2));
  }
}
function readStore() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return { vaults: {} };
  }
}
function writeStore(store) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
function normAddr(a) {
  return String(a || '').replace(/^0x/i, '').toLowerCase();
}
function modN(a) {
  let x = a % CURVE_N;
  if (x < 0n) x += CURVE_N;
  return x;
}
function modPow(base, exp, mod) {
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  let r = 1n;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}
function invScalar(a) {
  return modPow(modN(a), CURVE_N - 2n, CURVE_N);
}
function randomScalar() {
  for (let i = 0; i < 32; i++) {
    const bytes = nodeRandom(48);
    let x = 0n;
    for (const b of bytes) x = (x << 8n) | BigInt(b);
    x = modN(x);
    if (x > 0n) return x;
  }
  throw new Error('scalar sample failed');
}
function hexToScalar(hex) {
  const x = modN(BigInt('0x' + String(hex).replace(/^0x/i, '')));
  if (x === 0n) throw new Error('zero scalar');
  return x;
}

function decodeNoticePayload(payload) {
  if (payload == null) return null;
  try {
    if (typeof payload === 'object') return payload;
    const s = String(payload);
    if (s.trim().startsWith('{')) return JSON.parse(s);
    const hex = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
    return JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
  } catch {
    return null;
  }
}

async function fetchOutstandingFromGraphQL({ vaultAddress, subAddress }) {
  const query = `{ notices(last: 100) { edges { node { payload } } } }`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let edges = [];
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    const data = await res.json();
    if (data.errors?.length) throw new Error(data.errors[0]?.message || 'GraphQL error');
    edges = data?.data?.notices?.edges || [];
  } finally {
    clearTimeout(timer);
  }

  const vault = normAddr(vaultAddress);
  const sub = normAddr(subAddress);
  let minted = 0n;
  let burned = 0n;
  let lastRemaining = null;
  let unlocked = false;
  let matches = 0;

  for (const e of edges) {
    const n = decodeNoticePayload(e?.node?.payload);
    if (!n?.type) continue;
    const nSub = normAddr(n.subAddress);
    const nVault = normAddr(n.vaultAddress);
    if (!((vault && nVault === vault) || (sub && nSub === sub))) continue;
    matches++;
    if (n.type === 'sweep_locked' && n.mintedE8 != null) {
      try {
        minted += BigInt(String(n.mintedE8));
      } catch {
        /* */
      }
    }
    if (n.type === 'spoofed_wwart_burned') {
      if (n.burnedE8 != null) {
        try {
          burned += BigInt(String(n.burnedE8));
        } catch {
          /* */
        }
      }
      if (n.remainingMintedE8 != null) {
        try {
          lastRemaining = BigInt(String(n.remainingMintedE8));
        } catch {
          /* */
        }
      }
    }
    if (n.type === 'subwallet_unlocked') {
      unlocked = true;
      lastRemaining = 0n;
    }
  }

  let outstanding;
  if (unlocked || lastRemaining === 0n) outstanding = 0n;
  else if (lastRemaining != null) outstanding = lastRemaining;
  else outstanding = minted > burned ? minted - burned : 0n;

  return {
    source: 'graphql',
    graphqlUrl: GRAPHQL_URL,
    outstandingE8: outstanding.toString(),
    mintedE8: minted.toString(),
    burnedE8: burned.toString(),
    noticeMatches: matches,
  };
}

async function fetchOutstandingFromInspect(owner) {
  const bare = normAddr(owner);
  if (bare.length !== 40) throw new Error('inspect needs 40-hex L1 owner');
  const url = `${INSPECT_URL.replace(/\/$/, '')}/vault/${bare}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`Inspect HTTP ${res.status}`);
    const data = await res.json();
    const payload = data?.reports?.[0]?.payload;
    if (!payload) return { source: 'inspect', outstandingE8: '0', note: 'no reports' };
    const hex = String(payload).startsWith('0x') ? String(payload).slice(2) : String(payload);
    const j = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
    if (j.error) throw new Error(j.error);
    const minted = BigInt(String(j.totalSpoofedMinted || '0'));
    const burned = BigInt(String(j.totalSpoofedBurned || '0'));
    return {
      source: 'inspect',
      outstandingE8: (minted > burned ? minted - burned : 0n).toString(),
      mintedE8: minted.toString(),
      burnedE8: burned.toString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function verifyOutstanding({ vaultAddress, subAddress, owner }) {
  const errors = [];
  try {
    return { ok: true, ...(await fetchOutstandingFromGraphQL({ vaultAddress, subAddress })) };
  } catch (e) {
    errors.push(`graphql: ${e.message || e}`);
  }
  try {
    return { ok: true, ...(await fetchOutstandingFromInspect(owner)), fallbackErrors: errors };
  } catch (e) {
    errors.push(`inspect: ${e.message || e}`);
  }
  return { ok: false, error: 'Could not verify outstanding on Cartesi', details: errors };
}

function lindellSignStep({ R1Hex, hashHex, dappShareHex, ckeyStr, paillierN, paillierG }) {
  const k2 = (() => {
    for (let i = 0; i < 32; i++) {
      const bytes = nodeRandom(48);
      let x = 0n;
      for (const b of bytes) x = (x << 8n) | BigInt(b);
      x = modN(x);
      if (x > 0n) return x;
    }
    throw new Error('k2 sample failed');
  })();

  const R1 = secp256k1.ProjectivePoint.fromHex(String(R1Hex).replace(/^0x/i, ''));
  const R = R1.multiply(k2);
  const r = modN(R.toAffine().x);
  if (r === 0n) throw new Error('bad r');

  const z = modN(BigInt('0x' + String(hashHex).replace(/^0x/i, '')));
  const x2 = hexToScalar(dappShareHex);
  const k2inv = invScalar(k2);

  const pub = new PublicKey(BigInt(paillierN), BigInt(paillierG));
  const ckey = BigInt(ckeyStr);
  const termM = modN(k2inv * z);
  const termX2 = modN(k2inv * r * x2);
  const exp = modN(k2inv * r);

  const rhoBytes = nodeRandom(32);
  let rho = 0n;
  for (const b of rhoBytes) rho = (rho << 8n) | BigInt(b);
  rho = (rho % (pub.n - 1n)) + 1n;

  let c = pub.encrypt(termM);
  c = pub.addition(c, pub.encrypt(termX2));
  c = pub.addition(c, pub.multiply(ckey, exp));
  c = pub.addition(c, pub.encrypt(rho * CURVE_N));

  return {
    rHex: r.toString(16).padStart(64, '0'),
    ciphertext: c.toString(),
    RHex: Buffer.from(R.toRawBytes(true)).toString('hex'),
  };
}

export async function OPTIONS() {
  return json(204, {});
}

export async function GET({ request }) {
  const url = new URL(request.url);
  const vault = normAddr(url.searchParams.get('vault') || '');
  if (!vault) return json(400, { error: 'Missing vault query' });
  const store = readStore();
  const rec = store.vaults[vault];
  if (!rec) return json(404, { error: 'Unknown vault', vault });
  const out = {
    vault,
    owner: rec.owner,
    subAddress: rec.subAddress,
    scheme: rec.scheme,
    hasShare: !!rec.dappShareHex,
    hasCkey: !!rec.ckey,
    signCount: rec.signCount || 0,
  };
  if (url.searchParams.get('checkOutstanding') === '1') {
    out.policy = await verifyOutstanding({
      vaultAddress: vault,
      subAddress: rec.subAddress,
      owner: rec.owner,
    });
  }
  return json(200, out);
}

export async function POST({ request }) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  let action = body.action || 'auto';
  if (action === 'auto') {
    if (body.R1Hex && body.hashHex) action = 'sign';
    else if (body.ckey || body.dappShareHex) action = 'register';
    else action = 'register';
  }

  if (action === 'register') {
    const vaultAddress = normAddr(body.vaultAddress);
    const dappShareHex = String(body.dappShareHex || '')
      .replace(/^0x/i, '')
      .toLowerCase()
      .padStart(64, '0');
    const owner = String(body.owner || '').toLowerCase();
    if (!vaultAddress || !owner || !body.ckey || !body.paillierN || !body.paillierG) {
      return json(400, {
        error: 'register requires vaultAddress, owner, dappShareHex, ckey, paillierN, paillierG',
      });
    }
    try {
      hexToScalar(dappShareHex);
    } catch {
      return json(400, { error: 'invalid dappShareHex' });
    }
    const store = readStore();
    store.vaults[vaultAddress] = {
      dappShareHex,
      paillierN: String(body.paillierN),
      paillierG: String(body.paillierG),
      ckey: String(body.ckey),
      publicKey: body.publicKey || null,
      owner,
      subAddress: normAddr(body.subAddress),
      index: body.index != null ? Number(body.index) : null,
      scheme: body.scheme || 'wart-2p-ecdsa-lindell-v1',
      createdAt: Date.now(),
      signCount: store.vaults[vaultAddress]?.signCount || 0,
    };
    writeStore(store);
    console.log(`[2p-ecdsa] REGISTER vault=${vaultAddress.slice(0, 12)}… (no full key)`);
    return json(200, {
      ok: true,
      vaultAddress,
      message: '2P-ECDSA material stored — d_dapp + Enc(d_user) only',
    });
  }

  if (action === 'sign') {
    const vaultAddress = normAddr(body.vaultAddress);
    const owner = String(body.owner || '').toLowerCase();
    const R1Hex = body.R1Hex;
    const hashHex = String(body.hashHex || '').replace(/^0x/i, '');
    const force = !!body.force;
    if (!vaultAddress || !owner || !R1Hex || hashHex.length !== 64) {
      return json(400, { error: 'sign requires vaultAddress, owner, R1Hex, hashHex' });
    }
    const store = readStore();
    const rec = store.vaults[vaultAddress];
    if (!rec) return json(404, { error: 'Unknown vault' });
    if (rec.owner !== owner) return json(403, { error: 'owner mismatch' });
    if (!rec.ckey) {
      return json(400, { error: 'Vault missing 2P-ECDSA ckey — recreate multi-sig vault' });
    }

    let policy = null;
    // amountE8: transfer size — required when outstanding > 0 so we can release
    // only burned collateral (partial unlock), not the residual pin.
    let amountE8 = null;
    if (body.amountE8 != null && body.amountE8 !== '') {
      try {
        amountE8 = BigInt(String(body.amountE8));
      } catch {
        return json(400, { error: 'invalid amountE8' });
      }
      if (amountE8 < 0n) return json(400, { error: 'amountE8 must be >= 0' });
    }

    if (!force) {
      policy = await verifyOutstanding({
        vaultAddress,
        subAddress: rec.subAddress || body.subAddress,
        owner,
      });
      if (!policy.ok) {
        return json(503, { error: policy.error, details: policy.details });
      }
      const outstanding = BigInt(policy.outstandingE8 || '0');
      const burned = BigInt(policy.burnedE8 || '0');
      const used = BigInt(rec.signedWithdrawE8 || '0');

      if (outstanding === 0n) {
        // Fully unlocked — any spend OK; reset partial-release budget
        rec.signedWithdrawE8 = '0';
      } else {
        // Partial pin: may withdraw only up to burned − already signed
        // (1:1 collateral — burn 30 frees 30 WART while 69 remains locked)
        if (amountE8 == null || amountE8 <= 0n) {
          return json(403, {
            error:
              'Pin held: outstanding spoofed wWART > 0 — pass amountE8 ≤ freeable (burned − already withdrawn)',
            outstandingE8: policy.outstandingE8,
            burnedE8: burned.toString(),
            signedWithdrawE8: used.toString(),
            freeableE8: (burned > used ? burned - used : 0n).toString(),
            policy,
          });
        }
        const freeable = burned > used ? burned - used : 0n;
        if (amountE8 > freeable) {
          return json(403, {
            error: `Pin: amount ${amountE8} E8 exceeds freeable ${freeable} E8 (burn more spoofed wWART first)`,
            outstandingE8: policy.outstandingE8,
            burnedE8: burned.toString(),
            signedWithdrawE8: used.toString(),
            freeableE8: freeable.toString(),
            policy,
          });
        }
        rec.signedWithdrawE8 = (used + amountE8).toString();
      }
    }

    let step;
    try {
      step = lindellSignStep({
        R1Hex,
        hashHex,
        dappShareHex: rec.dappShareHex,
        ckeyStr: rec.ckey,
        paillierN: rec.paillierN,
        paillierG: rec.paillierG,
      });
    } catch (e) {
      // Roll back budget if we reserved amount then signing failed
      if (!force && amountE8 != null && amountE8 > 0n && rec.signedWithdrawE8) {
        try {
          const usedNow = BigInt(rec.signedWithdrawE8 || '0');
          rec.signedWithdrawE8 = (usedNow > amountE8 ? usedNow - amountE8 : 0n).toString();
          writeStore(store);
        } catch {
          /* */
        }
      }
      return json(500, { error: 'sign failed: ' + (e.message || e) });
    }

    rec.signCount = (rec.signCount || 0) + 1;
    rec.lastSignAt = Date.now();
    writeStore(store);

    console.log(`[2p-ecdsa] SIGN partial vault=${vaultAddress.slice(0, 12)}… (key never assembled)`);
    return json(200, {
      ok: true,
      rHex: step.rHex,
      ciphertext: step.ciphertext,
      RHex: step.RHex,
      policy: policy || { source: 'force' },
      message: '2P-ECDSA partial — client finishes s; full d never existed',
    });
  }

  if (action === 'policy') {
    const vaultAddress = normAddr(body.vaultAddress);
    const store = readStore();
    const rec = store.vaults[vaultAddress];
    if (!rec) return json(404, { error: 'Unknown vault' });
    const policy = await verifyOutstanding({
      vaultAddress,
      subAddress: rec.subAddress,
      owner: rec.owner,
    });
    return json(200, { vaultAddress, policy });
  }

  // Refund freeable budget reserved by a prior sign if node submit / client finish failed.
  if (action === 'releaseBudget') {
    const vaultAddress = normAddr(body.vaultAddress);
    const owner = String(body.owner || '').toLowerCase();
    const store = readStore();
    const rec = store.vaults[vaultAddress];
    if (!rec) return json(404, { error: 'Unknown vault' });
    if (rec.owner !== owner) return json(403, { error: 'owner mismatch' });
    let amountE8 = 0n;
    try {
      amountE8 = BigInt(String(body.amountE8 || '0'));
    } catch {
      return json(400, { error: 'invalid amountE8' });
    }
    if (amountE8 <= 0n) return json(400, { error: 'amountE8 must be > 0' });
    const used = BigInt(rec.signedWithdrawE8 || '0');
    rec.signedWithdrawE8 = (used > amountE8 ? used - amountE8 : 0n).toString();
    writeStore(store);
    return json(200, {
      ok: true,
      signedWithdrawE8: rec.signedWithdrawE8,
      releasedE8: amountE8.toString(),
    });
  }

  if (action === 'open' || action === 'release') {
    return json(400, {
      error: 'open/release removed. Use action=sign (2P-ECDSA). Private key is never returned.',
    });
  }

  return json(400, { error: `Unknown action: ${action}` });
}
