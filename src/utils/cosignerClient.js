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
 */
export async function multiSigSignPartial({
  vaultAddress,
  owner,
  subAddress,
  R1Hex,
  hashHex,
  amountE8 = null,
  force = false,
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

/** Removed: open that returned privateKey */
export async function multiSigOpen() {
  throw new Error(
    'multiSigOpen removed — use multiSigSignPartial + clientSignFinish (2P-ECDSA, no key assembly)',
  );
}
