import assert from 'node:assert/strict';
import { sweepPackDecision } from '../src/utils/server/sweepPackGate.mjs';
import { rotationBlocksNewUserRooms } from '../src/utils/server/pool3p.mjs';
import { ethRotationBlocksNewUserRooms } from '../src/utils/server/poolEth3p.mjs';

const good = ['node-a', 'node-b', 'node-c'];
const sealed = (holders) => ({ next: true, t: 2, holders });

const ready = sweepPackDecision({
  nextPacks: { 1: sealed(good), 2: sealed(['node-a', 'node-b']) },
  eligibleIds: good,
});
assert.equal(ready.ok, true, ready.reason);
assert.equal(ready.reason, null);

const onePeer = sweepPackDecision({
  nextPacks: { 1: sealed(['only-one']), 2: sealed(['only-one']) },
  eligibleIds: ['only-one'],
});
assert.equal(onePeer.ok, false);
assert.match(onePeer.reason, /have 1/);
assert.match(onePeer.reason, /deposits and withdrawals stay on the live Q/);

const thin = sweepPackDecision({
  nextPacks: { 1: sealed(['node-a', 'node-b']), 2: sealed(['node-a']) },
  eligibleIds: good,
});
assert.equal(thin.ok, false);
assert.match(thin.reason, /e?2|d2/);
assert.deepEqual(thin.missing, ['2']);

const livePack = sweepPackDecision({
  nextPacks: {
    1: { next: false, t: 2, holders: good },
    2: sealed(good),
  },
  eligibleIds: good,
});
assert.equal(livePack.ok, false);
assert.deepEqual(livePack.missing, ['1']);

const ignored = sweepPackDecision({
  nextPacks: { 1: sealed(['official1', 'denylisted']), 2: sealed(good) },
  eligibleIds: good,
});
assert.equal(ignored.ok, false);
assert.deepEqual(ignored.missing, ['1']);

assert.equal(rotationBlocksNewUserRooms('next_ready'), false);
assert.equal(rotationBlocksNewUserRooms('need_birth'), false);
assert.equal(rotationBlocksNewUserRooms('idle'), false);
assert.equal(rotationBlocksNewUserRooms('announced'), true);
assert.equal(rotationBlocksNewUserRooms('sweeping'), true);
assert.equal(rotationBlocksNewUserRooms('cutover'), true);

assert.equal(ethRotationBlocksNewUserRooms('next_ready'), false);
assert.equal(ethRotationBlocksNewUserRooms('need_birth'), false);
assert.equal(ethRotationBlocksNewUserRooms('sweeping'), true);
assert.equal(ethRotationBlocksNewUserRooms('cutover'), true);

console.log('sweep pack gate ok');
