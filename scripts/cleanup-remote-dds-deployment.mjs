import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveCiIdentity, assertGithubContext, assertPreDeploymentIdentity, bindCiArtifacts, assertEndpoint, canonicalOutputTarget } from './remote-dds-ci-identity.mjs';
import { readOwnershipSnapshot, sameOwnershipSnapshot, disableWorkersDevSubdomain, deleteExactWorker, confirmExactAbsence, OwnershipRefusal } from './cloudflare-temporary-worker-api.mjs';
import { writeReportCheckpoint } from './worker-dds-checkpoint.mjs';
import { diagnostic, publicDiagnosticCode, renderRemoteDdsCleanupFailure } from './remote-dds-public-errors.mjs';
import { deadlineSignal, isTimeoutError, MANAGEMENT_API_TIMEOUT_MS, ENDPOINT_PROBE_TIMEOUT_MS } from './remote-dds-timeouts.mjs';

function resultFor(context, workerName) {
  return { version: 2, status: 'failed', ...context, workerName, subdomainDisabled: false, objectDeleted: false,
    currentAbsent: false, legacyAbsent: false, failureCode: null };
}
const RESULT_WRITE_FAILURES = new WeakMap();
function cleanupFailure(error, failureCode, timeoutCode, result) {
  const code = timeoutCode && isTimeoutError(error) ? timeoutCode : failureCode;
  const failure = diagnostic(code, error);
  Object.defineProperty(failure, 'cleanupResult', { value: { ...result, status: 'failed', currentAbsent: false, legacyAbsent: false, failureCode: code } });
  return failure;
}
async function cleanupStage(operation, failureCode, timeoutCode, result) {
  try { return await operation(); }
  catch (error) { throw cleanupFailure(error, failureCode, timeoutCode, result); }
}
function verifyDeployment(snapshot, record) {
  if (!record) return;
  const version = snapshot.versionEvidence.versions[0];
  if (snapshot.worker.id !== record.workerId || snapshot.versionEvidence.status !== 'PRESENT' || !version
      || version.id !== record.workerVersionId || version.ownershipTag !== record.ownershipTag || version.scriptETag !== record.scriptETag
      || version.versionConfigurationSha256 !== record.versionConfigurationSha256) throw new OwnershipRefusal('Refusing mutation: deployed immutable object and version evidence does not match attested deployment');
}
async function formerEndpoint({ accountId, apiToken, temporaryWorkerName, fetchImpl, signal }, record) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/subdomain`, {
    headers: { authorization: `Bearer ${apiToken}` }, signal: deadlineSignal({ signal, timeoutMs: MANAGEMENT_API_TIMEOUT_MS }),
  });
  let payload; try { payload = await response.json(); } catch { throw new OwnershipRefusal('Refusing mutation: account workers.dev endpoint evidence is invalid'); }
  const subdomain = payload?.result?.subdomain;
  if (!response.ok || payload?.success !== true || typeof subdomain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(subdomain)) throw new OwnershipRefusal('Refusing mutation: account workers.dev endpoint evidence is invalid');
  const endpoint = `https://${temporaryWorkerName}.${subdomain}.workers.dev`;
  if (record && record.endpoint !== endpoint) throw new OwnershipRefusal('Refusing mutation: former endpoint does not match attested deployment');
  return endpoint;
}

export async function probeFormerWorkersDevEndpoint(endpoint, { fetchImpl = fetch, signal, timeoutMs = ENDPOINT_PROBE_TIMEOUT_MS } = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.pathname !== '/' || url.search || url.hash || url.username || url.password || url.port) throw new Error('Former endpoint must be an HTTPS workers.dev root');
  let response;
  try { response = await fetchImpl(endpoint, { method: 'GET', redirect: 'manual', signal: deadlineSignal({ signal, timeoutMs }) }); }
  catch (error) {
    if (['ENOTFOUND', 'ENODATA', 'NODATA'].includes(error?.cause?.code ?? error?.code)) return { absent: true };
    throw new OwnershipRefusal('Refusing object deletion: former endpoint absence is ambiguous');
  }
  if (response?.status !== 404) throw new OwnershipRefusal('Refusing object deletion: former endpoint did not prove HTTP 404 absence');
  return { absent: true };
}

export async function cleanupRemoteDdsDeployment({ accountId, apiToken, context, preDeploymentIdentity, deploymentRecord,
  fetchImpl = fetch, probeFetchImpl = fetchImpl, probeImpl = probeFormerWorkersDevEndpoint,
  temporaryWorkerName, workersDevUrl, observedVersions = new Map(), initialOwnershipSnapshot, signal } = {}) {
  const trustedContext = assertGithubContext(context);
  let trustedIdentity;
  let result = resultFor(trustedContext, null);
  try {
    trustedIdentity = deriveCiIdentity({ ...trustedContext, secret: apiToken });
    result.workerName = trustedIdentity.workerName;
    if (typeof accountId !== 'string' || !accountId) throw new Error('Cleanup requires the explicit account');
    const identity = assertPreDeploymentIdentity(preDeploymentIdentity, { trustedIdentity, context: trustedContext });
    const record = deploymentRecord === undefined ? undefined : bindCiArtifacts({ trustedIdentity, identity, deployment: deploymentRecord, context: trustedContext }).deployment;
    if (temporaryWorkerName !== undefined && temporaryWorkerName !== identity.workerName) throw new OwnershipRefusal('Refusing mutation: supplied name does not match trusted identity');
    if (workersDevUrl !== undefined) {
      assertEndpoint(workersDevUrl, identity.workerName);
      if (record && workersDevUrl !== record.endpoint) throw new OwnershipRefusal('Refusing mutation: supplied endpoint does not match attested deployment');
    }
    const apiOptions = { accountId, apiToken, temporaryWorkerName: trustedIdentity.workerName, ownershipTag: trustedIdentity.ownershipTag,
      fetchImpl, observedVersions, signal, expectedWorkerId: record?.workerId ?? initialOwnershipSnapshot?.worker.id };
    const before = await cleanupStage(() => readOwnershipSnapshot(apiOptions), 'CLEANUP_OWNERSHIP_UNVERIFIED', 'CLEANUP_OWNERSHIP_READ_TIMEOUT', result);
    await cleanupStage(() => {
      if (initialOwnershipSnapshot !== undefined) sameOwnershipSnapshot(before, initialOwnershipSnapshot);
      if (before !== null) verifyDeployment(before, record);
    }, 'CLEANUP_OWNERSHIP_UNVERIFIED', undefined, result);
    if (before === null) return { ...result, status: 'already-absent', currentAbsent: true, legacyAbsent: true, failureCode: null };
    const endpoint = await cleanupStage(() => formerEndpoint(apiOptions, record),
      'CLEANUP_ENDPOINT_UNVERIFIED', 'CLEANUP_SUBDOMAIN_LOOKUP_TIMEOUT', result);
    await cleanupStage(() => {
      if (workersDevUrl !== undefined && workersDevUrl !== endpoint) throw new OwnershipRefusal('Refusing mutation: supplied endpoint does not match trusted identity');
    }, 'CLEANUP_ENDPOINT_UNVERIFIED', undefined, result);
    await cleanupStage(() => disableWorkersDevSubdomain({ ...apiOptions, worker: before.worker }),
      'CLEANUP_SUBDOMAIN_DISABLE_FAILED', 'CLEANUP_SUBDOMAIN_DISABLE_TIMEOUT', result);
    result.subdomainDisabled = true;
    const absence = await cleanupStage(() => probeImpl(endpoint, { fetchImpl: probeFetchImpl, signal, timeoutMs: ENDPOINT_PROBE_TIMEOUT_MS }),
      'CLEANUP_ENDPOINT_UNVERIFIED', 'CLEANUP_ENDPOINT_PROBE_TIMEOUT', result);
    await cleanupStage(() => {
      if (absence?.absent !== true) throw new OwnershipRefusal('Refusing object deletion: former endpoint absence was not verified');
    }, 'CLEANUP_ENDPOINT_UNVERIFIED', undefined, result);
    const after = await cleanupStage(() => readOwnershipSnapshot({ ...apiOptions, expectedWorkerId: before.worker.id }),
      'CLEANUP_OWNERSHIP_UNVERIFIED', 'CLEANUP_REVERIFY_TIMEOUT', result);
    await cleanupStage(() => {
      sameOwnershipSnapshot(after, before);
      verifyDeployment(after, record);
    }, 'CLEANUP_OWNERSHIP_UNVERIFIED', undefined, result);
    const stableEndpoint = await cleanupStage(() => formerEndpoint(apiOptions, record),
      'CLEANUP_ENDPOINT_UNVERIFIED', 'CLEANUP_SUBDOMAIN_LOOKUP_TIMEOUT', result);
    await cleanupStage(() => {
      if (stableEndpoint !== endpoint) throw new OwnershipRefusal('Refusing object deletion: account endpoint changed');
    }, 'CLEANUP_ENDPOINT_UNVERIFIED', undefined, result);
    await cleanupStage(() => deleteExactWorker({ ...apiOptions, worker: after.worker }),
      'CLEANUP_DELETE_FAILED', 'CLEANUP_DELETE_TIMEOUT', result);
    result.objectDeleted = true;
    await cleanupStage(() => confirmExactAbsence(apiOptions),
      'CLEANUP_ABSENCE_UNVERIFIED', 'CLEANUP_FINAL_ABSENCE_TIMEOUT', result);
    return { ...result, status: 'deleted', currentAbsent: true, legacyAbsent: true, failureCode: null };
  } catch (error) {
    if (error?.cleanupResult) throw error;
    throw cleanupFailure(error, 'CLEANUP_IDENTITY_INVALID', undefined, result);
  }
}

export function parseCleanupOptions(args) {
  const allowed = new Set(['--identity', '--deployment-record', '--repository', '--workflow', '--run-id', '--run-attempt', '--commit-sha', '--out']);
  const values = new Map();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!allowed.has(key)) throw new Error('Unknown cleanup CLI argument');
    if (values.has(key)) throw new Error('Duplicate cleanup CLI argument');
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('Missing cleanup CLI argument value');
    values.set(key, value);
  }
  for (const key of allowed) if (key !== '--deployment-record' && !values.has(key)) throw new Error('Missing required cleanup CLI argument');
  const context = assertGithubContext({ repository: values.get('--repository'), workflow: values.get('--workflow'), runId: values.get('--run-id'), runAttempt: values.get('--run-attempt'), commitSha: values.get('--commit-sha') });
  return { context, identity: values.get('--identity'), deploymentRecord: values.get('--deployment-record'), out: values.get('--out') };
}
export async function runCleanupCli(args, env = process.env, dependencies = {}) {
  const options = parseCleanupOptions(args);
  const target = canonicalOutputTarget(options.out);
  for (const input of [options.identity, options.deploymentRecord].filter((path) => path !== undefined)) {
    if (canonicalOutputTarget(input) === target) throw new Error('Cleanup output and attestation inputs must be separate files');
  }
  let result = resultFor(options.context, null);
  const checkpointWriter = dependencies.writeReportCheckpoint ?? writeReportCheckpoint;
  const runtimeDependencies = { ...dependencies };
  delete runtimeDependencies.writeReportCheckpoint;
  try {
    result.workerName = deriveCiIdentity({ ...options.context, secret: env.CLOUDFLARE_API_TOKEN }).workerName;
    const preDeploymentIdentity = JSON.parse(readFileSync(resolve(options.identity), 'utf8'));
    const deploymentRecord = options.deploymentRecord === undefined ? undefined : JSON.parse(readFileSync(resolve(options.deploymentRecord), 'utf8'));
    result = await cleanupRemoteDdsDeployment({ ...runtimeDependencies, accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN, context: options.context, preDeploymentIdentity, deploymentRecord });
  } catch (error) {
    const failure = publicDiagnosticCode(error) === 'UNKNOWN'
      ? cleanupFailure(error, 'CLEANUP_IDENTITY_INVALID', undefined, result) : error;
    try { checkpointWriter(resolve(options.out), failure.cleanupResult ?? result); }
    catch (writeError) { RESULT_WRITE_FAILURES.set(failure, diagnostic('CLEANUP_RESULT_WRITE_FAILED', writeError)); }
    throw failure;
  }
  try { checkpointWriter(resolve(options.out), result); }
  catch (error) { throw cleanupFailure(error, 'CLEANUP_RESULT_WRITE_FAILED', undefined, result); }
  return result;
}
export async function runCleanupProcess(args, env = process.env, dependencies = {}, io = {}) {
  const writeError = io.error ?? ((value) => process.stderr.write(value));
  const setExitCode = io.setExitCode ?? ((value) => { process.exitCode = value; });
  try { return await runCleanupCli(args, env, dependencies); }
  catch (error) {
    const primary = publicDiagnosticCode(error) === 'UNKNOWN' ? diagnostic('CLEANUP_IDENTITY_INVALID', error) : error;
    writeError(`${renderRemoteDdsCleanupFailure(primary)}\n`);
    const writeFailure = RESULT_WRITE_FAILURES.get(error);
    if (writeFailure) writeError(`${renderRemoteDdsCleanupFailure(writeFailure)}\n`);
    setExitCode(1);
    return undefined;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCleanupProcess(process.argv.slice(2));
