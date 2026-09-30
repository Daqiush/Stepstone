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
