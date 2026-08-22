import {
  createTwoPartyVault,
  encryptJsonWithMnemonic,
  decryptJsonWithMnemonic,
  isAesGcmClientSecretBlob,
  DEFAULT_PAILLIER_BITS,
  cosignerSignStep,
  clientSignRound1,
  clientSignFinish,
} from '../src/utils/twoPartyEcdsa.js';
import { createHash } from 'crypto';
import { secp256k1 } from '@noble/curves/secp256k1';

console.log('PAILLIER default bits', DEFAULT_PAILLIER_BITS);
console.time('keygen');
const vault = await createTwoPartyVault({ subAddress: 'aa'.repeat(24), index: 1, owner: '0x'+'11'.repeat(20) });
console.timeEnd('keygen');
console.log('address', vault.address.slice(0,16), 'paillierBits', vault.clientSecret.paillierBits);
console.log('has dapp in client?', 'dappShareHex' in vault.clientSecret);

const enc = await encryptJsonWithMnemonic(vault.clientSecret, 'test mnemonic words here');
console.log('aes v2?', isAesGcmClientSecretBlob(enc), enc.slice(0,48));
const dec = await decryptJsonWithMnemonic(enc, 'test mnemonic words here');
console.log('roundtrip user share', dec.userShareHex === vault.clientSecret.userShareHex);

const hashHex = createHash('sha256').update('test').digest('hex');
const { k1Hex, R1Hex } = clientSignRound1();
const dapp = BigInt('0x' + vault.cosignerRegister.dappShareHex);
const Q2Hex = Buffer.from(secp256k1.ProjectivePoint.BASE.multiply(dapp).toRawBytes(true)).toString('hex');
const step = cosignerSignStep({
  R1Hex,
  hashHex,
  dappShareHex: vault.cosignerRegister.dappShareHex,
  ckeyStr: vault.cosignerRegister.ckey,
  paillierN: vault.cosignerRegister.paillierN,
  paillierG: vault.cosignerRegister.paillierG,
  Q2Hex,
  sid: 'aes-keygen',
});
const sig = clientSignFinish({
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
  sid: 'aes-keygen',
});
console.log('sig keys', Object.keys(sig));
console.log('OK');
