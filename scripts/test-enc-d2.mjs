import { generateRandomKeys } from 'paillier-bigint';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  encryptWithR,
  proveEncEqualsDlog,
  verifyEncEqualsDlog,
  randomShareLindellRange,
  verifySignC,
} from '../src/utils/lindellZk.js';
import { cosignerSignStep, clientSignRound1 } from '../src/utils/twoPartyEcdsa.js';

const pt = (s) => {
  const n = secp256k1.CURVE.n;
  const d = ((s % n) + n) % n;
  return Buffer.from(secp256k1.ProjectivePoint.BASE.multiply(d).toRawBytes(true)).toString('hex');
};
const pad = (x) => x.toString(16).padStart(64, '0');

const { publicKey: pk, privateKey: sk } = await generateRandomKeys(512);
const d2 = randomShareLindellRange();
const P2 = pt(d2);
const enc = encryptWithR(pk, d2);
const ctx = 'test-offer-d2|tick';
const proof = proveEncEqualsDlog({
  x: d2, rEnc: enc.r, c: enc.c, paillierN: pk.n.toString(), paillierG: pk.g.toString(), Qhex: P2, context: ctx,
});
verifyEncEqualsDlog({
  c: enc.c, paillierN: pk.n.toString(), paillierG: pk.g.toString(), Qhex: P2, proof, context: ctx,
});
console.log('enc-dlog ok');

const dapp = 12345n;
const d1 = randomShareLindellRange();
const enc1 = encryptWithR(pk, d1);
const rnd = clientSignRound1();
const hashHex = '11'.repeat(32);
const Pd = pt(dapp);
const step = cosignerSignStep({
  R1Hex: rnd.R1Hex,
  hashHex,
  dappShareHex: pad(dapp),
  encD2Str: enc.c.toString(),
  ckeyStr: enc1.c.toString(),
  paillierN: pk.n.toString(),
  paillierG: pk.g.toString(),
  Q2Hex: Pd,
  sid: 'wart-pool-0:99',
});
const z = BigInt('0x' + hashHex) % secp256k1.CURVE.n;
const r = BigInt('0x' + step.rHex);
verifySignC({
  paillierN: pk.n.toString(),
  paillierG: pk.g.toString(),
  ckey: step.ckeyAdj,
  c: step.ciphertext,
  Q2Hex: step.Q2Hex,
  R2Hex: step.R2Hex,
  m: z,
  r,
  pokC: step.pokC,
  sid: 'wart-pool-0:99',
});
sk.decrypt(BigInt(step.ciphertext));
console.log('pokC+encD2 ok');
