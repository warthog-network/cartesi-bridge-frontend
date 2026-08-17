# Live stack checkpoint — 2026-08-17

Working Path A demo on `https://cartesi-bridge.duckdns.org`.
Manual + 1-click / swap finish both directions. 3P Lindell signs.
Rabby/desktop connect and WalletConnect/mobile connect work.

## This repo (`cartesi-bridge-frontend`)

Pushed with this checkpoint:

- EIP-6963 request/announce loop guard (Rabby no longer freezes the tab)
- Reserved-mint UI: unused credit stays with the depositor; 1-click drains leftover vouchers; atomic swap still sends the typed amount
- Dual-sig WART↔L1 bind modules origin already imported
- Live wWART import uses `0xBc174Ba3265e5E0FbdEFa2A8c9FDa5F334471287` (old `0x663F3a…` is empty after Anvil wipe)
- Auto-rotate + auto-sweep enabled (2400 Anvil blocks)

## Live facts (do not invent a new Q)

| Item | Value |
|------|--------|
| 3P Q | `e070c46e3bae9372e4798b6a1709f7108bfb58fd19417424` acct **114** |
| Inspect scheme | `wart-reserved-pool-v1` `reservedMint: true` |
| wWART | `0xBc174Ba3265e5E0FbdEFa2A8c9FDa5F334471287` minter = dApp `0xab7528…` |
| DeFi RPC | `https://warthog-defitestnet.duckdns.org` |
| L1 RPC | `https://cartesi-bridge.duckdns.org/rpc` chain `31337` |

Custody: client-born, `POOL_3P_VPS_FALLBACK=0`, `hasD1/hasD2/hasFullKey` must stay false. Keep `3p-s1` / `3p-s2` / faux-signers **stopped**. Pack floor: Chrome + Brave site + Brave ext + `pool-3p-orbit-vps`.

## Services with no GitHub remote

Notes also live on the VPS at `/opt/cartesi-bridge/ops-not-on-remote.env`.

| Place | Remote? | Notes |
|-------|---------|--------|
| `/opt/cartesi-bridge` monorepo | **no git** | Live tree only |
| `cartesi-bridge-backend` on VPS | laptop repo exists; VPS tree was not a checkout | reserved-pool machine source — sync/push separately |
| `cartesi-mcp` on VPS | no git | read-only MCP |
| `cosigner` / `cosigner-node` | local git, **no origin** | Path B 2P |
| systemd units + `*.service.d` | not in git | see env snapshot below |
| `.data/` | never push | dapp seal, sessions, ops token |

### systemd snapshot (2026-08-17)

Active: `cartesi-bridge`, `cartesi-bridge-frontend`, `cartesi-bridge-bootstrap`, `cartesi-bridge-pool-relayer`, `cartesi-bridge-pool-3p-orbit`, `cartesi-cosigner`. Stopped: `3p-s1`, `3p-s2`, `faux-signers`.

Frontend: `POOL_3P_CLIENT_BORN=1` `POOL_3P_VPS_FALLBACK=0` `POOL_3P_AUTO_ROTATE=1` `POOL_3P_AUTO_SWEEP=1` `POOL_3P_ROTATE_EPOCHS=2400` `POOL_HOT_PAYOUT=1` `POOL_ONCHAIN_SIGNERS=0`.

Relayer: `POOL_ADDRESS=e070c46e…` `FUNGIBLE_POOL_ACCOUNT_ID=114` `POOL_SPV_RELAY=1` `WARTHOG_RPC=http://127.0.0.1:3001`.

Rotate clock is Anvil blocks (`pool-3p-rotate.json` `anchorBlock`). Hitting 0 starts client-born next Q + sweep — keep 4 live heartbeats.
