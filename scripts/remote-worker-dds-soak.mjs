import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createRandomCaseGenerator } from './worker-dds-random-cases.mjs';
import { compareDdsResults, normalizeDdsResult, validateWorkerSolveCandidates } from './worker-dds-benchmark-validation.mjs';
import { createSoakState, recoverSoakState, projectAccounting, requestHash, SOAK_SEED } from './remote-dds-soak-state.mjs';
import { assertDeploymentManifest } from './prepare-remote-dds-deployment.mjs';
import { writeReportCheckpoint } from './worker-dds-checkpoint.mjs';

const require = createRequire(import.meta.url);
const { calcDDTable, solveBoard } = require('../dds-wrapper.js');
export const OPERATION_COUNT = 22000;
export const SHARD_COUNT = 11;
export const DEPTH_COUNT = 13;
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
async function remotePost(endpoint, args) {
  const response = await fetch(`${endpoint}${args.route}`, { method: 'POST', headers: stableHeaders(args), body: args.body, signal: AbortSignal.timeout(60000) });
  let payload; try { payload = await response.json(); } catch { throw new Error(`Malformed remote JSON: ${args.route} status ${response.status}`); }
  if (!response.ok || payload?.operationResult?.ok !== true || !payload.accounting) throw new Error(`Remote operation failed: ${args.route} status ${response.status}`);
  return payload;
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
async function runFixtureChecks({ endpoint, key, runId, fixtures, buildId, evidence }) {
  for (const [index, item] of fixtures.entries()) {
    const kind = item.kind, route = kind === 'table' ? '/__dds/table' : '/__dds/ordered-probe';
    const body = JSON.stringify(kind === 'table' ? { hands: item.hands } : { deal: item.deal ?? { trump: item.trump, trickLeader: item.trickLeader, trickPlayed: item.trickPlayed, hands: item.hands } });
    const remote = await remotePost(endpoint, { key, runId, operationId: `fixture.${String(index).padStart(6, '0')}`, route, body, shard: 0 });
    const op = { kind, id: item.id, item: kind === 'table' ? { hands: item.hands } : { deal: JSON.parse(body).deal } };
    const worker = unwrap(op, remote); const expected = item.expected?.table ?? item.expected;
    if (JSON.stringify(normalizeDdsResult(kind, worker)) !== JSON.stringify(normalizeDdsResult(kind, expected))) throw new Error(`Fixture parity mismatch: ${item.id}`);
    if (index === 0 && remote.operationResult.buildId !== undefined) assertEndpointBuild(remote.operationResult, buildId);
    evidence.fixtures.push({ id: item.id, route, accounting: remote.accounting });
  }
}
function option(name, fallback) { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1]; }
async function runCli() {
  const endpoint = assertRemoteEndpoint(option('--url', ''));
  const key = process.env.DDS_REMOTE_TEST_KEY;
  if (!key) throw new Error('DDS_REMOTE_TEST_KEY is required');
  const runDir = assertRunDirectory(resolve(ROOT, option('--run-dir', 'workers/test/results/remote-soak')), process.argv.includes('--resume'));
  const manifestPath = resolve(ROOT, option('--deployment-manifest', 'workers/test/results/remote-dds-deployment.json'));
  const deployment = assertDeploymentManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), { root: ROOT });
  const operations = createSeededOperations(); const coverage = validateCoverage(operations);
  const fixtures = JSON.parse(readFileSync(resolve(ROOT, 'workers/test/fixtures/dds-parity.json'), 'utf8'));
  const runId = `soak-${deployment.buildId.slice(0, 16)}`;
  const projection = projectAccounting({ fixtures: fixtures.length, metricProbes: 1, pendingReplays: 1 });
  const requestForIndex = (index) => operations[index];
  const resume = process.argv.includes('--resume');
  const state = resume ? recoverSoakState({ dir: runDir, root: ROOT, requestForIndex, projection }) : createSoakState({ dir: runDir, root: ROOT, requestForIndex, projection });
  const evidence = { version: 1, endpoint, runId, buildId: deployment.buildId, projection, coverage, fixtures: [], operations: [], candidateDifferences: [] };
  // The deployed Worker must explicitly identify the exact manifest being run.
  // This request is budgeted before any fixture or generated DDS dispatch.
  const preflightBody = '{}';
  const preflight = await remotePost(endpoint, { key, runId, operationId: 'preflight.build', route: '/__dds/ping', body: preflightBody, shard: 0 });
  assertEndpointBuild(preflight, deployment.buildId);
  evidence.preflight = { accounting: preflight.accounting, activationId: preflight.operationResult.activationId };
  if (!resume || state.report.completedCursor === 0) await runFixtureChecks({ endpoint, key, runId, fixtures, buildId: deployment.buildId, evidence });
  const dispatch = async (operation, operationId) => remotePost(endpoint, { key, runId, operationId, route: operation.route, body: operation.body, shard: operation.shard });
  if (state.recovery?.kind === 'replay-pending') {
    const pending = state.recovery.intent, operation = operations[pending.index];
    const remote = await dispatch(operation, pending.operationId); const native = await baseline(operation); const checked = verify(operation, native, remote);
    state.completeReplay({ operationId: pending.operationId, response: remote.operationResult, activationId: remote.operationResult.activationId, observed: remote.accounting });
    evidence.operations.push({ id: operation.id, replay: true, ...checked });
  }
  for (let index = state.report.completedCursor; index < operations.length; index++) {
    const operation = operations[index], operationId = `op.${String(index).padStart(6, '0')}`;
    state.recordIntent({ index, operationId, route: operation.route, body: operation.body });
    try {
      const remote = await dispatch(operation, operationId); const nativeStarted = performance.now(); const native = await baseline(operation); const nativeMs = performance.now() - nativeStarted;
      const checked = verify(operation, native, remote);
      state.recordCompletion({ operationId, response: remote.operationResult, activationId: remote.operationResult.activationId, observed: remote.accounting });
      evidence.operations.push({ id: operation.id, index, route: operation.route, nativeMs, activationId: remote.operationResult.activationId, accounting: remote.accounting, ...checked });
      if (checked.candidateDifference) evidence.candidateDifferences.push({ id: operation.id, ...checked.candidateDifference });
      if ((index + 1) % 100 === 0) writeReportCheckpoint(resolve(runDir, 'evidence.json'), evidence);
    } catch (error) { state.recordFailure({ operationId, error: error.message }); throw error; }
  }
  writeReportCheckpoint(resolve(runDir, 'evidence.json'), evidence);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
