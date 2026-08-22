/**
 * Time Path B-shaped Lindell sign (same JS as Path A cosignerSignStep + finish).
 * Birth/PDL is separate and is not on the withdrawal hot path.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  createTwoPartyVault,
  clientSignRound1,
  cosignerSignStep,
  clientSignFinish,
} from '../src/utils/twoPartyEcdsa.js';
import { createHash } from 'crypto';

const rounds = Number(process.argv[2] || 5);
console.time('keygen');
const vault = await createTwoPartyVault({
  subAddress: 'aa'.repeat(24),
  index: 1,
  owner: '0x' + '11'.repeat(20),
});
console.timeEnd('keygen');

const dapp = BigInt('0x' + vault.cosignerRegister.dappShareHex);
const Q2Hex = Buffer.from(
  secp256k1.ProjectivePoint.BASE.multiply(dapp).toRawBytes(true),
).toString('hex');
const hashHex = createHash('sha256').update('bench').digest('hex');

const stepMs = [];
const finishMs = [];
for (let i = 0; i < rounds; i++) {
  const { k1Hex, R1Hex } = clientSignRound1();
  const t0 = performance.now();
  const step = cosignerSignStep({
    R1Hex,
    hashHex,
    dappShareHex: vault.cosignerRegister.dappShareHex,
    ckeyStr: vault.cosignerRegister.ckey,
    paillierN: vault.cosignerRegister.paillierN,
    paillierG: vault.cosignerRegister.paillierG,
    Q2Hex,
    sid: 'bench',
  });
  const t1 = performance.now();
  clientSignFinish({
    k1Hex,
    rHex: step.rHex,
    ciphertext: step.ciphertext,
    hashHex,
    clientSecret: vault.clientSecret,
    RHex: step.RHex,
    pokR: step.pokR,
    pokC: step.pokC,
    R2Hex: step.R2Hex,
    Q2Hex: step.Q2Hex,
    ckeyAdj: step.ckeyAdj,
    sid: 'bench',
  });
  const t2 = performance.now();
  stepMs.push(t1 - t0);
  finishMs.push(t2 - t1);
  console.log(
    `round ${i + 1}: prove(cosigner) ${(t1 - t0).toFixed(0)}ms  verify+decrypt(d1) ${(t2 - t1).toFixed(0)}ms  total ${(t2 - t0).toFixed(0)}ms`,
  );
}

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
console.log(
  JSON.stringify(
    {
      rounds,
      proveMs: { avg: Math.round(avg(stepMs)), med: Math.round(med(stepMs)) },
      verifyMs: { avg: Math.round(avg(finishMs)), med: Math.round(med(finishMs)) },
      signTotalMs: {
        avg: Math.round(avg(stepMs.map((x, i) => x + finishMs[i]))),
        med: Math.round(med(stepMs.map((x, i) => x + finishMs[i]))),
      },
      note: 'JS Node, 2048-bit Paillier. Not including orbit/prepare/broadcast.',
    },
    null,
    2,
  ),
);
