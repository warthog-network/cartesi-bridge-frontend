/**
 * Mode A: post pool_mint_wwart from a Foundry demo key via localhost Anvil.
 * Wallet addInput has not landed since the last cartesi run wipe (every InputBox
 * tx is the relayer). Same trust model as AnvilTestKeys / deposit relayer.
 */
import { ANVIL_TEST_ACCOUNTS } from '../anvilTestAccounts.js';
import { LOCAL_WWART } from '../localTokens.js';

function env(key, fallback = '') {
  const e = globalThis.process?.env || {};
  const v = e[key];
  return v == null || v === '' ? fallback : String(v);
}

const ACCOUNT = Object.fromEntries(
  ANVIL_TEST_ACCOUNTS.map((a) => [String(a.address).toLowerCase(), a]),
);

export function anvilDemoAccount(addr) {
  return ACCOUNT[String(addr || '').toLowerCase()] || null;
}

async function submitAnvilPoolInput(owner, payload, mode) {
  const rec = anvilDemoAccount(owner);
  if (!rec) {
    throw new Error(
      'Not an Anvil demo account — connect 0x7099… / 0xf39… or send InputBox from the wallet',
    );
  }
  const { ethers } = await import('ethers-v6');
  // Same Anvil as wallets: nginx /rpc → 127.0.0.1:8545.
  const rpc =
    env('PUBLIC_L1_RPC') ||
    env('CARTESI_PUBLIC_RPC') ||
    'https://cartesi-bridge.duckdns.org/rpc';
  const dapp = env('DAPP_ADDRESS', '0xab7528bb862fB57E8A2BCd567a2e929a0Be56a5e');
  const boxAddr = env('INPUT_BOX', '0x59b22D57D4f067708AB0c00552767405926dc768');
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(rec.privateKey, provider);
  const nonce = await provider.getTransactionCount(wallet.address, 'latest');
  const box = new ethers.Contract(
    boxAddr,
    ['function addInput(address app, bytes input) returns (bytes32)'],
    wallet,
  );
  const bytes = ethers.toUtf8Bytes(JSON.stringify(payload));
  const tx = await box.addInput(dapp, bytes, { nonce });
  const recpt = await tx.wait();
  return {
    ok: true,
    mode,
    owner: rec.address,
    payload,
    txHash: recpt?.hash || tx.hash,
    from: wallet.address,
    nonce,
  };
}

export async function submitAnvilPoolMint({ owner, amount, tokenAddress } = {}) {
  const token = String(tokenAddress || LOCAL_WWART.address || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token)) throw new Error('tokenAddress required');
  const amt = String(amount || '').trim();
  if (!amt || Number(amt) <= 0) throw new Error('amount required');
  return submitAnvilPoolInput(
    owner,
    { type: 'pool_mint_wwart', amount: amt, tokenAddress: token },
    'anvil-demo-mint',
  );
}

export async function submitAnvilPoolWithdraw({ owner, amount } = {}) {
  const amt = String(amount || '').trim();
  if (!amt || Number(amt) <= 0) throw new Error('amount required');
  return submitAnvilPoolInput(
    owner,
    { type: 'pool_withdraw_wwart', amount: amt },
    'anvil-demo-withdraw',
  );
}
