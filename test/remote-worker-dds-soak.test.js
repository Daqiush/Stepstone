'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');

const ROOT = resolve(__dirname, '..');
const activation = '00000000-0000-4000-8000-000000000001';
const request = (index) => ({ route: '/__dds/solve', body: JSON.stringify({ index }) });

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
