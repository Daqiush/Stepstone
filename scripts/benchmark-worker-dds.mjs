import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { normalizeDdsResult } from './worker-dds-benchmark-validation.mjs';
import { createRandomCaseGenerator } from './worker-dds-random-cases.mjs';
import { probeTimedSolve } from './worker-dds-queue-probe.mjs';
import { writeReportCheckpoint } from './worker-dds-checkpoint.mjs';

const require = createRequire(import.meta.url);
const { calcDDTable, solveBoard } = require('../dds-wrapper.js');
const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_OUT = 'workers/test/results/dds-feasibility.json';

function option(name, fallback) {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1];
}
const seed = Number(option('--seed', '20260923'));
const iterations = Number(option('--iterations', '100000'));
const url = option('--url', 'http://127.0.0.1:8787').replace(/\/$/, '');
const out = resolve(ROOT, option('--out', DEFAULT_OUT));
const randomCase = createRandomCaseGenerator(seed);
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error('--iterations must be a positive integer');
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('--url must be a local 127.0.0.1 HTTP Worker address');
async function post(route, body) {
  const response = await fetch(`${url}/__dds/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(`Malformed HTTP JSON from ${route}: status ${response.status}`); }
  if (response.status !== 200 || payload?.ok !== true) {
    throw new Error(`Malformed HTTP response from ${route}: status ${response.status}, body ${JSON.stringify(payload)}`);
  }
  return payload;
}
const fixtures = JSON.parse(readFileSync(resolve(ROOT, 'workers/test/fixtures/dds-parity.json'), 'utf8'));
const report = {
  generatedAt: new Date().toISOString(),
  benchmark: {
    seed, iterations, completedIterations: 0, fixtureCount: fixtures.length, completedFixtureCount: 0,
    bundleBytes: statSync(resolve(ROOT, 'workers/vendor/bridge-dds/dds-worker.wasm')).size,
    parityMismatches: [], solveCpuMs: [], queueDelayMs: [], maxMemoryBytes: null,
    generation: { randomTableEvery: 100, solveDepthRule: '(index - 1) % 13',
      solveDepthMeaning: 'number of complete legal tricks played before the current partial trick' },
    randomTableCount: 0, solveDepthCounts: Array(13).fill(0),
    operations: [], status: 'running',
  },
};
const save = () => writeReportCheckpoint(out, report);
let interrupted = false;
process.on('SIGINT', () => { interrupted = true; });
process.on('SIGTERM', () => { interrupted = true; });
let expectedCompletedOperations;

async function runCase(item) {
  const kind = item.kind;
  const deal = kind === 'solve' ? (item.deal ?? { trump: item.trump, trickLeader: item.trickLeader,
    trickPlayed: item.trickPlayed, hands: item.hands }) : undefined;
  const baselineStarted = performance.now();
  const baseline = kind === 'table' ? await calcDDTable(item.hands) : await solveBoard(deal);
  const baselineMs = performance.now() - baselineStarted;
  const normalizedBaseline = normalizeDdsResult(kind, baseline);
  const payload = kind === 'table' ? { hands: item.hands } : { deal };
  const workerStarted = performance.now();
  let worker, workerMs, queueDelayMs = null;
  let normalizedWorker;
  function validateWorkerResponse(response) {
    if (!response.metrics || !Number.isFinite(response.metrics.initMs) || !Number.isFinite(response.metrics.solveMs)
        || response.metrics.solveMs < 0 || response.metrics.initMs < 0) throw new Error('Malformed Worker metrics');
    try { normalizedWorker = normalizeDdsResult(kind, response.result); }
    catch (error) { throw new Error(`Malformed Worker response: ${error.message}`); }
    if (response.metrics.memoryBytes !== undefined
        && (!Number.isSafeInteger(response.metrics.memoryBytes) || response.metrics.memoryBytes < 0)) {
      throw new Error('Malformed Worker response: invalid memoryBytes metric');
    }
  }
  if (kind === 'solve') {
    // Both requests use the same fixed Worker URL and Durable Object. The
    // ping counter must prove this solve completed before its response.
    const timed = await probeTimedSolve({
      sendSolve: () => post('solve', payload), sendPing: () => post('ping', {}),
      expectedCompletedOperations, now: () => performance.now(),
      validateSolveResponse: validateWorkerResponse,
    });
    worker = timed.solveResponse;
    workerMs = timed.solveCompletedAt - workerStarted;
    queueDelayMs = timed.queueDelayMs;
    expectedCompletedOperations = timed.completedOperations;
  } else {
    worker = await post('table', payload);
    workerMs = performance.now() - workerStarted;
    validateWorkerResponse(worker);
    expectedCompletedOperations += 1;
  }
  const same = JSON.stringify(normalizedBaseline) === JSON.stringify(normalizedWorker);
  const record = { id: item.id, kind, depth: item.depth ?? null, baseline, worker: worker.result, baselineMs, workerMs,
    initMs: worker.metrics.initMs, solveCpuMs: worker.metrics.solveMs, queueDelayMs,
    memoryBytes: Number.isFinite(worker.metrics.memoryBytes) ? worker.metrics.memoryBytes : null };
  report.benchmark.operations.push(record);
  if (!same) report.benchmark.parityMismatches.push({ id: item.id, kind, baseline, worker: worker.result });
  if (kind === 'solve') {
    report.benchmark.solveCpuMs.push(worker.metrics.solveMs);
    report.benchmark.queueDelayMs.push(queueDelayMs);
  }
  if (record.memoryBytes !== null) report.benchmark.maxMemoryBytes = Math.max(report.benchmark.maxMemoryBytes ?? 0, record.memoryBytes);
}

try {
  const ready = await post('ping', {});
  if (!Number.isSafeInteger(ready.completedOperations) || ready.completedOperations < 0) throw new Error('Malformed readiness ping');
  expectedCompletedOperations = ready.completedOperations;
  for (const item of fixtures) {
    if (interrupted) throw new Error('Interrupted');
    await runCase(item);
    report.benchmark.completedFixtureCount += 1;
    save();
  }
  for (let i = 0; i < iterations; i++) {
    if (interrupted) throw new Error('Interrupted');
    const item = randomCase(i);
    await runCase(item);
    report.benchmark.completedIterations += 1;
    if (item.kind === 'table') report.benchmark.randomTableCount += 1;
    else report.benchmark.solveDepthCounts[item.depth] += 1;
    if (i % 5000 === 0 || i + 1 === iterations) save();
    if (i % 1000 === 0) console.log(`DDS benchmark: ${i + 1}/${iterations} random positions`);
  }
  report.benchmark.status = 'complete';
} catch (error) {
  report.benchmark.status = 'failed';
  report.benchmark.failure = error.message;
  process.exitCode = 1;
  console.error(`DDS benchmark stopped: ${error.message}`);
} finally {
  save();
  console.log(`DDS benchmark report: ${out}`);
}
