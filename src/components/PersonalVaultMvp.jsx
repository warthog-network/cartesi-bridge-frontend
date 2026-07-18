import { useState, useEffect } from 'react';
import { gql, GraphQLClient } from 'graphql-request';
import { keccak256, toUtf8Bytes, toUtf8String } from 'ethers-v6';
import { toast } from 'react-hot-toast';
import { createWarthogApi, signAndSubmitTransaction } from '../utils/warthogClient.js';
import { getSmartNonce, bumpNonceAfterSuccess } from '../utils/cancelLimitOrder.js';
import { loadPersonalVault, savePersonalVault } from '../utils/personalVault.js';
import { getTxConfirmationStatus } from '../utils/txProof.js';

import { getRollupGraphqlUrl, getInspectUrl } from '../utils/bridgeConfig.js';
import { deriveSubWallet as deriveSubFromMnemonic, deriveSubPrivateKey } from '../utils/subWalletDerive.js';
import {
  createTwoPartyVault,
  encryptJsonWithMnemonic,
  saveTwoPartyClientLocal,
  MULTISIG_SCHEME,
} from '../utils/twoPartyEcdsa.js';
import { registerMultiSigVault } from '../utils/cosignerClient.js';

const STEPS = ['Create Token', 'Register Vault', 'Fund Vault', 'Status'];

export default function PersonalVaultMvp({
  mainWallet,
  mainMnemonic,
  selectedNode,
  l1Address,
  send,
  sendTransaction,
  getWartTxProof,
  fetchBalanceAndNonce,
  loading,
  setLoading,
}) {
  const [step, setStep] = useState(0);
  const [tokenName, setTokenName] = useState('BTC');
  const [tokenSupply, setTokenSupply] = useState('21000000');
  const [tokenDecimals, setTokenDecimals] = useState('8');
  const [fundAmount, setFundAmount] = useState('1');
  const [assetHash, setAssetHash] = useState(null);
  const [assetTxHash, setAssetTxHash] = useState(null);
  const [subWallet, setSubWallet] = useState(null);
  const [vaultAddress, setVaultAddress] = useState(null);
  const [vaultWartBalance, setVaultWartBalance] = useState(null);
  const [tokenBalance, setTokenBalance] = useState(null);
  const [rollupVault, setRollupVault] = useState(null);
  const [busy, setBusy] = useState(false);

  const client = new GraphQLClient(getRollupGraphqlUrl());

  useEffect(() => {
    if (!mainWallet?.address) return;
    const saved = loadPersonalVault(mainWallet.address);
    if (!saved) return;
    if (saved.assetHash) setAssetHash(saved.assetHash);
    if (saved.assetName) setTokenName(saved.assetName);
    if (saved.subWallet) setSubWallet(saved.subWallet);
    if (saved.vaultAddress) setVaultAddress(saved.vaultAddress);
    if (saved.step != null) setStep(saved.step);
  }, [mainWallet?.address]);

  const persist = (patch) => {
    if (!mainWallet?.address) return;
    const current = loadPersonalVault(mainWallet.address) || {};
    savePersonalVault(mainWallet.address, { ...current, ...patch, assetName: tokenName });
  };

  const pollNotice = async (type, matchFn, timeoutMs = 60000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const { notices } = await client.request(gql`
          { notices(last: 10) { edges { node { payload } } } }
        `);
        const parsed = notices.edges
          .map((e) => {
            try { return JSON.parse(toUtf8String(e.node.payload)); }
            catch { return null; }
          })
          .filter(Boolean);
        const hit = parsed.find((n) => n.type === type && matchFn(n));
        if (hit) return hit;
      } catch {
        // rollup may not be up yet
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  };

  const pollTxConfirmed = async (txHash, required = 2) => {
    const api = await createWarthogApi(selectedNode);
    for (let i = 0; i < 40; i++) {
      const res = await api.getNodePath(`transaction/lookup/${txHash}`);
      if (res.success) {
        const { blockHeight, confirmations } = getTxConfirmationStatus(res.data);
        if (blockHeight !== undefined && confirmations >= required) return true;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return false;
  };

  const resolveAssetHash = async (name) => {
    const api = await createWarthogApi(selectedNode);
    for (let i = 0; i < 20; i++) {
      const res = await api.searchAssets(name.toUpperCase());
      if (res.success) {
        const match = (res.data?.matches || []).find((m) => m.name?.toUpperCase() === name.toUpperCase());
        if (match?.hash) return match.hash;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return null;
  };

  const deriveSubWallet = async () => {
    if (!mainMnemonic) throw new Error('Wallet mnemonic required — save wallet with seed phrase');
    if (!mainWallet?.address) throw new Error('Main wallet address required');

    let noticePayload = 'fallback';
    try {
      const { notices } = await client.request(gql`
        { notices(last: 1) { edges { node { payload } } } }
      `);
      noticePayload = notices.edges[0]?.node.payload || 'fallback';
    } catch {
      // rollup offline — deterministic fallback salt still works
    }

    let saltSource = noticePayload;
    try {
      saltSource = toUtf8String(noticePayload) + mainWallet.address + 'btc-vault';
    } catch {
      saltSource = String(noticePayload) + mainWallet.address + 'btc-vault';
    }
    const saltedIndex =
      parseInt(keccak256(toUtf8Bytes(saltSource)).slice(2, 10), 16) %
      (2 ** 31 - 1);

    const derived = await deriveSubFromMnemonic(mainMnemonic, saltedIndex);
    const sub = { index: derived.index, address: derived.address };
    setSubWallet(sub);
    persist({ subWallet: sub });
    return sub;
  };

  const refreshStatus = async () => {
    if (!l1Address) return;
    try {
      const res = await fetch(`${getInspectUrl()}/vault/${l1Address.slice(2).toLowerCase()}`);
      if (!res.ok) throw new Error(`Inspect HTTP ${res.status}`);
      const data = await res.json();
      if (data.reports?.length > 0) {
        const json = JSON.parse(toUtf8String(data.reports[0].payload));
        setRollupVault(json);
        if (json.personalVault?.vaultAddress) {
          setVaultAddress(json.personalVault.vaultAddress);
        }
      }
    } catch (err) {
      console.warn('[PersonalVault] rollup inspect unavailable:', err.message);
    }

    if (vaultAddress && fetchBalanceAndNonce) {
      try {
        const bal = await fetchBalanceAndNonce(vaultAddress, true);
        setVaultWartBalance(bal?.balance ?? '0');
      } catch (err) {
        console.warn('[PersonalVault] vault balance fetch failed:', err.message);
        setVaultWartBalance(null);
      }
    }

    if (assetHash && mainWallet?.address && selectedNode) {
      try {
        const api = await createWarthogApi(selectedNode);
        const res = await api.getAccountAssetBalance(mainWallet.address, assetHash);
        if (res.success) {
          const total = res.data?.balance?.total;
          setTokenBalance(total?.str || '0');
        }
      } catch (err) {
        console.warn('[PersonalVault] asset balance fetch failed:', err.message);
      }
    }
  };

  useEffect(() => {
    if (step === 3) refreshStatus();
  }, [step, vaultAddress, assetHash, l1Address]);

  const handleCreateToken = async () => {
    if (!mainWallet?.address) return toast.error('Unlock Warthog wallet first');
    setBusy(true);
    setLoading(true);
    const toastId = toast.loading('Creating native token on chain...');
    try {
      const api = await createWarthogApi(selectedNode);
      const nonceId = getSmartNonce(mainWallet.address, 0);
      const { nonce, data } = await signAndSubmitTransaction(api, {
        nonceId,
        buildSpec: {
          type: 'ASSET_CREATE',
          name: tokenName,
          supply: tokenSupply,
          decimals: tokenDecimals,
        },
      });
      bumpNonceAfterSuccess(mainWallet.address, nonce, 0);
      const txHash = data?.txHash;
      setAssetTxHash(txHash);
      toast.loading('Waiting for confirmation...', { id: toastId });

      if (txHash) await pollTxConfirmed(txHash, 1);

      const hash = await resolveAssetHash(tokenName);
      if (!hash) throw new Error('Token created but asset hash not found yet — try again in a minute');

      setAssetHash(hash);
      persist({ assetHash: hash, assetTxHash: txHash, step: 1 });
      setStep(1);
      toast.success(`Token ${tokenName} created!`, { id: toastId });
    } catch (err) {
      toast.error(err.message, { id: toastId });
    } finally {
      setBusy(false);
      setLoading(false);
    }
  };

  const handleRegisterVault = async () => {
    if (!l1Address) return toast.error('Connect MetaMask (L1) first — needed to tie vault to your account');
    if (!assetHash) return toast.error('Create token first');
    setBusy(true);
    setLoading(true);
    const toastId = toast.loading('Registering personal vault on rollup...');
    try {
      const sub = subWallet || await deriveSubWallet();
      if (!mainMnemonic) throw new Error('Mnemonic required to encrypt 2P client secret');
      const vault = await createTwoPartyVault({
        subAddress: sub.address,
        index: sub.index,
        owner: l1Address,
      });
      const enc = encryptJsonWithMnemonic(vault.clientSecret, mainMnemonic);
      saveTwoPartyClientLocal({
        mainAddress: mainWallet?.address,
        subAddress: sub.address,
        vaultAddress: vault.address,
        index: sub.index,
        encryptedClientSecret: enc,
        scheme: MULTISIG_SCHEME,
      });
      await registerMultiSigVault({
        ...vault.cosignerRegister,
        owner: l1Address.toLowerCase(),
        subAddress: sub.address,
        index: sub.index,
      });

      await send({
        type: 'create_vault',
        subAddress: sub.address,
        index: sub.index,
        owner: l1Address,
        vaultAddress: vault.address,
        multisig: true,
        scheme: MULTISIG_SCHEME,
        assetHash,
        assetName: tokenName.toUpperCase(),
      });

      const notice = await pollNotice('vault_created', (n) => n.subAddress === sub.address);
      const vAddr = notice?.vaultAddress || vault.address;
      if (!vAddr) throw new Error('Vault registration not confirmed on rollup');

      setVaultAddress(vAddr);
      persist({ vaultAddress: vAddr, step: 2, multisig: true });
      setStep(2);
      toast.success('2P-ECDSA multi-sig vault registered!', { id: toastId });
    } catch (err) {
      toast.error(err.message, { id: toastId });
    } finally {
      setBusy(false);
      setLoading(false);
    }
  };

  const handleFundVault = async () => {
    if (!subWallet?.address || !vaultAddress) return toast.error('Register vault first');
    if (!fundAmount || Number(fundAmount) <= 0) return toast.error('Enter a valid fund amount');

    setBusy(true);
    setLoading(true);
    const toastId = toast.loading('Funding vault (deposit → lock → sweep)...');
    try {
      const depositTx = await sendTransaction(
        mainWallet.privateKey,
        mainWallet.address,
        subWallet.address,
        fundAmount,
        '0.01',
      );
      const depositHash = depositTx?.data?.txHash || depositTx?.txHash;
      if (!depositHash) throw new Error('Deposit tx failed');

      toast.loading('Locking deposit on rollup...', { id: toastId });
      const proof = await getWartTxProof(depositHash);
      await send({
        type: 'sub_lock',
        subAddress: subWallet.address,
        proof,
        index: subWallet.index,
        recipient: l1Address,
      });

      const pending = await pollNotice('subwallet_pending', (n) => n.subAddress === subWallet.address);
      const resolvedVault = pending?.vaultAddress || vaultAddress;

      toast.loading('Waiting for deposit confirmations...', { id: toastId });
      await pollTxConfirmed(depositHash, 2);

      toast.loading('Sweeping WART to vault...', { id: toastId });
      const subPk = deriveSubPrivateKey(mainMnemonic, subWallet.index);

      const sweepTx = await sendTransaction(subPk, subWallet.address, resolvedVault, fundAmount, '0.01');
      const sweepHash = sweepTx?.data?.txHash || sweepTx?.txHash;
      if (!sweepHash) throw new Error('Sweep tx failed');

      await pollTxConfirmed(sweepHash, 2);
      const sweepProof = await getWartTxProof(sweepHash);

      await send({
        type: 'sweep_lock',
        subAddress: subWallet.address,
        sweepProof,
        index: subWallet.index,
      });

      const locked = await pollNotice('sweep_locked', (n) => n.subAddress === subWallet.address);
      if (!locked) throw new Error('Sweep lock not confirmed on rollup');

      setVaultAddress(resolvedVault);
      persist({ vaultAddress: resolvedVault, fundedAmount: fundAmount, step: 3 });
      setStep(3);
      await refreshStatus();
      toast.success(`Vault funded with ${fundAmount} WART, linked to ${tokenName}!`, { id: toastId });
    } catch (err) {
      toast.error(err.message, { id: toastId });
    } finally {
      setBusy(false);
      setLoading(false);
    }
  };

  if (!mainWallet) {
    return (
      <section className="personal-vault-mvp">
        <h3>Personal vault</h3>
        <p>Unlock your Warthog wallet to start.</p>
      </section>
    );
  }

  if (!mainMnemonic) {
    return (
      <div className="wh-card wh-card--inset personal-vault-mvp">
        <p className="wh-muted" style={{ marginBottom: 0 }}>
          Personal vault needs a seed-based wallet. Log in with a seed phrase (not private-key-only import).
        </p>
      </div>
    );
  }

  return (
    <div className="wh-card wh-card--inset personal-vault-mvp">
      <nav className="sw-action-tabs" role="tablist" aria-label="Personal vault steps">
        {STEPS.map((label, i) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={i === step}
            className={`sw-action-tab ${i === step ? 'is-active' : ''}`}
            onClick={() => i <= step && setStep(i)}
            title={i > step ? 'Complete earlier steps first' : label}
          >
            {i + 1}. {label}
          </button>
        ))}
      </nav>

      {step === 0 && (
        <div className="sw-action-panel">
          <div className="form-group">
            <label>Token name (1–5 chars)</label>
            <input className="input" value={tokenName} onChange={(e) => setTokenName(e.target.value.toUpperCase().slice(0, 5))} />
          </div>
          <div className="wh-row-2">
            <div className="form-group">
              <label>Total supply</label>
              <input className="input" value={tokenSupply} onChange={(e) => setTokenSupply(e.target.value)} />
            </div>
            <div className="form-group">
              <label>Decimals</label>
              <input className="input" value={tokenDecimals} onChange={(e) => setTokenDecimals(e.target.value)} />
            </div>
          </div>
          <button className="btn primary small" onClick={handleCreateToken} disabled={busy || !tokenName}>
            {busy ? 'Creating…' : `Create ${tokenName || 'token'}`}
          </button>
          {assetTxHash && <p className="wh-hint">Tx: {assetTxHash.slice(0, 12)}…</p>}
        </div>
      )}

      {step === 1 && (
        <div className="sw-action-panel">
          <p className="wh-muted">
            Token <strong>{tokenName}</strong>
            {assetHash ? (
              <> · <code className="mono">{assetHash.slice(0, 16)}…</code></>
            ) : null}
          </p>
          {!l1Address && (
            <p className="wh-hint" style={{ color: '#ffaa00' }}>
              Connect MetaMask to register under your L1 address.
            </p>
          )}
          {subWallet && (
            <p className="wh-hint">Sub: <code className="mono">{subWallet.address.slice(0, 12)}…</code></p>
          )}
          <button className="btn primary small" onClick={handleRegisterVault} disabled={busy || !l1Address}>
            {busy ? 'Registering…' : 'Register vault + link token'}
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="sw-action-panel">
          <p className="wh-hint mono">Vault: {vaultAddress}</p>
          <div className="form-group">
            <label>Fund amount (WART)</label>
            <input className="input" type="number" step="0.00000001" value={fundAmount} onChange={(e) => setFundAmount(e.target.value)} />
          </div>
          <button className="btn primary small" onClick={handleFundVault} disabled={busy}>
            {busy ? 'Funding…' : 'Fund vault'}
          </button>
        </div>
      )}

      {step === 3 && (
        <div className="sw-action-panel wh-stat-grid">
          <div className="wh-stat">
            <span className="wh-stat-label">Native token</span>
            <span className="wh-stat-value">{tokenName} · {tokenBalance ?? '…'}</span>
          </div>
          <div className="wh-stat">
            <span className="wh-stat-label">Vault WART</span>
            <span className="wh-stat-value">{vaultWartBalance ?? '…'}</span>
          </div>
          <div className="wh-stat">
            <span className="wh-stat-label">Rollup wWART</span>
            <span className="wh-stat-value">
              {rollupVault?.wWART ?? rollupVault?.totalSpoofedMinted ?? '…'}
            </span>
          </div>
          <div className="wh-stat">
            <span className="wh-stat-label">Vault addr</span>
            <span className="wh-stat-value mono">{vaultAddress ? `${vaultAddress.slice(0, 12)}…` : '—'}</span>
          </div>
          <button className="btn primary small" onClick={refreshStatus} disabled={busy}>
            Refresh status
          </button>
        </div>
      )}
    </div>
  );
}
