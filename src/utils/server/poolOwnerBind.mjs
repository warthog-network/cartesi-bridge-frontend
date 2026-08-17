/**
 * Path A owner bind — dual-sig registration (kills first-writer race).
 *
 * Credit may only use an existing WART → L1 map. Creating that map
 * requires a Warthog secp256k1 personal_sign + a MetaMask personal_sign
 * over the same cartesi-pool-bind-v1 message.
 *
 * Legacy ownerByWart rows (no bindMeta) stay valid so already-credited
 * wallets keep working.
 */
import { hashMessage, SigningKey, verifyMessage, getBytes, sha256, ripemd160, concat, hexlify } from 'ethers-v6';
import {
  buildPoolBindMessage,
  normWartAddr,
  normL1Addr,
} from '../poolBindMessage.js';
import { loadCreditQueueRaw, persistOwnerBind } from './poolCreditQueue.mjs';

const ISSUED_MAX_AGE_SEC = Number(process.env.POOL_BIND_MAX_AGE_SEC || 3600);

export { buildPoolBindMessage, normWartAddr, normL1Addr };

/** 48-hex Warthog address from compressed/uncompressed secp256k1 pubkey. */
export function wartAddressFromPublicKey(publicKeyHex) {
  let pk = String(publicKeyHex || '').replace(/^0x/i, '').toLowerCase();
  if (pk.length === 130 && pk.startsWith('04')) {
    const x = pk.slice(2, 66);
    const y = pk.slice(66);
    const yLast = parseInt(y.slice(-2), 16);
    pk = (yLast % 2 === 0 ? '02' : '03') + x;
  }
  if (pk.length !== 66 || (!pk.startsWith('02') && !pk.startsWith('03'))) {
    throw new Error('invalid secp256k1 public key');
  }
  const pubBytes = getBytes(`0x${pk}`);
  const ripe = getBytes(ripemd160(getBytes(sha256(pubBytes))));
  const checksum = getBytes(sha256(ripe)).slice(0, 4);
  return hexlify(concat([ripe, checksum])).slice(2);
}

export function wartAddressFromPersonalSig(message, sig) {
  const digest = hashMessage(message);
  const pub = SigningKey.recoverPublicKey(digest, sig);
  return wartAddressFromPublicKey(pub);
}

export function inspectWartOwnerBind(q, { fromAddress, owner } = {}) {
  const from = fromAddress ? normWartAddr(fromAddress) : null;
  const own = owner ? normL1Addr(owner) : '';
  const bound = from && q?.ownerByWart?.[from]
    ? normL1Addr(q.ownerByWart[from])
    : null;
  const meta = from && q?.bindMeta?.[from] ? q.bindMeta[from] : null;
  let status = 'unbound';
  if (bound && own && bound === own) status = 'match';
  else if (bound && own && bound !== own) status = 'mismatch';
  else if (bound && !own) status = 'bound';
  const conflict = status === 'mismatch';
  const needsRegister = status === 'unbound' && Boolean(from && own);
  let error = null;
  if (conflict) {
    error = `Warthog ${from.slice(0, 12)}… already bound to L1 ${bound.slice(0, 10)}… — switch MetaMask to that account. WART was not sent.`;
  } else if (needsRegister) {
    error = null;
  }
  return {
    ok: !conflict,
    status,
    conflict,
    needsRegister,
    fromAddress: from,
    owner: own || null,
    boundOwner: bound,
    method: meta?.method || (bound ? 'legacy' : null),
    error,
  };
}

export async function checkWartOwnerBind(args) {
  const q = await loadCreditQueueRaw();
  return inspectWartOwnerBind(q, args);
}

/**
 * Verify dual signatures and persist WART → L1 bind.
 * Does not overwrite a different owner.
 */
export async function registerWartOwnerBind({
  fromAddress,
  owner,
  issuedAt,
  wartSig,
  ownerSig,
}) {
  const from = normWartAddr(fromAddress);
  const own = normL1Addr(owner);
  const ts = Math.floor(Number(issuedAt));
  if (!from || from.length < 40) throw new Error('fromAddress required');
  if (!own || own.length !== 42) throw new Error('owner must be 0x + 40 hex');
  if (!Number.isFinite(ts) || ts <= 0) throw new Error('issuedAt required');
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > ISSUED_MAX_AGE_SEC) {
    throw new Error(
      `bind issuedAt too old or skewed (max ${ISSUED_MAX_AGE_SEC}s)`,
    );
  }
  if (!wartSig || !ownerSig) {
    throw new Error('wartSig and ownerSig required');
  }

  const message = buildPoolBindMessage({ fromAddress: from, owner: own, issuedAt: ts });

  let recoveredWart;
  try {
    recoveredWart = wartAddressFromPersonalSig(message, wartSig);
  } catch (e) {
    throw new Error(`invalid Warthog bind signature (${e?.message || e})`);
  }
  if (recoveredWart !== from) {
    throw new Error(
      `Warthog signature is for ${recoveredWart.slice(0, 12)}… not ${from.slice(0, 12)}…`,
    );
  }

  let recoveredOwner;
  try {
    recoveredOwner = String(verifyMessage(message, ownerSig)).toLowerCase();
  } catch (e) {
    throw new Error(`invalid MetaMask bind signature (${e?.message || e})`);
  }
  if (recoveredOwner !== own) {
    throw new Error(
      `MetaMask signature is for ${recoveredOwner.slice(0, 10)}… not ${own.slice(0, 10)}…`,
    );
  }

  return persistOwnerBind({
    fromAddress: from,
    owner: own,
    issuedAt: ts,
    wartSig,
    ownerSig,
    method: 'dual-sig',
  });
}
