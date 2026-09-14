/**
 * Drop-in replacement for `import { toast } from 'react-hot-toast'`.
 *
 * Behaves identically, but messages sent to a long-running bridge flow
 * (the shared 'pool' / 'eth3p' toast ids) are also recorded in
 * utils/bridgeProgress so <BridgeProgress /> can show them as a step tracker.
 *
 * In Simple UI mode (utils/uiMode) the most common flow messages are rewritten
 * into plain language before they are shown or recorded, so a newcomer reads
 * "Creating 12 wWART on the bridge…" instead of "Minting 12 claim via Anvil
 * InputBox…". Advanced mode shows the original text.
 */
import { toast as hot } from 'react-hot-toast';
import { record } from './bridgeProgress.js';
import { isSimpleMode } from './uiMode.js';

const TRACKED_IDS = new Set(['pool', 'eth3p']);

// [pattern, replacement | fn]. First match wins. Keep each replacement to
// what happened + what to do; drop protocol nouns (InputBox, voucher, notice,
// mint, claim, Anvil, 3P, d1/d2, Lindell).
const PLAIN = [
  [/^Minting (.+?) claim via Anvil InputBox…$/, 'Creating $1 wWART on the bridge…'],
  [/^Minting (.+?)…$/, 'Creating $1 wWART…'],
  [/^Sending (.+?) WART → pool…$/, 'Sending $1 WART to the bridge…'],
  [/^Sending (.+?) WART…$/, 'Sending $1 WART…'],
  [/^Waiting for 1 Warthog confirmation.*$/, 'Waiting for the Warthog network to confirm (about a minute)…'],
  [/^Pool credit: (\d+)\/(\d+) confirmations$/, 'Confirming on Warthog: $1 of $2'],
  [/^Pool credit: (.+)$/, 'Bridge received your WART: $1'],
  [/^Confirm pool_deposit in MetaMask \(Anvil\)…$/, 'Confirm the deposit in MetaMask…'],
  [/^Withdrawing (.+?) \(InputBox → voucher\)…$/, 'Withdrawing $1 through the bridge…'],
  [/^New voucher #\d+ — open Vouchers → Execute.*$/, 'Withdrawal ready — press Execute to receive it'],
  [/^wWART → WART: burn (.+?) and pay…$/, 'Converting $1 wWART back to WART…'],
  [/^1-click: using your unused deposit…$/, 'Using the WART you already sent…'],
  [/^Payout ticket (.+?)…$/, 'Requesting your payout…'],
  [/^3P pool: waiting for d1 \+ d2 on .+$/, 'Bridge signers are approving your withdrawal…'],
  [
    /^3P Lindell · (.*)$/,
    (m) => {
      const rest = m[1] || '';
      let why = '';
      if (/notice proof|epoch not claimed|validateNotice/i.test(rest)) {
        why = ' The bridge is confirming your request first, usually under 5 minutes.';
      } else if (/vacant/i.test(rest)) {
        why = ' One signer is offline; it resumes as soon as that signer is back.';
      } else if (/not synced|not running|catch/i.test(rest)) {
        why = ' A signer is catching up with the network.';
      }
      return `Bridge signers are approving your withdrawal…${why}`;
    },
  ],
  [
    /^3P payout timeout for .+$/,
    'Your withdrawal is taking longer than usual. It stays queued and pays automatically when the signers are ready; you can check back later.',
  ],
  [/^Burn not confirmed.*$/, 'Still confirming, nothing to do. This usually takes about a minute.'],
  [/^Checking WART↔ETH bind…$/, 'Checking your wallet link…'],
  [/^Pool refreshed$/, 'Updated'],
  [/^Wallet network OK for Anvil$/, 'Network set up'],
  [/^Copy failed$/, 'Could not copy — your browser blocked clipboard access'],
];

export function plainMessage(msg) {
  if (typeof msg !== 'string') return msg;
  for (const [re, rep] of PLAIN) {
    const m = msg.match(re);
    if (!m) continue;
    return typeof rep === 'function' ? rep(m) : msg.replace(re, rep);
  }
  return msg;
}

function wrap(kind, fn) {
  return (msg, opts, ...rest) => {
    let text = msg;
    try {
      if (isSimpleMode()) text = plainMessage(msg);
    } catch {
      /* never let translation break a toast */
    }
    try {
      if (opts?.id && TRACKED_IDS.has(opts.id)) record(kind, text, opts.id);
    } catch {
      /* tracking must never break a toast */
    }
    return fn(text, opts, ...rest);
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
