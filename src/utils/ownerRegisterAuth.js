/**
 * V2 — build + sign owner-bound cosigner register auth (EIP-191).
 *
 * Whether a missing signature is fatal depends on the SERVER, not on this file:
 * with COSIGNER_REQUIRE_OWNER_SIG=1 the cosigner rejects an unsigned register;
 * with =0 it soft-accepts. (This VPS runs =1 as of 2026-09-04 — see
 * cartesi-cosigner.service.d/owner-sig.conf. The documented Mode B default is 0.)
 *
 * So on failure we return a `reason` instead of a bare {}, letting the caller say
 * why — "you declined the signature" and "no wallet connected" need different
 * messages, and previously both looked identical to the UI.
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
  if (!owner || !vaultAddress) return { reason: 'missing-owner-or-vault' };

  let signer = opts.signer;
  const hadProvider = Boolean(opts.signer)
    || (typeof window !== 'undefined' && Boolean(window.ethereum));
  if (!signer && typeof window !== 'undefined' && window.ethereum) {
    try {
      const { BrowserProvider } = await import('ethers-v6');
      const provider = new BrowserProvider(window.ethereum);
      signer = await provider.getSigner();
    } catch {
      signer = null;
    }
  }
  if (!signer?.signMessage) {
    return { reason: hadProvider ? 'wallet-locked' : 'no-wallet' };
  }

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
    return { reason: 'declined' };
  }
}
