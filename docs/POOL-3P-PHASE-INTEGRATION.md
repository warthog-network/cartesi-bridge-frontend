# Path A 3P — phase integration (next session)

Pick this file up first. Crypto detail lives in `POOL-3P-LINDELL.md`. This is the **lab cutover** list: what is on disk, what is not on the VPS, deploy order, and what withdrawals will feel like.

Laptop A1–A3 are done. **VPS coordinator + Rust + frontend `dist/` cut over 2026-08-21** on existing Q `2b733d1407bc50ce94a2838651068d93065dfbb055d22acb`. Old d1 tabs still finish (they ignore extra JSON). New d1 / new Path B finish **require** `pokC`. Reload Chrome site, Brave site, and the extension together. Do not invent a Q.

Live Q at last check (read-only): `2b733d1407bc50ce94a2838651068d93065dfbb055d22acb`. `dealerSawPlaintext: false`, `hasD1/hasD2/hasFullKey: false`. Do not invent a new Q to “test” this. Existing Enc(d1) can **sign** with Phase 6 without a re-birth; L_PDL is only required on **new** birth/rekey.

Laptop trees:

| Tree | Role |
|------|------|
| `/home/whitefang/webdev/Cartesi` | Coordinator JS, `lindellZk.js`, frontend Path B |
| `/home/whitefang/webdev/warthog/warthog-browser-node` | Extension + Chrome signer |
| `/home/whitefang/webdev/warthog/browser-node-website` | Brave-site signer |
| `/home/whitefang/Downloads/cartesi-bridge-stack/cosigner` | Rust Path B (`pokR` + `pokC` + slack \(q\cdot 2^{80}\)) |
| `/opt/cartesi-bridge` on `root@217.216.94.146` | Live. Coordinator + Rust + `dist/` on Phases 4–6 as of 2026-08-21. Browser tabs still need reload. |

---

## Phase status

| Phase | What | Laptop | VPS |
|-------|------|--------|-----|
| 0 | 2048-bit N, RAM d2, R1/hash bind, no `d1Hex` on rekey | done | older subset |
| 1 | 512-bit ρ window (now superseded on the sign path by pokC) | done | no |
| 2 | Schnorr of dlog(P), not Enc(d1) | done | likely yes on live birth |
| 3 | d2 not in `pool-3p-sessions.json` | done | yes if that build is live |
| 4 | Schnorr \(R = k_2 R_1\) (`pokR`) | JS + Rust + extension zip | coordinator + Rust + `dist/` 2026-08-21 |
| 5 | \(L_{\mathrm{PDL}}\) range \(t=40\) + Protocol 6.1 | JS coordinator + live birth **and** `birth_next` | coordinator `dist/` 2026-08-21; **d1 tabs still old until reload** |
| 6 | Coinbase integer-commit ZK of \(c\) (`pokC`) | JS + Rust Path B | coordinator + Rust + `dist/` 2026-08-21; **reload Chrome / Brave / extension** |

Still not “scale custody”: no \(N\in L_P\), no second MtA (d2 still posted at offer), no bit-identical `cb-mpc` interop, no human cryptographer review.

---

## Withdrawal time (measured)

Bench: `node cartesi-bridge-frontend/scripts/bench-lindell-sign.mjs 5`  
Node JS, 2048-bit Paillier, this laptop (2026-08-21).

| Hop | Median |
|-----|--------|
| Coordinator `cosignerSignStep` (Paillier recipe + `pokR` + **`pokC` prove**) | **258 ms** |
| d1 `clientSignFinish` (`pokR` + **`pokC` verify** + decrypt + ECDSA recover) | **184 ms** |
| **Lindell crypto, sequential** | **~440 ms** |

Coinbase C++ `cb-mpc` Sign-with-ZK is ~72 ms both parties (their VM, no JS). This port is ~6× that on Node. Brave/Chrome will be similar or a bit slower than Node.

**What this adds to a live Path A payout**, on top of today’s stack:

Today’s Lindell hop (Paillier add/mul + small Schnorr, no `pokC`) is on the order of **tens of milliseconds**. Phase 6 replaces that hop with **~0.45 s** of CPU.

It does **not** sit on:

- orbit n-of-n (heartbeats, already 20 s lease)
- `pool3p_prepare` / hash
- d1 R1 + d2 offer RTTs
- Warthog broadcast + confirm

If a lab withdraw is already **2–8 s** wall (tabs + ticket + node), expect **+0.4–0.8 s** (Node vs browser, one extra JSON blob). Users will not see a multi-second hang unless the d1 tab is busy. If you ever thought Lindell was “instant”, it will feel like a short pause after d2 joins.

**Birth / rekey is a different clock.** Appendix A \(t=40\) + Protocol 6.1 was **~6.5 s** after 2048-bit keygen (~0.3–2 s). That is seat birth and next-Q, not withdraw.

Path B vault withdraw uses the same JS `cosignerSignStep` if the frontend talks to `cosigner.local.js`. Live Path B is **Rust** `cartesi-cosigner` — until `pokC` is ported there, **do not** ship the new frontend Path B finish or vault withdraws abort.

---

## Next session — finish then lab

Do in this order. Stop before VPS if any box is unchecked.

### A. Finish laptop (still local)

1. **Rust Path B `pokC`** — **done (laptop).**  
   `prove_sign_c` / `verify_sign_c` in `cosigner/src/lindell_zk.rs`. Same Pedersen \(N,g,h\), FS `wart-lindell-c-zk-v1`, slack \(q\cdot 2^{80}\). Sign JSON includes `pokC`, `R2Hex`, `Q2Hex`, `ckeyAdj`. JS `verifySignC` accepts a Rust proof (`cargo test pokc_roundtrip`).

2. **`birth_next` L_PDL** — **done (laptop).**  
   `birthNextSeat` runs range + `pool3p_pdl_commit` / `pool3p_pdl_finish` with `kind: 'birth-next'`. `maybeBirthNextQ` in both browser trees follows live birth.

3. **Extension zip** — **done (laptop).**  
   `warthog-browser-node` `npm run extension:package`. Load unpacked from `extension/`. Old `app.js` will abort on `pokC`.

4. **Optional, not blocking lab:** \(N\in L_P\) (Hazay–Mikkelsen–Rabin–Toft, ~120 Paillier exp) — birth only. d2 MtA rewrite — do not start in a lab cutover session.

### B. Lab cutover (existing Q)

Coordinator **before** any d1 that *requires* `pokR`/`pokC`.

1. Copy JS coordinator (`pool3p.mjs`, `lindellZk.js`, `twoPartyEcdsa.js`, `pages/api/pool.js`) to `/opt/cartesi-bridge`. Restart `cartesi-bridge-frontend` only.  
   Old browsers **ignore** extra JSON and can still finish **until** you update them. Confirm one dummy Lindell room emits `pokC` (do not need a real pay yet).

2. Rebuild frontend `dist/` only after Rust Path B emits `pokC`, **or** keep Path B finish compatible (not current code — finish now **requires** `pokC`).

3. Update d1 holders together: Chrome site, Brave site, Brave extension (reload unpacked). Floor is 4 live (those three + `pool-3p-orbit-vps`). A mixed set: **new d1 + old coordinator = no pay**.

4. Do **not** run dealer ceremony. Do **not** start `3p-s1`/`3p-s2`. `POOL_3P_VPS_FALLBACK=0`.

5. First lab pay: same Q, inspect `poolAddress` === `pool3p_status.address`. A success is **not** a transcript audit.

Existing Enc(d1) on this Q has **no** \(L_{\mathrm{PDL}}\). Signing still works. PDL applies when this Q rotates or a seat rekeys.

### C. After lab is boring

- Paillier \(L_P\) on next birth  
- Decide if d2-off-VPS (second MtA) is worth a rewrite  
- Human cryptographer on `lindellZk.js` + `cosignerSignStep` + `combine`/`x2` fold only  

---

## Files the next agent should open

```
cartesi-bridge-frontend/src/utils/lindellZk.js          # L_PDL + proveSignC/verifySignC
cartesi-bridge-frontend/src/utils/twoPartyEcdsa.js      # cosignerSignStep / clientSignFinish
cartesi-bridge-frontend/src/utils/server/pool3p.mjs     # runLindellInto, birth PDL HTTP
cartesi-bridge-frontend/src/pages/api/pool.js           # pool3p_pdl_* 
cartesi-bridge-frontend/src/pages/api/cosigner.local.js # Path B JS; already pokC
cartesi-bridge-frontend/src/utils/server/pool3pRotate.mjs  # birth_next L_PDL (kind birth-next)
Downloads/cartesi-bridge-stack/cosigner/src/lindell_zk.rs + main.rs  # pokC + pokR
warthog-browser-node/src/lib/{lindellZk,pool3pClient,poolSigner}.js
browser-node-website/src/lib/  # same
```

Selftest: `node cartesi-bridge-frontend/scripts/selftest-3p.mjs`  
Expect `pdlOk`, `rangeOk`, `cZkOk`.  
Sign bench: `node cartesi-bridge-frontend/scripts/bench-lindell-sign.mjs 5`

---

## Crypto reminders (do not regress)

- Path A spend is **2P Lindell** + folded d2, not 3-party Lindell.
- Sign: \(x_2 = d_{\mathrm{dapp}}+d_2\), \(Q_2=P_2+P_{\mathrm{dapp}}\), `ckey` = Enc(\(d_1\)) only, plus slack \(q\cdot 2^{80}\) for the Coinbase relation.
- FS prefix for `c`: `wart-lindell-c-zk-v1`. Not `cb-mpc` wire format.
- d2 is still plaintext at `pool3p_d2` (RAM). TLS + no logs. Not “no party sees another share.”
- `hasD1` / `hasD2` / `hasFullKey` are flags, not sensors.
