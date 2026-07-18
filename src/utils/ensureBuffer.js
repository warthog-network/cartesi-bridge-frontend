let bufferReady = false;
let cryptoReady = false;

/** Browser polyfills required by warthog-js and its crypto deps. */
export async function ensureBuffer() {
  if (bufferReady) return;

  if (typeof globalThis.global === 'undefined') {
    globalThis.global = globalThis;
  }

  if (typeof globalThis.process === 'undefined') {
    if (typeof process !== 'undefined') {
      globalThis.process = process;
    } else {
      const processShim = await import('../shims/process.js');
      globalThis.process = processShim.default ?? processShim;
    }
  }

  if (typeof globalThis.Buffer === 'undefined') {
    if (typeof Buffer !== 'undefined') {
      globalThis.Buffer = Buffer;
    } else {
      const { Buffer: BufferPolyfill } = await import('buffer');
      globalThis.Buffer = BufferPolyfill;
    }
  }

  bufferReady = true;
}

/** Warm up crypto after Buffer exists — required before warthog-js loads in workers. */
export async function ensureWorkerCrypto() {
  await ensureBuffer();
  if (cryptoReady) return;

  const { createHash } = await import('crypto');
  createHash('sha256').update(globalThis.Buffer.alloc(0)).digest();
  cryptoReady = true;
}