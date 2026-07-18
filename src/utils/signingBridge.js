const AUTO_LOCK_MS = 15 * 60 * 1000;

let worker = null;
let nextRequestId = 0;
const pendingRequests = new Map();

function isBrowser() {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

function getWorker() {
  if (!isBrowser()) return null;
  if (!worker) {
    worker = new Worker(new URL('../workers/signingWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const { requestId, ok, error, ...result } = event.data || {};
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      pendingRequests.delete(requestId);
      if (ok) {
        pending.resolve(result);
      } else {
        pending.reject(new Error(error || 'Signing worker request failed'));
      }
    };
    worker.onerror = (event) => {
      pendingRequests.forEach(({ reject }) => {
        reject(new Error(event.message || 'Signing worker crashed'));
      });
      pendingRequests.clear();
      worker = null;
    };
  }
  return worker;
}

function callWorker(action, payload = {}) {
  const activeWorker = getWorker();
  if (!activeWorker) {
    return Promise.reject(new Error('Signing worker is not available'));
  }

  return new Promise((resolve, reject) => {
    const requestId = ++nextRequestId;
    pendingRequests.set(requestId, { resolve, reject });
    activeWorker.postMessage({ requestId, action, payload });
  });
}

export function getAutoLockMs() {
  return AUTO_LOCK_MS;
}

export async function unlockSigningWorker(privateKey, walletMeta = null) {
  const result = await callWorker('unlock', {
    privateKey,
    publicKey: walletMeta?.publicKey ?? null,
    address: walletMeta?.address ?? null,
  });
  return result;
}

export async function lockSigningWorker() {
  if (!worker) return { unlocked: false };
  return callWorker('lock');
}

export async function getSigningStatus() {
  if (!worker) return { unlocked: false, address: null, publicKey: null };
  return callWorker('status');
}

export async function exportWalletFromWorker() {
  const result = await callWorker('exportWallet');
  return result.wallet;
}

async function buildTransactionOnMainThread(ctxSnapshot, buildSpec) {
  const wallet = await exportWalletFromWorker();
  const { accountFromKnownKeys } = await import('./warthogAccount.js');
  const { ensureWorkerCrypto } = await import('./ensureBuffer.js');
  const { executeBuildSpec } = await import('./txBuildHandlers.js');

  await ensureWorkerCrypto();
  const { TransactionContext, RoundedFee, NonceId } = await import('warthog-js');

  const fee = RoundedFee.fromE8(BigInt(ctxSnapshot.feeE8), true);
  if (!fee) {
    throw new Error('Invalid fee from node');
  }
  const nonce = NonceId.fromNumber(Number(ctxSnapshot.nonceId));
  if (!nonce) {
    throw new Error('Invalid nonce');
  }

  const ctx = new TransactionContext(
    {
      pinHash: String(ctxSnapshot.pinHash).replace(/^0x/i, ''),
      pinHeight: Number(ctxSnapshot.pinHeight),
    },
    fee,
    nonce,
  );

  const account = await accountFromKnownKeys(wallet.privateKey, wallet.publicKey, wallet.address);
  return executeBuildSpec(ctx, account, buildSpec);
}

export async function buildTransactionInWorker(ctxSnapshot, buildSpec) {
  const status = await getSigningStatus();
  if (!status.unlocked) {
    throw new Error('Wallet is locked — unlock to sign transactions');
  }

  // warthog-js crypto (ethers sha256, etc.) is unreliable inside web workers;
  // build and sign on the main thread using keys exported from the worker vault.
  return buildTransactionOnMainThread(ctxSnapshot, buildSpec);
}

export async function signMessageInWorker(message) {
  const status = await getSigningStatus();
  if (!status.unlocked) {
    throw new Error('Wallet is locked — unlock to sign messages');
  }

  const wallet = await exportWalletFromWorker();
  const { ensureWorkerCrypto } = await import('./ensureBuffer.js');
  await ensureWorkerCrypto();
  // Static ethers-v6 import — dynamic import('ethers-v6') 404s under Vite deps
  const { Wallet } = await import('ethers-v6');
  const key = wallet.privateKey.startsWith('0x') ? wallet.privateKey : `0x${wallet.privateKey}`;
  return new Wallet(key).signMessage(message);
}

export function terminateSigningWorker() {
  pendingRequests.forEach(({ reject }) => {
    reject(new Error('Signing worker terminated'));
  });
  pendingRequests.clear();
  if (worker) {
    worker.terminate();
    worker = null;
  }
}