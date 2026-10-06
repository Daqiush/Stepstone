'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = resolve(__dirname, '..');
const checker = join(ROOT, 'scripts/check-remote-worker-dds-gates.mjs');
const fixturePath = join(ROOT, 'workers/test/fixtures/dds-parity.json');
const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const activation = (shard) => `00000000-0000-4000-8000-${String(shard).padStart(12, '0')}`;

function annotateRemoteAccounting(physical) {
  const totals = new Map();
  for (const entry of physical) {
    entry.accountingActivationId ??= entry.response.activationId;
    const key = `${entry.shard}:${entry.accountingActivationId}`;
    const total = totals.get(key) ?? { workerInbound: 0, doFetchArrivals: 0, queuedDoCommands: 0, sqliteRows: { reads: 0, writes: 0 } };
    total.workerInbound += 1;
    total.doFetchArrivals += 1;
    total.queuedDoCommands += entry.replayed ? 0 : entry.route === '/__dds/ordered-probe' ? 2 : entry.route === '/__dds/table' || entry.route === '/__dds/solve' ? 1 : 0;
    total.sqliteRows.reads += 1;
    total.sqliteRows.writes += entry.replayed ? 0 : 1;
    entry.remoteAccounting = structuredClone(total);
    totals.set(key, total);
  }
}

async function validRun() {
  const [{ createRunManifest, canonicalJson, canonicalRequest, requestHash, sha256Utf8 }, { createDeploymentManifest }, { createRandomCaseGenerator }] = await Promise.all([
    import('../scripts/remote-dds-soak-state.mjs'),
    import('../scripts/prepare-remote-dds-deployment.mjs'),
    import('../scripts/worker-dds-random-cases.mjs'),
  ]);
  const runId = 'soak-00000000-0000-4000-8000-000000000000';
  const manifest = createRunManifest({ root: ROOT, runId });
  const { deriveCiIdentity, createPreDeploymentIdentity } = await import('../scripts/remote-dds-ci-identity.mjs');
  const trusted = deriveCiIdentity({ repository: 'bridge/stepstone', workflow: 'Remote DDS Soak', runId: '12345', runAttempt: '2', commitSha: 'a'.repeat(40), secret: 'fake-token' });
  const identity = createPreDeploymentIdentity({ identity: trusted, noCollisionVerifiedAt: '2026-10-01T00:00:00.000Z' });
  const deployment = createDeploymentManifest({ root: ROOT, verifiedDeployment: {
    identity, ownershipTag: identity.ownershipTag, localConfigurationSha256: 'a'.repeat(64), scriptETag: 'script-etag', versionConfigurationSha256: 'b'.repeat(64),
    workerId: 'b'.repeat(32), versionId: 'version-verified', apiVerified: true, wranglerVersion: '4.137.0',
    temporaryWorkerName: identity.workerName,
    workersDevUrl: `https://${identity.workerName}.example.workers.dev`,
  } });
  const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const preflightRemote = { ok: true, activationId: activation(0), buildId: deployment.buildId, workerVersionId: deployment.workerVersionId };
  const physical = [{ type: 'physical', operationId: 'preflight.metrics', route: '/__dds/metrics', replayed: false, shard: '0', response: preflightRemote, responseHash: sha256Utf8(canonicalJson(preflightRemote)) }];
  const journal = [{ type: 'auxiliary-intent', runId, operationId: 'preflight.metrics', route: '/__dds/metrics' }, physical[0]];
  for (const [index, fixture] of fixtures.entries()) {
    const operationId = `fixture.${String(index).padStart(6, '0')}`;
    const route = fixture.kind === 'table' ? '/__dds/table' : '/__dds/ordered-probe';
    const native = fixture.expected?.table ?? fixture.expected;
    const metrics = { heapBytes: 18_939_904, solveMs: 3.25 };
    const remote = fixture.kind === 'table' ? { ok: true, result: native, activationId: activation(0), metrics }
      : { ok: true, solveResponse: { ok: true, result: native, metrics }, pingResponse: { ok: true }, activationId: activation(0) };
    const entry = { type: 'physical', operationId, route, replayed: false, shard: '0', response: remote, responseHash: sha256Utf8(canonicalJson(remote)) };
    physical.push(entry); journal.push({ type: 'auxiliary-intent', runId, operationId, route }, entry);
  }
  const operations = [];
  const generate = createRandomCaseGenerator(20260923);
  for (let index = 0; index < 22000; index++) {
    const item = generate(index);
    const shard = Math.floor(index / 2000), kind = item.kind;
    const operationId = `op.${String(index).padStart(6, '0')}`;
    const route = kind === 'table' ? '/__dds/table' : '/__dds/ordered-probe';
    const body = JSON.stringify(kind === 'table' ? { hands: item.hands } : { deal: item.deal });
    const deal = item.deal;
    const currentSeat = kind === 'solve' ? ['N', 'E', 'S', 'W'][(['N', 'E', 'S', 'W'].indexOf(deal.trickLeader) + deal.trickPlayed.length) % 4] : null;
    const currentHand = kind === 'solve' ? deal.hands[currentSeat] : null, ledSuit = kind === 'solve' ? deal.trickPlayed[0]?.suit : null;
    const native = kind === 'table' ? Array.from({ length: 5 }, () => Array(4).fill(0)) : { score: 0, cards: [currentHand.find((card) => card.suit === ledSuit) ?? currentHand[0]] };
    const metrics = { heapBytes: 18_939_904, solveMs: 3.25 };
    const remote = kind === 'table' ? { ok: true, result: native, activationId: activation(shard), metrics }
      : { ok: true, solveResponse: { ok: true, result: native, metrics }, pingResponse: { ok: true }, activationId: activation(shard) };
    const evidenceItem = { id: item.id, index, kind, shard, depth: kind === 'solve' ? item.depth : undefined, input: JSON.parse(body), nativeBaseline: native, remote,
      heapBytes: 18_939_904, wasmElapsedMs: 3.25, activationId: activation(shard),
      ...(kind === 'solve' ? { orderedPingDelayMs: 2.5 } : {}) };
    operations.push(evidenceItem);
    const intent = { type: 'intent', runId, index, operationId, route, canonicalRequest: canonicalRequest(route, body), requestHash: requestHash(route, body) };
    const request = { type: 'physical', operationId, route, replayed: false, shard: String(shard), response: remote, responseHash: sha256Utf8(canonicalJson(remote)) };
    const completion = { type: 'completion', index, operationId, activationId: activation(shard), responseHash: request.responseHash };
    physical.push(request); journal.push(intent, request, completion);
  }
  annotateRemoteAccounting(physical);
  const fixtureTables = fixtures.filter((item) => item.kind === 'table').length;
  const fixtureSolves = fixtures.length - fixtureTables;
  const observed = { workerInbound: physical.length, doFetchArrivals: physical.length,
    queuedDoCommands: 43780 + fixtureTables + fixtureSolves * 2,
    sqliteRows: { reads: physical.length, writes: physical.length } };
  const depths = Array(13).fill(0);
  for (const operation of operations) if (operation.kind === 'solve') depths[operation.depth]++;
  const physicalById = new Map(physical.map((entry) => [entry.operationId, entry]));
  const evidence = { version: 1, runId, buildId: deployment.buildId, workerVersionId: deployment.workerVersionId,
    deploymentAssets: deployment.assets, fixtureHash: hashFile(fixturePath),
    preflight: { remote: preflightRemote, activationId: activation(0), endpointBuildId: deployment.buildId, endpointWorkerVersionId: deployment.workerVersionId },
    coverage: { shards: Array(11).fill(2000), depths },
    fixtures: fixtures.map((fixture, index) => {
      const physicalFixture = physicalById.get(`fixture.${String(index).padStart(6, '0')}`);
      return { id: fixture.id, kind: fixture.kind, input: fixture.kind === 'table' ? { hands: fixture.hands } : { deal: fixture.deal ?? { trump: fixture.trump, trickLeader: fixture.trickLeader, trickPlayed: fixture.trickPlayed, hands: fixture.hands } }, nativeBaseline: fixture.expected?.table ?? fixture.expected, remote: physicalFixture.response, remoteMetrics: physicalFixture.response.metrics ?? physicalFixture.response.solveResponse.metrics };
    }), operations, candidateDifferences: [] };
  physicalById.get('preflight.metrics').evidenceHash = sha256Utf8(canonicalJson(evidence.preflight));
  for (const [index, fixture] of evidence.fixtures.entries()) physicalById.get(`fixture.${String(index).padStart(6, '0')}`).evidenceHash = sha256Utf8(canonicalJson(fixture));
  for (let index = 0; index < operations.length; index++) physicalById.get(`op.${String(index).padStart(6, '0')}`).evidenceHash = sha256Utf8(canonicalJson(operations[index]));
  return { manifest, deployment, report: { version: 1, completedCursor: 22000, observed,
    activationIds: Object.fromEntries(Array.from({ length: 11 }, (_, shard) => [shard, activation(shard)])),
    activationSegments: Object.fromEntries(Array.from({ length: 11 }, (_, shard) => [shard, [{ activationId: activation(shard), startIndex: shard * 2000, endIndex: shard * 2000 + 1999 }]])), terminalFailure: null },
  evidence,
    journal, simulator: { budget: { rooms: 50, writesPerDay: 70000, readsPerDay: 250000 } } };
}

function check(run, { output = false, outputDirectory = false } = {}) {
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
    const out = join(dir, 'gate-result.json');
    if (outputDirectory) mkdirSync(out);
    const result = spawnSync(process.execPath, [checker, '--run-dir', runDir, '--deployment-manifest', deployment, '--simulator-report', simulator,
      ...(output || outputDirectory ? ['--out', out] : [])], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return { ...result, gateResult: output && result.status !== null ? JSON.parse(readFileSync(out, 'utf8')) : null };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a complete, version-bound remote soak report passes every gate', async () => {
  const result = check(await validRun());
  assert.equal(result.status, 0, result.stderr + result.stdout);
  for (const name of ['corpus', 'journal', 'deployment', 'wasm-bundle', 'heap', 'p99-wasm-elapsed', 'max-wasm-elapsed', 'queue-delay', 'worker-inbound', 'queued-do-commands', 'sqlite', 'room-simulator']) assert.match(result.stdout, new RegExp(`PASS ${name}`));
});

test('gate checker atomically writes a complete versioned passing result', async () => {
  const result = check(await validRun(), { output: true });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(Object.keys(result.gateResult), ['version', 'runId', 'runAttempt', 'gates']);
  assert.equal(result.gateResult.version, 1);
  assert.equal(result.gateResult.runId, '12345');
  assert.equal(result.gateResult.runAttempt, '2');
  assert.ok(result.gateResult.gates.length > 0);
  assert.ok(result.gateResult.gates.every((gate) => Object.keys(gate).join(',') === 'name,passed' && gate.passed === true));
});

test('gate checker writes failed gates before preserving its nonzero exit', async () => {
  const run = await validRun();
  run.simulator.budget.writesPerDay = 70001;
  const result = check(run, { output: true });
  assert.notEqual(result.status, 0, result.stdout);
  assert.deepEqual(result.gateResult.gates.find((gate) => gate.name === 'room-simulator'), { name: 'room-simulator', passed: false });
  assert.equal(result.gateResult.runId, '12345');
  assert.equal(result.gateResult.runAttempt, '2');
});

test('gate checker fails if its requested result cannot be atomically written', async () => {
  const result = check(await validRun(), { outputDirectory: true });
  assert.notEqual(result.status, 0, result.stdout);
});

test('activation gate accepts a documented Cloudflare restart inside a shard', async () => {
  const run = await validRun();
  const replacement = activation(99);
  for (let index = 1126; index < 2000; index++) {
    const operation = run.evidence.operations[index];
    operation.activationId = replacement; operation.remote.activationId = replacement;
    const operationId = `op.${String(index).padStart(6, '0')}`;
    const physical = run.journal.find((entry) => entry.type === 'physical' && entry.operationId === operationId);
    physical.response.activationId = replacement;
    physical.responseHash = createHash('sha256').update(JSON.stringify(physical.response)).digest('hex');
    physical.evidenceHash = createHash('sha256').update(JSON.stringify(operation)).digest('hex');
    const completion = run.journal.find((entry) => entry.type === 'completion' && entry.operationId === operationId);
    completion.activationId = replacement; completion.responseHash = physical.responseHash;
  }
  run.report.activationIds[0] = replacement;
  run.report.activationSegments[0] = [
    { activationId: activation(0), startIndex: 0, endIndex: 1125 },
    { activationId: replacement, startIndex: 1126, endIndex: 1999 },
  ];
  for (const physical of run.journal.filter((entry) => entry.type === 'physical' && /^op\.\d{6}$/.test(entry.operationId))) {
    physical.accountingActivationId = physical.response.activationId;
  }
  annotateRemoteAccounting(run.journal.filter((entry) => entry.type === 'physical'));
  const result = check(run);
  assert.match(result.stdout, /PASS activation/);
  assert.doesNotMatch(result.stdout, /FAIL activation/);
});

test('fixture validation permits one immediate, fully accounted replay', async () => {
  const run = await validRun();
  const at = run.journal.findIndex((entry) => entry.type === 'physical' && entry.operationId === 'fixture.000000');
  run.journal.splice(at + 1, 0, { ...run.journal[at], replayed: true });
  annotateRemoteAccounting(run.journal.filter((entry) => entry.type === 'physical'));
  run.report.observed.workerInbound++; run.report.observed.doFetchArrivals++; run.report.observed.sqliteRows.reads++;
  const result = check(run);
  assert.match(result.stdout, /PASS fixture-first/);
  assert.match(result.stdout, /PASS worker-inbound/);
});

for (const [name, mutate] of [
  ['source-hashes', (r) => { r.manifest.hashes.randomGenerator = '0'.repeat(64); }],
  ['source-hashes', (r) => { r.manifest.randomGenerator = 'not-xorshift32'; }],
  ['source-hashes', (r) => { r.manifest.hashes.simulator = '0'.repeat(64); }],
  ['source-hashes', (r) => { r.manifest.shards[3].startIndex++; }],
  ['corpus', (r) => { r.evidence.operations.pop(); r.report.completedCursor--; }],
  ['corpus', (r) => { r.journal.find((x) => x.type === 'intent' && x.index === 1).requestHash = '0'.repeat(64); }],
  ['corpus', (r) => { r.journal.find((x) => x.type === 'physical' && x.operationId === 'op.000001').responseHash = '0'.repeat(64); }],
  ['corpus', (r) => { r.evidence.operations[0].remote = { ...r.evidence.operations[0].remote, detached: true }; }],
  ['fixture-first', (r) => { const first = r.journal.findIndex((x) => x.type === 'physical' && x.operationId.startsWith('fixture.')); const random = r.journal.findIndex((x) => x.type === 'physical' && x.operationId === 'op.000000'); [r.journal[first], r.journal[random]] = [r.journal[random], r.journal[first]]; }],
  ['fixture-first', (r) => { delete r.evidence.fixtures[0].nativeBaseline; }],
  ['fixture-first', (r) => { r.evidence.fixtures[0].input = { detached: true }; }],
  ['fixture-first', (r) => { r.evidence.fixtures[0].remote.result = [[0]]; }],
  ['journal', (r) => { r.journal.push({ type: 'failed', operationId: 'op.021999' }); }],
  ['journal', (r) => { r.journal.find((x) => x.type === 'physical' && x.operationId === 'op.000001').remoteAccounting.workerInbound++; }],
  ['journal', (r) => { r.journal.find((x) => x.type === 'physical' && x.operationId === 'op.000001').accountingActivationId = activation(99); }],
  ['parity', (r) => { r.evidence.operations[0].parityMismatch = true; }],
  ['candidate-diagnostics', (r) => { r.evidence.candidateDifferences.push({ id: 'random-1', why: 'unreconciled' }); }],
  ['candidate-diagnostics', (r) => {
    const solve = r.evidence.operations.find((operation) => operation.kind === 'solve');
    solve.candidateDifference = { baseline: ['S2'], worker: ['S3'] };
  }],
  ['candidate-diagnostics', (r) => {
    const solve = r.evidence.operations.find((operation) => operation.kind === 'solve');
    solve.candidateDifference = { baseline: ['S2'], worker: ['S3'] };
    r.evidence.candidateDifferences.push({ id: solve.id, ...solve.candidateDifference });
    r.evidence.candidateDifferences.push({ id: solve.id, ...solve.candidateDifference });
  }],
  ['depths', (r) => { r.evidence.coverage.depths[0] = 0; }],
  ['activation', (r) => { r.journal.find((x) => x.type === 'completion' && x.index === 1).activationId = activation(2); }],
  ['activation', (r) => { r.evidence.operations[0].activationId = activation(2); }],
  ['activation', (r) => { r.evidence.preflight.activationId = activation(1); }],
  ['deployment', (r) => { r.deployment.verifiedDeployment.apiVerified = false; }],
  ['deployment', (r) => { delete r.deployment.workerId; }],
  ['deployment', (r) => { r.deployment.workerId = 'c'.repeat(32); }],
  ['deployment', (r) => { delete r.deployment.verifiedDeployment.workerId; }],
  ['deployment', (r) => { delete r.deployment.ownershipTag; }],
  ['deployment', (r) => { r.deployment.verifiedDeployment.ownershipTag = 'c'.repeat(43); }],
  ['deployment', (r) => { r.deployment.endpoint = 'https://foreign.example.workers.dev'; }],
  ['deployment', (r) => { r.deployment.DDS_REMOTE_TEST_KEY = 'secret'; }],
  ['wasm-bundle', (r) => { r.deployment.assets.wasm.bytes = 3 * 1024 * 1024; }],
  ['heap', (r) => { r.evidence.operations[0].heapBytes = 100663296; }],
  ['p99-wasm-elapsed', (r) => { for (let i = 0; i < 221; i++) r.evidence.operations[i].wasmElapsedMs = 1000; }],
  ['p99-wasm-elapsed', (r) => { r.evidence.operations[0].wasmElapsedMs = -1; }],
  ['max-wasm-elapsed', (r) => { r.evidence.operations[0].wasmElapsedMs = 10000; }],
  ['queue-delay', (r) => { r.evidence.operations[1].orderedPingDelayMs = 10000; }],
  ['queue-delay', (r) => { r.evidence.operations.find((operation) => operation.kind === 'solve').orderedPingDelayMs = -1; }],
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
