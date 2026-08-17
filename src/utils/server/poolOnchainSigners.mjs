/**
 * Relays pool_signer_* advance inputs to Cartesi InputBox (Anvil / Mode A).
 * Signatures are the auth; the relayer key only pays gas.
 */
import { JsonRpcProvider, Wallet, Contract, toUtf8Bytes, hexlify } from 'ethers-v6';

const RPC = process.env.CARTESI_RPC_URL || 'http://127.0.0.1:8545';
const DAPP =
  process.env.DAPP_ADDRESS || '0xab7528bb862fB57E8A2BCd567a2e929a0Be56a5e';
const INPUT_BOX =
  process.env.INPUT_BOX || '0x59b22D57D4f067708AB0c00552767405926dc768';
const PK =
  process.env.ANVIL_PK ||
  process.env.RELAYER_PK ||
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

const ABI = ['function addInput(address app, bytes input) returns (bytes32)'];

function envOn(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function onchainSignersEnabled() {
  return envOn('POOL_ONCHAIN_SIGNERS');
}

export function enrollText({ signerId, pubkey, shareIndex, poolId, epoch }) {
  const idx =
    shareIndex == null || shareIndex === '' ? '' : String(Number(shareIndex));
  return [
    'CARTESI-POOL-SIGNER-ENROLL-v1',
    `signerId=${String(signerId || '').trim().toLowerCase()}`,
    `pubkey=${String(pubkey || '').replace(/^0x/i, '').toLowerCase()}`,
    `shareIndex=${idx}`,
    `poolId=${String(poolId || 'wart-pool-0')}`,
    `epoch=${Number(epoch || 1)}`,
  ].join('\n');
}

export function attestText({ ticketId, amountE8, toAddress, poolAddress, epoch }) {
  return [
    'CARTESI-POOL-SIGNER-ATTEST-v1',
    `ticketId=${String(ticketId || '').trim()}`,
    `amountE8=${String(amountE8)}`,
    `toAddress=${String(toAddress || '').replace(/^0x/i, '').toLowerCase()}`,
    `poolAddress=${String(poolAddress || '').replace(/^0x/i, '').toLowerCase()}`,
    `epoch=${Number(epoch || 1)}`,
  ].join('\n');
}

export async function submitPoolSignerInput(input) {
  const provider = new JsonRpcProvider(RPC);
  const wallet = new Wallet(PK, provider);
  const box = new Contract(INPUT_BOX, ABI, wallet);
  const bytes = hexlify(toUtf8Bytes(JSON.stringify(input)));
  let tx;
  try {
    tx = await box.addInput(DAPP, bytes, { gasLimit: 1_500_000n });
  } catch {
    tx = await box.addInput(DAPP, bytes);
  }
  const rec = await tx.wait();
  return {
    ok: true,
    txHash: rec?.hash || tx.hash,
    type: input.type,
  };
}
