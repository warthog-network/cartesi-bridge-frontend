import { generateRandomKeys } from 'paillier-bigint';
import {
  randomShareLindellRange,
  encryptWithR,
  runLindellPdl,
  proveRangeLindell,
  verifyRangeLindell,
} from '../src/utils/lindellZk.js';
import { secp256k1 } from '@noble/curves/secp256k1';

const G = secp256k1.ProjectivePoint.BASE;
function hx(P) {
  return Buffer.from(P.toRawBytes(true)).toString('hex');
}

console.time('paillier');
const { publicKey: pk, privateKey: sk } = await generateRandomKeys(2048);
console.timeEnd('paillier');
const x1 = randomShareLindellRange();
const Q1 = hx(G.multiply(x1));
const enc = encryptWithR(pk, x1);
console.time('pdl');
const r = runLindellPdl({
  x1,
  rEnc: enc.r,
  ckey: enc.c.toString(),
  Q1,
  paillierN: pk.n.toString(),
  paillierG: pk.g.toString(),
  paillierLambda: sk.lambda.toString(),
  paillierMu: sk.mu.toString(),
  context: 'unit',
});
console.timeEnd('pdl');
console.log(r);

const poison = pk.encrypt(x1 + 1n);
let threw = false;
try {
  const pr = proveRangeLindell({
    x: x1,
    rEnc: enc.r,
    c: poison,
    paillierN: pk.n.toString(),
    paillierG: pk.g.toString(),
    Q1,
    context: 'poison',
  });
  verifyRangeLindell({
    c: poison,
    paillierN: pk.n.toString(),
    paillierG: pk.g.toString(),
    Q1,
    proof: pr,
    context: 'poison',
  });
} catch (e) {
  threw = /LINDELL_RANGE/.test(e.message);
  console.log('poison range:', e.message.slice(0, 120));
}
if (!threw) throw new Error('poisoned ciphertext must fail range');
console.log('PDL UNIT OK');
