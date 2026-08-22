/**
 * Lindell'17 keygen ZK (eprint 2017/552).
 *
 * L_PDL = {(c, pk, Q1) | ∃(x1, r): c = Enc(x1; r) ∧ Q1 = x1·G ∧ x1 ∈ Z_q }
 *
 * Protocol 6.1 (interactive, verifier-first) + Appendix A range proof.
 * Range is Fiat-Shamir in the ROM (paper commits the challenge first).
 * Completeness for x1 ∈ [q/3, 2q/3]; soundness for x1 ∉ Z_q (range) plus
 * the integer MAC that Enc(x1) is dlog(Q1).
 *
 * This is NOT a ZK well-formedness proof of the signing ciphertext c.
 * Lindell Protocol 3.2 checks that by verifying the ECDSA signature.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { PublicKey, PrivateKey } from 'paillier-bigint';
import { sha256, toUtf8Bytes } from 'ethers-v6';

const CURVE_N = secp256k1.CURVE.n;
const G = secp256k1.ProjectivePoint.BASE;

/** Statistical soundness 2^{-t} on the range cut-and-choose. Paper: t = 40. */
export const LINDELL_RANGE_T = 40;
export const LINDELL_Q_THIRD = CURVE_N / 3n;

function sha256Hex(s) {
  return String(sha256(toUtf8Bytes(s)))
    .replace(/^0x/i, '')
    .toLowerCase();
}

function gcd(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

function modPow(base, exp, mod) {
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  let r = 1n;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

function modInv(a, m) {
  let t = 0n;
  let newt = 1n;
  let r = m;
  let newr = ((a % m) + m) % m;
  while (newr !== 0n) {
    const q = r / newr;
    [t, newt] = [newt, t - q * newt];
    [r, newr] = [newr, r - q * newr];
  }
  if (r > 1n) throw new Error('not invertible');
  if (t < 0n) t += m;
  return t;
}

/** c ⊖ k : multiply by g^{-k} (not g^{N-k}, which injects g^N). */
function homomorphicSubConst(pub, c, k) {
  const n2 = pub._n2;
  const gk = modPow(pub.g, k, n2);
  return (BigInt(c) * modInv(gk, n2)) % n2;
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

function bytesToBig(u8) {
  let x = 0n;
  for (const b of u8) x = (x << 8n) | BigInt(b);
  return x;
}

function randomBelow(n) {
  if (n <= 1n) throw new Error('randomBelow: n ≤ 1');
  const bits = n.toString(2).length;
  const len = (bits + 7) >> 3;
  for (let i = 0; i < 64; i++) {
    const x = bytesToBig(randomBytes(len + 4)) % n;
    if (x > 0n) return x;
  }
  throw new Error('randomBelow failed');
}

function randomInclusive(lo, hi) {
  const span = hi - lo + 1n;
  if (span <= 0n) throw new Error('empty range');
  return lo + (bytesToBig(randomBytes(48)) % span);
}

function bytesToHex(u8) {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomCoprimeTo(n) {
  for (let i = 0; i < 64; i++) {
    const r = randomBelow(n);
    if (r > 1n && gcd(r, n) === 1n) return r;
  }
  throw new Error('coprime sample failed');
}

/** Paper: P1 samples x1 ← {q/3, …, 2q/3}. */
export function randomShareLindellRange() {
  const x = randomInclusive(LINDELL_Q_THIRD, 2n * LINDELL_Q_THIRD);
  if (x === 0n) throw new Error('Lindell-range scalar was 0');
  return x;
}

export function scalarToHex(s) {
  const x = ((s % CURVE_N) + CURVE_N) % CURVE_N;
  return x.toString(16).padStart(64, '0');
}

function pointHex(P) {
  return bytesToHex(P.toRawBytes(true));
}

function pointFromHex(hex) {
  return secp256k1.ProjectivePoint.fromHex(String(hex).replace(/^0x/i, ''));
}

function bigToDec(x) {
  return x.toString(10);
}

function decToBig(s) {
  return BigInt(String(s));
}

export function encryptWithR(pub, m) {
  const r = randomCoprimeTo(pub.n);
  const c = pub.encrypt(m, r);
  return { c, r };
}

/**
 * PoK of (x, r) s.t. c = Enc(x; r) under (N,g) and Q = x·G.
 * Witness is encryption randomness, not Paillier λ — so d2 can prove Enc(d2)
 * under d1's public (N,g) without the dealer key.
 */
export function proveEncEqualsDlog({
  x,
  rEnc,
  c,
  paillierN,
  paillierG,
  Qhex,
  context = '',
}) {
  const pub = new PublicKey(BigInt(paillierN), BigInt(paillierG));
  const N = pub.n;
  const xx = BigInt(x);
  const Qn = String(Qhex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const want = pointHex(ecMul(G, xx));
  if (want !== Qn) {
    throw new Error('ENC_DLOG: x·G ≠ Q');
  }
  const xPrime = randomBelow(CURVE_N << 128n);
  const rPrime = randomCoprimeTo(N);
  const Tenc = pub.encrypt(xPrime, rPrime);
  const Tpt = pointHex(ecMul(G, xPrime));
  const e = BigInt(
    '0x' +
      sha256Hex(
        [
          'wart-enc-dlog-v1',
          String(context || ''),
          String(N),
          String(c),
          Qn,
          String(Tenc),
          Tpt,
        ].join('|'),
      ).slice(0, 32),
  );
  const zr = (rPrime * modPow(BigInt(rEnc), e, N)) % N;
  return {
    Tenc: Tenc.toString(10),
    Tpt,
    e: e.toString(10),
    zx: (xPrime + e * xx).toString(10),
    zr: zr.toString(10),
    context: String(context || ''),
  };
}

export function verifyEncEqualsDlog({
  c,
  paillierN,
  paillierG,
  Qhex,
  proof,
  context = '',
}) {
  if (!proof?.Tenc || proof.e == null || proof.zx == null || proof.zr == null) {
    throw new Error('ENC_DLOG_MISSING: need Enc(x)=x·G proof');
  }
  const pub = new PublicKey(BigInt(paillierN), BigInt(paillierG));
  const N = pub.n;
  const Qn = String(Qhex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const Tenc = BigInt(proof.Tenc);
  const Tpt = String(proof.Tpt || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  const e = BigInt(proof.e);
  const zx = BigInt(proof.zx);
  const zr = BigInt(proof.zr);
  const eWant = BigInt(
    '0x' +
      sha256Hex(
        [
          'wart-enc-dlog-v1',
          String(context || proof.context || ''),
          String(N),
          String(c),
          Qn,
          String(Tenc),
          Tpt,
        ].join('|'),
      ).slice(0, 32),
  );
  if (e !== eWant) throw new Error('ENC_DLOG: Fiat-Shamir e mismatch');
  if (zr <= 0n || zr >= N) throw new Error('ENC_DLOG: r response not in Z_N');
  const leftEnc = pub.encrypt(zx, zr);
  const rightEnc = pub.addition(Tenc, pub.multiply(BigInt(c), e));
  if (leftEnc !== rightEnc) throw new Error('ENC_DLOG: Paillier relation fails');
  const Q = pointFromHex(Qn);
  const T = pointFromHex(Tpt);
  if (pointHex(ecMul(G, zx)) !== pointHex(ecMul(Q, e).add(T))) {
    throw new Error('ENC_DLOG: zx·G ≠ T + e·Q');
  }
  return { ok: true };
}

function commitHex(parts) {
  const nonce = bytesToHex(randomBytes(32));
  const msg = ['wart-lindell-com-v1', ...parts.map(String), nonce].join('|');
  return { com: sha256Hex(msg), nonce };
}

function openCommit(com, parts, nonce) {
  const msg = ['wart-lindell-com-v1', ...parts.map(String), String(nonce || '')].join('|');
  if (sha256Hex(msg) !== String(com || '').toLowerCase()) {
    throw new Error('LINDELL_PDL: commitment open failed');
  }
  return true;
}

function challengeBits(t, parts) {
  const h = sha256Hex(['wart-lindell-range-fs-v1', ...parts.map(String)].join('|'));
  const x = BigInt('0x' + h);
  const bits = [];
  for (let i = 0; i < t; i++) bits.push(Number((x >> BigInt(i)) & 1n));
  return bits;
}

/**
 * Appendix A range proof, Fiat-Shamir. Proves Dec(c) ∈ [q/3, 2q/3]
 * (completeness) / not wildly outside (soundness 2^{-t}).
 */
export function proveRangeLindell({
  x,
  rEnc,
  c,
  paillierN,
  paillierG,
  Q1,
  context = '',
  t = LINDELL_RANGE_T,
}) {
  const pub = new PublicKey(BigInt(paillierN), BigInt(paillierG));
  const q = CURVE_N;
  const ell = q / 3n;
  if (x < ell || x > 2n * ell) {
    throw new Error('LINDELL_RANGE: x1 not in [q/3, 2q/3] — resample the share');
  }
  const xp = x - ell;
  const cp = homomorphicSubConst(pub, c, ell);
  const pairs = [];
  const ws = [];
  for (let i = 0; i < t; i++) {
    let w1 = randomInclusive(ell, 2n * ell);
    let w2 = w1 - ell;
    if (randomInclusive(0n, 1n) === 1n) {
      const tmp = w1;
      w1 = w2;
      w2 = tmp;
    }
    const r1 = randomCoprimeTo(pub.n);
    const r2 = randomCoprimeTo(pub.n);
    const c1 = pub.encrypt(w1, r1);
    const c2 = pub.encrypt(w2, r2);
    pairs.push({ c1: bigToDec(c1), c2: bigToDec(c2) });
    ws.push({ w1, w2, r1, r2 });
  }
  const e = challengeBits(t, [
    context,
    String(c),
    Q1 || '',
    paillierN,
    bigToDec(cp),
    ...pairs.flatMap((p) => [p.c1, p.c2]),
  ]);
  const z = [];
  const rC = BigInt(rEnc);
  for (let i = 0; i < t; i++) {
    if (e[i] === 0) {
      z.push({
        e: 0,
        w1: bigToDec(ws[i].w1),
        r1: bigToDec(ws[i].r1),
        w2: bigToDec(ws[i].w2),
        r2: bigToDec(ws[i].r2),
      });
    } else {
      let j = 1;
      let w = xp + ws[i].w1;
      let rj = ws[i].r1;
      if (w < ell || w > 2n * ell) {
        j = 2;
        w = xp + ws[i].w2;
        rj = ws[i].r2;
      }
      if (w < ell || w > 2n * ell) {
        throw new Error('LINDELL_RANGE: no j with x+w_j in [ℓ,2ℓ]');
      }
      z.push({
        e: 1,
        j,
        w: bigToDec(w),
        r: bigToDec((rC * rj) % pub.n),
      });
    }
  }
  return { t, pairs, z, context: String(context || '') };
}

export function verifyRangeLindell({
  c,
  paillierN,
  paillierG,
  Q1,
  proof,
  context = '',
}) {
  if (!proof?.pairs || !proof?.z) {
    throw new Error('LINDELL_RANGE_MISSING: need Appendix A range proof on Enc(d1)');
  }
  const t = Number(proof.t || 0);
  if (t < LINDELL_RANGE_T) {
    throw new Error(`LINDELL_RANGE: t=${t} < ${LINDELL_RANGE_T}`);
  }
  if (proof.pairs.length !== t || proof.z.length !== t) {
    throw new Error('LINDELL_RANGE: pair/z length mismatch');
  }
  const pub = new PublicKey(BigInt(paillierN), BigInt(paillierG));
  const q = CURVE_N;
  const ell = q / 3n;
  const cp = homomorphicSubConst(pub, c, ell);
  const e = challengeBits(t, [
    context || proof.context || '',
    String(c),
    Q1 || '',
    String(paillierN),
    bigToDec(cp),
    ...proof.pairs.flatMap((p) => [p.c1, p.c2]),
  ]);
  for (let i = 0; i < t; i++) {
    const zi = proof.z[i];
    const c1 = BigInt(proof.pairs[i].c1);
    const c2 = BigInt(proof.pairs[i].c2);
    if (e[i] === 0) {
      if (Number(zi.e) !== 0) throw new Error('LINDELL_RANGE: e_i=0 but z is open-sum');
      const w1 = BigInt(zi.w1);
      const w2 = BigInt(zi.w2);
      if (pub.encrypt(w1, BigInt(zi.r1)) !== c1 || pub.encrypt(w2, BigInt(zi.r2)) !== c2) {
        throw new Error('LINDELL_RANGE: Enc(w) ≠ c_i (e=0)');
      }
      const inHi = (w) => w >= ell && w <= 2n * ell;
      const inLo = (w) => w >= 0n && w <= ell;
      const ok =
        (inHi(w1) && inLo(w2)) || (inLo(w1) && inHi(w2));
      if (!ok) throw new Error('LINDELL_RANGE: w1/w2 not a complementary pair');
    } else {
      if (Number(zi.e) !== 1) throw new Error('LINDELL_RANGE: e_i=1 but z is open-both');
      const w = BigInt(zi.w);
      if (w < ell || w > 2n * ell) throw new Error('LINDELL_RANGE: opened w not in [ℓ,2ℓ]');
      const cj = Number(zi.j) === 2 ? c2 : c1;
      const got = pub.addition(cp, cj);
      if (pub.encrypt(w, BigInt(zi.r)) !== got) {
        throw new Error('LINDELL_RANGE: Enc(x+w) ≠ c ⊕ c_j');
      }
    }
  }
  return { ok: true, t };
}

/**
 * Protocol 6.1 step 1 — V (coordinator) challenges the dealer.
 * Stores (a,b) only in RAM; the dealer never sees them until after committing Q̂.
 */
export function pdlVerifierChallenge({ ckey, paillierN, paillierG, Q1 }) {
  const pub = new PublicKey(BigInt(paillierN), BigInt(paillierG));
  if (pub.n <= 2n * CURVE_N * CURVE_N + CURVE_N) {
    throw new Error('LINDELL_PDL: N too small (need N > 2q²+q)');
  }
  const a = randomBelow(CURVE_N);
  const b = randomBelow(CURVE_N * CURVE_N);
  const r = randomCoprimeTo(pub.n);
  const cPrime = pub.addition(pub.multiply(BigInt(ckey), a), pub.encrypt(b, r));
  const com = commitHex([scalarToHex(a), b.toString(10), Q1 || '']);
  const bMod = b % CURVE_N;
  const aQ = pointFromHex(Q1).multiply(a);
  const Qexpect = bMod === 0n ? aQ : aQ.add(G.multiply(bMod));
  // b is in Z_{q²}; b·G uses b mod q. Paper: Q' = a·Q1 + b·G over the curve.
  // Using b mod q is the EC operation; the integer MAC uses full b.
  return {
    a: a.toString(10),
    b: b.toString(10),
    r: r.toString(10),
    cPrime: bigToDec(cPrime),
    comAB: com.com,
    nonceAB: com.nonce,
    Qexpect: pointHex(Qexpect),
    Q1,
    ckey: String(ckey),
    paillierN: String(paillierN),
    paillierG: String(paillierG),
  };
}

/** Public slice of the challenge (no a,b). */
export function pdlChallengePublic(ch) {
  return {
    cPrime: ch.cPrime,
    comAB: ch.comAB,
    Q1: ch.Q1,
    ckey: ch.ckey,
    paillierN: ch.paillierN,
    paillierG: ch.paillierG,
  };
}

export function pdlProverCommit({ cPrime, paillierN, paillierG, paillierLambda, paillierMu }) {
  const pub = new PublicKey(BigInt(paillierN), BigInt(paillierG));
  const sk = new PrivateKey(BigInt(paillierLambda), BigInt(paillierMu), pub);
  const alpha = sk.decrypt(BigInt(cPrime));
  const aMod = alpha % CURVE_N;
  const Qhat = aMod === 0n ? secp256k1.ProjectivePoint.ZERO : G.multiply(aMod);
  const com = commitHex([pointHex(Qhat)]);
  return {
    alpha: alpha.toString(10),
    Qhat: pointHex(Qhat),
    comQ: com.com,
    nonceQ: com.nonce,
  };
}

export function pdlVerifierOpen(ch) {
  return {
    a: ch.a,
    b: ch.b,
    nonceAB: ch.nonceAB,
    comAB: ch.comAB,
    Q1: ch.Q1,
  };
}

export function pdlProverFinish({ alpha, x1, a, b, Qhat, comQ, nonceQ, comAB, nonceAB, Q1 }) {
  const A = BigInt(a);
  const B = BigInt(b);
  const al = BigInt(alpha);
  const x = BigInt(x1);
  if (al !== A * x + B) {
    throw new Error('LINDELL_PDL: Dec(c′) ≠ a·x1+b — refusing to open Q̂ (MAC mismatch)');
  }
  openCommit(comAB, [scalarToHex(A % CURVE_N), B.toString(10), Q1 || ''], nonceAB);
  openCommit(comQ, [Qhat], nonceQ);
  return { Qhat, nonceQ, comQ };
}

export function pdlVerifierAccept({ ch, Qhat, nonceQ, comQ }) {
  openCommit(ch.comAB, [scalarToHex(BigInt(ch.a) % CURVE_N), ch.b, ch.Q1 || ''], ch.nonceAB);
  openCommit(comQ, [Qhat], nonceQ);
  const a = BigInt(ch.a);
  const b = BigInt(ch.b);
  const bMod = b % CURVE_N;
  const aQ = pointFromHex(ch.Q1).multiply(a);
  const expect = bMod === 0n ? aQ : aQ.add(G.multiply(bMod));
  if (pointHex(expect) !== String(Qhat).replace(/^0x/i, '').toLowerCase()) {
    throw new Error('LINDELL_PDL: Q̂ ≠ a·Q1 + b·G — Enc(d1) is not dlog(P1)');
  }
  return { ok: true };
}

/**
 * In-process PDL + range (selftest / dealer ceremony). Same 3-share design.
 */
export function runLindellPdl({
  x1,
  rEnc,
  ckey,
  Q1,
  paillierN,
  paillierG,
  paillierLambda,
  paillierMu,
  context = 'selftest',
}) {
  const range = proveRangeLindell({
    x: x1,
    rEnc,
    c: ckey,
    paillierN,
    paillierG,
    Q1,
    context,
  });
  verifyRangeLindell({
    c: ckey,
    paillierN,
    paillierG,
    Q1,
    proof: range,
    context,
  });
  const ch = pdlVerifierChallenge({ ckey, paillierN, paillierG, Q1 });
  const pr = pdlProverCommit({
    cPrime: ch.cPrime,
    paillierN,
    paillierG,
    paillierLambda,
    paillierMu,
  });
  const open = pdlVerifierOpen(ch);
  pdlProverFinish({
    alpha: pr.alpha,
    x1,
    a: open.a,
    b: open.b,
    Qhat: pr.Qhat,
    comQ: pr.comQ,
    nonceQ: pr.nonceQ,
    comAB: open.comAB,
    nonceAB: open.nonceAB,
    Q1,
  });
  pdlVerifierAccept({ ch, Qhat: pr.Qhat, nonceQ: pr.nonceQ, comQ: pr.comQ });
  return { ok: true, rangeT: range.t, pdlOk: true };
}

/**
 * Coinbase cb-mpc `zk_ecdsa_sign_2pc_integer_commit_t` (docs/spec ECDSA-2PC
 * §9 — ZK of message 4 from P2 to P1). Pedersen (N,g,h) are their published
 * unknown-order parameters.
 *
 * Proves c = Enc(k2^{-1} m + k2^{-1} x2 r + ρ q) · Enc(x1)^{k2^{-1} r}
 * with Q2 = x2·G and R2 = k2·G, without revealing k2, x2, ρ.
 */
export const SEC_P_STAT = 80;
export const SEC_P_COM = 128;
export const PEDERSEN_N = BigInt(
  '23021179409182938570359750938980338144228252278091272301373977814239751374837999838492546432888767127769655940068264100853353551499366755577355531007018750768200171255441698821574892336993202780622143746877429267180956985375718503710984554436993994314439687609895321760284136988355617570080829893220388340848662424870689770253814604041743989571505561981559749559655239486273235991420864634594679913369883938003881718526701794556221696559508817046918913994546361857215207106703848946440502419613199522137735334940177512343371386118880901797914415961377788512776238741479649148106573475707451684652229544231196914573289',
);
export const PEDERSEN_G = BigInt(
  '18692609727959642347495417395722097525189086531367077703372461312274023157993906686576615309234701031882307230283129349048160114209918340065147702452404381410406703543047035263825585677685288105331451962046612323375135943439625150989289125977704731027044468880699601265142162637878950397691930657280005244438693270908351393909855450315038730976563321234196068882925686057387933231622612372734407696300564311472069289215359164131367652584423723804201294306251241012679464813370234988048205813130011019436870655061686956966570610789218397436279311675374020440160625193097157363946641954583407515109646139183272575875147',
);
export const PEDERSEN_H = BigInt(
  '1048665143557212763219747740365925372973495762670564399175662900857975294535671104954036501552639642493753905307453170704505994561004317929987661874942164325790769136087625173204744153810498026365780398250521692204997255045340560453829554404127652590720296677920879093396879580879248242026646264911671785581014516272702688970899804455365256101399624385933528202110196550761839775309049444508960694778077273805944573689614247122411049825824247506775813394277339807872884192982983105098004844709850011190976172521026823264137921322799866525778649032062366285804392400257876447684994961367594957563285783650449234172753',
);

function randomLt(n) {
  if (n <= 1n) return 0n;
  const bits = n.toString(2).length;
  const len = (bits + 7) >> 3;
  return bytesToBig(randomBytes(len + 8)) % n;
}

function ecMul(P, k) {
  let s = k % CURVE_N;
  if (s < 0n) s += CURVE_N;
  if (s === 0n) return secp256k1.ProjectivePoint.ZERO;
  return P.multiply(s);
}

function pedersen(w, r) {
  return (modPow(PEDERSEN_G, w, PEDERSEN_N) * modPow(PEDERSEN_H, r, PEDERSEN_N)) % PEDERSEN_N;
}

function signCChallenge(parts) {
  const h = sha256Hex(['wart-lindell-c-zk-v1', ...parts.map(String)].join('|'));
  return BigInt('0x' + h.slice(0, SEC_P_COM / 4));
}

function invModQ(a) {
  return modPow(((a % CURVE_N) + CURVE_N) % CURVE_N, CURVE_N - 2n, CURVE_N);
}

function inRange(x, lo, hi) {
  return x >= lo && x < hi;
}

export function proveSignC({
  paillierN,
  paillierG,
  ckey,
  c,
  Q2Hex,
  R2Hex,
  m,
  r,
  k2,
  x2,
  rho,
  rc,
  sid = '0',
  aux = 0,
}) {
  const pub = new PublicKey(BigInt(paillierN), BigInt(paillierG));
  const N = pub.n;
  const q = CURVE_N;
  const Q2n = String(Q2Hex).replace(/^0x/i, '').toLowerCase();
  const R2n = String(R2Hex).replace(/^0x/i, '').toLowerCase();
  const R2 = pointFromHex(R2n);
  const Q2 = pointFromHex(Q2n);
  const cKey = BigInt(ckey);
  const c3 = BigInt(c);
  const mm = BigInt(m);
  const rr = BigInt(r);
  const w1 = invModQ(k2);
  const w2 = (w1 * (x2 % q)) % q;
  const w3 = BigInt(rho);
  const w4 = BigInt(rc);

  const cKeyR = pub.multiply(cKey, rr);

  const r1w = randomLt(PEDERSEN_N << BigInt(SEC_P_STAT));
  const r2w = randomLt(PEDERSEN_N << BigInt(SEC_P_STAT));
  const r3w = randomLt(PEDERSEN_N << BigInt(SEC_P_STAT));
  const W1 = pedersen(w1, r1w);
  const W2 = pedersen(w2, r2w);
  const W3 = pedersen(w3, r3w);

  const w1t = randomLt(q << BigInt(SEC_P_STAT + SEC_P_COM));
  const w2t = randomLt(q << BigInt(SEC_P_STAT + SEC_P_COM));
  const w3t = randomLt((q * q) << BigInt(3 * SEC_P_STAT + SEC_P_COM));
  const r1t = randomLt(PEDERSEN_N << BigInt(2 * SEC_P_STAT + SEC_P_COM));
  const r2t = randomLt(PEDERSEN_N << BigInt(2 * SEC_P_STAT + SEC_P_COM));
  const r3t = randomLt(PEDERSEN_N << BigInt(2 * SEC_P_STAT + SEC_P_COM));
  const W1t = pedersen(w1t, r1t);
  const W2t = pedersen(w2t, r2t);
  const W3t = pedersen(w3t, r3t);

  const Gtag = pointHex(ecMul(R2, w1t));
  const Q2tag = pointHex(ecMul(R2, w2t));

  const rEnc = randomCoprimeTo(N);
  const temp = w1t * mm + w2t * rr + w3t * q;
  const Cenc = pub.addition(pub.encrypt(temp, rEnc), pub.multiply(cKeyR, w1t));

  const e = signCChallenge([
    N,
    cKey,
    c3,
    Q2n,
    R2n,
    mm,
    rr,
    W1,
    W2,
    W3,
    W1t,
    W2t,
    W3t,
    Gtag,
    Q2tag,
    Cenc,
    sid,
    aux,
  ]);

  return {
    W1: W1.toString(10),
    W2: W2.toString(10),
    W3: W3.toString(10),
    W1t: W1t.toString(10),
    W2t: W2t.toString(10),
    W3t: W3t.toString(10),
    Gtag,
    Q2tag,
    Cenc: Cenc.toString(10),
    e: e.toString(10),
    w1tt: (w1t + e * w1).toString(10),
    w2tt: (w2t + e * w2).toString(10),
    w3tt: (w3t + e * w3).toString(10),
    r1tt: (r1t + e * r1w).toString(10),
    r2tt: (r2t + e * r2w).toString(10),
    r3tt: (r3t + e * r3w).toString(10),
    rEncTt: ((rEnc * modPow(w4, e, N)) % N).toString(10),
  };
}

export function verifySignC({
  paillierN,
  paillierG,
  ckey,
  c,
  Q2Hex,
  R2Hex,
  m,
  r,
  pokC,
  sid = '0',
  aux = 0,
}) {
  if (!pokC?.e || !pokC?.Cenc) {
    throw new Error('LINDELL_C_ZK_MISSING: need Coinbase integer-commit proof of c');
  }
  const pub = new PublicKey(BigInt(paillierN), BigInt(paillierG));
  const N = pub.n;
  const NN = pub._n2;
  const q = CURVE_N;
  const Q2 = pointFromHex(Q2Hex);
  const R2 = pointFromHex(R2Hex);
  const Gtag = pointFromHex(pokC.Gtag);
  const Q2tag = pointFromHex(pokC.Q2tag);
  const mm = BigInt(m);
  const rr = BigInt(r);
  const cKey = BigInt(ckey);
  const c3 = BigInt(c);
  const W1 = BigInt(pokC.W1);
  const W2 = BigInt(pokC.W2);
  const W3 = BigInt(pokC.W3);
  const W1t = BigInt(pokC.W1t);
  const W2t = BigInt(pokC.W2t);
  const W3t = BigInt(pokC.W3t);
  const Cenc = BigInt(pokC.Cenc);
  const e = BigInt(pokC.e);
  const w1tt = BigInt(pokC.w1tt);
  const w2tt = BigInt(pokC.w2tt);
  const w3tt = BigInt(pokC.w3tt);
  const r1tt = BigInt(pokC.r1tt);
  const r2tt = BigInt(pokC.r2tt);
  const r3tt = BigInt(pokC.r3tt);
  const rEncTt = BigInt(pokC.rEncTt);

  const eWant = signCChallenge([
    N,
    cKey,
    c3,
    String(Q2Hex).replace(/^0x/i, '').toLowerCase(),
    String(R2Hex).replace(/^0x/i, '').toLowerCase(),
    mm,
    rr,
    W1,
    W2,
    W3,
    W1t,
    W2t,
    W3t,
    String(pokC.Gtag).replace(/^0x/i, '').toLowerCase(),
    String(pokC.Q2tag).replace(/^0x/i, '').toLowerCase(),
    Cenc,
    sid,
    aux,
  ]);
  if (e !== eWant) throw new Error('LINDELL_C_ZK: Fiat-Shamir e mismatch');

  const pedHi = PEDERSEN_N << BigInt(2 * SEC_P_STAT + SEC_P_COM + 1);
  if (!inRange(r1tt, 0n, pedHi) || !inRange(r2tt, 0n, pedHi) || !inRange(r3tt, 0n, pedHi)) {
    throw new Error('LINDELL_C_ZK: Pedersen randomness out of range');
  }
  if (mm >= q || rr >= q) throw new Error('LINDELL_C_ZK: m or r not in Z_q');
  const w1hi = q << BigInt(SEC_P_STAT + SEC_P_COM + 1);
  const w3hi = (q * q) << BigInt(3 * SEC_P_STAT + SEC_P_COM + 1);
  if (!inRange(w1tt, 0n, w1hi) || !inRange(w2tt, 0n, w1hi) || !inRange(w3tt, 0n, w3hi)) {
    throw new Error('LINDELL_C_ZK: response out of range');
  }
  if (!inRange(rEncTt, 0n, N)) throw new Error('LINDELL_C_ZK: r_enc response not in Z_N');

  const Gcurve = G;
  if (pointHex(ecMul(R2, w1tt)) !== pointHex(ecMul(Gcurve, e).add(Gtag))) {
    throw new Error('LINDELL_C_ZK: w1·R2 ≠ eG + G_tag — k2 inverse not bound');
  }
  if (pointHex(ecMul(R2, w2tt)) !== pointHex(ecMul(Q2, e).add(Q2tag))) {
    throw new Error('LINDELL_C_ZK: w2·R2 ≠ e Q2 + Q2_tag — x2 not bound');
  }
  if (pedersen(w1tt, r1tt) !== (W1t * modPow(W1, e, PEDERSEN_N)) % PEDERSEN_N) {
    throw new Error('LINDELL_C_ZK: Pedersen W1');
  }
  if (pedersen(w2tt, r2tt) !== (W2t * modPow(W2, e, PEDERSEN_N)) % PEDERSEN_N) {
    throw new Error('LINDELL_C_ZK: Pedersen W2');
  }
  if (pedersen(w3tt, r3tt) !== (W3t * modPow(W3, e, PEDERSEN_N)) % PEDERSEN_N) {
    throw new Error('LINDELL_C_ZK: Pedersen W3');
  }

  const cKeyR = pub.multiply(cKey, rr);
  const temp = w1tt * mm + w2tt * rr + w3tt * q;
  const left = pub.addition(pub.encrypt(temp, rEncTt), pub.multiply(cKeyR, w1tt));
  const right = pub.addition(Cenc, pub.multiply(c3, e));
  if (left !== right) throw new Error('LINDELL_C_ZK: Paillier relation fails — c is not the Lindell tuple');
  return { ok: true };
}

export function sampleSignRho() {
  return randomLt((CURVE_N * CURVE_N) << BigInt(SEC_P_STAT * 2));
}

export { invModQ };
