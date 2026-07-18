const STORAGE_KEY = 'cartesiPersonalVault';

export function loadPersonalVault(walletAddress) {
  if (!walletAddress) return null;
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return all[walletAddress.toLowerCase()] || null;
  } catch {
    return null;
  }
}

export function savePersonalVault(walletAddress, data) {
  if (!walletAddress) return;
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    all[walletAddress.toLowerCase()] = { ...data, updatedAt: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch (err) {
    console.error('Failed to save personal vault state:', err);
  }
}

export function clearPersonalVault(walletAddress) {
  if (!walletAddress) return;
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    delete all[walletAddress.toLowerCase()];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}