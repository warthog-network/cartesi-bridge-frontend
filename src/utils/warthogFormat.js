import { ensureBuffer } from './ensureBuffer.js';

const WART_PRECISION = 8;

/** Format a raw integer amount at the given decimal precision. */
export function formatAmountFromRaw(raw, precision) {
  const value = BigInt(raw);
  const divisor = 10n ** BigInt(precision);
  const whole = value / divisor;
  const frac = value % divisor;
  if (precision === 0) return whole.toString();
  return `${whole}.${frac.toString().padStart(precision, '0')}`;
}

/**
 * Format a WART balance from the node API.
 * Accepts:
 * - `{ str, E8 }` (defi wart.total / modern mainnet)
 * - raw E8 number/string
 * - decimal string amount
 * - account payload with balanceE8 / balance.total
 */
export async function formatWartBalance(wartObj) {
  if (wartObj == null || wartObj === '') return '0.00000000';

  // Full account payload shortcuts
  if (typeof wartObj === 'object') {
    if (wartObj.balance?.total) return formatWartBalance(wartObj.balance.total);
    if (wartObj.wart?.total) return formatWartBalance(wartObj.wart.total);
    if (wartObj.str != null && wartObj.str !== '') return String(wartObj.str);
    if (wartObj.E8 !== undefined && wartObj.E8 !== null) {
      await ensureBuffer();
      const { Wart } = await import('warthog-js');
      const wart = Wart.fromE8(BigInt(wartObj.E8));
      if (wart) return formatAmountFromRaw(wart.E8, WART_PRECISION);
      return formatAmountFromRaw(wartObj.E8, WART_PRECISION);
    }
    if (wartObj.balanceE8 !== undefined) {
      return formatAmountFromRaw(wartObj.balanceE8, WART_PRECISION);
    }
    if (typeof wartObj.balance === 'string' || typeof wartObj.balance === 'number') {
      return Number(wartObj.balance).toFixed(8);
    }
  }

  if (typeof wartObj === 'number' || (typeof wartObj === 'string' && /^\d+$/.test(wartObj))) {
    // bare E8 integer
    return formatAmountFromRaw(wartObj, WART_PRECISION);
  }
  if (typeof wartObj === 'string') {
    const n = Number(wartObj);
    return Number.isFinite(n) ? n.toFixed(8) : '0.00000000';
  }

  return '0.00000000';
}

/** Pick balance field for main vs defi account responses. */
export function pickWartBalanceObject(balanceData, { mainnet } = {}) {
  if (!balanceData) return null;
  if (mainnet) {
    // Prefer structured total; fall back to legacy flat balanceE8 / balance string
    if (balanceData?.balance?.total != null) return balanceData.balance.total;
    if (balanceData?.balanceE8 !== undefined) {
      return { E8: balanceData.balanceE8, str: balanceData.balance };
    }
    if (typeof balanceData.balance === 'object' && balanceData.balance != null) {
      return balanceData.balance;
    }
    if (typeof balanceData.balance === 'string' || typeof balanceData.balance === 'number') {
      return { str: String(balanceData.balance) };
    }
    return balanceData;
  }
  // DeFi / testnet: wart.total is canonical
  if (balanceData?.wart?.total != null) return balanceData.wart.total;
  if (balanceData?.balance?.total != null) return balanceData.balance.total;
  if (balanceData?.balanceE8 !== undefined) {
    return { E8: balanceData.balanceE8, str: balanceData.balance };
  }
  return balanceData;
}

/**
 * Split DeFi/mainnet account payload into total / mempool / locked / spendable.
 * Nodes often report `total` including funds already reserved by unconfirmed txs
 * (`mempool`). Spendable ≈ max(0, total − mempool − locked).
 */
export function parseWartBalanceBreakdown(balanceData, { mainnet } = {}) {
  const empty = {
    totalE8: 0n,
    mempoolE8: 0n,
    lockedE8: 0n,
    spendableE8: 0n,
    total: '0.00000000',
    mempool: '0.00000000',
    locked: '0.00000000',
    spendable: '0.00000000',
  };
  if (!balanceData) return empty;

  const e8 = (obj) => {
    if (obj == null) return 0n;
    if (typeof obj === 'bigint') return obj;
    if (typeof obj === 'number' && Number.isFinite(obj)) return BigInt(Math.trunc(obj));
    if (typeof obj === 'string' && /^\d+$/.test(obj)) return BigInt(obj);
    if (typeof obj === 'object') {
      if (obj.E8 != null) return BigInt(obj.E8);
      if (obj.u64 != null) return BigInt(obj.u64);
      if (obj.str != null && String(obj.str).includes('.')) {
        // decimal string → E8
        const [w, f = ''] = String(obj.str).split('.');
        const frac = (f + '00000000').slice(0, 8);
        return BigInt(w || '0') * 100000000n + BigInt(frac || '0');
      }
    }
    return 0n;
  };

  let totalE8 = 0n;
  let mempoolE8 = 0n;
  let lockedE8 = 0n;

  if (!mainnet && balanceData.wart) {
    totalE8 = e8(balanceData.wart.total);
    mempoolE8 = e8(balanceData.wart.mempool);
    lockedE8 = e8(balanceData.wart.locked);
  } else if (balanceData.balance && typeof balanceData.balance === 'object') {
    totalE8 = e8(balanceData.balance.total ?? balanceData.balance);
    mempoolE8 = e8(balanceData.balance.mempool);
    lockedE8 = e8(balanceData.balance.locked);
  } else if (balanceData.balanceE8 != null) {
    totalE8 = e8(balanceData.balanceE8);
  } else {
    const picked = pickWartBalanceObject(balanceData, { mainnet });
    totalE8 = e8(picked);
  }

  const spendableE8 = totalE8 > mempoolE8 + lockedE8 ? totalE8 - mempoolE8 - lockedE8 : 0n;

  return {
    totalE8,
    mempoolE8,
    lockedE8,
    spendableE8,
    total: formatAmountFromRaw(totalE8, WART_PRECISION),
    mempool: formatAmountFromRaw(mempoolE8, WART_PRECISION),
    locked: formatAmountFromRaw(lockedE8, WART_PRECISION),
    spendable: formatAmountFromRaw(spendableE8, WART_PRECISION),
  };
}

/** Format a token balance object from the node API. */
export async function formatTokenBalance(balanceObj, decimals = 8) {
  if (!balanceObj) return '0';
  if (balanceObj.str) return balanceObj.str;

  const raw = balanceObj.u64 ?? balanceObj.E8 ?? balanceObj.amount;
  if (raw !== undefined) {
    return formatAmountFromRaw(raw, decimals);
  }

  return '0';
}

/** Format a limit order price using warthog-js Price when a hex encoding is available. */
export async function formatLimitPrice(limit, assetDecimals = 8) {
  if (limit == null) return '0.00000000';
  if (typeof limit === 'number') return limit.toFixed(8);
  if (typeof limit === 'string') {
    if (limit.length === 6) {
      return formatLimitPriceFromHex(limit, assetDecimals);
    }
    const asNum = Number(limit);
    return Number.isFinite(asNum) ? asNum.toFixed(8) : limit;
  }
  if (limit.doubleAdjusted != null) {
    return Number(limit.doubleAdjusted).toFixed(8);
  }
  if (limit.hex?.length === 6) {
    return formatLimitPriceFromHex(limit.hex, assetDecimals);
  }
  return '0.00000000';
}

async function formatLimitPriceFromHex(hex, assetDecimals) {
  await ensureBuffer();
  const { Price, TokenPrecision } = await import('warthog-js');
  const price = Price.fromHex(hex);
  if (!price) return '0.00000000';
  const prec = new TokenPrecision(assetDecimals);
  return price.toDoubleAdjusted(prec).toFixed(8);
}

/** Validate a 64-character asset hash. */
export function isValidAssetHash(hash) {
  const clean = (hash || '').trim().toLowerCase();
  return clean.length === 64 && /^[0-9a-f]+$/.test(clean);
}

/** Validate a Warthog address checksum via warthog-js. */
export async function isValidWarthogAddress(address) {
  const result = await validateWarthogAddressInput(address);
  return result.valid === true;
}

/**
 * Validate a Warthog address locally (no node required).
 * Accepts 40-char account IDs (checksum computed) or 48-char full addresses.
 */
export async function validateWarthogAddressInput(address) {
  const clean = (address || '').trim().replace(/^0x/i, '').toLowerCase();

  if (!clean) {
    return { valid: false, error: 'Please enter an address' };
  }

  if (!/^[0-9a-f]+$/.test(clean)) {
    return { valid: false, error: 'Address must contain only hexadecimal characters (0-9, a-f)' };
  }

  await ensureBuffer();
  const { Address } = await import('warthog-js');

  if (clean.length === 40) {
    const derived = Address.fromRaw(clean);
    if (!derived) {
      return { valid: false, error: 'Invalid 40-character account ID' };
    }
    return {
      valid: true,
      format: 'raw',
      accountId: clean,
      fullAddress: derived.hex,
      checksumValid: true,
      message: 'Valid address',
    };
  }

  if (clean.length === 48) {
    if (!Address.validate(clean)) {
      return {
        valid: false,
        error: 'Checksum invalid — one or more characters may be wrong in this 48-character address.',
      };
    }
    return {
      valid: true,
      format: 'full',
      fullAddress: clean,
      accountId: clean.slice(0, 40),
      checksumValid: true,
      message: 'Valid address',
    };
  }

  return {
    valid: false,
    error: `Address must be 40 hex characters (account ID) or 48 hex characters (full address with checksum). You entered ${clean.length}.`,
  };
}

/** Parse a nonce from account data and return the next usable nonce id. */
export async function getNextNonceFromAccount(data) {
  const current =
    data?.nonceId ??
    data?.nonce ??
    data?.balance?.nonceId ??
    data?.wart?.nonceId;
  if (current === undefined || current === null) return 0;
  await ensureBuffer();
  const { NonceId } = await import('warthog-js');
  const nonce = NonceId.fromNumber(Number(current));
  if (!nonce) return 0;
  const next = NonceId.fromNumber(nonce.value + 1);
  return next ? next.value : 0;
}