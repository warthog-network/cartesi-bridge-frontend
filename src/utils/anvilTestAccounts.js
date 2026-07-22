/**
 * Foundry / Anvil default accounts (chainId 31337).
 * Public test keys only — never use on mainnet or Sepolia with real funds.
 *
 * Cartesi `cartesi run` boots Anvil with these 10 pre-funded accounts (~10k ETH each).
 * Script default deployer / minter owner is Anvil #2 (see scripts/* ANVIL_PK).
 */

/** @typedef {{ index: number, address: string, privateKey: string, role?: string, reserved?: boolean }} AnvilTestAccount */

/** @type {AnvilTestAccount[]} */
export const ANVIL_TEST_ACCOUNTS = [
  {
    index: 0,
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    privateKey:
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    role: 'Default MetaMask / common primary demo',
    reserved: false,
  },
  {
    index: 1,
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    privateKey:
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    role: 'Second tester',
    reserved: false,
  },
  {
    index: 2,
    address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    privateKey:
      '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    role: 'Deploy scripts / MinterWWART owner (ANVIL_PK)',
    reserved: true,
  },
  {
    index: 3,
    address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    privateKey:
      '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    role: 'Spare',
    reserved: false,
  },
  {
    index: 4,
    address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
    privateKey:
      '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
    role: 'Spare',
    reserved: false,
  },
  {
    index: 5,
    address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
    privateKey:
      '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
    role: 'Spare',
    reserved: false,
  },
  {
    index: 6,
    address: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
    privateKey:
      '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
    role: 'Spare',
    reserved: false,
  },
  {
    index: 7,
    address: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
    privateKey:
      '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
    role: 'Spare',
    reserved: false,
  },
  {
    index: 8,
    address: '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f',
    privateKey:
      '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
    role: 'Spare',
    reserved: false,
  },
  {
    index: 9,
    address: '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720',
    privateKey:
      '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
    role: 'Spare',
    reserved: false,
  },
];

/** Accounts recommended for extra MetaMask profiles (not script-owned). */
export function getSpareAnvilAccounts() {
  return ANVIL_TEST_ACCOUNTS.filter((a) => !a.reserved);
}

/**
 * Fetch ETH balances for Anvil test accounts from an RPC.
 * @param {string} rpcUrl
 * @returns {Promise<Record<string, string>>} address(lower) → human ETH string
 */
export async function fetchAnvilAccountBalances(rpcUrl) {
  const out = {};
  if (!rpcUrl) return out;
  const bodyFor = (addr) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBalance',
      params: [addr, 'latest'],
    });
  await Promise.all(
    ANVIL_TEST_ACCOUNTS.map(async (a) => {
      try {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: bodyFor(a.address),
          cache: 'no-store',
        });
        const json = await res.json();
        const wei = BigInt(json.result || '0x0');
        const whole = wei / 10n ** 18n;
        const frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 4);
        out[a.address.toLowerCase()] = `${whole}.${frac}`.replace(/\.?0+$/, '') || '0';
      } catch {
        out[a.address.toLowerCase()] = '—';
      }
    }),
  );
  return out;
}
