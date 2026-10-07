'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const ROOT = resolve(__dirname, '..');
const activation = '00000000-0000-4000-8000-000000000001';
const request = (index) => ({ route: '/__dds/solve', body: JSON.stringify({ index }) });

// Only the external DDS execution and state storage are substituted here. The
// bounded runner, parity validation, and ledger reconciliation remain real.
async function segmentHarness(t, { count = 3, cursor = 0, pending = false } = {}) {
  const runner = await import('../scripts/remote-worker-dds-soak.mjs');
  const { ledgerAccounting } = await import('../scripts/remote-dds-soak-state.mjs');
  const runDir = mkdtempSync(join(tmpdir(), 'remote-dds-segment-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const table = Array.from({ length: 5 }, () => [0, 0, 0, 0]);
  const operations = Array.from({ length: count }, (_, index) => ({ index, id: `case-${index}`, kind: 'table', shard: Math.floor(index / 2000), route: '/__dds/table', body: JSON.stringify({ hands: {}, index }), item: { hands: {} } }));
  const events = [];
  const physicalOperations = [{ operationId: 'preflight.metrics', route: '/__dds/metrics', replayed: false }];
  for (let index = 0; index < cursor; index++) physicalOperations.push({ operationId: `op.${String(index).padStart(6, '0')}`, route: '/__dds/table', replayed: false });
  const state = {
    manifest: { runId: 'soak-test', hashes: { fixtureCorpus: 'fixture-hash' } },
    report: { completedCursor: cursor, observed: ledgerAccounting(physicalOperations), terminalFailure: null },
    physicalOperations, evidence: [], fixtureEvidence: [], preflightEvidence: null,
    recovery: pending ? { kind: 'replay-pending', intent: { index: cursor, operationId: `op.${String(cursor).padStart(6, '0')}` } } : { kind: 'ready' },
    hasPhysicalOperation: (id) => physicalOperations.some((item) => item.operationId === id),
    recordAuxiliaryIntent: (intent) => events.push(['aux-intent', intent.operationId]),
    recordAuxiliaryResponse(response) { physicalOperations.push({ ...response }); this.report.observed = ledgerAccounting(physicalOperations); },
    recordIntent(intent) { this.pending = intent; events.push(['intent', intent.index]); },
    recordCompletion(response) {
      const index = this.report.completedCursor;
      physicalOperations.push({ operationId: response.operationId, route: operations[index].route, replayed: response.replayed });
      this.report.completedCursor++; this.report.observed = ledgerAccounting(physicalOperations); this.pending = null;
      events.push(['complete', index]);
    },
    completeReplay(response) { this.recordCompletion(response); events.push(['replay', this.report.completedCursor - 1]); },
    recordFailure(failure) { this.report.terminalFailure = failure; events.push(['failure', failure.operationId]); },
  };
  let now = 0;
  const options = { endpoint: 'https://test.workers.dev', runDir, resume: false, maxNewOperations: 6000, deadlineMs: null };
  const dependencies = {
    operations, fixtures: [], runId: 'soak-test', deployment: { buildId: 'build-test', workerVersionId: 'version-test', assets: [] },
    stateFactory: () => state, baseline: async () => table, monotonicNow: () => now,
    wallNow: () => new Date('2026-09-30T00:00:00.000Z'), key: 'request-key-must-not-leak',
    readEvidence: () => ({ operations: [], fixtures: [], candidateDifferences: [] }),
    writeCheckpoint: () => {},
    remotePost: async (_endpoint, args) => {
      events.push(['dispatch', args.operationId]);
      return { operationResult: { ok: true, result: table, activationId: activation, buildId: 'build-test', workerVersionId: 'version-test' }, accounting: {}, accountingActivationId: activation, replayed: false };
    },
  };
  return { runner, options, dependencies, state, events, runDir, setNow: (value) => { now = value; } };
}

test('segment stops before operation 6001 is journaled or dispatched', async (t) => {
  const h = await segmentHarness(t, { count: 6001 });
  const result = await h.runner.runRemoteSoak(h.options, h.dependencies);
  assert.equal(result.disposition, 'PAUSED');
  assert.equal(result.reason, 'MAX_NEW_OPERATIONS');
  assert.equal(result.completedThisSegment, 6000);
  assert.equal(h.state.report.completedCursor, 6000);
  assert.equal(h.events.some(([kind, index]) => kind === 'intent' && index === 6000), false);
});

test('deadline is checked before the next durable intent', async (t) => {
  const h = await segmentHarness(t);
  h.options.deadlineMs = 10;
  let clockReads = 0;
  h.dependencies.monotonicNow = () => clockReads++ === 0 ? 0 : 10;
  const result = await h.runner.runRemoteSoak(h.options, h.dependencies);
  assert.equal(result.disposition, 'PAUSED');
  assert.equal(result.reason, 'DEADLINE');
  assert.equal(h.events.some(([kind]) => kind === 'intent'), false);
});

test('a received response is durably completed before a deadline pause', async (t) => {
  const h = await segmentHarness(t);
  h.options.deadlineMs = 10;
  const post = h.dependencies.remotePost;
  h.dependencies.remotePost = async (...args) => { const response = await post(...args); h.setNow(10); return response; };
  const result = await h.runner.runRemoteSoak(h.options, h.dependencies);
  assert.equal(result.reason, 'DEADLINE');
  assert.equal(h.state.report.completedCursor, 1);
  assert.deepEqual(h.events.map(([kind]) => kind), ['intent', 'dispatch', 'complete']);
});

test('an expired segment first replays its recovered pending intent', async (t) => {
  const h = await segmentHarness(t, { pending: true });
  h.options.resume = true; h.options.deadlineMs = 10;
  let reads = 0;
  h.dependencies.monotonicNow = () => reads++ === 0 ? 0 : 10;
  const result = await h.runner.runRemoteSoak(h.options, h.dependencies);
  assert.equal(result.reason, 'DEADLINE');
  assert.equal(result.completedThisSegment, 0);
  assert.equal(h.state.report.completedCursor, 1);
  assert.deepEqual(h.events.map(([kind]) => kind), ['dispatch', 'complete', 'replay']);
});

test('a recovered pending completion does not consume the new-operation allowance', async (t) => {
  const h = await segmentHarness(t, { count: 6002, pending: true });
  h.options.resume = true;
  const result = await h.runner.runRemoteSoak(h.options, h.dependencies);
  assert.equal(result.reason, 'MAX_NEW_OPERATIONS');
  assert.equal(result.completedThisSegment, 6000);
  assert.equal(h.state.report.completedCursor, 6001);
  assert.equal(h.events.filter(([kind]) => kind === 'intent').length, 6000);
});

test('a completed cursor 22000 resumes without remote calls and reconciles its final ledger', async (t) => {
  const h = await segmentHarness(t, { count: 22000, cursor: 22000 });
  h.options.resume = true;
  const result = await h.runner.runRemoteSoak(h.options, h.dependencies);
  assert.equal(result.disposition, 'COMPLETE');
  assert.equal(result.reason, null);
  assert.equal(h.events.length, 0);
  h.state.physicalOperations.pop();
  await assert.rejects(h.runner.runRemoteSoak(h.options, h.dependencies), /missing required operation|reconcile/);
});

test('a journal-backed terminal failure rejects even when the segment deadline is exhausted', async (t) => {
  const h = await segmentHarness(t);
  h.options.deadlineMs = 10;
  h.state.report.terminalFailure = { operationId: 'op.000000', error: 'SEEDED_OPERATION_FAILED' };
  h.state.recovery = { kind: 'failed', failure: h.state.report.terminalFailure };
  let reads = 0; h.dependencies.monotonicNow = () => reads++ === 0 ? 0 : 10;
  await assert.rejects(h.runner.runRemoteSoak(h.options, h.dependencies), /terminal|failed/i);
});

test('a paused segment atomically persists its versioned public disposition', async (t) => {
  const h = await segmentHarness(t);
  const { writeReportCheckpoint } = await import('../scripts/worker-dds-checkpoint.mjs');
  h.dependencies.writeCheckpoint = writeReportCheckpoint;
  h.options.maxNewOperations = 1;
  const result = await h.runner.runRemoteSoak(h.options, h.dependencies);
  const persisted = JSON.parse(readFileSync(join(h.runDir, 'segment-result.json'), 'utf8'));
  assert.deepEqual(persisted, result);
  assert.deepEqual(persisted, { version: 1, disposition: 'PAUSED', reason: 'MAX_NEW_OPERATIONS', completedCursor: 1,
    completedThisSegment: 1, startedAt: '2026-09-30T00:00:00.000Z', finishedAt: '2026-09-30T00:00:00.000Z' });
  assert.equal(readdirSync(h.runDir).some((file) => file.endsWith('.tmp')), false);
  assert.equal(JSON.stringify(persisted).includes(h.dependencies.key), false);
});

test('a complete segment atomically persists COMPLETE with no pause reason', async (t) => {
  const h = await segmentHarness(t, { count: 1 });
  h.dependencies.writeCheckpoint = (await import('../scripts/worker-dds-checkpoint.mjs')).writeReportCheckpoint;
  const result = await h.runner.runRemoteSoak(h.options, h.dependencies);
  assert.equal(result.disposition, 'COMPLETE');
  assert.equal(result.reason, null);
  assert.equal(result.completedCursor, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(h.runDir, 'segment-result.json'), 'utf8')), result);
});

for (const reason of ['INITIALIZATION_FAILED', 'PREFLIGHT_FAILED', 'FIXTURE_FAILED', 'PENDING_REPLAY_FAILED', 'SEEDED_OPERATION_FAILED', 'FINAL_ACCOUNTING_FAILED']) {
  test(`a ${reason} persists only its stage code and rejects the original error`, async (t) => {
    const h = await segmentHarness(t, { pending: reason === 'PENDING_REPLAY_FAILED' });
    h.dependencies.writeCheckpoint = (await import('../scripts/worker-dds-checkpoint.mjs')).writeReportCheckpoint;
    const original = new Error('endpoint-key request-key token-fragment raw-stack response-body');
    if (reason === 'INITIALIZATION_FAILED') h.dependencies.stateFactory = () => { throw original; };
    if (reason === 'PREFLIGHT_FAILED') {
      h.state.physicalOperations.length = 0;
      h.dependencies.remotePost = async () => { throw original; };
    }
    if (reason === 'FIXTURE_FAILED') h.dependencies.fixtures = [{ kind: 'table', get hands() { throw original; } }];
    if (reason === 'PENDING_REPLAY_FAILED' || reason === 'SEEDED_OPERATION_FAILED') h.dependencies.remotePost = async () => { throw original; };
    if (reason === 'FINAL_ACCOUNTING_FAILED') {
      h.state.report.completedCursor = 3;
      // Final reconciliation is deliberately real: the ledger is missing the
      // completed operations, and must reject even if a deadline has elapsed.
    }
    await assert.rejects(h.runner.runRemoteSoak(h.options, h.dependencies), (error) => reason === 'FINAL_ACCOUNTING_FAILED' ? /missing required/.test(error.message) : error === original);
    const text = readFileSync(join(h.runDir, 'segment-result.json'), 'utf8');
    const persisted = JSON.parse(text);
    assert.deepEqual(persisted, { version: 1, disposition: 'FAILED', reason, completedCursor: reason === 'FINAL_ACCOUNTING_FAILED' ? 3 : 0,
      completedThisSegment: 0, startedAt: '2026-09-30T00:00:00.000Z', finishedAt: '2026-09-30T00:00:00.000Z' });
    for (const fragment of ['endpoint-key', 'request-key', 'token-fragment', 'raw-stack', 'response-body', h.dependencies.key]) assert.equal(text.includes(fragment), false);
    assert.equal(readdirSync(h.runDir).some((file) => file.endsWith('.tmp')), false);
    const failure = h.events.find(([kind]) => kind === 'failure');
    assert.equal(Boolean(failure), ['PENDING_REPLAY_FAILED', 'SEEDED_OPERATION_FAILED'].includes(reason));
  });
}

test('a failed disposition checkpoint cannot mask the operation rejection', async (t) => {
  const h = await segmentHarness(t);
  const original = new Error('seeded failure');
  h.dependencies.remotePost = async () => { throw original; };
  h.dependencies.writeCheckpoint = (file) => { if (file.endsWith('segment-result.json')) throw new Error('disk full'); };
  await assert.rejects(h.runner.runRemoteSoak(h.options, h.dependencies), (error) => error === original);
  assert.equal(h.state.report.terminalFailure.error, 'SEEDED_OPERATION_FAILED');
});

for (const disposition of ['PAUSED', 'COMPLETE']) {
  test(`a ${disposition} result checkpoint rejection is not reclassified or retried`, async (t) => {
    const h = await segmentHarness(t, { count: disposition === 'COMPLETE' ? 1 : 3 });
    h.options.maxNewOperations = 1;
    const durable = await useDurableState(h);
    const stateFactory = h.dependencies.stateFactory;
    let failureCalls = 0;
    h.dependencies.stateFactory = (args) => {
      const state = stateFactory(args);
      const recordFailure = state.recordFailure;
      state.recordFailure = (failure) => { failureCalls++; return recordFailure(failure); };
      return state;
    };
    const checkpoint = h.dependencies.writeCheckpoint;
    const original = new Error('segment result storage failed');
    const attemptedResults = [];
    h.dependencies.writeCheckpoint = (file, report) => {
      if (file.endsWith('segment-result.json')) {
        attemptedResults.push(report);
        throw original;
      }
      return checkpoint(file, report);
    };
    await assert.rejects(h.runner.runRemoteSoak(h.options, h.dependencies), (error) => error === original);
    assert.deepEqual(attemptedResults.map((result) => result.disposition), [disposition]);
    assert.equal(attemptedResults[0].reason, disposition === 'PAUSED' ? 'MAX_NEW_OPERATIONS' : null);
    assert.equal(failureCalls, 0);
    const recovered = durable.recover();
    assert.equal(recovered.recovery.kind, 'ready');
    assert.equal(recovered.report.completedCursor, 1);
    assert.equal(recovered.report.terminalFailure, null);
  });
}

async function useDurableState(h, { pending = false } = {}) {
  const storage = await import('../scripts/remote-dds-soak-state.mjs');
  h.dependencies.writeCheckpoint = (await import('../scripts/worker-dds-checkpoint.mjs')).writeReportCheckpoint;
  let state;
  let stateArgs;
  h.dependencies.stateFactory = (args) => {
    stateArgs = args;
    state = storage.createSoakState(args);
    if (pending) {
      state.recordIntent({ index: 0, operationId: 'op.000000', ...h.dependencies.operations[0] });
      state = storage.recoverSoakState(args);
    }
    return state;
  };
  const post = h.dependencies.remotePost;
  h.dependencies.remotePost = async (...args) => {
    const response = await post(...args);
    const physical = { operationId: args[1].operationId, route: args[1].route, shard: args[1].shard,
      replayed: response.replayed, accountingActivationId: response.accountingActivationId };
    response.accounting = storage.ledgerAccounting(state.physicalOperations.concat(physical).filter((item) =>
      String(item.shard ?? '0') === String(physical.shard) && item.accountingActivationId === physical.accountingActivationId));
    return response;
  };
  return { recover: () => storage.recoverSoakState(stateArgs) };
}

for (const pending of [false, true]) {
  test(`${pending ? 'pending replay' : 'seeded'} failure is durable for the same operation identity`, async (t) => {
    const h = await segmentHarness(t);
    const durable = await useDurableState(h, { pending });
    const post = h.dependencies.remotePost;
    const original = new Error('unsafe response-body request-key');
    h.dependencies.remotePost = async (...args) => {
      if (args[1].operationId.startsWith('op.')) throw original;
      return post(...args);
    };
    await assert.rejects(h.runner.runRemoteSoak(h.options, h.dependencies), (error) => error === original);
    const recovered = durable.recover();
    assert.equal(recovered.recovery.kind, 'failed');
    assert.deepEqual(recovered.report.terminalFailure, { type: 'failed', index: 0, operationId: 'op.000000', error: pending ? 'PENDING_REPLAY_FAILED' : 'SEEDED_OPERATION_FAILED' });
    assert.deepEqual(recovered.recovery.failure, recovered.report.terminalFailure);
  });
}

for (const failure of ['parity', 'protocol', 'activation', 'transport']) {
  test(`seeded ${failure} failure rejects rather than reporting a deadline pause`, async (t) => {
    const h = await segmentHarness(t);
    h.options.deadlineMs = 10;
    const durable = await useDurableState(h);
    const post = h.dependencies.remotePost;
    h.dependencies.remotePost = async (...args) => {
      const response = await post(...args);
      if (args[1].operationId.startsWith('op.')) {
        h.setNow(10);
        if (failure === 'transport') throw new Error('Remote transport failed');
        if (failure === 'protocol') response.operationResult.result = null;
        if (failure === 'parity') response.operationResult.result = Array.from({ length: 5 }, () => [1, 1, 1, 1]);
        if (failure === 'activation') response.operationResult.activationId = 'invalid';
      }
      return response;
    };
    await assert.rejects(h.runner.runRemoteSoak(h.options, h.dependencies));
    assert.equal(JSON.parse(readFileSync(join(h.runDir, 'segment-result.json'), 'utf8')).reason, 'SEEDED_OPERATION_FAILED');
    assert.equal(durable.recover().report.terminalFailure.operationId, 'op.000000');
  });
}

test('CLI initialization failure writes a safe disposition and exits nonzero', (t) => {
  const runDir = mkdtempSync(join(tmpdir(), 'remote-dds-cli-failed-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [join(ROOT, 'scripts/remote-worker-dds-soak.mjs'), '--url', 'https://test.workers.dev', '--run-dir', runDir,
    '--deployment-manifest', join(runDir, 'missing-manifest.json')], { env: { ...process.env, DDS_REMOTE_TEST_KEY: 'token-fragment-must-not-leak' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 1);
  const result = JSON.parse(readFileSync(join(runDir, 'segment-result.json'), 'utf8'));
  assert.equal(result.disposition, 'FAILED');
  assert.equal(result.reason, 'INITIALIZATION_FAILED');
  assert.equal(JSON.stringify(result).includes('token-fragment'), false);
});

test('fixture validation uses the injected remote dispatch and native baseline', async (t) => {
  const h = await segmentHarness(t);
  // A file URL prevents any real network call if fixture injection regresses.
  h.options.endpoint = 'file:///blocked';
  h.dependencies.fixtures = [{ id: 'fixture-drift', kind: 'table', hands: {}, expected: Array.from({ length: 5 }, () => [1, 1, 1, 1]) }];
  h.dependencies.writeCheckpoint = (await import('../scripts/worker-dds-checkpoint.mjs')).writeReportCheckpoint;
  await assert.rejects(h.runner.runRemoteSoak(h.options, h.dependencies), /Fixture corpus drift/);
  assert.equal(h.events.some(([kind, id]) => kind === 'dispatch' && id === 'fixture.000000'), true);
  assert.equal(JSON.parse(readFileSync(join(h.runDir, 'segment-result.json'), 'utf8')).reason, 'FIXTURE_FAILED');
  assert.equal(h.events.some(([kind]) => kind === 'failure'), false);
});

test('a durable recovered intent completes before writing an expired deadline disposition', async (t) => {
  const h = await segmentHarness(t);
  h.options.deadlineMs = 10;
  const durable = await useDurableState(h, { pending: true });
  const post = h.dependencies.remotePost;
  h.dependencies.remotePost = async (...args) => {
    const response = await post(...args);
    if (args[1].operationId.startsWith('op.')) h.setNow(10);
    return response;
  };
  const result = await h.runner.runRemoteSoak(h.options, h.dependencies);
  const recovered = durable.recover();
  assert.equal(recovered.report.completedCursor, 1);
  assert.equal(recovered.recovery.kind, 'ready');
  assert.equal(result.completedThisSegment, 0);
  assert.equal(result.reason, 'DEADLINE');
  assert.deepEqual(JSON.parse(readFileSync(join(h.runDir, 'segment-result.json'), 'utf8')), result);
});

test('wall-clock changes affect report timestamps but never the segment deadline', async (t) => {
  const h = await segmentHarness(t);
  h.options.maxNewOperations = 1; h.options.deadlineMs = 10;
  let wallReads = 0;
  h.dependencies.wallNow = () => new Date(wallReads++ === 0 ? '2026-09-30T00:00:00Z' : '2026-10-30T00:00:00Z');
  const result = await h.runner.runRemoteSoak(h.options, h.dependencies);
  assert.equal(result.reason, 'MAX_NEW_OPERATIONS');
  assert.equal(result.completedThisSegment, 1);
  assert.equal(result.startedAt, '2026-09-30T00:00:00.000Z');
  assert.equal(result.finishedAt, '2026-10-30T00:00:00.000Z');
});

for (const failure of ['missing key', 'invalid deadline']) {
  test(`CLI ${failure} writes INITIALIZATION_FAILED only to an explicit run directory`, (t) => {
    const runDir = mkdtempSync(join(tmpdir(), 'remote-dds-cli-parse-'));
    t.after(() => rmSync(runDir, { recursive: true, force: true }));
    const env = { ...process.env }; delete env.DDS_REMOTE_TEST_KEY;
    const args = ['--url', 'https://test.workers.dev', '--run-dir', runDir];
    if (failure === 'invalid deadline') { env.DDS_REMOTE_TEST_KEY = 'token-fragment'; args.push('--deadline-ms', '0'); }
    const child = spawnSync(process.execPath, [join(ROOT, 'scripts/remote-worker-dds-soak.mjs'), ...args], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 1);
    const text = readFileSync(join(runDir, 'segment-result.json'), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(text)), ['version', 'disposition', 'reason', 'completedCursor', 'completedThisSegment', 'startedAt', 'finishedAt']);
    assert.equal(JSON.parse(text).reason, 'INITIALIZATION_FAILED');
    assert.equal(text.includes('token-fragment'), false);
    assert.equal(child.stderr.includes('    at '), false);
  });
}

test('CLI parse rejection without a determinate run directory reports an error without creating files', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-dds-cli-no-dir-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env }; delete env.DDS_REMOTE_TEST_KEY;
  const child = spawnSync(process.execPath, [join(ROOT, 'scripts/remote-worker-dds-soak.mjs'), '--url', 'https://test.workers.dev'], { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /DDS_REMOTE_TEST_KEY/);
  assert.equal(child.stderr.includes('    at '), false);
  assert.deepEqual(readdirSync(dir), []);
});

test('recovery rebuilds candidate diagnostics from journaled operation evidence after the checkpoint write is lost', async () => {
  const state = await import('../scripts/remote-dds-soak-state.mjs');
  const runner = await import('../scripts/remote-worker-dds-soak.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'remote-dds-soak-runner-'));
  try {
    const run = state.createSoakState({ dir, root: ROOT, runId: 'soak-recovery', requestForIndex: request });
    const operationEvidence = {
      id: 'random-0', index: 0, kind: 'solve',
      candidateDifference: { baseline: ['S2'], worker: ['S3'] },
    };
    run.recordIntent({ index: 0, operationId: 'op-000000', ...request(0) });
    run.recordCompletion({ operationId: 'op-000000', response: { ok: true }, activationId: activation, evidence: operationEvidence });
    const recovered = state.recoverSoakState({ dir, root: ROOT, requestForIndex: request });
    const checkpoint = { operations: [], candidateDifferences: [{ id: 'stale', baseline: ['H2'], worker: ['H3'] }] };
    const evidence = runner.mergeRecoveredEvidence({ checkpoint, durableOperations: recovered.evidence, durableFixtures: recovered.fixtureEvidence });
    assert.deepEqual(evidence.operations, [operationEvidence]);
    assert.deepEqual(evidence.candidateDifferences, [{ id: 'random-0', baseline: ['S2'], worker: ['S3'] }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('candidate diagnostics are derived only from solve operations and omit stale or extra records', async () => {
  const { deriveCandidateDifferences } = await import('../scripts/remote-worker-dds-soak.mjs');
  assert.deepEqual(deriveCandidateDifferences([
    { id: 'table-1', kind: 'table', candidateDifference: { baseline: ['S2'], worker: ['S3'] } },
    { id: 'solve-1', kind: 'solve', candidateDifference: { baseline: ['H2'], worker: ['H3'] } },
    { id: 'solve-2', kind: 'solve', candidateDifference: null },
  ]), [{ id: 'solve-1', baseline: ['H2'], worker: ['H3'] }]);
});

test('segment stop reason respects operation, deadline, and completion boundaries', async () => {
  const { segmentStopReason } = await import('../scripts/remote-worker-dds-soak.mjs');
  const base = { completedAtStart: 100, completedNow: 100, maxNewOperations: 6000,
    startedAtMs: 1000, nowMs: 1000, deadlineMs: 17_100_000, totalOperations: 22000 };
  assert.equal(segmentStopReason({ ...base, completedNow: 6100 }), 'MAX_NEW_OPERATIONS');
  assert.equal(segmentStopReason({ ...base, completedNow: 6099 }), null);
  assert.equal(segmentStopReason({ ...base, nowMs: 17_101_000 }), 'DEADLINE');
  assert.equal(segmentStopReason({ ...base, completedAtStart: 22000, completedNow: 22000 }), 'COMPLETE');
  assert.equal(segmentStopReason({ ...base, completedNow: 22000, nowMs: 17_101_000 }), 'COMPLETE');
});

test('native baseline bounds both table and solve subprocesses with the configured timeout', async () => {
  const { createNativeBaseline } = await import('../scripts/remote-worker-dds-soak.mjs');
  const calls = [];
  const native = createNativeBaseline({
    runProcess: async (programPath, input, options) => {
      calls.push({ programPath, input, options });
      return programPath.endsWith('calc') ? '0 1 2 3 4 5 6 7 8 9 10 11 12 13 0 1 2 3 4 0' : '1 1 0 2';
    },
    paths: { calc: 'fake-calc', solve: 'fake-solve' },
    existsSync: () => true,
  });

  const hands = { N: [{ suit: 'S', rank: 2 }], E: [], S: [], W: [] };
  const deal = { trump: 'NT', trickLeader: 'N', trickPlayed: [], hands };
  assert.deepEqual(await native.calcDDTable(hands), [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 0, 1], [2, 3, 4, 0]]);
  assert.deepEqual(await native.solveBoard(deal), { score: 1, cards: [{ suit: 'S', rank: 2 }] });
  assert.deepEqual(calls.map(({ options }) => options), [{ timeoutMs: 180000 }, { timeoutMs: 180000 }]);
});

test('recovery restores journaled preflight evidence when the preflight checkpoint write was interrupted', async () => {
  const state = await import('../scripts/remote-dds-soak-state.mjs');
  const runner = await import('../scripts/remote-worker-dds-soak.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'remote-dds-soak-preflight-'));
  try {
    const run = state.createSoakState({ dir, root: ROOT, runId: 'soak-preflight', requestForIndex: request });
    const preflight = { activationId: activation, endpointBuildId: 'build-A', endpointWorkerVersionId: 'version-A', remote: { ok: true } };
    run.recordAuxiliaryIntent({ operationId: 'preflight.metrics', route: '/__dds/metrics', body: '{}' });
    run.recordAuxiliaryResponse({ operationId: 'preflight.metrics', route: '/__dds/metrics', response: { ok: true }, evidence: preflight, evidenceKind: 'preflight' });
    const recovered = state.recoverSoakState({ dir, root: ROOT, requestForIndex: request });
    const evidence = runner.mergeRecoveredEvidence({ checkpoint: { operations: [], fixtures: [], candidateDifferences: [] },
      durableOperations: recovered.evidence, durableFixtures: recovered.fixtureEvidence, durablePreflight: recovered.preflightEvidence });
    assert.deepEqual(evidence.preflight, preflight);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
