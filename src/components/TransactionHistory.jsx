// TransactionHistory.jsx — Activity tab
// DeFi testnet: node /account/.../history often 502s; use explorer indexer instead.
import { useState, useEffect, useCallback } from 'react';
import { createWarthogApi, normalizeNodeUrl } from '../utils/warthogClient.js';
import { isDefiNode, DEFI_TESTNET_URL } from '../utils/presetNodes.js';
import { shouldUseNodeProxy } from '../utils/nodeAccess.js';

const PAGE_SIZE = 20;
/** Official DeFi explorer (rich history; works when node history 502s). */
const DEFI_EXPLORER_HOST = DEFI_TESTNET_URL;

async function fetchViaProxyOrDirect(nodeBase, nodePath) {
  const base = normalizeNodeUrl(nodeBase);
  const path = String(nodePath || '').replace(/^\//, '');
  if (shouldUseNodeProxy(base)) {
    const res = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeBase: base, nodePath: path, method: 'GET' }),
      cache: 'no-store',
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        text.trim().startsWith('<')
          ? 'History endpoint returned HTML (node/proxy down)'
          : 'Non-JSON history response',
      );
    }
    if (json.code !== 0 && json.code != null) {
      throw new Error(json.error || `History error code ${json.code}`);
    }
    return json.data ?? json;
  }
  const url = `${base.replace(/\/$/, '')}/${path}`;
  const res = await fetch(url, { cache: 'no-store' });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      text.trim().startsWith('<')
        ? 'History endpoint returned HTML'
        : 'Non-JSON history response',
    );
  }
  if (json.code !== 0 && json.code != null) {
    throw new Error(json.error || `History error code ${json.code}`);
  }
  return json.data ?? json;
}

function normalizeExplorerTx(t) {
  return {
    source: 'explorer',
    txid: t.hash || t.txid || t.txHash,
    fromAddress: t.sender || t.fromAddress || '',
    toAddress: t.recipient || t.toAddress || '',
    amount: t.amount,
    fee: t.fee,
    height: t.height,
    confirmations: t.confirmations,
    direction: t.direction || null,
    type: t.type || 'transfer',
    timestamp: t.timestamp || null,
    meta: t.meta || null,
    summary: t.meta?.summary || null,
  };
}

function normalizeNodeBlockTx(tx, block) {
  return {
    source: 'node',
    txid: tx.txHash || tx.hash || tx.txid,
    fromAddress: tx.fromAddress || tx.sender || '',
    toAddress: tx.toAddress || tx.recipient || '',
    amount: tx.amount?.str ?? tx.amount ?? tx.amountE8,
    fee: tx.fee?.str ?? tx.fee,
    height: block?.height ?? tx.height,
    confirmations: block?.confirmations ?? tx.confirmations,
    direction: null,
    type: 'transfer',
    timestamp: block?.time?.timestamp ?? null,
    meta: null,
    summary: null,
  };
}

function shortHex(h, a = 6, b = 4) {
  const s = String(h || '');
  if (s.length <= a + b + 1) return s || '—';
  return `${s.slice(0, a)}…${s.slice(-b)}`;
}

function formatAmount(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function formatTime(ts) {
  if (ts == null) return '';
  try {
    const ms = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000;
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

const TransactionHistory = ({ address, node }) => {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [sourceLabel, setSourceLabel] = useState('');
  /** Node-history cursor (legacy mainnet / working nodes) */
  const [nodeCursor, setNodeCursor] = useState('4294967295');
  const [mode, setMode] = useState('auto'); // 'explorer' | 'node'

  const reset = useCallback(() => {
    setItems([]);
    setError(null);
    setPage(1);
    setHasMore(true);
    setNodeCursor('4294967295');
    setMode('auto');
    setSourceLabel('');
  }, []);

  useEffect(() => {
    reset();
  }, [address, node, reset]);

  const loadExplorerPage = async (pageNum) => {
    const addr = String(address || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    const path = `api/explorer/accounts/${addr}/transactions?count=${PAGE_SIZE}&page=${pageNum}`;
    // Always hit official DeFi explorer host for testnet history (works even if RPC is another peer)
    const data = await fetchViaProxyOrDirect(DEFI_EXPLORER_HOST, path);
    const txs = Array.isArray(data?.transactions) ? data.transactions : [];
    const normalized = txs.map(normalizeExplorerTx);
    setSourceLabel('DeFi explorer');
    setMode('explorer');
    setHasMore(txs.length >= PAGE_SIZE);
    return normalized;
  };

  const loadNodeHistory = async (cursor) => {
    const api = await createWarthogApi(node);
    const historyRes = await api.getAccountHistory(address, cursor ?? 4294967295);
    if (!historyRes.success) {
      throw new Error(historyRes.error || 'Failed to fetch transaction history');
    }
    const rawData = historyRes.data;
    if (!rawData?.perBlock || !Array.isArray(rawData.perBlock)) {
      throw new Error('Unexpected node history format');
    }
    const newItems = rawData.perBlock.flatMap((block) => {
      const height = block.height ?? block.header?.height;
      const conf = block.confirmations;
      const transfers = block.transactions?.transfers || block.transactions || [];
      const list = Array.isArray(transfers) ? transfers : [];
      return list.map((tx) =>
        normalizeNodeBlockTx(tx, {
          height,
          confirmations: conf,
          time: block.header?.time || block.time,
        }),
      );
    });
    setSourceLabel('Node history');
    setMode('node');
    setHasMore(newItems.length > 0 && Number(rawData.fromId) > 0);
    setNodeCursor(rawData.fromId > 0 ? String(rawData.fromId) : null);
    return newItems;
  };

  const fetchPage = async ({ append = false, pageNum = 1 } = {}) => {
    if (!address || !node || loading) return;
    setLoading(true);
    setError(null);
    try {
      let batch = [];
      const preferExplorer = isDefiNode(node) || mode === 'explorer';

      if (preferExplorer && mode !== 'node') {
        try {
          batch = await loadExplorerPage(pageNum);
        } catch (exErr) {
          console.warn('[Activity] explorer failed, trying node history', exErr);
          batch = await loadNodeHistory(nodeCursor);
        }
      } else {
        try {
          batch = await loadNodeHistory(nodeCursor);
        } catch (nodeErr) {
          if (isDefiNode(node)) {
            batch = await loadExplorerPage(pageNum);
          } else {
            throw nodeErr;
          }
        }
      }

      setItems((prev) => (append ? [...prev, ...batch] : batch));
      setPage(pageNum);
    } catch (err) {
      setError(err.message || 'Failed to fetch activity');
      if (!append) setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (address && node) {
      fetchPage({ append: false, pageNum: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, node]);

  const handleRefresh = () => {
    setNodeCursor('4294967295');
    fetchPage({ append: false, pageNum: 1 });
  };

  const handleMore = () => {
    if (mode === 'explorer') {
      fetchPage({ append: true, pageNum: page + 1 });
    } else {
      fetchPage({ append: true, pageNum: page + 1 });
    }
  };

  return (
    <section className="activity-panel">
      <div className="activity-head">
        <h3>
          Activity
          {sourceLabel ? (
            <span className="activity-source"> · {sourceLabel}</span>
          ) : null}
        </h3>
        <button
          type="button"
          className="btn primary small"
          onClick={handleRefresh}
          disabled={loading || !address}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="activity-error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <p className="activity-empty">No transactions found for this address.</p>
      )}

      {items.length > 0 && (
        <ul className="activity-list">
          {items.map((tx, i) => {
            const dir = tx.direction;
            const dirClass =
              dir === 'in' ? 'in' : dir === 'out' ? 'out' : dir === 'self' ? 'self' : '';
            const title =
              tx.summary ||
              `${tx.type || 'tx'} ${dir || ''}`.trim();
            return (
              <li key={`${tx.txid || i}-${i}`} className={`activity-row ${dirClass}`}>
                <div className="activity-row-main">
                  <span className={`activity-dir ${dirClass}`}>
                    {dir === 'in' ? '↓ in' : dir === 'out' ? '↑ out' : dir || tx.type || 'tx'}
                  </span>
                  <span className="activity-amt">
                    {formatAmount(tx.amount)} WART
                  </span>
                  {tx.fee != null && Number(tx.fee) > 0 && (
                    <span className="activity-fee">fee {formatAmount(tx.fee)}</span>
                  )}
                </div>
                <div className="activity-row-meta">
                  <span className="activity-type">{title}</span>
                  {tx.height != null && <span>h{tx.height}</span>}
                  {tx.confirmations != null && <span>{tx.confirmations} conf</span>}
                  {tx.timestamp != null && (
                    <span className="activity-time">{formatTime(tx.timestamp)}</span>
                  )}
                </div>
                <div className="activity-row-addrs">
                  {tx.fromAddress ? (
                    <button
                      type="button"
                      className="activity-addr"
                      title={tx.fromAddress}
                      onClick={() => navigator.clipboard?.writeText(tx.fromAddress)}
                    >
                      from {shortHex(tx.fromAddress)}
                    </button>
                  ) : null}
                  {tx.toAddress ? (
                    <button
                      type="button"
                      className="activity-addr"
                      title={tx.toAddress}
                      onClick={() => navigator.clipboard?.writeText(tx.toAddress)}
                    >
                      to {shortHex(tx.toAddress)}
                    </button>
                  ) : null}
                  {tx.txid ? (
                    <button
                      type="button"
                      className="activity-addr mono"
                      title={tx.txid}
                      onClick={() => navigator.clipboard?.writeText(tx.txid)}
                    >
                      {shortHex(tx.txid, 8, 6)}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="activity-pager">
        {hasMore && items.length > 0 && (
          <button
            type="button"
            className="btn secondary small"
            onClick={handleMore}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </section>
  );
};

export default TransactionHistory;
