import { createHash } from 'node:crypto';
import { canonicalJson } from './remote-dds-soak-state.mjs';

function temporaryName(value) {
  const uuid = /^ss-dds-soak-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const github = /^ss-dds-soak-gh-[0-9]+-[0-9]+-[a-z0-9_-]{12}$/;
  if (typeof value !== 'string' || value.length > 63 || (!uuid.test(value) && !github.test(value))) throw new Error('An exact generated temporary Worker identity is required');
  return value.toLowerCase();
}
function inputs(options) {
  const { accountId, apiToken, fetchImpl = fetch } = options;
  if (typeof accountId !== 'string' || !accountId || typeof apiToken !== 'string' || !apiToken) throw new Error('Cloudflare API requires account and token');
  return { base: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers`, name: temporaryName(options.temporaryWorkerName), fetchImpl, headers: { authorization: `Bearer ${apiToken}` } };
}
async function jsonRequest(client, url, options = {}, { allowNotFound = false } = {}) {
  const response = await client.fetchImpl(url, { ...options, headers: { ...client.headers, ...options.headers } });
  if (allowNotFound && response.status === 404) return null;
  let payload; try { payload = await response.json(); } catch { throw new Error('Cloudflare API returned invalid JSON'); }
  if (allowNotFound && !response.ok && payload?.success === false && Array.isArray(payload.errors) && payload.errors.some((error) => error?.code === 10007)) return null;
  if (!response.ok || payload?.success !== true) throw new Error('Cloudflare API request failed');
  return payload;
}
// These three official endpoints use pages. A cursor from a different API cannot
// prove exhaustion when the requested page metadata is missing.
async function listAll(client, path, { query = {}, items = (payload) => payload.result, allowNotFound = false } = {}) {
  const results = []; let totalPages, perPage;
  for (let page = 1; page <= 100000; page++) {
    const url = new URL(`${client.base}/${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const payload = await jsonRequest(client, url.toString(), {}, { allowNotFound });
    if (payload === null) {
      if (page !== 1) throw new Error('Cloudflare pagination endpoint vanished before termination');
      return null;
    }
    const values = items(payload); const info = payload.result_info;
    if (!Array.isArray(values) || !info || typeof info !== 'object' || Array.isArray(info)) throw new Error('Cloudflare pagination metadata is missing or malformed');
    if (!Number.isSafeInteger(info.page) || info.page !== page || !Number.isSafeInteger(info.per_page) || info.per_page < 1 || info.per_page > 100
        || !Number.isSafeInteger(info.total_pages) || info.total_pages < 0 || info.total_pages > 100000 || values.length > info.per_page
        || (info.total_pages === 0 && (page !== 1 || values.length !== 0)) || (info.total_pages > 0 && page > info.total_pages)) throw new Error('Cloudflare pagination page is missing, malformed, or non-advancing');
    if (totalPages !== undefined && (totalPages !== info.total_pages || perPage !== info.per_page)) throw new Error('Cloudflare pagination pages are inconsistent');
    totalPages = info.total_pages; perPage = info.per_page;
    results.push(...values);
    if (page >= totalPages) return results;
  }
  throw new Error('Cloudflare pagination did not terminate');
}
export async function findExactWorker(options) {
  const client = inputs(options); const workers = await listAll(client, 'workers');
  const matches = workers.filter((worker) => worker?.name === client.name);
  if (matches.length > 1) throw new Error('Cloudflare pagination returned duplicate exact Worker identities');
  if (!matches.length) return null;
  if (typeof matches[0].id !== 'string' || !/^[a-f0-9]{32}$/i.test(matches[0].id)) throw new Error('Cloudflare API returned an invalid immutable Worker ID');
  return { id: matches[0].id, name: client.name };
}
export async function listLegacyExactScript(options) {
  const client = inputs(options); let exactExists = false;
  if (options.includeExact === true) {
    const exact = await client.fetchImpl(`${client.base}/scripts/${encodeURIComponent(client.name)}`, { headers: client.headers });
    if (exact.ok) exactExists = true;
    else if (exact.status !== 404) throw new Error('Cloudflare exact-name endpoint could not prove absence');
  }
  const scripts = await listAll(client, 'scripts-search', { query: { name: client.name } });
  const matches = scripts.filter((script) => script?.script_name === client.name);
  if (matches.length > 1) throw new Error('Cloudflare pagination returned duplicate exact legacy scripts');
  return matches.length || exactExists ? { name: client.name } : null;
}
function normalizedVersion(result, expectedId) {
  if (!result || result.id !== expectedId || typeof result.id !== 'string' || !result.id.trim()) throw new Error('Cloudflare API did not verify the immutable version ID');
  const resources = result.resources;
  if (!resources || typeof resources.script?.etag !== 'string' || !resources.script.etag.trim() || !Array.isArray(resources.bindings)
      || !resources.script_runtime || typeof resources.script_runtime !== 'object' || Array.isArray(resources.script_runtime)) throw new Error('Cloudflare immutable version resource metadata is missing or malformed');
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
    if (typeof version?.id !== 'string' || !version.id || version.id.trim() !== version.id) throw new Error('Cloudflare immutable version ID is malformed');
    if (seen.has(version.id)) throw new Error('Cloudflare pagination returned duplicate immutable versions');
    seen.add(version.id);
    const payload = await jsonRequest(client, `${client.base}/${path}/${encodeURIComponent(version.id)}`);
    records.push(normalizedVersion(payload.result, version.id));
  }
  return { status: 'PRESENT', versions: records };
}
export async function disableWorkersDevSubdomain(options) {
  const client = inputs(options);
  await jsonRequest(client, `${client.base}/scripts/${encodeURIComponent(client.name)}/subdomain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, previews_enabled: false }) });
  return { disabled: true };
}
export async function deleteExactWorker(options) {
  const client = inputs(options); const worker = options.worker;
  if (!worker || worker.name !== client.name) throw new Error('A verified exact temporary Worker object is required');
  if (typeof worker.id !== 'string' || !/^[a-f0-9]{32}$/i.test(worker.id)) throw new Error('A verified immutable temporary Worker ID is required');
  const path = `workers/${encodeURIComponent(worker.id)}`;
  await jsonRequest(client, `${client.base}/${path}`, { method: 'DELETE' });
  return { deleted: true };
}
export async function confirmExactAbsence(options) {
  const client = inputs(options);
  const exact = await client.fetchImpl(`${client.base}/scripts/${encodeURIComponent(client.name)}`, { headers: client.headers });
  if (exact.ok) throw new Error('Temporary Worker collision: exact name already exists');
  if (exact.status !== 404) throw new Error('Cloudflare exact-name endpoint could not prove absence');
  const worker = await findExactWorker(options);
  const legacy = await listLegacyExactScript(options);
  if (worker || legacy) throw new Error('Temporary Worker collision: exact name already exists');
  return { absent: true };
}
