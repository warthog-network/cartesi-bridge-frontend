/**
 * Live bridge step store.
 *
 * Every long-running Path A / ETH 3P flow already narrates itself through a
 * single react-hot-toast id ('pool' / 'eth3p'). A toast shows one line at a
 * time and then disappears — you cannot see where you are in the run.
 *
 * This store tapes those same messages into an ordered, persistent step list
 * so <BridgeProgress /> can render them as a tunnel-style tracker while the
 * toasts keep working exactly as before.
 *
 * Fed by utils/trackedToast.js — no call site changes needed.
 */

const MAX_HISTORY = 4;
const MAX_STEPS = 40;

let state = { current: null, history: [], pipeline: [] };
const listeners = new Set();
let seq = 0;

function emit() {
  // New object identity every change so useSyncExternalStore re-renders.
  state = { ...state };
  for (const fn of listeners) fn();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSnapshot() {
  return state;
}

/** Server render / prerender has no activity. */
export function getServerSnapshot() {
  return { current: null, history: [], pipeline: [] };
}

/**
 * Collapse the variable parts of a status line so a step that only updates its
 * own detail (poll counters, tx hashes, block heights) stays one step instead
 * of pushing a new row every tick.
 */
function stepKey(msg) {
  return String(msg)
    .replace(/0x[0-9a-fA-F]+/g, '·')
    .replace(/\b[0-9a-fA-F]{16,}\b/g, '·')
    .replace(/[\d][\d.,]*/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const TITLE_RULES = [
  [/^1-click/i, 'One-click bridge'],
  [/portal-deposit/i, 'wWART → WART'],
  [/wwart\s*→\s*wart|burn .* and pay/i, 'wWART → WART'],
  [/wart\s*→\s*wwart/i, 'WART → wWART'],
  [/eth 3p|redeem/i, 'wETH → ETH'],
  [/deposit adapter|sending .* eth\b/i, 'ETH → wETH'],
  [/minting .*(weth|receipt)/i, 'ETH → wETH'],
  [/^withdraw|voucher/i, 'Withdraw → L1'],
  [/^minting|mint claim/i, 'Mint claim'],
  [/sending .* wart|verifying warthog deposit|pool credit|queueing credit/i, 'Deposit WART'],
  [/bind/i, 'Bind wallets'],
];

function flowTitle(msg) {
  for (const [re, label] of TITLE_RULES) if (re.test(msg)) return label;
  const s = String(msg).replace(/…$/, '');
  return s.length > 44 ? `${s.slice(0, 42)}…` : s;
}

function newFlow(msg, source) {
  seq += 1;
  return {
    id: `flow-${seq}-${Date.now().toString(36)}`,
    title: flowTitle(msg),
    source: source || 'pool',
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    steps: [],
  };
}

function newStep(msg) {
  return {
    key: stepKey(msg),
    text: String(msg),
    status: 'active',
    startedAt: Date.now(),
    endedAt: null,
  };
}

function archive(flow) {
  if (!flow) return;
  // An abandoned run (user started something else) is not a success.
  const closed =
    flow.status === 'running'
      ? { ...flow, status: 'stalled', endedAt: Date.now() }
      : flow;
  state.history = [closed, ...state.history].slice(0, MAX_HISTORY);
}

function closeActiveSteps(flow, status, at) {
  for (const s of flow.steps) {
    if (s.status === 'active') {
      s.status = status;
      s.endedAt = at;
    }
  }
}

/**
 * @param {'loading'|'success'|'error'} kind
 * @param {string} msg
 * @param {string} [source] toast id the message came from
 */
export function record(kind, msg, source) {
  if (typeof msg !== 'string' || !msg.trim()) return;
  const now = Date.now();

  if (kind === 'loading') {
    if (!state.current || state.current.status !== 'running') {
      archive(state.current);
      state.current = newFlow(msg, source);
    }
    const flow = state.current;
    const last = flow.steps[flow.steps.length - 1];
    const key = stepKey(msg);
    if (last && last.key === key) {
      // Same step, fresher detail (counters, hashes) — update in place.
      last.text = String(msg);
      last.status = 'active';
    } else {
      if (last && last.status === 'active') {
        last.status = 'done';
        last.endedAt = now;
      }
      flow.steps.push(newStep(msg));
      if (flow.steps.length > MAX_STEPS) flow.steps.splice(0, flow.steps.length - MAX_STEPS);
    }
    emit();
    return;
  }

  if (kind === 'success') {
    if (!state.current || state.current.status !== 'running') {
      archive(state.current);
      state.current = newFlow(msg, source);
    }
    const flow = state.current;
    closeActiveSteps(flow, 'done', now);
    flow.steps.push({
      key: stepKey(msg),
      text: String(msg),
      status: 'done',
      result: true,
      startedAt: now,
      endedAt: now,
    });
    flow.status = 'done';
    flow.endedAt = now;
    emit();
    return;
  }

  if (kind === 'error') {
    if (!state.current || state.current.status !== 'running') {
      archive(state.current);
      state.current = newFlow(msg, source);
    }
    const flow = state.current;
    const last = flow.steps[flow.steps.length - 1];
    if (last && last.status === 'active') {
      last.status = 'error';
      last.endedAt = now;
      last.detail = String(msg);
    } else {
      flow.steps.push({
        key: stepKey(msg),
        text: String(msg),
        status: 'error',
        result: true,
        startedAt: now,
        endedAt: now,
      });
    }
    flow.status = 'error';
    flow.endedAt = now;
    emit();
  }
}

/** Mirror of the persistent poolFlowTracker rows, published by FungiblePool. */
export function setPipeline(flows) {
  const next = Array.isArray(flows) ? flows : [];
  const same =
    next.length === state.pipeline.length &&
    next.every((f, i) => f.id === state.pipeline[i]?.id && f.step === state.pipeline[i]?.step);
  if (same) return;
  state.pipeline = next;
  emit();
}

export function clearActivity() {
  state.current = null;
  state.history = [];
  emit();
}

// Ops/debug handle: drive the tracker from the console without a wallet.
//   __bridgeProgress.record('loading', 'Sending 5 WART → pool…', 'pool')
if (typeof window !== 'undefined') {
  window.__bridgeProgress = { record, setPipeline, clearActivity, getSnapshot };
}
