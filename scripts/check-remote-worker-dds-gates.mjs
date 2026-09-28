import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNTING_SCHEMA_VERSION, JOURNAL_SCHEMA_VERSION, SOAK_SEED, canonicalJson, canonicalRequest, ledgerAccounting, requestHash, sha256Utf8 } from './remote-dds-soak-state.mjs';
import { assertDeploymentManifest } from './prepare-remote-dds-deployment.mjs';
import { createRandomCaseGenerator } from './worker-dds-random-cases.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const COUNT = 22000;
const SHARDS = 11;
const WASM_LIMIT = 3 * 1024 * 1024;
const HEAP_LIMIT = 100663296;
const ACCOUNTING_LIMITS = { workerInbound: 25000, queuedDoCommands: 50000, sqliteReads: 25000, sqliteWrites: 25000 };
const ROOM_LIMITS = { writes: 70000, reads: 250000 };
const ACTIVATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
function latestPhysical(journal, operationId) {
  const records = journal.filter((entry) => entry.type === 'physical' && entry.operationId === operationId);
  if (!(records.length === 1 || records.length === 2) || records[0].replayed !== false || (records[1] && records[1].replayed !== true)) return null;
  return records.at(-1);
}
function bindsEvidence(record, evidence, route, shard) {
  return !!record && record.route === route && record.shard === String(shard) && record.response !== undefined
    && record.responseHash === sha256Utf8(canonicalJson(record.response)) && record.evidenceHash === sha256Utf8(canonicalJson(evidence))
    && equal(record.response, evidence.remote);
}
function activationForShard(report, evidence, journal) {
  const values = Array.from({ length: SHARDS }, () => new Set());
  for (const entry of journal) if (entry.type === 'completion' && Number.isSafeInteger(entry.index) && entry.index >= 0 && entry.index < COUNT) values[Math.floor(entry.index / 2000)].add(entry.activationId);
  const preflight = latestPhysical(journal, 'preflight.metrics');
  return ACTIVATION.test(evidence?.preflight?.activationId ?? '') && evidence?.preflight?.activationId === evidence?.preflight?.remote?.activationId
    && bindsEvidence(preflight, evidence.preflight, '/__dds/metrics', 0)
    && Array.isArray(evidence?.fixtures) && evidence.fixtures.every((fixture, index) => ACTIVATION.test(fixture?.remote?.activationId ?? '') && fixture.remote.activationId === latestPhysical(journal, `fixture.${String(index).padStart(6, '0')}`)?.response?.activationId)
    && Array.isArray(evidence?.operations) && evidence.operations.length === COUNT
    && evidence.operations.every((operation) => ACTIVATION.test(operation?.activationId ?? '') && values[operation.shard]?.has(operation.activationId))
    && values.every((set, shard) => set.size === 1 && report.activationIds?.[shard] === [...set][0]);
}

function validateCorpus({ evidence, manifest, journal }) {
  const operations = evidence?.operations;
  if (!Array.isArray(operations) || operations.length !== COUNT || evidence?.runId !== manifest?.runId) return false;
  const coverage = evidence.coverage;
  if (!Array.isArray(coverage?.shards) || coverage.shards.length !== SHARDS || coverage.shards.some((count) => count !== 2000)
      || !Array.isArray(coverage?.depths) || coverage.depths.length !== 13 || coverage.depths.some((count) => !Number.isSafeInteger(count) || count <= 0)) return false;
  const seen = new Set(); const actualDepths = Array(13).fill(0); const generate = createRandomCaseGenerator(SOAK_SEED);
  const intents = journal.filter((entry) => entry.type === 'intent');
  const completions = journal.filter((entry) => entry.type === 'completion');
  if (intents.length !== COUNT || completions.length !== COUNT) return false;
  for (let index = 0; index < COUNT; index++) {
    const op = operations[index], generated = generate(index), table = generated.kind === 'table', route = table ? '/__dds/table' : '/__dds/ordered-probe';
    const body = JSON.stringify(table ? { hands: generated.hands } : { deal: generated.deal });
    const intent = intents[index], completion = completions[index];
    if (!op || op.id !== generated.id || op.index !== index || op.shard !== Math.floor(index / 2000)
        || op.kind !== generated.kind || !equal(op.input, JSON.parse(body)) || seen.has(op.id) || op.parityMismatch === true || op.networkError || op.protocolError || op.error || op.remote?.ok !== true
        || !ACTIVATION.test(op.activationId ?? '') || !intent || intent.runId !== manifest.runId || intent.index !== index || intent.operationId !== `op.${String(index).padStart(6, '0')}` || intent.route !== route
        || intent.canonicalRequest !== canonicalRequest(route, body) || intent.requestHash !== requestHash(route, body)
        || !completion || completion.index !== index || completion.operationId !== intent.operationId || completion.activationId !== op.activationId || !/^[a-f0-9]{64}$/.test(completion.responseHash ?? '')) return false;
    seen.add(op.id);
    if (!table) { if (!Number.isSafeInteger(op.depth) || op.depth < 0 || op.depth > 12) return false; actualDepths[op.depth]++; }
  }
  if (actualDepths.some((count, index) => count !== coverage.depths[index])) return false;
  const physicalByOperation = new Map();
  for (const entry of journal.filter((entry) => entry.type === 'physical' && /^op\.\d{6}$/.test(entry.operationId))) {
    const entries = physicalByOperation.get(entry.operationId) ?? []; entries.push(entry); physicalByOperation.set(entry.operationId, entries);
  }
  for (const completion of completions) {
    const entries = physicalByOperation.get(completion.operationId) ?? [];
    if (!(entries.length === 1 || entries.length === 2) || entries[0].replayed !== false || (entries[1] && entries[1].replayed !== true)
      || entries.some((entry) => !entry.response || entry.responseHash !== sha256Utf8(canonicalJson(entry.response)))
      || entries.at(-1)?.responseHash !== completion.responseHash) return false;
  }
  for (let index = 0; index < COUNT; index++) {
    const operation = operations[index], operationId = `op.${String(index).padStart(6, '0')}`;
    if (operation.nativeBaseline === undefined || !bindsEvidence(physicalByOperation.get(operationId)?.at(-1), operation, operation.kind === 'table' ? '/__dds/table' : '/__dds/ordered-probe', operation.shard)) return false;
  }
  return true;
}
function validateFixtures({ evidence, journal }) {
  const expected = readJson(resolve(ROOT, 'workers/test/fixtures/dds-parity.json'), 'fixture corpus');
  if (!Array.isArray(evidence?.fixtures) || evidence.fixtures.length !== expected.length || evidence.fixtureHash !== hash(resolve(ROOT, 'workers/test/fixtures/dds-parity.json'))) return false;
  if (!expected.every((fixture, index) => {
    const item = evidence.fixtures[index];
    const metrics = item?.remoteMetrics ?? item?.remote?.metrics ?? item?.remote?.solveResponse?.metrics;
    const input = fixture.kind === 'table' ? { hands: fixture.hands } : { deal: fixture.deal ?? { trump: fixture.trump, trickLeader: fixture.trickLeader, trickPlayed: fixture.trickPlayed, hands: fixture.hands } };
    const native = fixture.expected?.table ?? fixture.expected;
    return item?.id === fixture.id && item?.kind === fixture.kind && equal(item.input, input) && equal(item.nativeBaseline, native) && item.remote?.ok === true && metrics
      && !item.parityMismatch && !item.networkError && !item.protocolError && !item.error && ACTIVATION.test(item.remote?.activationId ?? '');
  })) return false;
  const physical = journal.filter((entry) => entry.type === 'physical');
  const firstRandom = physical.findIndex((entry) => /^op\.\d{6}$/.test(entry.operationId));
  const fixtures = physical.filter((entry) => /^fixture\.\d{6}$/.test(entry.operationId));
  if (!(firstRandom > 0 && fixtures.length >= expected.length && physical.slice(0, firstRandom).filter((entry) => /^fixture\.\d{6}$/.test(entry.operationId)).length >= expected.length)) return false;
  for (let index = 0; index < expected.length; index++) {
    const id = `fixture.${String(index).padStart(6, '0')}`, indexes = physical.map((entry, physicalIndex) => entry.operationId === id ? physicalIndex : -1).filter((physicalIndex) => physicalIndex >= 0), records = indexes.map((physicalIndex) => physical[physicalIndex]), fixture = evidence.fixtures[index];
    if (!(records.length === 1 || records.length === 2) || records[0].replayed !== false || (records[1] && records[1].replayed !== true)) return false;
    if (records.length === 2 && indexes[1] !== indexes[0] + 1) return false;
    if (!bindsEvidence(records.at(-1), fixture, fixture.kind === 'table' ? '/__dds/table' : '/__dds/ordered-probe', 0)) return false;
  }
  return true;
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
    ['source-hashes', manifest?.seed === SOAK_SEED && manifest?.randomGenerator === 'xorshift32' && manifest?.accountingSchemaVersion === ACCOUNTING_SCHEMA_VERSION && manifest?.journalSchemaVersion === JOURNAL_SCHEMA_VERSION
      && Array.isArray(manifest?.shards) && manifest.shards.length === SHARDS && manifest.shards.every((shard, index) => shard?.shard === index && shard.startIndex === index * 2000 && shard.endIndex === index * 2000 + 1999)
      && manifest?.hashes?.randomGenerator === hash(resolve(ROOT, 'scripts/worker-dds-random-cases.mjs')) && manifest?.hashes?.fixtureCorpus === hash(resolve(ROOT, 'workers/test/fixtures/dds-parity.json')) && manifest?.hashes?.simulator === hash(resolve(ROOT, 'scripts/simulate-worker-room-budget.mjs'))],
    ['corpus', report?.completedCursor === COUNT && validateCorpus({ evidence, manifest, journal })],
    ['fixture-first', validateFixtures({ evidence, journal })],
    ['journal', validateJournal(journal) && report?.terminalFailure === null],
    ['parity', Array.isArray(evidence?.operations) && evidence.operations.every((op) => op.parityMismatch !== true && !op.networkError && !op.protocolError && !op.error && op.remote?.ok === true)],
    ['candidate-diagnostics', Array.isArray(evidence?.candidateDifferences) && evidence.candidateDifferences.every((diagnostic) => evidence.operations?.find((op) => op.id === diagnostic.id && equal(op.candidateDifference, diagnostic)))],
    ['depths', Array.isArray(evidence?.coverage?.depths) && evidence.coverage.depths.length === 13 && evidence.coverage.depths.every((count) => Number.isSafeInteger(count) && count > 0)],
    ['activation', activationForShard(report, evidence, journal)],
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
