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
import VoucherExecutor from './VoucherExecutor.jsx';
import '../styles/global.css'; // Assuming global styles (including new Warthog CSS) in Astro
import '../styles/warthog.css';
import {
  getInspectUrl,
  getRollupGraphqlUrl,
  L1_RPC_URL,
  LOCAL_ADDRESSES,
  getAddresses,
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

// Active network address book (Anvil default; Sepolia when PUBLIC_NETWORK=sepolia)
const RPC_URL = L1_RPC_URL;
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
  const [l1Tab, setL1Tab] = useState('home'); // home | claim | more
  /** true if UI is showing cached claims because inspect was empty */
  const [vaultFromCache, setVaultFromCache] = useState(false);
  /** Live MetaMask ERC-20 wWART balance (human units string) */
  const [mmWwartBal, setMmWwartBal] = useState(null);

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

  useEffect(() => {
    if (connected && address) {
      hydrateVaultPreferApi(address);
      refreshVault(address);
      refreshMmWwart(address);
      const interval = setInterval(() => {
        refreshVault(address);
        refreshMmWwart(address);
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
        return;
      }

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

  const L1_TABS = [
    { id: 'home', label: 'Overview' },
    { id: 'claim', label: 'Get wWART' },
    { id: 'more', label: 'More' },
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

      {/* ── 2) L1 MetaMask (claim / execute) ── */}
      <section className="wi-l1-block">
        <header className="wi-header">
          <div className="wi-header-main">
            <div className="wi-header-id">
              <span className="wi-header-label">L1 · MetaMask</span>
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
                  ? 'Online'
                  : 'Offline'}
            </span>
          </div>
          <div className="wi-header-tools">
            <button
              type="button"
              className="btn primary small"
              onClick={() => {
                refreshVault(address);
                refreshMmWwart(address);
              }}
              disabled={loading}
            >
              <RefreshCw size={14} className="inline" style={{ marginRight: 4, verticalAlign: -2 }} />
              Refresh
            </button>
            <button
              type="button"
              className="btn small secondary"
              onClick={() => setShowWarthog(!showWarthog)}
            >
              {showWarthog ? 'Hide wallet' : 'Show wallet'}
            </button>
          </div>
        </header>

        <nav className="sw-action-tabs wi-l1-tabs" role="tablist" aria-label="L1 actions">
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

        {l1Tab === 'home' && (
          <div className="wi-panel">
            <div className="wi-stat-grid wi-stat-grid--focus">
              <div className="wi-stat wi-stat--liquid">
                <Coins size={18} className="wi-stat-icon" />
                <span className="wi-stat-k">Available</span>
                <span className="wi-stat-v">{mintCap.available}</span>
                <span className="wi-stat-hint">shared mint headroom</span>
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
                  from {lockedWart.toFixed(4)} WART collateral
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
              <strong>Capacity</strong> = locked WART. <strong>Used</strong> = {SHARE_TOKEN.symbol} +
              wWART claims. <strong>Open</strong> claims (not withdrawn) can burn immediately.{' '}
              <strong>Filled</strong> claims (ERC-20 already on MetaMask) keep Used until you{' '}
              <strong>deposit L1 wWART back</strong> and then <strong>Burn wWART claims</strong>.
              <strong> Release</strong> unlocks native collateral separately.
            </p>
            <ol className="wi-steps">
              <li>
                <strong>Bridge</strong> — fund sub, sweep → lock capacity
              </li>
              <li>
                Mint wWART / {SHARE_TOKEN.symbol} (uses capacity) → optional{' '}
                <button type="button" className="wi-linkish" onClick={() => setL1Tab('claim')}>
                  Get wWART
                </button>{' '}
                to MetaMask (claim becomes <em>filled</em>)
              </li>
              <li>
                To free filled capacity: deposit MetaMask wWART → <strong>Burn wWART claims</strong>
              </li>
              <li>
                Open (unfilled) claims: burn on Warthog Home without deposit
              </li>
              <li>
                Optional: <strong>Release</strong> locked WART → Vault → main
              </li>
            </ol>
            {WWART_ADDRESS ? (
              <button
                type="button"
                className="wi-token-copy"
                onClick={async () => {
                  const addr = WWART_ADDRESS;
                  const symbol = LOCAL_WWART?.symbol || 'wWART';
                  const decimals = LOCAL_WWART?.decimals ?? 18;
                  try {
                    if (!window.ethereum) {
                      throw new Error('MetaMask not found');
                    }
                    // EIP-747 — MetaMask prompt to add the token to the asset list
                    const added = await window.ethereum.request({
                      method: 'wallet_watchAsset',
                      params: {
                        type: 'ERC20',
                        options: {
                          address: addr,
                          symbol,
                          decimals,
                        },
                      },
                    });
                    if (added) {
                      toast.success(`${symbol} added to MetaMask`);
                    } else {
                      // User dismissed — still offer address
                      await navigator.clipboard?.writeText(addr);
                      toast('Import cancelled — address copied', { duration: 4000 });
                    }
                  } catch (e) {
                    try {
                      await navigator.clipboard?.writeText(addr);
                      toast.error(
                        `Auto-import failed (${e?.message || e}). Address copied — add token manually.`,
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
        )}

        {l1Tab === 'claim' && (
          <div className="wi-panel">
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
              </strong>
              {' '}
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
              Portable = mint claims not yet withdrawn (mint voucher). Portal = MetaMask deposits
              (transfer voucher). Deposit does <strong>not</strong> raise portable or free Used —
              burn does for capacity; withdraw for sending out.
            </p>
            {WWART_ADDRESS ? (
              <div className="wi-portal-card wi-portal-card--focus">
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
                      // Max = portable + portal inventory (same as backend withdraw_wwart)
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
            ) : (
              <p className="wi-muted">wWART token not configured.</p>
            )}
            <VoucherExecutor
              address={address}
              signer={signer}
              provider={provider}
              onlyMine
            />
          </div>
        )}

        {l1Tab === 'more' && (
          <div className="wi-panel">
            <p className="wi-muted">
              Optional portals &amp; diagnostics. wWART deposit returns L1 tokens to the rollup
              balance — it does <strong>not</strong> free Used capacity (burn does).
            </p>
            {WWART_ADDRESS ? (
              <div className="wi-portal-card wi-portal-card--focus" style={{ marginBottom: '0.75rem' }}>
                <div className="wi-portal-title">Deposit wWART (MetaMask → rollup)</div>
                <p className="wi-portal-note" style={{ marginBottom: '0.5rem' }}>
                  Credits <strong>portal inventory</strong> (not portable). Used / Available
                  unchanged until you <strong>Burn wWART claims</strong> on Warthog → Home.
                  Withdraw Max includes portal + portable. Unlock collateral is a separate{' '}
                  <strong>Release</strong> on Bridge.
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
                          'Deposited — portal inventory up (not portable). Max withdraw includes it; Used claim free only after burn.',
                          { duration: 8000 },
                        );
                      } catch {
                        /* depositWwart already toasts errors */
                      }
                      setTimeout(() => refreshVault(address), 10000);
                    }}
                  >
                    Deposit wWART
                  </button>
                </div>
                <p className="wi-portal-note">
                  Portal inventory:{' '}
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
                  {' · '}
                  Used claim: <strong>{mintCap.claim || '0'}</strong>
                </p>
              </div>
            ) : null}
            <div className="wi-portal-grid">
              {renderPortalAsset({
                label: 'ETH',
                depositVal: ethDepositAmt,
                setDeposit: setEthDepositAmt,
                onDeposit: depositEth,
                withdrawVal: withdrawEthAmt,
                setWithdraw: setWithdrawEthAmt,
                onWithdraw: withdrawEth,
                note: 'Execute vouchers under Get wWART.',
              })}
              {renderPortalAsset({
                label: 'CTSI',
                depositVal: ctsiDepositAmt,
                setDeposit: setCtsiDepositAmt,
                onDeposit: depositCtsi,
                withdrawVal: withdrawCtsiAmt,
                setWithdraw: setWithdrawCtsiAmt,
                onWithdraw: withdrawCtsi,
                note: 'Execute under Get wWART.',
              })}
              {renderPortalAsset({
                label: 'USDC',
                depositVal: usdcDepositAmt,
                setDeposit: setUsdcDepositAmt,
                onDeposit: depositUsdc,
                withdrawVal: withdrawUsdcAmt,
                setWithdraw: setWithdrawUsdcAmt,
                onWithdraw: withdrawUsdc,
                note: 'Execute under Get wWART.',
              })}
            </div>
            <details className="wi-guide">
              <summary>Collateral lock history (native WART, not ERC-20 wWART)</summary>
              <div className="wi-stat-grid" style={{ marginTop: '0.5rem' }}>
                <div className="wi-stat">
                  <span className="wi-stat-k">Ever locked</span>
                  <span className="wi-stat-v">{formatWart(spoofedWwart.total)} WART</span>
                </div>
                <div className="wi-stat">
                  <span className="wi-stat-k">Released</span>
                  <span className="wi-stat-v">{formatWart(spoofedWwart.totalBurned)} WART</span>
                </div>
              </div>
              {spoofedWwart.history?.length ? (
                <ul className="wi-history">
                  {spoofedWwart.history.slice(0, 5).map((m, i) => (
                    <li key={`m-${i}`}>
                      Collateral +{formatWart(m.amount)} WART ·{' '}
                      {new Date(m.timestamp).toLocaleString()}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="wi-muted">No history yet.</p>
              )}
            </details>
            <div className="wi-header-tools" style={{ marginTop: '0.75rem' }}>
              <button
                type="button"
                className="btn secondary small"
                onClick={() => send({ type: 'register_address' })}
                disabled={loading || rollupOnline === false}
              >
                Register L1 address
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
