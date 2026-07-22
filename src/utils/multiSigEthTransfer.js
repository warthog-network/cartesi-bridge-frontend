/**
 * Cosigner ETH vault → main (MetaMask) transfer.
 * Gated by eth_release_ticket freeable (same 2P-ECDSA Lindell as WART).
 * Full private key never assembled.
 */

import { ethers, Signature } from 'ethers-v6';
import {
  clientSignRound1,
  clientSignFinish,
  decryptJsonWithMnemonic,
} from './twoPartyEcdsa.js';
import { multiSigSignPartial, multiSigReleaseBudget } from './cosignerClient.js';

const GAS_LIMIT = 21_000n;

/**
 * @param {object} opts
 * @param {import('ethers-v6').Provider} opts.provider
 * @param {string} opts.vaultAddress - cosigner ETH vault (0x…)
 * @param {string} opts.toAddress - MetaMask main (allowlisted)
 * @param {string|bigint} opts.amountEth - human ETH or wei if amountIsWei
 * @param {string} opts.ownerL1 - MetaMask owner
 * @param {string} [opts.subAddress]
 * @param {object} opts.clientSecret - decrypted user half
 * @param {boolean} [opts.amountIsWei]
 */
export async function multiSigTransferEth({
  provider,
  vaultAddress,
  toAddress,
  amountEth,
  ownerL1,
  subAddress = null,
  clientSecret,
  amountIsWei = false,
}) {
  if (!provider) throw new Error('L1 provider required');
  if (!clientSecret?.userShareHex) {
    throw new Error('clientSecret (user half) required — unlock Warthog / vault share');
  }

  const vault = ethers.getAddress(
    String(vaultAddress).startsWith('0x') ? vaultAddress : `0x${vaultAddress}`,
  );
  const to = ethers.getAddress(
    String(toAddress).startsWith('0x') ? toAddress : `0x${toAddress}`,
  );
  const owner = String(ownerL1).toLowerCase();

  let amountWei;
  try {
    amountWei = amountIsWei
      ? BigInt(String(amountEth))
      : ethers.parseEther(String(amountEth).trim());
  } catch {
    throw new Error('Invalid ETH amount');
  }
  if (amountWei <= 0n) throw new Error('Amount must be > 0');

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const nonce = await provider.getTransactionCount(vault, 'pending');
  const fee = await provider.getFeeData();
  const maxPriority =
    fee.maxPriorityFeePerGas != null && fee.maxPriorityFeePerGas > 0n
      ? fee.maxPriorityFeePerGas
      : 1_000_000_000n;
  const maxFee =
    fee.maxFeePerGas != null && fee.maxFeePerGas > maxPriority
      ? fee.maxFeePerGas
      : maxPriority * 2n;

  const bal = await provider.getBalance(vault);
  const need = amountWei + GAS_LIMIT * maxFee;
  if (bal < need) {
    throw new Error(
      `Vault L1 balance ${ethers.formatEther(bal)} ETH — need ~${ethers.formatEther(need)} (amount + gas)`,
    );
  }

  // Cap amount if user asked max that doesn't leave gas
  let sendWei = amountWei;
  if (bal < amountWei + GAS_LIMIT * maxFee) {
    const maxSend = bal > GAS_LIMIT * maxFee ? bal - GAS_LIMIT * maxFee : 0n;
    if (maxSend <= 0n) throw new Error('Vault balance too low for gas');
    sendWei = maxSend < amountWei ? maxSend : amountWei;
  }

  const txFields = {
    type: 2,
    chainId,
    nonce,
    maxPriorityFeePerGas: maxPriority,
    maxFeePerGas: maxFee,
    gasLimit: GAS_LIMIT,
    to,
    value: sendWei,
    data: '0x',
  };

  const unsigned = ethers.Transaction.from(txFields);
  const hashHex = String(unsigned.unsignedHash).replace(/^0x/i, '');

  const vaultBare = vault.replace(/^0x/i, '').toLowerCase();
  const { k1Hex, R1Hex } = clientSignRound1();

  const partial = await multiSigSignPartial({
    vaultAddress: vaultBare,
    owner,
    subAddress,
    R1Hex,
    hashHex,
    amountWei: sendWei.toString(),
    amountE8: sendWei.toString(), // alias for older cosigners
    toAddress: to,
    chain: 'eth',
    force: false,
  });

  const releaseBudget = async () => {
    try {
      await multiSigReleaseBudget({
        vaultAddress: vaultBare,
        owner,
        amountE8: sendWei.toString(),
      });
    } catch (e) {
      console.warn('[multiSigEth] releaseBudget failed', e?.message || e);
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

  // yParity for EIP-1559 = recid 0|1
  const yParity = Number(sig.recid) % 2;
  const signature = Signature.from({
    r: '0x' + sig.r,
    s: '0x' + sig.s,
    yParity,
  });

  let signed;
  try {
    signed = ethers.Transaction.from({
      ...txFields,
      signature,
    });
  } catch (e) {
    await releaseBudget();
    throw new Error('Failed to assemble signed ETH tx: ' + (e?.message || e));
  }

  let txResponse;
  try {
    txResponse = await provider.broadcastTransaction(signed.serialized);
  } catch (e) {
    await releaseBudget();
    throw new Error(e?.shortMessage || e?.message || 'Broadcast failed');
  }

  const receipt = await txResponse.wait?.(1);
  return {
    txHash: txResponse.hash || receipt?.hash,
    amountWei: sendWei.toString(),
    amountEth: ethers.formatEther(sendWei),
    policy: partial.policy,
    receipt,
  };
}

/**
 * Load + decrypt eth vault clientSecret from localStorage share.
 */
export async function loadEthVaultClientSecret(mnemonic, mainAddress, ethSubAddress) {
  const { loadTwoPartyEthClientLocal } = await import('./twoPartyEcdsa.js');
  const local = loadTwoPartyEthClientLocal(mainAddress, ethSubAddress);
  if (!local?.encryptedClientSecret) {
    throw new Error(
      'No local ETH vault share — create cosigner ETH vault again (or import vault share)',
    );
  }
  return decryptJsonWithMnemonic(local.encryptedClientSecret, mnemonic);
}
