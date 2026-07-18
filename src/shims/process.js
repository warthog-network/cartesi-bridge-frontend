/** Minimal ESM process shim for browser (avoids CJS process/browser.js). */
const processShim = {
  env: {},
  browser: true,
  version: '',
  versions: {},
  nextTick(fn, ...args) {
    queueMicrotask(() => fn(...args));
  },
};

export default processShim;