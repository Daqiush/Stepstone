const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const CONTEXT = { repository: 'Daqiush/Stepstone', workflow: 'Remote DDS Soak', runId: '123456789', runAttempt: '2', commitSha: 'a'.repeat(40) };
const TOKEN = 'cleanup-fake-source-token', WORKER_ID = 'a'.repeat(32);
const mod = () => import('../scripts/cleanup-remote-dds-deployment.mjs');
const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(payload) });
const notFound = () => response({ success: false, errors: [{ code: 10007, message: 'Worker not found' }] }, 404);
const page = (items, number = 1, total = 1, capacity = 100, count = items.length) => ({ success: true, result: items, result_info: { page: number, total_pages: total, per_page: capacity, count: items.length, total_count: count } });
const versionPage = (items, ...args) => ({ ...page(items, ...args), result: { items } });
async function assertCleanupDiagnostic(thunk, expectedCode, expected = {}) {
  const { publicDiagnosticCode } = await import('../scripts/remote-dds-public-errors.mjs');
  await assert.rejects(thunk, (error) => {
    assert.equal(publicDiagnosticCode(error), expectedCode);
    assert.equal(error.cleanupResult?.version, 2);
    assert.equal(error.cleanupResult?.status, 'failed');
    assert.equal(error.cleanupResult?.failureCode, expectedCode);
    assert.equal(error.cleanupResult?.currentAbsent, false);
    assert.equal(error.cleanupResult?.legacyAbsent, false);
    for (const [key, value] of Object.entries(expected)) assert.equal(error.cleanupResult?.[key], value, key);
    return true;
  });
}

const NEW_CLEANUP_DIAGNOSTICS = [
  'CLEANUP_IDENTITY_INVALID',
  'CLEANUP_OWNERSHIP_UNVERIFIED',
  'CLEANUP_ENDPOINT_UNVERIFIED',
  'CLEANUP_SUBDOMAIN_DISABLE_FAILED',
  'CLEANUP_DELETE_FAILED',
  'CLEANUP_ABSENCE_UNVERIFIED',
  'CLEANUP_RESULT_WRITE_FAILED',
  'CLEANUP_OWNERSHIP_READ_TIMEOUT',
  'CLEANUP_SUBDOMAIN_LOOKUP_TIMEOUT',
  'CLEANUP_SUBDOMAIN_DISABLE_TIMEOUT',
  'CLEANUP_ENDPOINT_PROBE_TIMEOUT',
  'CLEANUP_REVERIFY_TIMEOUT',
  'CLEANUP_DELETE_TIMEOUT',
  'CLEANUP_FINAL_ABSENCE_TIMEOUT',
];

test('every staged cleanup and timeout diagnostic has an exact leak-free public line', async () => {
  const errors = await import('../scripts/remote-dds-public-errors.mjs');
  const privateMarkers = [
    'cleanup-account-id-private-marker',
    'cleanup-api-token-private-marker',
    'cleanup-test-key-private-marker',
    'C:\\private\\remote-dds\\cleanup-marker',
    'https://cleanup-private-marker.example.invalid/worker?key=secret',
    'cleanup-stack-frame-private-marker',
    'CLEANUP_ARBITRARY_INTERNAL_CODE_MARKER',
    'raw cleanup deletion stage marker',
  ];
  const cause = new Error(privateMarkers.join(' '));
  cause.stack = privateMarkers.join('\n');
  Object.assign(cause, {
    accountId: privateMarkers[0], token: privateMarkers[1], testKey: privateMarkers[2],
    path: privateMarkers[3], url: privateMarkers[4], code: privateMarkers[6], stage: privateMarkers[7],
  });

  for (const code of NEW_CLEANUP_DIAGNOSTICS) {
    const error = errors.diagnostic(code, cause);
    assert.equal(errors.publicDiagnosticCode(error), code);
    const output = errors.renderRemoteDdsCleanupFailure(error);
    assert.equal(output, `Remote DDS cleanup failed [${code}].`);
    for (const marker of privateMarkers) assert.equal(output.includes(marker), false, `${code}: ${marker}`);
  }

  const forged = { code: 'CLEANUP_DELETE_FAILED', cause };
  assert.equal(errors.renderRemoteDdsCleanupFailure(forged), 'Remote DDS cleanup failed [UNKNOWN].');
  for (const marker of privateMarkers) {
    assert.equal(errors.renderRemoteDdsCleanupFailure(forged).includes(marker), false, marker);
  }
});

async function fixture() {
  const identityApi = await import('../scripts/remote-dds-ci-identity.mjs');
  const { canonicalJson } = await import('../scripts/remote-dds-soak-state.mjs');
  const trusted = identityApi.deriveCiIdentity({ ...CONTEXT, secret: TOKEN });
  const identity = identityApi.createPreDeploymentIdentity({ identity: trusted, noCollisionVerifiedAt: '2026-10-01T00:00:00.000Z' });
  const resources = { script: { etag: 'observed-etag' }, bindings: [{ type: 'plain_text', name: 'DDS_REMOTE_TEST', text: 'true' }], script_runtime: { compatibility_date: '2026-09-22' } };
  const detail = { id: 'deployed-v1', annotations: { 'workers/tag': identity.ownershipTag }, resources };
  const endpoint = `https://${identity.workerName}.example.workers.dev`;
  const record = { schemaVersion: 1, kind: 'remote-dds-deployment-record', identity, endpoint, version: 2, deploymentManifestVersion: 2,
    workerId: WORKER_ID, workerVersionId: 'deployed-v1', buildId: '1'.repeat(64), wranglerVersion: '4.33.0',
    assets: { wasm: { path: 'workers/vendor/bridge-dds/dds-worker.wasm', bytes: 4, sha256: '2'.repeat(64) }, harness: {
      'workers/src/index.mjs': { path: 'workers/src/index.mjs', bytes: 8, sha256: '3'.repeat(64) } } },
    verifiedDeployment: { workerId: WORKER_ID, versionId: 'deployed-v1', apiVerified: true, wranglerVersion: '4.33.0', temporaryWorkerName: identity.workerName, ownershipTag: identity.ownershipTag },
    ownershipTag: identity.ownershipTag, localConfigurationSha256: '4'.repeat(64), scriptETag: resources.script.etag,
    versionConfigurationSha256: createHash('sha256').update(canonicalJson({ bindings: resources.bindings, script_runtime: resources.script_runtime })).digest('hex') };
  record.buildId = createHash('sha256').update(canonicalJson({ version: 2, assets: record.assets })).digest('hex');
  const state = { present: true, mapping: true, legacy: true, versionsAbsent: false, workerId: WORKER_ID, details: [detail], probeStatus: 404, subdomain: 'example' };
  const calls = [];
  let intercept = async () => undefined;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url), path = parsed.pathname, method = init.method ?? 'GET';
    calls.push({ url, method, init });
    const custom = await intercept({ url, init, parsed, method, state, calls });
    if (custom !== undefined) return custom;
    if (parsed.hostname.endsWith('.workers.dev')) { assert.equal(url, endpoint); assert.equal(init.redirect, 'manual'); assert.equal(method, 'GET'); assert.equal(init.headers, undefined); return response({}, state.probeStatus); }
    if (method === 'DELETE' && path.endsWith('/subdomain')) {
      assert.ok(path.endsWith(`/scripts/${identity.workerName}/subdomain`));
      if (!state.mapping) return notFound();
      state.mapping = false; return response({ success: true, result: { enabled: false, previews_enabled: false }, errors: [], messages: [] });
    }
    if (method === 'DELETE') { assert.ok(path.endsWith('/workers/' + state.workerId)); state.present = false; state.legacy = false; return response({ success: true }); }
    assert.equal(method, 'GET', 'cleanup must not create any Worker version');
    if (path.endsWith('/workers/workers')) return response(page(state.present ? [{ id: state.workerId, name: identity.workerName }] : []));
    if (path.endsWith(`/scripts/${identity.workerName}`)) return state.present && state.legacy ? response({}) : notFound();
    if (path.endsWith('/scripts-search')) return response(page(state.present && state.legacy ? [{ script_name: identity.workerName }] : []));
    if (path.endsWith('/versions')) return state.versionsAbsent ? notFound() : response(versionPage(state.details.map(({ id }) => ({ id }))));
    const version = state.details.find(({ id }) => path.endsWith('/versions/' + id));
    if (version) return response({ success: true, result: version });
    if (path.endsWith('/workers/subdomain')) return response({ success: true, result: { subdomain: state.subdomain } });
    throw new Error('Unexpected fake request');
  };
  return { identity, record, endpoint, state, calls, fetchImpl,
    options: { accountId: 'fake-account', apiToken: TOKEN, context: CONTEXT, preDeploymentIdentity: identity, deploymentRecord: record, fetchImpl },
    intercept: (fn) => { intercept = fn; }, mutations: () => calls.filter(({ method }) => method !== 'GET') };
}

test('fully attested cleanup reads all ownership evidence, disables the exact mapping, probes, revalidates, deletes ID, then proves absence', async () => {
  const m = await mod(), f = await fixture();
  const result = await m.cleanupRemoteDdsDeployment(f.options);
  assert.deepEqual(result, { version: 2, status: 'deleted', ...CONTEXT, workerName: f.identity.workerName,
    subdomainDisabled: true, objectDeleted: true, currentAbsent: true, legacyAbsent: true, failureCode: null });
  const mutations = f.mutations(); assert.equal(mutations.length, 2);
  const disable = f.calls.indexOf(mutations[0]), deletion = f.calls.indexOf(mutations[1]);
  const probe = f.calls.findIndex(({ url }) => url === f.endpoint);
  assert.ok(disable < probe && probe < deletion);
  for (const suffix of ['/workers/workers', '/scripts-search', '/versions', '/versions/deployed-v1', '/workers/subdomain']) {
    assert.ok(f.calls.slice(0, disable).some(({ url }) => new URL(url).pathname.endsWith(suffix)), suffix + ' must be read before first mutation');
    assert.ok(f.calls.slice(probe + 1, deletion).some(({ url }) => new URL(url).pathname.endsWith(suffix)), suffix + ' must be reread before delete');
  }
  assert.ok(f.calls.slice(deletion + 1).some(({ url }) => new URL(url).pathname.endsWith('/workers/workers')));
  assert.ok(f.calls.slice(deletion + 1).some(({ url }) => new URL(url).pathname.endsWith('/scripts-search')));
  assert.equal(mutations[0].method, 'DELETE'); assert.ok(mutations[0].url.endsWith(`/scripts/${f.identity.workerName}/subdomain`));
  assert.ok(mutations[1].url.endsWith('/workers/' + WORKER_ID));
});

test('cleanup direct account lookup and former-endpoint probe receive composed signals', async () => {
  const m = await mod(), f = await fixture();
  await m.cleanupRemoteDdsDeployment(f.options);
  const direct = f.calls.filter(({ url }) => new URL(url).pathname.endsWith('/workers/subdomain') || url === f.endpoint);
  assert.ok(direct.length >= 3);
  for (const call of direct) assert.equal(call.init.signal instanceof AbortSignal, true, call.url);
});

test('cleanup identity failure is classified before any network request', async () => {
  const m = await mod(), f = await fixture();
  await assertCleanupDiagnostic(() => m.cleanupRemoteDdsDeployment({ ...f.options, accountId: '' }), 'CLEANUP_IDENTITY_INVALID');
  assert.equal(f.calls.length, 0);
});

for (const [label, configure, code, evidence] of [
  ['initial ownership read', (f) => f.intercept(async ({ parsed, method }) => {
    if (method === 'GET' && parsed.pathname.endsWith('/workers/workers')) throw new DOMException('private-timeout', 'TimeoutError');
  }), 'CLEANUP_OWNERSHIP_READ_TIMEOUT', { subdomainDisabled: false, objectDeleted: false }],
  ['subdomain lookup', (f) => f.intercept(async ({ parsed, method }) => {
    if (method === 'GET' && parsed.pathname.endsWith('/workers/subdomain')) throw new DOMException('private-timeout', 'TimeoutError');
  }), 'CLEANUP_SUBDOMAIN_LOOKUP_TIMEOUT', { subdomainDisabled: false, objectDeleted: false }],
  ['subdomain disable', (f) => f.intercept(async ({ parsed, method }) => {
    if (method === 'DELETE' && parsed.pathname.endsWith('/subdomain')) throw new DOMException('private-timeout', 'TimeoutError');
  }), 'CLEANUP_SUBDOMAIN_DISABLE_TIMEOUT', { subdomainDisabled: false, objectDeleted: false }],
  ['endpoint probe', (_f) => ({ probeImpl: async () => { throw new DOMException('private-timeout', 'TimeoutError'); } }),
    'CLEANUP_ENDPOINT_PROBE_TIMEOUT', { subdomainDisabled: true, objectDeleted: false }],
  ['ownership reverify', (f) => { let reads = 0; f.intercept(async ({ parsed, method }) => {
    if (method === 'GET' && parsed.pathname.endsWith('/workers/workers') && ++reads === 2) throw new DOMException('private-timeout', 'TimeoutError');
  }); }, 'CLEANUP_REVERIFY_TIMEOUT', { subdomainDisabled: true, objectDeleted: false }],
  ['delete', (f) => f.intercept(async ({ parsed, method }) => {
    if (method === 'DELETE' && !parsed.pathname.endsWith('/subdomain')) throw new DOMException('private-timeout', 'TimeoutError');
  }), 'CLEANUP_DELETE_TIMEOUT', { subdomainDisabled: true, objectDeleted: false }],
  ['final absence', (f) => f.intercept(async ({ parsed, method, state }) => {
    if (method === 'GET' && !state.present && parsed.pathname.endsWith('/workers/workers')) throw new DOMException('private-timeout', 'TimeoutError');
  }), 'CLEANUP_FINAL_ABSENCE_TIMEOUT', { subdomainDisabled: true, objectDeleted: true }],
]) test('cleanup timeout classification: ' + label, async () => {
  const m = await mod(), f = await fixture();
  const changes = configure(f) ?? {};
  await assertCleanupDiagnostic(() => m.cleanupRemoteDdsDeployment({ ...f.options, ...changes }), code, evidence);
});

test('cleanup mutation and final-absence failures retain only confirmed evidence', async () => {
  const m = await mod();
  {
    const f = await fixture();
    f.intercept(async ({ parsed, method }) => {
      if (method === 'DELETE' && !parsed.pathname.endsWith('/subdomain')) throw new Error('private-delete-marker');
    });
    await assertCleanupDiagnostic(() => m.cleanupRemoteDdsDeployment(f.options), 'CLEANUP_DELETE_FAILED',
      { subdomainDisabled: true, objectDeleted: false });
  }
  {
    const f = await fixture();
    f.intercept(async ({ parsed, method, state }) => {
      if (method === 'GET' && !state.present && parsed.pathname.endsWith('/workers/workers')) return response(page([{ id: WORKER_ID, name: f.identity.workerName }]));
    });
    await assertCleanupDiagnostic(() => m.cleanupRemoteDdsDeployment(f.options), 'CLEANUP_ABSENCE_UNVERIFIED',
      { subdomainDisabled: true, objectDeleted: true });
  }
});

for (const shape of ['owned versions', 'empty versions', 'absent version endpoint']) test('predeployment-only recovery accepts ' + shape, async () => {
  const m = await mod(), f = await fixture();
  if (shape !== 'owned versions') { f.state.details = []; f.state.legacy = false; f.state.versionsAbsent = shape === 'absent version endpoint'; }
  const result = await m.cleanupRemoteDdsDeployment({ ...f.options, deploymentRecord: undefined });
  assert.equal(result.status, 'deleted'); assert.equal(f.mutations().length, 2);
});

test('already absent exact name is successful without mutations or endpoint probe', async () => {
  const m = await mod(), f = await fixture(); f.state.present = false; f.state.legacy = false;
  const result = await m.cleanupRemoteDdsDeployment(f.options);
  assert.equal(result.status, 'already-absent'); assert.equal(result.currentAbsent, true); assert.equal(result.legacyAbsent, true);
  assert.equal(result.objectDeleted, false); assert.equal(f.mutations().length, 0);
});

for (const drift of ['worker ID', 'version', 'tag', 'missing tag', 'ETag', 'config', 'endpoint']) test('deployment evidence mismatch rejects ' + drift + ' before any mutation', async () => {
  const m = await mod(), f = await fixture();
  if (drift === 'worker ID') f.state.workerId = 'b'.repeat(32);
  if (drift === 'version') f.state.details[0].id = 'other-v1';
  if (drift === 'tag') f.state.details[0].annotations['workers/tag'] = 'b'.repeat(43);
  if (drift === 'missing tag') f.state.details[0].annotations = {};
  if (drift === 'ETag') f.state.details[0].resources.script.etag = 'changed';
  if (drift === 'config') f.state.details[0].resources.bindings = [];
  if (drift === 'endpoint') f.state.subdomain = 'other';
  await assert.rejects(() => m.cleanupRemoteDdsDeployment(f.options), /ownership|immutable|evidence|endpoint|refus|match/i);
  assert.equal(f.mutations().length, 0);
});

for (const drift of ['name', 'tag', 'timestamp', 'context', 'missing attestation', 'missing object ID', 'nested object ID', 'build ID', 'assets']) test('invalid trusted input rejects ' + drift + ' before network', async () => {
  const m = await mod(), f = await fixture(), options = structuredClone({ ...f.options, fetchImpl: undefined }); options.fetchImpl = f.fetchImpl;
  if (drift === 'name') options.preDeploymentIdentity.workerName = 'ss-dds-soak-gh-1-1-aaaaaaaaaaaa';
  if (drift === 'tag') options.preDeploymentIdentity.ownershipTag = 'b'.repeat(43);
  if (drift === 'timestamp') options.preDeploymentIdentity.noCollisionVerifiedAt = '2026-02-30T00:00:00.000Z';
  if (drift === 'context') options.context.runAttempt = '3';
  if (drift === 'missing attestation') delete options.preDeploymentIdentity;
  if (drift === 'missing object ID') delete options.deploymentRecord.workerId;
  if (drift === 'nested object ID') options.deploymentRecord.verifiedDeployment.workerId = 'b'.repeat(32);
  if (drift === 'build ID') options.deploymentRecord.buildId = 'b'.repeat(64);
  if (drift === 'assets') options.deploymentRecord.assets.wasm.sha256 = 'b'.repeat(64);
  await assert.rejects(() => m.cleanupRemoteDdsDeployment(options)); assert.equal(f.calls.length, 0);
});

for (const drift of ['foreign', 'missing']) test('predeployment-only refuses any ' + drift + ' version ownership', async () => {
  const m = await mod(), f = await fixture();
  const old = structuredClone(f.state.details[0]); old.id = 'older-v1'; old.annotations = drift === 'missing' ? {} : { 'workers/tag': 'b'.repeat(43) }; f.state.details.push(old);
  await assert.rejects(() => m.cleanupRemoteDdsDeployment({ ...f.options, deploymentRecord: undefined })); assert.equal(f.mutations().length, 0);
});

for (const kind of ['current duplicate name', 'current duplicate ID', 'unrelated duplicate ID', 'legacy duplicate', 'unrelated legacy duplicate', 'malformed page', 'incomplete page', 'later malformed page']) test('complete listing rejects ' + kind + ' before mutation', async () => {
  const m = await mod(), f = await fixture();
  f.intercept(async ({ parsed, method }) => {
    if (method !== 'GET') return;
    if (parsed.pathname.endsWith('/workers/workers')) {
      const exact = { id: WORKER_ID, name: f.identity.workerName };
      if (kind === 'current duplicate name') return response(page([exact, { ...exact, id: 'b'.repeat(32) }]));
      if (kind === 'current duplicate ID') return response(page([exact, { ...exact, name: 'other' }]));
      if (kind === 'unrelated duplicate ID') return response(page([exact, { id: 'b'.repeat(32), name: 'other' }, { id: 'b'.repeat(32), name: 'other' }]));
      if (kind === 'malformed page') return response({ success: true, result: {} });
      if (kind === 'incomplete page') return response(page([exact], 1, 2, 100, 101));
      if (kind === 'later malformed page') return parsed.searchParams.get('page') === '1'
        ? response(page([exact], 1, 2, 1, 2)) : response({ success: true, result: [], result_info: { page: 1, per_page: 1 } });
    }
    if (parsed.pathname.endsWith('/scripts-search')) {
      if (kind === 'legacy duplicate') return response(page([{ script_name: f.identity.workerName }, { script_name: f.identity.workerName }]));
      if (kind === 'unrelated legacy duplicate') return response(page([{ script_name: f.identity.workerName }, { script_name: 'other' }, { script_name: 'other' }]));
    }
  });
  await assert.rejects(() => m.cleanupRemoteDdsDeployment(f.options)); assert.equal(f.mutations().length, 0);
});

test('later-page exact current and legacy matches are found through every page', async () => {
  const m = await mod(), f = await fixture();
  f.intercept(async ({ parsed, method }) => {
    if (method !== 'GET') return;
    const number = Number(parsed.searchParams.get('page'));
    if (parsed.pathname.endsWith('/workers/workers')) return response(page(number === 1 ? [{ id: 'c'.repeat(32), name: 'other' }] : f.state.present ? [{ id: f.state.workerId, name: f.identity.workerName }] : [{ id: 'd'.repeat(32), name: 'another' }], number, 2, 1, 2));
    if (parsed.pathname.endsWith('/scripts-search')) return response(page(number === 1 ? [{ script_name: 'near-' + f.identity.workerName }] : f.state.present ? [{ script_name: f.identity.workerName }] : [{ script_name: 'another' }], number, 2, 1, 2));
  });
  assert.equal((await m.cleanupRemoteDdsDeployment(f.options)).status, 'deleted');
});

test('an absent name cannot be proven by broken pagination', async () => {
  const m = await mod(), f = await fixture(); f.state.present = false; f.state.legacy = false;
  f.intercept(async ({ parsed }) => parsed.pathname.endsWith('/workers/workers') ? response({
    success: true,
    result: [{ id: 'c'.repeat(32), name: 'other' }],
    result_info: { page: Number(parsed.searchParams.get('page')), per_page: 100 },
  }) : undefined);
  await assert.rejects(() => m.cleanupRemoteDdsDeployment(f.options)); assert.equal(f.mutations().length, 0);
});

for (const drift of ['ID', 'version', 'tag', 'ETag', 'config']) test('after disabling, ' + drift + ' drift refuses object deletion', async () => {
  const m = await mod(), f = await fixture();
  f.intercept(async ({ parsed }) => {
    if (!parsed.hostname.endsWith('.workers.dev')) return;
    if (drift === 'ID') f.state.workerId = 'b'.repeat(32);
    if (drift === 'version') f.state.details[0].id = 'changed-v1';
    if (drift === 'tag') f.state.details[0].annotations['workers/tag'] = 'b'.repeat(43);
    if (drift === 'ETag') f.state.details[0].resources.script.etag = 'changed';
    if (drift === 'config') f.state.details[0].resources.bindings = [];
  });
  await assert.rejects(() => m.cleanupRemoteDdsDeployment(f.options));
  assert.equal(f.mutations().length, 1); assert.ok(f.mutations()[0].url.endsWith('/subdomain'));
});

for (const status of [200, 301, 403, 500]) test('former endpoint HTTP ' + status + ' fails closed before object deletion', async () => {
  const m = await mod(), f = await fixture(); f.state.probeStatus = status;
  await assert.rejects(() => m.cleanupRemoteDdsDeployment(f.options)); assert.equal(f.mutations().length, 1);
});

for (const code of ['ENOTFOUND', 'ENODATA', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT']) test('DNS/transport ' + code + ' has explicit absence semantics', async () => {
  const m = await mod(), f = await fixture();
  const options = { ...f.options, probeFetchImpl: async () => { throw Object.assign(new TypeError('fake secret-bearing transport error ' + TOKEN), { cause: { code } }); } };
  if (['ENOTFOUND', 'ENODATA'].includes(code)) assert.equal((await m.cleanupRemoteDdsDeployment(options)).status, 'deleted');
  else { await assert.rejects(() => m.cleanupRemoteDdsDeployment(options)); assert.equal(f.mutations().length, 1); }
});

test('interrupted cleanup retries an already absent mapping, then a second complete cleanup mutates nothing', async () => {
  const m = await mod(), f = await fixture(); f.state.mapping = false;
  assert.equal((await m.cleanupRemoteDdsDeployment(f.options)).status, 'deleted');
  const count = f.mutations().length;
  assert.equal((await m.cleanupRemoteDdsDeployment(f.options)).status, 'already-absent');
  assert.equal(f.mutations().length, count); assert.equal(f.mutations().filter(({ url }) => !url.endsWith('/subdomain')).length, 1);
});

test('an interrupted endpoint probe leaves only the mapping disabled and a later invocation resumes deletion', async () => {
  const m = await mod(), f = await fixture(); f.state.probeStatus = 200;
  await assert.rejects(() => m.cleanupRemoteDdsDeployment(f.options));
  assert.equal(f.state.mapping, false); assert.equal(f.state.present, true);
  f.state.probeStatus = 404;
  assert.equal((await m.cleanupRemoteDdsDeployment(f.options)).status, 'deleted');
  assert.equal(f.mutations().filter(({ url }) => !url.endsWith('/subdomain')).length, 1);
  const count = f.calls.length;
  assert.equal((await m.cleanupRemoteDdsDeployment(f.options)).status, 'already-absent');
  assert.ok(f.calls.slice(count).every(({ method }) => method === 'GET'));
});

for (const kind of ['duplicate version', 'malformed versions page', 'missing detail', 'newer owned version']) test('cleanup refuses ' + kind + ' before mutation', async () => {
  const m = await mod(), f = await fixture();
  if (kind === 'newer owned version') { const next = structuredClone(f.state.details[0]); next.id = 'deployed-v2'; f.state.details.unshift(next); }
  f.intercept(async ({ parsed }) => {
    if (parsed.pathname.endsWith('/versions')) {
      if (kind === 'duplicate version') return response(versionPage([{ id: 'deployed-v1' }, { id: 'deployed-v1' }]));
      if (kind === 'malformed versions page') return response({ success: true, result: { items: [] } });
    }
    if (kind === 'missing detail' && parsed.pathname.endsWith('/versions/deployed-v1')) return notFound();
  });
  await assert.rejects(() => m.cleanupRemoteDdsDeployment(f.options)); assert.equal(f.mutations().length, 0);
});

for (const status of [401, 403, 500]) test('subdomain HTTP ' + status + ' with a not-found code cannot authorize object deletion', async () => {
  const m = await mod(), f = await fixture();
  f.intercept(async ({ parsed, method }) => method === 'DELETE' && parsed.pathname.endsWith('/subdomain') ? response({ success: false, errors: [{ code: 10007 }] }, status) : undefined);
  await assert.rejects(() => m.cleanupRemoteDdsDeployment(f.options)); assert.equal(f.mutations().length, 1); assert.equal(f.state.present, true);
});

const disabledPayload = () => ({ success: true, result: { enabled: false, previews_enabled: false }, errors: [], messages: [] });
const invalidDisableReplies = [
  ['missing result', () => response({ success: true })],
  ['null result', () => response({ success: true, result: null })],
  ['string result', () => response({ success: true, result: 'false' })],
  ['array result', () => response({ success: true, result: [] })],
  ['non-plain result', () => { const result = Object.assign(new Date(), { enabled: false, previews_enabled: false }); return { ok: true, status: 200, json: async () => ({ success: true, result }) }; }],
  ['inherited result prototype', () => { const result = Object.assign(Object.create({ foreign: true }), { enabled: false, previews_enabled: false }); return { ok: true, status: 200, json: async () => ({ success: true, result }) }; }],
  ['missing success', () => response({ result: { enabled: false, previews_enabled: false } })],
  ['false success', () => response({ ...disabledPayload(), success: false })],
  ['string success', () => response({ ...disabledPayload(), success: 'true' })],
  ['malformed JSON', () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('fake malformed response'); } })],
  ['empty HTTP 204', () => ({ ok: true, status: 204, json: async () => { throw new SyntaxError('empty response'); } })],
  ['HTTP 404 without typed errors', () => response({ success: false }, 404)],
  ['HTTP 404 mixed errors', () => response({ success: false, errors: [{ code: 10007 }, { code: 10000 }] }, 404)],
  ['HTTP 400 mixed errors', () => response({ success: false, errors: [{ code: 10007 }, { code: 10000 }] }, 400)],
  ['HTTP 404 permission message', () => response({ success: false, errors: [{ code: 10007, message: 'Permission denied' }] }, 404)],
  ...[401, 403, 429, 500, 503].map((status) => [`HTTP ${status} not-found code`, () => response({ success: false, errors: [{ code: 10007 }] }, status)]),
  ...['enabled', 'previews_enabled'].flatMap((field) => [
    [`missing ${field}`, () => { const payload = disabledPayload(); delete payload.result[field]; return response(payload); }],
    ...[true, null, 'false', 0].map((value) => [`${field}=${JSON.stringify(value)}`, () => response({ ...disabledPayload(), result: { ...disabledPayload().result, [field]: value } })]),
  ]),
];
for (const [label, makeReply] of invalidDisableReplies) {
  for (const flow of ['shared helper', 'cleanup']) test(flow + ' refuses unconfirmed subdomain disable: ' + label, async () => {
    const m = await mod(), api = await import('../scripts/cloudflare-temporary-worker-api.mjs'), f = await fixture();
    const options = { ...f.options, temporaryWorkerName: f.identity.workerName };
    const worker = flow === 'shared helper' ? await api.findExactWorker(options) : undefined;
    f.intercept(async ({ parsed, method }) => method === 'DELETE' && parsed.pathname.endsWith('/subdomain') ? makeReply() : undefined);
    const action = flow === 'shared helper' ? () => api.disableWorkersDevSubdomain({ ...options, worker }) : () => m.cleanupRemoteDdsDeployment(f.options);
    const { publicDiagnosticCode } = await import('../scripts/remote-dds-public-errors.mjs');
    await assert.rejects(action, (error) => flow === 'shared helper'
      ? error instanceof api.OwnershipRefusal
      : publicDiagnosticCode(error) === 'CLEANUP_SUBDOMAIN_DISABLE_FAILED'
        && error.cleanupResult?.subdomainDisabled === false && error.cleanupResult.objectDeleted === false);
    assert.equal(f.mutations().filter(({ url }) => !url.endsWith('/subdomain')).length, 0);
    assert.equal(f.calls.filter(({ url }) => url === f.endpoint).length, 0);
  });
}

test('shared helper accepts only an explicit disabled plain-object response as a successful disable', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'), f = await fixture();
  const options = { ...f.options, temporaryWorkerName: f.identity.workerName };
  const worker = await api.findExactWorker(options);
  assert.deepEqual(await api.disableWorkersDevSubdomain({ ...options, worker }), { disabled: true, absent: false });
});

for (const status of [400, 404]) test('typed HTTP ' + status + ' mapping absence remains idempotent and revalidates before object deletion', async () => {
  const m = await mod(), api = await import('../scripts/cloudflare-temporary-worker-api.mjs'), f = await fixture();
  const options = { ...f.options, temporaryWorkerName: f.identity.workerName };
  const worker = await api.findExactWorker(options);
  f.intercept(async ({ parsed, method }) => method === 'DELETE' && parsed.pathname.endsWith('/subdomain')
    ? response({ success: false, errors: [{ code: 10007, message: 'Worker not found' }] }, status) : undefined);
  assert.deepEqual(await api.disableWorkersDevSubdomain({ ...options, worker }), { disabled: false, absent: true });
  const start = f.calls.length;
  assert.equal((await m.cleanupRemoteDdsDeployment(f.options)).status, 'deleted');
  const calls = f.calls.slice(start), probe = calls.findIndex(({ url }) => url === f.endpoint);
  const deletion = calls.findIndex(({ method, url }) => method === 'DELETE' && !url.endsWith('/subdomain'));
  assert.ok(probe > 0 && probe < deletion);
  assert.ok(calls.slice(probe + 1, deletion).some(({ url }) => url.endsWith('/versions/deployed-v1')));
});

for (const representation of ['current', 'legacy']) test('final ' + representation + ' absence must be confirmed after object deletion', async () => {
  const m = await mod(), f = await fixture();
  f.intercept(async ({ parsed, method }) => {
    if (f.state.present || method !== 'GET') return;
    if (representation === 'current' && parsed.pathname.endsWith('/workers/workers')) return response(page([{ id: WORKER_ID, name: f.identity.workerName }]));
    if (representation === 'legacy' && parsed.pathname.endsWith('/scripts-search')) return response(page([{ script_name: f.identity.workerName }]));
  });
  await assert.rejects(() => m.cleanupRemoteDdsDeployment(f.options), (error) => error.cleanupResult?.objectDeleted === true && error.cleanupResult.currentAbsent === false);
  assert.equal(f.mutations().length, 2);
});

test('supplemental endpoint mismatch is refused even when the exact object is already absent', async () => {
  const m = await mod(), f = await fixture(); f.state.present = false; f.state.legacy = false;
  await assert.rejects(() => m.cleanupRemoteDdsDeployment({ ...f.options, workersDevUrl: `https://${f.identity.workerName}.other.workers.dev` }));
  assert.equal(f.calls.length, 0);
});

test('versions endpoint absence with a legacy representation refuses placeholder recovery', async () => {
  const m = await mod(), f = await fixture(); f.state.details = []; f.state.versionsAbsent = true;
  await assert.rejects(() => m.cleanupRemoteDdsDeployment({ ...f.options, deploymentRecord: undefined })); assert.equal(f.mutations().length, 0);
});

for (const legacy of ['both readers', 'exact endpoint only', 'search only']) test('PRESENT empty versions with ' + legacy + ' legacy presence refuses all cleanup mutations', async () => {
  const m = await mod(), f = await fixture(); f.state.details = [];
  f.intercept(async ({ parsed, method }) => {
    if (method !== 'GET') return;
    if (legacy === 'search only' && parsed.pathname.endsWith(`/scripts/${f.identity.workerName}`)) return notFound();
    if (legacy === 'exact endpoint only' && parsed.pathname.endsWith('/scripts-search')) return response(page([]));
  });
  await assert.rejects(() => m.cleanupRemoteDdsDeployment({ ...f.options, deploymentRecord: undefined }));
  assert.equal(f.mutations().filter(({ url }) => url.endsWith('/subdomain')).length, 0);
  assert.equal(f.mutations().filter(({ url }) => !url.endsWith('/subdomain')).length, 0);
});

test('legacy-only ownership cannot authorize deletion', async () => {
  const m = await mod(), f = await fixture();
  f.intercept(async ({ parsed }) => parsed.pathname.endsWith('/workers/workers') ? response(page([])) : undefined);
  await assert.rejects(() => m.cleanupRemoteDdsDeployment(f.options)); assert.equal(f.mutations().length, 0);
});

const contextArgs = ['--repository', CONTEXT.repository, '--workflow', CONTEXT.workflow, '--run-id', CONTEXT.runId, '--run-attempt', CONTEXT.runAttempt, '--commit-sha', CONTEXT.commitSha];
test('cleanup CLI rejects unknown, missing, duplicate, and deployment-mode arguments before network', async () => {
  const m = await mod();
  const base = ['--identity', 'pre.json', ...contextArgs, '--out', 'result.json'];
  for (const args of [base.concat('--unknown', 'x'), base.concat('--identity', 'other'), base.concat('--deploy-from-identity', 'x'), base.concat('--preflight'), base.slice(0, -1), ['--identity', 'pre.json', '--out', 'x']]) {
    let calls = 0;
    await assert.rejects(() => m.runCleanupCli(args, {}, { fetchImpl: async () => { calls++; } })); assert.equal(calls, 0);
  }
});

test('cleanup CLI atomically persists only schema-v2 safe success or failed results and returns nonzero on failure', async () => {
  const m = await mod(), f = await fixture(); const dir = mkdtempSync(join(tmpdir(), 'dds-cleanup-'));
  try {
    const identity = join(dir, 'pre.json'), deployment = join(dir, 'deployment.json'), out = join(dir, 'cleanup.json');
    writeFileSync(identity, JSON.stringify(f.identity)); writeFileSync(deployment, JSON.stringify(f.record));
    const args = ['--identity', identity, '--deployment-record', deployment, ...contextArgs, '--out', out];
    const env = { CLOUDFLARE_ACCOUNT_ID: 'fake-account', CLOUDFLARE_API_TOKEN: TOKEN };
    assert.deepEqual(JSON.parse(JSON.stringify(await m.runCleanupCli(args, env, { fetchImpl: f.fetchImpl }))), JSON.parse(readFileSync(out, 'utf8')));
    f.state.present = true; f.state.legacy = true; f.state.mapping = true; f.state.probeStatus = 200;
    await assert.rejects(() => m.runCleanupCli(args, env, { fetchImpl: f.fetchImpl }));
    const failed = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(failed.status, 'failed'); assert.equal(failed.subdomainDisabled, true); assert.equal(failed.objectDeleted, false);
    assert.equal(failed.failureCode, 'CLEANUP_ENDPOINT_UNVERIFIED');
    assert.deepEqual(Object.keys(failed).sort(), ['version', 'status', ...Object.keys(CONTEXT), 'workerName', 'subdomainDisabled', 'objectDeleted', 'currentAbsent', 'legacyAbsent', 'failureCode'].sort());
    assert.equal(readFileSync(out, 'utf8').includes(TOKEN), false); assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
    const result = spawnSync(process.execPath, [join(__dirname, '../scripts/cleanup-remote-dds-deployment.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: '' } });
    assert.notEqual(result.status, 0); assert.equal((result.stdout + result.stderr).includes(TOKEN), false); assert.equal(result.stderr.includes(' at '), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cleanup process keeps the stage diagnostic first when safe result persistence also fails', async () => {
  const m = await mod(), f = await fixture(); const dir = mkdtempSync(join(tmpdir(), 'dds-cleanup-write-failure-'));
  try {
    const identity = join(dir, 'pre.json'), deployment = join(dir, 'deployment.json'), out = join(dir, 'cleanup.json');
    writeFileSync(identity, JSON.stringify(f.identity)); writeFileSync(deployment, JSON.stringify(f.record));
    f.state.probeStatus = 200;
    const args = ['--identity', identity, '--deployment-record', deployment, ...contextArgs, '--out', out];
    let stderr = '', exitCode;
    await m.runCleanupProcess(args, { CLOUDFLARE_ACCOUNT_ID: 'fake-account', CLOUDFLARE_API_TOKEN: TOKEN }, {
      fetchImpl: f.fetchImpl,
      writeReportCheckpoint: () => { throw new Error('private-result-path-marker'); },
    }, { error: (value) => { stderr += value; }, setExitCode: (value) => { exitCode = value; } });
    assert.equal(exitCode, 1);
    assert.equal(stderr, 'Remote DDS cleanup failed [CLEANUP_ENDPOINT_UNVERIFIED].\n' +
      'Remote DDS cleanup failed [CLEANUP_RESULT_WRITE_FAILED].\n');
    assert.equal(stderr.includes('private-result-path-marker'), false);
    assert.equal(stderr.includes(TOKEN), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ['identity', 'deployment', 'case alias', 'parent junction']) test('cleanup CLI rejects output overwriting an input through ' + kind + ' before any request', async () => {
  const m = await mod(), f = await fixture(), dir = mkdtempSync(join(tmpdir(), 'dds-cleanup-alias-'));
  try {
    const parent = join(dir, 'real'); mkdirSync(parent);
    const identity = join(parent, 'pre.json'), deployment = join(parent, 'deployment.json');
    writeFileSync(identity, JSON.stringify(f.identity)); writeFileSync(deployment, JSON.stringify(f.record));
    let out = kind === 'deployment' ? deployment : identity;
    if (kind === 'case alias') out = join(parent, 'PRE.JSON');
    if (kind === 'parent junction') { const alias = join(dir, 'alias'); symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir'); out = join(alias, 'pre.json'); }
    if (kind === 'case alias' && process.platform !== 'win32') return;
    const original = readFileSync(identity, 'utf8'), originalDeployment = readFileSync(deployment, 'utf8');
    await assert.rejects(() => m.runCleanupCli(['--identity', identity, '--deployment-record', deployment, ...contextArgs, '--out', out],
      { CLOUDFLARE_ACCOUNT_ID: 'fake-account', CLOUDFLARE_API_TOKEN: TOKEN }, { fetchImpl: f.fetchImpl }), /separate|same.*target|alias/i);
    assert.equal(readFileSync(identity, 'utf8'), original); assert.equal(readFileSync(deployment, 'utf8'), originalDeployment); assert.equal(f.calls.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
