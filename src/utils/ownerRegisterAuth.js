/**
 * V2 — build + sign owner-bound cosigner register auth (EIP-191).
 * Soft path: if no signer, returns {} and cosigner still accepts (requireOwnerSig=false).
 */

export function buildRegisterMessage({
  vaultAddress,
  owner,
  scheme,
  allowedTo,
  issuedAt,
}) {
  const vault = String(vaultAddress || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  let own = String(owner || '').toLowerCase();
  if (own && !own.startsWith('0x')) own = `0x${own}`;
  const allowed = (Array.isArray(allowedTo) ? allowedTo : allowedTo ? [allowedTo] : [])
    .map((a) =>
      String(a || '')
        .replace(/^0x/i, '')
        .toLowerCase(),
    )
    .filter(Boolean)
    .sort()
    .join(',');
  return [
    'cartesi-cosigner-register-v0',
    `vault:${vault}`,
    `owner:${own}`,
    `scheme:${scheme || 'wart-2p-ecdsa-lindell-v1'}`,
    `allowedTo:${allowed}`,
    `issuedAt:${Math.floor(Number(issuedAt))}`,
  ].join('\n');
}

/**
 * @param {object} reg - register fields (vaultAddress, owner, scheme, allowedTo/mainAddress)
 * @param {{ signer?: { signMessage: (m: string) => Promise<string> } }} [opts]
 * @returns {Promise<{ ownerSig?: string, issuedAt?: number }>}
 */
export async function attachOwnerRegisterAuth(reg, opts = {}) {
  const owner = String(reg?.owner || '').toLowerCase();
  const vaultAddress = reg?.vaultAddress;
  if (!owner || !vaultAddress) return {};

  let signer = opts.signer;
  if (!signer && typeof window !== 'undefined' && window.ethereum) {
    try {
      const { BrowserProvider } = await import('ethers-v6');
      const provider = new BrowserProvider(window.ethereum);
      signer = await provider.getSigner();
    } catch {
      signer = null;
    }
  }
  if (!signer?.signMessage) return {};

  const issuedAt = Math.floor(Date.now() / 1000);
  const allowedTo =
    reg.allowedTo ||
    (reg.mainAddress ? [reg.mainAddress] : []);
  const message = buildRegisterMessage({
    vaultAddress,
    owner,
    scheme: reg.scheme,
    allowedTo,
    issuedAt,
  });
  try {
    const ownerSig = await signer.signMessage(message);
    return { ownerSig, issuedAt };
  } catch (e) {
    console.warn('[ownerRegisterAuth] signMessage declined or failed', e);
    return {};
  }
}
