/**
 * Simple vs Advanced UI mode.
 *
 * Simple (default) hides operator vocabulary — seat ids, orbit counts, the
 * pool Q address, "Path A", mint/claim/voucher wording — and shows one bridge
 * health chip instead. Advanced is the full cockpit, unchanged. The choice
 * persists per browser and is mirrored on <html data-ui="…"> so plain CSS
 * (`.adv-only`, `.simple-only`) and Astro-rendered parts follow it too.
 * Layout.astro applies the stored value before first paint.
 */
import { useEffect, useState } from 'react';

export const UI_MODE_KEY = 'bridge.ui';
const MODES = new Set(['simple', 'advanced']);

export function getUiMode() {
  try {
    const v = localStorage.getItem(UI_MODE_KEY);
    if (MODES.has(v)) return v;
  } catch {
    /* private mode / blocked storage */
  }
  return 'simple';
}

export function applyUiMode(mode) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.ui = MODES.has(mode) ? mode : 'simple';
}

export function setUiMode(mode) {
  const m = MODES.has(mode) ? mode : 'simple';
  try {
    localStorage.setItem(UI_MODE_KEY, m);
  } catch {
    /* ignore */
  }
  applyUiMode(m);
  try {
    window.dispatchEvent(new CustomEvent('bridge:ui-mode', { detail: m }));
  } catch {
    /* ignore */
  }
  return m;
}

export function isSimpleMode() {
  if (typeof document !== 'undefined' && document.documentElement.dataset.ui) {
    return document.documentElement.dataset.ui !== 'advanced';
  }
  return getUiMode() !== 'advanced';
}

/** React hook: [mode, setMode]; every component using it re-renders on change. */
export function useUiMode() {
  const [mode, setMode] = useState('simple');
  useEffect(() => {
    const m = getUiMode();
    applyUiMode(m);
    setMode(m);
    const onChange = (e) => setMode(e?.detail || getUiMode());
    const onStorage = (e) => {
      if (e.key === UI_MODE_KEY) {
        const v = getUiMode();
        applyUiMode(v);
        setMode(v);
      }
    };
    window.addEventListener('bridge:ui-mode', onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('bridge:ui-mode', onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return [mode, setUiMode];
}
