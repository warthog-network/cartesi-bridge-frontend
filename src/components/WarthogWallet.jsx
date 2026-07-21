// src/components/WarthogWallet.jsx — streamlined Warthog native wallet shell
import React, { useState, useEffect, useRef } from 'react';
import CryptoJS from 'crypto-js';
import { toast } from 'react-hot-toast';
import { Settings, LayoutGrid } from 'lucide-react';
import TransactionHistory from './TransactionHistory';
import SubWallet from './SubWallet';
import PersonalVaultMvp from './PersonalVaultMvp';
import '../styles/warthog.css';
import '../styles/subWallet.css';
import {
  createWarthogApi,
  parseRecipientAddress,
  signAndSubmitTransaction,
  formatSubmitResult,
} from '../utils/warthogClient.js';
import {
  generateWallet as createWarthogWallet,
  deriveWallet as restoreWarthogWallet,
  importFromPrivateKey as importWarthogWallet,
} from '../utils/warthogWallet.js';
import { serializeTransaction } from '../utils/warthogTx.js';
import {
  formatWartBalance,
  pickWartBalanceObject,
  parseWartBalanceBreakdown,
  validateWarthogAddressInput,
  getNextNonceFromAccount,
} from '../utils/warthogFormat.js';
import { getSmartNonce, bumpNonceAfterSuccess } from '../utils/cancelLimitOrder.js';
import { unlockSigningWorker, lockSigningWorker, terminateSigningWorker } from '../utils/signingBridge.js';
import {
  PRESET_NODES,
  MAINNET_NODES,
  DEFAULT_NODE_URL,
  DEFI_TESTNET_URL,
  isMainnetNode,
  isDefiNode,
} from '../utils/presetNodes.js';
import { resolveLiveNode, persistSelectedNode } from '../utils/nodeFailover.js';
import { normalizeTxLookup, getTxConfirmationStatus } from '../utils/txProof.js';
import { subWalletStorageSecret } from '../utils/bridgeConfig.js';
import { SHARE_TOKEN } from '../utils/tokenNames.js';
import { LOCAL_WWART } from '../utils/localTokens.js';
import {
  listWalletEntries,
  getNamedWalletCipher,
  getLegacyWalletCipher,
  saveNamedWalletCipher,
  deleteNamedWallet,
  deleteLegacyWallet,
  getLastWalletName,
  setLastWalletName,
} from '../utils/namedWallets.js';
import { computeWliqMintAvailable } from '../utils/wliqCapacity.js';

/** DeFi first (vaults / sub-wallets), then mainnet — same product surface on both. */
const NODE_OPTIONS = [
  { url: DEFI_TESTNET_URL, name: 'DeFi Testnet (Official)' },
  ...PRESET_NODES.filter((n) => n.url !== DEFI_TESTNET_URL).map((node) => ({
    url: node.url,
    name: `DeFi · ${node.name}`,
  })),
  ...MAINNET_NODES.map((node) => ({
    url: node.url,
    name: node.name,
  })),
];

/** Password field matching WartBunker BalanceCardAccess (prod login). */
function PasswordField({
  id,
  label,
  value,
  onChange,
  onKeyDown,
  placeholder,
  autoComplete = 'current-password',
  autoFocus = false,
  disabled = false,
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="bca-field">
      <label htmlFor={id} className="bca-label">
        {label}
      </label>
      <div className="bca-password-wrap">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="input bca-password-input"
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          disabled={disabled}
        />
        <button
          type="button"
          className="bca-password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          tabIndex={-1}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
}

/** Known throwaway phrase for local UI / bridge testing only — never use with real funds. */
const TEST_SEED_PHRASE =
  'demise wear federal fan flee oven plug accident know buffalo kingdom orange';

const APP_TABS = [
  { id: 'overview', label: 'Home' },
  { id: 'subwallets', label: 'Sub wallets' },
  { id: 'send', label: 'Send' },
  { id: 'vault', label: 'Vault' },
  { id: 'activity', label: 'History' },
];

function shortHex(value, head = 8, tail = 6) {
  if (!value || typeof value !== 'string') return '—';
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * Warthog main address — same compact meta-row chip as vault/sub addresses.
 * Cyan chip; truncated on small screens; click to copy.
 */
function MainAddressRow({
  address,
  compact = false,
  isSmallScreen = false,
  copied = false,
  onCopied,
  label = 'Main address',
  className = '',
}) {
  if (!address) return null;
  const display = copied
    ? 'Copied!'
    : compact || isSmallScreen
      ? shortHex(address, 6, 4)
      : shortHex(address, 10, 8);
  return (
    <div className={`wh-meta-row${className ? ` ${className}` : ''}`}>
      <span className="wh-meta-k">{label}</span>
      <button
        type="button"
        className="wh-address-chip"
        title={address}
        onClick={() => {
          navigator.clipboard?.writeText(address);
          if (typeof onCopied === 'function') onCopied();
        }}
      >
        {display}
      </button>
    </div>
  );
}

const WarthogWallet = ({
  send,
  address: propAddress,
  l1Address,
  loading: propLoading,
  setLoading: propSetLoading,
  burnAmt,
  setBurnAmt,
  /** Cartesi L1 vault inspect snapshot from WalletIsland */
  l1Vault = null,
  onRefreshL1Vault,
  /** Optimistic capacity update after mint_liquid / mint_wwart */
  onOptimisticShareMint,
}) => {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [walletData, setWalletData] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [consentToClose, setConsentToClose] = useState(false);
  const [validateResult, setValidateResult] = useState(null);
  const [sendResult, setSendResult] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [balance, setBalance] = useState(null);
  /** Spendable = total − mempool − locked (DeFi node fields). */
  const [spendableBalance, setSpendableBalance] = useState(null);
  const [mempoolBalance, setMempoolBalance] = useState(null);
  const [nextNonce, setNextNonce] = useState(null);
  const [pinHeight, setPinHeight] = useState(null);
  const [pinHash, setPinHash] = useState(null);
  const [mnemonic, setMnemonic] = useState('');
  const [privateKeyInput, setPrivateKeyInput] = useState('');
  const [validateAddr, setValidateAddr] = useState('');
  const [toAddr, setToAddr] = useState('');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('');
  const [nonceInput, setNonceInput] = useState('');
  const [wordCount, setWordCount] = useState('12');
  const [pathType, setPathType] = useState('hardened');
  /** Guided access path: hub | login | create | have | derive | import | load (WartBunker BCA) */
  const [accessPath, setAccessPath] = useState('hub');
  /** @deprecated kept for save-modal / legacy handlers that still read walletAction */
  const [walletAction, setWalletAction] = useState(() =>
    typeof window !== 'undefined' && listWalletEntries().length > 0 ? 'saved' : 'create',
  );
  const [error, setError] = useState(null);
  const [password, setPassword] = useState('');
  const [saveWalletConsent, setSaveWalletConsent] = useState(false);
  const [showPasswordPrompt, setShowPasswordPrompt] = useState(false);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [walletFileDragActive, setWalletFileDragActive] = useState(false);
  const [isWalletProcessed, setIsWalletProcessed] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  /** Named wallet currently selected for unlock / active session tag */
  const [walletName, setWalletName] = useState(() => {
    if (typeof window === 'undefined') return '';
    const last = getLastWalletName();
    const entries = listWalletEntries();
    if (last && entries.some((e) => e.id === last && e.kind === 'named')) return last;
    const named = entries.find((e) => e.kind === 'named');
    return named?.id || '';
  });
  const [selectedSavedId, setSelectedSavedId] = useState(() => {
    if (typeof window === 'undefined') return '';
    const entries = listWalletEntries();
    if (entries.length === 0) return '';
    const last = getLastWalletName();
    const pick =
      (last && entries.find((e) => e.id === last)) ||
      entries.find((e) => e.kind === 'named') ||
      entries[0];
    return pick?.id || '';
  });
  const [savedEntries, setSavedEntries] = useState(() => listWalletEntries());
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showManageSaved, setShowManageSaved] = useState(false);
  const [selectedNode, setSelectedNode] = useState(() => {
    if (typeof window !== 'undefined') {
      // Prefer stored pick; fall back to official DeFi testnet
      return localStorage.getItem('selectedNode') || DEFAULT_NODE_URL;
    }
    return DEFAULT_NODE_URL;
  });
  const [showNodeMenu, setShowNodeMenu] = useState(false);
  const nodeMenuRef = useRef(null);
  const [showSectionMenu, setShowSectionMenu] = useState(false);
  const sectionMenuRef = useRef(null);
  const [showDownloadPrompt, setShowDownloadPrompt] = useState(false);
  const [sending, setSending] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [failedTransactions, setFailedTransactions] = useState([]);
  const [sentTransactions, setSentTransactions] = useState([]);
  const [copiedTxId, setCopiedTxId] = useState(null);
  const [copiedToAddr, setCopiedToAddr] = useState(null);
  const [copiedFromAddr, setCopiedFromAddr] = useState(null);
  const [isSmallScreen767, setIsSmallScreen767] = useState(false);
  const [isPollingTx, setIsPollingTx] = useState(false);
  const [isRefreshingBalance, setIsRefreshingBalance] = useState(false);
  const [subWallets, setSubWallets] = useState([]);
  const [subIndex, setSubIndex] = useState(0);
  const [subDepositAmt, setSubDepositAmt] = useState('');
  const [selectedSub, setSelectedSub] = useState(null);
  const [voucherPayload, setVoucherPayload] = useState('');
  const [appTab, setAppTab] = useState('overview');
  /** Overview sub-tabs: account | liquid | tools */
  const [overviewTab, setOverviewTab] = useState('account');
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [mintWliqAmt, setMintWliqAmt] = useState('10');
  /** 'wliq' | 'wwart' — share claim vs portable mock wWART against same capacity */
  const [mintTokenChoice, setMintTokenChoice] = useState('wliq');
  /** Live MetaMask ERC-20 wWART (mock) — separate from rollup claims */
  const [mmWwartBal, setMmWwartBal] = useState(null);
  const [burnWwartAmt, setBurnWwartAmt] = useState('');

  // Load MetaMask wWART whenever liquid/vault/bridge surfaces may need it
  useEffect(() => {
    let cancelled = false;
    const needMm =
      overviewTab === 'liquid' || appTab === 'vault' || appTab === 'subwallets' || appTab === 'overview';
    if (!needMm) return undefined;
    (async () => {
      try {
        if (!LOCAL_WWART?.address || typeof window === 'undefined' || !window.ethereum) return;
        const { BrowserProvider, Contract, formatUnits } = await import('ethers-v6');
        const provider = new BrowserProvider(window.ethereum);
        const accounts = await provider.send('eth_accounts', []);
        if (!accounts?.length) return;
        const token = new Contract(
          LOCAL_WWART.address,
          ['function balanceOf(address) view returns (uint256)'],
          provider,
        );
        const bal = await token.balanceOf(accounts[0]);
        if (!cancelled) setMmWwartBal(formatUnits(bal, 18));
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [l1Vault?.l1WwartClaim, l1Vault?.mintRemaining18, overviewTab, appTab]);

  useEffect(() => {
    localStorage.setItem('selectedNode', selectedNode);
  }, [selectedNode]);

  // Close node gear / section menus on outside click / Escape
  useEffect(() => {
    if (!showNodeMenu && !showSectionMenu) return undefined;
    const onPointer = (e) => {
      if (showNodeMenu && nodeMenuRef.current && !nodeMenuRef.current.contains(e.target)) {
        setShowNodeMenu(false);
      }
      if (
        showSectionMenu &&
        sectionMenuRef.current &&
        !sectionMenuRef.current.contains(e.target)
      ) {
        setShowSectionMenu(false);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setShowNodeMenu(false);
        setShowSectionMenu(false);
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [showNodeMenu, showSectionMenu]);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  }, []);

  useEffect(() => {
    const handleAppInstalled = () => setDeferredPrompt(null);
    window.addEventListener('appinstalled', handleAppInstalled);
    return () => window.removeEventListener('appinstalled', handleAppInstalled);
  }, []);

  const refreshSavedList = () => setSavedEntries(listWalletEntries());

  // On load: land on Saved tab with named-wallet list (not the compact unlock card).
  useEffect(() => {
    const entries = listWalletEntries();
    setSavedEntries(entries);
    if (entries.length === 0) {
      setWalletAction('derive');
      setShowPasswordPrompt(false);
      return;
    }
    const last = getLastWalletName();
    const pick =
      (last && entries.find((e) => e.id === last)) ||
      entries.find((e) => e.kind === 'named') ||
      entries[0];
    if (pick) {
      setSelectedSavedId(pick.id);
      setWalletName(pick.kind === 'named' ? pick.id : '');
    }
    setWalletAction('saved');
    setShowPasswordPrompt(false);
  }, []);

  useEffect(() => {
    if (wallet?.address) fetchBalanceAndNonce(wallet.address);
  }, [wallet, selectedNode]);

  useEffect(() => {
    if (sentTransactions.length > 0 && wallet?.address) {
      const interval = setInterval(() => updateTxStatuses(), 30000);
      return () => clearInterval(interval);
    }
  }, [sentTransactions, wallet, selectedNode]);

  useEffect(() => {
    const handleResize = () => setIsSmallScreen767(window.innerWidth < 767);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!wallet?.address) {
      setSubWallets([]);
      return;
    }
    const key = `warthogSubWallets:${wallet.address.toLowerCase()}`;
    const saved = localStorage.getItem(key);
    if (!saved) {
      setSubWallets([]);
      return;
    }
    try {
      const secret = subWalletStorageSecret(wallet.address);
      const bytes = CryptoJS.AES.decrypt(saved, secret);
      const decrypted = bytes.toString(CryptoJS.enc.Utf8);
      if (!decrypted) {
        try {
          setSubWallets(JSON.parse(saved));
        } catch {
          setSubWallets([]);
        }
        return;
      }
      setSubWallets(JSON.parse(decrypted));
    } catch (err) {
      console.error('Failed to decrypt/parse subWallets:', err);
      setSubWallets([]);
    }
  }, [wallet?.address]);

  useEffect(() => {
    if (!wallet?.address) return;
    try {
      const secret = subWalletStorageSecret(wallet.address);
      const key = `warthogSubWallets:${wallet.address.toLowerCase()}`;
      // Persist empty list too (so Remove last sub / Clear hidden actually sticks)
      const encrypted = CryptoJS.AES.encrypt(JSON.stringify(subWallets), secret).toString();
      localStorage.setItem(key, encrypted);
    } catch (err) {
      console.error('Failed to persist subWallets:', err);
    }
  }, [subWallets, wallet?.address]);

  const copyToClipboard = async (text, setCopied) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* ignore */
    }
  };

  /**
   * Fetch chain balance for any address.
   * @param {string} address
   * @param {boolean} isForSub - when true, do NOT overwrite main-wallet header state
   *   (sub / vault lookups must pass true so a vault balance never clobbers main UI).
   */
  const fetchBalanceAndNonce = async (address, isForSub = false) => {
    setError(null);
    if (!address || String(address).length < 40) {
      if (!isForSub) {
        setBalance('0');
        setSpendableBalance('0');
        setMempoolBalance('0');
        setIsRefreshingBalance(false);
      }
      return {
        balance: '0',
        spendable: '0',
        mempool: '0',
        nextNonce: 0,
        pinHeight: null,
        pinHash: null,
      };
    }
    if (!isForSub) {
      setIsRefreshingBalance(true);
      setBalance(null);
      setSpendableBalance(null);
      setMempoolBalance(null);
      setNextNonce(null);
    }
    setPinHeight(null);
    setPinHash(null);

    try {
      const live = await resolveLiveNode(selectedNode);
      if (live.switched) {
        persistSelectedNode(live.node);
        setSelectedNode(live.node);
        console.info(
          `[node failover] ${live.fromNode} unreachable — switched to ${live.node}`,
          live.attempts,
        );
      }

      const api = live.api;
      const activeNode = live.node;
      const { normalizeChainPin } = await import('warthog-js');

      const { pinHash: headPinHash, pinHeight: headPinHeight } = normalizeChainPin(live.head);
      setPinHeight(headPinHeight);
      setPinHash(headPinHash);

      const balRes = isMainnetNode(activeNode)
        ? await api.getAccountBalance(address)
        : await api.getAccountWartBalance(address);
      if (!balRes.success) {
        throw new Error(balRes.error || 'Failed to fetch balance');
      }

      const balanceData = balRes.data;
      const mainnet = isMainnetNode(activeNode);
      const breakdown = parseWartBalanceBreakdown(balanceData, { mainnet });
      // Header "balance" = spendable when mempool/locked known; else total (legacy)
      const balanceInWart =
        breakdown.mempoolE8 > 0n || breakdown.lockedE8 > 0n
          ? breakdown.spendable
          : breakdown.total || (await formatWartBalance(pickWartBalanceObject(balanceData, { mainnet })));

      let chainNextNonce = 0;
      if (mainnet) {
        chainNextNonce = await getNextNonceFromAccount(balanceData);
      }
      const smartNonce = getSmartNonce(
        isForSub ? address : wallet?.address || address,
        chainNextNonce,
      );

      if (!isForSub) {
        setBalance(balanceInWart);
        setSpendableBalance(breakdown.spendable);
        setMempoolBalance(breakdown.mempool);
        setNextNonce(smartNonce);
      }

      if (!isForSub) setIsRefreshingBalance(false);
      return {
        balance: breakdown.total,
        spendable: breakdown.spendable,
        mempool: breakdown.mempool,
        locked: breakdown.locked,
        nextNonce: smartNonce,
        pinHeight: headPinHeight,
        pinHash: headPinHash,
        isDefi: isDefiNode(activeNode),
      };
    } catch (err) {
      const errorMessage = err.message || 'Could not fetch chain head or balance';
      setError(errorMessage);
      console.error('Fetch error:', err);
      if (!isForSub) setIsRefreshingBalance(false);
      return {
        balance: '0',
        spendable: '0',
        mempool: '0',
        nextNonce: 0,
        pinHeight: null,
        pinHash: null,
      };
    }
  };

  const updateTxStatuses = async () => {
    setIsPollingTx(true);
    try {
      const api = await createWarthogApi(selectedNode);
      const updatedTxs = await Promise.all(
        sentTransactions.map(async (tx) => {
          if (tx.status === 'confirmed') return tx;
          try {
            const lookupRes = await api.getNodePath(`transaction/lookup/${tx.txHash}`);
            if (!lookupRes.success) return tx;
            const { blockHeight, confirmations } = getTxConfirmationStatus(lookupRes.data);
            if (blockHeight !== undefined && confirmations > 0) {
              return { ...tx, status: 'confirmed', confirmations };
            }
            return tx;
          } catch {
            return tx;
          }
        })
      );
      setSentTransactions(updatedTxs);
    } finally {
      setIsPollingTx(false);
    }
  };

  const encryptWallet = (data, pwd) => {
    const { privateKey, publicKey, address, mnemonic: m, wordCount: wc, pathType: pt } = data;
    const walletToSave = { privateKey, publicKey, address, mnemonic: m, wordCount: wc, pathType: pt };
    return CryptoJS.AES.encrypt(JSON.stringify(walletToSave), pwd).toString();
  };

  const decryptWallet = (encrypted, pwd) => {
    try {
      const bytes = CryptoJS.AES.decrypt(encrypted, pwd);
      const decrypted = bytes.toString(CryptoJS.enc.Utf8);
      if (!decrypted) throw new Error('Invalid password');
      return JSON.parse(decrypted);
    } catch {
      throw new Error('Failed to decrypt wallet: Invalid password');
    }
  };

  const activateWallet = async (data, nameTag = '') => {
    if (!data?.privateKey || !data?.publicKey || !data?.address) {
      throw new Error('Invalid wallet data (missing key or address)');
    }
    try {
      await unlockSigningWorker(data.privateKey, {
        publicKey: data.publicKey,
        address: data.address,
      });
    } catch (err) {
      // Still open the session; signing can fall back to in-memory private key.
      console.warn('Signing worker unlock failed; using session keys:', err);
    }
    setWallet(data);
    if (nameTag) {
      setWalletName(nameTag);
      setLastWalletName(nameTag);
    }
    setShowPasswordPrompt(false);
    setError(null);
    setIsWalletProcessed(true);
    setIsLoggedIn(true);
    setAppTab('overview');
    const storedNonce = localStorage.getItem(`warthogNextNonce_${data.address}`);
    if (storedNonce) setNextNonce(Number(storedNonce));
  };

  /**
   * Save encrypted wallet under a name (wartbunker-style warthogWallet_${name}).
   * Also writes legacy warthogWallet for backward compat when name is used.
   */
  const saveNamedWallet = async (data, name, pwd) => {
    const trimmed = String(name || '').trim();
    if (!trimmed) {
      setError('Give this wallet a name to save it');
      return false;
    }
    if (!pwd) {
      setError('Password required to encrypt the saved wallet');
      return false;
    }
    try {
      const encrypted = encryptWallet(data, pwd);
      saveNamedWalletCipher(trimmed, encrypted);
      // Keep legacy slot in sync so older unlock paths still work
      localStorage.setItem('warthogWallet', encrypted);
      setWalletName(trimmed);
      setLastWalletName(trimmed);
      refreshSavedList();
      toast.success(`Saved “${trimmed}” in this browser`);
      return true;
    } catch (err) {
      setError(err.message || 'Failed to save named wallet');
      return false;
    }
  };

  const saveWallet = async (data) => {
    if (!saveWalletConsent || !password) {
      setError('Please provide a password and consent to save the wallet');
      return false;
    }
    const name = String(walletName || '').trim();
    if (!name) {
      setError('Enter a wallet name (e.g. Main, Test) — same as WartBunker named saves');
      return false;
    }
    try {
      const ok = await saveNamedWallet(data, name, password);
      if (!ok) return false;
      if (!wallet || wallet.address !== data.address) {
        await activateWallet(data, name);
      } else {
        setError(null);
        setIsWalletProcessed(true);
        setIsLoggedIn(true);
      }
      setPassword('');
      setConfirmPassword('');
      setSaveWalletConsent(false);
      return true;
    } catch (err) {
      setError(err.message || 'Failed to save wallet');
      return false;
    }
  };

  const downloadWallet = (data) => {
    if (!password) {
      setError('Please provide a password to encrypt the wallet file');
      return false;
    }
    try {
      const encrypted = encryptWallet(data, password);
      const blob = new Blob([encrypted], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'warthog_wallet.txt';
      a.click();
      URL.revokeObjectURL(url);
      setIsWalletProcessed(true);
      setPassword('');
      setSaveWalletConsent(false);
      return true;
    } catch (err) {
      setError(err.message || 'Failed to download wallet file');
      return false;
    }
  };

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (!file) {
      setError('No file selected');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => setUploadedFile(e.target.result);
    reader.onerror = () => setError('Failed to read file');
    reader.readAsText(file);
  };

  const loadWallet = async () => {
    if (!password) {
      setError('Please provide a password');
      return;
    }
    try {
      let encrypted;
      let nameTag = '';
      if (uploadedFile) {
        encrypted = uploadedFile;
      } else if (selectedSavedId && selectedSavedId !== '__legacy__') {
        encrypted = getNamedWalletCipher(selectedSavedId);
        if (!encrypted) throw new Error(`No saved wallet named “${selectedSavedId}”`);
        nameTag = selectedSavedId;
      } else if (selectedSavedId === '__legacy__' || !selectedSavedId) {
        encrypted = getLegacyWalletCipher() || getNamedWalletCipher(walletName);
        if (!encrypted) throw new Error('No wallet found in storage or file');
        nameTag = selectedSavedId === '__legacy__' ? '' : String(walletName || '').trim();
      }
      const decryptedWallet = decryptWallet(encrypted, password);
      await activateWallet(decryptedWallet, nameTag);
      setUploadedFile(null);
      setPassword('');
    } catch (err) {
      setError(err.message);
    }
  };

  /** Lock session only — does not delete named wallets from this browser. */
  const clearWallet = async () => {
    if (wallet?.address) {
      localStorage.removeItem(`warthogNextNonce_${wallet.address}`);
    }
    await lockSigningWorker();
    terminateSigningWorker();
    setWallet(null);
    setBalance(null);
    setSpendableBalance(null);
    setMempoolBalance(null);
    setNextNonce(null);
    setPinHeight(null);
    setPinHash(null);
    setError(null);
    setPassword('');
    setConfirmPassword('');
    setSaveWalletConsent(false);
    setUploadedFile(null);
    setIsWalletProcessed(false);
    setIsLoggedIn(false);
    setFailedTransactions([]);
    setSentTransactions([]);
    setNonceInput('');
    setAppTab('overview');
    setShowModal(false);
    setWalletData(null);
    setSubWallets([]);
    refreshSavedList();
    // After lock: back to Saved list (same as preferred first-load UX)
    if (listWalletEntries().length > 0) {
      setWalletAction('saved');
      setShowPasswordPrompt(false);
    }
    toast.success('Session locked');
  };

  /** Permanently remove a named (or legacy) encrypted save from this browser. */
  const removeSavedWallet = (entryId) => {
    const label =
      entryId === '__legacy__' ? 'Default (legacy)' : entryId;
    if (
      !window.confirm(
        `Delete saved wallet “${label}” from this browser?\n\nThis cannot be undone. Session is not required — only the encrypted local copy is removed.`,
      )
    ) {
      return;
    }
    if (entryId === '__legacy__') {
      deleteLegacyWallet();
    } else {
      deleteNamedWallet(entryId);
    }
    if (walletName === entryId) setWalletName('');
    if (selectedSavedId === entryId) setSelectedSavedId('');
    refreshSavedList();
    setError(null);
    toast.success(`Deleted saved “${label}”`);
  };

  const generateWallet = async (wc, pt) => createWarthogWallet(wc, pt);

  const deriveWallet = async (phrase, wc, pt) => {
    const words = phrase.trim().split(/\s+/).filter(Boolean);
    const expectedWordCount = Number(wc);
    if (words.length !== expectedWordCount) {
      throw new Error(`Invalid mnemonic: must have exactly ${expectedWordCount} words`);
    }
    return restoreWarthogWallet(phrase, wc, pt);
  };

  const importFromPrivateKey = async (privKey) => importWarthogWallet(privKey);

  const handleWalletAction = async (forcedAction) => {
    const action = typeof forcedAction === 'string' ? forcedAction : walletAction;
    setWalletAction(action);
    setError(null);
    setIsWalletProcessed(false);

    if (action === 'saved') {
      await loadWallet();
      return;
    }

    if (action === 'login' && !uploadedFile) {
      setError('Upload warthog_wallet.txt, or use another restore path');
      return;
    }

    if (action === 'login') {
      await loadWallet();
      return;
    }

    if (action === 'derive' && !mnemonic.trim()) {
      setError('Please enter your 12 or 24-word seed phrase');
      return;
    }

    if (action === 'import' && !privateKeyInput) {
      setError('Please enter a private key');
      return;
    }

    if (action === 'derive') {
      const words = mnemonic.trim().split(/\s+/).filter(Boolean);
      const expectedWordCount = Number(wordCount);
      if (words.length !== expectedWordCount) {
        setError(
          `Seed phrase has ${words.length} word${words.length === 1 ? '' : 's'}; expected ${expectedWordCount}. Check Word Count if you have 24 words.`
        );
        return;
      }
    }

    setWalletBusy(true);
    try {
      let data;
      if (action === 'create') {
        data = await generateWallet(Number(wordCount), pathType);
      } else if (action === 'derive') {
        data = await deriveWallet(mnemonic, Number(wordCount), pathType);
      } else if (action === 'import') {
        data = await importFromPrivateKey(privateKeyInput);
      } else {
        setError(`Unknown wallet action: ${action}`);
        return;
      }

      await activateWallet(data);
      setWalletData(data);
      // Only show backup modal when we have new material worth backing up
      if (data.mnemonic || action === 'import' || action === 'create') {
        setShowModal(true);
        setConsentToClose(false);
      }
      setMnemonic('');
      setPrivateKeyInput('');
    } catch (err) {
      const raw = err?.message || String(err);
      let errorMessage = raw || `Failed to ${action} wallet`;
      if (/invalid mnemonic|invalid phrase|checksum|BIP39|word list/i.test(raw)) {
        errorMessage = `Invalid seed phrase. Check spelling, word count, and derivation path (hardened vs non-hardened).`;
      }
      setError(errorMessage);
      console.error('Wallet action error:', err);
    } finally {
      setWalletBusy(false);
    }
  };

  const handleValidateAddress = async () => {
    setError(null);
    setValidateResult(null);
    if (!validateAddr) {
      setError('Please enter an address');
      return;
    }
    try {
      const result = await validateWarthogAddressInput(validateAddr);
      setValidateResult(result);
    } catch (err) {
      setError(err.message || 'Failed to validate address');
      console.error('Validate error:', err);
    }
  };

  const handleSendTransaction = async (
    fromPrivKey = wallet?.privateKey,
    fromAddress = wallet?.address,
    to = toAddr,
    amountVal = amount,
    feeVal = fee,
  ) => {
    if (sending) return;
    setSending(true);
    setError(null);
    setSendResult(null);

    if (!to || !amountVal) {
      setError('Please fill in recipient and amount');
      setSending(false);
      return;
    }

    const amountNum = parseFloat(amountVal);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError('Invalid amount: must be a positive number');
      setSending(false);
      return;
    }

    const isForSub = fromAddress !== wallet?.address;
    const nonceOwner = isForSub ? fromAddress : wallet?.address;
    let txNonce = getSmartNonce(nonceOwner, nextNonce ?? 0);

    if (!isForSub && nonceInput !== '') {
      const parsedNonce = Number(nonceInput);
      if (isNaN(parsedNonce) || parsedNonce < 0 || !Number.isInteger(parsedNonce)) {
        setError('Invalid nonce: must be a non-negative integer');
        setSending(false);
        return;
      }
      txNonce = parsedNonce;
    }

    const txDetails = {
      toAddr: to,
      amount: amountVal,
      fee: feeVal || 'node minimum',
      nonce: txNonce,
      timestamp: new Date().toISOString(),
    };

    try {
      const api = await createWarthogApi(selectedNode);
      const { Address, Wart } = await import('warthog-js');
      const recipient = parseRecipientAddress(Address, to);
      if (!recipient) {
        throw new Error('Invalid recipient address (expected 40 or 48 hex chars with valid checksum)');
      }
      const wartAmount = Wart.parse(amountVal);
      if (!wartAmount) throw new Error('Invalid amount');

      let submitResult;
      if (isForSub) {
        if (!fromPrivKey) throw new Error('No private key available for sub-wallet transaction');
        submitResult = await signAndSubmitTransaction(api, {
          privateKey: fromPrivKey,
          nonceId: txNonce,
          buildTx: async (ctx, account) =>
            serializeTransaction(ctx.transferWart(account, recipient, wartAmount)),
        });
        bumpNonceAfterSuccess(fromAddress, submitResult.nonce, txNonce);
      } else {
        submitResult = await signAndSubmitTransaction(api, {
          privateKey: wallet.privateKey || fromPrivKey,
          nonceId: txNonce,
          buildSpec: {
            type: 'TRANSFER_WART',
            recipientHex: recipient.hex,
            amount: amountVal,
          },
        });
        bumpNonceAfterSuccess(wallet.address, submitResult.nonce, nextNonce ?? 0);
        setNextNonce(getSmartNonce(wallet.address, (submitResult.nonce ?? txNonce) + 1));
      }

      const data = formatSubmitResult(submitResult.data);
      setSendResult(data);

      if (!isForSub) {
        await fetchBalanceAndNonce(wallet.address);
        setSentTransactions((prev) => [
          ...prev,
          {
            ...txDetails,
            txHash: data.data?.txHash || data.txHash,
            status: 'pending',
          },
        ]);
        setToAddr('');
        setAmount('');
        setFee('');
        setNonceInput('');
      }

      return data;
    } catch (err) {
      const errorMessage = err.message || 'Failed to send transaction';
      setError(errorMessage);
      console.error('Send transaction error:', err);
      if (!isForSub) {
        setFailedTransactions((prev) => [...prev, { ...txDetails, error: errorMessage }]);
      }
      return null;
    } finally {
      setSending(false);
    }
  };

  const getWartTxProof = async (txHash) => {
    propSetLoading(true);
    try {
      const api = await createWarthogApi(selectedNode);
      const lookupRes = await api.getNodePath(`transaction/lookup/${txHash}`);
      if (!lookupRes.success) {
        throw new Error(lookupRes.error || 'Failed to fetch Warthog TX proof');
      }
      return normalizeTxLookup(lookupRes.data);
    } catch (err) {
      const errorMessage = err.message || 'Failed to fetch Warthog TX proof';
      setError(errorMessage);
      console.error('TX proof error:', err);
      throw new Error(errorMessage);
    } finally {
      propSetLoading(false);
    }
  };

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      setDeferredPrompt(null);
    }
  };

  const networkBadgeClass = isDefiNode(selectedNode)
    ? 'network-badge network-badge--defi'
    : 'network-badge network-badge--main';

  const hasSavedWallets = savedEntries.length > 0;

  const goAccessPath = (next) => {
    setAccessPath(next);
    setError(null);
    setPassword('');
    setConfirmPassword('');
    setMnemonic('');
    setPrivateKeyInput('');
    setUploadedFile(null);
    setWalletFileDragActive(false);
    setIsWalletProcessed(false);
    // keep walletAction in sync for existing create/derive/import/load handlers
    const map = {
      login: 'saved',
      create: 'create',
      derive: 'derive',
      import: 'import',
      load: 'login',
      have: walletAction,
      hub: walletAction,
    };
    if (map[next]) setWalletAction(map[next]);
    if (next === 'login' || next === 'hub') refreshSavedList();
    if (next === 'login' && savedEntries.length > 0 && !selectedSavedId) {
      setSelectedSavedId(savedEntries[0].id);
    }
  };

  const acceptWalletFile = (file) => {
    if (!file) return;
    setUploadedFile(file);
    setError(null);
  };

  const pathTitle = {
    hub: hasSavedWallets ? 'Welcome back' : 'Get started',
    login: 'Unlock wallet',
    create: 'Create wallet',
    have: 'Restore wallet',
    derive: 'Seed phrase',
    import: 'Private key',
    load: 'Wallet file',
  }[accessPath] || 'Wallet';

  const pathHint = {
    hub: hasSavedWallets
      ? 'Unlock a wallet saved in this browser, or start another path.'
      : 'Create a new wallet, or restore one you already have.',
    login: 'Choose a saved wallet and enter its password.',
    create: 'Generate keys in this browser. You’ll back up the seed next.',
    have: 'How do you want to restore access?',
    derive: 'Enter the 12 or 24 word phrase for this wallet.',
    import: 'Paste the 64-character private key.',
    load: 'Open an encrypted warthog_wallet.txt file.',
  }[accessPath] || '';

  const showAccessBack = accessPath !== 'hub';
  const accessBackTarget = ['derive', 'import', 'load'].includes(accessPath) ? 'have' : 'hub';

  /* ─── Auth gate — WartBunker BalanceCardAccess (prod) guided hub ─── */
  const renderAuthGate = () => (
    <div className="bca">
      <div className="bca-head">
        {showAccessBack ? (
          <button
            type="button"
            className="bca-back"
            onClick={() => goAccessPath(accessBackTarget)}
            disabled={walletBusy}
          >
            ← Back
          </button>
        ) : (
          <span className="bca-kicker">No wallet open</span>
        )}
        <h3 className="bca-title">{pathTitle}</h3>
        <p className="bca-hint">{pathHint}</p>
      </div>

      {accessPath === 'hub' && (
        <div className="bca-paths">
          {hasSavedWallets && (
            <button
              type="button"
              className="bca-path bca-path--primary"
              onClick={() => goAccessPath('login')}
            >
              <span className="bca-path__label">Unlock saved wallet</span>
              <span className="bca-path__meta">
                {savedEntries.length} in this browser
              </span>
            </button>
          )}
          <button
            type="button"
            className={`bca-path${hasSavedWallets ? '' : ' bca-path--primary'}`}
            onClick={() => goAccessPath('create')}
          >
            <span className="bca-path__label">Create new wallet</span>
            <span className="bca-path__meta">Fresh seed phrase</span>
          </button>
          <button type="button" className="bca-path" onClick={() => goAccessPath('have')}>
            <span className="bca-path__label">
              {hasSavedWallets ? 'Other restore options' : 'I already have a wallet'}
            </span>
            <span className="bca-path__meta">Seed, key, or file</span>
          </button>
        </div>
      )}

      {accessPath === 'have' && (
        <div className="bca-paths">
          {hasSavedWallets && (
            <button type="button" className="bca-path" onClick={() => goAccessPath('login')}>
              <span className="bca-path__label">Saved in this browser</span>
              <span className="bca-path__meta">
                {savedEntries.length} wallet{savedEntries.length === 1 ? '' : 's'}
              </span>
            </button>
          )}
          <button type="button" className="bca-path" onClick={() => goAccessPath('derive')}>
            <span className="bca-path__label">Seed phrase</span>
            <span className="bca-path__meta">12 or 24 words</span>
          </button>
          <button type="button" className="bca-path" onClick={() => goAccessPath('import')}>
            <span className="bca-path__label">Private key</span>
            <span className="bca-path__meta">64-character hex</span>
          </button>
          <button type="button" className="bca-path" onClick={() => goAccessPath('load')}>
            <span className="bca-path__label">Encrypted file</span>
            <span className="bca-path__meta">warthog_wallet.txt</span>
          </button>
        </div>
      )}

      {accessPath === 'login' && (
        <div className="bca-form">
          <div className="bca-field">
            <span className="bca-label">Wallet</span>
            <div className="bca-paths" role="listbox" aria-label="Saved wallets">
              {savedEntries.map((entry) => {
                const selected = selectedSavedId === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`bca-path${selected ? ' bca-path--primary' : ''}`}
                    onClick={() => {
                      setSelectedSavedId(entry.id);
                      setWalletName(entry.kind === 'named' ? entry.id : '');
                      setError(null);
                    }}
                    disabled={walletBusy}
                  >
                    <span className="bca-path__label" style={{ fontFamily: 'ui-monospace, monospace' }}>
                      {entry.label}
                    </span>
                    <span className="bca-path__meta">
                      {selected ? 'Selected' : entry.kind === 'legacy' ? 'Legacy slot' : 'Saved in this browser'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <PasswordField
            id="bca-login-pw"
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadWallet()}
            placeholder="Wallet password"
            autoFocus
            disabled={walletBusy}
          />
          <button
            type="button"
            className="btn primary bca-cta"
            disabled={walletBusy || !password || !selectedSavedId}
            onClick={loadWallet}
          >
            {walletBusy ? 'Unlocking…' : 'Unlock'}
          </button>
          {selectedSavedId && (
            <button
              type="button"
              className="bca-back"
              style={{ marginTop: '0.35rem' }}
              onClick={() => removeSavedWallet(selectedSavedId)}
              disabled={walletBusy}
            >
              Delete selected from this browser
            </button>
          )}
        </div>
      )}

      {accessPath === 'create' && (
        <div className="bca-form">
          <div className="bca-field">
            <label className="bca-label" htmlFor="bca-words">
              Word count
            </label>
            <select
              id="bca-words"
              className="input"
              value={wordCount}
              onChange={(e) => setWordCount(e.target.value)}
              disabled={walletBusy}
            >
              <option value="12">12 words</option>
              <option value="24">24 words</option>
            </select>
          </div>
          <div className="bca-field">
            <label className="bca-label" htmlFor="bca-path">
              Path
            </label>
            <select
              id="bca-path"
              className="input"
              value={pathType}
              onChange={(e) => setPathType(e.target.value)}
              disabled={walletBusy}
            >
              <option value="hardened">Hardened BIP44</option>
              <option value="non-hardened">Non-hardened</option>
            </select>
          </div>
          <button
            type="button"
            className="btn primary bca-cta"
            disabled={walletBusy}
            onClick={() => handleWalletAction('create')}
          >
            {walletBusy ? 'Generating…' : 'Create wallet'}
          </button>
        </div>
      )}

      {accessPath === 'derive' && (
        <div className="bca-form">
          <div className="bca-field">
            <label className="bca-label" htmlFor="bca-seed">
              Seed phrase
            </label>
            <textarea
              id="bca-seed"
              className="input bca-seed"
              rows={3}
              value={mnemonic}
              onChange={(e) => setMnemonic(e.target.value)}
              placeholder="12 or 24 words"
              disabled={walletBusy}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button
            type="button"
            className="bca-back"
            disabled={walletBusy}
            onClick={() => {
              setMnemonic(TEST_SEED_PHRASE);
              setWordCount('12');
              setPathType('hardened');
              setError(null);
            }}
          >
            Fill demo test seed (lab only)
          </button>
          <div className="bca-row-2">
            <div className="bca-field">
              <label className="bca-label" htmlFor="bca-dwords">
                Words
              </label>
              <select
                id="bca-dwords"
                className="input"
                value={wordCount}
                onChange={(e) => setWordCount(e.target.value)}
                disabled={walletBusy}
              >
                <option value="12">12</option>
                <option value="24">24</option>
              </select>
            </div>
            <div className="bca-field">
              <label className="bca-label" htmlFor="bca-dpath">
                Path
              </label>
              <select
                id="bca-dpath"
                className="input"
                value={pathType}
                onChange={(e) => setPathType(e.target.value)}
                disabled={walletBusy}
              >
                <option value="hardened">BIP44</option>
                <option value="non-hardened">Non-hardened</option>
              </select>
            </div>
          </div>
          <button
            type="button"
            className="btn primary bca-cta"
            disabled={walletBusy || !mnemonic.trim()}
            onClick={() => handleWalletAction('derive')}
          >
            {walletBusy ? 'Working…' : 'Recover wallet'}
          </button>
        </div>
      )}

      {accessPath === 'import' && (
        <div className="bca-form">
          <div className="bca-field">
            <label className="bca-label" htmlFor="bca-pk">
              Private key
            </label>
            <input
              id="bca-pk"
              type="text"
              className="input bca-seed"
              value={privateKeyInput}
              onChange={(e) => setPrivateKeyInput(e.target.value.trim())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleWalletAction('import');
              }}
              placeholder="64-character hex"
              disabled={walletBusy}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button
            type="button"
            className="btn primary bca-cta"
            disabled={walletBusy || !privateKeyInput}
            onClick={() => handleWalletAction('import')}
          >
            {walletBusy ? 'Working…' : 'Import wallet'}
          </button>
        </div>
      )}

      {accessPath === 'load' && (
        <div className="bca-form">
          <div className="bca-field">
            <span className="bca-label">Wallet file</span>
            <div
              className={`bca-dropzone${walletFileDragActive ? ' bca-dropzone--active' : ''}${
                uploadedFile ? ' bca-dropzone--ready' : ''
              }`}
              onDragEnter={(e) => {
                e.preventDefault();
                setWalletFileDragActive(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setWalletFileDragActive(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                setWalletFileDragActive(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setWalletFileDragActive(false);
                acceptWalletFile(e.dataTransfer.files?.[0] ?? null);
              }}
            >
              <input
                id="bca-file"
                type="file"
                accept=".txt,text/plain"
                className="sr-only"
                disabled={walletBusy}
                onChange={(e) => {
                  acceptWalletFile(e.target.files?.[0] ?? null);
                  e.target.value = '';
                }}
              />
              {uploadedFile ? (
                <div className="bca-drop-inner">
                  <p className="bca-drop-name">{uploadedFile.name}</p>
                  <label htmlFor="bca-file" className="bca-drop-browse">
                    Choose a different file
                  </label>
                </div>
              ) : (
                <div className="bca-drop-inner">
                  <p className="bca-drop-prompt">Drag your encrypted wallet file here</p>
                  <p className="bca-drop-or">or</p>
                  <label htmlFor="bca-file" className="bca-drop-browse">
                    Browse for file
                  </label>
                </div>
              )}
            </div>
          </div>
          <PasswordField
            id="bca-file-pw"
            label="File password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleWalletAction('login');
            }}
            placeholder="Encryption password"
            disabled={walletBusy}
          />
          <button
            type="button"
            className="btn primary bca-cta"
            disabled={walletBusy || !password || !uploadedFile}
            onClick={() => handleWalletAction('login')}
          >
            {walletBusy ? 'Unlocking…' : 'Open file'}
          </button>
        </div>
      )}

      {error && !showModal && (
        <div className="bca-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );

  /* ─── Logged-in shell ─── */
  const renderDashboard = () => (
    <div className="wh-dash">
      <header className="wh-header">
        <div className="wh-header-main">
          <div className="wh-header-left">
            <div className="wh-balance-block">
              <span className="wh-balance-label">
                {mempoolBalance && Number(mempoolBalance) > 0 ? 'Spendable' : 'Balance'}
              </span>
              <span className="wh-balance-value">
                {balance !== null ? `${balance} WART` : '…'}
                {isRefreshingBalance && <span className="wh-pulse" />}
              </span>
              {mempoolBalance && Number(mempoolBalance) > 0 && (
                <span className="wh-balance-mempool" title="Reserved by unconfirmed mempool txs">
                  {mempoolBalance} mempool
                </span>
              )}
            </div>
            {walletName ? (
              <span className="wh-wallet-name" title="Saved account name">
                {walletName}
              </span>
            ) : null}
            <MainAddressRow
              address={wallet.address}
              isSmallScreen={isSmallScreen767}
              compact
              copied={copiedAddress}
              onCopied={() => {
                setCopiedAddress(true);
                setTimeout(() => setCopiedAddress(false), 1200);
              }}
            />
          </div>
          <div className="wh-header-icons">
            {/* Section nav — grid icon (not gear) */}
            <div className="wh-section-menu" ref={sectionMenuRef}>
              <button
                type="button"
                className={`wh-section-btn${showSectionMenu ? ' is-open' : ''}`}
                aria-label="Sections"
                aria-expanded={showSectionMenu}
                aria-haspopup="menu"
                title={`Section · ${APP_TABS.find((t) => t.id === appTab)?.label || 'Home'}`}
                onClick={() => {
                  setShowSectionMenu((v) => !v);
                  setShowNodeMenu(false);
                }}
              >
                <LayoutGrid size={16} strokeWidth={2.25} aria-hidden />
              </button>
              {showSectionMenu && (
                <div className="wh-section-dropdown" role="menu" aria-label="Main sections">
                  <div className="wh-node-menu-head">
                    <span className="wh-node-menu-title">Go to</span>
                    <span className="wh-section-current">
                      {APP_TABS.find((t) => t.id === appTab)?.label || 'Home'}
                    </span>
                  </div>
                  {APP_TABS.map((tab) => {
                    const needsSeed = tab.id === 'subwallets' || tab.id === 'vault';
                    const disabled = needsSeed && !wallet.mnemonic;
                    const active = appTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="menuitem"
                        disabled={disabled}
                        className={`wh-section-item${active ? ' is-active' : ''}`}
                        title={
                          disabled
                            ? 'Seed phrase required'
                            : tab.id === 'vault'
                              ? 'WART multi-sig vaults only'
                              : tab.id === 'subwallets'
                                ? 'Sub-wallets · fund & sweep'
                                : undefined
                        }
                        onClick={() => {
                          if (disabled) return;
                          setAppTab(tab.id);
                          setShowSectionMenu(false);
                        }}
                      >
                        <span>{tab.label}</span>
                        {active ? <span className="wh-section-check" aria-hidden>✓</span> : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Node settings — gear */}
            <div className="wh-header-node" ref={nodeMenuRef}>
              <button
                type="button"
                className={`wh-node-gear${showNodeMenu ? ' is-open' : ''}`}
                aria-label="Node settings"
                aria-expanded={showNodeMenu}
                aria-haspopup="true"
                title={`${isDefiNode(selectedNode) ? 'DeFi' : 'Mainnet'} · change node`}
                onClick={() => {
                  setShowNodeMenu((v) => !v);
                  setShowSectionMenu(false);
                }}
              >
                <Settings size={16} strokeWidth={2.25} aria-hidden />
                <span
                  className={`wh-node-gear-dot ${isDefiNode(selectedNode) ? 'is-defi' : 'is-main'}`}
                />
              </button>
              {showNodeMenu && (
                <div className="wh-node-menu" role="dialog" aria-label="RPC node">
                  <div className="wh-node-menu-head">
                    <span className="wh-node-menu-title">RPC node</span>
                    <span className={networkBadgeClass}>
                      {isDefiNode(selectedNode) ? 'DeFi' : 'Mainnet'}
                    </span>
                  </div>
                  <select
                    value={selectedNode}
                    onChange={(e) => {
                      setSelectedNode(e.target.value);
                      setShowNodeMenu(false);
                    }}
                    className="input wh-node-select"
                    aria-label="RPC node"
                    autoFocus
                  >
                    {NODE_OPTIONS.map((node) => (
                      <option key={node.url} value={node.url}>
                        {node.name}
                      </option>
                    ))}
                  </select>
                  <p className="wh-node-menu-hint">Default: DeFi Testnet (Official)</p>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="wh-header-tools">
          <div className="wh-header-actions" role="group" aria-label="Wallet actions">
            <button
              type="button"
              className="btn primary small"
              onClick={() => fetchBalanceAndNonce(wallet.address)}
              disabled={isRefreshingBalance}
            >
              Refresh
            </button>
            <button type="button" className="btn secondary small" onClick={() => setShowDownloadPrompt(true)}>
              Backup
            </button>
            <button type="button" className="btn danger small" onClick={clearWallet}>
              Lock
            </button>
          </div>
        </div>
      </header>

      <div className="wh-section-bar" aria-live="polite">
        <span className="wh-section-bar-label">
          {APP_TABS.find((t) => t.id === appTab)?.label || 'Home'}
        </span>
      </div>

      <div className="wh-panel">
        {appTab === 'overview' && (
          <div className="wh-panel-stack">
            <nav className="sw-action-tabs wh-overview-tabs" role="tablist" aria-label="Overview">
              {[
                { id: 'account', label: 'Account' },
                { id: 'liquid', label: SHARE_TOKEN.symbol },
                { id: 'tools', label: 'Tools' },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={overviewTab === t.id}
                  className={`sw-action-tab ${overviewTab === t.id ? 'is-active' : ''}`}
                  onClick={() => setOverviewTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </nav>

            {overviewTab === 'account' && (
              <div className="wh-card wh-card--inset">
                <div className="sw-card-meta" style={{ marginBottom: '0.55rem' }}>
                  <MainAddressRow
                    address={wallet.address}
                    isSmallScreen={isSmallScreen767}
                    copied={copiedAddress}
                    onCopied={() => {
                      setCopiedAddress(true);
                      setTimeout(() => setCopiedAddress(false), 1200);
                    }}
                  />
                </div>
                <div className="wh-stat-grid">
                  <div className="wh-stat">
                    <span className="wh-stat-label">Nonce</span>
                    <span className="wh-stat-value">{nextNonce ?? '—'}</span>
                  </div>
                  <div className="wh-stat">
                    <span className="wh-stat-label">Pin height</span>
                    <span className="wh-stat-value">{pinHeight ?? '—'}</span>
                  </div>
                  <div className="wh-stat">
                    <span className="wh-stat-label">Path</span>
                    <span className="wh-stat-value">
                      {wallet.pathType || '—'}
                      {wallet.wordCount ? ` · ${wallet.wordCount}w` : ''}
                    </span>
                  </div>
                </div>
                <p className="wh-hint" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
                  Keys stay in the signing worker this session. Use <strong>Backup</strong> to encrypt.
                </p>
              </div>
            )}

            {overviewTab === 'liquid' && (() => {
              const mintCap = computeWliqMintAvailable(l1Vault);
              const liquidNum = Number(mintCap.liquid);
              const claimNum = Number(mintCap.claim || 0);
              const usedNum = liquidNum + claimNum;
              const refreshAll = () => {
                if (typeof onRefreshL1Vault === 'function') onRefreshL1Vault();
                (async () => {
                  try {
                    if (!LOCAL_WWART?.address || !window.ethereum) return;
                    const { BrowserProvider, Contract, formatUnits } = await import('ethers-v6');
                    const provider = new BrowserProvider(window.ethereum);
                    const signer = await provider.getSigner();
                    const me = await signer.getAddress();
                    const token = new Contract(
                      LOCAL_WWART.address,
                      ['function balanceOf(address) view returns (uint256)'],
                      provider,
                    );
                    const bal = await token.balanceOf(me);
                    setMmWwartBal(formatUnits(bal, 18));
                  } catch {
                    /* */
                  }
                })();
              };
              return (
              <div className="wh-card wh-card--inset">
                {/* Compact summary — always visible */}
                <div className="wh-stat-grid" style={{ marginBottom: '0.5rem' }}>
                  <div className="wh-stat">
                    <span className="wh-stat-label">Available</span>
                    <span className="wh-stat-value">{mintCap.available}</span>
                  </div>
                  <div className="wh-stat">
                    <span className="wh-stat-label">Used</span>
                    <span className="wh-stat-value">
                      {usedNum.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </span>
                  </div>
                  <div className="wh-stat">
                    <span className="wh-stat-label">Capacity</span>
                    <span className="wh-stat-value">{mintCap.capacity}</span>
                  </div>
                </div>
                <div className="wh-inline-burn" style={{ marginBottom: '0.5rem' }}>
                  <button
                    type="button"
                    className="btn secondary small"
                    onClick={refreshAll}
                    disabled={propLoading}
                  >
                    Refresh
                  </button>
                  {!mintCap.hasBacking && (
                    <span className="wh-hint">Lock WART first (sub → vault sweep)</span>
                  )}
                </div>

                <details className="wh-details">
                  <summary>Capacity details</summary>
                  <div className="wh-details-body">
                    <p className="wh-hint">
                      Shared pool: locked WART → capacity. Mint uses capacity (Used ↑). Depositing
                      MetaMask wWART back is inventory only (Used unchanged). Burn frees Available.
                      Release locked WART (Bridge) is optional and separate from burn.
                    </p>
                    <div className="wh-stat-grid">
                      <div className="wh-stat">
                        <span className="wh-stat-label">WLIQ held</span>
                        <span className="wh-stat-value">{mintCap.liquid}</span>
                      </div>
                      <div className="wh-stat">
                        <span className="wh-stat-label">wWART claims</span>
                        <span className="wh-stat-value">{mintCap.claim || '0'}</span>
                      </div>
                      <div className="wh-stat">
                        <span className="wh-stat-label">MetaMask wWART</span>
                        <span className="wh-stat-value">
                          {mmWwartBal != null
                            ? Number(mmWwartBal).toLocaleString(undefined, {
                                maximumFractionDigits: 4,
                              })
                            : '—'}
                        </span>
                      </div>
                      <div className="wh-stat">
                        <span className="wh-stat-label">Locked WART?</span>
                        <span className="wh-stat-value">
                          {mintCap.hasLockedWart ? 'yes' : 'no'}
                        </span>
                      </div>
                    </div>
                  </div>
                </details>

                <details className="wh-details">
                  <summary>Mint (uses capacity)</summary>
                  <div className="wh-details-body">
                    <div className="wh-inline-burn" style={{ marginBottom: '0.5rem', gap: '0.5rem' }}>
                      <span className="wh-hint">Mint as:</span>
                      <button
                        type="button"
                        className={`btn small ${mintTokenChoice === 'wliq' ? 'primary' : 'secondary'}`}
                        onClick={() => setMintTokenChoice('wliq')}
                      >
                        {SHARE_TOKEN.symbol}
                      </button>
                      <button
                        type="button"
                        className={`btn small ${mintTokenChoice === 'wwart' ? 'primary' : 'secondary'}`}
                        onClick={() => setMintTokenChoice('wwart')}
                      >
                        wWART
                      </button>
                    </div>
                    <p className="wh-hint">
                      {mintTokenChoice === 'wwart'
                        ? 'Needs locked WART. Shares available capacity with WLIQ. Caps to available; mirrors to MetaMask after rollup accept.'
                        : `${SHARE_TOKEN.symbol} share only (no MetaMask token). Same capacity pool.`}
                    </p>
                    <div className="wh-inline-burn">
                      <input
                        type="number"
                        step="any"
                        min="0"
                        placeholder={
                          mintCap.hasBacking ? `Max ${mintCap.available}` : 'No capacity'
                        }
                        value={mintWliqAmt}
                        onChange={(e) => setMintWliqAmt(e.target.value)}
                        className="input"
                      />
                      <button
                        type="button"
                        className="btn secondary small"
                        disabled={!mintCap.hasBacking || mintCap.remaining18 <= 0n}
                        onClick={() => setMintWliqAmt(mintCap.available)}
                      >
                        Max
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!mintWliqAmt || Number(mintWliqAmt) <= 0) return;
                          try {
                            const isWwart = mintTokenChoice === 'wwart';
                            let amtStr = String(mintWliqAmt).trim();
                            if (!mintCap.hasBacking || mintCap.remaining18 <= 0n) {
                              toast.error(
                                'No capacity — lock WART first. WLIQ/wWART share one pool.',
                              );
                              return;
                            }
                            if (isWwart && !mintCap.hasLockedWart) {
                              toast.error(
                                'wWART needs locked Warthog WART (sweep sub → vault first).',
                              );
                              return;
                            }
                            if (Number(amtStr) > Number(mintCap.available) + 1e-12) {
                              amtStr = mintCap.available;
                              setMintWliqAmt(amtStr);
                              toast(`Capped to ${amtStr} available`, { duration: 4000 });
                            }
                            if (!amtStr || Number(amtStr) <= 0) {
                              toast.error('Nothing available to mint');
                              return;
                            }
                            // Optimistic once BEFORE send so refresh after tx cannot double-add.
                            if (typeof onOptimisticShareMint === 'function') {
                              onOptimisticShareMint({
                                kind: isWwart ? 'wwart' : 'wliq',
                                amountHuman: amtStr,
                                direction: 'mint',
                              });
                            }
                            try {
                              await send(
                                isWwart
                                  ? {
                                      type: 'mint_wwart',
                                      amount: amtStr,
                                      // Bind claim to live L1 token so redeploys invalidate old capacity use
                                      tokenAddress: LOCAL_WWART?.address || undefined,
                                    }
                                  : {
                                      type: 'mint_liquid',
                                      amount: amtStr,
                                    },
                              );
                            } catch (sendErr) {
                              // Reverse optimistic bump
                              if (typeof onOptimisticShareMint === 'function') {
                                onOptimisticShareMint({
                                  kind: isWwart ? 'wwart' : 'wliq',
                                  amountHuman: amtStr,
                                  direction: 'burn',
                                });
                              }
                              throw sendErr;
                            }
                            if (!isWwart) {
                              toast.success(`Minted ${amtStr} ${SHARE_TOKEN.symbol} · capacity used`);
                            } else {
                              // Product path: rollup claim only. L1 ERC-20 arrives via voucher /
                              // authorized minter — never open-mint from the connected wallet.
                              let l1Note = `Claim +${amtStr} wWART (capacity used).`;
                              const allowOpen =
                                LOCAL_WWART?.openMint === true && LOCAL_WWART?.address;
                              if (allowOpen && window.ethereum) {
                                try {
                                  const { BrowserProvider, Contract, parseUnits, formatUnits } =
                                    await import('ethers-v6');
                                  const provider = new BrowserProvider(window.ethereum);
                                  const signer = await provider.getSigner();
                                  const me = await signer.getAddress();
                                  const token = new Contract(
                                    LOCAL_WWART.address,
                                    [
                                      'function mint(address to, uint256 amount) external',
                                      'function balanceOf(address) view returns (uint256)',
                                    ],
                                    signer,
                                  );
                                  const tx = await token.mint(me, parseUnits(amtStr, 18));
                                  await tx.wait();
                                  const bal = await token.balanceOf(me);
                                  setMmWwartBal(formatUnits(bal, 18));
                                  l1Note += ` MetaMask ${formatUnits(bal, 18)}.`;
                                } catch (l1e) {
                                  console.warn('[mint_wwart] L1 mirror failed', l1e);
                                  l1Note += ' MetaMask mint failed.';
                                }
                              } else {
                                l1Note +=
                                  ' Not in MetaMask yet — L1 portals → Withdraw voucher, then Vouchers tab → Execute on L1.';
                              }
                              toast.success(l1Note, { duration: 9000 });
                            }
                          } catch (e) {
                            toast.error(e?.message || 'Mint failed');
                          }
                          setTimeout(refreshAll, 5000);
                        }}
                        className="btn primary small"
                        disabled={
                          propLoading ||
                          !mintWliqAmt ||
                          Number(mintWliqAmt) <= 0 ||
                          mintCap.remaining18 <= 0n
                        }
                      >
                        Mint {mintTokenChoice === 'wwart' ? 'wWART' : SHARE_TOKEN.symbol}
                      </button>
                    </div>
                  </div>
                </details>

                <details className="wh-details">
                  <summary>
                    Burn WLIQ (free capacity) · held {mintCap.liquid}
                  </summary>
                  <div className="wh-details-body">
                    <p className="wh-hint">
                      Burns rollup {SHARE_TOKEN.symbol} and frees shared capacity for new WLIQ or wWART mints.
                    </p>
                    <div className="wh-inline-burn">
                      <input
                        type="number"
                        step="any"
                        min="0"
                        placeholder={liquidNum > 0 ? `Burn ≤ ${mintCap.liquid}` : 'No WLIQ'}
                        value={burnAmt}
                        onChange={(e) => setBurnAmt(e.target.value)}
                        className="input"
                      />
                      <button
                        type="button"
                        className="btn secondary small"
                        disabled={mintCap.liquid18 <= 0n}
                        onClick={() => setBurnAmt(mintCap.liquid)}
                      >
                        Max
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!burnAmt) return;
                          try {
                            if (typeof onOptimisticShareMint === 'function') {
                              onOptimisticShareMint({
                                kind: 'wliq',
                                amountHuman: burnAmt,
                                direction: 'burn',
                              });
                            }
                            try {
                              await send({ type: 'burn_liquid', amount: burnAmt });
                            } catch (sendErr) {
                              if (typeof onOptimisticShareMint === 'function') {
                                onOptimisticShareMint({
                                  kind: 'wliq',
                                  amountHuman: burnAmt,
                                  direction: 'mint',
                                });
                              }
                              throw sendErr;
                            }
                            toast.success(`Burned ${burnAmt} ${SHARE_TOKEN.symbol} · capacity freed`);
                          } catch (e) {
                            toast.error(e?.message || 'Burn failed');
                          }
                          setTimeout(refreshAll, 4000);
                        }}
                        className="btn danger small"
                        disabled={!burnAmt || propLoading || mintCap.liquid18 <= 0n}
                      >
                        Burn {SHARE_TOKEN.symbol}
                      </button>
                    </div>
                  </div>
                </details>

                <details className="wh-details">
                  <summary>
                    Burn wWART claims (free capacity) · claims {mintCap.claim || '0'}
                  </summary>
                  <div className="wh-details-body">
                    <p className="wh-hint">
                      Backend frees <strong>Used</strong> capacity when you burn the claim.
                      Depositing MetaMask wWART first only restores rollup balance — it does not
                      free Available. After burn you may optionally <strong>Release</strong>{' '}
                      locked WART on Bridge (unlock collateral → Vault → main).
                    </p>
                    <div className="wh-inline-burn">
                      <input
                        type="number"
                        step="any"
                        min="0"
                        placeholder={
                          claimNum > 0 ? `Burn ≤ ${mintCap.claim}` : 'No wWART claims'
                        }
                        value={burnWwartAmt}
                        onChange={(e) => setBurnWwartAmt(e.target.value)}
                        className="input"
                      />
                      <button
                        type="button"
                        className="btn secondary small"
                        disabled={claimNum <= 0}
                        onClick={() => setBurnWwartAmt(mintCap.claim || '0')}
                      >
                        Max
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!burnWwartAmt || Number(burnWwartAmt) <= 0) return;
                          let amt = String(burnWwartAmt).trim();
                          if (Number(amt) > claimNum + 1e-12) {
                            amt = mintCap.claim;
                            setBurnWwartAmt(amt);
                          }
                          try {
                            if (typeof onOptimisticShareMint === 'function') {
                              onOptimisticShareMint({
                                kind: 'wwart',
                                amountHuman: amt,
                                direction: 'burn',
                              });
                            }
                            try {
                              await send({ type: 'burn_wwart', amount: amt });
                            } catch (sendErr) {
                              if (typeof onOptimisticShareMint === 'function') {
                                onOptimisticShareMint({
                                  kind: 'wwart',
                                  amountHuman: amt,
                                  direction: 'mint',
                                });
                              }
                              throw sendErr;
                            }
                            toast.success(
                              `Burned ${amt} wWART claim · capacity freed (same pool as WLIQ)`,
                              { duration: 6000 },
                            );
                          } catch (e) {
                            toast.error(e?.message || 'Burn wWART failed');
                          }
                          setTimeout(refreshAll, 4000);
                        }}
                        className="btn danger small"
                        disabled={!burnWwartAmt || propLoading || claimNum <= 0}
                      >
                        Burn wWART claims
                      </button>
                    </div>
                  </div>
                </details>
              </div>
              );
            })()}

            {overviewTab === 'tools' && (
              <div className="wh-card wh-card--inset">
                <p className="wh-muted" style={{ marginBottom: '0.5rem' }}>
                  Validate a Warthog address checksum.
                </p>
                <div className="wh-inline-burn">
                  <input
                    type="text"
                    value={validateAddr}
                    onChange={(e) => setValidateAddr(e.target.value.trim())}
                    placeholder="48-char Warthog address"
                    className="input"
                  />
                  <button type="button" onClick={handleValidateAddress} className="btn primary small">
                    Check
                  </button>
                </div>
                {validateResult && (
                  <div className="result">
                    <pre>{JSON.stringify(validateResult, null, 2)}</pre>
                  </div>
                )}

                <hr className="wh-divider" />
                <p className="wh-muted" style={{ marginBottom: '0.45rem' }}>
                  Named wallets (localStorage, encrypted — like WartBunker)
                </p>
                {walletName ? (
                  <p className="wh-hint">
                    Active tag: <strong>{walletName}</strong>
                  </p>
                ) : (
                  <p className="wh-hint">This session has no name tag yet — use Backup to save one.</p>
                )}
                <div className="button-group">
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() => {
                      setShowDownloadPrompt(true);
                      setPassword('');
                      setConfirmPassword('');
                      if (!walletName) setWalletName('');
                    }}
                  >
                    Save / rename
                  </button>
                  <button
                    type="button"
                    className="btn secondary small"
                    onClick={() => {
                      refreshSavedList();
                      setShowManageSaved(true);
                    }}
                  >
                    Manage saved ({savedEntries.length})
                  </button>
                  {walletName && (
                    <button
                      type="button"
                      className="btn danger small"
                      onClick={() => removeSavedWallet(walletName)}
                    >
                      Delete “{walletName}”
                    </button>
                  )}
                </div>

                {wallet.mnemonic && (
                  <details className="wh-tools-exp" style={{ marginTop: '1rem' }}>
                    <summary>Experimental: personal asset vault</summary>
                    <p className="wh-hint">
                      Separate from WART multi-sig vaults (use the <strong>Vault</strong> tab for those).
                    </p>
                    <PersonalVaultMvp
                      mainWallet={wallet}
                      mainMnemonic={wallet.mnemonic}
                      selectedNode={selectedNode}
                      l1Address={l1Address}
                      send={send}
                      sendTransaction={handleSendTransaction}
                      getWartTxProof={getWartTxProof}
                      fetchBalanceAndNonce={fetchBalanceAndNonce}
                      loading={propLoading}
                      setLoading={propSetLoading}
                    />
                  </details>
                )}
              </div>
            )}
          </div>
        )}

        {appTab === 'send' && (
          <div className="wh-card wh-card--inset wh-send-card">
            <div className="form-group">
              <label>To</label>
              <input
                type="text"
                value={toAddr}
                onChange={(e) => setToAddr(e.target.value.trim())}
                placeholder="Recipient (40 or 48 hex)"
                className="input"
              />
            </div>
            <div className="wh-row-2">
              <div className="form-group">
                <label>Amount (WART)</label>
                <div className="wh-inline-burn">
                  <input
                    type="text"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.trim())}
                    placeholder="e.g. 1"
                    className="input"
                  />
                  <button
                    type="button"
                    className="btn secondary small"
                    title="Use spendable balance"
                    onClick={() =>
                      setAmount(
                        String(spendableBalance ?? balance ?? '0'),
                      )
                    }
                  >
                    Max
                  </button>
                </div>
              </div>
              <div className="form-group">
                <label>Fee (optional)</label>
                <input
                  type="text"
                  value={fee}
                  onChange={(e) => setFee(e.target.value.trim())}
                  placeholder="node min if empty"
                  className="input"
                />
              </div>
            </div>
            <details className="wh-advanced">
              <summary>Advanced</summary>
              <div className="form-group">
                <label>Nonce override</label>
                <input
                  type="text"
                  value={nonceInput}
                  onChange={(e) => setNonceInput(e.target.value.trim())}
                  placeholder={`Auto: ${nextNonce ?? '…'}`}
                  className="input"
                />
              </div>
            </details>
            <button
              type="button"
              onClick={() => handleSendTransaction()}
              disabled={sending}
              className="btn primary small wh-primary-cta"
            >
              {sending ? 'Sending…' : 'Send WART'}
            </button>
            {sendResult && (
              <div className="result">
                <pre>{JSON.stringify(sendResult, null, 2)}</pre>
              </div>
            )}
          </div>
        )}

        {(appTab === 'subwallets' || appTab === 'vault') && wallet.mnemonic && (
          <SubWallet
            mainWallet={wallet}
            mainMnemonic={wallet.mnemonic}
            selectedNode={selectedNode}
            fetchBalanceAndNonce={fetchBalanceAndNonce}
            sendTransaction={handleSendTransaction}
            send={send}
            address={wallet.address}
            l1Address={l1Address}
            loading={propLoading}
            setLoading={propSetLoading}
            subWallets={subWallets}
            setSubWallets={setSubWallets}
            subIndex={subIndex}
            setSubIndex={setSubIndex}
            subDepositAmt={subDepositAmt}
            setSubDepositAmt={setSubDepositAmt}
            selectedSub={selectedSub}
            setSelectedSub={setSelectedSub}
            voucherPayload={voucherPayload}
            setVoucherPayload={setVoucherPayload}
            setWartToAddr={setToAddr}
            setWartAmount={setAmount}
            setWartFee={setFee}
            getWartTxProof={getWartTxProof}
            sentTransactions={sentTransactions}
            focusMode={appTab === 'vault' ? 'vault' : 'bridge'}
            l1Vault={l1Vault}
            mmWwartBal={mmWwartBal}
            onRefreshL1Vault={onRefreshL1Vault}
            onRefreshMmWwart={async () => {
              try {
                if (!LOCAL_WWART?.address || !window.ethereum) return;
                const { BrowserProvider, Contract, formatUnits } = await import('ethers-v6');
                const provider = new BrowserProvider(window.ethereum);
                const accounts = await provider.send('eth_accounts', []);
                if (!accounts?.length) return;
                const token = new Contract(
                  LOCAL_WWART.address,
                  ['function balanceOf(address) view returns (uint256)'],
                  provider,
                );
                const bal = await token.balanceOf(accounts[0]);
                setMmWwartBal(formatUnits(bal, 18));
              } catch {
                /* ignore */
              }
            }}
          />
        )}

        {(appTab === 'subwallets' || appTab === 'vault') && !wallet.mnemonic && (
          <div className="wh-card wh-card--inset">
            <p className="wh-muted" style={{ marginBottom: 0 }}>
              Bridge vaults need a seed-based wallet. Log in with a seed phrase (not private-key-only
              import).
            </p>
          </div>
        )}

        {appTab === 'activity' && (
          <div className="wh-panel-stack">
            <TransactionHistory address={wallet.address} node={selectedNode} />

            {sentTransactions.length > 0 && (
              <div className="sw-card activity-shell">
                <div className="sw-card-head">
                  <h4 className="sw-card-title">
                    Session sends
                    {isPollingTx ? <span className="wh-pulse" /> : null}
                  </h4>
                  <button type="button" onClick={updateTxStatuses} className="btn secondary small">
                    Refresh status
                  </button>
                </div>
                <ul className="activity-list">
                  {sentTransactions.map((tx, index) => (
                    <li key={index} className="sw-card activity-tx-card">
                      <div className="sw-card-meta">
                        <div className="sw-meta-row">
                          <span className="sw-meta-k">Amount</span>
                          <span className="sw-meta-v">{tx.amount} WART</span>
                        </div>
                        <div className="sw-meta-row">
                          <span className="sw-meta-k">To</span>
                          <button
                            type="button"
                            className="sw-meta-v mono sw-link"
                            title={tx.toAddr}
                            onClick={() => copyToClipboard(tx.toAddr, setCopiedToAddr)}
                          >
                            {shortHex(tx.toAddr)}
                            {copiedToAddr === tx.toAddr ? ' ✓' : ''}
                          </button>
                        </div>
                        <div className="sw-meta-row">
                          <span className="sw-meta-k">Status</span>
                          <span className="sw-meta-v">
                            {tx.status}
                            {tx.confirmations ? ` · ${tx.confirmations} conf` : ''}
                          </span>
                        </div>
                        <div className="sw-meta-row">
                          <span className="sw-meta-k">Nonce</span>
                          <span className="sw-meta-v">{tx.nonce ?? '—'}</span>
                        </div>
                        {tx.timestamp ? (
                          <div className="sw-meta-row">
                            <span className="sw-meta-k">When</span>
                            <span className="sw-meta-v">{tx.timestamp}</span>
                          </div>
                        ) : null}
                        {tx.txHash ? (
                          <div className="sw-meta-row">
                            <span className="sw-meta-k">Tx</span>
                            <button
                              type="button"
                              className="sw-meta-v mono sw-link"
                              title={tx.txHash}
                              onClick={() => copyToClipboard(tx.txHash, setCopiedTxId)}
                            >
                              {shortHex(tx.txHash, 10, 8)}
                              {copiedTxId === tx.txHash ? ' ✓' : ''}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {failedTransactions.length > 0 && (
              <div className="sw-card activity-shell">
                <div className="sw-card-head">
                  <h4 className="sw-card-title">Failed this session</h4>
                </div>
                <ul className="activity-list">
                  {failedTransactions.map((tx, index) => (
                    <li key={index} className="sw-card activity-tx-card is-out">
                      <div className="sw-card-meta">
                        <div className="sw-meta-row">
                          <span className="sw-meta-k">Amount</span>
                          <span className="sw-meta-v">{tx.amount} WART</span>
                        </div>
                        <div className="sw-meta-row">
                          <span className="sw-meta-k">To</span>
                          <span className="sw-meta-v mono">{shortHex(tx.toAddr)}</span>
                        </div>
                        <div className="sw-meta-row">
                          <span className="sw-meta-k">Error</span>
                          <span className="sw-meta-v">{tx.error || '—'}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="warthog-section">
      {isLoggedIn && (
        <div className="wh-title-row">
          <h2>Warthog Wallet</h2>
          <p className="wh-subtitle">Native WART · bridge vaults · multi-sig</p>
        </div>
      )}

      {deferredPrompt && (
        <button type="button" onClick={handleInstallClick} className="btn primary small wh-install">
          Install app
        </button>
      )}

      {!isLoggedIn && renderAuthGate()}
      {isLoggedIn && wallet && renderDashboard()}

      {error && isLoggedIn && (
        <div className="error" role="alert">
          <strong>Error:</strong> {error}
        </div>
      )}

      {showDownloadPrompt && wallet && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2>Save named wallet</h2>
            <p className="wh-muted">
              Encrypts keys into this browser under a name (like WartBunker). Also download a file if you want.
            </p>
            <div className="sw-card-meta" style={{ marginBottom: '0.75rem' }}>
              <MainAddressRow
                address={wallet.address}
                isSmallScreen={isSmallScreen767}
                copied={copiedAddress}
                onCopied={() => {
                  setCopiedAddress(true);
                  setTimeout(() => setCopiedAddress(false), 1200);
                }}
              />
            </div>
            <div className="form-group">
              <label>Wallet name</label>
              <input
                type="text"
                value={walletName}
                onChange={(e) => setWalletName(e.target.value)}
                placeholder="e.g. Main, Bridge-test"
                className="input"
                autoComplete="off"
              />
            </div>
            <div className="form-group">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Encrypt with password"
                className="input"
              />
            </div>
            <div className="form-group">
              <label>Confirm password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repeat password"
                className="input"
              />
            </div>
            <div className="button-group">
              <button
                type="button"
                className="btn primary small"
                onClick={async () => {
                  if (password !== confirmPassword) {
                    setError('Passwords do not match');
                    return;
                  }
                  setError(null);
                  if (await saveNamedWallet(wallet, walletName, password)) {
                    setShowDownloadPrompt(false);
                    setPassword('');
                    setConfirmPassword('');
                    setError(null);
                  }
                }}
              >
                Save named
              </button>
              <button
                type="button"
                onClick={() => {
                  if (downloadWallet(wallet)) {
                    setShowDownloadPrompt(false);
                    setPassword('');
                    setConfirmPassword('');
                  }
                }}
                className="btn secondary small"
              >
                Download file
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowDownloadPrompt(false);
                  setPassword('');
                  setConfirmPassword('');
                  setError(null);
                }}
                className="btn secondary small"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showManageSaved && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2>Manage saved wallets</h2>
            <p className="wh-muted">Delete encrypted copies from this browser only. Lock does not delete.</p>
            {savedEntries.length === 0 ? (
              <p className="wh-hint">No saved wallets.</p>
            ) : (
              <ul className="wh-manage-list">
                {savedEntries.map((e) => (
                  <li key={e.id} className="wh-manage-row">
                    <span>
                      <strong>{e.label}</strong>
                      <span className="wh-hint"> · {e.kind}</span>
                    </span>
                    <button
                      type="button"
                      className="btn danger small"
                      onClick={() => removeSavedWallet(e.id)}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="btn secondary small"
              onClick={() => setShowManageSaved(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {showModal && walletData && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2>You&apos;re in — optional backup</h2>
            <p className="warning">
              Session is unlocked. Write down any seed shown. Do not share keys.
            </p>
            {walletData.mnemonic && (
              <div className="wh-seed-reveal">
                <strong>Seed phrase</strong>
                <p className="wh-seed-text">{walletData.mnemonic}</p>
              </div>
            )}
            <div className="sw-card-meta" style={{ marginBottom: '0.65rem' }}>
              <MainAddressRow
                address={walletData.address}
                isSmallScreen={isSmallScreen767}
                copied={copiedAddress}
                onCopied={() => {
                  setCopiedAddress(true);
                  setTimeout(() => setCopiedAddress(false), 1200);
                }}
              />
            </div>
            <details className="wh-advanced">
              <summary>Show private / public keys</summary>
              <p className="mono">
                <strong>Private:</strong> {walletData.privateKey}
              </p>
              <p className="mono">
                <strong>Public:</strong> {walletData.publicKey}
              </p>
            </details>
            <div className="form-group">
              <label>Wallet name</label>
              <input
                type="text"
                value={walletName}
                onChange={(e) => setWalletName(e.target.value)}
                placeholder="e.g. Main, Bridge-test"
                className="input"
                autoComplete="off"
              />
            </div>
            <div className="form-group">
              <label>Password to encrypt backup</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Choose a strong password"
                className="input"
              />
            </div>
            <div className="form-group">
              <label>Confirm password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repeat password"
                className="input"
              />
            </div>
            <label className="wh-check">
              <input
                type="checkbox"
                checked={saveWalletConsent}
                onChange={(e) => setSaveWalletConsent(e.target.checked)}
              />
              Save named encrypted copy in this browser
            </label>
            <div className="button-group">
              <button
                type="button"
                className="btn primary small"
                onClick={async () => {
                  if (!password) {
                    setError('Password required to save encrypted backup.');
                    return;
                  }
                  if (password !== confirmPassword) {
                    setError('Passwords do not match');
                    return;
                  }
                  if (!saveWalletConsent) {
                    setError('Check the consent box to save to this browser.');
                    return;
                  }
                  setError(null);
                  if (await saveWallet(walletData)) {
                    setShowModal(false);
                    setWalletData(null);
                    setConsentToClose(false);
                  }
                }}
              >
                Save named
              </button>
              <button
                type="button"
                className="btn secondary small"
                onClick={() => {
                  if (!password) {
                    setError('Password required to download encrypted file.');
                    return;
                  }
                  setError(null);
                  if (downloadWallet(walletData)) {
                    setShowModal(false);
                    setWalletData(null);
                    setConsentToClose(false);
                  }
                }}
              >
                Download file
              </button>
            </div>
            <label className="wh-check">
              <input
                type="checkbox"
                checked={consentToClose}
                onChange={(e) => setConsentToClose(e.target.checked)}
              />
              Continue without encrypted backup (session stays open)
            </label>
            <button
              type="button"
              disabled={!consentToClose}
              className="btn danger small"
              onClick={() => {
                setShowModal(false);
                setWalletData(null);
                setPassword('');
                setConfirmPassword('');
                setSaveWalletConsent(false);
                setConsentToClose(false);
                setError(null);
              }}
            >
              Continue
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default WarthogWallet;
