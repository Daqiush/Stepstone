'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');

const client = import('../scripts/worker-dds-queue-probe.mjs');
const server = import('../workers/src/ordered-queue-probe.mjs');
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('ordered pair enqueues distinct solve then ping and times ping completion', async () => {
  const { runOrderedQueueProbe } = await server;
  const solve = deferred(), ping = deferred();
  const calls = [];
  let queued = Promise.resolve();
  const enqueue = (label, pending) => {
    const command = queued.then(() => { calls.push(label); return pending.promise; });
    queued = command.then(() => {}, () => {});
    return command;
  };
  let clock = 10;
  const running = runOrderedQueueProbe({
    enqueueSolve: () => enqueue('solve', solve),
    enqueuePing: () => enqueue('ping', ping),
    now: () => clock,
  });
  await Promise.resolve();
  assert.deepEqual(calls, ['solve']);
  clock = 50; solve.resolve({ ok: true });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['solve', 'ping']);
  clock = 90; ping.resolve({ ok: true, completedOperations: 8 });
  const pair = await running;
  assert.equal(pair.solveCompletedMs, 40);
  assert.equal(pair.queueDelayMs, 80);
  assert.deepEqual(pair.pingResponse, { ok: true, completedOperations: 8 });
});

test('old independent transport overtake is rejected, never silently dropped', async () => {
  const { probeTimedSolve } = await client;
  await assert.rejects(() => probeTimedSolve({
    sendOrderedPair: async () => ({ ok: true, solveResponse: { ok: true },
      pingResponse: { ok: true, completedOperations: 7 }, solveCompletedMs: 20, queueDelayMs: 30 }),
    expectedCompletedOperations: 7,
  }), /Inconclusive queue ordering: expected completedOperations=8, got 7/);
});

test('valid ordered pair records exactly one solve and ping completion delay', async () => {
  const { probeTimedSolve } = await client;
  const pair = { ok: true, solveResponse: { ok: true }, pingResponse: { ok: true, completedOperations: 8 },
    solveCompletedMs: 40, queueDelayMs: 80 };
  const result = await probeTimedSolve({ sendOrderedPair: async () => pair, expectedCompletedOperations: 7 });
  assert.deepEqual(result, { solveResponse: pair.solveResponse, solveCompletedMs: 40,
    queueDelayMs: 80, completedOperations: 8 });
});

for (const [name, pair] of [
  ['missing pair', null],
  ['malformed ping', { ok: true, solveResponse: { ok: true }, pingResponse: null, solveCompletedMs: 1, queueDelayMs: 2 }],
  ['counter skipped', { ok: true, solveResponse: { ok: true }, pingResponse: { ok: true, completedOperations: 9 }, solveCompletedMs: 1, queueDelayMs: 2 }],
  ['negative delay', { ok: true, solveResponse: { ok: true }, pingResponse: { ok: true, completedOperations: 8 }, solveCompletedMs: 1, queueDelayMs: -1 }],
  ['ping precedes solve', { ok: true, solveResponse: { ok: true }, pingResponse: { ok: true, completedOperations: 8 }, solveCompletedMs: 3, queueDelayMs: 2 }],
]) test(`${name} fails the ordered queue probe`, async () => {
  const { probeTimedSolve } = await client;
  await assert.rejects(() => probeTimedSolve({ sendOrderedPair: async () => pair,
    expectedCompletedOperations: 7 }), /Malformed ordered queue probe|Inconclusive queue ordering/);
});

test('transport timeout fails the ordered queue probe explicitly', async () => {
  const { probeTimedSolve } = await client;
  await assert.rejects(() => probeTimedSolve({
    sendOrderedPair: async () => { throw new Error('Ordered queue probe timeout'); },
    expectedCompletedOperations: 7,
  }), /Ordered queue probe timeout/);
});

test('malformed solve fails before a pair can count as evidence', async () => {
  const { probeTimedSolve } = await client;
  await assert.rejects(() => probeTimedSolve({
    sendOrderedPair: async () => ({ ok: true, solveResponse: { ok: true, result: null },
      pingResponse: { ok: true, completedOperations: 8 }, solveCompletedMs: 1, queueDelayMs: 2 }),
    expectedCompletedOperations: 7,
    validateSolveResponse: () => { throw new Error('Malformed Worker response'); },
  }), /Malformed Worker response/);
});
