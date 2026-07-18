import { serializeTransaction } from './warthogTx.js';
import { isValidAssetHash } from './warthogFormat.js';
import { normalizeAssetHash, parseRecipientAddress } from './warthogClient.js';

/** Build and serialize an asset creation transaction. */
export async function buildAssetCreationTx(ctx, account, { name, supply, decimals }) {
  const assetName = name.trim().toUpperCase();
  if (!assetName || assetName.length > 5) {
    throw new Error('Asset name must be 1-5 characters');
  }

  const precisionValue = Math.min(Math.max(parseInt(decimals, 10) || 8, 0), 18);
  const { Funds, TokenPrecision } = await import('warthog-js');
  const precision = new TokenPrecision(precisionValue);
  const totalSupply = Funds.parse(String(supply).trim(), precision);
  if (!totalSupply) {
    throw new Error('Invalid total supply');
  }

  return serializeTransaction(ctx.createAssets(account, totalSupply, precision, assetName));
}

/** Build and serialize a token or liquidity transfer transaction. */
export async function buildAssetTransferTx(ctx, account, {
  assetHash,
  toAddress,
  amount,
  decimals,
  isLiquidity,
}) {
  const hash = normalizeAssetHash(assetHash);
  if (!isValidAssetHash(hash)) {
    throw new Error('Asset hash must be exactly 64 hex characters');
  }

  const { Address, Funds, Liquidity, TokenPrecision } = await import('warthog-js');
  const recipient = parseRecipientAddress(Address, toAddress);
  if (!recipient) {
    throw new Error('Invalid recipient address');
  }

  const amountStr = String(amount).trim();

  const tx = isLiquidity
    ? (() => {
        const units = Liquidity.parse(amountStr);
        if (!units) throw new Error('Invalid liquidity amount');
        return ctx.transferLiquidity(account, hash, recipient, units);
      })()
    : (() => {
        const precision = new TokenPrecision(Math.min(Math.max(parseInt(decimals, 10) || 8, 0), 18));
        const tokenAmount = Funds.parse(amountStr, precision);
        if (!tokenAmount) throw new Error('Invalid token amount');
        return ctx.transferAsset(account, hash, recipient, tokenAmount);
      })();

  return serializeTransaction(tx);
}