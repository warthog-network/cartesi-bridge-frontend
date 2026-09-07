/**
 * Drop-in replacement for `import { toast } from 'react-hot-toast'`.
 *
 * Behaves identically, but messages sent to a long-running bridge flow
 * (the shared 'pool' / 'eth3p' toast ids) are also recorded in
 * utils/bridgeProgress so <BridgeProgress /> can show them as a step tracker.
 */
import { toast as hot } from 'react-hot-toast';
import { record } from './bridgeProgress.js';

const TRACKED_IDS = new Set(['pool', 'eth3p']);

function wrap(kind, fn) {
  return (msg, opts, ...rest) => {
    try {
      if (opts?.id && TRACKED_IDS.has(opts.id)) record(kind, msg, opts.id);
    } catch {
      /* tracking must never break a toast */
    }
    return fn(msg, opts, ...rest);
  };
}

// A bare toast(msg, { id: 'pool' }) is also a flow step (e.g. the yellow
// 'broadcast accepted' line), so treat it as one.
const toast = wrap('loading', (msg, opts, ...rest) => hot(msg, opts, ...rest));
Object.assign(toast, hot);
toast.loading = wrap('loading', hot.loading.bind(hot));
toast.success = wrap('success', hot.success.bind(hot));
toast.error = wrap('error', hot.error.bind(hot));

export { toast };
export default toast;
