/**
 * Get wETH — Warthog-wallet view of ETH 3P wraps.
 *
 * Unlike Get wWART, there is no Cartesi voucher. ETH is locked in the e1/e2
 * 3P address; redeem is a signed ETH transfer after the receipt hits the burn bin.
 */
import { useCallback, useEffect, useState } from 'react';
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

function short(v, n = 10, t = 6) {
  const s = String(v || '');
  if (s.length <= n + t) return s;
  return `${s.slice(0, n)}…${s.slice(-t)}`;
}

export default function GetWethPanel({
  wartAddress = null,
  l1Address = null,
  selectedNode = null,
  sendAsset = null,
}) {
  const [st, setSt] = useState(null);
  const [hold, setHold] = useState([]);
  const [amt, setAmt] = useState('');
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState(null);

  const refresh = useCallback(async () => {
    const s = await poolPost({ action: 'eth3p_status' });
    setSt(s);
    if (wartAddress) {
      const extra = (s.wraps || []).map((w) => w.assetHash);
      const live = await fetchWartAssetHoldings(wartAddress, extra, selectedNode);
      setHold(live);
    } else setHold([]);
    return s;
  }, [wartAddress, selectedNode]);

  useEffect(() => {
    refresh().catch((e) => setLine({ kind: 'err', text: e.message }));
    const id = setInterval(() => refresh().catch(() => null), 8000);
    return () => clearInterval(id);
  }, [refresh]);

  const weth = hold.filter((h) => String(h.name || '').toUpperCase() === 'WETH' || BigInt(h.e8 || 0) > 0n);
  const open = st?.open || [];

  const redeem = async () => {
    if (!wartAddress) throw new Error('Unlock Warthog');
    if (!sendAsset) throw new Error('Warthog sendAsset not ready');
    if (!st?.burnBin) throw new Error('Burn bin missing');
    const mine = weth.find((h) => BigInt(h.e8 || 0) > 0n);
    if (!mine) throw new Error('No wETH on this address');
    const useAmt = String(amt || mine.available || mine.total || '').trim();
    if (!useAmt) throw new Error('Enter amount');
    setBusy(true);
    try {
      if (l1Address) {
        await poolPost({
          action: 'eth3p_bind',
          wartAddress,
          ethAddress: l1Address,
        }).catch(() => null);
      }
      toast.loading('Sending wETH to burn bin…', { id: 'getweth', duration: Infinity });
      const sent = await sendAsset({
        assetHash: mine.hash,
        toAddress: st.burnBin,
        amount: useAmt,
        decimals: 8,
      });
      const wartTx = sent?.txHash || sent?.hash || sent?.data?.txHash || sent?.data?.hash;
      if (!wartTx) throw new Error('Burn submitted but no tx hash');
      const [w, f = ''] = String(useAmt).split('.');
      const e8 = BigInt(w || '0') * 10n ** 8n + BigInt((f + '00000000').slice(0, 8));
      toast.loading('Opening ETH 3P redeem (e1+e2)…', { id: 'getweth', duration: Infinity });
      const opened = await openRedeemWhenMined(
        poolPost,
        {
          wartTxHash: wartTx,
          assetHash: mine.hash,
          amountE8: e8.toString(),
          burnerWart: wartAddress,
          ethAddress: l1Address,
        },
        (m) => toast.loading(m, { id: 'getweth', duration: Infinity }),
      );
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const t = await poolPost({ action: 'eth3p_ticket', ticketId: opened.ticketId });
        if (t?.status === 'paid' && t.txHash) {
          toast.success(`ETH paid ${short(t.txHash, 10, 6)} → ${short(l1Address, 8, 4)}`, {
            id: 'getweth',
            duration: 10000,
          });
          setLine({ kind: 'ok', text: `Redeemed ${useAmt} ETH to ${short(l1Address, 8, 4)}` });
          await refresh();
          return;
        }
        const wait = [
          st?.e1Live || (await poolPost({ action: 'eth3p_status' }).catch(() => st))?.e1Live
            ? 'e1 live'
            : 'need original e1 ETH Signing ON',
          (await poolPost({ action: 'eth3p_status' }).catch(() => ({})))?.e2Live
            ? 'e2 live'
            : 'need original e2 ETH Signing ON',
        ].join(' · ');
        toast.loading(`Waiting ${opened.ticketId}: ${wait}`, { id: 'getweth', duration: Infinity });
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error('Still waiting on e1+e2 — ticket stays open, no extra burn needed');
    } catch (e) {
      toast.error(e?.message || String(e), { id: 'getweth' });
      setLine({ kind: 'err', text: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wi-panel" style={{ margin: 0, padding: 0, background: 'transparent', border: 0 }}>
      <p className="wh-hint">
        <strong>Get wETH</strong> is the Warthog receipt for ETH locked in the e1/e2 3P.
        There is <strong>no Cartesi voucher</strong>. Redeem burns the receipt to the bin;
        e1+e2 sign an ETH transfer to your bound MetaMask.
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
          <span className="sw-meta-v mono">{l1Address ? short(l1Address, 8, 4) : 'connect MetaMask'}</span>
        </div>
      </div>
      {weth.length ? (
        <ul className="wi-list">
          {weth.map((h) => (
            <li key={h.hash}>
              <strong>{h.name}</strong> {h.available ?? h.total}{' '}
              <code>{short(h.hash, 10, 8)}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p className="wh-muted">No wETH on this Warthog address. Use Path A ETH → wETH first.</p>
      )}
      {open.length ? (
        <p className="wh-hint">
          Open redeem: {open.map((t) => `${t.ticketId} (${t.status})`).join(', ')} — leave e1+e2 ON,
          do not burn again.
        </p>
      ) : null}
      <div className="wh-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <input
          className="input"
          style={{ maxWidth: 140 }}
          value={amt}
          onChange={(e) => setAmt(e.target.value)}
          placeholder={weth[0]?.available || 'amount'}
          disabled={busy}
        />
        <button
          type="button"
          className="btn primary small"
          disabled={busy || !weth.length || !sendAsset}
          onClick={() => redeem()}
        >
          Redeem wETH → ETH
        </button>
      </div>
      {line ? (
        <p className={line.kind === 'err' ? 'dash__error' : 'wh-hint'}>{line.text}</p>
      ) : null}
    </div>
  );
}
