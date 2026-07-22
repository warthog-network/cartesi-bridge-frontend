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
 * Portal-deposited wWART inventory (18-dec wei).
 * Mirrors backend: values below 1e15 are legacy spoofed E8 pollution — ignore.
 */
export function portalWwart18(vault) {
  const raw = toBigIntSafe(vault?.wWART);
  if (raw > 0n && raw < 10n ** 15n) return 0n;
  return raw;
}

/**
 * Withdrawable wWART on rollup = open portable claims + portal deposits.
 * Backend withdraw_wwart uses the same sum (portable first, then portal).
 * Deposit does NOT increase portable — it increases portal inventory only.
 */
export function wwartWithdrawable18(vault) {
  const portable = toBigIntSafe(vault?.wwartPortable);
  return portable + portalWwart18(vault);
}

/** Human string for Max / amount inputs (full precision, no trailing zeros). */
export function formatUnits18Exact(raw) {
  try {
    const bn = typeof raw === 'bigint' ? raw : BigInt(raw || 0);
    if (bn <= 0n) return '0';
    const whole = bn / 10n ** 18n;
    const frac = (bn % 10n ** 18n)
      .toString()
      .padStart(18, '0')
      .replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
  } catch {
    return '0';
  }
}

/**
 * @param {object|null} vault — inspect vault payload (WalletIsland state)
 */
/**
 * Open / filled / burnable split for wWART capacity claims.
 * Open = portable not yet withdrawn; filled = claim still Used while ERC-20 on L1;
 * burnable = min(claim, portable + portal) — filled needs deposit back before burn.
 */
function wwartClaimSplit(vault, claim18) {
  const portable18 = toBigIntSafe(vault.wwartPortable);
  // Prefer explicit inspect fields when present (authoritative dApp)
  if (vault.wwartBurnable != null || vault.wwartOpenClaim != null) {
    const open18 = toBigIntSafe(vault.wwartOpenClaim ?? portable18);
    const filled18 = toBigIntSafe(
      vault.wwartFilledClaim ??
        (claim18 > open18 ? claim18 - open18 : 0n),
    );
    const burnable18 = toBigIntSafe(
      vault.wwartBurnable ??
        (() => {
          const portal = toBigIntSafe(vault.wWART);
          const cover = portable18 + portal;
          return claim18 < cover ? claim18 : cover;
        })(),
    );
    return { open18, filled18, burnable18, portable18 };
  }
  const portal18 = toBigIntSafe(vault.wWART);
  const open18 = portable18 < claim18 ? portable18 : claim18;
  const filled18 = claim18 > open18 ? claim18 - open18 : 0n;
  const cover = portable18 + portal18;
  const burnable18 = claim18 < cover ? claim18 : cover;
  return { open18, filled18, burnable18, portable18 };
}

export function computeWliqMintAvailable(vault) {
  const empty = {
    capacity18: 0n,
    liquid18: 0n,
    claim18: 0n,
    remaining18: 0n,
    openClaim18: 0n,
    filledClaim18: 0n,
    burnableClaim18: 0n,
    capacity: '0',
    liquid: '0',
    claim: '0',
    openClaim: '0',
    filledClaim: '0',
    burnableClaim: '0',
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
      const split = wwartClaimSplit(vault, claim18);
      return {
        capacity18,
        liquid18,
        claim18,
        remaining18,
        openClaim18: split.open18,
        filledClaim18: split.filled18,
        burnableClaim18: split.burnable18,
        capacity: formatUnits18(capacity18),
        liquid: formatUnits18(liquid18),
        claim: formatUnits18(claim18),
        openClaim: formatUnits18(split.open18),
        filledClaim: formatUnits18(split.filled18),
        burnableClaim: formatUnits18(split.burnable18),
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
    const split = wwartClaimSplit(vault, claim18);

    return {
      capacity18,
      liquid18,
      claim18,
      remaining18,
      openClaim18: split.open18,
      filledClaim18: split.filled18,
      burnableClaim18: split.burnable18,
      capacity: formatUnits18(capacity18),
      liquid: formatUnits18(liquid18),
      claim: formatUnits18(claim18),
      openClaim: formatUnits18(split.open18),
      filledClaim: formatUnits18(split.filled18),
      burnableClaim: formatUnits18(split.burnable18),
      available: formatUnits18(remaining18),
      hasBacking: capacity18 > 0n,
      hasLockedWart: spoofedE8 > 0n,
      spoofedOutstandingE8: spoofedE8,
    };
  } catch {
    return empty;
  }
}
