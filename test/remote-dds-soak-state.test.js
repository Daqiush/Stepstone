const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

let state;
const ROOT = resolve(__dirname, '..');

function tempRun() { return mkdtempSync(join(tmpdir(), 'remote-dds-soak-state-')); }
function request(index) { return { route: '/__dds/solve', body: { index, z: 2, a: 1 } }; }
function accounting(overrides = {}) {
  return { workerInbound: 1, doFetchArrivals: 1, queuedDoCommands: 2, sqliteRows: 2, ...overrides };
}

test('creates the pinned deterministic manifest', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const manifest = state.createRunManifest({ root: ROOT });
  assert.equal(manifest.seed, 20260923);
  assert.equal(manifest.randomGenerator, 'xorshift32');
  assert.equal(manifest.shards.length, 11);
  assert.deepEqual(manifest.shards, Array.from({ length: 11 }, (_, shard) => ({ shard, startIndex: shard * 2000, endIndex: shard * 2000 + 1999 })));
  assert.equal(manifest.accountingSchemaVersion, 1);
  assert.match(manifest.hashes.randomGenerator, /^[a-f0-9]{64}$/);
  assert.match(manifest.hashes.fixtureCorpus, /^[a-f0-9]{64}$/);
});

test('persists an fsynced intent and recovers it as a deterministic replay', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const dir = tempRun();
  try {
    const run = state.createSoakState({ dir, root: ROOT, requestForIndex: request });
    const intent = run.recordIntent({ index: 0, operationId: 'op-0', ...request(0) });
    assert.equal(intent.requestHash, state.requestHash('/__dds/solve', { a: 1, index: 0, z: 2 }));
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
    run.recordCompletion({ operationId: 'op-0', response: { ok: true }, activationId: 'a1', observed: accounting() });
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
      run.recordCompletion({ operationId: 'op-0', response: { ok: true }, observed: accounting() });
      if (scenario === 'gap') writeFileSync(join(dir, 'journal.jsonl'), `${readFileSync(join(dir, 'journal.jsonl'))}${JSON.stringify({ type: 'intent', index: 2, operationId: 'op-2', ...request(2), requestHash: state.requestHash('/__dds/solve', request(2).body) })}\n`);
      if (scenario === 'duplicate') writeFileSync(join(dir, 'journal.jsonl'), `${readFileSync(join(dir, 'journal.jsonl'))}${JSON.stringify({ type: 'completion', index: 0, operationId: 'op-0', responseHash: 'a'.repeat(64), observed: accounting() })}\n`);
      if (scenario === 'invalid-json') writeFileSync(join(dir, 'journal.jsonl'), `${readFileSync(join(dir, 'journal.jsonl'))}{broken\n`);
      if (scenario === 'changed-request') assert.throws(() => state.recoverSoakState({ dir, root: ROOT, requestForIndex: (index) => ({ route: '/changed', body: { index } }) }), /deterministic request changed/i);
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
    assert.throws(() => run.completeReplay({ operationId: 'wrong', response: { ok: true }, activationId: 'a1', observed: accounting() }), /operation ID/i);
    run.completeReplay({ operationId: 'op-0', response: { ok: true }, activationId: 'a1', observed: accounting() });
    run.recordIntent({ index: 1, operationId: 'op-1', ...request(1) });
    assert.throws(() => run.completeReplay({ operationId: 'op-1', response: { ok: true }, activationId: 'a2', observed: accounting() }), /activation/i);
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
        run.recordCompletion({ operationId: 'op-0', response: { ok: true }, activationId: 'a1', observed: accounting() });
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
    const boundaryRequest = (index) => ({ route: '/__dds/table', body: { index } });
    state.createSoakState({ dir, root: ROOT, requestForIndex: boundaryRequest });
    const journal = [];
    for (let index = 0; index <= 2000; index++) {
      const { route, body } = boundaryRequest(index);
      journal.push({ type: 'intent', index, operationId: `op-${index}`, route,
        requestHash: state.requestHash(route, body), canonicalRequest: state.canonicalRequest(route, body) });
      journal.push({ type: 'completion', index, operationId: `op-${index}`,
        responseHash: state.sha256Utf8(state.canonicalJson({ ok: true })), activationId: index < 2000 ? 'first' : 'second',
        observed: accounting({ queuedDoCommands: 1 }) });
    }
    writeFileSync(join(dir, 'journal.jsonl'), `${journal.map(JSON.stringify).join('\n')}\n`);
    const recovered = state.recoverSoakState({ dir, root: ROOT, requestForIndex: boundaryRequest });
    assert.equal(recovered.recovery.kind, 'ready');
    assert.deepEqual(recovered.report.activationIds, { 0: 'first', 1: 'second' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('projects and enforces all accounting dimensions including replay arrival costs', async () => {
  state ??= await import('../scripts/remote-dds-soak-state.mjs');
  const baseline = state.projectAccounting();
  assert.equal(baseline.workerInbound, 22000);
  assert.equal(baseline.queuedDoCommands, 43780);
  const projected = state.projectAccounting({ fixtures: 3, coldStarts: 11, metricProbes: 2, pendingReplays: 1, closeSmokeProbes: 2 });
  assert.equal(projected.queuedDoCommands, 43780 + 3 * 2 + 2 + 2);
  assert.equal(projected.workerInbound, 22000 + 3 + 11 + 2 + 1 + 2);
  assert.equal(projected.doFetchArrivals, projected.workerInbound);
  assert.throws(() => state.assertAccountingWithinLimits({ ...baseline, workerInbound: 25001 }), /workerInbound/i);
  assert.throws(() => state.assertAccountingWithinLimits({ ...baseline, queuedDoCommands: 50001 }), /queuedDoCommands/i);
  assert.throws(() => state.assertAccountingWithinLimits({ ...baseline, sqliteRows: 25001 }), /sqliteRows/i);
});
