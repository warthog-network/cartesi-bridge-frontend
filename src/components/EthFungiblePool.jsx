/**
 * Path A ETH 3P — fungible ETH lock + Warthog bearer receipt.
 * Parallel to FungiblePool (WART). Seats are e1/e2, not d1/d2.
 *
 * Recipient is the minter: after ETH credit, they createAssets on Warthog.
 * The coordinator stamps assetHash (badge). Unwrap = send that hash to the burn bin.
 */
import { useCallback, useEffect, useState } from 'react';
import { Droplets, RefreshCw, Copy, Check, Flame } from 'lucide-react';
import { toast } from '../utils/trackedToast.js';
import { ethers } from 'ethers-v6';
import { createWarthogEthAsset, normalizeEthSupplyAmount } from '../utils/mintEthWarthogAsset.js';
import { depositEthThroughAdapter } from '../utils/eth3pAdapter.js';

const POOL_API = '/api/pool';

function shortHex(v, head = 8, tail = 6) {
  const s = String(v || '').replace(/^0x/i, '');
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(String(value || ''));
    return true;
  } catch {
    return false;
  }
}

async function poolPost(body) {
  const res = await fetch(POOL_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) {
    throw new Error(j.error || j.message || `pool ${res.status}`);
  }
  return j;
}

/**
 * The WETH asset is already on Warthog L1 by the time we register it — the SPV
 * claim is only waiting for its block. So TX_UNCONFIRMED is a wait, not a
 * failure: retry the *register* call, never the mint. A second createAssets
 * would put a second, separately-backed WETH asset on chain.
 */
async function registerWrapWhenMined(send, note) {
  const deadline = Date.now() + 300000;
  for (;;) {
    try {
      return await send();
    } catch (e) {
      const msg = e?.message || String(e);
      if (!/TX_UNCONFIRMED|not mined yet/.test(msg) || Date.now() > deadline) throw e;
      note?.('Waiting for the createAssets block — the receipt is minted, do not mint again…');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

export default function EthFungiblePool({
  ownerAddress,
  signer = null,
  wartBridgeApi = null,
  wartAddress = null,
}) {
  const [open, setOpen] = useState(true);
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState('0.01');
  const [copied, setCopied] = useState('');
  const [statusLine, setStatusLine] = useState(null);

  const refresh = useCallback(async () => {
    const j = await poolPost({ action: 'eth3p_status' });
    setSt(j);
    return j;
  }, []);

  useEffect(() => {
    refresh().catch((e) => setStatusLine({ kind: 'err', text: e.message || String(e) }));
    const id = setInterval(() => refresh().catch(() => null), 8000);
    return () => clearInterval(id);
  }, [refresh]);

  const copy = async (key, val) => {
    if (!(await copyText(val))) return;
    setCopied(key);
    setTimeout(() => setCopied(''), 1200);
  };

  const q = st?.address || '';
  const sealed = !!(st?.seatsReady?.['1'] && st?.seatsReady?.['2'] && q);

  const depositEth = async () => {
    if (!signer) throw new Error('Connect MetaMask');
    if (!q) throw new Error('ETH 3P Q not sealed — turn e1 and e2 Signing ON');
    if (!wartAddress) throw new Error('Unlock Warthog wallet — the adapter credits a 48-hex issuer');
    const wei = ethers.parseEther(String(amount || '0'));
    if (wei <= 0n) throw new Error('Amount must be > 0');
    setBusy(true);
    setStatusLine({ kind: 'info', text: `Send ${amount} ETH through the deposit adapter…` });
    try {
      if (!st?.adapter?.address) {
        throw new Error('ETH deposit adapter is not live — cannot lock');
      }
      const sent = await depositEthThroughAdapter({
        signer,
        adapter: { address: st.adapter.address, pool: q },
        wartAddress,
        value: wei,
      });
      toast.loading(`ETH tx ${sent.hash.slice(0, 10)}…`, { id: 'eth3p' });
      if (wartAddress) {
        await poolPost({
          action: 'eth3p_credit',
          ethTxHash: sent.hash,
          amountWei: wei.toString(),
          wartAddress,
          fromEth: ownerAddress,
        });
        await poolPost({
          action: 'eth3p_bind',
          wartAddress,
          ethAddress: ownerAddress,
        }).catch(() => null);
      }
      toast.success('ETH locked on 3P. Mint the Warthog receipt next.', { id: 'eth3p' });
      setStatusLine({
        kind: 'ok',
        text: 'Lock credited (bridge fee held in the Q). createAssets WETH at the credited amount, then Register wrap.',
      });
      await refresh();
    } catch (e) {
      toast.error(e?.message || String(e), { id: 'eth3p' });
      setStatusLine({ kind: 'err', text: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  const mintReceipt = async () => {
    if (!wartBridgeApi) throw new Error('Unlock Warthog wallet first (same tab)');
    if (!wartAddress) throw new Error('No Warthog address');
    setBusy(true);
    setStatusLine({ kind: 'info', text: 'createAssets WETH on Warthog L1…' });
    try {
      // Mint what the credit actually backs, not what was deposited. The
      // bridge fee is held back in the Q, so the mintable amount is smaller
      // than the lock; ask the server rather than minting the gross figure and
      // having registerEthWrap reject it *after* createAssets has already put
      // the asset on Warthog.
      const quota = await poolPost({
        action: 'eth3p_mintable',
        issuerWart: wartAddress,
      });
      const e8 = BigInt(quota?.mintableE8 || '0');
      if (e8 <= 0n) {
        throw new Error('No ETH lock credit for this Warthog address — lock ETH first');
      }
      const supply = `${e8 / 10n ** 8n}.${(e8 % 10n ** 8n).toString().padStart(8, '0')}`;
      const minted = await createWarthogEthAsset({
        amount: supply,
        wartAddress,
        ownerL1: ownerAddress,
      });
      const hash = minted?.assetHash || minted?.hash;
      if (!hash) throw new Error('createAssets returned no assetHash');
      const reg = await registerWrapWhenMined(
        () =>
          poolPost({
            action: 'eth3p_register_wrap',
            assetHash: hash,
            supplyE8: e8.toString(),
            issuerWart: wartAddress,
            assetTxHash: minted?.txHash,
            assetName: 'WETH',
          }),
        (text) => {
          toast.loading(text, { id: 'eth3p' });
          setStatusLine({ kind: 'info', text });
        },
      );
      toast.success('Wrap registered — bearer receipt on Warthog L1', { id: 'eth3p' });
      setStatusLine({
        kind: 'ok',
        text: `Badge stamped. Send this hash on Warthog; burn to ${shortHex(st?.burnBin)} to redeem ETH.`,
      });
      await refresh();
      return reg;
    } catch (e) {
      toast.error(e?.message || String(e), { id: 'eth3p' });
      setStatusLine({ kind: 'err', text: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="wi-panel" aria-label="ETH 3P fungible pool">
      <button type="button" className="wi-panel-toggle" onClick={() => setOpen((v) => !v)}>
        <Droplets size={18} />
        <span>ETH 3P pool</span>
        <span className="wi-muted">{open ? 'hide' : 'show'}</span>
      </button>
      {open ? (
        <div className="wi-panel-body">
          <p className="wi-lead">
            Testnet ETH lock in a <strong>3P Lindell</strong> pool (e1 + e2 + d_dapp). You mint the
            Warthog WETH receipt yourself after the lock — the dApp only badges the hash. Send that
            receipt to anyone; they burn it to the bin to get ETH at <em>their</em> bound 0x.
          </p>
          <div className="wi-stat-grid">
            <div className="wi-stat">
              <span className="wi-stat-k">ETH Q</span>
              <strong className="wi-mono">
                {q ? shortHex(q, 10, 8) : 'unsealed — birth e1+e2'}
              </strong>
              {q ? (
                <button type="button" className="wi-icon-btn" onClick={() => copy('q', q)}>
                  {copied === 'q' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              ) : null}
            </div>
            <div className="wi-stat">
              <span className="wi-stat-k">e1</span>
              <strong>{st?.e1Live ? 'live' : st?.holder1 ? 'assigned' : 'vacant'}</strong>
              <span className="wi-muted">{st?.holder1 ? shortHex(st.holder1, 8, 4) : '—'}</span>
            </div>
            <div className="wi-stat">
              <span className="wi-stat-k">e2</span>
              <strong>{st?.e2Live ? 'live' : st?.holder2 ? 'assigned' : 'vacant'}</strong>
              <span className="wi-muted">{st?.holder2 ? shortHex(st.holder2, 8, 4) : '—'}</span>
            </div>
          </div>
          <p className="wi-muted">
            Burn bin (Warthog, no key):{' '}
            <code>{st?.burnBin ? shortHex(st.burnBin, 10, 8) : '…'}</code>
            {st?.burnBin ? (
              <button type="button" className="wi-icon-btn" onClick={() => copy('bin', st.burnBin)}>
                {copied === 'bin' ? <Check size={14} /> : <Copy size={14} />}
              </button>
            ) : null}
          </p>
          <label className="wi-field">
            Amount (ETH)
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              disabled={busy}
            />
          </label>
          <div className="wi-row">
            <button
              type="button"
              className="btn"
              disabled={busy || !sealed}
              onClick={() => depositEth()}
            >
              {busy ? <RefreshCw size={16} className="spin" /> : null}
              1. Lock ETH into 3P
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy || !wartBridgeApi}
              onClick={() => mintReceipt()}
            >
              2. Mint Warthog receipt
            </button>
          </div>
          {statusLine ? (
            <p className={statusLine.kind === 'err' ? 'dash__error' : 'wi-muted'}>
              {statusLine.kind === 'ok' ? <Flame size={14} /> : null} {statusLine.text}
            </p>
          ) : null}
          {(st?.wraps || []).length ? (
            <ul className="wi-list">
              {(st.wraps || []).slice(-8).reverse().map((w) => (
                <li key={w.assetHash}>
                  <code>{shortHex(w.assetHash, 10, 8)}</code> · {w.outstandingE8} e8 outstanding
                  {' · '}
                  issuer {shortHex(w.issuerWart, 6, 4)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="wi-muted">No wraps yet. Lock ETH, then mint on Warthog L1.</p>
          )}
          <p className="wi-muted">
            ETH 3P signers are e1/e2 in the browser-node (separate from WART d1/d2). Turn ETH Signing
            ON on two tabs after a hard-refresh.
          </p>
        </div>
      ) : null}
    </section>
  );
}
