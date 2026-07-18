// src/components/WarthogWallet.jsx — streamlined Warthog native wallet shell
import React, { useState, useEffect } from 'react';
import CryptoJS from 'crypto-js';
import { toast } from 'react-hot-toast';
import TransactionHistory from './TransactionHistory';
import SubWallet from './SubWallet';
import PersonalVaultMvp from './PersonalVaultMvp';
import '../styles/warthog.css';
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

const AUTH_TABS = [
  { id: 'saved', label: 'Saved' },
  { id: 'derive', label: 'Seed phrase' },
  { id: 'create', label: 'Create' },
  { id: 'import', label: 'Private key' },
  { id: 'login', label: 'Wallet file' },
];

/** Known throwaway phrase for local UI / bridge testing only — never use with real funds. */
const TEST_SEED_PHRASE =
  'demise wear federal fan flee oven plug accident know buffalo kingdom orange';

const APP_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'send', label: 'Send' },
  { id: 'subwallets', label: 'Sub-wallets' },
  { id: 'vault', label: 'Vault' },
  { id: 'activity', label: 'Activity' },
];

function shortHex(value, head = 8, tail = 6) {
  if (!value || typeof value !== 'string') return '—';
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
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
  const [walletAction, setWalletAction] = useState(() =>
    typeof window !== 'undefined' && listWalletEntries().length > 0 ? 'saved' : 'derive',
  );
  const [error, setError] = useState(null);
  const [password, setPassword] = useState('');
  const [saveWalletConsent, setSaveWalletConsent] = useState(false);
  // Prefer Saved list on first paint (not the separate "Unlock saved wallet" card)
  const [showPasswordPrompt, setShowPasswordPrompt] = useState(false);
  const [uploadedFile, setUploadedFile] = useState(null);
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
      return localStorage.getItem('selectedNode') || DEFAULT_NODE_URL;
    }
    return DEFAULT_NODE_URL;
  });
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

  useEffect(() => {
    localStorage.setItem('selectedNode', selectedNode);
  }, [selectedNode]);

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
    if (!wallet?.address || subWallets.length === 0) return;
    try {
      const secret = subWalletStorageSecret(wallet.address);
      const encrypted = CryptoJS.AES.encrypt(JSON.stringify(subWallets), secret).toString();
      localStorage.setItem(`warthogSubWallets:${wallet.address.toLowerCase()}`, encrypted);
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

  const handleWalletAction = async () => {
    setError(null);
    setIsWalletProcessed(false);

    if (walletAction === 'login' && !uploadedFile) {
      setError('Upload warthog_wallet.txt, or switch to Seed phrase login');
      return;
    }

    if (walletAction === 'login') {
      await loadWallet();
      return;
    }

    if (walletAction === 'derive' && !mnemonic.trim()) {
      setError('Please enter your 12 or 24-word seed phrase');
      return;
    }

    if (walletAction === 'import' && !privateKeyInput) {
      setError('Please enter a private key');
      return;
    }

    if (walletAction === 'derive') {
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
      if (walletAction === 'create') {
        data = await generateWallet(Number(wordCount), pathType);
      } else if (walletAction === 'derive') {
        data = await deriveWallet(mnemonic, Number(wordCount), pathType);
      } else if (walletAction === 'import') {
        data = await importFromPrivateKey(privateKeyInput);
      } else {
        setError(`Unknown wallet action: ${walletAction}`);
        return;
      }

      await activateWallet(data);
      setWalletData(data);
      // Only show backup modal when we have new material worth backing up
      if (data.mnemonic || walletAction === 'import' || walletAction === 'create') {
        setShowModal(true);
        setConsentToClose(false);
      }
      setMnemonic('');
      setPrivateKeyInput('');
    } catch (err) {
      const raw = err?.message || String(err);
      let errorMessage = raw || `Failed to ${walletAction} wallet`;
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

  const selectAuthTab = (id) => {
    setWalletAction(id);
    setError(null);
    setMnemonic('');
    setPrivateKeyInput('');
    setUploadedFile(null);
    setPassword('');
    setConfirmPassword('');
    setIsWalletProcessed(false);
    if (id === 'saved') refreshSavedList();
  };

  const networkBadgeClass = isDefiNode(selectedNode)
    ? 'network-badge network-badge--defi'
    : 'network-badge network-badge--main';

  const renderSavedWalletPicker = () => (
    <>
      {savedEntries.length === 0 ? (
        <p className="wh-muted">
          No named wallets in this browser yet. Log in with a seed, then save with a name + password
          (same idea as WartBunker).
        </p>
      ) : (
        <>
          <p className="wh-muted" style={{ marginBottom: '0.5rem' }}>
            Select a saved account, enter its password, unlock.
          </p>
          <div className="wh-saved-list" role="listbox" aria-label="Saved wallets">
            {savedEntries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="option"
                aria-selected={selectedSavedId === entry.id}
                className={`wh-saved-card ${selectedSavedId === entry.id ? 'is-selected' : ''}`}
                onClick={() => {
                  setSelectedSavedId(entry.id);
                  setWalletName(entry.kind === 'named' ? entry.id : '');
                  setError(null);
                }}
              >
                <span className="wh-saved-card__name">{entry.label}</span>
                <span className="wh-saved-card__meta">
                  {entry.kind === 'legacy' ? 'legacy slot' : 'named'}
                </span>
              </button>
            ))}
          </div>
          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Decrypt password"
              className="input"
              onKeyDown={(e) => e.key === 'Enter' && loadWallet()}
              autoComplete="current-password"
            />
          </div>
          <div className="button-group">
            <button
              type="button"
              className="btn primary small"
              onClick={loadWallet}
              disabled={!selectedSavedId || !password}
            >
              Unlock
            </button>
            {selectedSavedId && (
              <button
                type="button"
                className="btn danger small"
                onClick={() => removeSavedWallet(selectedSavedId)}
                title="Permanently delete this encrypted copy from the browser"
              >
                Delete saved
              </button>
            )}
          </div>
        </>
      )}
    </>
  );

  /* ─── Auth / unlock gate ─── */
  const renderAuthGate = () => (
    <div className="wh-auth">
      {showPasswordPrompt && !wallet && (
        <div className="wh-card wh-card--unlock">
          <h3>Unlock saved wallet</h3>
          <p className="wh-muted">
            {selectedSavedId && selectedSavedId !== '__legacy__'
              ? `Account “${selectedSavedId}”`
              : selectedSavedId === '__legacy__'
                ? 'Legacy default wallet'
                : 'Encrypted wallet found in this browser'}
          </p>
          {savedEntries.length > 1 && (
            <div className="form-group">
              <label>Account</label>
              <select
                className="input"
                value={selectedSavedId}
                onChange={(e) => {
                  const id = e.target.value;
                  setSelectedSavedId(id);
                  setWalletName(id === '__legacy__' ? '' : id);
                }}
              >
                {savedEntries.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Decrypt password"
              className="input"
              onKeyDown={(e) => e.key === 'Enter' && loadWallet()}
            />
          </div>
          <div className="form-group">
            <label>Or upload wallet file</label>
            <input type="file" accept=".txt" onChange={handleFileUpload} className="input" />
          </div>
          <div className="button-group">
            <button type="button" onClick={loadWallet} className="btn primary small">
              Unlock
            </button>
            <button
              type="button"
              onClick={() => {
                setShowPasswordPrompt(false);
                setPassword('');
                setUploadedFile(null);
                setWalletAction(savedEntries.length ? 'saved' : 'derive');
              }}
              className="btn secondary small"
            >
              Use another method
            </button>
            {selectedSavedId && (
              <button
                type="button"
                className="btn danger small"
                onClick={() => removeSavedWallet(selectedSavedId)}
              >
                Delete saved
              </button>
            )}
          </div>
        </div>
      )}

      {(!showPasswordPrompt || wallet) && !isLoggedIn && (
        <div className="wh-card">
          <div className="wh-auth-tabs" role="tablist">
            {AUTH_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={walletAction === tab.id}
                className={`wh-auth-tab ${walletAction === tab.id ? 'is-active' : ''}`}
                onClick={() => selectAuthTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="wh-auth-panel">
            {walletAction === 'saved' && renderSavedWalletPicker()}

            {walletAction === 'derive' && (
              <>
                <div className="form-group">
                  <label>Seed phrase (12 or 24 words)</label>
                  <textarea
                    value={mnemonic}
                    onChange={(e) => setMnemonic(e.target.value)}
                    placeholder="Paste words separated by spaces"
                    className="input wh-seed-input"
                    rows={3}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <button
                  type="button"
                  className="btn danger small"
                  onClick={() => {
                    setMnemonic(TEST_SEED_PHRASE);
                    setWordCount('12');
                    setPathType('hardened');
                    setError(null);
                  }}
                >
                  Fill test seed
                </button>
                <div className="wh-row-2">
                  <div className="form-group">
                    <label>Word count</label>
                    <select value={wordCount} onChange={(e) => setWordCount(e.target.value)} className="input">
                      <option value="12">12 words</option>
                      <option value="24">24 words</option>
                    </select>
                  </div>
                  {wordCount === '12' && (
                    <div className="form-group">
                      <label>Derivation path</label>
                      <select value={pathType} onChange={(e) => setPathType(e.target.value)} className="input">
                        <option value="hardened">Hardened m/44&apos;/2070&apos;/0&apos;/0/0</option>
                        <option value="non-hardened">Non-hardened m/44&apos;/2070&apos;/0/0/0</option>
                      </select>
                    </div>
                  )}
                </div>
                <p className="wh-hint">
                  Unlocks this session immediately. Optional encrypted backup afterward. Wrong path → wrong address — try the other if balance looks empty.
                  Test seed hardened address starts with <code>0b5de62d…</code>.
                </p>
              </>
            )}

            {walletAction === 'create' && (
              <>
                <p className="wh-muted">Generate a fresh seed and address. Write the seed down before you continue.</p>
                <div className="wh-row-2">
                  <div className="form-group">
                    <label>Word count</label>
                    <select value={wordCount} onChange={(e) => setWordCount(e.target.value)} className="input">
                      <option value="12">12 words</option>
                      <option value="24">24 words</option>
                    </select>
                  </div>
                  {wordCount === '12' && (
                    <div className="form-group">
                      <label>Derivation path</label>
                      <select value={pathType} onChange={(e) => setPathType(e.target.value)} className="input">
                        <option value="hardened">Hardened (recommended)</option>
                        <option value="non-hardened">Non-hardened</option>
                      </select>
                    </div>
                  )}
                </div>
              </>
            )}

            {walletAction === 'import' && (
              <div className="form-group">
                <label>Private key (64 hex chars)</label>
                <input
                  type="password"
                  value={privateKeyInput}
                  onChange={(e) => setPrivateKeyInput(e.target.value.replace(/\s/g, ''))}
                  placeholder="Hex private key"
                  className="input"
                  autoComplete="off"
                />
              </div>
            )}

            {walletAction === 'login' && (
              <>
                <div className="form-group">
                  <label>Wallet file (warthog_wallet.txt)</label>
                  <input type="file" accept=".txt" onChange={handleFileUpload} className="input" />
                  {uploadedFile && <p className="wh-hint">File loaded — enter password and unlock.</p>}
                </div>
                <div className="form-group">
                  <label>Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Decrypt password"
                    className="input"
                  />
                </div>
              </>
            )}

            {walletAction !== 'saved' && (
              <button
                type="button"
                onClick={handleWalletAction}
                className="btn primary small wh-primary-cta"
                disabled={walletBusy}
              >
                {walletBusy
                  ? 'Working…'
                  : walletAction === 'create'
                    ? 'Create wallet'
                    : walletAction === 'derive'
                      ? 'Log in with seed'
                      : walletAction === 'import'
                        ? 'Import key'
                        : 'Unlock file'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );

  /* ─── Logged-in shell ─── */
  const renderDashboard = () => (
    <div className="wh-dash">
      <header className="wh-header">
        <div className="wh-header-main">
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
          <div className="wh-header-id-col">
            {walletName ? (
              <span className="wh-wallet-name" title="Saved account name">
                {walletName}
              </span>
            ) : null}
            <button
              type="button"
              className="wh-address-chip"
              title={wallet.address}
              onClick={() => {
                navigator.clipboard?.writeText(wallet.address);
                setCopiedAddress(true);
                setTimeout(() => setCopiedAddress(false), 1200);
              }}
            >
              {copiedAddress ? 'Copied!' : shortHex(wallet.address, 10, 8)}
            </button>
          </div>
        </div>
        <div className="wh-header-tools">
          <span className={networkBadgeClass}>
            {isDefiNode(selectedNode) ? 'DeFi' : 'Mainnet'}
          </span>
          <select
            value={selectedNode}
            onChange={(e) => setSelectedNode(e.target.value)}
            className="input wh-node-select"
            title="RPC node"
          >
            {NODE_OPTIONS.map((node) => (
              <option key={node.url} value={node.url}>
                {node.name}
              </option>
            ))}
          </select>
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
      </header>

      <nav className="wh-app-tabs" role="tablist" aria-label="Main">
        {APP_TABS.map((tab) => {
          const disabled = tab.id === 'subwallets' && !wallet.mnemonic;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              disabled={disabled}
              title={disabled ? 'Seed phrase required for sub-wallets' : undefined}
              aria-selected={appTab === tab.id}
              className={`wh-app-tab ${appTab === tab.id ? 'is-active' : ''}`}
              onClick={() => !disabled && setAppTab(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

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
                <div className="wh-stat-grid">
                  <div className="wh-stat">
                    <span className="wh-stat-label">Address</span>
                    <button
                      type="button"
                      className="wh-stat-value mono wh-linkish"
                      title="Copy address"
                      onClick={() => {
                        navigator.clipboard?.writeText(wallet.address);
                        setCopiedAddress(true);
                        setTimeout(() => setCopiedAddress(false), 1200);
                      }}
                    >
                      {copiedAddress ? 'Copied!' : wallet.address}
                    </button>
                  </div>
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
              return (
              <div className="wh-card wh-card--inset">
                <div className="wh-stat-grid" style={{ marginBottom: '0.65rem' }}>
                  <div className="wh-stat">
                    <span className="wh-stat-label">Available to mint</span>
                    <span className="wh-stat-value">
                      {mintCap.available} {SHARE_TOKEN.symbol}
                    </span>
                  </div>
                  <div className="wh-stat">
                    <span className="wh-stat-label">Your balance</span>
                    <span className="wh-stat-value">
                      {mintCap.liquid} {SHARE_TOKEN.symbol}
                    </span>
                  </div>
                  <div className="wh-stat">
                    <span className="wh-stat-label">Backing capacity</span>
                    <span className="wh-stat-value">
                      {mintCap.capacity} {SHARE_TOKEN.symbol}
                    </span>
                  </div>
                </div>
                <p className="wh-muted">
                  {mintCap.hasBacking
                    ? `Mint up to available (capacity − already minted). Backing from spoofed wWART / L1 portals.`
                    : `No vault backing yet — rollup allows a small demo mint (≤ 1 ${SHARE_TOKEN.symbol}). Sweep sub → vault first for real capacity.`}
                  {' '}
                  {typeof onRefreshL1Vault === 'function' && (
                    <button
                      type="button"
                      className="wh-linkish"
                      onClick={() => onRefreshL1Vault()}
                      disabled={propLoading}
                    >
                      Refresh vault
                    </button>
                  )}
                </p>
                <div className="wh-inline-burn">
                  <input
                    type="number"
                    step="any"
                    min="0"
                    placeholder={
                      mintCap.hasBacking
                        ? `Max ${mintCap.available}`
                        : `Mint ${SHARE_TOKEN.symbol}`
                    }
                    value={mintWliqAmt}
                    onChange={(e) => setMintWliqAmt(e.target.value)}
                    className="input"
                  />
                  <button
                    type="button"
                    className="btn secondary small"
                    disabled={!mintCap.hasBacking || mintCap.remaining18 <= 0n}
                    title="Fill available mint amount"
                    onClick={() => setMintWliqAmt(mintCap.available)}
                  >
                    Max
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!mintWliqAmt || Number(mintWliqAmt) <= 0) return;
                      if (
                        mintCap.hasBacking &&
                        Number(mintWliqAmt) > Number(mintCap.available) + 1e-12
                      ) {
                        toast.error(
                          `Only ${mintCap.available} ${SHARE_TOKEN.symbol} available to mint`,
                        );
                        setMintWliqAmt(mintCap.available);
                        return;
                      }
                      try {
                        await send({
                          type: 'mint_liquid',
                          amount: String(mintWliqAmt).trim(),
                        });
                        toast.success(`Mint submitted — ${mintWliqAmt} ${SHARE_TOKEN.symbol}`);
                      } catch (e) {
                        toast.error(e?.message || 'Mint failed');
                      }
                      if (typeof onRefreshL1Vault === 'function') {
                        setTimeout(() => onRefreshL1Vault(), 4000);
                      }
                    }}
                    className="btn primary small"
                    disabled={
                      propLoading ||
                      !mintWliqAmt ||
                      Number(mintWliqAmt) <= 0 ||
                      (mintCap.hasBacking && mintCap.remaining18 <= 0n)
                    }
                  >
                    Mint {SHARE_TOKEN.symbol}
                  </button>
                </div>
                {mintCap.hasBacking && mintCap.remaining18 <= 0n && (
                  <p className="wh-hint">
                    Fully minted against current backing — burn {SHARE_TOKEN.symbol} or add more
                    vault collateral to mint again.
                  </p>
                )}
                <div className="wh-inline-burn">
                  <input
                    type="number"
                    step="any"
                    min="0"
                    placeholder={
                      liquidNum > 0
                        ? `Burn ≤ ${mintCap.liquid}`
                        : `Burn ${SHARE_TOKEN.symbol}`
                    }
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
                      await send({ type: 'burn_liquid', amount: burnAmt });
                      if (typeof onRefreshL1Vault === 'function') {
                        setTimeout(() => onRefreshL1Vault(), 4000);
                      }
                    }}
                    className="btn danger small"
                    disabled={!burnAmt || propLoading || mintCap.liquid18 <= 0n}
                  >
                    Burn {SHARE_TOKEN.symbol}
                  </button>
                </div>
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

        {appTab === 'subwallets' && wallet.mnemonic && (
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
          />
        )}

        {appTab === 'subwallets' && !wallet.mnemonic && (
          <div className="wh-card wh-card--inset">
            <p className="wh-muted" style={{ marginBottom: 0 }}>
              Sub-wallets need a seed-based wallet. Log in with a seed phrase (not private-key-only import).
            </p>
          </div>
        )}

        {appTab === 'vault' && (
          <div className="wh-panel-stack">
            <p className="wh-hint" style={{ marginTop: 0 }}>
              Native token + personal vault wizard. For the bridge multi-sig vault, use{' '}
              <button type="button" className="wh-linkish" onClick={() => setAppTab('subwallets')}>
                Sub-wallets
              </button>
              .
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
          </div>
        )}

        {appTab === 'activity' && (
          <div className="wh-panel-stack">
            <TransactionHistory address={wallet.address} node={selectedNode} />

            {sentTransactions.length > 0 && (
              <div className="wh-card wh-card--inset">
                <div className="wh-section-head">
                  <h3>Session sends {isPollingTx && <span className="wh-pulse" />}</h3>
                  <button type="button" onClick={updateTxStatuses} className="btn secondary small">
                    Refresh status
                  </button>
                </div>
                <ul className="wh-tx-list">
                  {sentTransactions.map((tx, index) => (
                    <li key={index} className="tx-log-item">
                      <p>
                        <strong>{tx.amount}</strong> WART →{' '}
                        <button
                          type="button"
                          className="wh-linkish"
                          onClick={() => copyToClipboard(tx.toAddr, setCopiedToAddr)}
                        >
                          {isSmallScreen767 ? shortHex(tx.toAddr) : tx.toAddr}
                          {copiedToAddr === tx.toAddr ? ' ✓' : ''}
                        </button>
                      </p>
                      <p className="wh-muted">
                        {tx.timestamp} · nonce {tx.nonce} · {tx.status}
                        {tx.confirmations ? ` (${tx.confirmations} conf)` : ''}
                      </p>
                      <p>
                        <button
                          type="button"
                          className="wh-linkish mono"
                          onClick={() => copyToClipboard(tx.txHash, setCopiedTxId)}
                        >
                          {shortHex(tx.txHash, 12, 8)}
                          {copiedTxId === tx.txHash ? ' ✓' : ''}
                        </button>
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {failedTransactions.length > 0 && (
              <div className="wh-card wh-card--inset">
                <h3>Failed this session</h3>
                <ul className="wh-tx-list">
                  {failedTransactions.map((tx, index) => (
                    <li key={index} className="tx-log-item">
                      <p>
                        {tx.amount} → {shortHex(tx.toAddr)} · {tx.error}
                      </p>
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
      <div className="wh-title-row">
        <h2>Warthog Wallet</h2>
        <p className="wh-subtitle">Native WART · sub-wallets · personal vaults</p>
      </div>

      {deferredPrompt && (
        <button type="button" onClick={handleInstallClick} className="btn primary small wh-install">
          Install app
        </button>
      )}

      {!isLoggedIn && renderAuthGate()}
      {isLoggedIn && wallet && renderDashboard()}

      {error && (
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
            <p className="mono wh-muted">Address: {walletData.address}</p>
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
