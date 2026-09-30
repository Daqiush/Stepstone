import { createHmac } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './remote-dds-soak-state.mjs';
import { writeReportCheckpoint } from './worker-dds-checkpoint.mjs';

export const CI_SCHEMA_VERSION = 1;
const CONTEXT_FIELDS = ['repository', 'workflow', 'runId', 'runAttempt', 'commitSha'];
const CORE_FIELDS = ['schemaVersion', 'kind', ...CONTEXT_FIELDS, 'workerName', 'ownershipTag'];
const PRE_FIELDS = [...CORE_FIELDS, 'noCollisionVerifiedAt'];
const DEPLOYMENT_FIELDS = ['schemaVersion', 'kind', 'identity', 'endpoint', 'deploymentManifestVersion', 'buildId', 'workerVersionId', 'wranglerVersion', 'assets', 'localConfigurationSha256', 'scriptETag', 'versionConfigurationSha256'];

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function exactFields(value, fields, label) {
  object(value, label);
  const actual = Object.keys(value).sort(); const expected = [...fields].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} has missing or unexpected fields`);
}
function equal(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} does not match`);
}
function nonempty(value, label) {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} must be a nonempty single-line string`);
  return value;
}
function hash(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 hash`);
  return value;
}
export function assertGithubContext(value) {
  object(value, 'GitHub context');
  const { repository, workflow, runId, runAttempt, commitSha } = value;
  if (typeof repository !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/')[1] === '.' || repository.split('/')[1] === '..') throw new Error('repository must be owner/repo');
  nonempty(workflow, 'workflow');
  for (const [field, input] of [['runId', runId], ['runAttempt', runAttempt]]) {
    if (typeof input !== 'string' || !/^[1-9][0-9]*$/.test(input)) throw new Error(`${field} must be a positive canonical decimal string`);
  }
  if (typeof commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(commitSha)) throw new Error('commitSha must be a lowercase 40-hex SHA');
  return { repository, workflow, runId, runAttempt, commitSha };
}
function secret(value) {
  if (typeof value !== 'string' || !value) throw new Error('A source secret is required');
  return value;
}
function ownershipDigest(value) {
  const c = assertGithubContext(value);
  return createHmac('sha256', secret(value.secret)).update(JSON.stringify(['stepstone:remote-dds:ownership:v1', ...CONTEXT_FIELDS.map((field) => c[field])]), 'utf8').digest();
}
function workerName(context, digest) {
  const name = `ss-dds-soak-gh-${context.runId}-${context.runAttempt}-${digest.toString('hex').slice(0, 12)}`;
  if (name.length > 63) throw new Error('Worker name exceeds 63 characters for runId/runAttempt');
  return name;
}
export function deriveRemoteTestKey(value) {
  const c = assertGithubContext(value);
  return createHmac('sha256', secret(value.secret)).update(JSON.stringify(['stepstone:remote-dds:test-key:v1', c.repository, c.runId, c.runAttempt]), 'utf8').digest('base64url');
}
export function deriveOwnershipAttestation(value) { return ownershipDigest(value).toString('base64url'); }
export function deriveCiIdentity(value) {
  const context = assertGithubContext(value); const digest = ownershipDigest(value);
  const name = workerName(context, digest);
  if (value.workerName !== undefined && value.workerName !== name) throw new Error('Artifact Worker name does not match derived identity');
  return { schemaVersion: CI_SCHEMA_VERSION, kind: 'remote-dds-ci-identity', ...context, workerName: name, ownershipTag: digest.toString('base64url') };
}
function assertIdentityCore(value, kind, fields) {
  exactFields(value, fields, 'CI identity');
  if (value.schemaVersion !== CI_SCHEMA_VERSION || value.kind !== kind) throw new Error('Unsupported CI identity schema version or kind');
  const context = assertGithubContext(value);
  if (typeof value.ownershipTag !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.ownershipTag)) throw new Error('CI identity ownershipTag must be a 32-byte base64url digest');
  const digest = Buffer.from(value.ownershipTag, 'base64url');
  if (digest.length !== 32 || digest.toString('base64url') !== value.ownershipTag) throw new Error('CI identity ownershipTag is not canonical base64url');
  if (value.workerName !== workerName(context, digest)) throw new Error('CI identity Worker name does not match ownership attestation');
}
export function assertCiIdentity(value, { context } = {}) {
  assertIdentityCore(value, 'remote-dds-ci-identity', CORE_FIELDS);
  if (context) equal(assertGithubContext(value), assertGithubContext(context), 'CI identity GitHub context');
  return structuredClone(value);
}
function identityCore(predeployment) {
  const result = Object.fromEntries(CORE_FIELDS.map((field) => [field, predeployment[field]]));
  result.kind = 'remote-dds-ci-identity';
  return result;
}
export function createPreDeploymentIdentity({ identity, noCollisionVerifiedAt }) {
  return assertPreDeploymentIdentity({ ...assertCiIdentity(identity), kind: 'remote-dds-predeployment-identity', noCollisionVerifiedAt });
}
export function assertPreDeploymentIdentity(value, { trustedIdentity, context } = {}) {
  assertIdentityCore(value, 'remote-dds-predeployment-identity', PRE_FIELDS);
  const timestamp = value.noCollisionVerifiedAt;
  if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) throw new Error('noCollisionVerifiedAt must be a canonical valid ISO timestamp');
  if (context) equal(assertGithubContext(value), assertGithubContext(context), 'Predeployment identity GitHub context');
  if (trustedIdentity) equal(identityCore(value), assertCiIdentity(trustedIdentity, { context }), 'Predeployment identity trusted ownership');
  return structuredClone(value);
}
function assertEndpoint(value, name) {
  let url; try { url = new URL(value); } catch { throw new Error('Deployment endpoint must be an exact HTTPS workers.dev root'); }
  const host = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.workers\\.dev$`);
  if (typeof value !== 'string' || url.protocol !== 'https:' || !host.test(url.hostname) || url.pathname !== '/' || url.search || url.hash || url.username || url.password || url.port || url.toString().slice(0, -1) !== value) throw new Error('Deployment endpoint must be the exact generated Worker HTTPS workers.dev root');
  return value;
}
function asset(value, path) {
  exactFields(value, ['path', 'bytes', 'sha256'], 'Deployment manifest asset');
  if (value.path !== path || !Number.isSafeInteger(value.bytes) || value.bytes < 0) throw new Error('Deployment manifest asset path or bytes is invalid');
  return hash(value.sha256, 'Deployment manifest asset hash');
}
function manifestSnapshot(value, identity) {
  object(value, 'Deployment manifest');
  if (value.version !== 1) throw new Error('Unsupported deployment manifest version');
  const verified = object(value.verifiedDeployment, 'Verified deployment');
  if (verified.apiVerified !== true || verified.temporaryWorkerName !== identity.workerName || verified.versionId !== value.workerVersionId) throw new Error('Deployment manifest does not bind the identity and Worker version');
  const wasmSha256 = asset(value.assets?.wasm, 'workers/vendor/bridge-dds/dds-worker.wasm');
  const harness = object(value.assets?.harness, 'Deployment manifest harness');
  const keys = Object.keys(harness);
  if (!keys.length || keys.some((path) => !/^workers\/src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.mjs$/.test(path))) throw new Error('Deployment manifest harness paths are invalid');
  return { deploymentManifestVersion: value.version, buildId: hash(value.buildId, 'Deployment manifest build ID'), workerVersionId: nonempty(value.workerVersionId, 'Deployment Worker version'), wranglerVersion: nonempty(verified.wranglerVersion, 'Deployment Wrangler version'),
    assets: { wasmSha256, harnessSha256: Object.fromEntries(keys.map((path) => [path, asset(harness[path], path)])) } };
}
export function createDeploymentRecord({ identity, endpoint, deploymentManifest, localConfigurationSha256, scriptETag, versionConfigurationSha256 }) {
  const predeployment = assertPreDeploymentIdentity(identity);
  return assertDeploymentRecord({ schemaVersion: CI_SCHEMA_VERSION, kind: 'remote-dds-deployment-record', identity: predeployment, endpoint, ...manifestSnapshot(deploymentManifest, predeployment), localConfigurationSha256, scriptETag, versionConfigurationSha256 }, { identity: predeployment, deploymentManifest });
}
export function assertDeploymentRecord(value, { identity, trustedIdentity, context, deploymentManifest } = {}) {
  exactFields(value, DEPLOYMENT_FIELDS, 'Deployment record');
  if (value.schemaVersion !== CI_SCHEMA_VERSION || value.kind !== 'remote-dds-deployment-record' || value.deploymentManifestVersion !== 1) throw new Error('Unsupported deployment record schema version or kind');
  const predeployment = assertPreDeploymentIdentity(value.identity, { trustedIdentity, context });
  if (identity) equal(predeployment, assertPreDeploymentIdentity(identity, { trustedIdentity, context }), 'Deployment record identity');
  assertEndpoint(value.endpoint, predeployment.workerName);
  hash(value.buildId, 'Deployment build ID'); nonempty(value.workerVersionId, 'Deployment Worker version'); nonempty(value.wranglerVersion, 'Deployment Wrangler version');
  exactFields(value.assets, ['wasmSha256', 'harnessSha256'], 'Deployment assets');
  hash(value.assets.wasmSha256, 'Deployment Wasm hash');
  const harness = object(value.assets.harnessSha256, 'Deployment harness hashes');
  if (!Object.keys(harness).length) throw new Error('Deployment harness hashes must be complete');
  for (const [path, digest] of Object.entries(harness)) {
    if (!/^workers\/src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.mjs$/.test(path)) throw new Error('Deployment harness path is invalid');
    hash(digest, 'Deployment harness hash');
  }
  hash(value.localConfigurationSha256, 'localConfigurationSha256'); nonempty(value.scriptETag, 'scriptETag'); hash(value.versionConfigurationSha256, 'versionConfigurationSha256');
  if (deploymentManifest) {
    const expected = manifestSnapshot(deploymentManifest, predeployment);
    for (const field of Object.keys(expected)) equal(value[field], expected[field], `Deployment manifest ${field}`);
  }
  return structuredClone(value);
}
export function bindCiArtifacts({ trustedIdentity, identity, deployment, context }) {
  // Trust the freshly derived job identity only after checking explicit GitHub context.
  const trusted = assertCiIdentity(trustedIdentity, { context: assertGithubContext(context) });
  const predeployment = assertPreDeploymentIdentity(identity, { trustedIdentity: trusted, context });
  const record = assertDeploymentRecord(deployment, { identity: predeployment, trustedIdentity: trusted, context });
  return { identity: predeployment, deployment: record };
}

function parseCli(args) {
  const values = new Map();
  const allowed = new Set(['--derive', '--repository', '--workflow', '--run-id', '--run-attempt', '--commit-sha', '--github-env', '--identity-out']);
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!allowed.has(key)) throw new Error('Unknown identity CLI argument');
    if (values.has(key)) throw new Error('Duplicate identity CLI argument');
    if (key === '--derive') { values.set(key, true); continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('Missing identity CLI argument value');
    values.set(key, value);
  }
  for (const key of allowed) if (key !== '--identity-out' && !values.has(key)) throw new Error(`Missing required identity CLI argument: ${key}`);
  return values;
}
function runCli() {
  const args = parseCli(process.argv.slice(2));
  const input = { repository: args.get('--repository'), workflow: args.get('--workflow'), runId: args.get('--run-id'), runAttempt: args.get('--run-attempt'), commitSha: args.get('--commit-sha'), secret: process.env.CLOUDFLARE_API_TOKEN };
  const identity = deriveCiIdentity(input); const key = deriveRemoteTestKey(input);
  const envFile = resolve(args.get('--github-env')); const out = args.has('--identity-out') ? resolve(args.get('--identity-out')) : null;
  if (out === envFile) throw new Error('Identity output and GitHub environment must be separate files');
  const existing = existsSync(envFile) ? readFileSync(envFile) : Buffer.alloc(0);
  const separator = existing.length && existing.at(-1) !== 10 ? '\n' : '';
  process.stdout.write(`::add-mask::${key}\n`);
  appendFileSync(envFile, `${separator}DDS_REMOTE_TEST_KEY=${key}\n`, 'utf8');
  if (out) writeReportCheckpoint(out, identity);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCli(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
