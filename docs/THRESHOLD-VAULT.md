# 2P-ECDSA multi-sig vault (fuller security)

## Goal

**Full private key never exists in one process** — not on the cosigner, not on the browser after keygen.

## How it works

```text
Keygen (browser, once):
  d_user, d_dapp ← random scalars
  Q = (d_user + d_dapp)·G  →  Warthog address
  Paillier: ckey = Enc(d_user)
  Store client: d_user + Paillier sk (encrypted w/ mnemonic)
  Cosigner:     d_dapp + ckey + Paillier pk   (never d_user plaintext)

Sign (interactive, Lindell-style):
  1. Client: k1, R1 = k1·G
  2. Cosigner: checks Cartesi GraphQL outstanding === 0
               k2, R = k2·R1, builds Paillier ciphertext of k2^{-1}(z+r·d) masked
               returns r + ciphertext  (NOT private key, NOT d_dapp)
  3. Client: decrypt, s = k1^{-1} * (pt mod n) → signature65
  4. Submit Warthog wartTransfer with signature65
```

| Party | Sees | Never sees |
|-------|------|------------|
| Browser | d_user, final signature | d_dapp, full d |
| Cosigner | d_dapp, Enc(d_user), partials | d_user, full d |
| Cartesi | vault address + policy | any key material |

## Pin policy

Before cosigner joins a sign, it verifies outstanding spoofed wWART via:

1. GraphQL notices (preferred)
2. Inspect fallback on L1 owner

## Files

| File | Role |
|------|------|
| `src/utils/twoPartyEcdsa.js` | Keygen, Lindell client/server math |
| `src/utils/multiSigTransfer.js` | Hash + sign + submit WART transfer |
| `src/utils/cosignerClient.js` | HTTP client |
| `src/pages/api/cosigner.js` | Cosigner + GraphQL pin |

## UI

1. **Load / create vault** → 2P keygen + cosigner register + Cartesi register  
2. Sweep / mint spoofed  
3. Burn outstanding to 0  
4. **Withdraw vault → main** → 2P-ECDSA (no key open)

## Env

```bash
CARTESI_GRAPHQL_URL=http://127.0.0.1:8080/graphql
CARTESI_INSPECT_URL=http://127.0.0.1:8080/inspect
# optional: PAILLIER_BITS=2048 for stronger Paillier (slower keygen)
```

## Notes

- Warthog still sees one ECDSA signature (no native multisig needed).
- Keygen briefly computes aggregate `d` only to derive address, then drops it.
- Sign path never reconstructs `d`.
