import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ledgerAccounting } from './remote-dds-soak-state.mjs';
import { assertDeploymentManifest } from './prepare-remote-dds-deployment.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const COUNT = 22000;
const SHARDS = 11;
const WASM_LIMIT = 3 * 1024 * 1024;
const HEAP_LIMIT = 100663296;
const ACCOUNTING_LIMITS = { workerInbound: 25000, queuedDoCommands: 50000, sqliteReads: 25000, sqliteWrites: 25000 };
const ROOM_LIMITS = { writes: 70000, reads: 250000 };
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const canonical = (value) => JSON.stringify(value);

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`Missing ${label}: ${path}`);
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`Invalid ${label}: ${path}`); }
}
function readJournal(path) {
  if (!existsSync(path)) throw new Error(`Missing journal: ${path}`);
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  try { return lines.map(JSON.parse); } catch { throw new Error('Invalid journal JSON'); }
}
function option(args, name, fallback = null) { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; }
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function nearestRankP99(samples) { const sorted = [...samples].sort((a, b) => a - b); return sorted[Math.ceil(sorted.length * 0.99) - 1]; }
function equal(left, right) { return canonical(left) === canonical(right); }
function activationForShard(report, journal) {
  const values = Array.from({ length: SHARDS }, () => new Set());
  for (const entry of journal) if (entry.type === 'completion' && Number.isSafeInteger(entry.index) && entry.index >= 0 && entry.index < COUNT) values[Math.floor(entry.index / 2000)].add(entry.activationId);
  return values.every((set, shard) => set.size === 1 && report.activationIds?.[shard] === [...set][0]);
}

function validateCorpus({ evidence, manifest, journal }) {
  const operations = evidence?.operations;
  if (!Array.isArray(operations) || operations.length !== COUNT || evidence?.runId !== manifest?.runId) return false;
  const coverage = evidence.coverage;
  if (!Array.isArray(coverage?.shards) || coverage.shards.length !== SHARDS || coverage.shards.some((count) => count !== 2000)
      || !Array.isArray(coverage?.depths) || coverage.depths.length !== 13 || coverage.depths.some((count) => !Number.isSafeInteger(count) || count <= 0)) return false;
  const seen = new Set(); const actualDepths = Array(13).fill(0);
  for (let index = 0; index < COUNT; index++) {
    const op = operations[index], table = index % 100 === 0;
    if (!op || op.id !== `random-${index}` || op.index !== index || op.shard !== Math.floor(index / 2000)
        || op.kind !== (table ? 'table' : 'solve') || seen.has(op.id) || op.parityMismatch === true || op.networkError || op.protocolError || op.error || op.remote?.ok === false) return false;
    seen.add(op.id);
    if (!table) { if (!Number.isSafeInteger(op.depth) || op.depth < 0 || op.depth > 12) return false; actualDepths[op.depth]++; }
  }
  if (actualDepths.some((count, index) => count !== coverage.depths[index])) return false;
  const intents = journal.filter((entry) => entry.type === 'intent');
  const completions = journal.filter((entry) => entry.type === 'completion');
  return intents.length === COUNT && completions.length === COUNT && intents.every((entry, index) => entry.runId === manifest.runId && entry.index === index && entry.operationId === `op.${String(index).padStart(6, '0')}`)
    && completions.every((entry, index) => entry.index === index && entry.operationId === `op.${String(index).padStart(6, '0')}` && typeof entry.responseHash === 'string' && /^[a-f0-9]{64}$/.test(entry.responseHash));
}
function validateFixtures({ evidence, journal }) {
  const expected = readJson(resolve(ROOT, 'workers/test/fixtures/dds-parity.json'), 'fixture corpus');
  if (!Array.isArray(evidence?.fixtures) || evidence.fixtures.length !== expected.length || evidence.fixtureHash !== hash(resolve(ROOT, 'workers/test/fixtures/dds-parity.json'))) return false;
  if (!expected.every((fixture, index) => evidence.fixtures[index]?.id === fixture.id && evidence.fixtures[index]?.kind === fixture.kind)) return false;
  const physical = journal.filter((entry) => entry.type === 'physical');
  const firstRandom = physical.findIndex((entry) => /^op\.\d{6}$/.test(entry.operationId));
  const fixtures = physical.filter((entry) => /^fixture\.\d{6}$/.test(entry.operationId));
  return firstRandom > 0 && fixtures.length === expected.length && physical.slice(0, firstRandom).filter((entry) => /^fixture\.\d{6}$/.test(entry.operationId)).length === expected.length;
}
function validateJournal(journal) {
  if (!Array.isArray(journal) || journal.some((entry) => entry.type === 'failed')) return false;
  const physical = journal.filter((entry) => entry.type === 'physical');
  try { ledgerAccounting(physical); return physical.length > COUNT; } catch { return false; }
}
function validateDeployment({ deployment, evidence }) {
  if (!deployment || evidence?.buildId !== deployment.buildId || evidence?.workerVersionId !== deployment.workerVersionId
      || evidence?.preflight?.endpointBuildId !== deployment.buildId || evidence?.preflight?.endpointWorkerVersionId !== deployment.workerVersionId) return false;
  if (deployment?.verifiedDeployment?.apiVerified !== true || deployment?.verifiedDeployment?.versionId !== deployment.workerVersionId
      || typeof deployment?.verifiedDeployment?.wranglerVersion !== 'string' || !deployment?.verifiedDeployment?.temporaryWorkerName?.startsWith('stepstone-dds-soak-')) return false;
  try { assertDeploymentManifest(deployment, { root: ROOT }); return true; } catch { return false; }
}

export function evaluateRemoteSoak({ manifest, report, evidence, journal, deployment, simulator }) {
  const physical = journal.filter((entry) => entry.type === 'physical');
  let ledger = null; try { ledger = ledgerAccounting(physical); } catch { /* journal gate reports this */ }
  const elapsed = Array.isArray(evidence?.operations) ? evidence.operations.map((op) => op.wasmElapsedMs) : [];
  const heap = Array.isArray(evidence?.operations) ? evidence.operations.map((op) => op.heapBytes) : [];
  const queues = Array.isArray(evidence?.operations) ? evidence.operations.filter((op) => op.kind === 'solve').map((op) => op.orderedPingDelayMs) : [];
  const allElapsed = elapsed.length === COUNT && elapsed.every(finite);
  const allHeap = heap.length === COUNT && heap.every((value) => Number.isSafeInteger(value) && value > 0);
  const allQueues = queues.length === COUNT - 220 && queues.every(finite);
  const observed = report?.observed;
  const results = [
    ['source-hashes', manifest?.hashes?.randomGenerator === hash(resolve(ROOT, 'scripts/worker-dds-random-cases.mjs')) && manifest?.hashes?.fixtureCorpus === hash(resolve(ROOT, 'workers/test/fixtures/dds-parity.json'))],
    ['corpus', report?.completedCursor === COUNT && validateCorpus({ evidence, manifest, journal })],
    ['fixture-first', validateFixtures({ evidence, journal })],
    ['journal', validateJournal(journal) && report?.terminalFailure === null],
    ['parity', Array.isArray(evidence?.operations) && evidence.operations.every((op) => op.parityMismatch !== true && !op.networkError && !op.protocolError && !op.error && op.remote?.ok !== false)],
    ['candidate-diagnostics', Array.isArray(evidence?.candidateDifferences) && evidence.candidateDifferences.every((diagnostic) => evidence.operations?.find((op) => op.id === diagnostic.id && equal(op.candidateDifference, diagnostic)))],
    ['depths', Array.isArray(evidence?.coverage?.depths) && evidence.coverage.depths.length === 13 && evidence.coverage.depths.every((count) => Number.isSafeInteger(count) && count > 0)],
    ['activation', activationForShard(report, journal)],
    ['deployment', validateDeployment({ deployment, evidence })],
    ['wasm-bundle', Number.isSafeInteger(deployment?.assets?.wasm?.bytes) && deployment.assets.wasm.bytes < WASM_LIMIT],
    ['heap', allHeap && Math.max(...heap) < HEAP_LIMIT],
    ['p99-wasm-elapsed', allElapsed && nearestRankP99(elapsed) < 1000],
    ['max-wasm-elapsed', allElapsed && Math.max(...elapsed) < 10000],
    ['queue-delay', allQueues && Math.max(...queues) < 10000],
    ['worker-inbound', ledger !== null && observed?.workerInbound === ledger.workerInbound && ledger.workerInbound <= ACCOUNTING_LIMITS.workerInbound],
    ['do-fetch-arrivals', ledger !== null && observed?.doFetchArrivals === ledger.doFetchArrivals && ledger.doFetchArrivals <= ACCOUNTING_LIMITS.workerInbound],
    ['queued-do-commands', ledger !== null && observed?.queuedDoCommands === ledger.queuedDoCommands && ledger.queuedDoCommands <= ACCOUNTING_LIMITS.queuedDoCommands],
    ['sqlite', ledger !== null && observed?.sqliteRows?.reads === ledger.sqliteRows.reads && observed?.sqliteRows?.writes === ledger.sqliteRows.writes && ledger.sqliteRows.reads <= ACCOUNTING_LIMITS.sqliteReads && ledger.sqliteRows.writes <= ACCOUNTING_LIMITS.sqliteWrites],
    ['room-simulator', simulator?.budget?.rooms === 50 && Number.isSafeInteger(simulator.budget.writesPerDay) && simulator.budget.writesPerDay <= ROOM_LIMITS.writes && Number.isSafeInteger(simulator.budget.readsPerDay) && simulator.budget.readsPerDay <= ROOM_LIMITS.reads],
  ];
  return results.map(([name, passed]) => ({ name, passed: Boolean(passed) }));
}
function runCli() {
  const args = process.argv.slice(2);
  const runDir = option(args, '--run-dir');
  const deploymentPath = option(args, '--deployment-manifest');
  const simulatorPath = option(args, '--simulator-report');
  if (!runDir || !deploymentPath || !simulatorPath) throw new Error('--run-dir, --deployment-manifest, and --simulator-report are required');
  const dir = resolve(process.cwd(), runDir);
  const gates = evaluateRemoteSoak({ manifest: readJson(resolve(dir, 'manifest.json'), 'run manifest'), report: readJson(resolve(dir, 'report.json'), 'run report'),
    evidence: readJson(resolve(dir, 'evidence.json'), 'run evidence'), journal: readJournal(resolve(dir, 'journal.jsonl')),
    deployment: readJson(resolve(process.cwd(), deploymentPath), 'deployment manifest'), simulator: readJson(resolve(process.cwd(), simulatorPath), 'simulator report') });
  for (const gate of gates) console.log(`${gate.passed ? 'PASS' : 'FAIL'} ${gate.name}`);
  if (gates.some((gate) => !gate.passed)) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
