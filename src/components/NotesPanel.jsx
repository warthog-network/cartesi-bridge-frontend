/**
 * In-app Notes tab content — latest bridge changes (no wallet required).
 */
import { useCallback, useEffect, useState } from 'react';

function renderBody(body) {
  if (!body) return null;
  // Lightweight markdown-ish: paragraphs, bullets, tables skipped as pre
  const lines = body.split('\n');
  const blocks = [];
  let list = null;
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    blocks.push(
      <p key={`p-${blocks.length}`} className="notes-p">
        {para.join(' ')}
      </p>,
    );
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="notes-ul">
        {list.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>,
    );
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (!t) {
      flushPara();
      flushList();
      continue;
    }
    if (t.startsWith('|')) {
      flushPara();
      flushList();
      blocks.push(
        <pre key={`pre-${blocks.length}`} className="notes-pre">
          {t}
        </pre>,
      );
      continue;
    }
    if (/^[-*]\s+/.test(t)) {
      flushPara();
      if (!list) list = [];
      list.push(t.replace(/^[-*]\s+/, '').replace(/\*\*(.*?)\*\*/g, '$1'));
      continue;
    }
    flushList();
    para.push(t.replace(/\*\*(.*?)\*\*/g, '$1'));
  }
  flushPara();
  flushList();
  return blocks;
}

export default function NotesPanel({ compact = false }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch('/api/notes', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className={`notes-panel ${compact ? 'notes-panel--compact' : ''}`}>
      <div className="notes-panel-head">
        <div>
          <h2 className="notes-title">Notes</h2>
          <p className="notes-sub">Latest changes · demo stays usable during progression work</p>
        </div>
        <button type="button" className="btn small secondary" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {data?.notice ? <p className="notes-banner">{data.notice}</p> : null}

      {loading && !data ? <p className="notes-muted">Loading notes…</p> : null}
      {err ? (
        <p className="notes-err">
          Could not load notes: {err}
        </p>
      ) : null}

      {data?.entries?.length ? (
        <ol className="notes-list">
          {data.entries.map((entry) => (
            <li key={entry.id || entry.title} className="notes-card">
              <h3 className="notes-card-title">{entry.title}</h3>
              <div className="notes-card-body">{renderBody(entry.body)}</div>
            </li>
          ))}
        </ol>
      ) : !loading && !err ? (
        <p className="notes-muted">No notes yet.</p>
      ) : null}

      {data?.updatedAt ? (
        <p className="notes-footer">Feed checked {new Date(data.updatedAt).toLocaleString()}</p>
      ) : null}

      <style>{`
        .notes-panel {
          text-align: left;
          max-width: 40rem;
          width: 100%;
          box-sizing: border-box;
          margin: 0.75rem auto 1.25rem;
          padding: 0.85rem 1rem 1rem;
          border-radius: 14px;
          border: 1px solid #333;
          background: color-mix(in srgb, #0a0a0a 94%, #00ffcc);
          color: #e8e8e8;
          overflow-x: hidden;
          min-width: 0;
        }
        .notes-panel--compact {
          margin-top: 0.5rem;
          max-width: 100%;
        }
        .notes-panel-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 0.75rem;
          margin-bottom: 0.65rem;
          min-width: 0;
        }
        .notes-panel-head > div {
          min-width: 0;
          flex: 1 1 auto;
        }
        .notes-title {
          margin: 0;
          font-size: 1.05rem;
          color: #00ffcc;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .notes-sub {
          margin: 0.2rem 0 0;
          font-size: 0.78rem;
          opacity: 0.75;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .notes-banner {
          font-size: 0.8rem;
          padding: 0.55rem 0.7rem;
          border-radius: 10px;
          border: 1px solid color-mix(in srgb, #fdb913 45%, #333);
          background: color-mix(in srgb, #fdb913 12%, #111);
          color: #ffe7a8;
          margin: 0 0 0.75rem;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .notes-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.65rem;
          min-width: 0;
        }
        .notes-card {
          border: 1px solid #2a2a2a;
          border-radius: 12px;
          padding: 0.7rem 0.8rem;
          background: rgba(0, 0, 0, 0.35);
          min-width: 0;
          max-width: 100%;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .notes-card-title {
          margin: 0 0 0.45rem;
          font-size: 0.88rem;
          color: #fdb913;
          font-weight: 700;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .notes-card-body {
          font-size: 0.84rem;
          line-height: 1.45;
          opacity: 0.95;
          min-width: 0;
          max-width: 100%;
          overflow-wrap: anywhere;
          word-break: break-word;
          white-space: normal;
        }
        .notes-p {
          margin: 0 0 0.45rem;
          overflow-wrap: anywhere;
          word-break: break-word;
          white-space: normal;
        }
        .notes-ul {
          margin: 0.25rem 0 0.45rem 1.1rem;
          padding: 0;
          max-width: 100%;
        }
        .notes-ul li {
          margin-bottom: 0.25rem;
          overflow-wrap: anywhere;
          word-break: break-word;
          white-space: normal;
        }
        .notes-pre {
          margin: 0.25rem 0;
          font-size: 0.72rem;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          word-break: break-word;
          max-width: 100%;
          overflow-x: auto;
          opacity: 0.85;
        }
        .notes-muted { font-size: 0.85rem; opacity: 0.7; overflow-wrap: anywhere; }
        .notes-err { font-size: 0.85rem; color: #f87171; overflow-wrap: anywhere; }
        .notes-footer {
          margin: 0.75rem 0 0;
          font-size: 0.7rem;
          opacity: 0.55;
        }
      `}</style>
    </div>
  );
}
