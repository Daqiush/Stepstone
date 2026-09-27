const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

let state;
let remoteCanonical;
const ROOT = resolve(__dirname, '..');

function tempRun() { return mkdtempSync(join(tmpdir(), 'remote-dds-soak-state-')); }
function request(index) { return { route: '/__dds/solve', body: `{"z":2,"index":${index},"a":1}` }; }
function activation(index) { return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`; }
function accounting(overrides = {}) {
  return { workerInbound: 1, doFetchArrivals: 1, queuedDoCommands: 2, sqliteRows: { reads: 1, writes: 1 }, ...overrides };
}

test('request hash exactly matches the remote UTF-8 body-string canonicalization', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  remoteCanonical ??= await import('../workers/src/remote-test-canonical.mjs');
  const body = '{"z":2,"a":1}';
  const canonical = remoteCanonical.canonicalHarnessRequest('/__dds/solve', body);
  assert.equal(state.canonicalRequest('/__dds/solve', body), canonical);
  assert.equal(state.requestHash('/__dds/solve', body), state.sha256Utf8(canonical));
  assert.notEqual(state.requestHash('/__dds/solve', body), state.requestHash('/__dds/solve', '{"a":1,"z":2}'));
});

test('creates the pinned deterministic manifest', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const manifest = state.createRunManifest({ root: ROOT });
  assert.equal(manifest.seed, 20260923);
  assert.equal(manifest.randomGenerator, 'xorshift32');
  assert.equal(manifest.shards.length, 11);
  assert.deepEqual(manifest.shards, Array.from({ length: 11 }, (_, shard) => ({ shard, startIndex: shard * 2000, endIndex: shard * 2000 + 1999 })));
  assert.equal(manifest.accountingSchemaVersion, 6);
  assert.equal(manifest.journalSchemaVersion, 6);
  assert.match(manifest.hashes.randomGenerator, /^[a-f0-9]{64}$/);
  assert.match(manifest.hashes.fixtureCorpus, /^[a-f0-9]{64}$/);
});

test('persists an fsynced intent and recovers it as a deterministic replay', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const dir = tempRun();
  try {
    const run = state.createSoakState({ dir, root: ROOT, requestForIndex: request });
    const intent = run.recordIntent({ index: 0, operationId: 'op-0', ...request(0) });
    assert.equal(intent.requestHash, state.requestHash('/__dds/solve', request(0).body));
    const resumed = state.recoverSoakState({ dir, root: ROOT, requestForIndex: request });
    assert.equal(resumed.recovery.kind, 'replay-pending');
    assert.equal(resumed.recovery.intent.operationId, 'op-0');
    assert.equal(resumed.report.completedCursor, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('completion is contiguous, persists response hash, and advances the cursor once', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const dir = tempRun();
  try {
    const run = state.createSoakState({ dir, root: ROOT, requestForIndex: request });
    run.recordIntent({ index: 0, operationId: 'op-0', ...request(0) });
    run.recordCompletion({ operationId: 'op-0', response: { ok: true }, activationId: activation(1), observed: accounting() });
    assert.equal(run.report.completedCursor, 1);
    const lines = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines[1].responseHash, state.sha256Utf8(state.canonicalJson({ ok: true })));
    assert.equal(state.recoverSoakState({ dir, root: ROOT, requestForIndex: request }).recovery.kind, 'ready');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fails closed on journal gap, duplicate, invalid JSON, changed deterministic request, or source hash', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  for (const scenario of ['gap', 'duplicate', 'invalid-json', 'changed-request', 'changed-hash']) {
    const dir = tempRun();
    try {
      const run = state.createSoakState({ dir, root: ROOT, requestForIndex: request });
      run.recordIntent({ index: 0, operationId: 'op-0', ...request(0) });
      run.recordCompletion({ operationId: 'op-0', response: { ok: true }, activationId: activation(1), observed: accounting() });
      if (scenario === 'gap') writeFileSync(join(dir, 'journal.jsonl'), `${readFileSync(join(dir, 'journal.jsonl'))}${JSON.stringify({ type: 'intent', index: 2, operationId: 'op-2', ...request(2), requestHash: state.requestHash('/__dds/solve', request(2).body) })}\n`);
      if (scenario === 'duplicate') writeFileSync(join(dir, 'journal.jsonl'), `${readFileSync(join(dir, 'journal.jsonl'))}${JSON.stringify({ type: 'completion', index: 0, operationId: 'op-0', responseHash: 'a'.repeat(64), observed: accounting() })}\n`);
      if (scenario === 'invalid-json') writeFileSync(join(dir, 'journal.jsonl'), `${readFileSync(join(dir, 'journal.jsonl'))}{broken\n`);
      if (scenario === 'changed-request') assert.throws(() => state.recoverSoakState({ dir, root: ROOT, requestForIndex: (index) => ({ route: '/changed', body: JSON.stringify({ index }) }) }), /deterministic request changed/i);
      if (scenario === 'changed-hash') { const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'))); manifest.hashes.fixtureCorpus = '0'.repeat(64); writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest)); }
      if (scenario !== 'changed-request') assert.throws(() => state.recoverSoakState({ dir, root: ROOT, requestForIndex: request }), /journal|hash/i, scenario);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a terminal failure holds cursor and a replay needs matching response and activation', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const dir = tempRun();
  try {
    const run = state.createSoakState({ dir, root: ROOT, requestForIndex: request });
    run.recordIntent({ index: 0, operationId: 'op-0', ...request(0) });
    run.recordFailure({ operationId: 'op-0', error: 'network exhausted' });
    assert.equal(run.report.completedCursor, 0);
    assert.equal(state.recoverSoakState({ dir, root: ROOT, requestForIndex: request }).recovery.kind, 'failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const replayDir = tempRun();
  try {
    const run = state.createSoakState({ dir: replayDir, root: ROOT, requestForIndex: request });
    run.recordIntent({ index: 0, operationId: 'op-0', ...request(0) });
    assert.throws(() => run.completeReplay({ operationId: 'wrong', response: { ok: true }, activationId: activation(1), observed: accounting() }), /operation ID/i);
    assert.throws(() => run.completeReplay({ operationId: 'op-0', response: { ok: true }, observed: accounting() }), /activation/i);
    run.completeReplay({ operationId: 'op-0', response: { ok: true }, activationId: activation(1), observed: accounting() });
    run.recordIntent({ index: 1, operationId: 'op-1', ...request(1) });
    assert.throws(() => run.completeReplay({ operationId: 'op-1', response: { ok: true }, activationId: activation(2), observed: accounting() }), /activation/i);
  } finally { rmSync(replayDir, { recursive: true, force: true }); }
});

test('recovery closes every crash window using the fsynced journal as authority', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  for (const window of ['intent-fsynced', 'remote-committed', 'completion-fsynced', 'report-replaced']) {
    const dir = tempRun();
    try {
      const run = state.createSoakState({ dir, root: ROOT, requestForIndex: request });
      run.recordIntent({ index: 0, operationId: 'op-0', ...request(0) });
      if (window === 'intent-fsynced' || window === 'remote-committed') {
        assert.equal(state.recoverSoakState({ dir, root: ROOT, requestForIndex: request }).recovery.kind, 'replay-pending', window);
      } else {
        run.recordCompletion({ operationId: 'op-0', response: { ok: true }, activationId: activation(1), observed: accounting() });
        if (window === 'completion-fsynced') writeFileSync(join(dir, 'report.json'), JSON.stringify({ completedCursor: 0 }));
        const resumed = state.recoverSoakState({ dir, root: ROOT, requestForIndex: request });
        assert.equal(resumed.recovery.kind, 'ready', window);
        assert.equal(resumed.report.completedCursor, 1, window);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('allows a documented fresh activation at the next shard boundary', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const dir = tempRun();
  try {
    const boundaryRequest = (index) => ({ route: '/__dds/table', body: JSON.stringify({ index }) });
    state.createSoakState({ dir, root: ROOT, requestForIndex: boundaryRequest });
    const journal = [];
    for (let index = 0; index <= 2000; index++) {
      const { route, body } = boundaryRequest(index);
      journal.push({ type: 'intent', runId: 'unbound-run', index, operationId: `op-${index}`, route,
        requestHash: state.requestHash(route, body), canonicalRequest: state.canonicalRequest(route, body) });
      journal.push({ type: 'completion', index, operationId: `op-${index}`,
        responseHash: state.sha256Utf8(state.canonicalJson({ ok: true })), activationId: activation(index < 2000 ? 1 : 2),
        observed: accounting({ queuedDoCommands: 1 }) });
    }
    writeFileSync(join(dir, 'journal.jsonl'), `${journal.map(JSON.stringify).join('\n')}\n`);
    const recovered = state.recoverSoakState({ dir, root: ROOT, requestForIndex: boundaryRequest });
    assert.equal(recovered.recovery.kind, 'ready');
    assert.deepEqual(recovered.report.activationIds, { 0: activation(1), 1: activation(2) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('derives direct-solve accounting from durable physical responses rather than cumulative snapshots', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const dir = tempRun();
  try {
    const run = state.createSoakState({ dir, root: ROOT, requestForIndex: request });
    run.recordIntent({ index: 0, operationId: 'op-0', ...request(0) });
    run.recordCompletion({ operationId: 'op-0', response: { ok: true }, activationId: activation(1), observed: accounting() });
    const secondSnapshot = accounting({ workerInbound: 2, doFetchArrivals: 2, queuedDoCommands: 4, sqliteRows: { reads: 2, writes: 2 } });
    run.recordIntent({ index: 1, operationId: 'op-1', ...request(1) });
    run.recordCompletion({ operationId: 'op-1', response: { ok: true }, activationId: activation(1), observed: secondSnapshot });
    assert.deepEqual(run.report.observed, { workerInbound: 2, doFetchArrivals: 2, queuedDoCommands: 2, sqliteRows: { reads: 2, writes: 2 } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects a duplicate operation id anywhere in a recovered journal', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const dir = tempRun();
  try {
    const run = state.createSoakState({ dir, root: ROOT, requestForIndex: request });
    run.recordIntent({ index: 0, operationId: 'op-0', ...request(0) });
    run.recordCompletion({ operationId: 'op-0', response: { ok: true }, activationId: activation(1), observed: accounting() });
    const duplicate = { type: 'intent', index: 1, operationId: 'op-0', route: request(1).route,
      requestHash: state.requestHash(request(1).route, request(1).body), canonicalRequest: state.canonicalRequest(request(1).route, request(1).body) };
    writeFileSync(join(dir, 'journal.jsonl'), `${readFileSync(join(dir, 'journal.jsonl'))}${JSON.stringify(duplicate)}\n`);
    assert.throws(() => state.recoverSoakState({ dir, root: ROOT, requestForIndex: request }), /duplicate operation/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fails closed instead of resuming a version-one cumulative-accounting journal', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const dir = tempRun();
  try {
    state.createSoakState({ dir, root: ROOT, requestForIndex: request });
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    manifest.accountingSchemaVersion = 1;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    assert.throws(() => state.recoverSoakState({ dir, root: ROOT, requestForIndex: request }), /schema version|new run/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('projects and enforces all accounting dimensions including replay arrival costs', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const baseline = state.projectAccounting();
  assert.equal(baseline.workerInbound, 22000);
  assert.equal(baseline.queuedDoCommands, 43780);
  assert.deepEqual(baseline.sqliteRows, { reads: 22000, writes: 22000 });
  const projected = state.projectAccounting({ fixtureTables: 26, fixtureSolves: 2, coldStarts: 11, metricProbes: 1, pendingReplays: 1, closeSmokeProbes: 2 });
  assert.equal(projected.queuedDoCommands, 43780 + 26 + 2 * 2 + 2);
  assert.equal(projected.workerInbound, 22000 + 26 + 2 + 11 + 1 + 1 + 2);
  assert.equal(projected.doFetchArrivals, projected.workerInbound);
  assert.throws(() => state.assertAccountingWithinLimits({ ...baseline, workerInbound: 25001 }), /workerInbound/i);
  assert.throws(() => state.assertAccountingWithinLimits({ ...baseline, queuedDoCommands: 50001 }), /queuedDoCommands/i);
  assert.doesNotThrow(() => state.assertAccountingWithinLimits(baseline));
  assert.throws(() => state.assertAccountingWithinLimits({ ...baseline, sqliteRows: { ...baseline.sqliteRows, reads: 25001 } }), /sqliteRows\.reads/i);
  assert.throws(() => state.assertAccountingWithinLimits({ ...baseline, sqliteRows: { ...baseline.sqliteRows, writes: 25001 } }), /sqliteRows\.writes/i);
});

test('derives a durable physical-request ledger from the remote replay decision instead of cumulative snapshots', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  assert.deepEqual(state.actualRequestAccounting({ route: '/__dds/metrics', replayed: false }), {
    workerInbound: 1, doFetchArrivals: 1, queuedDoCommands: 0, sqliteRows: { reads: 1, writes: 1 },
  });
  assert.deepEqual(state.actualRequestAccounting({ route: '/__dds/table', replayed: false }), {
    workerInbound: 1, doFetchArrivals: 1, queuedDoCommands: 1, sqliteRows: { reads: 1, writes: 1 },
  });
  assert.deepEqual(state.actualRequestAccounting({ route: '/__dds/ordered-probe', replayed: false }), {
    workerInbound: 1, doFetchArrivals: 1, queuedDoCommands: 2, sqliteRows: { reads: 1, writes: 1 },
  });
  assert.deepEqual(state.actualRequestAccounting({ route: '/__dds/ordered-probe', replayed: true }), {
    workerInbound: 1, doFetchArrivals: 1, queuedDoCommands: 0, sqliteRows: { reads: 1, writes: 0 },
  });
});

test('persists physical auxiliary and replay requests as an exact ledger across recovery', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const dir = tempRun();
  try {
    const run = state.createSoakState({ dir, root: ROOT, requestForIndex: request });
    run.recordAuxiliaryIntent({ operationId: 'preflight.metrics', route: '/__dds/metrics', body: '{}' });
    run.recordAuxiliaryResponse({ operationId: 'preflight.metrics', route: '/__dds/metrics', replayed: false, response: { ok: true } });
    run.recordIntent({ index: 0, operationId: 'op-0', ...request(0) });
    run.completeReplay({ operationId: 'op-0', response: { ok: true, executionAccounting: { workerInbound: 1, doFetchArrivals: 1, queuedDoCommands: 1, sqliteRows: { reads: 1, writes: 1 } } }, activationId: activation(1), replayed: true });
    const resumed = state.recoverSoakState({ dir, root: ROOT, requestForIndex: request });
    assert.deepEqual(resumed.report.observed, {
      workerInbound: 3, doFetchArrivals: 3, queuedDoCommands: 1, sqliteRows: { reads: 3, writes: 2 },
    });
    assert.equal(resumed.physicalOperations.length, 3);
    assert.equal(resumed.hasPhysicalOperation('preflight.metrics'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mocked transport ledger stays exact for fresh and resumed fixture, pending-cache, and new-execution paths', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const dir = tempRun();
  const remote = (replayed) => ({ ok: true, replayed });
  try {
    // Fresh preflight and first fixture are durable; a resume must not send them again.
    let run = state.createSoakState({ dir, root: ROOT, requestForIndex: request });
    run.recordAuxiliaryIntent({ operationId: 'preflight.metrics', route: '/__dds/metrics', body: '{}' });
    run.recordAuxiliaryResponse({ operationId: 'preflight.metrics', route: '/__dds/metrics', replayed: remote(false).replayed, response: { ok: true } });
    run.recordAuxiliaryIntent({ operationId: 'fixture.000000', route: '/__dds/table', body: '{}' });
    run.recordAuxiliaryResponse({ operationId: 'fixture.000000', route: '/__dds/table', replayed: remote(false).replayed, response: { ok: true } });
    run.recordIntent({ index: 0, operationId: 'op-0', ...request(0) });
    // Crash after intent; the next physical request is a cache hit, so it adds no queue/write cost.
    run = state.recoverSoakState({ dir, root: ROOT, requestForIndex: request });
    assert.equal(run.hasPhysicalOperation('preflight.metrics'), true);
    assert.equal(run.hasPhysicalOperation('fixture.000000'), true);
    run.completeReplay({ operationId: 'op-0', response: { ok: true, executionAccounting: { workerInbound: 1, doFetchArrivals: 1, queuedDoCommands: 1, sqliteRows: { reads: 1, writes: 1 } } }, activationId: activation(1), replayed: remote(true).replayed });
    // Mid-fixture/new request remains an execution and pays queue+write exactly once.
    run.recordIntent({ index: 1, operationId: 'op-1', ...request(1) });
    run.recordCompletion({ operationId: 'op-1', response: { ok: true }, activationId: activation(1), replayed: remote(false).replayed });
    const resumed = state.recoverSoakState({ dir, root: ROOT, requestForIndex: request });
    assert.deepEqual(resumed.report.observed, {
      workerInbound: 5, doFetchArrivals: 5, queuedDoCommands: 3, sqliteRows: { reads: 5, writes: 4 },
    });
    assert.deepEqual(state.ledgerAccounting(resumed.physicalOperations), resumed.report.observed);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fails closed when independently observed remote accounting disagrees with the physical ledger', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const dir = tempRun();
  try {
    const run = state.createSoakState({ dir, root: ROOT, requestForIndex: request });
    run.recordAuxiliaryIntent({ operationId: 'preflight.metrics', route: '/__dds/metrics', body: '{}' });
    assert.throws(() => run.recordAuxiliaryResponse({ operationId: 'preflight.metrics', route: '/__dds/metrics', replayed: false,
      response: { ok: true }, remoteAccounting: { workerInbound: 2, doFetchArrivals: 1, queuedDoCommands: 0, sqliteRows: { reads: 1, writes: 1 } } }), /remote accounting snapshot/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recovery reconstructs an executed-but-locally-lost request from persisted remote execution accounting and retains auxiliary evidence', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const dir = tempRun();
  try {
    const run = state.createSoakState({ dir, root: ROOT, requestForIndex: request });
    const auxiliaryEvidence = { id: 'fixture-A', nativeBaseline: { score: 1 }, remote: { ok: true } };
    run.recordAuxiliaryIntent({ operationId: 'fixture.000000', route: '/__dds/table', body: '{}' });
    run.recordAuxiliaryResponse({ operationId: 'fixture.000000', route: '/__dds/table', replayed: false, response: { ok: true }, evidence: auxiliaryEvidence, evidenceKind: 'fixture',
      remoteAccounting: { workerInbound: 1, doFetchArrivals: 1, queuedDoCommands: 1, sqliteRows: { reads: 1, writes: 1 } } });
    run.recordIntent({ index: 0, operationId: 'op-0', ...request(0) });
    const resumed = state.recoverSoakState({ dir, root: ROOT, requestForIndex: request });
    const original = { workerInbound: 1, doFetchArrivals: 1, queuedDoCommands: 1, sqliteRows: { reads: 1, writes: 1 } };
    resumed.completeReplay({ operationId: 'op-0', activationId: activation(1), replayed: true,
      response: { ok: true, executionAccounting: original },
      remoteAccounting: { workerInbound: 3, doFetchArrivals: 3, queuedDoCommands: 2, sqliteRows: { reads: 3, writes: 2 } },
      evidence: { id: 'op-0', remote: { ok: true } } });
    const recovered = state.recoverSoakState({ dir, root: ROOT, requestForIndex: request });
    assert.deepEqual(recovered.report.observed, { workerInbound: 3, doFetchArrivals: 3, queuedDoCommands: 2, sqliteRows: { reads: 3, writes: 2 } });
    assert.deepEqual(recovered.fixtureEvidence, [auxiliaryEvidence]);
    assert.deepEqual(recovered.evidence, [{ id: 'op-0', remote: { ok: true } }]);
    assert.equal(recovered.physicalOperations.filter((record) => record.operationId === 'op-0').length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recovery reconstructs remote-first preflight and fixture replays before atomically retaining fixture evidence', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const dir = tempRun();
  const metricsExecution = { workerInbound: 1, doFetchArrivals: 1, queuedDoCommands: 0, sqliteRows: { reads: 1, writes: 1 } };
  const tableExecution = { workerInbound: 1, doFetchArrivals: 1, queuedDoCommands: 1, sqliteRows: { reads: 1, writes: 1 } };
  const fixtureEvidence = { id: 'fixture-crash', nativeBaseline: { score: 1 }, remote: { ok: true } };
  try {
    // Both remote executions happened before this process received either response.
    let run = state.createSoakState({ dir, root: ROOT, requestForIndex: request });
    run.recordAuxiliaryIntent({ operationId: 'preflight.metrics', route: '/__dds/metrics', body: '{}' });
    run.recordAuxiliaryIntent({ operationId: 'fixture.000000', route: '/__dds/table', body: '{}' });
    run = state.recoverSoakState({ dir, root: ROOT, requestForIndex: request });
    run.recordAuxiliaryResponse({ operationId: 'preflight.metrics', route: '/__dds/metrics', replayed: true,
      response: { ok: true, executionAccounting: metricsExecution },
      remoteAccounting: { workerInbound: 2, doFetchArrivals: 2, queuedDoCommands: 0, sqliteRows: { reads: 2, writes: 1 } } });
    run.recordAuxiliaryResponse({ operationId: 'fixture.000000', route: '/__dds/table', replayed: true,
      response: { ok: true, executionAccounting: tableExecution }, evidence: fixtureEvidence, evidenceKind: 'fixture',
      remoteAccounting: { workerInbound: 4, doFetchArrivals: 4, queuedDoCommands: 1, sqliteRows: { reads: 4, writes: 2 } } });
    const resumed = state.recoverSoakState({ dir, root: ROOT, requestForIndex: request });
    assert.deepEqual(resumed.report.observed, { workerInbound: 4, doFetchArrivals: 4, queuedDoCommands: 1, sqliteRows: { reads: 4, writes: 2 } });
    assert.equal(resumed.physicalOperations.filter((item) => item.operationId === 'preflight.metrics').length, 2);
    assert.equal(resumed.physicalOperations.filter((item) => item.operationId === 'fixture.000000').length, 2);
    assert.deepEqual(resumed.fixtureEvidence, [fixtureEvidence]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('completion journals full evidence atomically and recovery restores it', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const dir = tempRun();
  try {
    const run = state.createSoakState({ dir, root: ROOT, requestForIndex: request });
    run.recordIntent({ index: 0, operationId: 'op-0', ...request(0) });
    const evidence = { input: { x: 1 }, nativeBaseline: { score: 2 }, remote: { ok: true } };
    run.recordCompletion({ operationId: 'op-0', response: { ok: true }, activationId: activation(1), observed: accounting(), evidence });
    const recovered = state.recoverSoakState({ dir, root: ROOT, requestForIndex: request });
    assert.deepEqual(recovered.evidence, [evidence]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
