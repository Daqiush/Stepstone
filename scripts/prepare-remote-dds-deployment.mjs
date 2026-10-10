import { createHash, randomUUID as systemRandomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { relative, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { canonicalJson, requestHash } from './remote-dds-soak-state.mjs';
import { writeReportCheckpoint } from './worker-dds-checkpoint.mjs';
import { deriveCiIdentity, assertGithubContext, assertCiIdentity, createPreDeploymentIdentity, assertPreDeploymentIdentity, createDeploymentRecord, assertDeploymentRecord } from './remote-dds-ci-identity.mjs';
import { readWorkerVersions, confirmExactAbsence, OwnershipRefusal, observeImmutableVersions, readOwnershipSnapshot, sameOwnershipSnapshot } from './cloudflare-temporary-worker-api.mjs';
import { cleanupRemoteDdsDeployment } from './cleanup-remote-dds-deployment.mjs';
import { diagnostic, publicDiagnosticCode, renderRemoteDdsFailure, renderRemoteDdsRollbackFailure } from './remote-dds-public-errors.mjs';
import { deadlineSignal, isTimeoutError, MANAGEMENT_API_TIMEOUT_MS, ENDPOINT_PROBE_TIMEOUT_MS } from './remote-dds-timeouts.mjs';

export const DEPLOYMENT_MANIFEST_VERSION = 2;
export const WASM_PATH = 'workers/vendor/bridge-dds/dds-worker.wasm';
export const TEMPORARY_WORKER_PREFIX = 'ss-dds-soak-';
const WRANGLER_CLI_PATH = resolve(import.meta.dirname, '../node_modules/wrangler/bin/wrangler.js');
const WRANGLER_OPERATION_TIMEOUT_MS = 120_000;
const WRANGLER_VERSION_TIMEOUT_MS = 15_000;
const WRANGLER_MAX_BUFFER = 4 * 1024 * 1024;
const ROLLBACK_FAILURES = new WeakMap();
export function harnessPaths(root) {
  const sourceRoot = resolve(root, 'workers/src');
  if (!existsSync(sourceRoot)) throw new Error('Missing harness source directory: workers/src');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() && entry.name.endsWith('.mjs') ? [relative(root, path).replaceAll('\\', '/')] : [];
  });
  return walk(sourceRoot).sort();
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export class ExternalCommandFailure extends Error {
  constructor(cause) {
    super(String(cause?.message || 'External deployment command failed'), { cause });
    this.name = 'ExternalCommandFailure';
    this.stderr = typeof cause?.stderr === 'string' ? cause.stderr : '';
    this.stdout = typeof cause?.stdout === 'string' ? cause.stdout : '';
  }
}
function externalCommandCode(error) {
  const detail = [error?.stderr, error?.stdout, error?.message].filter((value) => typeof value === 'string').join('\n');
  const auth = /\b(?:401|403)\b|authenticat|authori[sz]|unauthori[sz]ed|forbidden|permission|access denied|api token/i.test(detail);
  return auth ? 'API_AUTH_OR_PERMISSION' : 'API_REQUEST_FAILED';
}
function throwExternalCommandFailure(error) { throw new ExternalCommandFailure(error); }
function preserveNestedDiagnostic(error) {
  let cause = error?.cause;
  for (let depth = 0; cause && depth < 8; depth++, cause = cause.cause) {
    const code = publicDiagnosticCode(cause);
    if (code !== 'UNKNOWN') return diagnostic(code, error);
  }
  return error;
}
function classifyDeploymentBoundaryError(error) {
  if (error instanceof OwnershipRefusal) return preserveNestedDiagnostic(error);
  if (error instanceof ExternalCommandFailure) return diagnostic(externalCommandCode(error), error);
  return error;
}
function stagedDiagnostic(error, failureCode, timeoutCode, { preserveDiagnostic = true } = {}) {
  if (isTimeoutError(error)) return diagnostic(timeoutCode, error);
  if (preserveDiagnostic) {
    const directCode = publicDiagnosticCode(error);
    if (directCode !== 'UNKNOWN') return error;
    const nested = preserveNestedDiagnostic(error);
    if (nested !== error) return nested;
  }
  return diagnostic(failureCode, error);
}
async function deploymentStage(operation, failureCode, timeoutCode, options) {
  try { return await operation(); }
  catch (error) { throw stagedDiagnostic(error, failureCode, timeoutCode, options); }
}
function deploymentStageSync(operation, failureCode, timeoutCode, options) {
  try { return operation(); }
  catch (error) { throw stagedDiagnostic(error, failureCode, timeoutCode, options); }
}
function hasCause(error, Type) {
  const seen = new Set();
  for (let current = error; current && typeof current === 'object'; current = current.cause) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof Type) return true;
  }
  return false;
}
function asset(root, path, label) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) throw new Error(`Missing ${label} asset: ${path}`);
  const bytes = readFileSync(absolute);
  return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

export function assertVerifiedDeployment(record) {
  if (!record || record.apiVerified !== true || typeof record.versionId !== 'string' || !record.versionId.trim()
      || typeof record.wranglerVersion !== 'string' || !record.wranglerVersion.trim()) throw new Error('A verified deployment record is required');
  if (typeof record.workerId !== 'string' || !/^[a-f0-9]{32}$/.test(record.workerId)) throw new Error('A verified immutable Worker ID is required');
  const identity = assertPreDeploymentIdentity(record.identity);
  const temporaryWorkerName = assertTemporaryWorkerName(record.temporaryWorkerName);
  if (temporaryWorkerName !== identity.workerName || record.ownershipTag !== identity.ownershipTag) throw new Error('Verified deployment ownership identity does not match');
  for (const field of ['localConfigurationSha256', 'versionConfigurationSha256']) if (!/^[a-f0-9]{64}$/.test(record[field] ?? '')) throw new Error('Verified deployment configuration hash is invalid');
  if (typeof record.scriptETag !== 'string' || !record.scriptETag.trim()) throw new Error('Verified deployment script ETag is required');
  return { workerId: record.workerId, versionId: record.versionId, apiVerified: true, wranglerVersion: record.wranglerVersion, temporaryWorkerName,
    workersDevUrl: assertWorkersDevUrl(record.workersDevUrl), identity, ownershipTag: identity.ownershipTag,
    localConfigurationSha256: record.localConfigurationSha256, scriptETag: record.scriptETag, versionConfigurationSha256: record.versionConfigurationSha256 };
}
export function assertWorkersDevUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error('Wrangler deployment must return an HTTPS workers.dev root URL'); }
  if (typeof value !== 'string' || url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.pathname !== '/' || url.search || url.hash || url.username || url.password || url.port) throw new Error('Wrangler deployment must return an HTTPS workers.dev root URL');
  return url.toString().replace(/\/$/, '');
}
export function assertTemporaryWorkerName(value) {
  const uuid = /^ss-dds-soak-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const github = /^ss-dds-soak-gh-[0-9]+-[0-9]+-[a-z0-9_-]{12}$/;
  if (typeof value !== 'string' || value.length > 63 || (!uuid.test(value) && !github.test(value))) throw new Error('A generated temporary Worker identity is required');
  return value.toLowerCase();
}
export function createTemporaryWorkerName(randomUUID = systemRandomUUID) {
  return assertTemporaryWorkerName(TEMPORARY_WORKER_PREFIX + randomUUID());
}
export function createTemporaryWorkersConfig({ root = resolve(import.meta.dirname, '..'), temporaryWorkerName } = {}) {
  const scriptName = assertTemporaryWorkerName(temporaryWorkerName);
  const source = JSON.parse(readFileSync(resolve(root, 'workers/wrangler.jsonc'), 'utf8'));
  if (JSON.stringify(source).includes('DDS_REMOTE_TEST_KEY')) throw new Error('DDS_REMOTE_TEST_KEY must be absent from temporary configuration');
  for (const key of ['route', 'routes', 'zone_id', 'zone_name']) delete source[key];
  return { ...source, main: resolve(root, 'workers', source.main), name: scriptName, workers_dev: true };
}
function trustedIdentity({ accountId, apiToken, context }) {
  if (!accountId || !apiToken) throw new Error('Temporary Workers preflight requires account and token');
  return deriveCiIdentity({ ...context, secret: apiToken });
}
export async function preflightTemporaryWorkerIdentity({ fetchImpl = fetch, accountId, apiToken, context, identity, signal, now = () => new Date() }) {
  const trusted = trustedIdentity({ accountId, apiToken, context });
  const supplied = assertCiIdentity(identity, { context });
  if (canonicalJson(supplied) !== canonicalJson(trusted)) throw new Error('Predeployment identity does not match derived ownership');
  await deploymentStage(() => confirmExactAbsence({ fetchImpl, accountId, apiToken, temporaryWorkerName: trusted.workerName, signal }),
    'API_REQUEST_FAILED', 'PREFLIGHT_TIMEOUT');
  return createPreDeploymentIdentity({ identity: trusted, noCollisionVerifiedAt: now().toISOString() });
}
export async function verifyWorkersDeployment({ fetchImpl = fetch, accountId, scriptName, apiToken, expectedVersionId, ownershipTag, wranglerVersion, signal }) {
  if (!accountId || !apiToken || !expectedVersionId || !wranglerVersion || !/^[A-Za-z0-9_-]{43}$/.test(ownershipTag ?? '')) throw new Error('Workers API verification requires account, script, token, version, ownership tag, and Wrangler version');
  const result = await readWorkerVersions({ fetchImpl, accountId, apiToken, temporaryWorkerName: assertTemporaryWorkerName(scriptName), versionId: expectedVersionId, signal });
  if (result.status !== 'PRESENT') throw new Error('Cloudflare immutable version is absent');
  const [version] = result.versions;
  if (version.ownershipTag !== ownershipTag) throw new Error('Immutable Worker version ownership tag does not match');
  return { versionId: version.id, ownershipTag, scriptETag: version.scriptETag, versionConfigurationSha256: version.versionConfigurationSha256, apiVerified: true, wranglerVersion: String(wranglerVersion).trim() };
}
async function assertDeployedOwnership(options) {
  const snapshot = await readOwnershipSnapshot(options);
  if (!snapshot || snapshot.versionEvidence.status !== 'PRESENT' || !snapshot.versionEvidence.versions.length) throw new OwnershipRefusal('Refusing mutation: deployed immutable Worker version ownership is absent');
  return snapshot;
}
export async function deployAndVerifyWorkers({ execFile = execFileSync, fetchImpl = fetch, wrangler,
  root = resolve(import.meta.dirname, '..'), accountId, apiToken, remoteTestKey, context, preDeploymentIdentity,
  signal, removeDir = rmSync, cleanupImpl = cleanupRemoteDdsDeployment,
  wranglerOperationTimeoutMs = WRANGLER_OPERATION_TIMEOUT_MS, wranglerVersionTimeoutMs = WRANGLER_VERSION_TIMEOUT_MS,
  sleepImpl = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)) }) {
  const trusted = trustedIdentity({ accountId, apiToken, context });
  const identity = assertPreDeploymentIdentity(preDeploymentIdentity, { trustedIdentity: trusted, context });
  if (!/^[A-Za-z0-9_-]{43}$/.test(remoteTestKey ?? '')) throw new Error('Remote test key must be a 32-byte base64url value');
  for (const timeout of [wranglerOperationTimeoutMs, wranglerVersionTimeoutMs]) {
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new TypeError('Wrangler timeout must be a positive safe integer');
  }
  const temporaryWorkerName = assertTemporaryWorkerName(trusted.workerName), ownershipTag = trusted.ownershipTag;
  const apiOptions = { fetchImpl, accountId, apiToken, temporaryWorkerName, ownershipTag, observedVersions: new Map(), signal };
  // A persisted no-collision record is evidence, not authority to choose a name.
  await deploymentStage(() => confirmExactAbsence(apiOptions), 'API_REQUEST_FAILED', 'PREFLIGHT_TIMEOUT');
  const assets = deploymentAssets(root);
  const buildId = sha256(canonicalJson({ version: DEPLOYMENT_MANIFEST_VERSION, assets }));
  const configuration = createTemporaryWorkersConfig({ root, temporaryWorkerName });
  const configurationBytes = JSON.stringify(configuration) + '\n';
  const localConfigurationSha256 = sha256(configurationBytes);
  const configDir = mkdtempSync(join(tmpdir(), 'stepstone-dds-soak-'));
  const configPath = join(configDir, 'wrangler.json');
  let result;
  let primaryError;
  let rollbackError;
  let directoryError;
  let mutationAttempted = false;
  try {
    writeFileSync(configPath, configurationBytes, 'utf8');
    const childEnvironment = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken };
    delete childEnvironment.DDS_REMOTE_TEST_KEY;
    const childOptions = Object.freeze({ encoding: 'utf8', cwd: root, env: childEnvironment, windowsHide: true,
      killSignal: 'SIGTERM', maxBuffer: WRANGLER_MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] });
    const runWrangler = (args, { timeout, input, forceLocal = false } = {}) => {
      const useLocal = forceLocal || !wrangler;
      const command = useLocal ? process.execPath : wrangler;
      const commandArgs = useLocal ? [WRANGLER_CLI_PATH, ...args] : args;
      const options = { ...childOptions, timeout,
        ...(!useLocal && process.platform === 'win32' ? { shell: true } : {}),
        ...(input === undefined ? {} : { input }) };
      return execFile(command, commandArgs, options);
    };
    const deployArgs = ['deploy', '--config', configPath, '--tag=' + ownershipTag,
      '--var', 'DDS_REMOTE_TEST:true', '--var', 'DDS_DEPLOYMENT_BUILD_ID:' + buildId];
    mutationAttempted = true;
    try { runWrangler(deployArgs, { timeout: wranglerOperationTimeoutMs }); }
    catch (firstError) {
      if (!/\b10007\b/.test(String(firstError.message))) {
        throw stagedDiagnostic(firstError, 'WRANGLER_DEPLOY_FAILED', 'WRANGLER_DEPLOY_TIMEOUT');
      }
      const partial = await deploymentStage(() => readOwnershipSnapshot(apiOptions),
        'DEPLOYED_OWNERSHIP_UNVERIFIED', 'DEPLOYED_OWNERSHIP_TIMEOUT');
      if (partial === null) throw stagedDiagnostic(firstError, 'WRANGLER_DEPLOY_FAILED', 'WRANGLER_DEPLOY_TIMEOUT');
      apiOptions.expectedWorkerId = partial.worker.id;
      await sleepImpl(2000);
      const reread = await deploymentStage(() => readOwnershipSnapshot(apiOptions),
        'DEPLOYED_OWNERSHIP_UNVERIFIED', 'DEPLOYED_OWNERSHIP_TIMEOUT');
      deploymentStageSync(() => sameOwnershipSnapshot(reread, partial),
        'DEPLOYED_OWNERSHIP_UNVERIFIED', 'DEPLOYED_OWNERSHIP_TIMEOUT');
      deploymentStageSync(() => runWrangler(deployArgs, { timeout: wranglerOperationTimeoutMs }),
        'WRANGLER_DEPLOY_FAILED', 'WRANGLER_DEPLOY_TIMEOUT');
    }
    const beforeSecret = await deploymentStage(() => assertDeployedOwnership(apiOptions),
      'DEPLOYED_OWNERSHIP_UNVERIFIED', 'DEPLOYED_OWNERSHIP_TIMEOUT');
    apiOptions.expectedWorkerId = beforeSecret.worker.id;
    deploymentStageSync(() => runWrangler(['secret', 'put', 'DDS_REMOTE_TEST_KEY', '--config', configPath],
      { timeout: wranglerOperationTimeoutMs, input: remoteTestKey + '\n', forceLocal: true }),
    'SECRET_UPLOAD_FAILED', 'SECRET_UPLOAD_TIMEOUT');
    const afterSecret = await deploymentStage(() => assertDeployedOwnership(apiOptions),
      'POST_SECRET_OWNERSHIP_UNVERIFIED', 'POST_SECRET_OWNERSHIP_TIMEOUT');
    const versions = afterSecret.versionEvidence.versions;
    const subdomain = await deploymentStage(async () => {
      const subdomainResponse = await fetchImpl('https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(accountId) + '/workers/subdomain', {
        headers: { authorization: 'Bearer ' + apiToken }, signal: deadlineSignal({ signal, timeoutMs: MANAGEMENT_API_TIMEOUT_MS }),
      });
      const payload = await subdomainResponse.json();
      if (!subdomainResponse.ok || payload.success !== true || typeof payload.result?.subdomain !== 'string'
          || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(payload.result.subdomain)) throw new Error('Cloudflare did not verify the workers.dev subdomain');
      return payload;
    }, 'SUBDOMAIN_LOOKUP_FAILED', 'SUBDOMAIN_LOOKUP_TIMEOUT');
    const workersDevUrl = 'https://' + temporaryWorkerName + '.' + subdomain.result.subdomain + '.workers.dev';
    const wranglerVersion = deploymentStageSync(() => String(runWrangler(['--version'], { timeout: wranglerVersionTimeoutMs })).trim(),
      'IMMUTABLE_VERSION_UNVERIFIED', 'IMMUTABLE_VERSION_TIMEOUT');
    const verified = await deploymentStage(async () => {
      try {
        const value = await verifyWorkersDeployment({ fetchImpl, accountId, scriptName: temporaryWorkerName, apiToken,
          expectedVersionId: versions[0].id, ownershipTag, wranglerVersion, signal });
        const currentMetadata = { id: value.versionId, ownershipTag: value.ownershipTag, scriptETag: value.scriptETag, versionConfigurationSha256: value.versionConfigurationSha256 };
        observeImmutableVersions([currentMetadata], apiOptions.observedVersions);
        return value;
      } catch (error) {
        if (error instanceof OwnershipRefusal) throw error;
        throw new OwnershipRefusal('Refusing mutation: final immutable version ownership metadata could not be verified', { cause: error });
      }
    }, 'IMMUTABLE_VERSION_UNVERIFIED', 'IMMUTABLE_VERSION_TIMEOUT');
    const route = '/__dds/metrics', body = '{}';
    await deploymentStage(async () => {
      const remote = await fetchImpl(workersDevUrl + route, { method: 'POST', body,
        signal: deadlineSignal({ signal, timeoutMs: ENDPOINT_PROBE_TIMEOUT_MS }), headers: {
          'content-type': 'application/json', 'x-dds-test-key': remoteTestKey, 'x-dds-run-id': systemRandomUUID(),
          'x-dds-operation-id': 'deployment.verify.000001', 'x-dds-request-hash': requestHash(route, body), 'x-dds-shard': '0',
        } });
      const evidence = await remote.json();
      if (!remote.ok || evidence?.operationResult?.buildId !== buildId || evidence?.operationResult?.workerVersionId !== verified.versionId) {
        throw new Error('Remote deployment evidence did not verify the build and immutable version');
      }
    }, 'ENDPOINT_VERIFICATION_FAILED', 'ENDPOINT_VERIFICATION_TIMEOUT');
    result = assertVerifiedDeployment({ ...verified, workerId: afterSecret.worker.id, workersDevUrl, temporaryWorkerName, identity, localConfigurationSha256 });
  } catch (error) {
    primaryError = error;
    // An ownership refusal is final for this attempt, even if a later read would
    // appear owned again. It never grants authority for rollback mutations.
    if (!hasCause(error, OwnershipRefusal) && mutationAttempted) {
      let partial;
      try {
        partial = await deploymentStage(() => readOwnershipSnapshot(apiOptions),
          'ROLLBACK_DISCOVERY_FAILED', 'ROLLBACK_DISCOVERY_TIMEOUT', { preserveDiagnostic: false });
      } catch (failure) { rollbackError = failure; }
      if (partial && !rollbackError) {
        try {
          await deploymentStage(() => cleanupImpl({ ...apiOptions, context, preDeploymentIdentity: identity, initialOwnershipSnapshot: partial }),
            'ROLLBACK_CLEANUP_FAILED', 'ROLLBACK_CLEANUP_TIMEOUT', { preserveDiagnostic: false });
        } catch (failure) { rollbackError = failure; }
      }
    }
  }
  try { removeDir(configDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch (error) { directoryError = diagnostic('TEMP_DIRECTORY_CLEANUP_FAILED', error); }
  if (primaryError) {
    if (rollbackError) ROLLBACK_FAILURES.set(primaryError, rollbackError);
    throw primaryError;
  }
  if (directoryError) throw directoryError;
  return result;
}
function deploymentAssets(root) {
  return { wasm: asset(root, WASM_PATH, 'Wasm'), harness: Object.fromEntries(harnessPaths(root).map((path) => [path, asset(root, path, 'harness')])) };
}
export async function teardownTemporaryWorkers(options) {
  return cleanupRemoteDdsDeployment(options);
}
export function createDeploymentManifest({ root = resolve(import.meta.dirname, '..'), verifiedDeployment } = {}) {
  const deployment = assertVerifiedDeployment(verifiedDeployment);
  const assets = deploymentAssets(root);
  const fingerprint = { version: DEPLOYMENT_MANIFEST_VERSION, assets };
  const { workerId, versionId, apiVerified, wranglerVersion, temporaryWorkerName, ownershipTag } = deployment;
  return createDeploymentRecord({ identity: deployment.identity, endpoint: deployment.workersDevUrl,
    deploymentManifest: { ...fingerprint, workerId, workerVersionId: versionId, verifiedDeployment: { workerId, versionId, apiVerified, wranglerVersion, temporaryWorkerName, ownershipTag }, buildId: sha256(canonicalJson(fingerprint)) },
    localConfigurationSha256: deployment.localConfigurationSha256, scriptETag: deployment.scriptETag, versionConfigurationSha256: deployment.versionConfigurationSha256 });
}
export function assertDeploymentManifest(manifest, { root = resolve(import.meta.dirname, '..') } = {}) {
  const record = assertDeploymentRecord(manifest);
  const assets = deploymentAssets(root);
  if (canonicalJson(Object.keys(record.assets.harness).sort()) !== canonicalJson(Object.keys(assets.harness).sort())) throw new Error('Deployment manifest harness asset set changed');
  if (canonicalJson(record.assets.wasm) !== canonicalJson(assets.wasm)) throw new Error('Wasm asset hash changed since deployment manifest was generated');
  for (const path of Object.keys(assets.harness)) if (canonicalJson(record.assets.harness[path]) !== canonicalJson(assets.harness[path])) throw new Error('Harness asset hash changed since deployment manifest was generated: ' + path);
  if (record.buildId !== sha256(canonicalJson({ version: DEPLOYMENT_MANIFEST_VERSION, assets }))) throw new Error('Deployment manifest build ID does not bind the current assets');
  return record;
}
export function parseDeploymentOptions(args) {
  const common = ['--repository', '--workflow', '--run-id', '--run-attempt', '--commit-sha', '--out'];
  const allowed = new Set(['--preflight', '--identity', '--deploy-from-identity', ...common]);
  const values = new Map();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!allowed.has(key)) throw new Error('Unknown deployment CLI argument');
    if (values.has(key)) throw new Error('Duplicate deployment CLI argument');
    if (key === '--preflight') { values.set(key, true); continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('Missing deployment CLI argument value');
    values.set(key, value);
  }
  const preflight = values.has('--preflight'), deploy = values.has('--deploy-from-identity');
  if (preflight === deploy) throw new Error('Exactly one deployment CLI mode is required');
  const required = new Set([...(preflight ? ['--preflight', '--identity'] : ['--deploy-from-identity']), ...common]);
  for (const key of values.keys()) if (!required.has(key)) throw new Error('Deployment CLI modes cannot mix arguments');
  for (const key of required) if (!values.has(key)) throw new Error('Missing required deployment CLI argument: ' + key);
  const context = assertGithubContext({ repository: values.get('--repository'), workflow: values.get('--workflow'), runId: values.get('--run-id'), runAttempt: values.get('--run-attempt'), commitSha: values.get('--commit-sha') });
  if (`ss-dds-soak-gh-${context.runId}-${context.runAttempt}-${'0'.repeat(12)}`.length > 63) throw new Error('Worker name exceeds 63 characters for runId/runAttempt');
  return { preflight, context, input: values.get(preflight ? '--identity' : '--deploy-from-identity'), out: values.get('--out') };
}
export async function runDeploymentCli(args, env = process.env, dependencies = {}) {
  let options;
  try { options = parseDeploymentOptions(args); }
  catch (error) { throw diagnostic('CLI_INPUT_INVALID', error); }
  const accountId = env.CLOUDFLARE_ACCOUNT_ID, apiToken = env.CLOUDFLARE_API_TOKEN;
  if (typeof accountId !== 'string' || !accountId || typeof apiToken !== 'string' || !apiToken) {
    throw diagnostic('REQUIRED_CONFIG_MISSING', new Error('Temporary Workers deployment requires account and token'));
  }
  if (!options.preflight && (typeof env.DDS_REMOTE_TEST_KEY !== 'string' || !env.DDS_REMOTE_TEST_KEY)) {
    throw diagnostic('REQUIRED_CONFIG_MISSING', new Error('Remote test key is required for deployment'));
  }
  let input;
  try { input = JSON.parse(readFileSync(resolve(options.input), 'utf8')); }
  catch (error) { throw diagnostic('CLI_INPUT_INVALID', error); }
  try {
    const trustedIdentity = deriveCiIdentity({ ...options.context, secret: apiToken });
    if (options.preflight) {
      const supplied = assertCiIdentity(input, { context: options.context });
      if (canonicalJson(supplied) !== canonicalJson(trustedIdentity)) throw new Error('Predeployment identity does not match derived ownership');
    } else {
      assertPreDeploymentIdentity(input, { trustedIdentity, context: options.context });
    }
  } catch (error) { throw diagnostic('IDENTITY_INVALID', error); }
  const checkpointWriter = dependencies.writeReportCheckpoint ?? writeReportCheckpoint;
  const runtimeDependencies = { ...dependencies };
  delete runtimeDependencies.writeReportCheckpoint;
  const common = { ...runtimeDependencies, accountId, apiToken, context: options.context };
  const record = options.preflight ? await preflightTemporaryWorkerIdentity({ ...common, identity: input })
    : createDeploymentManifest({ root: dependencies.root, verifiedDeployment: await deployAndVerifyWorkers({ ...common, preDeploymentIdentity: input, remoteTestKey: env.DDS_REMOTE_TEST_KEY }) });
  try { checkpointWriter(resolve(options.out), record); }
  catch (error) { throw diagnostic('LOCAL_IO_FAILED', error); }
  return record;
}
export async function runDeploymentProcess(args, env = process.env, dependencies = {}, io = {}) {
  const execute = dependencies.runDeploymentCli ?? runDeploymentCli;
  const writeError = io.error ?? ((value) => process.stderr.write(value));
  const setExitCode = io.setExitCode ?? ((value) => { process.exitCode = value; });
  try { return await execute(args, env, dependencies); }
  catch (error) {
    const renderedError = classifyDeploymentBoundaryError(error);
    writeError(`${renderRemoteDdsFailure(renderedError)}\n`);
    const rollbackError = ROLLBACK_FAILURES.get(error);
    if (rollbackError) writeError(`${renderRemoteDdsRollbackFailure(rollbackError)}\n`);
    setExitCode(1);
    return undefined;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDeploymentProcess(process.argv.slice(2));
}
