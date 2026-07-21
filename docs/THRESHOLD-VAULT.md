# 2P-ECDSA multi-sig vault (Phases 0–4)

## Goal

**Full private key never exists in one process** — not on the cosigner, not on the browser after keygen.

See also: `docs/THREAT-MODEL.md`, `docs/SPLIT-SIG-ARCHITECTURE.md`, `docs/PHASES-0-4.md` (repo root under `/opt/cartesi-bridge/docs`).

## How it works

```text
Keygen (browser, once):
  d_user, d_dapp ← random scalars
  Q = (d_user + d_dapp)·G  →  Warthog address
  Paillier: ckey = Enc(d_user)
  Store client: d_user + Paillier sk (encrypted w/ mnemonic) only
  Cosigner:     d_dapp + ckey + Paillier pk   (never d_user plaintext)
  Never store d_dapp in browser / user-vault-share.txt (ops cosigner backup only)

Sign (interactive, Lindell-style):
  1. Client: k1, R1 = k1·G
  2. Cosigner: policy (tickets / freeable / outstanding)
               k2, R = k2·R1, builds Paillier ciphertext of k2^{-1}(z+r·d) masked
               returns r + ciphertext  (NOT private key, NOT d_dapp)
  3. Client: decrypt, s = k1^{-1} * (pt mod n) → signature65
  4. Submit Warthog wartTransfer with signature65
```

| Party | Sees | Never sees |
|-------|------|------------|
| Browser | d_user, final signature | d_dapp, full d |
| Cosigner | d_dapp, Enc(d_user), partials | d_user, full d |
| Cartesi | vault address + policy + release tickets | any key material |

## Pin policy (Phase 2–3)

Before cosigner joins a sign:

1. GraphQL notices (preferred) — mint/burn + **`release_ticket`**
2. Inspect fallback on L1 owner
3. freeable = (ticketSum|burned) − signedWithdrawE8 while outstanding > 0
4. outstanding == 0 → unrestricted
5. `force` only if `COSIGNER_ALLOW_FORCE=1`
6. optional `COSIGNER_REQUIRE_TICKETS=1` for hard ticket mode

On each `sub_unlock` burn, dApp emits `release_ticket` (`wart-release-ticket-v1`).

## Files

| File | Role |
|------|------|
| `src/utils/twoPartyEcdsa.js` | Keygen, Lindell client math |
| `src/utils/multiSigTransfer.js` | Hash + sign + submit WART transfer |
| `src/utils/cosignerClient.js` | HTTP client → `/api/cosigner` |
| `src/pages/api/cosigner.js` | Proxy to `COSIGNER_UPSTREAM` |
| `src/pages/api/cosigner.local.js` | In-process fallback |
| `../../cosigner/` | **Rust cosigner** (primary, :8791) |
| `../../cosigner-node/` | Node twin + policy tests |
| `scripts/test-2p-ecdsa.mjs` | Phase 1 offline harness |

## UI

1. **Load / create vault** → 2P keygen + cosigner register + Cartesi register  
2. Sweep / mint spoofed  
3. Burn (issues release tickets)  
4. **Withdraw vault → main** → 2P-ECDSA (no key open)

## Env

```bash
CARTESI_GRAPHQL_URL=http://127.0.0.1:8080/graphql
CARTESI_INSPECT_URL=http://127.0.0.1:8080/inspect
COSIGNER_UPSTREAM=http://127.0.0.1:8791
COSIGNER_ALLOW_FORCE=0
COSIGNER_REQUIRE_TICKETS=0
# optional: PAILLIER_BITS=2048 for stronger Paillier (slower keygen)
```

## Tests

```bash
npm run test:2p
npm run test:policy
curl -s http://127.0.0.1:8791/health
```

## Notes

- Warthog still sees one ECDSA signature (no native multisig needed).
- Keygen briefly computes aggregate `d` only to derive address, then drops it.
- Sign path never reconstructs `d`.
- Compliant cosigner + tickets gate freeable; a compromised cosigner is still a trust boundary (see threat model).
