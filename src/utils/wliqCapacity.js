/**
 * Mirror cartesi-bridge-backend backingCapacity18 / shareClaimed18.
 *
 * Capacity (shared by WLIQ + wWART claims):
 *   spoofedOutstandingE8 * 1e10  + CTSI + ethWei + usdc*1e12
 * Claimed:
 *   liquid + l1WwartClaim
 * Available:
 *   capacity − claimed
 *
 * Inspect may send mintCapacity18 / mintRemaining18 directly (preferred).
 */

function toBigIntSafe(v) {
  if (v == null || v === '') return 0n;
  if (typeof v === 'bigint') return v;
  const s = String(v).trim();
  if (!s || s === '0') return 0n;
  if (s.includes('.')) {
    const [w, f = ''] = s.split('.');
    const frac = (f + '000000000000000000').slice(0, 18);
    return BigInt(w || '0') * 10n ** 18n + BigInt(frac || '0');
  }
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/** Format 18-dec integer to compact human string */
export function formatUnits18(raw, maxFrac = 8) {
  try {
    const bn = typeof raw === 'bigint' ? raw : BigInt(raw || 0);
    const neg = bn < 0n;
    const x = neg ? -bn : bn;
    const whole = x / 10n ** 18n;
    let frac = (x % 10n ** 18n).toString().padStart(18, '0');
    if (maxFrac < 18) frac = frac.slice(0, maxFrac);
    frac = frac.replace(/0+$/, '');
    const body = frac ? `${whole}.${frac}` : whole.toString();
    return neg ? `-${body}` : body;
  } catch {
    return '0';
  }
}

/**
 * @param {object|null} vault — inspect vault payload (WalletIsland state)
 */
export function computeWliqMintAvailable(vault) {
  const empty = {
    capacity18: 0n,
    liquid18: 0n,
    claim18: 0n,
    remaining18: 0n,
    capacity: '0',
    liquid: '0',
    claim: '0',
    available: '0',
    hasBacking: false,
    hasLockedWart: false,
    spoofedOutstandingE8: 0n,
  };
  if (!vault) return empty;

  try {
    // Prefer server capacity when present, but ALWAYS derive Used/Available from
    // liquid + l1WwartClaim (not stale mintRemaining18 / mintClaimed18). Those
    // can lag or disagree after optimistic updates.
    if (vault.mintCapacity18 != null) {
      const capacity18 = toBigIntSafe(vault.mintCapacity18);
      const liquid18 = toBigIntSafe(vault.liquid);
      const claim18 = toBigIntSafe(vault.l1WwartClaim);
      const claimed18 = liquid18 + claim18;
      const remaining18 =
        capacity18 > claimed18 ? capacity18 - claimed18 : 0n;
      const spoofed = toBigIntSafe(vault.outstandingE8);
      return {
        capacity18,
        liquid18,
        claim18,
        remaining18,
        capacity: formatUnits18(capacity18),
        liquid: formatUnits18(liquid18),
        claim: formatUnits18(claim18),
        available: formatUnits18(remaining18),
        hasBacking: capacity18 > 0n,
        hasLockedWart: spoofed > 0n,
        spoofedOutstandingE8: spoofed,
      };
    }

    const spoofedE8 = toBigIntSafe(vault.outstandingE8);
    const CTSI = toBigIntSafe(vault.CTSI);
    const usdc = toBigIntSafe(vault.usdc);
    const ethWei = toBigIntSafe(vault.eth);

    // Capacity from locked spoofed WART + L1 portals (not raw wWART field)
    const capacity18 =
      spoofedE8 * 10n ** 10n + CTSI + ethWei + usdc * 10n ** 12n;

    const liquid18 = toBigIntSafe(vault.liquid);
    const claim18 = toBigIntSafe(vault.l1WwartClaim);
    const claimed18 = liquid18 + claim18;
    const remaining18 = capacity18 > claimed18 ? capacity18 - claimed18 : 0n;

    return {
      capacity18,
      liquid18,
      claim18,
      remaining18,
      capacity: formatUnits18(capacity18),
      liquid: formatUnits18(liquid18),
      claim: formatUnits18(claim18),
      available: formatUnits18(remaining18),
      hasBacking: capacity18 > 0n,
      hasLockedWart: spoofedE8 > 0n,
      spoofedOutstandingE8: spoofedE8,
    };
  } catch {
    return empty;
  }
}
