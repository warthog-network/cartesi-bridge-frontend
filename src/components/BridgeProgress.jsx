/**
 * Bridge activity tracker — the tunnel-style step display.
 *
 * Two layers:
 *   1. Pipeline  — the persistent round-trip stages from utils/poolFlowTracker
 *                  (deposit → credit → mint → voucher → burn → payout), which
 *                  survive a reload and reconcile against rollup inspect.
 *   2. Live steps — the per-run status lines the flows already emit through the
 *                  shared 'pool' / 'eth3p' toasts, captured by utils/bridgeProgress.
 *
 * Toasts still fire; this just stops the run from being invisible once one fades.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Check, X, Clock, Activity } from 'lucide-react';
import {
  subscribe,
  getSnapshot,
  getServerSnapshot,
  clearActivity,
} from '../utils/bridgeProgress.js';
import { FLOW_STEPS, stepMeta } from '../utils/poolFlowTracker.js';
import './BridgeProgress.css';

const RAIL = FLOW_STEPS.filter((s) => s.id !== 'complete');

function secs(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function StepIcon({ status }) {
  if (status === 'done') return <span className="bp-mark bp-mark--done"><Check size={11} /></span>;
  if (status === 'error') return <span className="bp-mark bp-mark--error"><X size={11} /></span>;
  if (status === 'active') return <span className="bp-mark bp-mark--active" aria-hidden />;
  return <span className="bp-mark bp-mark--idle" aria-hidden />;
}

function StepList({ flow, now }) {
  return (
    <ol className="bp-steps">
      {flow.steps.map((s, i) => {
        const end = s.endedAt || (s.status === 'active' ? now : s.startedAt);
        return (
          <li key={`${s.key}-${i}`} className={`bp-step is-${s.status}${s.result ? ' is-result' : ''}`}>
            <StepIcon status={s.status} />
            <div className="bp-step-body">
              <span className="bp-step-text">{s.text}</span>
              {s.detail ? <span className="bp-step-detail">{s.detail}</span> : null}
            </div>
            <span className="bp-step-time">{secs(end - s.startedAt)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function PipelineRail({ flow }) {
  const curIdx = RAIL.findIndex((s) => s.id === flow.step);
  const done = flow.step === 'complete';
  const cur = stepMeta(flow.step);
  return (
    <div className="bp-rail-wrap">
      <div className="bp-rail-head">
        <span className="bp-rail-title">{cur.label}</span>
        {flow.amountHuman ? <span className="bp-rail-amt">{flow.amountHuman} WART</span> : null}
      </div>
      <ol className="bp-rail" aria-label="Round-trip stage">
        {RAIL.map((s, i) => {
          const state = done || i < curIdx ? 'done' : i === curIdx ? 'active' : 'idle';
          return (
            <li key={s.id} className={`bp-rail-node is-${state}`} title={`${s.label} — ${s.hint}`}>
              <span className="bp-rail-dot" aria-hidden />
              <span className="bp-rail-label">{s.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="bp-rail-hint">{cur.hint}</p>
    </div>
  );
}

export default function BridgeProgress() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { current, history, pipeline } = state;
  const running = current?.status === 'running';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const elapsed = current ? (current.endedAt || now) - current.startedAt : 0;
  const statusLabel =
    current?.status === 'running'
      ? 'Running'
      : current?.status === 'done'
        ? 'Complete'
        : current?.status === 'error'
          ? 'Failed'
          : current?.status === 'stalled'
            ? 'Left open'
            : '';

  return (
    <section className="bp-card" aria-label="Bridge activity">
      <header className="bp-head">
        <span className="bp-head-title">
          <Activity size={14} aria-hidden /> Bridge activity
        </span>
        {current ? (
          <button
            type="button"
            className="bp-clear"
            onClick={clearActivity}
            title="Clear this activity log (browser only — nothing on-chain changes)"
          >
            Clear
          </button>
        ) : null}
      </header>

      {pipeline.length > 0 && (
        <div className="bp-pipeline">
          {pipeline.map((f) => (
            <PipelineRail key={f.id} flow={f} />
          ))}
        </div>
      )}

      {current ? (
        <div className={`bp-flow is-${current.status}`}>
          <div className="bp-flow-head">
            <span className="bp-flow-title">{current.title}</span>
            <span className={`bp-pill is-${current.status}`}>{statusLabel}</span>
          </div>
          <div className="bp-flow-meta">
            <Clock size={11} aria-hidden /> {secs(elapsed) || '0s'}
            <span className="bp-flow-count">
              {current.steps.length} step{current.steps.length === 1 ? '' : 's'}
            </span>
          </div>
          <StepList flow={current} now={now} />
        </div>
      ) : (
        <p className="bp-empty">
          No run in flight. Start a deposit, mint, withdrawal or 1-click and every
          step shows up here instead of vanishing with the toast.
        </p>
      )}

      {history.length > 0 && (
        <details className="bp-history">
          <summary>Earlier runs ({history.length})</summary>
          {history.map((f) => (
            <div key={f.id} className={`bp-flow bp-flow--past is-${f.status}`}>
              <div className="bp-flow-head">
                <span className="bp-flow-title">{f.title}</span>
                <span className={`bp-pill is-${f.status}`}>
                  {f.status === 'done' ? 'Complete' : f.status === 'error' ? 'Failed' : 'Left open'}
                </span>
              </div>
              <div className="bp-flow-meta">
                <Clock size={11} aria-hidden /> {secs((f.endedAt || f.startedAt) - f.startedAt) || '0s'}
              </div>
              <StepList flow={f} now={now} />
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
