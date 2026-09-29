import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRandomCaseGenerator } from './worker-dds-random-cases.mjs';
import { compareDdsResults, normalizeDdsResult, validateWorkerSolveCandidates } from './worker-dds-benchmark-validation.mjs';
import { createSoakState, recoverSoakState, ledgerAccounting, projectAccounting, requestHash, SOAK_SEED } from './remote-dds-soak-state.mjs';
import { assertDeploymentManifest } from './prepare-remote-dds-deployment.mjs';
import { writeReportCheckpoint } from './worker-dds-checkpoint.mjs';

const require = createRequire(import.meta.url);
const { calcDDTable, solveBoard } = require('../dds-wrapper.js');
export const OPERATION_COUNT = 22000;
export const SHARD_COUNT = 11;
export const DEPTH_COUNT = 13;
export const MAX_TRANSPORT_RETRIES = 64;
const ROOT = resolve(import.meta.dirname, '..');

export function assertRemoteEndpoint(value) {
  let url; try { url = new URL(value); } catch { throw new Error('Remote Worker URL must be an HTTPS workers.dev root URL'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Remote Worker URL must be an HTTPS workers.dev root URL');
  }
  return url.origin;
}
export function assertRunDirectory(dir, resume) {
  if (existsSync(dir) && readdirSync(dir).length && !resume) throw new Error('Run directory is nonempty; pass --resume to continue it');
  mkdirSync(dir, { recursive: true }); return dir;
}
export function assertEndpointBuild(payload, buildId) {
  if (payload?.buildId !== buildId) throw new Error(`Remote endpoint build ID mismatch: expected ${buildId}, received ${payload?.buildId ?? 'missing'}`);
  return payload;
}
export function assertEndpointVersion(payload, workerVersionId) {
  if (payload?.workerVersionId !== workerVersionId) throw new Error(`Remote endpoint Worker version ID mismatch: expected ${workerVersionId}, received ${payload?.workerVersionId ?? 'missing'}`);
  return payload;
}
export function buildPreflightEvidence(remote) {
  return { accounting: remote.accounting, accountingActivationId: remote.accountingActivationId, remote: remote.operationResult, activationId: remote.operationResult.activationId, replayed: remote.replayed,
    endpointBuildId: remote.operationResult.buildId, endpointWorkerVersionId: remote.operationResult.workerVersionId };
}
export function reconcileObservedLedger(observed, physicalOperations) {
  const actual = ledgerAccounting(physicalOperations);
  if (JSON.stringify(observed) !== JSON.stringify(actual)) throw new Error('Observed remote accounting does not reconcile to the durable physical-request ledger');
  return observed;
}
export function deriveCandidateDifferences(operations) {
  if (!Array.isArray(operations)) throw new Error('Operation evidence is required to derive candidate diagnostics');
  const seen = new Set();
  const diagnostics = [];
  for (const operation of operations) {
    if (operation?.kind !== 'solve' || operation.candidateDifference == null) continue;
    if (typeof operation.id !== 'string' || !operation.id || seen.has(operation.id)) {
      throw new Error('Candidate diagnostic operation identity is invalid');
    }
    seen.add(operation.id);
    diagnostics.push({ id: operation.id, ...operation.candidateDifference });
  }
  return diagnostics;
}
export function mergeRecoveredEvidence({ checkpoint, durableOperations, durableFixtures, durablePreflight = null }) {
  if (!checkpoint || typeof checkpoint !== 'object' || !Array.isArray(durableOperations) || !Array.isArray(durableFixtures)
      || (durablePreflight !== null && (typeof durablePreflight !== 'object' || Array.isArray(durablePreflight)))) {
    throw new Error('Recovery requires checkpoint and durable evidence arrays');
  }
  const unique = (items, label) => {
    const ids = new Set();
    for (const item of items) {
      if (typeof item?.id !== 'string' || !item.id || ids.has(item.id)) throw new Error(`Recovered ${label} evidence is invalid`);
      ids.add(item.id);
    }
    return [...items];
  };
  const operations = unique(durableOperations, 'operation').sort((left, right) => left.index - right.index);
  const fixtures = unique(durableFixtures, 'fixture');
  return { ...checkpoint, ...(durablePreflight === null ? {} : { preflight: durablePreflight }),
    operations, fixtures, candidateDifferences: deriveCandidateDifferences(operations) };
}
// The completion projection is built from the immutable workload identity, not
// a mutable counter. A recovered execution may have an original request and a
// single replay, but it may never silently add another preflight or fixture.
export function projectCompletionLedger({ operations, fixtures, physicalOperations }) {
  if (!Array.isArray(operations) || !Array.isArray(fixtures) || !Array.isArray(physicalOperations)) throw new Error('Completion projection requires operations, fixtures, and physical ledger');
  const expected = new Map([['preflight.metrics', '/__dds/metrics']]);
  fixtures.forEach((fixture, index) => expected.set(`fixture.${String(index).padStart(6, '0')}`, fixture.kind === 'table' ? '/__dds/table' : fixture.kind === 'solve' ? '/__dds/ordered-probe' : null));
  operations.forEach((operation, index) => expected.set(`op.${String(index).padStart(6, '0')}`, operation.route));
  if ([...expected.values()].some((route) => !route)) throw new Error('Completion projection contains an unsupported fixture route');
  const grouped = new Map();
  for (const physical of physicalOperations) {
    if (!expected.has(physical.operationId)) throw new Error(`Completion ledger has an unexpected operation: ${physical.operationId}`);
    if (physical.route !== expected.get(physical.operationId)) throw new Error(`Completion ledger route changed: ${physical.operationId}`);
    const records = grouped.get(physical.operationId) ?? []; records.push(physical); grouped.set(physical.operationId, records);
  }
  for (const [operationId] of expected) {
    const records = grouped.get(operationId) ?? [];
    if (!records.length) throw new Error(`Completion ledger is missing required operation: ${operationId}`);
    if (!((records.length === 1 && records[0].replayed === false)
        || (records.length === 2 && records[0].replayed === false && records[1].replayed === true))) {
      throw new Error(`Completion ledger has an invalid replay count: ${operationId}`);
    }
  }
  return ledgerAccounting(physicalOperations);
}
export function parseOptions(args = process.argv.slice(2), env = process.env) {
  const get = (name, fallback = null) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
  if (args.includes('--count')) throw new Error('--count is not supported; the remote soak always runs exactly 22000 operations');
  const endpoint = assertRemoteEndpoint(get('--url', ''));
  if (!env.DDS_REMOTE_TEST_KEY) throw new Error('DDS_REMOTE_TEST_KEY is required');
  return { endpoint, runDir: get('--run-dir', 'workers/test/results/remote-soak'), deploymentManifest: get('--deployment-manifest', 'workers/test/results/remote-dds-deployment.json'), resume: args.includes('--resume') };
}
export function createSeededOperations(seed = SOAK_SEED) {
  const random = createRandomCaseGenerator(seed);
  return Array.from({ length: OPERATION_COUNT }, (_, index) => {
    const item = random(index);
    const kind = item.kind;
    const payload = kind === 'table' ? { hands: item.hands } : { deal: item.deal };
    return { index, id: item.id, kind, depth: kind === 'solve' ? item.depth : undefined,
      shard: Math.floor(index / 2000), route: kind === 'table' ? '/__dds/table' : '/__dds/ordered-probe', body: JSON.stringify(payload), item };
  });
}
export function validateCoverage(operations) {
  if (operations.length !== OPERATION_COUNT) throw new Error(`Expected exactly ${OPERATION_COUNT} seeded operations`);
  const shards = Array(SHARD_COUNT).fill(0), depths = Array(DEPTH_COUNT).fill(0);
  for (const operation of operations) { shards[operation.shard]++; if (operation.kind === 'solve') depths[operation.depth]++; }
  if (shards.some((count) => count !== 2000) || depths.some((count) => count === 0)) throw new Error('Seeded operation coverage is incomplete');
  return { shards, depths };
}
function stableHeaders({ key, runId, operationId, route, body, shard }) {
  return { 'content-type': 'application/json', 'x-dds-test-key': key, 'x-dds-run-id': runId,
    'x-dds-operation-id': operationId, 'x-dds-request-hash': requestHash(route, body), 'x-dds-shard': String(shard) };
}
function retryableTransportError(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError'
    || (error instanceof TypeError && error.message === 'fetch failed');
}

function safeTransportCode(error) {
  const code = error?.cause?.code;
  if (typeof code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(code)) return code;
  return typeof error?.name === 'string' && /^[a-z0-9_-]{1,64}$/i.test(error.name) ? error.name : 'TRANSPORT_ERROR';
}

export async function remotePost(endpoint, args, { fetchImpl = fetch, retryBudget = null,
  sleepImpl = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)) } = {}) {
  let retried = false, attempts = 0;
  while (true) {
    try {
      attempts += 1;
      const response = await fetchImpl(`${endpoint}${args.route}`, { method: 'POST', headers: stableHeaders(args), body: args.body, signal: AbortSignal.timeout(60000) });
      let payload; try { payload = await response.json(); } catch { throw new Error(`Malformed remote JSON: ${args.route} status ${response.status}`); }
      if (!response.ok || payload?.operationResult?.ok !== true || !payload.accounting) throw new Error(`Remote operation failed: ${args.route} status ${response.status}`);
      return payload;
    } catch (error) {
      const remaining = retryBudget?.remaining;
      if (!retryableTransportError(error)) throw error;
      if (retried || !Number.isSafeInteger(remaining) || remaining <= 0) {
        throw new Error(`Remote transport failed: ${args.route} (${safeTransportCode(error)}) after ${attempts} attempts`, { cause: error });
      }
      retryBudget.remaining -= 1;
      retryBudget.used = (Number.isSafeInteger(retryBudget.used) ? retryBudget.used : 0) + 1;
      retried = true;
      await sleepImpl(500);
    }
  }
}
function unwrap(operation, remote) {
  const result = remote.operationResult;
  if (operation.kind === 'table') return result.result;
  if (result.pingResponse?.completedOperations !== undefined && result.solveResponse?.ok === true) return result.solveResponse.result;
  throw new Error('Ordered solve probe did not return an ordered solve/ping pair');
}
function verify(operation, baseline, remote) {
  const worker = unwrap(operation, remote); normalizeDdsResult(operation.kind, worker);
  if (operation.kind === 'solve') validateWorkerSolveCandidates(worker, operation.item.deal);
  const comparison = compareDdsResults(operation.kind, baseline, worker);
  if (comparison.parityMismatch) throw new Error(`DDS parity mismatch at ${operation.id}`);
  return { candidateDifference: comparison.candidateDifference, worker };
}
async function baseline(operation) { return operation.kind === 'table' ? calcDDTable(operation.item.hands) : solveBoard(operation.item.deal); }
async function runFixtureChecks({ endpoint, key, runId, fixtures, buildId, evidence, state, retryBudget }) {
  for (const [index, item] of fixtures.entries()) {
    const kind = item.kind, route = kind === 'table' ? '/__dds/table' : '/__dds/ordered-probe';
    const operationId = `fixture.${String(index).padStart(6, '0')}`;
    if (state.hasPhysicalOperation(operationId)) continue;
    const body = JSON.stringify(kind === 'table' ? { hands: item.hands } : { deal: item.deal ?? { trump: item.trump, trickLeader: item.trickLeader, trickPlayed: item.trickPlayed, hands: item.hands } });
    state.recordAuxiliaryIntent({ operationId, route, body, shard: 0 });
    const remote = await remotePost(endpoint, { key, runId, operationId, route, body, shard: 0 }, { retryBudget });
    const op = { kind, id: item.id, item: kind === 'table' ? { hands: item.hands } : { deal: JSON.parse(body).deal } };
    const worker = unwrap(op, remote); const expected = item.expected?.table ?? item.expected;
    const native = kind === 'table' ? await calcDDTable(item.hands) : await solveBoard(op.item.deal);
    if (JSON.stringify(normalizeDdsResult(kind, worker)) !== JSON.stringify(normalizeDdsResult(kind, native))) throw new Error(`Fixture native parity mismatch: ${item.id}`);
    if (JSON.stringify(normalizeDdsResult(kind, native)) !== JSON.stringify(normalizeDdsResult(kind, expected))) throw new Error(`Fixture corpus drift: ${item.id}`);
    if (index === 0 && remote.operationResult.buildId !== undefined) assertEndpointBuild(remote.operationResult, buildId);
    const fixtureEvidence = { id: item.id, route, input: JSON.parse(body), nativeBaseline: native, remote: remote.operationResult,
      accounting: remote.accounting, accountingActivationId: remote.accountingActivationId, replayed: remote.replayed };
    state.recordAuxiliaryResponse({ operationId, route, replayed: remote.replayed, response: remote.operationResult,
      accountingActivationId: remote.accountingActivationId,
      evidence: fixtureEvidence, evidenceKind: 'fixture', remoteAccounting: remote.accounting, shard: 0 });
    evidence.fixtures.push(fixtureEvidence);
  }
}
function option(name, fallback) { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1]; }
async function runCli() {
  const options = parseOptions();
  const endpoint = options.endpoint;
  const key = process.env.DDS_REMOTE_TEST_KEY;
  const runDir = assertRunDirectory(resolve(ROOT, options.runDir), options.resume);
  const manifestPath = resolve(ROOT, options.deploymentManifest);
  const deployment = assertDeploymentManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), { root: ROOT });
  const operations = createSeededOperations(); const coverage = validateCoverage(operations);
  const fixtures = JSON.parse(readFileSync(resolve(ROOT, 'workers/test/fixtures/dds-parity.json'), 'utf8'));
  const resume = options.resume;
  const runId = resume
    ? JSON.parse(readFileSync(resolve(runDir, 'manifest.json'), 'utf8')).runId
    : `soak-${randomUUID()}`;
  if (typeof runId !== 'string' || !runId) throw new Error('Resumed run has no persisted run identity');
  const fixtureTables = fixtures.filter((item) => item.kind === 'table').length;
  const fixtureSolves = fixtures.filter((item) => item.kind === 'solve').length;
  const projectionArgs = { fixtureTables, fixtureSolves, metricProbes: 1, pendingReplays: MAX_TRANSPORT_RETRIES };
  let projection = projectAccounting(projectionArgs);
  const requestForIndex = (index) => operations[index];
  const state = resume ? recoverSoakState({ dir: runDir, root: ROOT, requestForIndex, projection }) : createSoakState({ dir: runDir, root: ROOT, requestForIndex, projection, runId });
  const completedTransportRetries = state.physicalOperations.filter((record) => record.replayed === true).length;
  const retryBudget = { remaining: Math.max(0, MAX_TRANSPORT_RETRIES - completedTransportRetries), used: completedTransportRetries };
  if (resume) {
    // Every resumed attempt issues another preflight. A run interrupted before
    // its first durable operation also executes its fixture corpus again.
    projection = projectAccounting({ ...projectionArgs, metricProbes: 2,
      fixtureTables: state.report.completedCursor === 0 ? fixtureTables * 2 : fixtureTables,
      fixtureSolves: state.report.completedCursor === 0 ? fixtureSolves * 2 : fixtureSolves,
      pendingReplays: MAX_TRANSPORT_RETRIES });
  }
  let evidence = resume ? JSON.parse(readFileSync(resolve(runDir, 'evidence.json'), 'utf8')) : { version: 1, endpoint, runId, buildId: deployment.buildId, workerVersionId: deployment.workerVersionId,
    deploymentAssets: deployment.assets, fixtureHash: state.manifest.hashes.fixtureCorpus, projection, coverage, fixtures: [], operations: [], candidateDifferences: [] };
  if (resume) {
    evidence = mergeRecoveredEvidence({ checkpoint: evidence,
      durableOperations: state.evidence.filter((operation) => Number.isSafeInteger(operation?.index)),
      durableFixtures: state.fixtureEvidence, durablePreflight: state.preflightEvidence });
    writeReportCheckpoint(resolve(runDir, 'evidence.json'), evidence);
  }
  if (!resume) writeReportCheckpoint(resolve(runDir, 'evidence.json'), evidence);
  // The deployed Worker must explicitly identify the exact manifest being run.
  // This request is budgeted before any fixture or generated DDS dispatch.
  const preflightBody = '{}';
  if (!state.hasPhysicalOperation('preflight.metrics')) {
    state.recordAuxiliaryIntent({ operationId: 'preflight.metrics', route: '/__dds/metrics', body: preflightBody, shard: 0 });
    const preflight = await remotePost(endpoint, { key, runId, operationId: 'preflight.metrics', route: '/__dds/metrics', body: preflightBody, shard: 0 }, { retryBudget });
    assertEndpointBuild(preflight.operationResult, deployment.buildId);
    assertEndpointVersion(preflight.operationResult, deployment.workerVersionId);
    const preflightEvidence = buildPreflightEvidence(preflight);
    state.recordAuxiliaryResponse({ operationId: 'preflight.metrics', route: '/__dds/metrics', replayed: preflight.replayed,
      response: preflight.operationResult, accountingActivationId: preflight.accountingActivationId,
      evidence: preflightEvidence, evidenceKind: 'preflight', remoteAccounting: preflight.accounting, shard: 0 });
    evidence.preflight = preflightEvidence;
    writeReportCheckpoint(resolve(runDir, 'evidence.json'), evidence);
  }
  await runFixtureChecks({ endpoint, key, runId, fixtures, buildId: deployment.buildId, evidence, state, retryBudget });
  const dispatch = async (operation, operationId) => remotePost(endpoint, { key, runId, operationId, route: operation.route, body: operation.body, shard: operation.shard }, { retryBudget });
  if (state.recovery?.kind === 'replay-pending') {
    const pending = state.recovery.intent, operation = operations[pending.index];
    const remote = await dispatch(operation, pending.operationId); const native = await baseline(operation); const checked = verify(operation, native, remote);
    const replayEvidence = { id: operation.id, index: pending.index, kind: operation.kind, shard: operation.shard,
      ...(operation.kind === 'solve' ? { depth: operation.depth } : {}), replay: true, input: JSON.parse(operation.body), nativeBaseline: native, remote: remote.operationResult,
      remoteMetrics: remote.operationResult.metrics ?? remote.operationResult.solveResponse?.metrics ?? null,
      heapBytes: remote.operationResult.metrics?.heapBytes ?? remote.operationResult.solveResponse?.metrics?.heapBytes ?? null,
      wasmElapsedMs: remote.operationResult.metrics?.solveMs ?? remote.operationResult.solveResponse?.metrics?.solveMs ?? null,
      orderedPingDelayMs: remote.operationResult.queueDelayMs ?? null, accountingActivationId: remote.accountingActivationId, ...checked };
    state.completeReplay({ operationId: pending.operationId, response: remote.operationResult, activationId: remote.operationResult.activationId,
      accountingActivationId: remote.accountingActivationId,
      replayed: remote.replayed, evidence: replayEvidence, remoteAccounting: remote.accounting });
    evidence.operations.push(replayEvidence);
    evidence.candidateDifferences = deriveCandidateDifferences(evidence.operations);
    writeReportCheckpoint(resolve(runDir, 'evidence.json'), evidence);
  }
  for (let index = state.report.completedCursor; index < operations.length; index++) {
    const operation = operations[index], operationId = `op.${String(index).padStart(6, '0')}`;
    state.recordIntent({ index, operationId, route: operation.route, body: operation.body });
    try {
      const remote = await dispatch(operation, operationId); const nativeStarted = performance.now(); const native = await baseline(operation); const nativeMs = performance.now() - nativeStarted;
      const checked = verify(operation, native, remote);
      const operationEvidence = { id: operation.id, index, kind: operation.kind, shard: operation.shard,
        ...(operation.kind === 'solve' ? { depth: operation.depth } : {}), route: operation.route, input: JSON.parse(operation.body), nativeBaseline: native, nativeMs,
        remote: remote.operationResult, remoteMetrics: remote.operationResult.metrics ?? remote.operationResult.solveResponse?.metrics ?? null,
        heapBytes: remote.operationResult.metrics?.heapBytes ?? remote.operationResult.solveResponse?.metrics?.heapBytes ?? null,
        wasmElapsedMs: remote.operationResult.metrics?.solveMs ?? remote.operationResult.solveResponse?.metrics?.solveMs ?? null,
        orderedPingDelayMs: remote.operationResult.queueDelayMs ?? null, activationId: remote.operationResult.activationId,
        accounting: remote.accounting, accountingActivationId: remote.accountingActivationId, ...checked };
      state.recordCompletion({ operationId, response: remote.operationResult, activationId: remote.operationResult.activationId,
        accountingActivationId: remote.accountingActivationId,
        replayed: remote.replayed, evidence: operationEvidence, remoteAccounting: remote.accounting });
      evidence.operations.push(operationEvidence);
      evidence.candidateDifferences = deriveCandidateDifferences(evidence.operations);
      writeReportCheckpoint(resolve(runDir, 'evidence.json'), evidence);
    } catch (error) { state.recordFailure({ operationId, error: error.message }); throw error; }
  }
  writeReportCheckpoint(resolve(runDir, 'evidence.json'), evidence);
  const completionProjection = projectCompletionLedger({ operations, fixtures, physicalOperations: state.physicalOperations });
  const observed = reconcileObservedLedger(state.report.observed, state.physicalOperations);
  if (JSON.stringify(completionProjection) !== JSON.stringify(observed)) throw new Error('Completion projection does not reconcile to the durable physical-request ledger');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
