import { readFileSync } from 'node:fs';

// Conservative local gate for a Free-plan Worker script (Wasm bytes only).
// It intentionally leaves room for the JavaScript wrapper in a 3 MiB budget.
const WASM_LIMIT_BYTES = 3 * 1024 * 1024;
const MEMORY_LIMIT_BYTES = 96 * 1024 * 1024;
const DEFAULT_REPORT = 'workers/test/results/dds-feasibility.json';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const samples = (values) => Array.isArray(values) && values.length > 0 && values.every(finite);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

function printGate(name, pass, detail) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  return pass;
}

let report;
try {
  report = JSON.parse(readFileSync(argument('--report', DEFAULT_REPORT), 'utf8'));
} catch (error) {
  console.error(`Cannot read DDS feasibility report: ${error.message}`);
  process.exitCode = 1;
  report = {};
}
const benchmark = report?.benchmark ?? {};
const budget = report?.budget ?? {};
const sorted = samples(benchmark.solveCpuMs) ? [...benchmark.solveCpuMs].sort((a, b) => a - b) : [];
const p99 = sorted.length ? sorted[Math.ceil(sorted.length * 0.99) - 1] : undefined;
const maxSolve = sorted.length ? sorted.at(-1) : undefined;
const maxQueue = samples(benchmark.queueDelayMs)
  ? benchmark.queueDelayMs.reduce((max, value) => Math.max(max, value), 0) : undefined;
let passed = true;
const gate = (name, ok, detail) => { passed = printGate(name, ok, detail) && passed; };

// Benchmark reports keep per-operation records. Compact synthetic or external
// reports may instead supply aggregate table/solve operationCounts, but raw
// CPU and queue arrays must still contain one sample per solve. If records
// exist, their counts and sample values must agree with the raw arrays.
const recorded = Array.isArray(benchmark.operations) ? benchmark.operations : null;
const counts = recorded ? {
  table: recorded.filter((op) => op?.kind === 'table').length,
  solve: recorded.filter((op) => op?.kind === 'solve').length,
} : benchmark.operationCounts;
const countsValid = counts && integer(counts.table) && integer(counts.solve)
  && counts.table + counts.solve === benchmark.completedIterations + benchmark.completedFixtureCount;
let recordsValid = true;
if (recorded) {
  let solveIndex = 0;
  for (const op of recorded) {
    if (!op || typeof op.id !== 'string' || !['table', 'solve'].includes(op.kind)
        || !Object.hasOwn(op, 'baseline') || !Object.hasOwn(op, 'worker')
        || !finite(op.baselineMs) || !finite(op.workerMs) || !finite(op.initMs)
        || !finite(op.solveCpuMs)) { recordsValid = false; break; }
    if (op.kind === 'solve') {
      if (!finite(op.queueDelayMs) || op.solveCpuMs !== benchmark.solveCpuMs?.[solveIndex]
          || op.queueDelayMs !== benchmark.queueDelayMs?.[solveIndex]) { recordsValid = false; break; }
      solveIndex += 1;
    } else if (op.queueDelayMs !== null) { recordsValid = false; break; }
  }
  recordsValid = recordsValid && recorded.length === counts.table + counts.solve
    && solveIndex === counts.solve;
}
const sampleEvidence = countsValid && samples(benchmark.solveCpuMs) && samples(benchmark.queueDelayMs)
  && benchmark.solveCpuMs.length === counts.solve && benchmark.queueDelayMs.length === counts.solve;
const depths = benchmark.solveDepthCounts;
const depthCount = Array.isArray(depths) ? depths.reduce((sum, count) => sum + count, 0) : 0;
let recordedCoverage = true;
if (recorded && benchmark.status === 'complete') {
  const observedDepths = Array(13).fill(0);
  const randomIndexes = new Set();
  let observedTables = 0;
  for (const op of recorded) {
    const match = /^random-(\d+)$/.exec(op.id);
    if (!match) continue;
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index < 0 || index >= benchmark.iterations || randomIndexes.has(index)) {
      recordedCoverage = false; break;
    }
    randomIndexes.add(index);
    if ((index % 100 === 0) !== (op.kind === 'table')) { recordedCoverage = false; break; }
    if (op.kind === 'table') observedTables += 1;
    else if (integer(op.depth) && op.depth < 13) observedDepths[op.depth] += 1;
    else { recordedCoverage = false; break; }
  }
  recordedCoverage = recordedCoverage && randomIndexes.size === benchmark.completedIterations
    && observedTables === benchmark.randomTableCount
    && Array.isArray(depths) && observedDepths.every((count, depth) => count === depths[depth]);
}
const coverageEvidence = benchmark.status !== 'complete' || (
  integer(benchmark.randomTableCount)
  && benchmark.generation?.randomTableEvery === 100
  && benchmark.randomTableCount === Math.ceil(benchmark.iterations / 100)
  && Array.isArray(depths) && depths.length === 13 && depths.every((count) => integer(count) && count > 0)
  && depthCount + benchmark.randomTableCount === benchmark.completedIterations
  && counts?.table >= benchmark.randomTableCount
  && counts?.solve >= depthCount
  && counts.table - benchmark.randomTableCount + counts.solve - depthCount === benchmark.completedFixtureCount
  && recordedCoverage
);
const complete = integer(benchmark.iterations) && benchmark.iterations >= 100000
  && benchmark.completedIterations === benchmark.iterations
  && integer(benchmark.fixtureCount) && benchmark.fixtureCount > 0
  && benchmark.completedFixtureCount === benchmark.fixtureCount
  && benchmark.status === 'complete' && countsValid && recordsValid && sampleEvidence && coverageEvidence;
gate('benchmark-completeness', complete,
  `${benchmark.completedIterations ?? 'missing'}/${benchmark.iterations ?? 'missing'} random; ${benchmark.completedFixtureCount ?? 'missing'}/${benchmark.fixtureCount ?? 'missing'} fixtures; ${counts?.table ?? 'missing'} table + ${counts?.solve ?? 'missing'} solve operations; ${benchmark.solveCpuMs?.length ?? 'missing'} CPU / ${benchmark.queueDelayMs?.length ?? 'missing'} queue samples; depths=${Array.isArray(depths) ? depths.join(',') : 'legacy/unavailable'}; status=${benchmark.status ?? 'missing'}`);
gate('parity', complete && Array.isArray(benchmark.parityMismatches) && benchmark.parityMismatches.length === 0,
  `${benchmark.parityMismatches?.length ?? 'missing'} mismatches`);
gate('wasm-bundle', finite(benchmark.bundleBytes) && benchmark.bundleBytes < WASM_LIMIT_BYTES,
  `${benchmark.bundleBytes ?? 'missing'} bytes < ${WASM_LIMIT_BYTES} bytes`);
gate('memory', finite(benchmark.maxMemoryBytes) && benchmark.maxMemoryBytes < MEMORY_LIMIT_BYTES,
  `${benchmark.maxMemoryBytes ?? 'missing'} bytes < ${MEMORY_LIMIT_BYTES} bytes`);
gate('p99-solve-cpu', samples(benchmark.solveCpuMs) && p99 < 1000,
  `${p99 ?? 'missing'} ms < 1000 ms`);
gate('max-solve-cpu', samples(benchmark.solveCpuMs) && maxSolve < 10000,
  `${maxSolve ?? 'missing'} ms < 10000 ms`);
gate('max-queued-command-delay', samples(benchmark.queueDelayMs) && maxQueue < 10000,
  `${maxQueue ?? 'missing'} ms < 10000 ms`);
gate('writes-per-day', budget.rooms === 50 && integer(budget.writesPerDay) && budget.writesPerDay <= 70000,
  `${budget.writesPerDay ?? 'missing'} rows/day <= 70000`);
gate('reads-per-day', budget.rooms === 50 && integer(budget.readsPerDay) && budget.readsPerDay <= 250000,
  `${budget.readsPerDay ?? 'missing'} rows/day <= 250000`);
if (!passed) process.exitCode = 1;
