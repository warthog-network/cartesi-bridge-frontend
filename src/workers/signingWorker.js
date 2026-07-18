let privateKey = null;
let publicKey = null;
let address = null;

function normalizePrivateKeyHex(rawKey) {
  const privateKeyHex = String(rawKey).trim().replace(/^0x/i, '');
  if (privateKeyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(privateKeyHex)) {
    throw new Error('Invalid private key');
  }
  return privateKeyHex;
}

function normalizeWalletHex(value) {
  if (value == null) return null;
  const clean = String(value).trim().replace(/^0x/i, '');
  return clean || null;
}

function respond(requestId, payload) {
  self.postMessage({ requestId, ok: true, ...payload });
}

function respondError(requestId, error) {
  const message = error?.message || String(error);
  self.postMessage({
    requestId,
    ok: false,
    error: message,
  });
}

self.onmessage = async (event) => {
  const { requestId, action, payload = {} } = event.data || {};

  try {
    switch (action) {
      case 'unlock': {
        if (!payload.privateKey) {
          throw new Error('Missing private key');
        }
        privateKey = normalizePrivateKeyHex(payload.privateKey);

        const storedPublicKey = normalizeWalletHex(payload.publicKey);
        const storedAddress = normalizeWalletHex(payload.address);

        if (storedPublicKey && storedAddress) {
          publicKey = storedPublicKey;
          address = storedAddress;
        } else {
          throw new Error('Missing public key or address — log out and log in again');
        }

        respond(requestId, { unlocked: true, address, publicKey });
        break;
      }
      case 'lock': {
        privateKey = null;
        publicKey = null;
        address = null;
        respond(requestId, { unlocked: false });
        break;
      }
      case 'status': {
        respond(requestId, { unlocked: !!privateKey, address, publicKey });
        break;
      }
      case 'exportWallet': {
        if (!privateKey || !publicKey || !address) {
          throw new Error('Wallet is locked');
        }
        respond(requestId, {
          wallet: {
            privateKey,
            publicKey,
            address,
          },
        });
        break;
      }
      default:
        throw new Error(`Unknown signing worker action: ${action}`);
    }
  } catch (error) {
    respondError(requestId, error);
  }
};