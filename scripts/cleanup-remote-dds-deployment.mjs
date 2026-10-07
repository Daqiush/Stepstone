import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveCiIdentity, assertGithubContext, assertPreDeploymentIdentity, bindCiArtifacts, assertEndpoint, canonicalOutputTarget } from './remote-dds-ci-identity.mjs';
import { readOwnershipSnapshot, sameOwnershipSnapshot, disableWorkersDevSubdomain, deleteExactWorker, confirmExactAbsence, OwnershipRefusal } from './cloudflare-temporary-worker-api.mjs';
import { writeReportCheckpoint } from './worker-dds-checkpoint.mjs';

function resultFor(context, workerName) {
  return { version: 1, status: 'failed', ...context, workerName, subdomainDisabled: false, objectDeleted: false, currentAbsent: false, legacyAbsent: false };
}
function verifyDeployment(snapshot, record) {
  if (!record) return;
  const version = snapshot.versionEvidence.versions[0];
  if (snapshot.worker.id !== record.workerId || snapshot.versionEvidence.status !== 'PRESENT' || !version
      || version.id !== record.workerVersionId || version.ownershipTag !== record.ownershipTag || version.scriptETag !== record.scriptETag
      || version.versionConfigurationSha256 !== record.versionConfigurationSha256) throw new OwnershipRefusal('Refusing mutation: deployed immutable object and version evidence does not match attested deployment');
}
async function formerEndpoint({ accountId, apiToken, temporaryWorkerName, fetchImpl }, record) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/subdomain`, { headers: { authorization: `Bearer ${apiToken}` } });
  let payload; try { payload = await response.json(); } catch { throw new OwnershipRefusal('Refusing mutation: account workers.dev endpoint evidence is invalid'); }
  const subdomain = payload?.result?.subdomain;
  if (!response.ok || payload?.success !== true || typeof subdomain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(subdomain)) throw new OwnershipRefusal('Refusing mutation: account workers.dev endpoint evidence is invalid');
  const endpoint = `https://${temporaryWorkerName}.${subdomain}.workers.dev`;
  if (record && record.endpoint !== endpoint) throw new OwnershipRefusal('Refusing mutation: former endpoint does not match attested deployment');
  return endpoint;
}

export async function probeFormerWorkersDevEndpoint(endpoint, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.pathname !== '/' || url.search || url.hash || url.username || url.password || url.port) throw new Error('Former endpoint must be an HTTPS workers.dev root');
  let response;
  try { response = await fetchImpl(endpoint, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) {
    if (['ENOTFOUND', 'ENODATA', 'NODATA'].includes(error?.cause?.code ?? error?.code)) return { absent: true };
    throw new OwnershipRefusal('Refusing object deletion: former endpoint absence is ambiguous');
  }
  if (response?.status !== 404) throw new OwnershipRefusal('Refusing object deletion: former endpoint did not prove HTTP 404 absence');
  return { absent: true };
}

export async function cleanupRemoteDdsDeployment({ accountId, apiToken, context, preDeploymentIdentity, deploymentRecord,
  fetchImpl = fetch, probeFetchImpl = fetchImpl, probeImpl = probeFormerWorkersDevEndpoint,
  temporaryWorkerName, workersDevUrl, observedVersions = new Map(), initialOwnershipSnapshot } = {}) {
  const trustedContext = assertGithubContext(context);
  const trustedIdentity = deriveCiIdentity({ ...trustedContext, secret: apiToken });
  const result = resultFor(trustedContext, trustedIdentity.workerName);
  try {
    if (typeof accountId !== 'string' || !accountId) throw new Error('Cleanup requires the explicit account');
    const identity = assertPreDeploymentIdentity(preDeploymentIdentity, { trustedIdentity, context: trustedContext });
    const record = deploymentRecord === undefined ? undefined : bindCiArtifacts({ trustedIdentity, identity, deployment: deploymentRecord, context: trustedContext }).deployment;
    if (temporaryWorkerName !== undefined && temporaryWorkerName !== identity.workerName) throw new OwnershipRefusal('Refusing mutation: supplied name does not match trusted identity');
    if (workersDevUrl !== undefined) {
      assertEndpoint(workersDevUrl, identity.workerName);
      if (record && workersDevUrl !== record.endpoint) throw new OwnershipRefusal('Refusing mutation: supplied endpoint does not match attested deployment');
    }
    const apiOptions = { accountId, apiToken, temporaryWorkerName: trustedIdentity.workerName, ownershipTag: trustedIdentity.ownershipTag, fetchImpl, observedVersions,
      expectedWorkerId: record?.workerId ?? initialOwnershipSnapshot?.worker.id };
    const before = await readOwnershipSnapshot(apiOptions);
    if (initialOwnershipSnapshot !== undefined) sameOwnershipSnapshot(before, initialOwnershipSnapshot);
    if (before === null) return { ...result, status: 'already-absent', currentAbsent: true, legacyAbsent: true };
    verifyDeployment(before, record);
    const endpoint = await formerEndpoint(apiOptions, record);
    if (workersDevUrl !== undefined && workersDevUrl !== endpoint) throw new OwnershipRefusal('Refusing mutation: supplied endpoint does not match trusted identity');
    await disableWorkersDevSubdomain({ ...apiOptions, worker: before.worker });
    result.subdomainDisabled = true;
    const absence = await probeImpl(endpoint, { fetchImpl: probeFetchImpl });
    if (absence?.absent !== true) throw new OwnershipRefusal('Refusing object deletion: former endpoint absence was not verified');
    const after = await readOwnershipSnapshot({ ...apiOptions, expectedWorkerId: before.worker.id });
    sameOwnershipSnapshot(after, before);
    verifyDeployment(after, record);
    if (await formerEndpoint(apiOptions, record) !== endpoint) throw new OwnershipRefusal('Refusing object deletion: account endpoint changed');
    await deleteExactWorker({ ...apiOptions, worker: after.worker });
    result.objectDeleted = true;
    await confirmExactAbsence(apiOptions);
    return { ...result, status: 'deleted', currentAbsent: true, legacyAbsent: true };
  } catch {
    // No transport response, credentials, or raw error details enter artifacts.
    const refusal = new OwnershipRefusal('Remote DDS cleanup refused: identity, ownership, endpoint absence, or immutable evidence could not be verified');
    refusal.cleanupResult = { ...result };
    throw refusal;
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
  try {
    result.workerName = deriveCiIdentity({ ...options.context, secret: env.CLOUDFLARE_API_TOKEN }).workerName;
    const preDeploymentIdentity = JSON.parse(readFileSync(resolve(options.identity), 'utf8'));
    const deploymentRecord = options.deploymentRecord === undefined ? undefined : JSON.parse(readFileSync(resolve(options.deploymentRecord), 'utf8'));
    result = await cleanupRemoteDdsDeployment({ ...dependencies, accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN, context: options.context, preDeploymentIdentity, deploymentRecord });
  } catch (error) {
    writeReportCheckpoint(resolve(options.out), error.cleanupResult ?? result);
    throw new Error('Remote DDS cleanup failed; verify identity, ownership, and endpoint absence evidence');
  }
  writeReportCheckpoint(resolve(options.out), result);
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCleanupCli(process.argv.slice(2)).catch(() => {
  console.error('Remote DDS cleanup failed; verify CLI arguments, identity, ownership, and endpoint absence evidence.');
  process.exitCode = 1;
});
