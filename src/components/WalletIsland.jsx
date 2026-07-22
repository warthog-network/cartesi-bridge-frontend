// src/components/WalletIsland.jsx — MERGED WITH WARTHOG WALLET FOR ASTRO (December 2025)
// Updated with class-based styles for Warthog section
// Refactored: Extracted WarthogWallet and SubWallet as separate components
// README: This is the main component for the WalletIsland DApp, handling connection to MetaMask, vault management, deposits/withdrawals for backing assets, and toggling the Warthog native wallet section. It integrates Cartesi rollup interactions via portals and inputs. The Warthog section is conditionally rendered via a toggle, and it passes necessary props like the 'send' function for relaying proofs to the extracted WarthogWallet component.
import './WalletIsland.css'; // Added external styles for modern, concise CSS

import { useState, useEffect, useRef } from 'react';
import { Wallet, Coins, RefreshCw, LayoutGrid, Eye, EyeOff } from 'lucide-react';
import { Toaster, toast } from 'react-hot-toast';
import { ethers, toUtf8String, getBytes } from 'ethers-v6';
import WarthogWallet from './WarthogWallet'; // Added import for WarthogWallet component
import EthSubWallets from './EthSubWallets.jsx';
import VoucherExecutor from './VoucherExecutor.jsx';
import AnvilTestKeys from './AnvilTestKeys.jsx';
import { useMmTxConfirm } from './MmTxConfirm.jsx';
import '../styles/global.css'; // Assuming global styles (including new Warthog CSS) in Astro
import '../styles/warthog.css';
import {
  getInspectUrl,
  getRollupGraphqlUrl,
  L1_RPC_URL,
  LOCAL_ADDRESSES,
  getAddresses,
  getNetwork,
  getNetworkId,
  getWwartToken,
} from '../utils/bridgeConfig.js';
import { SHARE_TOKEN } from '../utils/tokenNames.js';
import { LOCAL_WWART } from '../utils/localTokens.js';
import {
  computeWliqMintAvailable,
  formatUnits18,
  formatUnits18Exact,
  portalWwart18,
  wwartWithdrawable18,
} from '../utils/wliqCapacity.js';
import {
  loadVaultCache,
  saveVaultCache,
  clearVaultCache,
  vaultHasShareState,
  fetchClaimsFromApi,
  claimsFromGraphQLNotices,
} from '../utils/vaultStateCache.js';
import {
  describeRollupInput,
  describePortalDeposit,
  describeErc20Approve,
} from '../utils/mmTxDescribe.js';

// Active network address book (Anvil default; Sepolia when PUBLIC_NETWORK=sepolia)
const ACTIVE_NETWORK = getNetwork();
/** Prefer public network RPC for MetaMask (users are not on localhost). */
const RPC_URL =
  ACTIVE_NETWORK?.rpcUrl ||
  L1_RPC_URL ||
  'https://cartesi-bridge.duckdns.org/rpc';
const _addrs = getAddresses() || LOCAL_ADDRESSES;
const INPUT_BOX_ADDRESS = _addrs.inputBox || LOCAL_ADDRESSES.inputBox;
const DAPP_ADDRESS = _addrs.dapp || LOCAL_ADDRESSES.dapp;
const ETHER_PORTAL_ADDRESS = _addrs.etherPortal || LOCAL_ADDRESSES.etherPortal;
const ERC20_PORTAL_ADDRESS = _addrs.erc20Portal || LOCAL_ADDRESSES.erc20Portal;
const _wwart = getWwartToken();
const WWART_ADDRESS = (_wwart?.address || LOCAL_WWART?.address || '').toLowerCase();
const ACTIVE_NETWORK_ID = getNetworkId();
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
  "function allowance(address owner, address spender) view returns (uint256)",
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) view returns (uint256)",
];

export default function WalletIsland() {
  const [confirmMmTx, mmTxModal] = useMmTxConfirm();
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
  /** Collapse L1 tabs/panels under the ETH wallet card */
  const [showEthWallet, setShowEthWallet] = useState(true);
  /** MetaMask native ETH balance (human string) */
  const [mainEthBal, setMainEthBal] = useState(null);
  const [rollupOnline, setRollupOnline] = useState(null);
  /**
   * ETH section tabs — mirrors Warthog section menu:
   * overview | subwallets | vault | getwweth
   */
  const [l1Tab, setL1Tab] = useState('overview');
  const [showEthSectionMenu, setShowEthSectionMenu] = useState(false);
  /** Toggle Balances across layers card under ETH wallet header */
  const [showEthLayersCard, setShowEthLayersCard] = useState(true);
  const ethSectionMenuRef = useRef(null);
  /** Local Get wWETH burn amount */
  const [burnWethAmt, setBurnWethAmt] = useState('');
  const [mintWethAmt, setMintWethAmt] = useState('');
  /** Warthog session (mnemonic) for ETH bridge sub-wallet derivation */
  const [wartSession, setWartSession] = useState(null);
  /** true if UI is showing cached claims because inspect was empty */
  const [vaultFromCache, setVaultFromCache] = useState(false);
  /** Live MetaMask ERC-20 wWART balance (human units string) */
  const [mmWwartBal, setMmWwartBal] = useState(null);
  /**
   * L1 register_address status for this MetaMask owner.
   * null = unknown / loading, true = registered, false = not yet.
   */
  const [l1Registered, setL1Registered] = useState(null);

  const l1RegStorageKey = (addr) =>
    `cartesiL1Registered:${String(addr || '')
      .replace(/^0x/i, '')
      .toLowerCase()}`;

  const readLocalL1Registered = (addr) => {
    if (typeof localStorage === 'undefined' || !addr) return false;
    try {
      return localStorage.getItem(l1RegStorageKey(addr)) === '1';
    } catch {
      return false;
    }
  };

  const writeLocalL1Registered = (addr, yes) => {
    if (typeof localStorage === 'undefined' || !addr) return;
    try {
      if (yes) localStorage.setItem(l1RegStorageKey(addr), '1');
      else localStorage.removeItem(l1RegStorageKey(addr));
    } catch {
      /* */
    }
  };

  /** Scan GraphQL notices for address_registered matching this L1 owner. */
  const checkRegisteredFromNotices = async (addr) => {
    const bare = String(addr || '')
      .replace(/^0x/i, '')
      .toLowerCase();
    if (bare.length !== 40) return false;
    try {
      const gql = getRollupGraphqlUrl();
      const res = await fetch(gql, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `{ notices(last: 200) { edges { node { payload } } } }`,
        }),
        cache: 'no-store',
      });
      if (!res.ok) return false;
      const data = await res.json();
      const edges = data?.data?.notices?.edges || [];
      for (const e of edges) {
        const raw = e?.node?.payload;
        if (!raw) continue;
        let n = null;
        try {
          if (typeof raw === 'object') n = raw;
          else {
            const s = String(raw);
            if (s.trim().startsWith('{')) n = JSON.parse(s);
            else {
              const hex = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
              if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
                n = JSON.parse(toUtf8String('0x' + hex));
              }
            }
          }
        } catch {
          continue;
        }
        if (n?.type !== 'address_registered') continue;
        const u = String(n.user || '')
          .replace(/^0x/i, '')
          .toLowerCase();
        if (u === bare || u === `0x${bare}`) return true;
      }
    } catch {
      /* */
    }
    return false;
  };

  /** Resolve registered flag from inspect / notices / local optimistic cache. */
  const resolveL1Registered = async (addr, inspectJson = null) => {
    if (!addr) {
      setL1Registered(null);
      return false;
    }
    if (inspectJson?.registered === true) {
      setL1Registered(true);
      writeLocalL1Registered(addr, true);
      return true;
    }
    if (inspectJson?.registered === false) {
      // Live dApp says no — clear stale optimistic cache unless notices say yes
      const fromNotices = await checkRegisteredFromNotices(addr);
      if (fromNotices) {
        setL1Registered(true);
        writeLocalL1Registered(addr, true);
        return true;
      }
      setL1Registered(false);
      writeLocalL1Registered(addr, false);
      return false;
    }
    // Older dApp without registered field: notices + local
    const fromNotices = await checkRegisteredFromNotices(addr);
    if (fromNotices) {
      setL1Registered(true);
      writeLocalL1Registered(addr, true);
      return true;
    }
    if (readLocalL1Registered(addr)) {
      setL1Registered(true);
      return true;
    }
    setL1Registered(false);
    return false;
  };

  /** Instant paint from localStorage (may be stale). */
  const hydrateVaultFromCache = (addr) => {
    const cached = loadVaultCache(addr);
    if (!cached?.vault || !vaultHasShareState(cached.vault)) return false;
    setVault((prev) => ({ ...prev, ...cached.vault }));
    if (cached.spoofed) setSpoofedWwart((prev) => ({ ...prev, ...cached.spoofed }));
    setVaultFromCache(true);
    return true;
  };

  /**
   * Prefer server notice indexer over localStorage for liquid-tab claims.
   * Cache paints first (no flash), then API overwrites when it has data.
   */
  const hydrateVaultPreferApi = async (addr) => {
    hydrateVaultFromCache(addr);
    try {
      const fromApi = await fetchClaimsFromApi(addr);
      if (fromApi && vaultHasShareState(fromApi)) {
        setVault((prev) => ({
          ...prev,
          liquid: fromApi.liquid,
          l1WwartClaim: fromApi.l1WwartClaim,
          wwartPortable: fromApi.wwartPortable ?? fromApi.l1WwartClaim,
          outstandingE8: fromApi.outstandingE8,
          totalSpoofedMinted: fromApi.totalSpoofedMinted,
          totalSpoofedBurned: fromApi.totalSpoofedBurned,
          mintCapacity18: fromApi.mintCapacity18,
          mintClaimed18: fromApi.mintClaimed18,
          mintRemaining18: fromApi.mintRemaining18,
        }));
        setSpoofedWwart((prev) => ({
          ...prev,
          total: fromApi.totalSpoofedMinted || prev.total,
          totalBurned: fromApi.totalSpoofedBurned || prev.totalBurned,
        }));
        setVaultFromCache(true);
        saveVaultCache(addr, { ...(loadVaultCache(addr)?.vault || {}), ...fromApi });
        return true;
      }
    } catch (e) {
      console.warn('[hydrateVaultPreferApi]', e?.message || e);
    }
    return false;
  };

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
          await hydrateVaultPreferApi(addr);
          toast.success(`Auto-connected: ${addr.slice(0,6)}...${addr.slice(-4)}`);
          refreshVault(addr);
        }
      } catch (err) {
        console.log("No auto-connect");
      }
    };
    tryAutoConnect();

    const eth = window.ethereum;
    if (!eth?.on) return undefined;

    const onAccountsChanged = async (accounts) => {
      if (!accounts || accounts.length === 0) {
        clearLocalSession({ wipeCache: false });
        toast('MetaMask disconnected');
        return;
      }
      try {
        const prov = new ethers.BrowserProvider(eth);
        const sign = await prov.getSigner();
        const addr = await sign.getAddress();
        setProvider(prov);
        setSigner(sign);
        setAddress(addr);
        setConnected(true);
        hydrateVaultPreferApi(addr);
        refreshVault(addr);
        refreshMmWwart(addr);
        toast.success(`Account: ${addr.slice(0, 6)}…${addr.slice(-4)}`);
      } catch (e) {
        console.warn('[accountsChanged]', e);
      }
    };

    const onChainChanged = () => {
      // MetaMask recommends full reload; soft re-bind is enough for Anvil demo
      tryAutoConnect();
    };

    eth.on('accountsChanged', onAccountsChanged);
    eth.on('chainChanged', onChainChanged);
    return () => {
      eth.removeListener?.('accountsChanged', onAccountsChanged);
      eth.removeListener?.('chainChanged', onChainChanged);
    };
  }, []);

  const refreshMmWwart = async (addr) => {
    try {
      if (!WWART_ADDRESS || !window.ethereum || !addr) {
        setMmWwartBal(null);
        return;
      }
      const browser = new ethers.BrowserProvider(window.ethereum);
      const token = new ethers.Contract(
        WWART_ADDRESS,
        ['function balanceOf(address) view returns (uint256)'],
        browser,
      );
      const bal = await token.balanceOf(addr);
      setMmWwartBal(ethers.formatUnits(bal, 18));
    } catch {
      /* MetaMask not ready / wrong chain */
    }
  };

  const refreshMainEth = async (addr) => {
    try {
      if (!window.ethereum || !addr) {
        setMainEthBal(null);
        return;
      }
      const browser = new ethers.BrowserProvider(window.ethereum);
      const bal = await browser.getBalance(addr);
      setMainEthBal(ethers.formatEther(bal));
    } catch {
      setMainEthBal(null);
    }
  };

  useEffect(() => {
    if (connected && address) {
      hydrateVaultPreferApi(address);
      refreshVault(address);
      refreshMmWwart(address);
      refreshMainEth(address);
      const interval = setInterval(() => {
        refreshVault(address);
        refreshMmWwart(address);
        refreshMainEth(address);
      }, 12000);
      return () => clearInterval(interval);
    }
  }, [connected, address]);

  // Persist capacity/claims whenever they change (leave-and-return safe)
  useEffect(() => {
    if (!address || !vaultHasShareState(vault)) return;
    saveVaultCache(address, vault, spoofedWwart);
  }, [
    address,
    vault.liquid,
    vault.l1WwartClaim,
    vault.wwartPortable,
    vault.outstandingE8,
    vault.mintCapacity18,
    vault.mintClaimed18,
    vault.mintRemaining18,
    spoofedWwart.total,
    spoofedWwart.totalBurned,
  ]);

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

  /**
   * EIP-3085: add/switch the active Cartesi L1 network in MetaMask
   * (same idea as wallet_watchAsset for the token).
   * @param {{ silent?: boolean }} opts — silent: no toast on soft failures (connect path)
   */
  const ensureCartesiNetwork = async (opts = {}) => {
    const silent = !!opts.silent;
    if (!window.ethereum) {
      if (!silent) toast.error('Please install MetaMask!');
      throw new Error('MetaMask not found');
    }
    const net = getNetwork() || ACTIVE_NETWORK;
    const chainIdHex =
      net.chainIdHex ||
      (net.chainId != null ? `0x${Number(net.chainId).toString(16)}` : '0x7a69');
    const chainName = net.label || 'Cartesi Local';
    const rpcUrls = [net.rpcUrl || RPC_URL].filter(Boolean);
    const nativeCurrency = net.nativeCurrency || {
      name: 'ETH',
      symbol: 'ETH',
      decimals: 18,
    };
    const params = {
      chainId: chainIdHex,
      chainName,
      rpcUrls,
      nativeCurrency,
    };
    try {
      // Prefer switch if already added
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: chainIdHex }],
      });
      if (!silent) toast.success(`Switched to ${chainName}`);
      return true;
    } catch (switchErr) {
      // 4902 = chain not in wallet → add it
      const code = switchErr?.code ?? switchErr?.data?.originalError?.code;
      if (code === 4902 || /unrecognized chain|unknown chain/i.test(String(switchErr?.message || ''))) {
        try {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [params],
          });
          if (!silent) toast.success(`${chainName} added to MetaMask`);
          return true;
        } catch (addErr) {
          if (!silent) {
            toast.error(
              `Could not add network: ${addErr?.message || addErr}. RPC: ${rpcUrls[0] || '—'}`,
              { duration: 7000 },
            );
          }
          throw addErr;
        }
      }
      // User rejected switch, or already on a different chain and cancelled
      if (code === 4001) {
        if (!silent) toast('Network switch cancelled');
        return false;
      }
      // Fallback: try add anyway (some wallets only implement add)
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [params],
        });
        if (!silent) toast.success(`${chainName} added to MetaMask`);
        return true;
      } catch (addErr) {
        if (!silent) {
          toast.error(`Network prompt failed: ${addErr?.message || addErr}`, {
            duration: 6000,
          });
        }
        throw addErr;
      }
    }
  };

  /** Reset React connection state (always local; MetaMask has no full logout API). */
  const clearLocalSession = (opts = {}) => {
    const wipeCache = !!opts.wipeCache;
    const prev = address;
    if (wipeCache && prev) {
      try {
        clearVaultCache(prev);
      } catch {
        /* ignore */
      }
    }
    setProvider(null);
    setSigner(null);
    setAddress('');
    setConnected(false);
    setVaultFromCache(false);
    setMmWwartBal(null);
    setL1Registered(null);
    setVault({
      liquid: '0',
      wWART: '0',
      CTSI: '0',
      eth: '0',
      usdc: '0',
    });
    setSpoofedWwart({ history: [], burnHistory: [], total: '0', totalBurned: '0' });
    setL1Tab('overview');
    setBurnWethAmt('');
    setMintWethAmt('');
    setWithdrawWwartAmt('');
    setWwartDepositAmt('');
  };

  // Close ETH section menu on outside click / Escape
  useEffect(() => {
    if (!showEthSectionMenu) return undefined;
    const onDoc = (e) => {
      if (
        ethSectionMenuRef.current &&
        !ethSectionMenuRef.current.contains(e.target)
      ) {
        setShowEthSectionMenu(false);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setShowEthSectionMenu(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [showEthSectionMenu]);

  /**
   * Disconnect: leave the site session. Tries MetaMask wallet_revokePermissions
   * so eth_accounts is empty (stops auto-reconnect on refresh).
   */
  const disconnectWallet = async () => {
    try {
      if (window.ethereum?.request) {
        try {
          await window.ethereum.request({
            method: 'wallet_revokePermissions',
            params: [{ eth_accounts: {} }],
          });
        } catch (e) {
          // Older MetaMask / other wallets — local disconnect still works
          console.warn('[disconnect] revokePermissions unavailable', e?.message || e);
        }
      }
    } finally {
      clearLocalSession({ wipeCache: false });
      toast.success('Disconnected MetaMask from this site');
    }
  };

  /**
   * Log out: disconnect + clear this address’s vault cache so a new tester
   * does not inherit ghost claims / balances from localStorage.
   */
  const logoutWallet = async () => {
    try {
      if (window.ethereum?.request) {
        try {
          await window.ethereum.request({
            method: 'wallet_revokePermissions',
            params: [{ eth_accounts: {} }],
          });
        } catch (e) {
          console.warn('[logout] revokePermissions unavailable', e?.message || e);
        }
      }
    } finally {
      clearLocalSession({ wipeCache: true });
      toast.success('Logged out — site session and vault cache cleared');
    }
  };

  // FUNCTIONS FROM ORIGINAL WalletIsland
  const connect = async () => {
    if (!window.ethereum) {
      toast.error("Please install MetaMask!");
      return;
    }

    try {
      try {
        await ensureCartesiNetwork({ silent: true });
      } catch {
        /* still allow connect if user is already on a usable chain */
      }

      await window.ethereum.request({ method: 'eth_requestAccounts' });
      const prov = new ethers.BrowserProvider(window.ethereum);
      const sign = await prov.getSigner();
      const addr = await sign.getAddress();

      setProvider(prov);
      setSigner(sign);
      setAddress(addr);
      setConnected(true);
      setL1Registered(null);
      hydrateVaultFromCache(addr);
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
      let json = null;
      try {
        const res = await fetch(`${base}/vault/${hex}`, { cache: 'no-store' });
        const data = await res.json();
        if (data.reports?.length > 0) {
          json = decodeInspectPayload(data.reports[0].payload);
          if (json?.error) json = null;
        }
      } catch (e) {
        console.warn('[refreshVault] inspect fetch failed', e?.message || e);
      }

      // Capacity claims (WLIQ / wWART) are always merged from notice indexer when
      // inspect is present: a buggy withdraw once zeroed l1WwartClaim while
      // outstandingE8 stayed > 0, so "inspect has capacity" must not skip notices.
      //   1) server notice indexer  GET /api/claims/:owner
      //   2) browser GraphQL notice sum (legacy)
      //   3) localStorage cache (last resort)
      let fromApi = null;
      let fromNotices = null;
      try {
        fromApi = await fetchClaimsFromApi(hex);
      } catch {
        /* */
      }
      if (!fromApi) {
        try {
          fromNotices = await claimsFromGraphQLNotices(getRollupGraphqlUrl(), hex);
        } catch {
          /* */
        }
      }

      // Unified "rollup history" source: API indexer wins over browser GraphQL
      const fromIndex = fromApi || fromNotices;

      const cached = loadVaultCache(addr);

      if (!json && !fromIndex) {
        // Keep cache if we have it; do not wipe to zeros
        if (cached?.vault && vaultHasShareState(cached.vault)) {
          setVault((prev) => ({ ...prev, ...cached.vault }));
          setVaultFromCache(true);
          console.warn('[refreshVault] inspect empty — keeping local cache');
        }
        // Still resolve L1 registration (notices / local) even if vault balances empty
        await resolveL1Registered(addr, json);
        return;
      }

      // Track L1 register_address status for the Register button label
      await resolveL1Registered(addr, json);

      const totalMinted = String(
        json?.totalSpoofedMinted || fromIndex?.totalSpoofedMinted || '0',
      );
      const totalBurned = String(
        json?.totalSpoofedBurned || fromIndex?.totalSpoofedBurned || '0',
      );
      setSpoofedWwart({
        history: json?.spoofedMintHistory || [],
        burnHistory: json?.spoofedBurnHistory || [],
        total: totalMinted,
        totalBurned,
      });

      let outstandingE8 = json?.outstandingE8 ?? fromIndex?.outstandingE8;
      if (outstandingE8 == null) {
        try {
          const m = BigInt(totalMinted || 0);
          const b = BigInt(totalBurned || 0);
          outstandingE8 = (m > b ? m - b : 0n).toString();
        } catch {
          outstandingE8 = '0';
        }
      }

      const asBig = (v) => {
        try {
          return BigInt(v ?? 0);
        } catch {
          return 0n;
        }
      };

      /**
       * Fresh-stack / wipe detection: live inspect + notice index both empty.
       * Do NOT max() with localStorage in that case — stale browser cache was
       * keeping ghost claims (e.g. "32 wWART") after Anvil/indexer reset.
       */
      const liveRollupEmpty =
        !!json &&
        asBig(json.mintCapacity18) === 0n &&
        asBig(json.l1WwartClaim) === 0n &&
        asBig(json.liquid) === 0n &&
        asBig(json.outstandingE8) === 0n &&
        asBig(json.wwartPortable) === 0n &&
        asBig(fromIndex?.l1WwartClaim) === 0n &&
        asBig(fromIndex?.liquid) === 0n &&
        asBig(fromIndex?.mintCapacity18) === 0n &&
        asBig(fromIndex?.wwartPortable) === 0n;

      if (liveRollupEmpty && cached?.vault && vaultHasShareState(cached.vault)) {
        clearVaultCache(addr);
        console.info(
          '[refreshVault] live rollup empty — cleared stale local vault cache',
        );
      }

      /**
       * Capacity-consuming claims (liquid / l1WwartClaim):
       * max(inspect, notice index) only.
       * Do NOT max with localStorage — optimistic mint + delayed refresh used to
       * permanently double (inspect=3, cache=6 after race → Used 6).
       * Cache is last resort only when both live sources are missing/empty.
       */
      const pickCapacityClaim = (key) => {
        const a = asBig(json?.[key]);
        const b = asBig(fromIndex?.[key]);
        const liveBest = a > b ? a : b;
        const hasLive =
          (json && json[key] != null && json[key] !== '') ||
          (fromIndex && fromIndex[key] != null && fromIndex[key] !== '');
        if (hasLive || liveBest > 0n) {
          return liveBest.toString();
        }
        if (!liveRollupEmpty && cached?.vault?.[key] != null && cached.vault[key] !== '') {
          return String(cached.vault[key]);
        }
        return '0';
      };

      /**
       * Withdrawable portable: inspect is source of truth when present
       * (withdraw reduces portable without freeing capacity).
       */
      const pickPortable = () => {
        if (json && json.wwartPortable != null && json.wwartPortable !== '') {
          return String(json.wwartPortable);
        }
        if (fromIndex?.wwartPortable != null) return String(fromIndex.wwartPortable);
        if (!liveRollupEmpty && cached?.vault?.wwartPortable != null) {
          return String(cached.vault.wwartPortable);
        }
        // Fall back to claim only when we have no inspect portable field
        return pickCapacityClaim('l1WwartClaim');
      };

      const cacheCap = liveRollupEmpty ? undefined : cached?.vault;

      const nextVault = {
        ...(json || {}),
        outstandingE8: String(outstandingE8),
        liquid: pickCapacityClaim('liquid'),
        l1WwartClaim: pickCapacityClaim('l1WwartClaim'),
        wwartPortable: pickPortable(),
        // Pass through open/filled/burnable when inspect provides them
        wwartOpenClaim:
          json?.wwartOpenClaim != null ? String(json.wwartOpenClaim) : undefined,
        wwartFilledClaim:
          json?.wwartFilledClaim != null ? String(json.wwartFilledClaim) : undefined,
        wwartBurnable:
          json?.wwartBurnable != null ? String(json.wwartBurnable) : undefined,
        mintCapacity18:
          json?.mintCapacity18 != null
            ? String(json.mintCapacity18)
            : fromIndex?.mintCapacity18 != null
              ? String(fromIndex.mintCapacity18)
              : cacheCap?.mintCapacity18 ?? undefined,
        mintClaimed18:
          json?.mintClaimed18 != null
            ? String(json.mintClaimed18)
            : fromIndex?.mintClaimed18 != null
              ? String(fromIndex.mintClaimed18)
              : cacheCap?.mintClaimed18 ?? undefined,
        mintRemaining18:
          json?.mintRemaining18 != null
            ? String(json.mintRemaining18)
            : fromIndex?.mintRemaining18 != null
              ? String(fromIndex.mintRemaining18)
              : cacheCap?.mintRemaining18 ?? undefined,
        CTSI: String(json?.CTSI ?? cacheCap?.CTSI ?? '0'),
        usdc: String(json?.usdc ?? cacheCap?.usdc ?? '0'),
        eth: String(json?.eth ?? cacheCap?.eth ?? '0'),
        wWART: String(json?.wWART ?? cacheCap?.wWART ?? '0'),
      };

      // Always recompute remaining from capacity + merged claims (authoritative UI)
      try {
        const cap = asBig(nextVault.mintCapacity18);
        const claimed =
          asBig(nextVault.liquid) + asBig(nextVault.l1WwartClaim);
        if (cap > 0n || claimed > 0n) {
          nextVault.mintClaimed18 = claimed.toString();
          if (nextVault.mintCapacity18 != null || cap > 0n) {
            if (nextVault.mintCapacity18 == null && cap > 0n) {
              nextVault.mintCapacity18 = cap.toString();
            }
            nextVault.mintRemaining18 = (cap > claimed ? cap - claimed : 0n).toString();
          }
        }
      } catch {
        /* */
      }

      // Live inspect/index wins — overwrite any optimistic / stale localStorage inflation.
      setVault((prev) => ({ ...prev, ...nextVault }));
      const inspectShareClaims =
        json &&
        (asBig(json.l1WwartClaim) > 0n || asBig(json.liquid) > 0n);
      const usedIndexFallback = !inspectShareClaims && !!fromIndex;
      setVaultFromCache(
        usedIndexFallback ||
          (!inspectShareClaims && !fromIndex && vaultHasShareState(nextVault)),
      );
      saveVaultCache(addr, nextVault, {
        history: json?.spoofedMintHistory || [],
        burnHistory: json?.spoofedBurnHistory || [],
        total: totalMinted,
        totalBurned,
      });
    } catch (err) {
      console.log('Vault not ready yet', err?.message || err);
      // Keep whatever we have (cache / optimistic)
    } finally {
      setLoading(false);
    }
  };

  const send = async (payload, { successMessage = null, skipConfirm = false } = {}) => {
    if (!signer) {
      toast.error("Wallet not connected!");
      throw new Error("Wallet not connected!");
    }
    try {
      if (!skipConfirm) {
        const desc = describeRollupInput(payload, { dappAddress: DAPP_ADDRESS });
        const ok = await confirmMmTx(desc);
        if (!ok) {
          toast('Cancelled — nothing sent to MetaMask');
          throw new Error('User rejected transaction preview');
        }
      }
      setLoading(true);
      // UTF-8 JSON bytes — MetaMask may offer a UTF-8 view of the `input` param
      const message = JSON.stringify(payload);
      const payloadBytes = new TextEncoder().encode(message);
      const inputBox = new ethers.Contract(INPUT_BOX_ADDRESS, INPUT_BOX_ABI, signer);
      const tx = await inputBox.addInput(DAPP_ADDRESS, payloadBytes, { gasLimit: 200000 });
      const receipt = await tx.wait();
      // ethers-v6: receipt.hash (v5 used transactionHash)
      const txHash = receipt?.hash || receipt?.transactionHash || tx?.hash || '';
      if (successMessage) {
        toast.success(successMessage);
      } else {
        toast.success(txHash ? `Sent! Tx: ${String(txHash).slice(0, 10)}…` : 'Sent to rollup InputBox');
      }
      setTimeout(() => refreshVault(address), 8000);
      return receipt;
    } catch (err) {
      const msg = err?.message || String(err);
      if (/user rejected|cancelled|canceled/i.test(msg)) {
        // already toasted or silent cancel
        if (!/preview/i.test(msg)) toast.error(`Failed: ${msg}`);
      } else {
        toast.error(`Failed: ${msg}`);
      }
      console.error(err);
      throw err; // Re-throw to propagate to callers
    } finally {
      setLoading(false);
    }
  };

  /**
   * Register this MetaMask address with the Cartesi dApp (vault owner).
   * If already registered, show that and skip a redundant InputBox tx when we know.
   */
  const registerL1Address = async () => {
    if (!address || !signer) {
      toast.error('Connect MetaMask first');
      return;
    }
    if (rollupOnline === false) {
      toast.error('Rollup offline — cannot register right now');
      return;
    }

    // Fresh check (inspect / notices / local)
    let already = l1Registered === true;
    if (!already) {
      try {
        already = await resolveL1Registered(address);
      } catch {
        already = readLocalL1Registered(address);
      }
    }

    if (already) {
      setL1Registered(true);
      toast.success('Already registered', {
        duration: 4000,
        icon: '✓',
      });
      return;
    }

    try {
      await send(
        { type: 'register_address' },
        { successMessage: 'L1 address registered with the rollup' },
      );
      setL1Registered(true);
      writeLocalL1Registered(address, true);
      // Re-check after rollup processes the input
      setTimeout(() => {
        resolveL1Registered(address).catch(() => {});
      }, 10000);
    } catch {
      /* send() already toasted */
    }
  };

  const registerL1ButtonLabel =
    l1Registered === true
      ? 'Already registered'
      : l1Registered === null
        ? 'Register L1 address…'
        : 'Register L1 address';

  const depositEth = async () => {
    if (!ethDepositAmt || !signer) return;
    try {
      const amountWei = ethers.parseEther(ethDepositAmt);
      const ok = await confirmMmTx(
        describePortalDeposit({
          kind: 'eth',
          amount: amountWei,
          amountHuman: ethDepositAmt,
          dappAddress: DAPP_ADDRESS,
          portalAddress: ETHER_PORTAL_ADDRESS,
        }),
      );
      if (!ok) {
        toast('Cancelled — nothing sent to MetaMask');
        return;
      }
      setLoading(true);
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
    if (!withdrawEthAmt || loading) return Promise.resolve();
    return send({ type: "withdraw_eth", amount: withdrawEthAmt }).then(() => {
      setWithdrawEthAmt('');
      toast.success('ETH withdraw sent — open Vouchers tab to Execute on L1 when proof is ready.');
    });
  };

  const withdrawWwart = () => {
    if (!withdrawWwartAmt || loading) return Promise.resolve();
    return send({ type: "withdraw_wwart", amount: withdrawWwartAmt }).then(() => {
      setWithdrawWwartAmt('');
      toast.success(
        'wWART withdraw sent — open Vouchers tab → Execute on L1 (portable = mint voucher; portal deposit = transfer voucher).',
        { duration: 8000 },
      );
    });
  };

  const withdrawCtsi = () => {
    if (!withdrawCtsiAmt || loading) return Promise.resolve();
    return send({ type: "withdraw_ctsi", amount: withdrawCtsiAmt }).then(() => {
      setWithdrawCtsiAmt('');
      toast.success('CTSI withdraw sent — open Vouchers tab to Execute on L1.');
    });
  };

  const withdrawUsdc = () => {
    if (!withdrawUsdcAmt || loading) return Promise.resolve();
    return send({ type: "withdraw_usdc", amount: withdrawUsdcAmt }).then(() => {
      setWithdrawUsdcAmt('');
      toast.success('USDC withdraw sent — open Vouchers tab to Execute on L1.');
    });
  };

  const depositErc20 = async (tokenAddress, amountStr, decimals, opts = {}) => {
    if (!amountStr || !signer) return;
    try {
      const amount = ethers.parseUnits(amountStr, decimals);
      const tokenSym =
        opts.tokenSymbol ||
        (String(tokenAddress).toLowerCase() === String(WWART_ADDRESS).toLowerCase()
          ? 'wWART'
          : String(tokenAddress).toLowerCase() === String(CTSI_ADDRESS).toLowerCase()
            ? 'CTSI'
            : String(tokenAddress).toLowerCase() === String(USDC_ADDRESS).toLowerCase()
              ? 'USDC'
              : 'ERC-20');

      const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
      // ethers-v6 returns bigint — never use BigNumber .lt()
      const allowance = await token.allowance(address, ERC20_PORTAL_ADDRESS);
      if (allowance < amount) {
        const okApprove = await confirmMmTx(
          describeErc20Approve({
            tokenSymbol: tokenSym,
            tokenAddress,
            spender: ERC20_PORTAL_ADDRESS,
            amount,
            amountHuman: amountStr,
          }),
        );
        if (!okApprove) {
          toast('Cancelled — nothing sent to MetaMask');
          return;
        }
        setLoading(true);
        const txApprove = await token.approve(ERC20_PORTAL_ADDRESS, amount, { gasLimit: 100000 });
        await txApprove.wait();
        toast.success('Approved!');
        setLoading(false);
      }

      const okDeposit = await confirmMmTx(
        describePortalDeposit({
          kind: 'erc20',
          tokenSymbol: tokenSym,
          tokenAddress,
          amount,
          amountHuman: amountStr,
          dappAddress: DAPP_ADDRESS,
          portalAddress: ERC20_PORTAL_ADDRESS,
        }),
      );
      if (!okDeposit) {
        toast('Cancelled — nothing sent to MetaMask');
        return;
      }

      setLoading(true);
      const portal = new ethers.Contract(ERC20_PORTAL_ADDRESS, ERC20_PORTAL_ABI, signer);
      const tx = await portal.depositERC20Tokens(tokenAddress, DAPP_ADDRESS, amount, "0x", { gasLimit: 200000 });
      await tx.wait();
      if (!opts.silentSuccess) toast.success('Deposited!');
      setTimeout(() => refreshVault(address), 8000);
    } catch (err) {
      toast.error(`Failed: ${err.message || err}`);
      console.error(err);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  /** Open faucet disabled — capacity-limited mint is Warthog liquid tab → wWART. */
  const faucetMintWwart = async () => {
    toast.error(
      'Free faucet disabled. Mint wWART from Warthog → liquid tab (shared capacity with WLIQ; requires locked WART).',
      { duration: 7000 },
    );
  };

  const depositWwart = () => {
    if (!WWART_ADDRESS) {
      toast.error('wWART token not configured for this network yet');
      return Promise.reject(new Error('no wwart'));
    }
    // Success toast is owned by the Deposit card (explains Used unchanged).
    return depositErc20(WWART_ADDRESS, wwartDepositAmt, 18, { silentSuccess: true }).then(() =>
      setWwartDepositAmt(''),
    );
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
  // Portable wWART claims (mint_wwart) are 18-dec; do not mix with spoofed E8 in wWART field
  const wwartClaim = format(vault.l1WwartClaim || vault.wwartPortable || '0', 18);
  // Withdrawable = portable (open claims) + portal deposits (MetaMask → rollup). Deposit ≠ portable.
  const wwartPortableWei = (() => {
    try {
      return BigInt(vault?.wwartPortable || '0');
    } catch {
      return 0n;
    }
  })();
  const wwartPortalWei = portalWwart18(vault);
  const wwartWithdrawableWei = wwartWithdrawable18(vault);
  const CTSI = format(vault.CTSI, 18);
  const eth = Number(vault.eth || 0);
  const usdc = format(vault.usdc, 6);
  // Shared mint capacity (WLIQ + wWART) — same math as Warthog liquid tab
  const mintCap = computeWliqMintAvailable(vault);
  const capacityUsedLabel = (() => {
    try {
      const used = mintCap.liquid18 + mintCap.claim18;
      return formatUnits18(used, 4);
    } catch {
      return '0';
    }
  })();
  // Backing display: locked spoofed outstanding (E8) as human WART
  const lockedWart = (() => {
    try {
      return Number(BigInt(vault.outstandingE8 || '0')) / 1e8;
    } catch {
      return 0;
    }
  })();

  const totalBacking = lockedWart + CTSI + eth + usdc;
  const wwartPct = totalBacking > 0 ? (lockedWart / totalBacking * 100).toFixed(1) : 0;
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

  /** ETH wallet section menu — same shape as Warthog APP_TABS dropdown */
  const ETH_TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'subwallets', label: 'Sub wallets' },
    { id: 'vault', label: 'Vaults' },
    { id: 'getwweth', label: 'Get wWETH' },
  ];

  const ethCapSummary = (() => {
    const human = (weiStr) => {
      try {
        return ethers.formatEther(BigInt(String(weiStr || '0')));
      } catch {
        return '0';
      }
    };
    const pretty = (h) => {
      const n = Number(h);
      if (!Number.isFinite(n)) return String(h);
      return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
    };
    const capacityH = human(vault?.ethCapacity18);
    const usedH = human(vault?.ethClaimed18);
    const availableH = human(vault?.ethRemaining18);
    const claimH = human(vault?.l1WethClaim);
    const portableH = human(vault?.wethPortable);
    return {
      capacity: pretty(capacityH),
      used: pretty(usedH),
      available: pretty(availableH),
      claim: pretty(claimH),
      portable: pretty(portableH),
      capacityRaw: capacityH,
      usedRaw: usedH,
      availableRaw: availableH,
      claimRaw: claimH,
      portableRaw: portableH,
    };
  })();

  const mintWethClaim = async () => {
    const amt = String(mintWethAmt || '').trim();
    if (!amt) return toast.error('Enter mint amount');
    try {
      setLoading(true);
      await send({ type: 'mint_weth_claim', amount: amt });
      toast.success(`Minted ${amt} wETH claim (rollup)`);
      setMintWethAmt('');
      setTimeout(() => refreshVault(address), 4000);
    } catch (e) {
      /* send toasts */
    } finally {
      setLoading(false);
    }
  };

  const burnWethClaim = async () => {
    const amt = String(burnWethAmt || '').trim();
    if (!amt) return toast.error('Enter burn amount');
    try {
      setLoading(true);
      await send({ type: 'burn_weth_claim', amount: amt });
      toast.success(`Burned ${amt} wETH claim — Available ↑`);
      setBurnWethAmt('');
      setTimeout(() => refreshVault(address), 4000);
    } catch (e) {
      /* send toasts */
    } finally {
      setLoading(false);
    }
  };

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
          <p className="wi-connect-lead">
            L1 MetaMask — required for vault multi-sig, lock/burn, and vouchers
          </p>
          <p className="wi-muted" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
            This is your Cartesi rollup owner address. Connect MetaMask first, then use{' '}
            <strong>Register L1 address</strong> once so the dApp knows this wallet.
          </p>
          <button type="button" onClick={connect} className="btn primary">
            <Wallet className="inline" size={18} style={{ marginRight: 8, verticalAlign: -3 }} />
            Connect MetaMask (L1)
          </button>
          {(getNetworkId() === 'anvil' || ACTIVE_NETWORK?.isDemo) && (
            <AnvilTestKeys rpcUrl={RPC_URL} compact />
          )}
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
          <p className="wi-muted">Preview only — connect MetaMask to load your L1 vault</p>
        </div>
      </div>
    );
  }

  return (
    <div className="wi-shell vault-section">
      <Toaster position="top-right" />
      {mmTxModal}

      {/* ── 1) Warthog first (primary bridge path) ── */}
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
          onSessionChange={setWartSession}
          onToggleShowWallet={() => setShowWarthog(false)}
          showWalletVisible
          capacityOverviewPanel={
            <div className="wi-panel" style={{ margin: 0, padding: 0, background: 'transparent', border: 0 }}>
              <div className="wi-stat-grid wi-stat-grid--focus">
                <div className="wi-stat wi-stat--liquid">
                  <Coins size={18} className="wi-stat-icon" />
                  <span className="wi-stat-k">Available</span>
                  <span className="wi-stat-v">{mintCap.available}</span>
                  <span className="wi-stat-hint">WART-backed mint headroom</span>
                </div>
                <div className="wi-stat">
                  <span className="wi-stat-k">Used</span>
                  <span className="wi-stat-v">{capacityUsedLabel}</span>
                  <span className="wi-stat-hint">
                    {SHARE_TOKEN.symbol} {mintCap.liquid} + wWART {mintCap.claim || '0'}
                  </span>
                </div>
                <div className="wi-stat">
                  <span className="wi-stat-k">Capacity</span>
                  <span className="wi-stat-v">{mintCap.capacity}</span>
                  <span className="wi-stat-hint">
                    locked WART only · {lockedWart.toFixed(4)} WART
                    {mintCap.hasLockedWart ? '' : ' · lock first'}
                  </span>
                </div>
                <div className="wi-stat wi-stat--spoof">
                  <span className="wi-stat-k">MetaMask wWART</span>
                  <span className="wi-stat-v">
                    {mmWwartBal != null
                      ? Number(mmWwartBal).toLocaleString(undefined, {
                          maximumFractionDigits: 4,
                        })
                      : '—'}
                  </span>
                  <span className="wi-stat-hint">L1 ERC-20 (after voucher)</span>
                </div>
              </div>
              <p className="wi-muted" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
                <strong>Capacity</strong> = locked WART only (ETH/CTSI/USDC portals are separate
                inventory — not mint headroom). <strong>Used</strong> = {SHARE_TOKEN.symbol} +
                wWART claims. <strong>Open</strong> claims can burn immediately;{' '}
                <strong>filled</strong> claims need deposit-back then burn.{' '}
                <strong>Release</strong> unlocks native collateral separately.
              </p>
              <ol className="wi-steps">
                <li>
                  <strong>Register L1</strong> — on the middle L1 · MetaMask card (once per MetaMask)
                </li>
                <li>
                  <strong>Bridge</strong> — fund sub, sweep → lock capacity
                </li>
                <li>
                  Mint wWART / {SHARE_TOKEN.symbol} (uses capacity) → optional{' '}
                  <button type="button" className="wi-linkish" data-goto="getwwart">
                    Get wWART
                  </button>{' '}
                  to MetaMask (claim becomes <em>filled</em>)
                </li>
                <li>
                  To free filled capacity: deposit MetaMask wWART (Get wWART tab) →{' '}
                  <strong>Burn wWART claims</strong>
                </li>
                <li>
                  Open (unfilled) claims: burn on Warthog Home without deposit
                </li>
                <li>
                  Optional: <strong>Release</strong> locked WART → Vault → main
                </li>
              </ol>
            </div>
          }
          getWwartPanel={
            <div className="wi-panel" style={{ margin: 0, padding: 0, background: 'transparent', border: 0 }}>
              <p className="wi-muted wi-claim-lead">
                Capacity used by wWART claim:{' '}
                <strong>
                  {wwartClaim.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                </strong>
                {' · '}
                Withdrawable:{' '}
                <strong>
                  {Number(formatUnits18(wwartWithdrawableWei)).toLocaleString(undefined, {
                    maximumFractionDigits: 6,
                  })}
                </strong>{' '}
                <span className="wi-muted">
                  (portable{' '}
                  {Number(formatUnits18(wwartPortableWei)).toLocaleString(undefined, {
                    maximumFractionDigits: 6,
                  })}
                  {' + '}
                  portal{' '}
                  {Number(formatUnits18(wwartPortalWei)).toLocaleString(undefined, {
                    maximumFractionDigits: 6,
                  })}
                  )
                </span>
                {' · '}
                Shared available: <strong>{mintCap.available}</strong>.
              </p>
              <p className="wi-muted" style={{ marginTop: '-0.25rem', marginBottom: '0.75rem' }}>
                Portable = mint claims not yet withdrawn. Portal = MetaMask deposits. Deposit
                does <strong>not</strong> free Used — burn does.
              </p>
              {WWART_ADDRESS ? (
                <>
                  <div className="wi-portal-card wi-portal-card--focus" style={{ marginBottom: '0.75rem' }}>
                    <div className="wi-portal-title">Withdraw wWART → L1</div>
                    <div className="wi-portal-row">
                      <input
                        className="input"
                        placeholder="Amount"
                        value={withdrawWwartAmt}
                        onChange={(e) => setWithdrawWwartAmt(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn secondary small"
                        disabled={loading || wwartWithdrawableWei <= 0n}
                        onClick={() => {
                          setWithdrawWwartAmt(formatUnits18Exact(wwartWithdrawableWei));
                        }}
                      >
                        Max
                      </button>
                      <button
                        type="button"
                        className="btn primary small"
                        disabled={loading || wwartWithdrawableWei <= 0n}
                        onClick={() => withdrawWwart()}
                      >
                        Withdraw
                      </button>
                    </div>
                  </div>
                  <div className="wi-portal-card wi-portal-card--focus" style={{ marginBottom: '0.75rem' }}>
                    <div className="wi-portal-title">Deposit wWART (MetaMask → rollup)</div>
                    <p className="wi-portal-note" style={{ marginBottom: '0.5rem' }}>
                      Credits <strong>portal inventory</strong> (not portable). Used / Available
                      unchanged until you <strong>Burn wWART claims</strong> on Home. Withdraw Max
                      includes portal + portable.
                    </p>
                    <div className="wi-portal-row">
                      <input
                        className="input wi-portal-input"
                        placeholder="Amount (e.g. 2)"
                        value={wwartDepositAmt}
                        onChange={(e) => setWwartDepositAmt(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn primary small"
                        disabled={loading || !wwartDepositAmt}
                        onClick={async () => {
                          try {
                            await depositWwart();
                            toast.success(
                              'Deposited — portal inventory up. Used free only after burn.',
                              { duration: 8000 },
                            );
                          } catch {
                            /* depositWwart toasts */
                          }
                          setTimeout(() => refreshVault(address), 10000);
                        }}
                      >
                        Deposit wWART
                      </button>
                    </div>
                    <p className="wi-portal-note">
                      Portal:{' '}
                      <strong>
                        {Number(formatUnits18(wwartPortalWei)).toLocaleString(undefined, {
                          maximumFractionDigits: 6,
                        })}
                      </strong>
                      {' · '}
                      Portable:{' '}
                      <strong>
                        {Number(formatUnits18(wwartPortableWei)).toLocaleString(undefined, {
                          maximumFractionDigits: 6,
                        })}
                      </strong>
                      {' · '}
                      Withdrawable:{' '}
                      <strong>
                        {Number(formatUnits18(wwartWithdrawableWei)).toLocaleString(undefined, {
                          maximumFractionDigits: 6,
                        })}
                      </strong>
                    </p>
                  </div>
                </>
              ) : (
                <p className="wi-muted">wWART token not configured.</p>
              )}
              <VoucherExecutor
                address={address}
                signer={signer}
                provider={provider}
                onlyMine
                compact
              />
            </div>
          }
          onOptimisticShareMint={({ kind, amountHuman, direction = 'mint' }) => {
            // Immediate UI delta. Callers should apply once (before send) and
            // reverse on failure. Do not apply again after send — refresh will
            // replace with live inspect/index (see pickCapacityClaim).
            try {
              const s = String(amountHuman || '0').trim();
              const [w, f = ''] = s.split('.');
              const frac = (f + '000000000000000000').slice(0, 18);
              let amt = BigInt(w || '0') * 10n ** 18n + BigInt(frac || '0');
              if (amt <= 0n) return;
              if (direction === 'burn') amt = -amt;
              setVault((prev) => {
                let liq = BigInt(prev.liquid || 0);
                let claim = BigInt(prev.l1WwartClaim || 0);
                let portable = BigInt(prev.wwartPortable || 0);
                const cap =
                  prev.mintCapacity18 != null ? BigInt(prev.mintCapacity18) : null;
                let next = { ...prev };
                if (kind === 'wwart') {
                  claim = claim + amt;
                  portable = portable + amt;
                  if (claim < 0n) claim = 0n;
                  if (portable < 0n) portable = 0n;
                  next.l1WwartClaim = claim.toString();
                  next.wwartPortable = portable.toString();
                } else {
                  liq = liq + amt;
                  if (liq < 0n) liq = 0n;
                  next.liquid = liq.toString();
                }
                const claimed =
                  BigInt(next.liquid || 0) + BigInt(next.l1WwartClaim || 0);
                next.mintClaimed18 = claimed.toString();
                if (cap != null) {
                  next.mintRemaining18 = (
                    cap > claimed ? cap - claimed : 0n
                  ).toString();
                  next.mintCapacity18 = cap.toString();
                }
                return next;
              });
            } catch (e) {
              console.warn('[onOptimisticShareMint]', e);
            }
          }}
        />
      )}

      {/* ── 2) Middle: L1 · MetaMask control card (original style — leave alone) ── */}
      <section className="wi-l1-block">
        <header className="wi-header">
          <div className="wi-header-main">
            <div className="wi-header-id">
              <span className="wi-header-label">L1 · MetaMask</span>
            </div>
            <div className="wi-header-connected" aria-label="Connected wallets">
              <button
                type="button"
                className="wi-address-chip wi-address-chip--eth"
                title={address ? `ETH L1 · ${address}` : 'ETH not connected'}
                onClick={() => {
                  if (!address) return;
                  navigator.clipboard?.writeText(address);
                  toast.success('ETH L1 address copied');
                }}
              >
                <span className="wi-addr-tag">ETH</span>
                {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '—'}
              </button>
              <button
                type="button"
                className={`wi-address-chip wi-address-chip--wart${
                  wartSession?.address ? '' : ' is-empty'
                }`}
                title={
                  wartSession?.address
                    ? `WART · ${wartSession.address}`
                    : 'Warthog wallet not unlocked'
                }
                onClick={() => {
                  if (!wartSession?.address) {
                    toast('Unlock Warthog wallet to connect WART address');
                    return;
                  }
                  navigator.clipboard?.writeText(wartSession.address);
                  toast.success('WART address copied');
                }}
              >
                <span className="wi-addr-tag">WART</span>
                {wartSession?.address
                  ? `${String(wartSession.address).slice(0, 6)}…${String(
                      wartSession.address,
                    ).slice(-4)}`
                  : 'not connected'}
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
                  ? 'Online'
                  : 'Offline'}
            </span>
          </div>
          <div className="wi-header-tools">
            <button
              type="button"
              className={`btn small ${l1Registered === true ? 'secondary' : 'primary'}`}
              title={
                l1Registered === true
                  ? 'This MetaMask address is already registered as rollup vault owner'
                  : 'Register this MetaMask address with the Cartesi dApp (owner / vault mapping)'
              }
              onClick={() => registerL1Address()}
              disabled={loading || rollupOnline === false}
            >
              {registerL1ButtonLabel}
            </button>
            <button
              type="button"
              className="btn primary small"
              onClick={() => {
                refreshVault(address);
                refreshMmWwart(address);
                refreshMainEth(address);
              }}
              disabled={loading}
            >
              <RefreshCw size={14} className="inline" style={{ marginRight: 4, verticalAlign: -2 }} />
              Refresh
            </button>
            <button
              type="button"
              className="btn small secondary"
              title={
                showWarthog
                  ? 'Hide Warthog wallet panel'
                  : 'Show Warthog wallet panel'
              }
              onClick={() => setShowWarthog((v) => !v)}
            >
              {showWarthog ? 'Hide WART wallet' : 'Show WART wallet'}
            </button>
            <button
              type="button"
              className="btn small secondary"
              title={
                showEthWallet
                  ? 'Hide ETH wallet panel'
                  : 'Show ETH wallet panel'
              }
              onClick={() => setShowEthWallet((v) => !v)}
            >
              {showEthWallet ? 'Hide ETH wallet' : 'Show ETH wallet'}
            </button>
            <button
              type="button"
              className="btn small secondary"
              title="Disconnect this site from MetaMask (keeps vault cache)"
              onClick={() => disconnectWallet()}
            >
              Disconnect
            </button>
            <button
              type="button"
              className="btn small wi-btn-logout"
              title="Disconnect and clear vault cache for this address"
              onClick={() => logoutWallet()}
            >
              Log out
            </button>
          </div>
          <div className="wi-l1-meta-actions" role="group" aria-label="MetaMask helpers">
            <button
              type="button"
              className="wi-token-copy"
              title={`Add or switch to ${ACTIVE_NETWORK?.label || 'Cartesi Local'} in MetaMask`}
              onClick={async () => {
                try {
                  await ensureCartesiNetwork();
                } catch {
                  /* toasts handled inside */
                }
              }}
            >
              Add network · {ACTIVE_NETWORK?.label || 'Cartesi Local'} (chain{' '}
              {ACTIVE_NETWORK?.chainId ?? 31337})
            </button>
            {WWART_ADDRESS ? (
              <button
                type="button"
                className="wi-token-copy"
                title={`Import ${LOCAL_WWART?.symbol || 'wWART'} into MetaMask`}
                onClick={async () => {
                  const addr = WWART_ADDRESS;
                  const symbol = LOCAL_WWART?.symbol || 'wWART';
                  const decimals = LOCAL_WWART?.decimals ?? 18;
                  try {
                    if (!window.ethereum) throw new Error('MetaMask not found');
                    const added = await window.ethereum.request({
                      method: 'wallet_watchAsset',
                      params: {
                        type: 'ERC20',
                        options: { address: addr, symbol, decimals },
                      },
                    });
                    if (added) toast.success(`${symbol} added to MetaMask`);
                    else {
                      await navigator.clipboard?.writeText(addr);
                      toast('Import cancelled — address copied', { duration: 4000 });
                    }
                  } catch (e) {
                    try {
                      await navigator.clipboard?.writeText(addr);
                      toast.error(
                        `Auto-import failed (${e?.message || e}). Address copied.`,
                        { duration: 7000 },
                      );
                    } catch {
                      toast.error(`Auto-import failed: ${e?.message || e}`);
                    }
                  }
                }}
              >
                Import token · {WWART_ADDRESS.slice(0, 8)}…{WWART_ADDRESS.slice(-6)}
              </button>
            ) : null}
          </div>
        </header>
      </section>

      {/* ── 3) ETH section: one card shell matching warthog-section ── */}
      {showEthWallet && (
      <section className="eth-section">
        <div className="eth-title-row">
          <h2>ETH Wallet</h2>
          <p className="eth-subtitle">L1 MetaMask · bridge vaults · multi-sig</p>
        </div>

        {/* Header mirrors Warthog wh-header: balance · section grid menu · tools */}
        <header className="eth-section-header">
          <div className="eth-section-header-main">
            <div className="eth-section-header-left">
              <div className="eth-balance-block">
                <span className="eth-balance-label">Main L1 ETH</span>
                <span className="eth-balance-value">
                  {mainEthBal != null
                    ? `${Number(mainEthBal).toLocaleString(undefined, {
                        maximumFractionDigits: 6,
                      })} ETH`
                    : '…'}
                </span>
                <span className="eth-balance-hint">MetaMask</span>
              </div>
            </div>
            <div className="eth-section-header-icons">
              {/* Section nav — grid icon (same role as Warthog wh-section-btn) */}
              <div className="eth-section-menu" ref={ethSectionMenuRef}>
                <button
                  type="button"
                  className={`eth-section-btn${showEthSectionMenu ? ' is-open' : ''}`}
                  aria-label="ETH sections"
                  aria-expanded={showEthSectionMenu}
                  aria-haspopup="menu"
                  title={`Section · ${ETH_TABS.find((t) => t.id === l1Tab)?.label || 'Overview'}`}
                  onClick={() => setShowEthSectionMenu((v) => !v)}
                >
                  <LayoutGrid size={16} strokeWidth={2.25} aria-hidden />
                </button>
                {showEthSectionMenu && (
                  <div className="eth-section-dropdown" role="menu" aria-label="ETH sections">
                    <div className="eth-section-menu-head">
                      <span className="eth-section-menu-title">Go to</span>
                      <span className="eth-section-current">
                        {ETH_TABS.find((t) => t.id === l1Tab)?.label || 'Overview'}
                      </span>
                    </div>
                    {ETH_TABS.map((tab) => {
                      const needsSeed =
                        tab.id === 'subwallets' || tab.id === 'vault';
                      const disabled = needsSeed && !wartSession?.mnemonic;
                      const active = l1Tab === tab.id;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          role="menuitem"
                          disabled={disabled}
                          className={`eth-section-item${active ? ' is-active' : ''}`}
                          title={
                            disabled
                              ? 'Unlock Warthog wallet first (seed required)'
                              : tab.id === 'overview'
                                ? 'ETH capacity Overview'
                                : tab.id === 'subwallets'
                                  ? 'ETH sub-wallets · fund & create vault'
                                  : tab.id === 'vault'
                                    ? 'ETH multi-sig vaults only'
                                    : tab.id === 'getwweth'
                                      ? 'Mint / burn wETH claims'
                                      : undefined
                          }
                          onClick={() => {
                            if (disabled) return;
                            setL1Tab(tab.id);
                            setShowEthSectionMenu(false);
                          }}
                        >
                          <span>{tab.label}</span>
                          {active ? (
                            <span className="eth-section-check" aria-hidden>
                              ✓
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="eth-section-btn"
                title="Refresh L1 vault + ETH balance"
                onClick={() => {
                  refreshVault(address);
                  refreshMmWwart(address);
                  refreshMainEth(address);
                }}
                disabled={loading}
              >
                <RefreshCw size={16} strokeWidth={2.25} aria-hidden />
              </button>
            </div>
          </div>
          <div className="eth-section-tools" role="group" aria-label="ETH wallet actions">
            <button
              type="button"
              className="btn primary small"
              onClick={() => {
                refreshVault(address);
                refreshMmWwart(address);
                refreshMainEth(address);
              }}
              disabled={loading}
            >
              Refresh
            </button>
          </div>
        </header>

        <div
          className={`sw-card sw-card--l1-track eth-layers-card${
            showEthLayersCard ? '' : ' is-collapsed'
          }`}
        >
          <div className="sw-card-head">
            <h4 className="sw-card-title">Balances across layers</h4>
            <div className="sw-card-head-right sw-layers-actions">
              <button
                type="button"
                className="sw-icon-btn"
                title="Refresh layer balances"
                aria-label="Refresh layer balances"
                onClick={() => {
                  refreshVault(address);
                  refreshMainEth(address);
                }}
                disabled={loading}
              >
                <RefreshCw size={14} strokeWidth={2.25} aria-hidden />
              </button>
              <button
                type="button"
                className="sw-icon-btn"
                title={
                  showEthLayersCard
                    ? 'Hide balances across layers'
                    : 'Show balances across layers'
                }
                aria-label={
                  showEthLayersCard
                    ? 'Hide balances across layers'
                    : 'Show balances across layers'
                }
                aria-expanded={showEthLayersCard}
                onClick={() => setShowEthLayersCard((v) => !v)}
              >
                {showEthLayersCard ? (
                  <EyeOff size={14} strokeWidth={2.25} aria-hidden />
                ) : (
                  <Eye size={14} strokeWidth={2.25} aria-hidden />
                )}
              </button>
            </div>
          </div>
          {showEthLayersCard && (
            <>
              <div className="sw-card-meta">
                <div className="sw-meta-row">
                  <span
                    className="sw-meta-k"
                    title="Native ETH in your connected MetaMask account"
                  >
                    Main L1 ETH
                  </span>
                  <span className="sw-meta-v">
                    {mainEthBal != null
                      ? `${Number(mainEthBal).toLocaleString(undefined, {
                          maximumFractionDigits: 6,
                        })} ETH`
                      : '—'}
                  </span>
                </div>
                <div className="sw-meta-row">
                  <span
                    className="sw-meta-k"
                    title="Locked vault ETH capacity (ETH pool only — not WART)"
                  >
                    ETH capacity
                  </span>
                  <span className="sw-meta-v">{ethCapSummary.capacity} ETH</span>
                </div>
                <div className="sw-meta-row">
                  <span
                    className="sw-meta-k"
                    title="wETH claims using ETH capacity"
                  >
                    ETH used (claims)
                  </span>
                  <span className="sw-meta-v">{ethCapSummary.used} ETH</span>
                </div>
                <div className="sw-meta-row">
                  <span className="sw-meta-k" title="Remaining ETH mint headroom">
                    ETH available
                  </span>
                  <span className="sw-meta-v">{ethCapSummary.available} ETH</span>
                </div>
                <div className="sw-meta-row">
                  <span
                    className="sw-meta-k"
                    title="Rollup wETH claim / portable inventory"
                  >
                    wETH claim
                  </span>
                  <span className="sw-meta-v">
                    {ethCapSummary.claim} · port {ethCapSummary.portable}
                  </span>
                </div>
                <div className="sw-meta-row">
                  <span
                    className="sw-meta-k"
                    title="ETH deposited via portal (inventory, not mint capacity)"
                  >
                    Rollup portal ETH
                  </span>
                  <span className="sw-meta-v">
                    {vault?.eth != null
                      ? `${Number(vault.eth).toLocaleString(undefined, {
                          maximumFractionDigits: 6,
                        })} ETH`
                      : '—'}
                  </span>
                </div>
              </div>
              <p className="wh-hint sw-l1-track-hint">
                <strong>Locked vault ETH</strong> is capacity (not WART).{' '}
                <strong>wETH claims</strong> are rollup-only until DeFi WETH. Portal ETH is
                inventory only.
              </p>
            </>
          )}
        </div>

        <div className="eth-section-bar" aria-live="polite">
          <span className="eth-section-bar-label">
            {ETH_TABS.find((t) => t.id === l1Tab)?.label || 'Overview'}
          </span>
        </div>

        {l1Tab === 'overview' && (
          <div className="wi-panel eth-overview-panel">
            {/* 2×2: Available | Used / Capacity | Main L1 ETH (same as Warthog Overview) */}
            <div className="wi-stat-grid wi-stat-grid--focus eth-overview-stats">
              <div className="wi-stat wi-stat--liquid">
                <Coins size={18} className="wi-stat-icon" />
                <span className="wi-stat-k">Available</span>
                <span className="wi-stat-v">{ethCapSummary.available}</span>
                <span className="wi-stat-hint">ETH-backed mint headroom</span>
              </div>
              <div className="wi-stat">
                <span className="wi-stat-k">Used</span>
                <span className="wi-stat-v">{ethCapSummary.used}</span>
                <span className="wi-stat-hint">wETH claims</span>
              </div>
              <div className="wi-stat">
                <span className="wi-stat-k">Capacity</span>
                <span className="wi-stat-v">{ethCapSummary.capacity}</span>
                <span className="wi-stat-hint">locked vault ETH only</span>
              </div>
              <div className="wi-stat wi-stat--spoof">
                <span className="wi-stat-k">Main L1 ETH</span>
                <span className="wi-stat-v">
                  {mainEthBal != null
                    ? Number(mainEthBal).toLocaleString(undefined, {
                        maximumFractionDigits: 6,
                      })
                    : '—'}
                </span>
                <span className="wi-stat-hint">MetaMask</span>
              </div>
            </div>
            <p className="wi-muted" style={{ marginTop: '0.65rem', marginBottom: 0 }}>
              <strong>Capacity</strong> = locked ETH in cosigner vaults (separate from WART
              capacity). <strong>Used</strong> = wETH claims. Mint / burn under{' '}
              <button
                type="button"
                className="wi-linkish"
                onClick={() => setL1Tab('getwweth')}
              >
                Get wWETH
              </button>
              . Fund &amp; lock via Sub wallets → Vaults.
            </p>
            <ol className="wi-steps">
              <li>
                <strong>Sub wallets</strong> — generate · fund main → sub · create vault
              </li>
              <li>
                <strong>Vaults</strong> — sub → vault · lock capacity · release · cosign
              </li>
              <li>
                <strong>Get wWETH</strong> — mint / burn rollup wETH claims (until DeFi WETH)
              </li>
            </ol>
            {(getNetworkId() === 'anvil' || ACTIVE_NETWORK?.isDemo) && (
              <AnvilTestKeys
                rpcUrl={RPC_URL}
                compact
                highlightAddress={address}
              />
            )}
            <details className="wi-guide" style={{ marginTop: '0.75rem' }}>
              <summary>Optional portals (ETH / CTSI / USDC inventory)</summary>
              <div className="wi-portal-grid" style={{ marginTop: '0.65rem' }}>
                {renderPortalAsset({
                  label: 'ETH',
                  depositVal: ethDepositAmt,
                  setDeposit: setEthDepositAmt,
                  onDeposit: depositEth,
                  withdrawVal: withdrawEthAmt,
                  setWithdraw: setWithdrawEthAmt,
                  onWithdraw: withdrawEth,
                  note: `Inventory only (rollup ETH: ${vault?.eth ?? '0'}) — not ETH mint capacity. Use Sub wallets for indexed path.`,
                })}
                {renderPortalAsset({
                  label: 'CTSI',
                  depositVal: ctsiDepositAmt,
                  setDeposit: setCtsiDepositAmt,
                  onDeposit: depositCtsi,
                  withdrawVal: withdrawCtsiAmt,
                  setWithdraw: setWithdrawCtsiAmt,
                  onWithdraw: withdrawCtsi,
                  note: 'CTSI inventory only — not WART or ETH mint capacity.',
                })}
                {renderPortalAsset({
                  label: 'USDC',
                  depositVal: usdcDepositAmt,
                  setDeposit: setUsdcDepositAmt,
                  onDeposit: depositUsdc,
                  withdrawVal: withdrawUsdcAmt,
                  setWithdraw: setWithdrawUsdcAmt,
                  onWithdraw: withdrawUsdc,
                  note: 'USDC inventory only — not mint capacity.',
                })}
              </div>
            </details>
          </div>
        )}

        {(l1Tab === 'subwallets' || l1Tab === 'vault') && (
          <EthSubWallets
            mainMnemonic={wartSession?.mnemonic || null}
            wartAddress={wartSession?.address || null}
            l1Address={address}
            signer={signer}
            provider={provider}
            send={send}
            loading={loading}
            setLoading={setLoading}
            vault={vault}
            onRefreshVault={() => {
              refreshVault(address);
              refreshMainEth(address);
            }}
            confirmMmTx={confirmMmTx}
            hideMainCard
            focusMode={l1Tab === 'vault' ? 'vaults' : 'subs'}
            hideTopChrome
            hideCapacityTrack
          />
        )}

        {l1Tab === 'getwweth' && (
          <div className="wi-panel eth-getwweth-panel">
            <p className="wi-muted wi-claim-lead">
              wETH claim:{' '}
              <strong>{ethCapSummary.claim}</strong>
              {' · '}
              Portable: <strong>{ethCapSummary.portable}</strong>
              {' · '}
              Available: <strong>{ethCapSummary.available}</strong>
              {' · '}
              Capacity: <strong>{ethCapSummary.capacity}</strong>
            </p>
            <p className="wi-muted" style={{ marginTop: '-0.25rem', marginBottom: '0.75rem' }}>
              Rollup-only claims until Warthog DeFi WETH. Mint uses ETH capacity (locked vault
              ETH). Burn frees Available. Not the same as MetaMask WETH.
            </p>
            <div className="wi-portal-card wi-portal-card--focus" style={{ marginBottom: '0.75rem' }}>
              <div className="wi-portal-title">Mint wETH claim</div>
              <div className="wi-portal-row">
                <input
                  className="input"
                  placeholder="Amount"
                  value={mintWethAmt}
                  onChange={(e) => setMintWethAmt(e.target.value)}
                  disabled={loading}
                />
                <button
                  type="button"
                  className="btn secondary small"
                  disabled={
                    loading ||
                    !ethCapSummary.availableRaw ||
                    Number(ethCapSummary.availableRaw) <= 0
                  }
                  onClick={() => setMintWethAmt(ethCapSummary.availableRaw)}
                >
                  Max
                </button>
                <button
                  type="button"
                  className="btn primary small"
                  disabled={loading || !mintWethAmt}
                  onClick={() => mintWethClaim()}
                >
                  Mint claim
                </button>
              </div>
            </div>
            <div className="wi-portal-card wi-portal-card--focus" style={{ marginBottom: '0.75rem' }}>
              <div className="wi-portal-title">Burn wETH claim</div>
              <div className="wi-portal-row">
                <input
                  className="input"
                  placeholder="Amount"
                  value={burnWethAmt}
                  onChange={(e) => setBurnWethAmt(e.target.value)}
                  disabled={loading}
                />
                <button
                  type="button"
                  className="btn secondary small"
                  disabled={
                    loading ||
                    !ethCapSummary.portableRaw ||
                    Number(ethCapSummary.portableRaw) <= 0
                  }
                  onClick={() => setBurnWethAmt(ethCapSummary.portableRaw)}
                >
                  Max
                </button>
                <button
                  type="button"
                  className="btn primary small"
                  disabled={loading || !burnWethAmt}
                  onClick={() => burnWethClaim()}
                >
                  Burn claim
                </button>
              </div>
            </div>
            <p className="wi-muted" style={{ marginBottom: 0 }}>
              Lock ETH capacity under <strong>Vaults</strong> first. Sub wallets fund the path.
            </p>
          </div>
        )}
      </section>
      )}
      {/* end eth-section */}
    </div>
  );
}
