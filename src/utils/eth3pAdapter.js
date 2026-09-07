/**
 * ETH 3P deposit adapter — browser helper.
 * User pays this contract; it forwards to the 3P Q and attests on InputBox.
 * Do not send ETH to the Q directly (those locks are not credited).
 */
export const ETH3P_ADAPTER_ABI = [
  'function deposit(string wartAddress) payable returns (bytes32)',
  'function pool() view returns (address)',
  'function dapp() view returns (address)',
  'function inputBox() view returns (address)',
  'function owner() view returns (address)',
  'function setPool(address next)',
  'event Deposited(address indexed depositor, address indexed pool, uint256 amountWei, string wartAddress, bytes32 inputHash)',
  'event PoolUpdated(address indexed previous, address indexed next)',
];

export function normalizeWart48(addr) {
  const h = String(addr || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{48}$/.test(h)) {
    throw new Error('Warthog address must be 48 hex chars (no 0x)');
  }
  return h;
}

/**
 * @param {import('ethers-v6').Signer} signer
 * @param {{ address: string, pool?: string }} adapter
 * @param {string} wartAddress
 * @param {bigint} value
 */
export async function depositEthThroughAdapter({ signer, adapter, wartAddress, value }) {
  const { Contract } = await import('ethers-v6');
  const addr = String(adapter?.address || '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error('ETH deposit adapter is not live — cannot lock');
  }
  const wart = normalizeWart48(wartAddress);
  const q = String(adapter?.pool || '').toLowerCase();
  const c = new Contract(addr, ETH3P_ADAPTER_ABI, signer);
  if (q) {
    const onPool = String(await c.pool()).toLowerCase();
    if (onPool !== q) {
      throw new Error(
        `adapter still points at ${onPool} but status says live Q is ${q} — wait for rotation to sync setPool`,
      );
    }
  }
  const tx = await c.deposit(wart, { value });
  const rcpt = await tx.wait();
  return { hash: tx.hash, receipt: rcpt, adapter: addr, wartAddress: wart };
}
