import { createHash } from 'node:crypto';
import { canonicalJson } from './remote-dds-soak-state.mjs';
import { diagnostic } from './remote-dds-public-errors.mjs';

// Mutation authority comes from a complete exact-object read, never a caller's
// name-only object or a serialized artifact masquerading as an API observation.
const normalizedWorkers = new WeakMap();

function temporaryName(value) {
  const uuid = /^ss-dds-soak-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const github = /^ss-dds-soak-gh-[0-9]+-[0-9]+-[a-z0-9_-]{12}$/;
  if (typeof value !== 'string' || value.length > 63 || (!uuid.test(value) && !github.test(value))) throw new Error('An exact generated temporary Worker identity is required');
  return value.toLowerCase();
}
function inputs(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw diagnostic('REQUIRED_CONFIG_MISSING', new Error('Cloudflare API requires account and token'));
  }
  const { accountId, apiToken, fetchImpl = fetch } = options;
  if (typeof accountId !== 'string' || !accountId || typeof apiToken !== 'string' || !apiToken) {
    throw diagnostic('REQUIRED_CONFIG_MISSING', new Error('Cloudflare API requires account and token'));
  }
  return { base: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers`, name: temporaryName(options.temporaryWorkerName), fetchImpl, headers: { authorization: `Bearer ${apiToken}` } };
}
function invalidResponse(message, cause) { return diagnostic('API_RESPONSE_INVALID', new Error(message, { cause })); }
function requestFailed(message, cause) { return diagnostic('API_REQUEST_FAILED', new Error(message, { cause })); }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validError(error) {
  return isRecord(error) && (typeof error.code === 'number' || typeof error.code === 'string')
    && (error.message === undefined || typeof error.message === 'string');
}
function validFailureEnvelope(payload) {
  return isRecord(payload) && payload.success === false && Array.isArray(payload.errors) && payload.errors.length > 0 && payload.errors.every(validError);
}
function validResultInfo(info) {
  return isRecord(info) && Number.isSafeInteger(info.page) && info.page >= 1
    && Number.isSafeInteger(info.per_page) && info.per_page >= 1 && info.per_page <= 100
    && Number.isSafeInteger(info.total_pages) && info.total_pages >= 0 && info.total_pages <= 100000
    && Number.isSafeInteger(info.count) && info.count >= 0 && info.count <= info.per_page
    && Number.isSafeInteger(info.total_count) && info.total_count >= 0;
}
function authOrPermissionEnvelope(payload) {
  const authOrPermission = /authenticat|authori[sz]|unauthori[sz]ed|permission|forbidden|access denied/i;
  return validFailureEnvelope(payload) && payload.errors.some((error) => typeof error.message === 'string' && authOrPermission.test(error.message));
}
async function fetchResponse(client, url, options = {}) {
  let response;
  try { response = await client.fetchImpl(url, { ...options, headers: { ...client.headers, ...options.headers } }); }
  catch (error) {
    if (error instanceof OwnershipRefusal) throw error;
    throw requestFailed('Cloudflare API request failed', error);
  }
  if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean' || !Number.isInteger(response.status)) {
    throw invalidResponse('Cloudflare API returned an invalid response');
  }
  if ([401, 403].includes(response.status)) throw diagnostic('API_AUTH_OR_PERMISSION', new Error('Cloudflare API denied authorization'));
  return response;
}
async function responseJson(response) {
  if (typeof response.json !== 'function') throw invalidResponse('Cloudflare API returned invalid JSON');
  try { return await response.json(); }
  catch (error) {
    if (error instanceof OwnershipRefusal) throw error;
    throw invalidResponse('Cloudflare API returned invalid JSON', error);
  }
}
function responseIsJson(response) {
  let contentType;
  try {
    if (typeof response.headers?.get === 'function') contentType = response.headers.get('content-type');
    else if (isRecord(response.headers)) contentType = response.headers['content-type'] ?? response.headers['Content-Type'];
  } catch (error) {
    if (error instanceof OwnershipRefusal) throw error;
    throw invalidResponse('Cloudflare API returned invalid response headers', error);
  }
  if (contentType === undefined || contentType === null) return false;
  if (typeof contentType !== 'string') throw invalidResponse('Cloudflare API returned invalid response headers');
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  return mediaType.endsWith('/json') || mediaType.endsWith('+json');
}
function successfulPayload(response, payload, { allowNotFound = false } = {}) {
  if (!isRecord(payload) || typeof payload.success !== 'boolean') throw invalidResponse('Cloudflare API returned a malformed envelope');
  if (payload.success === false) {
    if (!validFailureEnvelope(payload)) throw invalidResponse('Cloudflare API returned a malformed error envelope');
    if (authOrPermissionEnvelope(payload)) throw diagnostic('API_AUTH_OR_PERMISSION', new Error('Cloudflare API denied authorization'));
    if (allowNotFound && explicitNotFound(response, payload)) return null;
    if ((Object.hasOwn(payload, 'result') && payload.result !== null)
        || (Object.hasOwn(payload, 'result_info') && !validResultInfo(payload.result_info))) throw invalidResponse('Cloudflare API returned malformed result metadata');
    throw requestFailed('Cloudflare API request failed');
  }
  if (!response.ok) throw requestFailed('Cloudflare API request failed');
  return payload;
}
async function jsonRequest(client, url, options = {}, { allowNotFound = false } = {}) {
  const response = await fetchResponse(client, url, options);
  return successfulPayload(response, await responseJson(response), { allowNotFound });
}
function explicitNotFound(response, payload) {
  const conflictingError = /permission|unauthori[sz]ed|forbidden|authentication|access denied|internal (?:server|service)|service (?:error|unavailable)|temporarily unavailable/i;
  return [400, 404].includes(response.status) && payload?.success === false && Array.isArray(payload.errors) && payload.errors.length > 0
    && payload.errors.every((error) => error?.code === 10007 && (error.message === undefined || (typeof error.message === 'string' && !conflictingError.test(error.message))));
}
async function exactScriptExists(client) {
  const response = await fetchResponse(client, `${client.base}/scripts/${encodeURIComponent(client.name)}`);
  if (response.ok) {
    if (!responseIsJson(response)) return true;
    successfulPayload(response, await responseJson(response));
    throw invalidResponse('Cloudflare exact-name endpoint returned an unexpected JSON success envelope');
  }
  return successfulPayload(response, await responseJson(response), { allowNotFound: true }) === null ? false : true;
}
// These three official endpoints use pages. A cursor from a different API cannot
// prove exhaustion when the requested page metadata is missing.
async function listAll(client, path, { query = {}, items = (payload) => payload.result, allowNotFound = false } = {}) {
  const results = []; let totalPages, perPage, totalCount;
  for (let page = 1; page <= 100000; page++) {
    const url = new URL(`${client.base}/${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const payload = await jsonRequest(client, url.toString(), {}, { allowNotFound });
    if (payload === null) {
      if (page !== 1) throw invalidResponse('Cloudflare pagination endpoint vanished before termination');
      return null;
    }
    const values = items(payload); const info = payload.result_info;
    if (!Array.isArray(values) || !info || typeof info !== 'object' || Array.isArray(info)) throw invalidResponse('Cloudflare pagination metadata is missing or malformed');
    if (!Number.isSafeInteger(info.page) || info.page !== page || !Number.isSafeInteger(info.per_page) || info.per_page < 1 || info.per_page > 100
        || !Number.isSafeInteger(info.total_pages) || info.total_pages < 0 || info.total_pages > 100000 || values.length > info.per_page
        || !Number.isSafeInteger(info.count) || info.count !== values.length || !Number.isSafeInteger(info.total_count) || info.total_count < 0
        || (info.total_pages === 0 && (page !== 1 || values.length !== 0)) || (info.total_pages > 0 && page > info.total_pages)) throw invalidResponse('Cloudflare pagination page is missing, malformed, or non-advancing');
    const expectedPages = Math.ceil(info.total_count / info.per_page);
    if ((info.total_count === 0 ? info.total_pages > 1 : info.total_pages !== expectedPages)
        || info.count !== Math.min(info.per_page, Math.max(0, info.total_count - (page - 1) * info.per_page))) throw invalidResponse('Cloudflare pagination counts and page capacity are inconsistent');
    if (totalPages !== undefined && (totalPages !== info.total_pages || perPage !== info.per_page || totalCount !== info.total_count)) throw invalidResponse('Cloudflare pagination pages are inconsistent');
    totalPages = info.total_pages; perPage = info.per_page; totalCount = info.total_count;
    results.push(...values);
    if (page >= totalPages) {
      if (results.length !== totalCount) throw invalidResponse('Cloudflare pagination cumulative count is inconsistent');
      return results;
    }
  }
  throw invalidResponse('Cloudflare pagination did not terminate');
}
export async function findExactWorker(options) {
  const client = inputs(options); const workers = await listAll(client, 'workers');
  const seen = new Map();
  for (const worker of workers) {
    if (typeof worker?.id !== 'string' || !/^[a-f0-9]{32}$/i.test(worker.id) || typeof worker.name !== 'string' || !worker.name || worker.name.trim() !== worker.name) throw invalidResponse('Cloudflare API returned an invalid immutable Worker identity');
    const id = worker.id.toLowerCase();
    if (seen.has(id)) throw invalidResponse(seen.get(id) === worker.name ? 'Cloudflare pagination returned duplicate Worker identities' : 'Cloudflare pagination returned conflicting names for an immutable Worker identity');
    seen.set(id, worker.name);
  }
  const matches = workers.filter((worker) => worker?.name === client.name);
  if (matches.length > 1) throw invalidResponse('Cloudflare pagination returned duplicate exact Worker identities');
  if (!matches.length) return null;
  if (typeof matches[0].id !== 'string' || !/^[a-f0-9]{32}$/i.test(matches[0].id)) throw invalidResponse('Cloudflare API returned an invalid immutable Worker ID');
  const worker = Object.freeze({ id: matches[0].id.toLowerCase(), name: client.name });
  normalizedWorkers.set(worker, client.base);
  return worker;
}
export async function listLegacyExactScript(options) {
  const client = inputs(options); let exactExists = false;
  if (options.includeExact === true) exactExists = await exactScriptExists(client);
  const scripts = await listAll(client, 'scripts-search', { query: { name: client.name } });
  const seen = new Set();
  for (const script of scripts) {
    if (typeof script?.script_name !== 'string' || !script.script_name || script.script_name.trim() !== script.script_name) throw invalidResponse('Cloudflare API returned an invalid legacy script identity');
    if (seen.has(script.script_name)) throw invalidResponse('Cloudflare pagination returned duplicate legacy script identities');
    seen.add(script.script_name);
  }
  const matches = scripts.filter((script) => script?.script_name === client.name);
  if (matches.length > 1) throw invalidResponse('Cloudflare pagination returned duplicate exact legacy scripts');
  return matches.length || exactExists ? { name: client.name } : null;
}
function normalizedVersion(result, expectedId) {
  if (!result || result.id !== expectedId || typeof result.id !== 'string' || !result.id.trim()) throw invalidResponse('Cloudflare API did not verify the immutable version ID');
  const resources = result.resources;
  if (!resources || typeof resources.script?.etag !== 'string' || !resources.script.etag.trim() || !Array.isArray(resources.bindings)
      || !resources.script_runtime || typeof resources.script_runtime !== 'object' || Array.isArray(resources.script_runtime)) throw invalidResponse('Cloudflare immutable version resource metadata is missing or malformed');
  const tag = result.annotations?.['workers/tag'];
  return { id: result.id, ownershipTag: typeof tag === 'string' ? tag : null, scriptETag: resources.script.etag,
    versionConfigurationSha256: createHash('sha256').update(canonicalJson({ bindings: resources.bindings, script_runtime: resources.script_runtime })).digest('hex') };
}
export async function readWorkerVersions(options) {
  const client = inputs(options); const path = `scripts/${encodeURIComponent(client.name)}/versions`;
  const versions = options.versionId === undefined ? await listAll(client, path, { items: (payload) => payload.result?.items, allowNotFound: true }) : [{ id: options.versionId }];
  if (versions === null) return { status: 'ABSENT_ENDPOINT', versions: [] };
  const seen = new Set(); const records = [];
  for (const version of versions) {
    if (typeof version?.id !== 'string' || !version.id || version.id.trim() !== version.id) throw invalidResponse('Cloudflare immutable version ID is malformed');
    if (seen.has(version.id)) throw invalidResponse('Cloudflare pagination returned duplicate immutable versions');
    seen.add(version.id);
    const payload = await jsonRequest(client, `${client.base}/${path}/${encodeURIComponent(version.id)}`);
    records.push(normalizedVersion(payload.result, version.id));
  }
  return { status: 'PRESENT', versions: records };
}
export async function disableWorkersDevSubdomain(options) {
  const client = inputs(options);
  verifiedExactWorker(options.worker, client);
  let payload;
  try {
    payload = await jsonRequest(client, `${client.base}/scripts/${encodeURIComponent(client.name)}/subdomain`, { method: 'DELETE' }, { allowNotFound: true });
  } catch (error) {
    if (error instanceof OwnershipRefusal) throw error;
    throw new OwnershipRefusal('Refusing object deletion: workers.dev mapping disable response could not be verified');
  }
  if (payload === null) return { disabled: false, absent: true };
  const result = payload.result;
  if (payload.success !== true || !result || typeof result !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(result))
      || result.enabled !== false || result.previews_enabled !== false) throw new OwnershipRefusal('Refusing object deletion: workers.dev mapping disable response did not confirm disabled settings');
  return { disabled: true, absent: false };
}
function verifiedExactWorker(worker, client) {
  if (!worker || normalizedWorkers.get(worker) !== client.base || worker.name !== client.name) throw new Error('A normalized verified exact temporary Worker object is required');
  if (typeof worker.id !== 'string' || !/^[a-f0-9]{32}$/.test(worker.id)) throw new Error('A verified immutable temporary Worker ID is required');
  return worker;
}
export async function deleteExactWorker(options) {
  const client = inputs(options); const worker = options.worker;
  verifiedExactWorker(worker, client);
  const path = `workers/${encodeURIComponent(worker.id)}`;
  await jsonRequest(client, `${client.base}/${path}`, { method: 'DELETE' });
  return { deleted: true };
}
export async function confirmExactAbsence(options) {
  const client = inputs(options);
  if (await exactScriptExists(client)) throw diagnostic('TEMPORARY_WORKER_COLLISION', new Error('Temporary Worker collision: exact name already exists'));
  const worker = await findExactWorker(options);
  if (worker) throw diagnostic('TEMPORARY_WORKER_COLLISION', new Error('Temporary Worker collision: exact name already exists'));
  const legacy = await listLegacyExactScript(options);
  if (legacy) throw diagnostic('TEMPORARY_WORKER_COLLISION', new Error('Temporary Worker collision: exact name already exists'));
  return { absent: true };
}

export class OwnershipRefusal extends Error {}
export function observeImmutableVersions(versions, observedVersions) {
  for (const version of versions) {
    const metadata = canonicalJson(version);
    if (observedVersions.has(version.id) && observedVersions.get(version.id) !== metadata) throw new OwnershipRefusal('Refusing mutation: previously observed immutable version metadata changed');
    observedVersions.set(version.id, metadata);
  }
}
export async function readOwnershipSnapshot(options) {
  try {
    const worker = await findExactWorker(options);
    const legacy = await listLegacyExactScript({ ...options, includeExact: true });
    if (!worker && !legacy) return null;
    if (!worker) throw new OwnershipRefusal('Refusing mutation: legacy-only Worker identity is inconsistent');
    if (options.expectedWorkerId !== undefined && worker.id !== options.expectedWorkerId) throw new OwnershipRefusal('Refusing mutation: immutable Worker object changed after deployment');
    const versionEvidence = await readWorkerVersions(options);
    observeImmutableVersions(versionEvidence.versions, options.observedVersions ?? new Map());
    if (versionEvidence.versions.length === 0 && legacy) throw new OwnershipRefusal('Refusing mutation: empty version evidence with an existing legacy script does not prove an undeployed placeholder');
    if (versionEvidence.versions.some((version) => version.ownershipTag !== options.ownershipTag)) throw new OwnershipRefusal('Refusing mutation: immutable Worker version ownership tag is missing or mismatched');
    return { worker, legacy, versionEvidence };
  } catch (error) {
    if (error instanceof OwnershipRefusal) throw error;
    throw new OwnershipRefusal('Refusing mutation: complete Worker ownership evidence could not be verified', { cause: error });
  }
}
export function sameOwnershipSnapshot(actual, expected) {
  const normalize = (snapshot) => snapshot === null ? null : { ...snapshot,
    currentVersionId: snapshot.versionEvidence.versions[0]?.id ?? null,
    versionEvidence: { ...snapshot.versionEvidence, versions: [...snapshot.versionEvidence.versions].sort((a, b) => a.id.localeCompare(b.id)) } };
  if (canonicalJson(normalize(actual)) !== canonicalJson(normalize(expected))) throw new OwnershipRefusal('Refusing mutation: Worker ownership snapshot changed before mutation');
}
