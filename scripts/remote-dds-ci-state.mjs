import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './remote-dds-soak-state.mjs';
import { writeReportCheckpoint } from './worker-dds-checkpoint.mjs';
import { CI_SCHEMA_VERSION, assertGithubContext, assertCiIdentity, assertPreDeploymentIdentity, assertDeploymentRecord, bindCiArtifacts } from './remote-dds-ci-identity.mjs';

export const CI_RUN_FILES = Object.freeze(['manifest.json', 'journal.jsonl', 'report.json', 'evidence.json', 'segment-result.json']);
const STATE_FIELDS = ['schemaVersion', 'kind', 'segment', 'disposition', 'identity', 'deployment', 'files'];
const DISPOSITIONS = ['PAUSED', 'COMPLETE', 'FAILED'];
const STATE_FILE = 'state-manifest.json';
function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...fields].sort())) throw new Error(`${label} has missing or unexpected fields`);
}
function equal(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} does not match`);
}
function segmentNumber(segment) {
  if (!Number.isInteger(segment) || segment < 1 || segment > 6) throw new Error('segment must be an integer from 1 to 6');
  return segment;
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function regularFile(path) {
  if (!lstatSync(path).isFile()) throw new Error('State input must be a regular file');
  return readFileSync(path);
}
function directory(path) {
  if (!lstatSync(path).isDirectory()) throw new Error('State input must be a regular directory');
}
function readJson(path, label) {
  const bytes = regularFile(path);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`Invalid ${label} JSON`); }
}
function parseSegmentResult(bytes) {
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid segment-result JSON'); }
  exactFields(value, ['version', 'disposition', 'reason', 'completedCursor', 'completedThisSegment', 'startedAt', 'finishedAt'], 'segment-result');
  if (value.version !== 1 || !DISPOSITIONS.includes(value.disposition)) throw new Error('Unsupported segment-result version or disposition');
  if (value.reason !== null && (typeof value.reason !== 'string' || !value.reason || /[\x00-\x1f\x7f]/.test(value.reason))) throw new Error('Invalid segment-result reason');
  for (const field of ['completedCursor', 'completedThisSegment']) if (!Number.isSafeInteger(value[field]) || value[field] < 0) throw new Error('Invalid segment-result cursor');
  for (const field of ['startedAt', 'finishedAt']) {
    if (typeof value[field] !== 'string' || !Number.isFinite(Date.parse(value[field])) || new Date(value[field]).toISOString() !== value[field]) throw new Error('Invalid segment-result timestamp');
  }
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt) || value.completedThisSegment > value.completedCursor) throw new Error('Invalid segment-result counters or chronology');
  return value;
}
export function assertStateManifest(value) {
  exactFields(value, STATE_FIELDS, 'State manifest');
  if (value.schemaVersion !== CI_SCHEMA_VERSION || value.kind !== 'remote-dds-ci-state') throw new Error('Unsupported state manifest schema version or kind');
  if (!Number.isInteger(value.segment) || value.segment < 0 || value.segment > 6) throw new Error('State manifest segment must be from 0 to 6');
  const identity = assertPreDeploymentIdentity(value.identity);
  assertDeploymentRecord(value.deployment, { identity });
  if (value.segment === 0) {
    if (value.disposition !== 'READY') throw new Error('State-0 disposition must be READY');
    exactFields(value.files, [], 'READY state files');
  } else {
    if (!DISPOSITIONS.includes(value.disposition)) throw new Error('Invalid state disposition');
    exactFields(value.files, CI_RUN_FILES.map((name) => `run/${name}`), 'State manifest files');
    for (const digest of Object.values(value.files)) if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('State manifest file hash must be SHA-256');
  }
  return structuredClone(value);
}
export function createStateManifest({ segment, disposition, identity, deployment, files }) {
  return assertStateManifest({ schemaVersion: CI_SCHEMA_VERSION, kind: 'remote-dds-ci-state', segment, disposition, identity, deployment, files });
}
export function createReadyState(inputs) {
  const bound = bindCiArtifacts(inputs);
  return createStateManifest({ segment: 0, disposition: 'READY', ...bound, files: {} });
}
function assertStateLayout(stateDir, manifest) {
  directory(stateDir);
  equal(readdirSync(stateDir).sort(), manifest.segment === 0 ? [STATE_FILE] : ['run', STATE_FILE].sort(), 'State directory layout');
  if (manifest.segment > 0) {
    const run = join(stateDir, 'run'); directory(run);
    equal(readdirSync(run).sort(), [...CI_RUN_FILES].sort(), 'State run directory layout');
  }
}
export function validateInputState({ stateDir, segment, ...inputs }) {
  const bound = bindCiArtifacts(inputs);
  segmentNumber(segment);
  const manifest = assertStateManifest(readJson(join(stateDir, STATE_FILE), 'state manifest'));
  if (manifest.segment !== segment - 1) throw new Error('State predecessor segment does not match the required lineage');
  equal(manifest.identity, bound.identity, 'State identity');
  equal(manifest.deployment, bound.deployment, 'State independent deployment');
  assertStateLayout(stateDir, manifest);
  for (const name of CI_RUN_FILES) {
    if (manifest.segment === 0) break;
    const digest = sha256(regularFile(join(stateDir, 'run', name)));
    if (digest !== manifest.files[`run/${name}`]) throw new Error(`State run file bytes hash mismatch: ${name}`);
  }
  if (manifest.segment > 0) {
    const result = parseSegmentResult(regularFile(join(stateDir, 'run', 'segment-result.json')));
    if (result.disposition !== manifest.disposition) throw new Error('State disposition does not match segment-result');
  }
  return manifest;
}
export function finalizeState({ stateDir, runDir, segment, ...inputs }) {
  const previous = validateInputState({ ...inputs, stateDir, segment });
  directory(runDir);
  const contents = new Map(CI_RUN_FILES.map((name) => [name, regularFile(join(runDir, name))]));
  const result = parseSegmentResult(contents.get('segment-result.json'));
  return createStateManifest({ segment, disposition: result.disposition, identity: previous.identity, deployment: previous.deployment,
    files: Object.fromEntries(CI_RUN_FILES.map((name) => [`run/${name}`, sha256(contents.get(name))])) });
}

function parseCli(args) {
  const modes = ['--create-ready', '--validate-input', '--finalize'];
  const common = ['--trusted-identity', '--identity', '--deployment', '--repository', '--workflow', '--run-id', '--run-attempt', '--commit-sha'];
  const modeFields = { '--create-ready': ['--out'], '--validate-input': ['--state', '--segment'], '--finalize': ['--state-in', '--run-dir', '--segment', '--out'] };
  const allowed = new Set([...modes, ...common, ...Object.values(modeFields).flat()]);
  const values = new Map();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!allowed.has(key)) throw new Error('Unknown state CLI argument');
    if (values.has(key)) throw new Error('Duplicate state CLI argument');
    if (modes.includes(key)) { values.set(key, true); continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('Missing state CLI argument value');
    values.set(key, value);
  }
  const selected = modes.filter((mode) => values.has(mode));
  if (selected.length !== 1) throw new Error('Exactly one state CLI mode is required');
  const mode = selected[0]; const required = new Set([mode, ...common, ...modeFields[mode]]);
  for (const key of values.keys()) if (!required.has(key)) throw new Error('State CLI modes cannot mix arguments');
  for (const key of required) if (!values.has(key)) throw new Error(`Missing required state CLI argument: ${key}`);
  if (values.has('--segment') && !/^[1-6]$/.test(values.get('--segment'))) throw new Error('segment must be from 1 to 6');
  return { mode, values };
}
function writeState(out, manifest, runDir) {
  const target = resolve(out);
  if (existsSync(target)) {
    directory(target);
    if (readdirSync(target).length) throw new Error('State output directory must be empty');
  }
  mkdirSync(target, { recursive: true });
  if (manifest.segment > 0) {
    const run = join(target, 'run'); mkdirSync(run);
    for (const name of CI_RUN_FILES) {
      copyFileSync(join(runDir, name), join(run, name));
      if (sha256(regularFile(join(run, name))) !== manifest.files[`run/${name}`]) throw new Error('Run file bytes changed while creating the state output');
    }
  }
  writeReportCheckpoint(join(target, STATE_FILE), manifest);
}
function runCli() {
  const { mode, values } = parseCli(process.argv.slice(2));
  const context = assertGithubContext({ repository: values.get('--repository'), workflow: values.get('--workflow'), runId: values.get('--run-id'), runAttempt: values.get('--run-attempt'), commitSha: values.get('--commit-sha') });
  // Artifact input is never authoritative for the current job's identity.
  const trustedIdentity = assertCiIdentity(readJson(resolve(values.get('--trusted-identity')), 'trusted identity'), { context });
  const identity = readJson(resolve(values.get('--identity')), 'predeployment identity');
  const deployment = readJson(resolve(values.get('--deployment')), 'deployment record');
  const inputs = { trustedIdentity, identity, deployment, context };
  bindCiArtifacts(inputs);
  let manifest;
  if (mode === '--create-ready') {
    manifest = createReadyState(inputs); writeState(values.get('--out'), manifest);
  } else if (mode === '--validate-input') {
    manifest = validateInputState({ ...inputs, stateDir: resolve(values.get('--state')), segment: Number(values.get('--segment')) });
  } else {
    const runDir = resolve(values.get('--run-dir'));
    manifest = finalizeState({ ...inputs, stateDir: resolve(values.get('--state-in')), runDir, segment: Number(values.get('--segment')) });
    writeState(values.get('--out'), manifest, runDir);
  }
  console.log(`State ${manifest.segment}: ${manifest.disposition}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCli(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
