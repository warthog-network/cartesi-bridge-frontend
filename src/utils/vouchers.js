/**
 * Fetch Cartesi rollup vouchers and execute them on L1 (Application.executeVoucher).
 */
import { Interface, getAddress, formatUnits } from 'ethers-v6';
import { getRollupGraphqlUrl, getAddresses, LOCAL_ADDRESSES } from './bridgeConfig.js';
import { LOCAL_WWART } from './localTokens.js';

const APP_ABI = [
  'function executeVoucher(address _destination, bytes _payload, tuple(tuple(uint64 inputIndexWithinEpoch, uint64 outputIndexWithinInput, bytes32 outputHashesRootHash, bytes32 vouchersEpochRootHash, bytes32 noticesEpochRootHash, bytes32 machineStateHash, bytes32[] outputHashInOutputHashesSiblings, bytes32[] outputHashesInEpochSiblings) validity, bytes context) _proof) returns (bool)',
  'function wasVoucherExecuted(uint256 _inputIndex, uint256 _outputIndexWithinInput) view returns (bool)',
];

const TRANSFER_SEL = '0xa9059cbb';
const MINT_SEL = '0x40c10f19';
// Cartesi EtherVoucher / withdrawEther-style (common)
const WITHDRAW_ETHER_SEL = '0x522f6815'; // withdrawEther(address,uint256) used by some stacks

export function getDappAddress() {
  const a = getAddresses() || LOCAL_ADDRESSES;
  return a.dapp || LOCAL_ADDRESSES.dapp;
}

export function decodeVoucherPayload(payload) {
  const hex = String(payload || '').toLowerCase();
  if (!hex.startsWith('0x') || hex.length < 10) {
    return { kind: 'unknown', label: 'Unknown payload', raw: payload };
  }
  const sel = hex.slice(0, 10);
  try {
    if ((sel === TRANSFER_SEL || sel === MINT_SEL) && hex.length >= 10 + 64 + 64) {
      const to = getAddress('0x' + hex.slice(10 + 24, 10 + 64));
      const amount = BigInt('0x' + hex.slice(10 + 64, 10 + 128));
      return {
        kind: sel === MINT_SEL ? 'mint' : 'transfer',
        label: sel === MINT_SEL ? 'ERC-20 mint' : 'ERC-20 transfer',
        to,
        amount,
        amountHuman: formatUnits(amount, 18),
      };
    }
    if (sel === WITHDRAW_ETHER_SEL && hex.length >= 10 + 64 + 64) {
      const to = getAddress('0x' + hex.slice(10 + 24, 10 + 64));
      const amount = BigInt('0x' + hex.slice(10 + 64, 10 + 128));
      return {
        kind: 'ether',
        label: 'ETH withdraw',
        to,
        amount,
        amountHuman: formatUnits(amount, 18),
      };
    }
  } catch {
    /* fall through */
  }
  return { kind: 'unknown', label: `Calldata ${sel}`, raw: payload };
}

export function tokenLabel(destination) {
  const d = String(destination || '').toLowerCase();
  const wwart = String(LOCAL_WWART?.address || '').toLowerCase();
  if (wwart && d === wwart) return 'wWART';
  if (d === '0xae7f61ecf06c65405560166b259c54031428a9c4') return 'CTSI';
  if (d === '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238') return 'USDC';
  return null;
}

/**
 * @param {{ last?: number, signal?: AbortSignal }} [opts]
 */
export async function fetchVouchers(opts = {}) {
  const last = opts.last ?? 40;
  const graphql = getRollupGraphqlUrl();
  const query = `{
    vouchers(last: ${last}) {
      edges {
        node {
          index
          destination
          payload
          input { index msgSender timestamp }
          proof {
            context
            validity {
              inputIndexWithinEpoch
              outputIndexWithinInput
              outputHashesRootHash
              vouchersEpochRootHash
              noticesEpochRootHash
              machineStateHash
              outputHashInOutputHashesSiblings
              outputHashesInEpochSiblings
            }
          }
        }
      }
    }
  }`;

  const res = await fetch(graphql, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query }),
    cache: 'no-store',
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0]?.message || 'GraphQL error');

  const edges = data?.data?.vouchers?.edges || [];
  return edges
    .map((e) => e?.node)
    .filter(Boolean)
    .map((n) => {
      const decoded = decodeVoucherPayload(n.payload);
      const dest = n.destination;
      const token = tokenLabel(dest);
      const validity = n.proof?.validity || null;
      // Epoch proofs need sibling arrays — bare `validity: {}` is not executable.
      const hasProof = Boolean(
        validity &&
          validity.outputHashesRootHash &&
          validity.vouchersEpochRootHash &&
          validity.machineStateHash &&
          Array.isArray(validity.outputHashInOutputHashesSiblings) &&
          validity.outputHashInOutputHashesSiblings.length > 0 &&
          Array.isArray(validity.outputHashesInEpochSiblings) &&
          validity.outputHashesInEpochSiblings.length > 0,
      );
      return {
        inputIndex: Number(n.input?.index),
        voucherIndex: Number(n.index),
        destination: dest,
        payload: n.payload,
        msgSender: n.input?.msgSender || null,
        timestamp: n.input?.timestamp != null ? Number(n.input.timestamp) : null,
        proof: n.proof || null,
        hasProof,
        decoded,
        token,
        summary: [
          token || shortAddr(dest),
          decoded.label,
          decoded.amountHuman != null ? `${decoded.amountHuman}` : null,
          decoded.to ? `→ ${shortAddr(decoded.to)}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      };
    })
    // newest first
    .sort((a, b) => {
      if (b.inputIndex !== a.inputIndex) return b.inputIndex - a.inputIndex;
      return b.voucherIndex - a.voucherIndex;
    });
}

function shortAddr(a) {
  const s = String(a || '');
  if (s.length < 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function toBytes32(v) {
  let h = String(v || '');
  if (!h.startsWith('0x') && !h.startsWith('0X')) h = '0x' + h;
  if (h.length === 66) return h;
  // pad
  return '0x' + h.replace(/^0x/i, '').padStart(64, '0');
}

function toBytes32Array(arr) {
  return (arr || []).map(toBytes32);
}

/**
 * Build ethers Proof tuple for executeVoucher.
 */
export function proofToEthers(proof) {
  if (!proof?.validity) throw new Error('Voucher has no proof yet (wait for epoch)');
  const v = proof.validity;
  return {
    validity: {
      inputIndexWithinEpoch: BigInt(v.inputIndexWithinEpoch),
      outputIndexWithinInput: BigInt(v.outputIndexWithinInput),
      outputHashesRootHash: toBytes32(v.outputHashesRootHash),
      vouchersEpochRootHash: toBytes32(v.vouchersEpochRootHash),
      noticesEpochRootHash: toBytes32(v.noticesEpochRootHash),
      machineStateHash: toBytes32(v.machineStateHash),
      outputHashInOutputHashesSiblings: toBytes32Array(v.outputHashInOutputHashesSiblings),
      outputHashesInEpochSiblings: toBytes32Array(v.outputHashesInEpochSiblings),
    },
    context: proof.context?.startsWith?.('0x') ? proof.context : `0x${proof.context || ''}`,
  };
}

/**
 * @param {import('ethers-v6').Signer} signer
 * @param {object} voucher from fetchVouchers
 */
export async function wasVoucherExecuted(signerOrProvider, voucher) {
  const dapp = getDappAddress();
  const { Contract } = await import('ethers-v6');
  const app = new Contract(dapp, APP_ABI, signerOrProvider);
  const outIdx =
    voucher.proof?.validity?.outputIndexWithinInput != null
      ? voucher.proof.validity.outputIndexWithinInput
      : voucher.voucherIndex;
  return app.wasVoucherExecuted(voucher.inputIndex, outIdx);
}

/**
 * Human-readable L1 / MetaMask error for voucher execute.
 */
export function formatVoucherExecuteError(e) {
  const raw =
    e?.shortMessage ||
    e?.reason ||
    e?.info?.error?.message ||
    e?.data?.message ||
    e?.message ||
    String(e || 'unknown');
  const s = String(raw);
  if (/user rejected|user denied|ACTION_REJECTED|4001/i.test(s)) {
    return 'MetaMask rejected executeVoucher — open Vouchers → Execute and approve (do not re-deposit)';
  }
  if (/Already executed/i.test(s)) {
    return 'That voucher was already executed — check MetaMask wWART balance';
  }
  if (/missing revert data|estimateGas|CALL_EXCEPTION/i.test(s)) {
    return (
      'executeVoucher gas estimate failed (often an already-used voucher or MetaMask estimateGas flake). ' +
      'Refresh Vouchers, pick the newest ready row for your amount, or retry — do not re-deposit. ' +
      'Wallet RPC must be https://cartesi-bridge.duckdns.org/rpc (Anvil 31337).'
    );
  }
  if (/Proof not ready|no proof|sibling/i.test(s)) {
    return 'Voucher proof not ready yet — wait a few epochs, then Vouchers → Execute';
  }
  if (/network|chainId|chain id/i.test(s)) {
    return `Wrong network for executeVoucher — switch MetaMask to Anvil (31337). ${s}`;
  }
  if (/NotMinter|not minter|execution reverted/i.test(s)) {
    return `executeVoucher reverted (often minter/dApp mismatch or bad proof): ${s}`;
  }
  return s.length > 220 ? `${s.slice(0, 220)}…` : s;
}

/**
 * Execute a voucher on L1 via connected MetaMask signer.
 *
 * MetaMask often fails `estimateGas` on large Cartesi proofs with
 * "missing revert data" even when the call is valid. We staticCall first,
 * then send with an explicit gasLimit to skip estimateGas.
 *
 * @returns {Promise<{ hash: string, receipt: any }>}
 */
export async function executeVoucherOnL1(signer, voucher) {
  if (!voucher?.hasProof) throw new Error('Proof not ready — wait a few blocks/epochs, then refresh');
  const dapp = getDappAddress();
  if (!dapp || /^0x0{40}$/i.test(dapp)) {
    throw new Error('dApp address not configured — cannot execute voucher');
  }
  const { Contract } = await import('ethers-v6');
  const app = new Contract(dapp, APP_ABI, signer);

  const outIdx =
    voucher.proof?.validity?.outputIndexWithinInput != null
      ? Number(voucher.proof.validity.outputIndexWithinInput)
      : voucher.voucherIndex;

  try {
    const done = await app.wasVoucherExecuted(voucher.inputIndex, outIdx);
    if (done) throw new Error('Already executed on L1');
  } catch (e) {
    if (String(e.message || e).includes('Already executed')) throw e;
    // wasVoucherExecuted may revert on some nodes — continue
  }

  const proof = proofToEthers(voucher.proof);
  const args = [voucher.destination, voucher.payload, proof];

  // Simulate with eth_call (more reliable than estimateGas for huge proofs)
  try {
    if (typeof app.executeVoucher?.staticCall === 'function') {
      await app.executeVoucher.staticCall(...args);
    }
  } catch (e) {
    // Re-check executed — Cartesi often returns empty revert data for already-used vouchers
    try {
      const done = await app.wasVoucherExecuted(voucher.inputIndex, outIdx);
      if (done) throw new Error('Already executed on L1');
    } catch (e2) {
      if (String(e2.message || e2).includes('Already executed')) throw e2;
    }
    const msg = formatVoucherExecuteError(e);
    const err = new Error(msg);
    err.cause = e;
    throw err;
  }

  // Explicit gas: skip MetaMask estimateGas (source of "missing revert data" on this stack)
  const gasOverrides = { gasLimit: 1_500_000n };
  try {
    // Optional: tighten gas if node estimate works; ignore failures
    const est = await app.executeVoucher.estimateGas(...args);
    if (est && est > 0n) {
      // 30% buffer, cap 3M
      const buffered = (est * 130n) / 100n;
      gasOverrides.gasLimit = buffered > 3_000_000n ? 3_000_000n : buffered < 300_000n ? 500_000n : buffered;
    }
  } catch {
    /* keep fixed 1.5M — intentional */
  }

  try {
    const tx = await app.executeVoucher(...args, gasOverrides);
    const receipt = await tx.wait();
    if (receipt && receipt.status === 0) {
      throw new Error('executeVoucher mined but reverted — try newest voucher only');
    }
    return { hash: tx.hash, receipt };
  } catch (e) {
    if (/Already executed/i.test(String(e?.message || ''))) throw e;
    try {
      const done = await app.wasVoucherExecuted(voucher.inputIndex, outIdx);
      if (done) throw new Error('Already executed on L1');
    } catch (e2) {
      if (String(e2.message || e2).includes('Already executed')) throw e2;
    }
    const err = new Error(formatVoucherExecuteError(e));
    err.cause = e;
    throw err;
  }
}

export { APP_ABI };
