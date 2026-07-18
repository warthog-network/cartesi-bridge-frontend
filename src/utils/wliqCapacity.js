/**
 * Mirror cartesi-bridge-backend backingCapacity18 / mint remaining.
 * Inspect payload: liquid (18-dec wei string), wWART (E8), CTSI (18-dec),
 * usdc (6-dec), eth (human ether string via formatEther).
 */

function toBigIntSafe(v) {
  if (v == null || v === '') return 0n;
  if (typeof v === 'bigint') return v;
  const s = String(v).trim();
  if (!s || s === '0') return 0n;
  // human decimal → 18-dec wei
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
 * @returns {{ capacity18: bigint, liquid18: bigint, remaining18: bigint, capacity: string, liquid: string, available: string, hasBacking: boolean }}
 */
export function computeWliqMintAvailable(vault) {
  const empty = {
    capacity18: 0n,
    liquid18: 0n,
    remaining18: 0n,
    capacity: '0',
    liquid: '0',
    available: '0',
    hasBacking: false,
  };
  if (!vault) return empty;

  try {
    const wWART = toBigIntSafe(vault.wWART); // E8
    const CTSI = toBigIntSafe(vault.CTSI); // 18-dec
    const usdc = toBigIntSafe(vault.usdc); // 6-dec
    // eth is human string from formatEther on inspect
    const ethWei = toBigIntSafe(vault.eth);

    const capacity18 =
      wWART * 10n ** 10n + CTSI + ethWei + usdc * 10n ** 12n;
    const liquid18 = toBigIntSafe(vault.liquid);
    const remaining18 = capacity18 > liquid18 ? capacity18 - liquid18 : 0n;

    return {
      capacity18,
      liquid18,
      remaining18,
      capacity: formatUnits18(capacity18),
      liquid: formatUnits18(liquid18),
      available: formatUnits18(remaining18),
      hasBacking: capacity18 > 0n,
    };
  } catch {
    return empty;
  }
}
