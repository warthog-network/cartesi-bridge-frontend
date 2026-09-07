# Path A — 3P additive ECDSA (research-grade)

**Lab cutover / next session:** `POOL-3P-PHASE-INTEGRATION.md` (deploy order, withdrawal timing, what is not on the VPS).

This is **not** three-party Lindell. Spend is 2P Lindell between **d1** (browser dealer, Paillier sk) and the **coordinator** (holds `d_dapp`), with **d2 folded** at sign time (\(x_2=d_{\mathrm{dapp}}+d_2\); `ckey` stays Enc(\(d_1\))).

    d = d_dapp + d1 + d2  (mod n),   Q = d·G

Warthog verifies a normal ECDSA `signature65`. Missing d1 or d2 or `d_dapp` ⇒ cannot pay.

## Who sees what

| Material | d1 tab | d2 tab | VPS / coordinator |
|----------|--------|--------|-------------------|
| d1, Paillier λ,μ | yes | no | **no** on honest client-born sign (rekey no longer sends `d1Hex`) |
| d2 | no | yes | **Enc(d2) under d1's (N,g)** + Enc=dlog(P2) (RAM). Plaintext `d2Hex` refused. |
| d_dapp | no | no | yes |
| Enc(d1) | yes | no | yes (cannot decrypt if N holds) |
| full d | no (honest) | no | no (honest) |

New d2 offer posts `Enc(d2)` under the live d1 Paillier plus `proveEncEqualsDlog` (range when `d2 ∈ [q/3,2q/3]`). Coordinator folds `Enc(d2)^{k2^{-1} r}` into `c` and **never** holds the scalar. Plaintext `d2Hex` is refused.

`hasD1` / `hasD2` / `hasFullKey` in status are flags, not sensors.

## Phases (hygiene, not a rewrite)

### Phase 0 — does **not** stop a malicious VPS

- Paillier floor **2048** on client birth (`poolSigner.js`), dealer-born ceremony, and rekey. `PAILLIER_BITS=1024` is refused.
- `d2Hex` is **not** written to `pool-3p-sessions.json`. Live d2 lives in a process `Map` and is wiped on pay / expire / close / error.
- Each `cosignerSignStep` is bound to `(ticketId, hashHex, R1Hex)`. Same R1 + different hash is refused (nonce-reuse class).
- API must not log `pool3p_d2` / rekey / claim bodies.

**Phase 0 ≠ “we fixed Lindell.”**

### Phase 1 — statistical hiding of x2 from d1, still no proof of c

Lindell’17 samples ρ ← Z_q² (~512 bits) and adds Enc(ρ·q). Cosigner now uses a 512-bit ρ with the high bit set. d1 `clientSignFinish` **aborts** if `Dec(c)` is outside that window (missing/tiny pad).

This is **not** a well-formedness proof that c is the Lindell tuple for this (R1, z, k2). A malicious coordinator can still try to extract d1 from s (classic omitted-proof Lindell). After Phase 1 a human cryptographer should read `twoPartyEcdsa.js` + `combineCkeyD1D2` only — not the room.

### Phase 2 — Schnorr on P, not Enc(d1)

Birth / next-Q birth / rekey **reject** without a Schnorr PoK of dlog(P). That binds the posted point. It does **not** prove `Enc(d1)` encrypts that dlog. Poisoned `ckey` vs seal is still an abort/brick, not Lindell keygen ZK.

### Phase 3 — d2 liveness, still no rewrite

d2 is not in long-lived JSON. Optional later: second short MtA so the VPS never sees d2. Operator backup of **current** di is 3-of-3 HA, not Lindell.

### Phase 4 (local, complete) — Schnorr that R = k2·R1

`cosignerSignStep` proves knowledge of k2 with R = k2·R1 (Schnorr on base R1, Fiat-Shamir bound to R1, R, r, z, and a hash of c). `clientSignFinish` **aborts** without it, and checks R1 = k1·G and r = Rx(R).

Same transcript on Path B: JS `cosigner.local.js` and the Rust `cartesi-cosigner` (512-bit ρ + `pokR`). Extension bundle rebuilt.

On a prime-order curve this is “the coordinator knows dlog_{R1}(R)”, not a proof that c is the honest Lindell tuple. A coordinator who knows k2 can still send a crafted c. This is a building block for a later proof of c, not that proof.

**Not on the live VPS.** Deploy coordinator first, then d1 clients. Do not ship browsers that require `pokR` against a coordinator that does not emit it.

### Phase 5 (local) — L_PDL on Enc(d1)

Lindell Protocol 6.1 + Appendix A range (eprint 2017/552):

- d1 is sampled in **[q/3, 2q/3]**
- Birth/rekey send an Appendix A range proof (Fiat-Shamir, t=40)
- Then an **interactive** PDL: coordinator (V) sends Enc(a·x1+b); dealer commits α·G; V opens (a,b); dealer opens Q̂. Accept iff Q̂ = a·P1 + b·G.

That is the paper’s proof that Enc(d1) encrypts dlog(P1) in Z_q (completeness on [q/3, 2q/3]). Ceremony/selftest run it in-process.

### Phase 6 (local) — Coinbase ZK of signing `c`

Port of `zk_ecdsa_sign_2pc_integer_commit_t` from Coinbase `cb-mpc` (ECDSA-2PC spec §9 / Lindell 2017 appendix B “Sign”): unknown-order Pedersen commitments bind \(k_2^{-1}\), \(x_2\), \(\rho\); Fiat-Shamir; Paillier relation that \(c\) is the Lindell tuple. Uses their published \((N,g,h)\). d2 is folded into the **scalar** \(x_2=d_{\mathrm{dapp}}+d_2\), \(Q_2=P_2+P_{\mathrm{dapp}}\); `ckey` stays Enc(\(d_1\)).

`clientSignFinish` **aborts** without a valid `pokC`. Selftest `cZkOk`.

## What is still missing (do not scale custody)

- Interop vs `cb-mpc` bit-for-bit (same hash encoding / SEC params; algebra matches).
- Paillier \(N\in L_P\) (valid-key proof).
- d2 never leaving the d2 tab.
- Next-Q `birth_next` L_PDL HTTP path (laptop: wired; lab cutover copies this with the coordinator).
- Rust Path B cosigner emits `pokC` (laptop release binary).
- Lab cutover still has to land these on the VPS.

Do **not** treat a testnet pay as a transcript proof. Do **not** say this is mainnet-safe without a human cryptographer.

## Files (crypto)

| File | Role |
|------|------|
| `src/utils/lindellZk.js` | L_PDL + Coinbase integer-commit ZK of signing `c` |
| `src/utils/twoPartyEcdsa.js` | 2P Lindell + 512-bit ρ + Schnorr helpers + R=k2·R1 + Paillier floor |
| `src/utils/server/pool3p.mjs` | `combineCkeyD1D2`, RAM d2, R1/hash bind, birth/rekey, persist `pokR` |
| `warthog-browser-node/src/lib/pool3pClient.js` | d1 finish + Schnorr prove + verify R=k2·R1 (browser) |
| `warthog-browser-node/src/lib/poolSigner.js` | 2048-bit birth/rekey, Schnorr on birth/claim/rekey |
| `browser-node-website/src/lib/pool3pClient.js` | same d1 finish / Schnorr as the extension tree |
| `browser-node-website/src/lib/poolSigner.js` | same 2048 + Schnorr birth/claim/rekey (caught up; still no next-Q birth) |
