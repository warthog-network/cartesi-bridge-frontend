#!/usr/bin/env node
/**
 * Pure-function checks for src/utils/server/rollupsApi.mjs (no network).
 *   node scripts/test-rollups-api.mjs
 * Selector expectations come from @cartesi/rollups 2.2.0 `methodIdentifiers`.
 */
import assert from 'node:assert/strict';
import * as api from '../src/utils/server/rollupsApi.mjs';

let n = 0;
const ok = (name) => {
  n += 1;
  console.log(`ok ${n} - ${name}`);
};

// selectors (from the compiled Outputs / Application / IInputBox artifacts)
assert.equal(api.NOTICE_SELECTOR, '0xc258d6e5');
assert.equal(api.VOUCHER_SELECTOR, '0x237a816f');
assert.equal(api.DELEGATE_CALL_VOUCHER_SELECTOR, '0x10321e8b');
assert.equal(api.selectorOf('validateOutput(bytes,(uint64,bytes32[]))'), '0xe88d39c0');
assert.equal(api.selectorOf('executeOutput(bytes,(uint64,bytes32[]))'), '0x33137b76');
assert.equal(api.selectorOf('wasOutputExecuted(uint256)'), '0x71891db0');
assert.equal(api.selectorOf('addInput(address,bytes)'), '0x1789cd63');
assert.equal(api.selectorOf('isOutputsMerkleRootValid(address,bytes32)'), '0xe5cc8664');
ok('selectors match @cartesi/rollups 2.2.0');

// notice raw_data round trip
const payloadObj = { type: 'pool_release_ticket', ticketId: 'wart-pool-0:8', amountE8: '100000000' };
const payloadHex = '0x' + Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('hex');
const raw = api.encodeNoticeRawData(payloadHex);
assert.equal(raw.slice(0, 10), api.NOTICE_SELECTOR);
// abi.encode(bytes): offset word + length word + padded data
assert.equal(raw.slice(10, 74), '0'.repeat(62) + '20');
const dec = api.decodeOutputRawData(raw);
assert.equal(dec.type, 'notice');
assert.equal(dec.payloadHex.toLowerCase(), payloadHex.toLowerCase());
assert.deepEqual(api.decodeJsonPayload(dec.payloadHex), payloadObj);
ok('Notice(bytes) raw_data encode/decode round trip');

// voucher raw_data round trip
const dest = '0xbc174ba3265e5e0fbdefa2a8c9fda5f334471287';
const mint = '0x40c10f19' + '0'.repeat(24) + 'd43799597cd40d639d17466132908672bd08151f' + '0'.repeat(63) + '1';
const vraw = api.encodeVoucherRawData(dest, 0, mint);
assert.equal(vraw.slice(0, 10), api.VOUCHER_SELECTOR);
const vdec = api.decodeOutputRawData(vraw);
assert.equal(vdec.type, 'voucher');
assert.equal(vdec.destination.toLowerCase(), dest);
assert.equal(vdec.value, '0');
assert.equal(vdec.payloadHex.toLowerCase(), mint.toLowerCase());
ok('Voucher(address,uint256,bytes) raw_data encode/decode round trip');

// unknown selector
assert.equal(api.decodeOutputRawData('0xdeadbeef' + '00'.repeat(32)).type, 'unknown');
assert.equal(api.decodeOutputRawData('0x').type, 'unknown');
ok('unknown raw_data is reported, not thrown');

// validateOutput / executeOutput call encoding
const sibs = ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32), '33'.repeat(32)];
const proof = { outputIndex: 7, outputHashesSiblings: sibs };
const call = api.encodeValidateOutputCall(raw, proof);
assert.equal(call.slice(0, 10), '0xe88d39c0');
// head: offset(output)=0x40, offset(proof)=…; then output bytes, then proof tuple
assert.equal(call.slice(10, 74), '0'.repeat(62) + '40');
const exec = api.encodeExecuteOutputCall(raw, proof);
assert.equal(exec.slice(0, 10), '0x33137b76');
assert.equal(exec.slice(10), call.slice(10), 'execute and validate share the argument encoding');
// decode back through ethers to confirm the tuple layout
const { Interface } = await import('ethers-v6');
const iface = new Interface(api.APPLICATION_V2_ABI);
const [outArg, proofArg] = iface.decodeFunctionData('validateOutput', call);
assert.equal(outArg.toLowerCase(), raw.toLowerCase());
assert.equal(BigInt(proofArg.outputIndex), 7n);
assert.equal(proofArg.outputHashesSiblings.length, 3);
assert.equal(proofArg.outputHashesSiblings[2].toLowerCase(), '0x' + '33'.repeat(32));
ok('validateOutput/executeOutput (bytes,(uint64,bytes32[])) encoding decodes back');

// proof readiness, both versions
assert.equal(api.proofV2Ready(null), false);
assert.equal(api.proofV2Ready({ outputIndex: 1, outputHashesSiblings: [] }), false);
assert.equal(api.proofV2Ready(proof), true);
assert.equal(api.noticeHasProof({ proof }), true);
assert.equal(api.noticeHasProof({ proof: null }), false);
const v1proof = {
  context: '0x00',
  validity: {
    inputIndexWithinEpoch: 0,
    outputIndexWithinInput: 0,
    outputHashesRootHash: '0x' + '01'.repeat(32),
    vouchersEpochRootHash: '0x' + '02'.repeat(32),
    noticesEpochRootHash: '0x' + '03'.repeat(32),
    machineStateHash: '0x' + '04'.repeat(32),
    outputHashInOutputHashesSiblings: ['0x' + '05'.repeat(32)],
    outputHashesInEpochSiblings: ['0x' + '06'.repeat(32)],
  },
};
assert.equal(api.noticeHasEpochProofV1(v1proof), true);
assert.equal(api.noticeHasProof({ proof: v1proof }), true);
assert.equal(api.noticeHasEpochProofV1({ ...v1proof, validity: { ...v1proof.validity, outputHashesInEpochSiblings: [] } }), false);
ok('proof readiness (v1 validity, v2 siblings)');

// version switch + public block
assert.equal(api.apiVersion(), process.env.ROLLUPS_API === 'v2' ? 'v2' : 'v1');
const pub = api.publicRollupsBlock();
assert.ok(['v1', 'v2'].includes(pub.api));
assert.ok(/^https?:\/\//.test(pub.inspectUrl), 'public URLs are absolute for cross-origin signers');
assert.ok(/^https?:\/\//.test(pub.l1RpcUrl));
if (pub.api === 'v2') assert.ok(/^https?:\/\//.test(pub.rpcUrl));
else assert.ok(/^https?:\/\//.test(pub.graphqlUrl));
ok(`publicRollupsBlock (${pub.api})`);

console.log(`\n${n} groups passed`);
