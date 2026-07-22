/**
 * Build human-readable MetaMask pre-confirm descriptions for Cartesi L1 txs.
 * MetaMask itself only shows ABI-decoded calldata (often opaque hex for bytes);
 * these helpers surface the JSON / decoded payload the user is about to send.
 */

import { getAddress, formatUnits } from 'ethers-v6';
import { decodeVoucherPayload, tokenLabel, getDappAddress } from './vouchers.js';

function shortAddr(a) {
  const s = String(a || '');
  if (s.length < 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function safeJson(value) {
  try {
    return JSON.parse(
      JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  } catch {
    return value;
  }
}

/** Friendly title for rollup InputBox JSON payloads. */
export function describeRollupInput(payload, opts = {}) {
  const body = payload && typeof payload === 'object' ? payload : { raw: payload };
  const type = String(body.type || body.action || 'input');
  const titles = {
    register_address: 'Register L1 address',
    withdraw_wwart: 'Withdraw wWART (rollup → voucher)',
    withdraw_eth: 'Withdraw ETH (rollup → voucher)',
    withdraw_ctsi: 'Withdraw CTSI (rollup → voucher)',
    withdraw_usdc: 'Withdraw USDC (rollup → voucher)',
    mint_wwart: 'Mint wWART claim',
    burn_wwart: 'Burn wWART claims',
    create_vault: 'Create multi-sig vault',
    sub_lock: 'Sub-lock (fund capacity)',
    sweep_lock: 'Sweep lock (lock WART)',
  };
  const title = titles[type] || `Rollup input · ${type}`;
  const utf8 = JSON.stringify(body);
  const lines = [
    `Method: InputBox.addInput`,
    `dApp: ${shortAddr(opts.dappAddress || getDappAddress())}`,
    `type: ${type}`,
  ];
  if (body.amount != null) lines.push(`amount: ${body.amount}`);
  if (body.subAddress) lines.push(`sub: ${shortAddr(body.subAddress)}`);
  if (body.vaultAddress) lines.push(`vault: ${shortAddr(body.vaultAddress)}`);

  return {
    kind: 'rollup_input',
    title,
    method: 'InputBox.addInput(dapp, bytes input)',
    summary: lines.join('\n'),
    /** What MetaMask encodes as the `input` bytes (UTF-8 JSON). */
    payloadJson: safeJson(body),
    payloadUtf8: utf8,
    sections: [
      {
        label: 'Rollup input JSON (sent as UTF-8 bytes)',
        json: safeJson(body),
      },
      opts.dappAddress || getDappAddress()
        ? {
            label: 'Call context',
            json: {
              contract: 'InputBox',
              method: 'addInput',
              dappAddress: opts.dappAddress || getDappAddress(),
              inputEncoding: 'utf-8 JSON',
              inputByteLength: new TextEncoder().encode(utf8).length,
            },
          }
        : null,
    ].filter(Boolean),
  };
}

/** Full descriptive view for Application.executeVoucher. */
export function describeVoucherExecute(voucher, opts = {}) {
  const decoded = voucher?.decoded || decodeVoucherPayload(voucher?.payload);
  const token = voucher?.token || tokenLabel(voucher?.destination);
  const title = [
    'Execute voucher',
    token || null,
    decoded?.label || null,
  ]
    .filter(Boolean)
    .join(' · ');

  const outIdx =
    voucher?.proof?.validity?.outputIndexWithinInput != null
      ? Number(voucher.proof.validity.outputIndexWithinInput)
      : voucher?.voucherIndex;

  const decodedJson = {
    kind: decoded?.kind,
    label: decoded?.label,
    token: token || null,
    to: decoded?.to || null,
    amount: decoded?.amount != null ? String(decoded.amount) : null,
    amountHuman: decoded?.amountHuman != null ? String(decoded.amountHuman) : null,
  };

  const voucherJson = {
    inputIndex: voucher?.inputIndex,
    voucherIndex: voucher?.voucherIndex,
    outputIndexWithinInput: outIdx,
    destination: voucher?.destination,
    destinationToken: token || null,
    msgSender: voucher?.msgSender || null,
    timestamp: voucher?.timestamp || null,
    payload: voucher?.payload,
    decoded: decodedJson,
    summary: voucher?.summary || null,
  };

  const proofJson = voucher?.proof
    ? {
        hasProof: true,
        context: voucher.proof.context || null,
        validity: voucher.proof.validity
          ? {
              inputIndexWithinEpoch: String(
                voucher.proof.validity.inputIndexWithinEpoch ?? '',
              ),
              outputIndexWithinInput: String(
                voucher.proof.validity.outputIndexWithinInput ?? '',
              ),
              outputHashesRootHash: voucher.proof.validity.outputHashesRootHash,
              vouchersEpochRootHash: voucher.proof.validity.vouchersEpochRootHash,
              noticesEpochRootHash: voucher.proof.validity.noticesEpochRootHash,
              machineStateHash: voucher.proof.validity.machineStateHash,
              outputHashInOutputHashesSiblings: (
                voucher.proof.validity.outputHashInOutputHashesSiblings || []
              ).map(String),
              outputHashesInEpochSiblings: (
                voucher.proof.validity.outputHashesInEpochSiblings || []
              ).map(String),
            }
          : null,
      }
    : { hasProof: false };

  const lines = [
    `Method: Application.executeVoucher`,
    `App: ${shortAddr(opts.dappAddress || getDappAddress())}`,
    `input #${voucher?.inputIndex} · voucher #${voucher?.voucherIndex}`,
    decoded?.label ? `action: ${decoded.label}` : null,
    token ? `token: ${token}` : `dest: ${shortAddr(voucher?.destination)}`,
    decoded?.amountHuman != null
      ? `amount: ${decoded.amountHuman}${token ? ` ${token}` : ''}`
      : null,
    decoded?.to ? `to: ${shortAddr(decoded.to)}` : null,
  ].filter(Boolean);

  return {
    kind: 'execute_voucher',
    title,
    method: 'Application.executeVoucher(destination, payload, proof)',
    summary: lines.join('\n'),
    payloadJson: safeJson(voucherJson),
    sections: [
      { label: 'Voucher', json: safeJson(voucherJson) },
      { label: 'Decoded payload', json: safeJson(decodedJson) },
      { label: 'Epoch proof', json: safeJson(proofJson) },
      {
        label: 'Call context',
        json: {
          contract: 'Application (dApp)',
          method: 'executeVoucher',
          dappAddress: opts.dappAddress || getDappAddress(),
          destination: voucher?.destination,
          payloadHex: voucher?.payload,
        },
      },
    ],
  };
}

/** Portal deposit description (ETH / ERC-20). */
export function describePortalDeposit({
  kind = 'erc20',
  tokenSymbol,
  tokenAddress,
  amount,
  amountHuman,
  dappAddress,
  portalAddress,
} = {}) {
  const title =
    kind === 'eth'
      ? `Deposit ETH → rollup`
      : `Deposit ${tokenSymbol || 'ERC-20'} → rollup`;
  const json = {
    kind: kind === 'eth' ? 'depositEther' : 'depositERC20Tokens',
    portal: portalAddress || null,
    dapp: dappAddress || getDappAddress(),
    token: tokenAddress || null,
    tokenSymbol: tokenSymbol || null,
    amount: amount != null ? String(amount) : null,
    amountHuman: amountHuman != null ? String(amountHuman) : null,
    execLayerData: '0x',
  };
  return {
    kind: 'portal_deposit',
    title,
    method:
      kind === 'eth'
        ? 'EtherPortal.depositEther(dapp, execLayerData) + value'
        : 'ERC20Portal.depositERC20Tokens(token, dapp, amount, execLayerData)',
    summary: [
      `Method: ${json.kind}`,
      amountHuman != null
        ? `amount: ${amountHuman}${tokenSymbol ? ` ${tokenSymbol}` : kind === 'eth' ? ' ETH' : ''}`
        : null,
      `dApp: ${shortAddr(json.dapp)}`,
    ]
      .filter(Boolean)
      .join('\n'),
    payloadJson: safeJson(json),
    sections: [{ label: 'Portal deposit', json: safeJson(json) }],
  };
}

export function describeErc20Approve({
  tokenSymbol,
  tokenAddress,
  spender,
  amount,
  amountHuman,
} = {}) {
  const json = {
    kind: 'approve',
    token: tokenAddress || null,
    tokenSymbol: tokenSymbol || null,
    spender: spender || null,
    amount: amount != null ? String(amount) : null,
    amountHuman: amountHuman != null ? String(amountHuman) : null,
  };
  return {
    kind: 'erc20_approve',
    title: `Approve ${tokenSymbol || 'token'} for portal`,
    method: 'ERC20.approve(spender, amount)',
    summary: [
      `spender: ${shortAddr(spender)}`,
      amountHuman != null
        ? `amount: ${amountHuman}${tokenSymbol ? ` ${tokenSymbol}` : ''}`
        : null,
    ]
      .filter(Boolean)
      .join('\n'),
    payloadJson: safeJson(json),
    sections: [{ label: 'Approve', json: safeJson(json) }],
  };
}

/** Pretty-print for modal pre blocks. */
export function formatDescribeJson(value, space = 2) {
  try {
    return JSON.stringify(
      value,
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      space,
    );
  } catch {
    return String(value);
  }
}

export { shortAddr, formatUnits, getAddress };
