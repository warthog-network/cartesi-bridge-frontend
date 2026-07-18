/**
 * Build + 2P-ECDSA sign + submit WART transfer from multi-sig vault.
 * Full private key is never assembled.
 */

import { createWarthogApi } from './warthogClient.js';
import { getSmartNonce, bumpNonceAfterSuccess } from './cancelLimitOrder.js';
import {
  clientSignRound1,
  clientSignFinish,
  buildWartTransferHash,
  wartToE8,
} from './twoPartyEcdsa.js';
import { multiSigSignPartial, multiSigReleaseBudget } from './cosignerClient.js';
import { serializeTransaction } from './warthogTx.js';
import { parseWartBalanceBreakdown } from './warthogFormat.js';
import { isMainnetNode } from './presetNodes.js';

function e8ToWart(e8) {
  try {
    const bn = BigInt(e8 || 0);
    const whole = bn / 100000000n;
    let frac = (bn % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
  } catch {
    return '0';
  }
}

/**
 * Live vault spendable (total − locked − mempool) in E8.
 * @returns {Promise<{ spendableE8: bigint, totalE8: bigint, lockedE8: bigint, mempoolE8: bigint, spendable: string, total: string }>}
 */
export async function fetchVaultSpendableE8(api, vaultAddress, nodeBase) {
  const vaultNorm = String(vaultAddress).replace(/^0x/i, '').toLowerCase();
  const mainnet = isMainnetNode(nodeBase);
  const balRes = mainnet
    ? await api.getAccountBalance(vaultNorm)
    : await api.getAccountWartBalance(vaultNorm);
  if (!balRes.success) throw new Error(balRes.error || 'Failed to fetch vault balance');
  const breakdown = parseWartBalanceBreakdown(balRes.data, { mainnet });
  const totalE8 = BigInt(breakdown.totalE8 ?? 0);
  const lockedE8 = BigInt(breakdown.lockedE8 ?? 0);
  const mempoolE8 = BigInt(breakdown.mempoolE8 ?? 0);
  const spendableE8 =
    breakdown.spendableE8 != null
      ? BigInt(breakdown.spendableE8)
      : totalE8 > lockedE8 + mempoolE8
        ? totalE8 - lockedE8 - mempoolE8
        : 0n;
  return {
    spendableE8,
    totalE8,
    lockedE8,
    mempoolE8,
    spendable: e8ToWart(spendableE8),
    total: e8ToWart(totalE8),
  };
}

/**
 * @param {object} opts
 */
export async function multiSigTransferWart({
  nodeBase,
  vaultAddress,
  toAddress,
  amountWart,
  ownerL1,
  subAddress,
  clientSecret,
  feeWart,
}) {
  const api = await createWarthogApi(nodeBase);
  const { normalizeChainPin } = await import('warthog-js');

  const feeRes = await api.getMinFee();
  if (!feeRes.success) throw new Error(feeRes.error || 'min fee failed');
  let feeE8 = BigInt(feeRes.data.minFee.E8);
  if (feeWart) feeE8 = BigInt(wartToE8(feeWart));

  const headRes = await api.getChainHead();
  if (!headRes.success) throw new Error(headRes.error || 'chain head failed');
  const { pinHash, pinHeight } = normalizeChainPin(headRes.data);

  const vaultNorm = String(vaultAddress).replace(/^0x/i, '').toLowerCase();
  let toNorm = String(toAddress).replace(/^0x/i, '').toLowerCase();
  // Node JSON expects 48-char address; expand 40-char account id with checksum if needed
  if (toNorm.length === 40) {
    const { Address } = await import('warthog-js');
    const expanded = Address.fromRaw(toNorm);
    if (!expanded) throw new Error('Invalid main Warthog address (40 hex)');
    toNorm = expanded.hex;
  } else if (toNorm.length !== 48) {
    throw new Error(
      `Main Warthog address must be 40 or 48 hex chars (got ${toNorm.length}) — not an Ethereum address`,
    );
  }

  const wartE8 = BigInt(wartToE8(amountWart));
  // Live balance check — UI vaultBalance is often stale after partial sweeps/burns
  const live = await fetchVaultSpendableE8(api, vaultNorm, nodeBase);
  const need = wartE8 + feeE8;
  if (need > live.spendableE8) {
    const maxSend = live.spendableE8 > feeE8 ? live.spendableE8 - feeE8 : 0n;
    throw new Error(
      `Insufficient vault balance: need ${e8ToWart(need)} (amount ${e8ToWart(wartE8)} + fee ${e8ToWart(feeE8)}), ` +
        `have ${live.spendable} free` +
        (live.lockedE8 > 0n || live.mempoolE8 > 0n
          ? ` (total ${live.total}, locked ${e8ToWart(live.lockedE8)}, mempool ${e8ToWart(live.mempoolE8)})`
          : '') +
        `. Max sendable ≈ ${e8ToWart(maxSend)} WART.`,
    );
  }

  const nonceId = getSmartNonce(vaultNorm, 0);
  const owner = String(ownerL1).toLowerCase();

  const hashHex = buildWartTransferHash({
    pinHash,
    pinHeight,
    nonceId,
    feeE8,
    toAddrHex: toNorm,
    wartE8,
  });

  const { k1Hex, R1Hex } = clientSignRound1();
  // amountE8 lets cosigner allow partial release: freeable = burned − signed
  const partial = await multiSigSignPartial({
    vaultAddress: vaultNorm,
    owner,
    subAddress,
    R1Hex,
    hashHex,
    amountE8: wartE8.toString(),
    force: false,
  });

  const releaseBudget = async () => {
    try {
      await multiSigReleaseBudget({
        vaultAddress: vaultNorm,
        owner,
        amountE8: wartE8.toString(),
      });
    } catch (e) {
      console.warn('[multiSig] releaseBudget failed', e?.message || e);
    }
  };

  let sig;
  try {
    sig = clientSignFinish({
      k1Hex,
      rHex: partial.rHex,
      ciphertext: partial.ciphertext,
      hashHex,
      clientSecret,
    });
  } catch (e) {
    await releaseBudget();
    throw e;
  }

  const tx = serializeTransaction({
    type: 'wartTransfer',
    pinHeight: Number(pinHeight),
    nonceId: Number(nonceId),
    feeE8: Number(feeE8),
    toAddr: toNorm,
    wartE8: Number(wartE8),
    signature65: sig.signature65,
  });

  const submitResult = await api.submitTransaction(tx);
  if (!submitResult.success) {
    await releaseBudget();
    const err = submitResult.error || 'Node rejected multi-sig transaction';
    if (/insufficient/i.test(String(err))) {
      throw new Error(
        `${err} — live free ${live.spendable} WART (amount+fee must fit). Refresh vault balance and lower amount.`,
      );
    }
    throw new Error(err);
  }

  bumpNonceAfterSuccess(vaultNorm, nonceId, 0);
  return {
    txHash: submitResult.data?.txHash || submitResult.data?.hash,
    data: submitResult.data,
    policy: partial.policy,
    liveBalance: live,
  };
}
