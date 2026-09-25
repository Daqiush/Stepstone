'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

const checker = join(__dirname, '../scripts/check-worker-dds-gates.mjs');
const simulator = join(__dirname, '../scripts/simulate-worker-room-budget.mjs');
const MB = 1024 * 1024;
const valid = () => ({
  benchmark: {
    seed: 20260923, iterations: 100000, completedIterations: 100000,
    fixtureCount: 1, completedFixtureCount: 1, parityMismatches: [],
    status: 'complete', operationCounts: { table: 1001, solve: 99000 },
    generation: { randomTableEvery: 100 }, randomTableCount: 1000,
    solveDepthCounts: Array.from({ length: 13 }, (_, i) => i < 5 ? 7616 : 7615),
    bundleBytes: 2 * MB, solveCpuMs: Array(99000).fill(100),
    queueDelayMs: Array(99000).fill(20), maxMemoryBytes: 48 * MB,
  },
  budget: { rooms: 50, writesPerDay: 1000, readsPerDay: 1000 },
});

function check(report) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-dds-gates-'));
  try {
    const file = join(dir, 'report.json');
    writeFileSync(file, JSON.stringify(report));
    return spawnSync(process.execPath, [checker, '--report', file], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a complete report below all limits passes and prints every named gate', () => {
  const result = check(valid());
  assert.equal(result.status, 0, result.stderr + result.stdout);
  for (const name of ['parity', 'wasm-bundle', 'memory', 'p99-solve-cpu',
    'max-solve-cpu', 'max-queued-command-delay', 'writes-per-day', 'reads-per-day']) {
    assert.match(result.stdout, new RegExp(name));
  }
});

const boundaries = [
  ['parity', (r) => r.benchmark.parityMismatches.push({ id: 'one' })],
  ['wasm-bundle', (r) => { r.benchmark.bundleBytes = 3 * MB; }],
  ['memory', (r) => { r.benchmark.maxMemoryBytes = 96 * MB; }],
  ['p99-solve-cpu', (r) => { r.benchmark.solveCpuMs.fill(1000, 98009); }],
  ['max-solve-cpu', (r) => { r.benchmark.solveCpuMs[98999] = 10000; }],
  ['max-queued-command-delay', (r) => { r.benchmark.queueDelayMs[98999] = 10000; }],
  ['writes-per-day', (r) => { r.budget.writesPerDay = 70001; }],
  ['reads-per-day', (r) => { r.budget.readsPerDay = 250001; }],
];
for (const [name, change] of boundaries) test(`${name} fails at its boundary`, () => {
  const report = valid(); change(report);
  const result = check(report);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, new RegExp(`FAIL ${name}`));
});

test('p99 uses the sorted nearest-rank sample rather than the input order', () => {
  const report = valid(); report.benchmark.solveCpuMs = [...Array(991).fill(1000), ...Array(98009).fill(1)];
  const result = check(report);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /FAIL p99-solve-cpu/);
});

for (const [field, gate, remove] of [
  ['parity mismatch array', 'parity', (r) => { delete r.benchmark.parityMismatches; }],
  ['expected iteration count', 'benchmark-completeness', (r) => { delete r.benchmark.iterations; }],
  ['completed iteration count', 'benchmark-completeness', (r) => { delete r.benchmark.completedIterations; }],
  ['expected fixture count', 'benchmark-completeness', (r) => { delete r.benchmark.fixtureCount; }],
  ['completed fixture count', 'benchmark-completeness', (r) => { delete r.benchmark.completedFixtureCount; }],
  ['benchmark status', 'benchmark-completeness', (r) => { delete r.benchmark.status; }],
  ['operation counts', 'benchmark-completeness', (r) => { delete r.benchmark.operationCounts; }],
  ['depth counts', 'benchmark-completeness', (r) => { delete r.benchmark.solveDepthCounts; }],
  ['random table count', 'benchmark-completeness', (r) => { delete r.benchmark.randomTableCount; }],
  ['table sampling frequency', 'benchmark-completeness', (r) => { delete r.benchmark.generation; }],
  ['bundle bytes', 'wasm-bundle', (r) => { delete r.benchmark.bundleBytes; }],
  ['memory bytes', 'memory', (r) => { delete r.benchmark.maxMemoryBytes; }],
  ['solve CPU samples', 'p99-solve-cpu', (r) => { delete r.benchmark.solveCpuMs; }],
  ['queue delay samples', 'max-queued-command-delay', (r) => { delete r.benchmark.queueDelayMs; }],
  ['SQL room count', 'writes-per-day', (r) => { delete r.budget.rooms; }],
  ['SQL reads', 'reads-per-day', (r) => { delete r.budget.readsPerDay; }],
  ['SQL writes', 'writes-per-day', (r) => { delete r.budget.writesPerDay; }],
]) test(`missing ${field} fails ${gate}`, () => {
  const report = valid(); remove(report);
  const result = check(report);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, new RegExp(`FAIL ${gate}`));
});

test('claimed completion with too few solve samples fails the completeness gate', () => {
  const report = valid(); report.benchmark.solveCpuMs.pop();
  const result = check(report);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /FAIL benchmark-completeness/);
});

test('claimed completion with too few queue samples fails the completeness gate', () => {
  const report = valid(); report.benchmark.queueDelayMs.pop();
  const result = check(report);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /FAIL benchmark-completeness/);
});

test('recorded operations must match completion and solve samples', () => {
  const report = valid(); report.benchmark.operations = [{ id: 'one', kind: 'solve', solveCpuMs: 100, queueDelayMs: 20 }];
  const result = check(report);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /FAIL benchmark-completeness/);
});

test('a complete claim without every solve depth fails completeness', () => {
  const report = valid(); report.benchmark.solveDepthCounts[0] = 0;
  report.benchmark.solveDepthCounts[1] += 7616;
  const result = check(report);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /FAIL benchmark-completeness/);
});

test('recorded solve depths must agree with claimed depth coverage', () => {
  const report = valid();
  const solveRecord = (i) => ({ id: `random-${i}`, kind: 'solve', depth: 0,
    baseline: {}, worker: {}, baselineMs: 1, workerMs: 1, initMs: 1,
    solveCpuMs: 100, queueDelayMs: 20 });
  report.benchmark.operations = [
    { id: 'fixture-table', kind: 'table', depth: null, baseline: {}, worker: {},
      baselineMs: 1, workerMs: 1, initMs: 1, solveCpuMs: 1, queueDelayMs: null },
    ...Array.from({ length: 100000 }, (_, i) => i % 100 === 0
      ? { id: `random-${i}`, kind: 'table', depth: null, baseline: {}, worker: {},
        baselineMs: 1, workerMs: 1, initMs: 1, solveCpuMs: 1, queueDelayMs: null }
      : solveRecord(i)),
  ];
  const result = check(report);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /FAIL benchmark-completeness/);
});

test('too few random full tables fails completeness', () => {
  const report = valid();
  report.benchmark.randomTableCount = 999;
  report.benchmark.solveDepthCounts[0] += 1;
  report.benchmark.operationCounts = { table: 1000, solve: 99001 };
  report.benchmark.solveCpuMs.push(100);
  report.benchmark.queueDelayMs.push(20);
  const result = check(report);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /FAIL benchmark-completeness/);
});

test('budget simulation counts all 50 room lifecycles and appends row totals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-dds-budget-'));
  try {
    const file = join(dir, 'report.json');
    writeFileSync(file, JSON.stringify({ benchmark: valid().benchmark }));
    const result = spawnSync(process.execPath, [simulator, '--report', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const { budget } = require(file);
    assert.equal(budget.rooms, 50);
    assert.equal(budget.readsPerDay, 50800);
    assert.equal(budget.writesPerDay, 50800);
    assert.equal(budget.actions['state-row update'].countPerRoom, 1000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('budget simulation fails on a missing report', () => {
  const result = spawnSync(process.execPath, [simulator, '--report', join(tmpdir(), `missing-${process.pid}.json`)], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});
