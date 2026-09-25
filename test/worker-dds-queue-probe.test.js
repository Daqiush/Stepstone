'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');

const probe = import('../scripts/worker-dds-queue-probe.mjs');
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('ping completion time is captured before the solve response is awaited', async () => {
  const { probeTimedSolve } = await probe;
  const solve = deferred(), ping = deferred();
  let time = 0;
  const calls = [];
  const running = probeTimedSolve({
    sendSolve: () => { calls.push('solve'); return solve.promise; },
    sendPing: () => { calls.push('ping'); return ping.promise; },
    expectedCompletedOperations: 7, now: () => time,
  });
  assert.deepEqual(calls, ['solve', 'ping']);
  time = 50; ping.resolve({ ok: true, completedOperations: 8 });
  await Promise.resolve();
  time = 120; solve.resolve({ ok: true, result: { score: 1, cards: [{ suit: 'S', rank: 14 }] } });
  const result = await running;
  assert.equal(result.queueDelayMs, 50);
  assert.equal(result.completedOperations, 8);
});

test('malformed solve response rejects before a pending ping completes', async () => {
  const { probeTimedSolve } = await probe;
  const ping = deferred();
  await assert.rejects(() => probeTimedSolve({
    sendSolve: async () => ({ ok: true, result: null }),
    sendPing: () => ping.promise,
    expectedCompletedOperations: 0, now: () => 0,
    validateSolveResponse: () => { throw new Error('Malformed Worker response'); },
  }), /Malformed Worker response/);
});

for (const completedOperations of [7, 9, undefined]) {
  test(`ping counter ${completedOperations} cannot prove immediate solve ordering`, async () => {
    const { probeTimedSolve } = await probe;
    await assert.rejects(() => probeTimedSolve({
      sendSolve: async () => ({ ok: true }),
      sendPing: async () => ({ ok: true, completedOperations }),
      expectedCompletedOperations: 7, now: () => 1,
    }), /inconclusive|ordering/i);
  });
}
