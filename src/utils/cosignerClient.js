/**
 * 2-of-2 multi-sig co-signer client (Lindell 2P-ECDSA).
 * Cosigner never returns private key or dapp share.
 */

const DEFAULT_BASE = '/api/cosigner';

async function cosignerFetch({ method = 'GET', body, query = '' } = {}) {
  const res = await fetch(`${DEFAULT_BASE}${query}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Cosigner HTTP ${res.status}`);
  }
  return data;
}

/** Register dapp share + Enc(d_user) + Paillier pub after keygen. */
export async function registerMultiSigVault(reg) {
  return cosignerFetch({
    method: 'POST',
    body: {
      action: 'register',
      ...reg,
    },
  });
}

/** @deprecated name */
export const registerDappShare = registerMultiSigVault;

/**
 * 2P-ECDSA round: send R1 + hash; receive r + ciphertext (never private key).
 * Destination binding: pass transfer preimage fields so cosigner re-hashes and
 * checks toAddress ∈ registered allowedTo (main wallet).
 */
export async function multiSigSignPartial({
  vaultAddress,
  owner,
  subAddress,
  R1Hex,
  hashHex,
  amountE8 = null,
  amountWei = null,
  force = false,
  toAddress = null,
  feeE8 = null,
  pinHash = null,
  pinHeight = null,
  nonceId = null,
  /** 'eth' = skip Warthog preimage; sign EIP-1559 unsignedHash */
  chain = null,
}) {
  return cosignerFetch({
    method: 'POST',
    body: {
      action: 'sign',
      vaultAddress,
      owner,
      subAddress,
      R1Hex,
      hashHex,
      ...(amountE8 != null ? { amountE8: String(amountE8) } : {}),
      ...(amountWei != null ? { amountWei: String(amountWei) } : {}),
      ...(toAddress != null ? { toAddress: String(toAddress) } : {}),
      ...(feeE8 != null ? { feeE8: String(feeE8) } : {}),
      ...(pinHash != null ? { pinHash: String(pinHash) } : {}),
      ...(pinHeight != null ? { pinHeight: Number(pinHeight) } : {}),
      ...(nonceId != null ? { nonceId: Number(nonceId) } : {}),
      ...(chain != null ? { chain: String(chain) } : {}),
      force,
    },
  });
}

/** Policy check only. */
export async function multiSigPolicy(vaultAddress) {
  return cosignerFetch({
    method: 'POST',
    body: { action: 'policy', vaultAddress },
  });
}

/** Undo freeable reservation after a failed client-finish or node submit. */
export async function multiSigReleaseBudget({ vaultAddress, owner, amountE8 }) {
  return cosignerFetch({
    method: 'POST',
    body: {
      action: 'releaseBudget',
      vaultAddress,
      owner,
      amountE8: String(amountE8),
    },
  });
}

export async function cosignerStatus(vaultAddress) {
  const q = encodeURIComponent(vaultAddress.replace(/^0x/i, '').toLowerCase());
  return cosignerFetch({
    method: 'GET',
    query: `?vault=${q}&checkOutstanding=1`,
  });
}

/**
 * List vaults registered on the cosigner for this L1 owner (public metadata only).
 * Used by Unloaded vaults — catches cosigner-only vaults with no rollup notices.
 */
export async function cosignerListByOwner(ownerL1) {
  const owner = String(ownerL1 || '').toLowerCase();
  if (!owner) throw new Error('owner required');
  return cosignerFetch({
    method: 'GET',
    query: `?owner=${encodeURIComponent(owner)}`,
  });
}

/** Removed: open that returned privateKey */
export async function multiSigOpen() {
  throw new Error(
    'multiSigOpen removed — use multiSigSignPartial + clientSignFinish (2P-ECDSA, no key assembly)',
  );
}
