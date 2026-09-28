'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = resolve(__dirname, '..');
const checker = join(ROOT, 'scripts/check-remote-worker-dds-gates.mjs');
const fixturePath = join(ROOT, 'workers/test/fixtures/dds-parity.json');
const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const activation = (shard) => `00000000-0000-4000-8000-00000000000${shard}`;

async function validRun() {
  const [{ createRunManifest }, { createDeploymentManifest }] = await Promise.all([
    import('../scripts/remote-dds-soak-state.mjs'),
    import('../scripts/prepare-remote-dds-deployment.mjs'),
  ]);
  const runId = 'soak-00000000-0000-4000-8000-000000000000';
  const manifest = createRunManifest({ root: ROOT, runId });
  const deployment = createDeploymentManifest({ root: ROOT, verifiedDeployment: {
    versionId: 'version-verified', apiVerified: true, wranglerVersion: '4.137.0',
    temporaryWorkerName: 'stepstone-dds-soak-00000000-0000-4000-8000-000000000001',
    workersDevUrl: 'https://stepstone-dds-soak-00000000-0000-4000-8000-000000000001.example.workers.dev',
  } });
  const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const physical = [{ type: 'physical', operationId: 'preflight.metrics', route: '/__dds/metrics', replayed: false, shard: '0' }];
  const journal = [{ type: 'auxiliary-intent', runId, operationId: 'preflight.metrics', route: '/__dds/metrics' }, physical[0]];
  for (const [index, fixture] of fixtures.entries()) {
    const operationId = `fixture.${String(index).padStart(6, '0')}`;
    const route = fixture.kind === 'table' ? '/__dds/table' : '/__dds/ordered-probe';
    const entry = { type: 'physical', operationId, route, replayed: false, shard: '0' };
    physical.push(entry); journal.push({ type: 'auxiliary-intent', runId, operationId, route }, entry);
  }
  const operations = [];
  for (let index = 0; index < 22000; index++) {
    const shard = Math.floor(index / 2000), kind = index % 100 === 0 ? 'table' : 'solve';
    const operationId = `op.${String(index).padStart(6, '0')}`;
    const route = kind === 'table' ? '/__dds/table' : '/__dds/ordered-probe';
    const item = { id: `random-${index}`, index, kind, shard, depth: kind === 'solve' ? index % 13 : undefined,
      heapBytes: 18_939_904, wasmElapsedMs: 3.25, activationId: activation(shard),
      ...(kind === 'solve' ? { orderedPingDelayMs: 2.5 } : {}) };
    operations.push(item);
    const intent = { type: 'intent', runId, index, operationId, route };
    const request = { type: 'physical', operationId, route, replayed: false, shard: String(shard) };
    const completion = { type: 'completion', index, operationId, activationId: activation(shard), responseHash: 'a'.repeat(64) };
    physical.push(request); journal.push(intent, request, completion);
  }
  const fixtureTables = fixtures.filter((item) => item.kind === 'table').length;
  const fixtureSolves = fixtures.length - fixtureTables;
  const observed = { workerInbound: physical.length, doFetchArrivals: physical.length,
    queuedDoCommands: 43780 + fixtureTables + fixtureSolves * 2,
    sqliteRows: { reads: physical.length, writes: physical.length } };
  const depths = Array(13).fill(0);
  for (const operation of operations) if (operation.kind === 'solve') depths[operation.depth]++;
  return { manifest, deployment, report: { version: 1, completedCursor: 22000, observed,
    activationIds: Object.fromEntries(Array.from({ length: 11 }, (_, shard) => [shard, activation(shard)])), terminalFailure: null },
  evidence: { version: 1, runId, buildId: deployment.buildId, workerVersionId: deployment.workerVersionId,
    deploymentAssets: deployment.assets, fixtureHash: hashFile(fixturePath),
    preflight: { endpointBuildId: deployment.buildId, endpointWorkerVersionId: deployment.workerVersionId },
    coverage: { shards: Array(11).fill(2000), depths },
    fixtures: fixtures.map((fixture) => ({ id: fixture.id, kind: fixture.kind })), operations, candidateDifferences: [] },
    journal, simulator: { budget: { rooms: 50, writesPerDay: 70000, readsPerDay: 250000 } } };
}

function check(run) {
  const dir = mkdtempSync(join(tmpdir(), 'remote-dds-gates-'));
  try {
    const runDir = join(dir, 'run');
    require('node:fs').mkdirSync(runDir);
    writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(run.manifest));
    writeFileSync(join(runDir, 'report.json'), JSON.stringify(run.report));
    writeFileSync(join(runDir, 'evidence.json'), JSON.stringify(run.evidence));
    writeFileSync(join(runDir, 'journal.jsonl'), `${run.journal.map(JSON.stringify).join('\n')}\n`);
    const deployment = join(dir, 'deployment.json'); const simulator = join(dir, 'simulator.json');
    writeFileSync(deployment, JSON.stringify(run.deployment)); writeFileSync(simulator, JSON.stringify(run.simulator));
    return spawnSync(process.execPath, [checker, '--run-dir', runDir, '--deployment-manifest', deployment, '--simulator-report', simulator], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a complete, version-bound remote soak report passes every gate', async () => {
  const result = check(await validRun());
  assert.equal(result.status, 0, result.stderr + result.stdout);
  for (const name of ['corpus', 'journal', 'deployment', 'wasm-bundle', 'heap', 'p99-wasm-elapsed', 'max-wasm-elapsed', 'queue-delay', 'worker-inbound', 'queued-do-commands', 'sqlite', 'room-simulator']) assert.match(result.stdout, new RegExp(`PASS ${name}`));
});

for (const [name, mutate] of [
  ['source-hashes', (r) => { r.manifest.hashes.randomGenerator = '0'.repeat(64); }],
  ['corpus', (r) => { r.evidence.operations.pop(); r.report.completedCursor--; }],
  ['fixture-first', (r) => { const first = r.journal.findIndex((x) => x.type === 'physical' && x.operationId.startsWith('fixture.')); const random = r.journal.findIndex((x) => x.type === 'physical' && x.operationId === 'op.000000'); [r.journal[first], r.journal[random]] = [r.journal[random], r.journal[first]]; }],
  ['journal', (r) => { r.journal.push({ type: 'failed', operationId: 'op.021999' }); }],
  ['parity', (r) => { r.evidence.operations[0].parityMismatch = true; }],
  ['candidate-diagnostics', (r) => { r.evidence.candidateDifferences.push({ id: 'random-1', why: 'unreconciled' }); }],
  ['depths', (r) => { r.evidence.coverage.depths[0] = 0; }],
  ['activation', (r) => { r.journal.find((x) => x.type === 'completion' && x.index === 1).activationId = activation(2); }],
  ['deployment', (r) => { r.deployment.verifiedDeployment.apiVerified = false; }],
  ['wasm-bundle', (r) => { r.deployment.assets.wasm.bytes = 3 * 1024 * 1024; }],
  ['heap', (r) => { r.evidence.operations[0].heapBytes = 100663296; }],
  ['p99-wasm-elapsed', (r) => { for (let i = 0; i < 221; i++) r.evidence.operations[i].wasmElapsedMs = 1000; }],
  ['max-wasm-elapsed', (r) => { r.evidence.operations[0].wasmElapsedMs = 10000; }],
  ['queue-delay', (r) => { r.evidence.operations[1].orderedPingDelayMs = 10000; }],
  ['worker-inbound', (r) => { r.report.observed.workerInbound = 25001; }],
  ['queued-do-commands', (r) => { r.report.observed.queuedDoCommands = 50001; }],
  ['sqlite', (r) => { r.report.observed.sqliteRows.reads = 25001; }],
  ['room-simulator', (r) => { r.simulator.budget.writesPerDay = 70001; }],
]) test(`${name} fails closed`, async () => {
  const run = await validRun(); mutate(run);
  const failed = check(run);
  assert.notEqual(failed.status, 0, failed.stdout);
  assert.match(failed.stdout, new RegExp(`FAIL ${name}`));
});
