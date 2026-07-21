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
const step = cosignerSignStep({
  R1Hex,
  hashHex,
  dappShareHex: vault.cosignerRegister.dappShareHex,
  ckeyStr: vault.cosignerRegister.ckey,
  paillierN: vault.cosignerRegister.paillierN,
  paillierG: vault.cosignerRegister.paillierG,
});
const sig = clientSignFinish({ k1Hex, rHex: step.rHex, ciphertext: step.ciphertext, hashHex, clientSecret: vault.clientSecret });
console.log('sig keys', Object.keys(sig));
console.log('OK');
