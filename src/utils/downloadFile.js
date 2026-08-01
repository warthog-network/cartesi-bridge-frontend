/**
 * Browser file download helpers.
 *
 * Normal browsers: <a download> + blob URL (append to DOM, delayed revoke).
 * Wallet in-app browsers (Rabby, MetaMask Mobile, many WebViews): the download
 * attribute is often ignored with no error — toast would lie if we always said
 * "Downloaded". We try several strategies and surface a copy / open fallback.
 */

export const DEFAULT_WALLET_DOWNLOAD_NAME = 'warthog_wallet.txt';
export const DEFAULT_VAULT_SHARE_DOWNLOAD_NAME = 'user-vault-share.txt';

/**
 * Sanitize a user-chosen filename. Empty → defaultName.
 * @param {string|null|undefined} name
 * @param {string} defaultName
 * @returns {string}
 */
export function sanitizeDownloadFilename(name, defaultName) {
  const fallback = String(defaultName || 'download.txt').trim() || 'download.txt';
  let s = String(name ?? '').trim();
  if (!s) s = fallback;
  s = s.replace(/[/\\?%*:|"<>]/g, '_').replace(/^\.+/, '');
  if (!s) s = fallback;
  if (!/\.[a-z0-9]{1,12}$/i.test(s)) {
    const m = fallback.match(/(\.[a-z0-9]{1,12})$/i);
    if (m) s = `${s}${m[1]}`;
  }
  if (s.length > 180) {
    const m = s.match(/(\.[a-z0-9]{1,12})$/i);
    const ext = m ? m[1] : '';
    s = s.slice(0, 180 - ext.length) + ext;
  }
  return s;
}

/**
 * Heuristic: environments that often block programmatic file downloads.
 * Rabby / MetaMask mobile / generic Android WebView / iOS WKWebView without Safari.
 */
export function isRestrictedDownloadEnv() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return true;
  const ua = String(navigator.userAgent || '');
  const w = window;

  // Explicit wallet / DApp browsers
  if (w.rabby || w.__rabby__ || /Rabby/i.test(ua)) return true;
  if (/MetaMaskMobile|MetaMask/i.test(ua) && /Mobile|Android|iPhone|iPad/i.test(ua)) return true;
  if (/Trust\//i.test(ua) || /TokenPocket/i.test(ua) || /CoinbaseWallet/i.test(ua)) return true;
  if (/Phantom/i.test(ua) || /OKApp/i.test(ua) || /imToken/i.test(ua)) return true;

  // Android WebView marker
  if (/\bwv\b|; wv\)/i.test(ua)) return true;
  // iOS WebView: AppleWebKit without Safari
  if (/(iPhone|iPod|iPad)/i.test(ua) && /AppleWebKit/i.test(ua) && !/Safari/i.test(ua)) {
    return true;
  }

  return false;
}

function toBlob(content, mimeType) {
  if (content instanceof Blob) return content;
  return new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
}

async function tryShowSaveFilePicker(blob, name) {
  if (typeof window === 'undefined' || typeof window.showSaveFilePicker !== 'function') {
    return false;
  }
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: name,
      types: [
        {
          description: 'Text file',
          accept: { 'text/plain': ['.txt'] },
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (err) {
    // user cancelled or not allowed
    if (err?.name === 'AbortError') return false;
    return false;
  }
}

async function tryWebShare(blob, name) {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
    return false;
  }
  try {
    const file = new File([blob], name, {
      type: blob.type || 'text/plain',
    });
    if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: [file] })) {
      return false;
    }
    await navigator.share({
      files: [file],
      title: name,
      text: `Save ${name}`,
    });
    return true;
  } catch (err) {
    if (err?.name === 'AbortError') return false;
    return false;
  }
}

function tryAnchorDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try {
      a.remove();
    } catch {
      /* ignore */
    }
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }, 60_000); // keep longer — restricted browsers may open async
  return url;
}

/**
 * Show a modal so the user can copy or open the payload when downloads are blocked.
 * Uses plain DOM so any caller (wallet / vault share) can use it without React.
 * @returns {Promise<'copied'|'opened'|'dismissed'>}
 */
export function showDownloadFallbackModal({ content, filename, reason }) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve('dismissed');
      return;
    }

    const text =
      typeof content === 'string'
        ? content
        : content instanceof Blob
          ? null
          : String(content ?? '');

    const existing = document.getElementById('cb-download-fallback');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'cb-download-fallback';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:99999',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:1rem',
      'background:rgba(0,0,0,0.72)',
      'font-family:system-ui,-apple-system,sans-serif',
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
      'max-width:28rem',
      'width:100%',
      'background:#1a1a1e',
      'color:#f4f4f5',
      'border:1px solid #3f3f46',
      'border-radius:12px',
      'padding:1.1rem 1.15rem',
      'box-shadow:0 12px 40px rgba(0,0,0,0.45)',
    ].join(';');

    const title = document.createElement('h3');
    title.textContent = 'Save file manually';
    title.style.cssText = 'margin:0 0 0.5rem;font-size:1.05rem;font-weight:650';

    const body = document.createElement('p');
    body.style.cssText = 'margin:0 0 0.75rem;font-size:0.9rem;line-height:1.45;color:#a1a1aa';
    body.textContent =
      reason ||
      'This browser (e.g. Rabby / wallet in-app) often blocks automatic downloads. Copy the encrypted text or open it, then save as a .txt file.';

    const nameRow = document.createElement('p');
    nameRow.style.cssText =
      'margin:0 0 0.75rem;font-size:0.82rem;color:#d4d4d8;word-break:break-all';
    nameRow.innerHTML = `Suggested name: <code style="color:#fbbf24">${filename}</code>`;

    const ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.rows = 5;
    ta.spellcheck = false;
    ta.style.cssText = [
      'width:100%',
      'box-sizing:border-box',
      'margin:0 0 0.85rem',
      'padding:0.55rem 0.65rem',
      'border-radius:8px',
      'border:1px solid #3f3f46',
      'background:#09090b',
      'color:#e4e4e7',
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace',
      'font-size:0.72rem',
      'line-height:1.35',
      'resize:vertical',
    ].join(';');

    const setTextarea = async () => {
      if (text != null) {
        ta.value = text;
        return;
      }
      if (content instanceof Blob) {
        ta.value = await content.text();
      } else {
        ta.value = '';
      }
    };

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:0.5rem';

    const mkBtn = (label, primary) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = [
        'cursor:pointer',
        'border:none',
        'border-radius:8px',
        'padding:0.5rem 0.85rem',
        'font-size:0.875rem',
        'font-weight:600',
        primary ? 'background:#f59e0b;color:#18181b' : 'background:#27272a;color:#f4f4f5',
      ].join(';');
      return b;
    };

    const copyBtn = mkBtn('Copy encrypted text', true);
    const openBtn = mkBtn('Open in tab', false);
    const closeBtn = mkBtn('Done', false);

    const finish = (result) => {
      try {
        overlay.remove();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    copyBtn.onclick = async () => {
      try {
        const val = ta.value || (text != null ? text : await (content instanceof Blob ? content.text() : ''));
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(val);
        } else {
          ta.focus();
          ta.select();
          document.execCommand('copy');
        }
        copyBtn.textContent = 'Copied ✓';
        setTimeout(() => {
          copyBtn.textContent = 'Copy encrypted text';
        }, 1600);
      } catch {
        ta.focus();
        ta.select();
        copyBtn.textContent = 'Select & copy manually';
      }
    };

    openBtn.onclick = () => {
      try {
        const blob =
          content instanceof Blob
            ? content
            : new Blob([ta.value || text || ''], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const w = window.open(url, '_blank', 'noopener,noreferrer');
        if (!w) {
          // popup blocked — navigate same tab as last resort is bad; use location assign on anchor
          const a = document.createElement('a');
          a.href = url;
          a.target = '_blank';
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
        }
        setTimeout(() => URL.revokeObjectURL(url), 120_000);
        finish('opened');
      } catch {
        finish('dismissed');
      }
    };

    closeBtn.onclick = () => finish('dismissed');
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish('dismissed');
    });

    btnRow.append(copyBtn, openBtn, closeBtn);
    card.append(title, body, nameRow, ta, btnRow);
    overlay.append(card);
    document.body.appendChild(overlay);

    setTextarea().then(() => {
      try {
        ta.focus();
        ta.select();
      } catch {
        /* ignore */
      }
    });
  });
}

/**
 * Best-effort download. Always returns a result object (does not throw on restricted env).
 *
 * @param {string|Blob|ArrayBuffer|Uint8Array} content
 * @param {string} filename
 * @param {string} [mimeType]
 * @param {{ forceFallback?: boolean, skipFallbackUi?: boolean }} [opts]
 * @returns {Promise<{
 *   name: string,
 *   method: 'file-picker'|'share'|'anchor'|'fallback'|'ms-save',
 *   restricted: boolean,
 *   likelySaved: boolean,
 * }>}
 */
export async function downloadTextFile(
  content,
  filename,
  mimeType = 'text/plain;charset=utf-8',
  opts = {},
) {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    throw new Error('downloadTextFile requires a browser');
  }
  const name = sanitizeDownloadFilename(filename, 'download.txt');
  const blob = toBlob(content, mimeType);
  const restricted = opts.forceFallback || isRestrictedDownloadEnv();

  // Legacy Edge/IE
  if (typeof window.navigator?.msSaveOrOpenBlob === 'function') {
    window.navigator.msSaveOrOpenBlob(blob, name);
    return { name, method: 'ms-save', restricted: false, likelySaved: true };
  }

  // Chromium desktop: real save dialog (works when available)
  if (!restricted) {
    const picked = await tryShowSaveFilePicker(blob, name);
    if (picked) {
      return { name, method: 'file-picker', restricted: false, likelySaved: true };
    }
  }

  // Mobile share sheet (sometimes works in WebViews)
  const shared = await tryWebShare(blob, name);
  if (shared) {
    return { name, method: 'share', restricted, likelySaved: true };
  }

  // Standard anchor download (Chrome/Firefox/Safari normal browsers)
  tryAnchorDownload(blob, name);

  // Wallet browsers almost never honor download= — always show fallback there.
  // In normal browsers we only show fallback if forced.
  if (restricted || opts.forceFallback) {
    if (!opts.skipFallbackUi) {
      const text =
        typeof content === 'string'
          ? content
          : await blob.text();
      await showDownloadFallbackModal({
        content: text,
        filename: name,
        reason: restricted
          ? 'Rabby / wallet in-app browsers usually block automatic downloads. Copy this encrypted backup and paste it into a file named as suggested (or open in a tab and save).'
          : undefined,
      });
    }
    return { name, method: 'fallback', restricted: true, likelySaved: false };
  }

  return { name, method: 'anchor', restricted: false, likelySaved: true };
}

/**
 * Sync wrapper kept for older call sites. Prefer async downloadTextFile.
 * Fires-and-forgets strategies; still returns the filename immediately.
 */
export function downloadTextFileSync(content, filename, mimeType = 'text/plain;charset=utf-8') {
  const name = sanitizeDownloadFilename(filename, 'download.txt');
  // kick async path without awaiting (callers that need result should use async)
  void downloadTextFile(content, name, mimeType);
  return name;
}

/**
 * Optional filename prompt with default pre-filled.
 * @param {string} defaultName
 * @param {string} [message]
 * @returns {string|null}
 */
export function promptDownloadFilename(
  defaultName,
  message = 'Save as (edit name or keep the default)',
) {
  if (typeof window === 'undefined') return defaultName;
  const raw = window.prompt(message, defaultName);
  if (raw === null) return null;
  return sanitizeDownloadFilename(raw, defaultName);
}
