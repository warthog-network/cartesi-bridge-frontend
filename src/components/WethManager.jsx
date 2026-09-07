/**
 * wETH manager — the single place to see and unwrap Warthog WETH receipts.
 *
 * Why this exists: the ETH 3P wrap is recipient-as-minter, so every wrap creates
 * a BRAND-NEW Warthog L1 asset and they all display as "WETH". A ledger reset
 * rewrites pool-eth-3p-wraps.json but cannot touch Warthog L1, so un-burned
 * balances from wiped generations linger in the wallet looking spendable.
 *
 * Burning one of those is a silent no-op that destroys the tokens: the transfer
 * to the burn bin succeeds on-chain, then recordEthBurn() rejects the unknown
 * hash and no ETH is released. Selecting the asset by hand — and prechecking it
 * server-side before signing — is the only thing standing between the two.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import { fetchWartAssetHoldings } from '../utils/mintEthWarthogAsset.js';

async function poolPost(body) {
  const res = await fetch('/api/pool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(j.error || j.message || `pool ${res.status}`);
  return j;
}

/**
 * The burn is already on-chain and irreversible; ETH is released only once its
 * Warthog block is mined. So BURN_UNCONFIRMED is a wait, not a failure — retry
 * rather than surfacing a scary error over a burn the user cannot take back.
 * A second burn must never be sent.
 */
async function openRedeemWhenMined(post, body, note) {
  const deadline = Date.now() + 300000;
  for (;;) {
    try {
      return await post({ action: 'eth3p_open_redeem', ...body });
    } catch (e) {
      const msg = e?.message || String(e);
      if (!/BURN_UNCONFIRMED/.test(msg) || Date.now() > deadline) throw e;
      note?.('Waiting for the burn block — no second burn needed…');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/** Same call, but a false `ok` is the answer rather than an error. */
async function poolAsk(body) {
  const res = await fetch('/api/pool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({ ok: false, message: `pool ${res.status}` }));
}

function short(v, n = 10, t = 6) {
  const s = String(v || '');
  if (s.length <= n + t) return s;
  return `${s.slice(0, n)}…${s.slice(-t)}`;
}

function toE8(amount) {
  const [w, f = ''] = String(amount || '0').trim().split('.');
  return BigInt(w || '0') * 10n ** 8n + BigInt((f + '00000000').slice(0, 8));
}

function fromE8(e8) {
  const v = BigInt(e8 || '0');
  const w = v / 10n ** 8n;
  const f = (v % 10n ** 8n).toString().padStart(8, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : String(w);
}

export default function WethManager({
  wartAddress = null,
  l1Address = null,
  selectedNode = null,
  sendAsset = null,
}) {
  const [st, setSt] = useState(null);
  const [index, setIndex] = useState(null);
  const [hold, setHold] = useState([]);
  const [picked, setPicked] = useState(null);
  const [amt, setAmt] = useState('');
  const [busy, setBusy] = useState(false);
  const [showDead, setShowDead] = useState(false);
  const [line, setLine] = useState(null);

  const refresh = useCallback(async () => {
    const [s, idx] = await Promise.all([
      poolPost({ action: 'eth3p_status' }),
      poolPost({ action: 'eth3p_assets' }),
    ]);
    setSt(s);
    setIndex(idx);
    if (wartAddress) {
      const extra = [...(idx.hashes || []), ...(s.wraps || []).map((w) => w.assetHash)];
      setHold(await fetchWartAssetHoldings(wartAddress, extra, selectedNode));
    } else {
      setHold([]);
    }
  }, [wartAddress, selectedNode]);

  useEffect(() => {
    refresh().catch((e) => setLine({ kind: 'err', text: e.message }));
    const id = setInterval(() => refresh().catch(() => null), 8000);
    return () => clearInterval(id);
  }, [refresh]);

  /**
   * Split holdings against the live registry. Name is not evidence — an orphan
   * from a wiped generation is also called "WETH" and also has a real balance.
   */
  const { live, dead } = useMemo(() => {
    const byHash = index?.byHash || {};
    const live = [];
    const dead = [];
    for (const h of hold) {
      if (BigInt(h.e8 || 0) <= 0n) continue;
      const wrap = byHash[h.hash];
      if (wrap && BigInt(wrap.outstandingE8 || '0') > 0n) {
        live.push({ ...h, wrap });
      } else {
        dead.push({ ...h, wrap: wrap || null });
      }
    }
    return { live, dead };
  }, [hold, index]);

  // Keep the selection valid as the registry and balances move under it.
  useEffect(() => {
    if (!live.length) {
      if (picked) setPicked(null);
      return;
    }
    if (!picked || !live.some((h) => h.hash === picked)) setPicked(live[0].hash);
  }, [live, picked]);

  const sel = live.find((h) => h.hash === picked) || null;
  /** Cap is whichever runs out first: your balance, or what the wrap still backs. */
  const capE8 = sel
    ? (BigInt(sel.e8) < BigInt(sel.wrap.outstandingE8)
        ? BigInt(sel.e8)
        : BigInt(sel.wrap.outstandingE8))
    : 0n;

  const deadTotal = dead.reduce((a, h) => a + BigInt(h.e8 || 0), 0n);
  const liveTotal = live.reduce((a, h) => a + BigInt(h.e8 || 0), 0n);
  const open = st?.open || [];

  const unwrap = async () => {
    if (!wartAddress) throw new Error('Unlock Warthog');
    if (!sendAsset) throw new Error('Warthog sendAsset not ready');
    if (!st?.burnBin) throw new Error('Burn bin missing');
    if (!sel) throw new Error('Select a wETH receipt first');
    const useAmt = String(amt || '').trim() || fromE8(capE8);
    const e8 = toE8(useAmt);
    if (e8 <= 0n) throw new Error('Enter an amount');
    if (e8 > capE8) throw new Error(`Max redeemable on this receipt is ${fromE8(capE8)}`);

    setBusy(true);
    try {
      // Precheck BEFORE signing. The transfer below is irreversible; this is the
      // only point where an orphaned hash can still be refused for free.
      const check = await poolAsk({
        action: 'eth3p_precheck_burn',
        assetHash: sel.hash,
        amountE8: e8.toString(),
      });
      if (!check.ok || !check.redeemable) {
        throw new Error(check.message || `Not redeemable (${check.reason || 'unknown'})`);
      }

      if (l1Address) {
        await poolPost({ action: 'eth3p_bind', wartAddress, ethAddress: l1Address }).catch(
          () => null,
        );
      }
      toast.loading('Sending wETH to burn bin…', { id: 'wethmgr', duration: Infinity });
      const sent = await sendAsset({
        assetHash: sel.hash,
        toAddress: st.burnBin,
        amount: useAmt,
        decimals: 8,
      });
      const wartTx = sent?.txHash || sent?.hash || sent?.data?.txHash || sent?.data?.hash;
      if (!wartTx) throw new Error('Burn submitted but no tx hash');

      toast.loading('Opening ETH 3P redeem (e1+e2)…', { id: 'wethmgr', duration: Infinity });
      const opened = await openRedeemWhenMined(
        poolPost,
        {
          wartTxHash: wartTx,
          assetHash: sel.hash,
          amountE8: e8.toString(),
          burnerWart: wartAddress,
          ethAddress: l1Address,
        },
        (m) => toast.loading(m, { id: 'wethmgr', duration: Infinity }),
      );

      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const t = await poolPost({ action: 'eth3p_ticket', ticketId: opened.ticketId });
        if (t?.status === 'paid' && t.txHash) {
          toast.success(`ETH paid ${short(t.txHash, 10, 6)} → ${short(l1Address, 8, 4)}`, {
            id: 'wethmgr',
            duration: 10000,
          });
          setLine({ kind: 'ok', text: `Redeemed ${useAmt} ETH to ${short(l1Address, 8, 4)}` });
          setAmt('');
          await refresh();
          return;
        }
        const live2 = await poolAsk({ action: 'eth3p_status' });
        const wait = `${live2?.e1Live ? 'e1 live' : 'need e1 ETH Signing ON'} · ${
          live2?.e2Live ? 'e2 live' : 'need e2 ETH Signing ON'
        }`;
        toast.loading(`Waiting ${opened.ticketId}: ${wait}`, { id: 'wethmgr', duration: Infinity });
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error('Still waiting on e1+e2 — ticket stays open, no extra burn needed');
    } catch (e) {
      toast.error(e?.message || String(e), { id: 'wethmgr' });
      setLine({ kind: 'err', text: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wi-panel" style={{ margin: 0, padding: 0, background: 'transparent', border: 0 }}>
      <p className="wh-hint">
        <strong>wETH</strong> is the Warthog receipt for ETH locked in the e1/e2 3P. There is{' '}
        <strong>no Cartesi voucher</strong> — unwrapping burns the receipt to the bin and e1+e2
        sign an ETH transfer to your bound MetaMask.
      </p>

      <div className="sw-card-meta" style={{ margin: '0.6rem 0' }}>
        <div className="sw-meta-row">
          <span className="sw-meta-k">ETH 3P Q</span>
          <span className="sw-meta-v mono">{st?.address ? short(st.address, 10, 6) : 'unsealed'}</span>
        </div>
        <div className="sw-meta-row">
          <span className="sw-meta-k">e1 / e2</span>
          <span className="sw-meta-v">
            {st?.e1Live ? 'e1 live' : 'e1 wait'} · {st?.e2Live ? 'e2 live' : 'e2 wait'}
          </span>
        </div>
        <div className="sw-meta-row">
          <span className="sw-meta-k">Pays ETH to</span>
          <span className="sw-meta-v mono">
            {l1Address ? short(l1Address, 8, 4) : 'connect MetaMask'}
          </span>
        </div>
        <div className="sw-meta-row">
          <span className="sw-meta-k">Redeemable</span>
          <span className="sw-meta-v">
            {fromE8(liveTotal)} wETH{live.length > 1 ? ` across ${live.length} receipts` : ''}
          </span>
        </div>
      </div>

      {/* ---- redeemable receipts: pick one explicitly ---- */}
      {live.length ? (
        <>
          <p className="wh-hint" style={{ marginBottom: '0.35rem' }}>
            <strong>Backed receipts</strong> — select which one to unwrap
          </p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {live.map((h) => (
              <li
                key={h.hash}
                style={{
                  border: `1px solid ${h.hash === picked ? 'rgba(56,189,248,0.65)' : 'rgba(148,163,184,0.2)'}`,
                  borderRadius: 6,
                  padding: '0.4rem 0.5rem',
                  fontSize: '0.78rem',
                }}
              >
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="weth-receipt"
                    checked={h.hash === picked}
                    onChange={() => {
                      setPicked(h.hash);
                      setAmt('');
                    }}
                    disabled={busy}
                  />
                  <strong>{h.name || 'WETH'}</strong>
                  <span className="mono">{h.available ?? h.total}</span>
                  <span style={{ opacity: 0.7, fontSize: '0.7rem' }}>
                    wrap backs {fromE8(h.wrap.outstandingE8)}
                  </span>
                </label>
                <code className="mono" style={{ wordBreak: 'break-all', opacity: 0.85 }}>
                  {short(h.hash, 16, 8)}
                </code>
              </li>
            ))}
          </ul>

          <div className="wh-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <input
              className="input"
              style={{ maxWidth: 140 }}
              value={amt}
              onChange={(e) => setAmt(e.target.value)}
              placeholder={sel ? fromE8(capE8) : 'amount'}
              disabled={busy || !sel}
            />
            <button
              type="button"
              className="btn secondary small"
              disabled={busy || !sel}
              onClick={() => setAmt(fromE8(capE8))}
            >
              Max
            </button>
            <button
              type="button"
              className="btn primary small"
              disabled={busy || !sel || !sendAsset}
              onClick={() => unwrap()}
            >
              {busy ? 'Working…' : 'Unwrap → ETH'}
            </button>
          </div>
        </>
      ) : (
        <p className="wh-muted">
          No backed wETH on this Warthog address. Use Path A ETH → wETH to mint a receipt.
        </p>
      )}

      {open.length ? (
        <p className="wh-hint">
          Open redeem: {open.map((t) => `${t.ticketId} (${t.status})`).join(', ')} — leave e1+e2 ON,
          do not burn again.
        </p>
      ) : null}

      {/* ---- orphans: visible, explained, never burnable ---- */}
      {dead.length ? (
        <div style={{ marginTop: '0.9rem', borderTop: '1px solid rgba(148,163,184,0.2)', paddingTop: '0.6rem' }}>
          <button
            type="button"
            className="btn secondary small"
            onClick={() => setShowDead((v) => !v)}
          >
            {showDead ? 'Hide' : 'Show'} {dead.length} unbacked receipt{dead.length > 1 ? 's' : ''} (
            {fromE8(deadTotal)} wETH)
          </button>
          {showDead ? (
            <>
              <p className="wh-hint" style={{ marginTop: '0.5rem' }}>
                These are <strong>not redeemable</strong>. Each is a WETH asset from an earlier
                bridge generation whose ETH backing was wiped by a ledger reset — the tokens survive
                on Warthog L1 because the chain is never reset. Sending one to the burn bin would
                destroy it and release no ETH, so unwrap is disabled for them.
              </p>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {dead.map((h) => (
                  <li
                    key={h.hash}
                    style={{
                      border: '1px dashed rgba(148,163,184,0.35)',
                      borderRadius: 6,
                      padding: '0.35rem 0.45rem',
                      fontSize: '0.78rem',
                      opacity: 0.75,
                    }}
                  >
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <strong>{h.name || 'WETH'}</strong>
                      <span className="mono">{h.available ?? h.total}</span>
                      <span style={{ fontSize: '0.7rem' }}>
                        {h.wrap ? 'fully redeemed' : 'orphaned by reset'}
                      </span>
                      <button
                        type="button"
                        className="btn secondary small"
                        style={{ marginLeft: 'auto' }}
                        onClick={async () => {
                          try {
                            await navigator.clipboard?.writeText(h.hash);
                            toast.success('Asset hash copied');
                          } catch {
                            toast.error('Copy failed');
                          }
                        }}
                      >
                        Copy
                      </button>
                    </div>
                    <code className="mono" style={{ wordBreak: 'break-all' }}>
                      {short(h.hash, 16, 8)}
                    </code>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {line ? <p className={line.kind === 'err' ? 'dash__error' : 'wh-hint'}>{line.text}</p> : null}
    </div>
  );
}
