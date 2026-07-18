import { serializeTransaction } from './warthogTx.js';
import { buildAssetCreationTx } from './buildAssetTx.js';
import { parseRecipientAddress } from './warthogClient.js';

/** Build and serialize a transaction from a worker-safe spec object. */
export async function executeBuildSpec(ctx, account, spec) {
  switch (spec.type) {
    case 'TRANSFER_WART': {
      const { Wart, Address } = await import('warthog-js');
      let recipient;
      if (spec.recipientHex) {
        const hex = String(spec.recipientHex).trim().replace(/^0x/i, '');
        if (hex.length !== 48) {
          throw new Error('Invalid recipientHex in build spec (expected 48 hex chars)');
        }
        recipient = new Address(hex);
      } else {
        recipient = parseRecipientAddress(Address, spec.recipient);
      }
      if (!recipient?.hex) {
        throw new Error('Invalid recipient address (expected 40 or 48 hex chars with valid checksum)');
      }
      const wartAmount = Wart.parse(spec.amount);
      if (!wartAmount) {
        throw new Error('Invalid amount');
      }
      return serializeTransaction(ctx.transferWart(account, recipient, wartAmount));
    }
    case 'ASSET_CREATE':
      return buildAssetCreationTx(ctx, account, spec);
    default:
      throw new Error(`Unknown transaction build spec: ${spec.type}`);
  }
}