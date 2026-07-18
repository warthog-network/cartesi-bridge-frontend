// src/components/WalletIsland.jsx — MERGED WITH WARTHOG WALLET FOR ASTRO (December 2025)
// Updated with class-based styles for Warthog section
// Refactored: Extracted WarthogWallet and SubWallet as separate components
// README: This is the main component for the WalletIsland DApp, handling connection to MetaMask, vault management, deposits/withdrawals for backing assets, and toggling the Warthog native wallet section. It integrates Cartesi rollup interactions via portals and inputs. The Warthog section is conditionally rendered via a toggle, and it passes necessary props like the 'send' function for relaying proofs to the extracted WarthogWallet component.
import './WalletIsland.css'; // Added external styles for modern, concise CSS

import { useState, useEffect } from 'react';
import { Wallet, Coins, RefreshCw } from 'lucide-react';
import { Toaster, toast } from 'react-hot-toast';
import { ethers, toUtf8String, getBytes } from 'ethers-v6';
import WarthogWallet from './WarthogWallet'; // Added import for WarthogWallet component
import '../styles/global.css'; // Assuming global styles (including new Warthog CSS) in Astro
import '../styles/warthog.css';
import { getInspectUrl, L1_RPC_URL, LOCAL_ADDRESSES } from '../utils/bridgeConfig.js';
import { SHARE_TOKEN } from '../utils/tokenNames.js';

// CARTESI CLI 1.5 local Anvil address book
const RPC_URL = L1_RPC_URL;
const INPUT_BOX_ADDRESS = LOCAL_ADDRESSES.inputBox;
const DAPP_ADDRESS = LOCAL_ADDRESSES.dapp;
const ETHER_PORTAL_ADDRESS = LOCAL_ADDRESSES.etherPortal;
const ERC20_PORTAL_ADDRESS = LOCAL_ADDRESSES.erc20Portal;
// WWART not deployed locally — UI will disable deposit until set
const WWART_ADDRESS = "";
const CTSI_ADDRESS = "0xae7f61eCf06C65405560166b259C54031428A9C4";
const USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

const INPUT_BOX_ABI = [
  "function addInput(address dappAddress, bytes calldata input) external returns (uint256)"
];

const ETHER_PORTAL_ABI = [
  "function depositEther(address _dapp, bytes calldata _execLayerData) external payable"
];

const ERC20_PORTAL_ABI = [
  "function depositERC20Tokens(address _erc20, address _dapp, uint256 _amount, bytes calldata _execLayerData) external"
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

export default function WalletIsland() {
  // STATES FROM ORIGINAL WalletIsland
  const [address, setAddress] = useState('');
  const [connected, setConnected] = useState(false);
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [vault, setVault] = useState({ liquid: "0", wWART: "0", CTSI: "0", eth: "0", usdc: "0" });
  const [spoofedWwart, setSpoofedWwart] = useState({ history: [], burnHistory: [], total: '0', totalBurned: '0' });
  const [burnAmt, setBurnAmt] = useState('');
  const [ethDepositAmt, setEthDepositAmt] = useState('');
  const [withdrawEthAmt, setWithdrawEthAmt] = useState('');
  const [wwartDepositAmt, setWwartDepositAmt] = useState('');
  const [ctsiDepositAmt, setCtsiDepositAmt] = useState('');
  const [usdcDepositAmt, setUsdcDepositAmt] = useState('');
  const [withdrawWwartAmt, setWithdrawWwartAmt] = useState('');
  const [withdrawCtsiAmt, setWithdrawCtsiAmt] = useState('');
  const [withdrawUsdcAmt, setWithdrawUsdcAmt] = useState('');
  const [loading, setLoading] = useState(false);

  // NEW: Toggle for Warthog section (to keep UI optional in Astro island)
  const [showWarthog, setShowWarthog] = useState(true);
  const [rollupOnline, setRollupOnline] = useState(null);
  /** L1 Cartesi panel tabs — mirrors Warthog Overview/Send pill pattern */
  const [l1Tab, setL1Tab] = useState('balances'); // balances | spoofed | portals

  // useEffects FROM ORIGINAL WalletIsland
  useEffect(() => {
    const tryAutoConnect = async () => {
      if (!window.ethereum) return;
      try {
        const prov = new ethers.BrowserProvider(window.ethereum);
        const accounts = await prov.listAccounts();
        if (accounts.length > 0) {
          const sign = await prov.getSigner();
          const addr = await sign.getAddress();
          setProvider(prov);
          setSigner(sign);
          setAddress(addr);
          setConnected(true);
          toast.success(`Auto-connected: ${addr.slice(0,6)}...${addr.slice(-4)}`);
          refreshVault(addr);
        }
      } catch (err) {
        console.log("No auto-connect");
      }
    };
    tryAutoConnect();
  }, []);

  useEffect(() => {
    if (connected && address) {
      refreshVault(address);
      const interval = setInterval(() => refreshVault(address), 12000);
      return () => clearInterval(interval);
    }
  }, [connected, address]);

  // Probe Cartesi (inspect and/or GraphQL) — INSPECT_URL was removed from imports
  // which made the badge stuck offline even when cartesi run is healthy.
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const zero = '0000000000000000000000000000000000000000';
      // Prefer same-origin Vite proxy, then direct local node
      const inspectBases = [
        getInspectUrl().replace(/\/$/, ''),
        '/rollup/inspect',
        'http://127.0.0.1:8080/inspect',
      ];
      const graphqlUrls = [
        typeof window !== 'undefined'
          ? new URL('/rollup/graphql', window.location.origin).href
          : null,
        'http://127.0.0.1:8080/graphql',
      ].filter(Boolean);

      let online = false;
      try {
        for (const base of inspectBases) {
          try {
            const res = await fetch(`${base}/vault/${zero}`, {
              signal: controller.signal,
              cache: 'no-store',
            });
            // Cartesi returns 200 Accepted even for empty vaults
            if (res.ok) {
              online = true;
              break;
            }
          } catch {
            /* try next */
          }
        }
        if (!online) {
          for (const gurl of graphqlUrls) {
            try {
              const res = await fetch(gurl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: '{ __typename }' }),
                signal: controller.signal,
                cache: 'no-store',
              });
              if (res.ok) {
                online = true;
                break;
              }
            } catch {
              /* try next */
            }
          }
        }
      } catch {
        online = false;
      } finally {
        clearTimeout(timer);
      }
      if (!cancelled) setRollupOnline(online);
    };
    probe();
    const t = setInterval(probe, 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // FUNCTIONS FROM ORIGINAL WalletIsland
  const connect = async () => {
    if (!window.ethereum) {
      toast.error("Please install MetaMask!");
      return;
    }

    try {
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: '0x7a69',
            chainName: 'Cartesi Local',
            rpcUrls: [RPC_URL],
            nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          }]
        });
      } catch (e) {}

      await window.ethereum.request({ method: 'eth_requestAccounts' });
      const prov = new ethers.BrowserProvider(window.ethereum);
      const sign = await prov.getSigner();
      const addr = await sign.getAddress();

      setProvider(prov);
      setSigner(sign);
      setAddress(addr);
      setConnected(true);
      toast.success(`Connected: ${addr.slice(0,6)}...${addr.slice(-4)}`);
      refreshVault(addr);
    } catch (err) {
      toast.error("Connection rejected");
      console.error(err);
    }
  };

  /** Cartesi inspect reports payload is 0x-hex JSON, not raw UTF-8 bytes. */
  const decodeInspectPayload = (payload) => {
    if (payload == null) return null;
    if (typeof payload === 'object') return payload;
    const s = String(payload);
    try {
      if (s.startsWith('0x') || s.startsWith('0X')) {
        return JSON.parse(toUtf8String(s));
      }
      // raw JSON string
      if (s.trim().startsWith('{')) return JSON.parse(s);
      // hex without 0x
      if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
        return JSON.parse(toUtf8String('0x' + s));
      }
      return JSON.parse(new TextDecoder().decode(getBytes(s)));
    } catch (e) {
      console.warn('[refreshVault] payload decode failed', e);
      return null;
    }
  };

  const refreshVault = async (addr) => {
    if (!addr) return;
    setLoading(true);
    try {
      // Normalize to 0x + 40 lowercase hex for rollup map keys
      let hex = String(addr).trim().replace(/^0x/i, '').toLowerCase();
      if (hex.length !== 40 || !/^[0-9a-f]+$/.test(hex)) {
        console.warn('[refreshVault] invalid L1 address for inspect:', addr);
        return;
      }
      const base = getInspectUrl().replace(/\/$/, '');
      const res = await fetch(`${base}/vault/${hex}`);
      const data = await res.json();
      if (data.reports?.length > 0) {
        const json = decodeInspectPayload(data.reports[0].payload);
        if (!json || json.error) {
          console.warn('[refreshVault] inspect error/empty', json);
          return;
        }
        setSpoofedWwart({
          history: json.spoofedMintHistory || [],
          burnHistory: json.spoofedBurnHistory || [],
          total: String(json.totalSpoofedMinted || '0'),
          totalBurned: String(json.totalSpoofedBurned || '0'),
        });
        // wWART credits from Warthog path are E8-scale on the dApp; keep raw for formatWart paths
        setVault((prev) => ({
          ...prev,
          ...json,
          // Prefer numeric display helpers: eth already human; ERC20 fields may be wei or E8
        }));
      }
    } catch (err) {
      console.log('Vault not ready yet', err?.message || err);
    } finally {
      setLoading(false);
    }
  };

  const send = async (payload) => {
    if (!signer) {
      toast.error("Wallet not connected!");
      throw new Error("Wallet not connected!");
    }
    try {
      setLoading(true);
      const message = JSON.stringify(payload);
      const payloadBytes = new TextEncoder().encode(message);
      const inputBox = new ethers.Contract(INPUT_BOX_ADDRESS, INPUT_BOX_ABI, signer);
      const tx = await inputBox.addInput(DAPP_ADDRESS, payloadBytes, { gasLimit: 200000 });
      const receipt = await tx.wait();
      // ethers-v6: receipt.hash (v5 used transactionHash)
      const txHash = receipt?.hash || receipt?.transactionHash || tx?.hash || '';
      toast.success(txHash ? `Sent! Tx: ${String(txHash).slice(0, 10)}…` : 'Sent to rollup InputBox');
      setTimeout(() => refreshVault(address), 8000);
      return receipt;
    } catch (err) {
      toast.error(`Failed: ${err.message || err}`);
      console.error(err);
      throw err; // Re-throw to propagate to callers
    } finally {
      setLoading(false);
    }
  };

  const depositEth = async () => {
    if (!ethDepositAmt || !signer) return;
    try {
      setLoading(true);
      const amountWei = ethers.parseEther(ethDepositAmt);
      const portal = new ethers.Contract(ETHER_PORTAL_ADDRESS, ETHER_PORTAL_ABI, signer);
      const tx = await portal.depositEther(DAPP_ADDRESS, "0x", { value: amountWei, gasLimit: 200000 });
      await tx.wait();
      toast.success('ETH Deposited!');
      setEthDepositAmt('');
      setTimeout(() => refreshVault(address), 8000);
    } catch (err) {
      toast.error(`Failed: ${err.message || err}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const withdrawEth = () => {
    if (!withdrawEthAmt || loading) return;
    send({ type: "withdraw_eth", amount: withdrawEthAmt })
      .then(() => {
        setWithdrawEthAmt('');
        toast.success('Withdrawal request sent! Voucher will be available for L1 claim after rollup processing.');
      });
  };

  const withdrawWwart = () => {
    if (!withdrawWwartAmt || loading) return;
    send({ type: "withdraw_wwart", amount: withdrawWwartAmt })
      .then(() => {
        setWithdrawWwartAmt('');
        toast.success('Withdrawal request sent! Voucher will be available for L1 claim after rollup processing.');
      });
  };

  const withdrawCtsi = () => {
    if (!withdrawCtsiAmt || loading) return;
    send({ type: "withdraw_ctsi", amount: withdrawCtsiAmt })
      .then(() => {
        setWithdrawCtsiAmt('');
        toast.success('Withdrawal request sent! Voucher will be available for L1 claim after rollup processing.');
      });
  };

  const withdrawUsdc = () => {
    if (!withdrawUsdcAmt || loading) return;
    send({ type: "withdraw_usdc", amount: withdrawUsdcAmt })
      .then(() => {
        setWithdrawUsdcAmt('');
        toast.success('Withdrawal request sent! Voucher will be available for L1 claim after rollup processing.');
      });
  };

  const depositErc20 = async (tokenAddress, amountStr, decimals) => {
    if (!amountStr || !signer) return;
    try {
      setLoading(true);
      const amount = ethers.parseUnits(amountStr, decimals);
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
      // ethers-v6 returns bigint — never use BigNumber .lt()
      const allowance = await token.allowance(address, ERC20_PORTAL_ADDRESS);
      if (allowance < amount) {
        const txApprove = await token.approve(ERC20_PORTAL_ADDRESS, amount, { gasLimit: 100000 });
        await txApprove.wait();
        toast.success('Approved!');
      }
      const portal = new ethers.Contract(ERC20_PORTAL_ADDRESS, ERC20_PORTAL_ABI, signer);
      const tx = await portal.depositERC20Tokens(tokenAddress, DAPP_ADDRESS, amount, "0x", { gasLimit: 200000 });
      await tx.wait();
      toast.success('Deposited!');
      setTimeout(() => refreshVault(address), 8000);
    } catch (err) {
      toast.error(`Failed: ${err.message || err}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

    const depositWwart = () => {
    if (!WWART_ADDRESS) {
      toast.error('wWART token not configured for this network yet');
      return;
    }
    return depositErc20(WWART_ADDRESS, wwartDepositAmt, 18).then(() => setWwartDepositAmt(''));
  };
  const depositCtsi = () => depositErc20(CTSI_ADDRESS, ctsiDepositAmt, 18).then(() => setCtsiDepositAmt(''));
  const depositUsdc = () => depositErc20(USDC_ADDRESS, usdcDepositAmt, 6).then(() => setUsdcDepositAmt(''));

  const format = (val, decimals) => Number(ethers.formatUnits(val || "0", decimals));
  const formatWart = (e8Str) => {
    if (!e8Str || e8Str === '0') return '0.00000000';
    try {
      const bn = BigInt(e8Str);
      const integer = (bn / 100000000n).toString();
      let fractional = (bn % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
      return fractional ? `${integer}.${fractional}` : integer;
    } catch {
      return '0.00000000';
    }
  };

  /**
   * Rollup stores Warthog-path wWART / spoofed amounts in E8 (8 decimals).
   * Portal ERC-20 deposits may use 18-dec wei. Heuristic: values &lt; 1e15 treated as E8.
   */
  const formatVaultToken = (val, portalDecimals = 18) => {
    if (val == null || val === '' || val === '0') return 0;
    try {
      const bn = BigInt(val);
      // E8-scale amounts from sweep_lock (e.g. 100 WART = 1e10)
      if (bn > 0n && bn < 10n ** 15n) {
        return Number(bn) / 1e8;
      }
      return Number(ethers.formatUnits(bn, portalDecimals));
    } catch {
      return Number(val) || 0;
    }
  };

  const liquid = format(vault.liquid, 18);
  const wWART = formatVaultToken(vault.wWART, 18);
  const CTSI = format(vault.CTSI, 18);
  const eth = Number(vault.eth || 0);
  const usdc = format(vault.usdc, 6);

  const totalBacking = wWART + CTSI + eth + usdc;
  const wwartPct = totalBacking > 0 ? (wWART / totalBacking * 100).toFixed(1) : 0;
  const ctsiPct = totalBacking > 0 ? (CTSI / totalBacking * 100).toFixed(1) : 0;
  const ethPct = totalBacking > 0 ? (eth / totalBacking * 100).toFixed(1) : 0;
  const usdcPct = totalBacking > 0 ? (usdc / totalBacking * 100).toFixed(1) : 0;

  const outstandingSpoofed = (() => {
    try {
      const m = BigInt(spoofedWwart.total || '0');
      const b = BigInt(spoofedWwart.totalBurned || '0');
      return (m > b ? m - b : 0n).toString();
    } catch {
      return '0';
    }
  })();

  const L1_TABS = [
    { id: 'balances', label: 'Balances' },
    { id: 'spoofed', label: 'Spoofed wWART' },
    { id: 'portals', label: 'L1 portals' },
  ];

  const renderPortalAsset = ({
    label,
    depositVal,
    setDeposit,
    onDeposit,
    withdrawVal,
    setWithdraw,
    onWithdraw,
    note,
    depositDisabled = false,
  }) => (
    <div className="wi-portal-card">
      <div className="wi-portal-title">{label}</div>
      <div className="wi-portal-row">
        <input
          type="number"
          placeholder="Deposit"
          value={depositVal}
          onChange={(e) => setDeposit(e.target.value)}
          className="input wi-portal-input"
          disabled={depositDisabled}
        />
        <button
          type="button"
          onClick={onDeposit}
          className="btn primary small"
          disabled={loading || depositDisabled}
        >
          Deposit
        </button>
      </div>
      <div className="wi-portal-row">
        <input
          type="number"
          placeholder="Withdraw"
          value={withdrawVal}
          onChange={(e) => setWithdraw(e.target.value)}
          className="input wi-portal-input"
          disabled={depositDisabled}
        />
        <button
          type="button"
          onClick={onWithdraw}
          className="btn danger small"
          disabled={loading || !withdrawVal || depositDisabled}
        >
          Withdraw
        </button>
      </div>
      {note ? <p className="wi-portal-note">{note}</p> : null}
    </div>
  );

  if (!connected) {
    return (
      <div className="wi-shell preview-section">
        <Toaster position="top-right" />
        <div className="wi-connect-card">
          <p className="wi-connect-lead">Cartesi L1 vault — connect MetaMask (local Anvil)</p>
          <button type="button" onClick={connect} className="btn primary">
            <Wallet className="inline" size={18} style={{ marginRight: 8, verticalAlign: -3 }} />
            Connect wallet
          </button>
          <div className="wi-stat-grid wi-stat-grid--preview">
            <div className="wi-stat wi-stat--liquid">
              <span className="wi-stat-k">{SHARE_TOKEN.symbol}</span>
              <span className="wi-stat-v">1,500</span>
            </div>
            <div className="wi-stat">
              <span className="wi-stat-k">wWART</span>
              <span className="wi-stat-v">750</span>
            </div>
            <div className="wi-stat">
              <span className="wi-stat-k">CTSI</span>
              <span className="wi-stat-v">450</span>
            </div>
            <div className="wi-stat">
              <span className="wi-stat-k">ETH</span>
              <span className="wi-stat-v">0.12</span>
            </div>
          </div>
          <p className="wi-muted">Preview only — connect to load your vault</p>
        </div>
      </div>
    );
  }

  return (
    <div className="wi-shell vault-section">
      <Toaster position="top-right" />

      {/* Compact L1 header — same density as Warthog header */}
      <header className="wi-header">
        <div className="wi-header-main">
          <div className="wi-header-id">
            <span className="wi-header-label">L1 MetaMask</span>
            <button
              type="button"
              className="wi-address-chip"
              title={address}
              onClick={() => {
                navigator.clipboard?.writeText(address);
                toast.success('Address copied');
              }}
            >
              {address.slice(0, 6)}…{address.slice(-4)}
            </button>
          </div>
          <span
            className={`network-badge ${
              rollupOnline ? 'network-badge--defi' : 'network-badge--main'
            }`}
          >
            {rollupOnline === null
              ? 'Rollup…'
              : rollupOnline
                ? 'Rollup online'
                : 'Rollup offline'}
          </span>
        </div>
        <div className="wi-header-tools">
          <button
            type="button"
            className="btn secondary small"
            onClick={() => send({ type: 'register_address' })}
            disabled={loading || rollupOnline === false}
            title="Register L1 address with the Cartesi dApp"
          >
            Register
          </button>
          <button
            type="button"
            className="btn primary small"
            onClick={() => refreshVault(address)}
            disabled={loading}
          >
            <RefreshCw size={14} className="inline" style={{ marginRight: 4, verticalAlign: -2 }} />
            Refresh
          </button>
          <button
            type="button"
            className={`btn small ${showWarthog ? 'secondary' : 'primary'}`}
            onClick={() => setShowWarthog(!showWarthog)}
          >
            {showWarthog ? 'Hide Warthog' : 'Show Warthog'}
          </button>
        </div>
      </header>

      {/* L1 panel tabs */}
      <nav className="sw-action-tabs wi-l1-tabs" role="tablist" aria-label="Cartesi L1 vault">
        {L1_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={l1Tab === t.id}
            className={`sw-action-tab ${l1Tab === t.id ? 'is-active' : ''}`}
            onClick={() => setL1Tab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {l1Tab === 'balances' && (
        <div className="wi-panel">
          <div className="wi-stat-grid">
            <div className="wi-stat wi-stat--liquid">
              <Coins size={18} className="wi-stat-icon" />
              <span className="wi-stat-k">{SHARE_TOKEN.symbol}</span>
              <span className="wi-stat-v">
                {liquid.toLocaleString(undefined, { maximumFractionDigits: 4 })}
              </span>
            </div>
            <div className="wi-stat">
              <span className="wi-stat-k">wWART · {wwartPct}%</span>
              <span className="wi-stat-v">{wWART.toFixed(4)}</span>
            </div>
            <div className="wi-stat">
              <span className="wi-stat-k">CTSI · {ctsiPct}%</span>
              <span className="wi-stat-v">{CTSI.toFixed(4)}</span>
            </div>
            <div className="wi-stat">
              <span className="wi-stat-k">ETH · {ethPct}%</span>
              <span className="wi-stat-v">{eth.toFixed(6)}</span>
            </div>
            <div className="wi-stat">
              <span className="wi-stat-k">USDC · {usdcPct}%</span>
              <span className="wi-stat-v">{usdc.toFixed(4)}</span>
            </div>
            <div className="wi-stat wi-stat--spoof">
              <span className="wi-stat-k">Spoofed outstanding</span>
              <span className="wi-stat-v">{formatWart(outstandingSpoofed)}</span>
            </div>
          </div>
          <details className="wi-guide">
            <summary>WART bridge path</summary>
            <ol className="bridge-path-steps">
              <li>
                <strong>Warthog → Sub-wallets</strong> — fund sub, sweep → vault + mint
              </li>
              <li>
                <strong>Spoofed wWART</strong> — 1:1 on L1 vault (this panel / Spoofed tab)
              </li>
              <li>
                <strong>Mint {SHARE_TOKEN.symbol}</strong> — Warthog Overview → {SHARE_TOKEN.symbol}
              </li>
              <li>
                <strong>L1 portals</strong> — optional ETH/CTSI/USDC backing (not native WART)
              </li>
            </ol>
          </details>
        </div>
      )}

      {l1Tab === 'spoofed' && (
        <div className="wi-panel">
          <div className="wi-stat-grid">
            <div className="wi-stat">
              <span className="wi-stat-k">Total minted</span>
              <span className="wi-stat-v">{formatWart(spoofedWwart.total)}</span>
            </div>
            <div className="wi-stat">
              <span className="wi-stat-k">Total burned</span>
              <span className="wi-stat-v">{formatWart(spoofedWwart.totalBurned)}</span>
            </div>
            <div className="wi-stat wi-stat--spoof">
              <span className="wi-stat-k">Outstanding</span>
              <span className="wi-stat-v">{formatWart(outstandingSpoofed)}</span>
            </div>
          </div>
          <p className="wi-muted">
            Minted 1:1 on sub → vault sweep. Burn freeable amounts on{' '}
            <strong>Warthog → Sub-wallets</strong> (partial burns leave residual pin).
          </p>
          {spoofedWwart.history.length > 0 && (
            <ul className="wi-history">
              {spoofedWwart.history.slice(0, 8).map((m, i) => (
                <li key={`m-${i}`}>
                  Mint {formatWart(m.amount)} · sub {m.subAddress?.slice(0, 10)}… ·{' '}
                  {new Date(m.timestamp).toLocaleString()}
                </li>
              ))}
            </ul>
          )}
          {spoofedWwart.burnHistory?.length > 0 && (
            <ul className="wi-history wi-history--burn">
              {spoofedWwart.burnHistory.slice(0, 8).map((b, i) => (
                <li key={`b-${i}`}>
                  Burn {formatWart(b.amount)} · {b.subAddress?.slice(0, 10)}… ·{' '}
                  {new Date(b.timestamp).toLocaleString()}
                </li>
              ))}
            </ul>
          )}
          {spoofedWwart.history.length === 0 &&
            !(spoofedWwart.burnHistory?.length > 0) && (
              <p className="wi-muted">No mint/burn history yet.</p>
            )}
        </div>
      )}

      {l1Tab === 'portals' && (
        <div className="wi-panel">
          <p className="wi-muted">
            Anvil/MetaMask portals for ETH / ERC-20. Native WART → spoofed wWART uses{' '}
            <strong>Warthog Sub-wallets</strong>, not these portals.
          </p>
          <div className="wi-portal-grid">
            {renderPortalAsset({
              label: 'ETH',
              depositVal: ethDepositAmt,
              setDeposit: setEthDepositAmt,
              onDeposit: depositEth,
              withdrawVal: withdrawEthAmt,
              setWithdraw: setWithdrawEthAmt,
              onWithdraw: withdrawEth,
              note: 'Withdraw creates a voucher — execute on L1 when ready.',
            })}
            {WWART_ADDRESS ? (
              renderPortalAsset({
                label: 'wWART (L1 ERC-20)',
                depositVal: wwartDepositAmt,
                setDeposit: setWwartDepositAmt,
                onDeposit: depositWwart,
                withdrawVal: withdrawWwartAmt,
                setWithdraw: setWithdrawWwartAmt,
                onWithdraw: withdrawWwart,
                note: 'Trustless voucher on L1.',
              })
            ) : (
              <div className="wi-portal-card wi-portal-card--disabled">
                <div className="wi-portal-title">wWART (L1 ERC-20)</div>
                <p className="wi-portal-note">
                  Not on local Anvil. Use Sub-wallets for spoofed wWART. Set WWART_ADDRESS later for
                  portal deposits.
                </p>
              </div>
            )}
            {renderPortalAsset({
              label: 'CTSI',
              depositVal: ctsiDepositAmt,
              setDeposit: setCtsiDepositAmt,
              onDeposit: depositCtsi,
              withdrawVal: withdrawCtsiAmt,
              setWithdraw: setWithdrawCtsiAmt,
              onWithdraw: withdrawCtsi,
              note: 'Trustless voucher on L1.',
            })}
            {renderPortalAsset({
              label: 'USDC',
              depositVal: usdcDepositAmt,
              setDeposit: setUsdcDepositAmt,
              onDeposit: depositUsdc,
              withdrawVal: withdrawUsdcAmt,
              setWithdraw: setWithdrawUsdcAmt,
              onWithdraw: withdrawUsdc,
              note: 'Trustless voucher on L1.',
            })}
          </div>
        </div>
      )}

      {showWarthog && (
        <WarthogWallet
          send={send}
          address={address}
          l1Address={address}
          loading={loading}
          setLoading={setLoading}
          burnAmt={burnAmt}
          setBurnAmt={setBurnAmt}
          l1Vault={vault}
          onRefreshL1Vault={() => refreshVault(address)}
        />
      )}
    </div>
  );
}
