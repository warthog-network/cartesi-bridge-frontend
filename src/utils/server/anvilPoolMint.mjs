/**
 * Mode A: post pool_mint_wwart from a Foundry demo key via localhost Anvil.
 * Wallet addInput has not landed since the last cartesi run wipe (every InputBox
 * tx is the relayer). Same trust model as AnvilTestKeys / deposit relayer.
 */
import { ANVIL_TEST_ACCOUNTS } from '../anvilTestAccounts.js';
import { LOCAL_WWART } from '../localTokens.js';
import { appAddress, inputBoxAddress, l1RpcUrl } from './rollupsApi.mjs';

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
  // Server-side: the same L1 the SSR side already talks to (CARTESI_RPC_URL,
  // http://127.0.0.1:8090/anvil on v2). PUBLIC_L1_RPC is the browser's
  // path ("/rpc") — on 2026-09-11 it reached here, ethers threw
  // "unsupported protocol /rpc" and the orphaned provider retried network
  // detection once a second for the life of the process.
  const rpc = l1RpcUrl();
  if (!/^https?:\/\//i.test(rpc)) {
    throw new Error(`anvil pool input: L1 RPC must be an absolute http(s) URL, got "${rpc}"`);
  }
  // App + InputBox follow the configured rollups API (v2 app, v2 InputBox),
  // not the 1.x defaults this file used to hardcode.
  const dapp = appAddress();
  const boxAddr = inputBoxAddress();
  if (!dapp) throw new Error('anvil pool input: no application address configured');
  // staticNetwork: never re-poll chain id, so a bad endpoint fails once and
  // does not leave a retry loop behind.
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true });
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
