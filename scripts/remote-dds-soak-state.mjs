import { appendFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { syncParentDirectory, writeReportCheckpoint } from './worker-dds-checkpoint.mjs';
import { canonicalHarnessRequest } from '../workers/src/remote-test-canonical.mjs';

export const SOAK_SEED = 20260923;
export const ACCOUNTING_SCHEMA_VERSION = 6;
export const JOURNAL_SCHEMA_VERSION = 6;
export const ACCOUNTING_LIMITS = Object.freeze({ workerInbound: 25000, queuedDoCommands: 50000, sqliteRows: Object.freeze({ reads: 25000, writes: 25000 }) });
const JOURNAL = 'journal.jsonl';
const MANIFEST = 'manifest.json';
const REPORT = 'report.json';
const ACTIVATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function canonicalJson(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item) ?? 'null').join(',')}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sha256Utf8(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
// `body` is the exact UTF-8 text passed to fetch. Do not parse/re-serialize it:
// remote authorization hashes the literal request body text.
export function canonicalRequest(route, body) { return canonicalHarnessRequest(route, body); }
export function requestHash(route, body) { return sha256Utf8(canonicalRequest(route, body)); }

function hashFile(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function defaultPaths(root) {
  return {
    randomGeneratorFile: resolve(root, 'scripts/worker-dds-random-cases.mjs'),
    fixtureCorpusFile: resolve(root, 'workers/test/fixtures/dds-parity.json'),
    simulatorFile: resolve(root, 'scripts/simulate-worker-room-budget.mjs'),
  };
}

export function createRunManifest({ root = resolve(import.meta.dirname, '..'), randomGeneratorFile, fixtureCorpusFile, runId = 'unbound-run' } = {}) {
  if (typeof runId !== 'string' || !runId) throw new Error('runId is required');
  const defaults = defaultPaths(root);
  const paths = {
    randomGeneratorFile: randomGeneratorFile ?? defaults.randomGeneratorFile,
    fixtureCorpusFile: fixtureCorpusFile ?? defaults.fixtureCorpusFile,
  };
  return {
    version: JOURNAL_SCHEMA_VERSION, runId,
    seed: SOAK_SEED,
    randomGenerator: 'xorshift32',
    hashes: { randomGenerator: hashFile(paths.randomGeneratorFile), fixtureCorpus: hashFile(paths.fixtureCorpusFile), simulator: hashFile(paths.simulatorFile ?? defaults.simulatorFile) },
    shards: Array.from({ length: 11 }, (_, shard) => ({ shard, startIndex: shard * 2000, endIndex: shard * 2000 + 1999 })),
    accountingSchemaVersion: ACCOUNTING_SCHEMA_VERSION,
    journalSchemaVersion: JOURNAL_SCHEMA_VERSION,
  };
}

function equalCanonical(left, right) { return canonicalJson(left) === canonicalJson(right); }
function file(dir, name) { return join(dir, name); }
function appendDurable(path, record) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  const fd = openSync(path, 'a');
  try { appendFileSync(fd, `${canonicalJson(record)}\n`, 'utf8'); fsyncSync(fd); }
  finally { closeSync(fd); }
  syncParentDirectory(resolve(path, '..'));
}
function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Invalid ${label}: ${error.message}`); }
}
function readJournal(dir) {
  const path = file(dir, JOURNAL);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  if (!text) return [];
  return text.split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Invalid journal JSON at line ${index + 1}`); }
  });
}
function zeroAccounting() { return { workerInbound: 0, doFetchArrivals: 0, queuedDoCommands: 0, sqliteRows: { reads: 0, writes: 0 } }; }
function addAccounting(total, delta) {
  const next = { ...total };
  for (const key of ['workerInbound', 'doFetchArrivals', 'queuedDoCommands']) {
    if (!Number.isSafeInteger(delta?.[key]) || delta[key] < 0) throw new Error(`Invalid observed accounting ${key}`);
    next[key] += delta[key];
  }
  for (const key of ['reads', 'writes']) {
    if (!Number.isSafeInteger(delta?.sqliteRows?.[key]) || delta.sqliteRows[key] < 0) throw new Error(`Invalid observed accounting sqliteRows.${key}`);
    next.sqliteRows[key] += delta.sqliteRows[key];
  }
  return next;
}
export function actualRequestAccounting({ route, replayed }) {
  if (typeof replayed !== 'boolean') throw new Error('Remote replay decision is required for actual accounting');
  const queued = replayed ? 0 : route === '/__dds/ordered-probe' ? 2
    : route === '/__dds/table' || route === '/__dds/solve' ? 1
      : route === '/__dds/metrics' || route === '/__dds/ping' ? 0 : null;
  if (queued === null) throw new Error(`Unsupported remote accounting route: ${route}`);
  return { workerInbound: 1, doFetchArrivals: 1, queuedDoCommands: queued,
    sqliteRows: { reads: 1, writes: replayed ? 0 : 1 } };
}

export function ledgerAccounting(physicalOperations) {
  if (!Array.isArray(physicalOperations)) throw new Error('Physical request ledger is required');
  return physicalOperations.reduce((total, record) => addAccounting(total, actualRequestAccounting(record)), zeroAccounting());
}
function sameAccounting(left, right) { return canonicalJson(left) === canonicalJson(right); }
function assertRemoteSnapshot(snapshot) {
  const checked = addAccounting(zeroAccounting(), snapshot);
  return checked;
}

export function assertAccountingWithinLimits(accounting) {
  for (const [key, limit] of Object.entries(ACCOUNTING_LIMITS)) {
    if (key === 'sqliteRows') continue;
    if (!Number.isSafeInteger(accounting?.[key]) || accounting[key] > limit) throw new Error(`${key} exceeds remote soak limit ${limit}`);
  }
  if (!Number.isSafeInteger(accounting?.doFetchArrivals) || accounting.doFetchArrivals < 0) throw new Error('Invalid doFetchArrivals');
  for (const [key, limit] of Object.entries(ACCOUNTING_LIMITS.sqliteRows)) {
    if (!Number.isSafeInteger(accounting?.sqliteRows?.[key]) || accounting.sqliteRows[key] < 0 || accounting.sqliteRows[key] > limit) {
      throw new Error(`sqliteRows.${key} exceeds remote soak limit ${limit}`);
    }
  }
  return accounting;
}

// Random work is 220 table commands plus 21,780 solves, each with ordered probe.
// Auxiliary entries each consume one Worker/DO arrival; only fixture work and
// metric probes are commands. Replays deliberately add physical accounting only.
export function projectAccounting({ fixtureTables = 0, fixtureSolves = 0, coldStarts = 0, metricProbes = 0, pendingReplays = 0, closeSmokeProbes = 0, fixtures } = {}) {
  // Legacy `fixtures` is conservatively treated as ordered solves.
  if (fixtures !== undefined) fixtureSolves += fixtures;
  for (const [key, value] of Object.entries({ fixtureTables, fixtureSolves, coldStarts, metricProbes, pendingReplays, closeSmokeProbes })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid projection ${key}`);
  }
  const auxiliary = fixtureTables + fixtureSolves + coldStarts + metricProbes + pendingReplays + closeSmokeProbes;
  const workerInbound = 22000 + auxiliary;
  return {
    workerInbound,
    doFetchArrivals: workerInbound,
    queuedDoCommands: 43780 + fixtureTables + fixtureSolves * 2 + closeSmokeProbes,
    sqliteRows: {
      reads: 22000 + auxiliary,
      writes: 22000 + fixtureTables + fixtureSolves + coldStarts + metricProbes + closeSmokeProbes,
    },
  };
}

function validateManifest(manifest, expected) {
  if (manifest?.accountingSchemaVersion !== ACCOUNTING_SCHEMA_VERSION || manifest?.journalSchemaVersion !== JOURNAL_SCHEMA_VERSION) {
    throw new Error('Unsupported remote soak journal/accounting schema version; start a new run');
  }
  if (!equalCanonical(manifest, expected)) throw new Error('Run manifest hash or deterministic configuration changed');
}
function validateIntent(record, cursor, requestForIndex, runId) {
  if (record.runId !== runId) throw new Error('Journal intent run identity changed');
  if (!Number.isSafeInteger(record.index) || record.index !== cursor || typeof record.operationId !== 'string' || !record.operationId) throw new Error('Journal intent is non-contiguous or invalid');
  const generated = requestForIndex(record.index);
  const canonical = canonicalRequest(generated.route, generated.body);
  if (record.route !== generated.route || record.requestHash !== sha256Utf8(canonical) || record.canonicalRequest !== canonical) {
    throw new Error('Deterministic request changed from persisted intent');
  }
}

function replayJournal(records, requestForIndex, runId) {
  let cursor = 0, pending = null, terminalFailure = null, activationIds = {}, observed = zeroAccounting(); const evidence = [], fixtureEvidence = [], physicalOperations = [], perShard = new Map(), auxiliaryIntents = new Map(); let preflightEvidence = null;
  const operationIds = new Set();
  for (const record of records) {
    if (record.type === 'intent') {
      if (pending || terminalFailure) throw new Error('Journal contains duplicate or post-terminal intent');
      if (operationIds.has(record.operationId)) throw new Error('Journal contains duplicate operation ID');
      validateIntent(record, cursor, requestForIndex, runId); pending = record;
      operationIds.add(record.operationId);
    } else if (record.type === 'auxiliary-intent') {
      if (record.runId !== runId || typeof record.operationId !== 'string' || !record.operationId || typeof record.route !== 'string' || !record.route || typeof record.canonicalRequest !== 'string' || !/^[a-f0-9]{64}$/.test(record.requestHash ?? '')) throw new Error('Journal auxiliary intent is invalid');
      if (auxiliaryIntents.has(record.operationId)) throw new Error('Journal contains duplicate auxiliary operation ID');
      auxiliaryIntents.set(record.operationId, record);
    } else if (record.type === 'physical') {
      if (typeof record.operationId !== 'string' || !record.operationId || typeof record.physicalId !== 'string' || !record.physicalId) throw new Error('Journal physical request is invalid');
      if (record.response === undefined || record.responseHash !== sha256Utf8(canonicalJson(record.response))) throw new Error('Journal physical response is missing or hash-divergent');
      if (record.evidence !== undefined && record.evidenceHash !== sha256Utf8(canonicalJson(record.evidence))) throw new Error('Journal physical evidence is hash-divergent');
      const delta = actualRequestAccounting(record);
      observed = addAccounting(observed, delta); assertAccountingWithinLimits(observed);
      const shard = String(record.shard ?? '0');
      const shardObserved = addAccounting(perShard.get(shard) ?? zeroAccounting(), delta);
      perShard.set(shard, shardObserved);
      if (record.remoteAccounting !== undefined && !sameAccounting(assertRemoteSnapshot(record.remoteAccounting), shardObserved)) {
        throw new Error('Remote accounting snapshot does not reconcile to the durable physical-request ledger');
      }
      physicalOperations.push(record);
      if (record.evidence !== undefined) {
        if (record.evidenceKind === 'fixture') fixtureEvidence.push(record.evidence);
        else if (record.evidenceKind === 'preflight') {
          if (preflightEvidence !== null) throw new Error('Journal contains duplicate preflight evidence');
          preflightEvidence = record.evidence;
        }
        else evidence.push(record.evidence);
      }
    } else if (record.type === 'completion') {
      if (!pending || record.operationId !== pending.operationId || record.index !== pending.index || !/^[a-f0-9]{64}$/.test(record.responseHash ?? '')) throw new Error('Journal completion is invalid or duplicate');
      const shard = Math.floor(pending.index / 2000);
      if (typeof record.activationId !== 'string' || !ACTIVATION_ID.test(record.activationId) || (activationIds[shard] && activationIds[shard] !== record.activationId)) throw new Error('Activation ID missing, invalid, or changed inside a shard');
      activationIds[shard] = record.activationId;
      if (record.evidence !== undefined) evidence.push(record.evidence);
      cursor += 1; pending = null;
    } else if (record.type === 'failed') {
      if (!pending || record.operationId !== pending.operationId || record.index !== pending.index || typeof record.error !== 'string') throw new Error('Journal failure is invalid');
      terminalFailure = record; pending = null;
    } else throw new Error('Journal record type is invalid');
  }
  return { cursor, pending, terminalFailure, activationIds, operationIds, observed, evidence, fixtureEvidence, preflightEvidence, physicalOperations, auxiliaryIntents };
}

function makeReport(snapshot) {
  return { version: 1, completedCursor: snapshot.cursor, observed: snapshot.observed, activationIds: snapshot.activationIds, terminalFailure: snapshot.terminalFailure ?? null };
}

export function createSoakState({ dir, root, requestForIndex, projection = projectAccounting(), runId = 'unbound-run' }) {
  if (typeof requestForIndex !== 'function') throw new Error('requestForIndex is required');
  assertAccountingWithinLimits(projection);
  mkdirSync(dir, { recursive: true });
  const manifest = createRunManifest({ root, runId });
  if (existsSync(file(dir, MANIFEST))) throw new Error('Soak state already exists; use recoverSoakState');
  writeReportCheckpoint(file(dir, MANIFEST), manifest);
  const state = { cursor: 0, pending: null, terminalFailure: null, activationIds: {}, operationIds: new Set(), observed: zeroAccounting(), physicalOperations: [], auxiliaryIntents: new Map() };
  const api = buildStateApi({ dir, requestForIndex, manifest, state, projection });
  writeReportCheckpoint(file(dir, REPORT), api.report);
  return api;
}

function buildStateApi({ dir, requestForIndex, manifest, state, projection }) {
  const saveReport = () => { api.report = makeReport(state); writeReportCheckpoint(file(dir, REPORT), api.report); };
  const requirePending = (operationId) => {
    if (!state.pending) throw new Error('No pending intent');
    if (state.pending.operationId !== operationId) throw new Error('Operation ID does not match pending intent');
  };
  const recordPhysical = ({ operationId, route, replayed, response, shard = 0, remoteAccounting, evidence, evidenceHash = evidence === undefined ? undefined : sha256Utf8(canonicalJson(evidence)), evidenceKind, recovered = false }) => {
    const delta = actualRequestAccounting({ route, replayed });
    const physical = { type: 'physical', physicalId: `request.${String(state.physicalOperations.length).padStart(8, '0')}`,
      operationId, route, replayed, shard: String(shard), response, responseHash: sha256Utf8(canonicalJson(response)), evidenceHash, remoteAccounting, evidence, evidenceKind, recovered };
    const nextObserved = addAccounting(state.observed, delta); assertAccountingWithinLimits(nextObserved);
    const shardOperations = state.physicalOperations.filter((item) => String(item.shard ?? '0') === physical.shard).concat(physical);
    if (remoteAccounting !== undefined && !sameAccounting(assertRemoteSnapshot(remoteAccounting), ledgerAccounting(shardOperations))) {
      throw new Error('Remote accounting snapshot does not reconcile to the durable physical-request ledger');
    }
    appendDurable(file(dir, JOURNAL), physical);
    state.observed = nextObserved; state.physicalOperations.push(physical);
    return physical;
  };
  const recoverOriginalExecution = ({ operationId, route, response, shard }) => {
    const original = actualRequestAccounting({ route, replayed: false });
    if (!sameAccounting(response?.executionAccounting, original)) throw new Error('Replay is missing the persisted original execution accounting');
    recordPhysical({ operationId, route, replayed: false, response, shard, recovered: true });
  };
  const finish = ({ operationId, response, activationId, replayed = false, evidence, remoteAccounting }) => {
    requirePending(operationId);
    const shard = Math.floor(state.pending.index / 2000);
    if (typeof activationId !== 'string' || !ACTIVATION_ID.test(activationId) || (state.activationIds[shard] && state.activationIds[shard] !== activationId)) throw new Error('Activation ID missing, invalid, or changed after replay');
    const responseHash = sha256Utf8(canonicalJson(response));
    const previousPhysical = state.physicalOperations.some((record) => record.operationId === operationId);
    if (replayed && !previousPhysical) {
      recoverOriginalExecution({ operationId, route: state.pending.route, response, shard });
    }
    recordPhysical({ operationId, route: state.pending.route, replayed, response, shard, remoteAccounting, evidenceHash: evidence === undefined ? undefined : sha256Utf8(canonicalJson(evidence)) });
    appendDurable(file(dir, JOURNAL), { type: 'completion', index: state.pending.index, operationId, responseHash, activationId, evidence });
    state.cursor += 1; state.pending = null; state.activationIds[shard] = activationId;
    saveReport();
  };
  const api = {
    manifest,
    report: makeReport(state),
    recordIntent({ index, operationId, route, body }) {
      // This is deliberately immediately before durable intent/dispatch: callers
      // provide the whole-run projection, including fixtures, probes and replays.
      assertAccountingWithinLimits(projection);
      if (state.pending || state.terminalFailure) throw new Error('Cannot dispatch while pending or terminally failed');
      if (state.operationIds.has(operationId)) throw new Error('Operation ID must be globally unique and monotonic');
      const record = { type: 'intent', runId: manifest.runId, index, operationId, route, requestHash: requestHash(route, body), canonicalRequest: canonicalRequest(route, body) };
      validateIntent(record, state.cursor, requestForIndex, manifest.runId);
      appendDurable(file(dir, JOURNAL), record); state.pending = record; state.operationIds.add(operationId); return record;
    },
    recordCompletion: finish,
    completeReplay: finish,
    recordAuxiliaryIntent({ operationId, route, body, shard = 0 }) {
      const canonical = canonicalRequest(route, body);
      const existing = state.auxiliaryIntents.get(operationId);
      if (existing) {
        if (existing.route !== route || existing.canonicalRequest !== canonical || existing.shard !== String(shard)) throw new Error('Auxiliary intent changed during recovery');
        return existing;
      }
      const record = { type: 'auxiliary-intent', runId: manifest.runId, operationId, route, shard: String(shard),
        requestHash: sha256Utf8(canonical), canonicalRequest: canonical };
      appendDurable(file(dir, JOURNAL), record); state.auxiliaryIntents.set(operationId, record); return record;
    },
    recordAuxiliaryResponse({ operationId, route, replayed = false, response, evidence, evidenceKind = 'auxiliary', remoteAccounting, shard = 0 }) {
      const intent = state.auxiliaryIntents.get(operationId);
      if (!intent || intent.route !== route || intent.shard !== String(shard)) throw new Error('Auxiliary response has no matching durable intent');
      if (state.physicalOperations.some((record) => record.operationId === operationId)) throw new Error('Physical operation was already recorded');
      if (replayed) recoverOriginalExecution({ operationId, route, response, shard });
      recordPhysical({ operationId, route, replayed, response, evidence, evidenceKind, remoteAccounting, shard });
      saveReport();
    },
    recordFailure({ operationId, error }) {
      requirePending(operationId);
      if (typeof error !== 'string' || !error) throw new Error('Failure error is required');
      appendDurable(file(dir, JOURNAL), { type: 'failed', index: state.pending.index, operationId, error });
      state.terminalFailure = { type: 'failed', index: state.pending.index, operationId, error }; state.pending = null; saveReport();
    },
    get physicalOperations() { return state.physicalOperations; },
    hasPhysicalOperation(operationId) { return state.physicalOperations.some((record) => record.operationId === operationId); },
    hasAuxiliaryIntent(operationId) { return state.auxiliaryIntents.has(operationId); },
  };
  return api;
}

export function recoverSoakState({ dir, root, requestForIndex, projection = projectAccounting() }) {
  if (typeof requestForIndex !== 'function') throw new Error('requestForIndex is required');
  assertAccountingWithinLimits(projection);
  const manifest = readJson(file(dir, MANIFEST), 'manifest');
  validateManifest(manifest, createRunManifest({ root, runId: manifest.runId }));
  const state = replayJournal(readJournal(dir), requestForIndex, manifest.runId);
  const api = buildStateApi({ dir, requestForIndex, manifest, state, projection });
  // A journal is authoritative. Replacing a stale or torn checkpoint is safe.
  writeReportCheckpoint(file(dir, REPORT), api.report);
  api.recovery = state.terminalFailure ? { kind: 'failed', failure: state.terminalFailure }
    : state.pending ? { kind: 'replay-pending', intent: state.pending } : { kind: 'ready' };
  api.evidence = state.evidence;
  api.fixtureEvidence = state.fixtureEvidence;
  api.preflightEvidence = state.preflightEvidence;
  return api;
}
