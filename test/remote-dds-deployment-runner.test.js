const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const RETRYABLE_WINDOWS_REMOVE_ERRORS = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);

function removeTreeAfterWindowsChildExit(path, {
  remove = rmSync,
  sleep = (delayMs) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs),
  maxRetries = 10,
  retryDelay = 100,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      remove(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!RETRYABLE_WINDOWS_REMOVE_ERRORS.has(error?.code) || attempt >= maxRetries) throw error;
      sleep(retryDelay * (attempt + 1));
    }
  }
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'remote-dds-deployment-'));
  mkdirSync(join(root, 'workers/vendor/bridge-dds'), { recursive: true });
  mkdirSync(join(root, 'workers/src'), { recursive: true });
  writeFileSync(join(root, 'workers/wrangler.jsonc'), JSON.stringify({ name: 'test-worker', main: 'src/index.mjs', workers_dev: false }));
  writeFileSync(join(root, 'workers/vendor/bridge-dds/dds-worker.wasm'), 'wasm-v1');
  writeFileSync(join(root, 'workers/src/harness-router.mjs'), 'router-v1');
  writeFileSync(join(root, 'workers/src/feasibility-room.mjs'), 'room-v1');
  return root;
}

async function deployment() { return import('../scripts/prepare-remote-dds-deployment.mjs'); }
async function runner() { return import('../scripts/remote-worker-dds-soak.mjs'); }
async function assertDiagnostic(thunk, expectedCode) {
  const { publicDiagnosticCode } = await import('../scripts/remote-dds-public-errors.mjs');
  await assert.rejects(thunk, (error) => {
    assert.equal(publicDiagnosticCode(error), expectedCode);
    return true;
  });
}

const CONTEXT = { repository: 'bridge/stepstone', workflow: 'Remote DDS Soak', runId: '12345', runAttempt: '2', commitSha: 'a'.repeat(40) };
const TOKEN = 'fake-source-token';
const KEY = 'a'.repeat(43);
const WORKER_ID = 'b'.repeat(32);
const DEPLOYMENT_CLI = join(__dirname, '../scripts/prepare-remote-dds-deployment.mjs');
const CONTEXT_ARGS = ['--repository', CONTEXT.repository, '--workflow', CONTEXT.workflow, '--run-id', CONTEXT.runId,
  '--run-attempt', CONTEXT.runAttempt, '--commit-sha', CONTEXT.commitSha];
const SECRET_MARKERS = ['account-marker-must-not-leak', 'token-marker-must-not-leak', 'worker-name-marker-must-not-leak',
  'https://url-marker-must-not-leak.example', 'body-marker-must-not-leak', 'stack-marker-must-not-leak'];
const NEW_DEPLOYMENT_DIAGNOSTICS = [
  'WRANGLER_DEPLOY_FAILED',
  'DEPLOYED_OWNERSHIP_UNVERIFIED',
  'SECRET_UPLOAD_FAILED',
  'POST_SECRET_OWNERSHIP_UNVERIFIED',
  'SUBDOMAIN_LOOKUP_FAILED',
  'IMMUTABLE_VERSION_UNVERIFIED',
  'ENDPOINT_VERIFICATION_FAILED',
  'TEMP_DIRECTORY_CLEANUP_FAILED',
  'PREFLIGHT_TIMEOUT',
  'WRANGLER_DEPLOY_TIMEOUT',
  'DEPLOYED_OWNERSHIP_TIMEOUT',
  'SECRET_UPLOAD_TIMEOUT',
  'POST_SECRET_OWNERSHIP_TIMEOUT',
  'SUBDOMAIN_LOOKUP_TIMEOUT',
  'IMMUTABLE_VERSION_TIMEOUT',
  'ENDPOINT_VERIFICATION_TIMEOUT',
];
const NEW_ROLLBACK_DIAGNOSTICS = [
  'ROLLBACK_DISCOVERY_FAILED',
  'ROLLBACK_CLEANUP_FAILED',
  'ROLLBACK_DISCOVERY_TIMEOUT',
  'ROLLBACK_CLEANUP_TIMEOUT',
];
function deploymentEnvironment(overrides = {}) {
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: SECRET_MARKERS[0], CLOUDFLARE_API_TOKEN: SECRET_MARKERS[1], DDS_REMOTE_TEST_KEY: KEY };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
function assertDeploymentCliFailure(result, code, markers = SECRET_MARKERS) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `Remote DDS deployment failed [${code}].\n`);
  for (const marker of markers) assert.equal(`${result.stdout}${result.stderr}`.includes(marker), false, marker);
}

test('every staged deployment, timeout, and rollback diagnostic has an exact leak-free public line', async () => {
  const errors = await import('../scripts/remote-dds-public-errors.mjs');
  const privateMarkers = [
    'account-id-private-marker',
    'api-token-private-marker',
    'test-key-private-marker',
    'C:\\private\\remote-dds\\deployment-marker',
    'https://private-marker.example.invalid/worker?key=secret',
    'stack-frame-private-marker',
    'ARBITRARY_INTERNAL_CODE_MARKER',
    'raw wrangler deployment stage marker',
  ];
  const cause = new Error(privateMarkers.join(' '));
  cause.stack = privateMarkers.join('\n');
  Object.assign(cause, {
    accountId: privateMarkers[0], token: privateMarkers[1], testKey: privateMarkers[2],
    path: privateMarkers[3], url: privateMarkers[4], code: privateMarkers[6], stage: privateMarkers[7],
  });

  for (const code of NEW_DEPLOYMENT_DIAGNOSTICS) {
    const error = errors.diagnostic(code, cause);
    assert.equal(errors.publicDiagnosticCode(error), code);
    const output = errors.renderRemoteDdsFailure(error);
    assert.equal(output, `Remote DDS deployment failed [${code}].`);
    for (const marker of privateMarkers) assert.equal(output.includes(marker), false, `${code}: ${marker}`);
  }

  for (const code of NEW_ROLLBACK_DIAGNOSTICS) {
    const error = errors.diagnostic(code, cause);
    assert.equal(errors.publicDiagnosticCode(error), code);
    const output = errors.renderRemoteDdsRollbackFailure(error);
    assert.equal(output, `Remote DDS rollback also failed [${code}].`);
    for (const marker of privateMarkers) assert.equal(output.includes(marker), false, `${code}: ${marker}`);
  }

  const forged = { code: 'ROLLBACK_CLEANUP_FAILED', cause };
  assert.equal(errors.renderRemoteDdsFailure(forged), 'Remote DDS deployment failed [UNKNOWN].');
  assert.equal(errors.renderRemoteDdsRollbackFailure(forged), 'Remote DDS rollback also failed [UNKNOWN].');
  for (const renderer of [errors.renderRemoteDdsFailure, errors.renderRemoteDdsRollbackFailure]) {
    const output = renderer(forged);
    for (const marker of privateMarkers) assert.equal(output.includes(marker), false, marker);
  }
});
function deploymentArgs(mode, input, out) { return [mode, mode === '--preflight' ? '--identity' : input, mode === '--preflight' ? input : undefined,
  ...CONTEXT_ARGS, '--out', out].filter((value) => value !== undefined); }
const page = (items, number = 1, total = 1, perPage = 100, totalCount = (total - 1) * perPage + items.length) => ({ success: true, result: items,
  result_info: { page: number, per_page: perPage, total_pages: total, count: items.length, total_count: totalCount } });
const versionPage = (items, ...args) => ({ ...page(items, ...args), result: { items } });
const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const jsonResponse = (payload, status = 200) => ({ ...response(payload, status), headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json; charset=UTF-8' : null } });
const notFound = (status = 404) => response({ success: false, errors: [{ code: 10007, message: 'Worker not found' }] }, status);
async function ciIdentity(secret = TOKEN) { return (await import('../scripts/remote-dds-ci-identity.mjs')).deriveCiIdentity({ ...CONTEXT, secret }); }
function versionDetail(identity, tag = identity.ownershipTag) {
  return { success: true, result: { id: 'deployed-v1', annotations: tag === null ? {} : { 'workers/tag': tag }, resources: { script: { etag: 'script-etag-1' }, bindings: [{ type: 'plain_text', name: 'DDS_REMOTE_TEST', text: 'true' }], script_runtime: { compatibility_date: '2026-09-22' } } } };
}
async function deploymentFixture(overrides = {}) {
  const mod = await deployment(); const identity = await ciIdentity(overrides.apiToken ?? TOKEN); const root = repo();
  const events = []; let deployed = false, deleted = false, buildId;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url); events.push({ url, method: options.method ?? 'GET' });
    if (parsed.hostname.endsWith('.workers.dev')) return parsed.pathname === '/' ? response({}, 404) : response({ operationResult: { buildId, workerVersionId: 'deployed-v1' } });
    if (options.method === 'DELETE' && parsed.pathname.endsWith('/subdomain')) return response({ success: true, result: { enabled: false, previews_enabled: false }, errors: [], messages: [] });
    if (options.method === 'DELETE') { deleted = true; return response({ success: true }); }
    if (parsed.pathname.endsWith(`/workers/scripts/${identity.workerName}`)) return deployed && !deleted ? response({}) : notFound();
    if (parsed.pathname.endsWith('/workers/workers')) return response(page(deployed && !deleted ? [{ id: WORKER_ID, name: identity.workerName }] : []));
    if (parsed.pathname.endsWith('/workers/scripts-search')) return response(page(deployed && !deleted ? [{ script_name: identity.workerName }] : []));
    if (parsed.pathname.endsWith('/versions')) return response(versionPage(deployed && !deleted ? [{ id: 'deployed-v1' }] : []));
    if (parsed.pathname.endsWith('/versions/deployed-v1')) return response(versionDetail(identity));
    if (parsed.pathname.endsWith('/workers/subdomain')) return response({ success: true, result: { subdomain: 'example' } });
    throw new Error(`Unexpected test request: ${url}`);
  };
  const execFile = (command, args, options = {}) => {
    events.push({ command, args: [...args], input: options.input });
    if (args[0] === 'deploy') { deployed = true; buildId = args.find((arg) => arg.startsWith('DDS_DEPLOYMENT_BUILD_ID:'))?.split(':')[1]; return ''; }
    if (args[1] === 'secret') return '';
    if (args[0] === '--version') return '4.33.0';
    throw new Error('Unexpected test command');
  };
  const options = { root, accountId: 'acct', apiToken: TOKEN, remoteTestKey: KEY, context: CONTEXT, identity, fetchImpl, execFile,
    wrangler: 'wrangler-test', sleepImpl: async () => {}, ...overrides };
  const preDeploymentIdentity = await mod.preflightTemporaryWorkerIdentity({ ...options, now: () => new Date('2026-10-01T00:00:00.000Z') });
  return { mod, root, identity, events, options: { ...options, preDeploymentIdentity }, fetchImpl, execFile,
    setDeployed: (value) => { deployed = value; }, isDeleted: () => deleted };
}
async function verifiedFixture() {
  const f = await deploymentFixture();
  try { return { root: f.root, verified: await f.mod.deployAndVerifyWorkers(f.options), mod: f.mod }; }
  catch (error) { rmSync(f.root, { recursive: true, force: true }); throw error; }
}

test('deployment manifest binds ownership, configuration, exact endpoint, immutable version, and every asset', async () => {
  const { root, verified, mod } = await verifiedFixture();
  try {
    const manifest = mod.createDeploymentManifest({ root, verifiedDeployment: verified });
    assert.equal(manifest.version, 2);
    assert.equal(manifest.kind, 'remote-dds-deployment-record');
    assert.equal(manifest.ownershipTag, verified.identity.ownershipTag);
    assert.equal(manifest.endpoint, verified.workersDevUrl);
    assert.equal(manifest.localConfigurationSha256, verified.localConfigurationSha256);
    assert.equal(manifest.scriptETag, 'script-etag-1');
    assert.match(manifest.versionConfigurationSha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.workerVersionId, 'deployed-v1');
    assert.equal(manifest.workerId, WORKER_ID);
    assert.equal(manifest.verifiedDeployment.workerId, WORKER_ID);
    assert.throws(() => mod.assertVerifiedDeployment({ ...verified, workerId: new String(WORKER_ID) }), /immutable Worker ID/i);
    assert.equal(manifest.assets.wasm.bytes, 7);
    assert.equal(Object.keys(manifest.assets.harness).length, 2);
    assert.equal(JSON.stringify(manifest).includes(KEY), false);
    assert.equal(JSON.stringify(manifest).includes(TOKEN), false);
    mod.assertDeploymentManifest(manifest, { root });
    writeFileSync(join(root, 'workers/vendor/bridge-dds/dds-worker.wasm'), 'wasm-v2');
    assert.throws(() => mod.assertDeploymentManifest(manifest, { root }), /Wasm asset hash changed/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deployment manifest fails closed for missing or inconsistent ownership and endpoint evidence', async () => {
  const { root, verified, mod } = await verifiedFixture();
  try {
    const manifest = mod.createDeploymentManifest({ root, verifiedDeployment: verified });
    for (const mutate of [
      (v) => { delete v.version; },
      (v) => { delete v.ownershipTag; },
      (v) => { v.verifiedDeployment.ownershipTag = 'b'.repeat(43); },
      (v) => { v.endpoint = 'https://production.example.workers.dev'; },
      (v) => { v.workerVersionId = 'other-version'; },
      (v) => { v.assets.harness['workers/src/extra.mjs'] = { path: 'workers/src/extra.mjs', bytes: 1, sha256: 'a'.repeat(64) }; },
      (v) => { v.DDS_REMOTE_TEST_KEY = KEY; },
    ]) {
      const changed = structuredClone(manifest); mutate(changed);
      assert.throws(() => mod.assertDeploymentManifest(changed, { root }), /version|ownership|endpoint|Worker|harness|field/i);
    }
    assert.throws(() => mod.createDeploymentManifest({ root, workerVersionId: 'unverified' }), /verified deployment/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('temporary Worker names accept UUID and derived GitHub forms while rejecting prefixes and production names', async () => {
  const mod = await deployment(); const identity = await ciIdentity();
  assert.equal(mod.assertTemporaryWorkerName(identity.workerName), identity.workerName);
  assert.equal(mod.assertTemporaryWorkerName('ss-dds-soak-00000000-0000-4000-8000-000000000001'), 'ss-dds-soak-00000000-0000-4000-8000-000000000001');
  for (const name of ['ss-dds-soak-', 'ss-dds-soak-gh-', 'ss-dds-soak-gh-1-1-UPPERCASE123', 'production-worker', 'ss-dds-soak-gh-1-1-too-short']) {
    assert.throws(() => mod.assertTemporaryWorkerName(name), /temporary Worker/i);
  }
});

test('preflight is read-only, queries exact name and both complete listings, and timestamps the derived identity', async () => {
  const f = await deploymentFixture();
  try {
    const record = f.options.preDeploymentIdentity;
    assert.equal(record.workerName, f.identity.workerName);
    assert.equal(record.ownershipTag, f.identity.ownershipTag);
    assert.equal(record.noCollisionVerifiedAt, '2026-10-01T00:00:00.000Z');
    assert.ok(f.events.some((e) => e.url?.endsWith('/workers/scripts/' + f.identity.workerName)));
    assert.ok(f.events.some((e) => new URL(e.url).pathname.endsWith('/workers/workers')));
    assert.ok(f.events.some((e) => new URL(e.url).pathname.endsWith('/workers/scripts-search')));
    assert.ok(f.events.every((e) => e.method === 'GET'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Wrangler child processes do not inherit the exported remote test key', async () => {
  const previous = process.env.DDS_REMOTE_TEST_KEY;
  process.env.DDS_REMOTE_TEST_KEY = 'job-exported-key';
  const f = await deploymentFixture(); const children = [];
  try {
    await f.mod.deployAndVerifyWorkers({ ...f.options,
      execFile: (command, args, options) => {
        children.push({ args: [...args], env: options.env, input: options.input });
        return f.execFile(command, args, options);
      },
    });
    assert.ok(children.length >= 3);
    for (const child of children) assert.equal(Object.hasOwn(child.env, 'DDS_REMOTE_TEST_KEY'), false, `key leaked to ${child.args.join(' ')}`);
    assert.equal(children.find((child) => child.args[1] === 'secret').input, KEY + '\n');
  } finally {
    if (previous === undefined) delete process.env.DDS_REMOTE_TEST_KEY;
    else process.env.DDS_REMOTE_TEST_KEY = previous;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('an exact-name collision rejects immediately with zero deployment or deletion', async () => {
  const mod = await deployment(); const identity = await ciIdentity(); let reads = 0, mutations = 0;
  await assert.rejects(() => mod.preflightTemporaryWorkerIdentity({ accountId: 'acct', apiToken: TOKEN, identity, context: CONTEXT,
    fetchImpl: async (url, options = {}) => { reads++; if (options.method && options.method !== 'GET') mutations++; assert.ok(url.endsWith('/workers/scripts/' + identity.workerName)); return response({}); },
    execFile: () => { mutations++; },
  }), /collision|already exists/i);
  assert.equal(reads, 1); assert.equal(mutations, 0);
});

for (const missing of ['accountId', 'apiToken']) test('Cloudflare preflight classifies missing ' + missing + ' before fetch', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let fetches = 0;
  const options = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async () => { fetches++; throw new Error('must not fetch'); } };
  delete options[missing];
  await assertDiagnostic(() => api.confirmExactAbsence(options), 'REQUIRED_CONFIG_MISSING');
  assert.equal(fetches, 0);
});

test('Cloudflare preflight classifies a wholly missing options object as required configuration', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs');
  await assertDiagnostic(() => api.confirmExactAbsence(), 'REQUIRED_CONFIG_MISSING');
});

test('Cloudflare preflight classifies null options as required configuration', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs');
  await assertDiagnostic(() => api.confirmExactAbsence(null), 'REQUIRED_CONFIG_MISSING');
});

for (const [label, payload, expectedCode] of [
  ['auth envelope', { success: false, errors: [{ code: 10000, message: 'Authentication error sensitive-marker' }] }, 'API_AUTH_OR_PERMISSION'],
  ['non-auth envelope', { success: false, errors: [{ code: 10001, message: 'Request rejected sensitive-marker' }] }, 'API_REQUEST_FAILED'],
  ['malformed failure envelope', { success: false, errors: [] }, 'API_EXACT_SCRIPT_RESPONSE_INVALID'],
]) test('exact HTTP 200 JSON ' + label + ' is classified before collision', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let reads = 0, mutations = 0;
  await assertDiagnostic(() => api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url, options = {}) => {
      reads++;
      if ((options.method ?? 'GET') !== 'GET') mutations++;
      return jsonResponse(payload);
    },
  }), expectedCode);
  assert.equal(reads, 1); assert.equal(mutations, 0);
});

test('exact HTTP 200 JSON response with invalid JSON is classified before collision', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let reads = 0, mutations = 0;
  await assertDiagnostic(() => api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url, options = {}) => {
      reads++;
      if ((options.method ?? 'GET') !== 'GET') mutations++;
      return { ok: true, status: 200, headers: { get: () => 'application/problem+json' }, json: async () => { throw new SyntaxError('sensitive-marker'); } };
    },
  }), 'API_EXACT_SCRIPT_RESPONSE_INVALID');
  assert.equal(reads, 1); assert.equal(mutations, 0);
});

for (const [label, payload] of [
  ['missing result', { success: true }],
  ['null result', { success: true, result: null }],
  ['unrelated result', { success: true, result: { unrelated: 'value' } }],
]) test('exact HTTP 200 JSON success with ' + label + ' cannot prove presence', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let reads = 0, mutations = 0;
  await assertDiagnostic(() => api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url, options = {}) => {
      reads++;
      if ((options.method ?? 'GET') !== 'GET') mutations++;
      return jsonResponse(payload);
    },
  }), 'API_EXACT_SCRIPT_RESPONSE_INVALID');
  assert.equal(reads, 1); assert.equal(mutations, 0);
});

test('exact HTTP 200 non-JSON script body proves presence without reading the body', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let reads = 0, jsonReads = 0, mutations = 0;
  await assertDiagnostic(() => api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url, options = {}) => {
      reads++;
      if ((options.method ?? 'GET') !== 'GET') mutations++;
      return { ok: true, status: 200, headers: { get: () => 'application/javascript' }, json: async () => { jsonReads++; throw new Error('script body must not be read'); } };
    },
  }), 'TEMPORARY_WORKER_COLLISION');
  assert.equal(reads, 1); assert.equal(jsonReads, 0); assert.equal(mutations, 0);
});

test('Cloudflare preflight classifies a rejected request without authorizing mutation', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let mutations = 0;
  await assertDiagnostic(() => api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url, options = {}) => {
      if ((options.method ?? 'GET') !== 'GET') mutations++;
      throw new TypeError('fetch failed with sensitive-marker');
    },
  }), 'API_REQUEST_FAILED');
  assert.equal(mutations, 0);
});

for (const status of [401, 403]) test('Cloudflare preflight classifies HTTP ' + status + ' before parsing its body', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let jsonReads = 0, mutations = 0;
  await assertDiagnostic(() => api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url, options = {}) => {
      if ((options.method ?? 'GET') !== 'GET') mutations++;
      return { ok: false, status, json: async () => { jsonReads++; throw new SyntaxError('non-json sensitive-marker'); } };
    },
  }), 'API_AUTH_OR_PERMISSION');
  assert.equal(jsonReads, 0); assert.equal(mutations, 0);
});

test('Cloudflare preflight classifies non-auth invalid JSON as an invalid response', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let mutations = 0;
  await assertDiagnostic(() => api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url, options = {}) => {
      if ((options.method ?? 'GET') !== 'GET') mutations++;
      return { ok: false, status: 500, json: async () => { throw new SyntaxError('html sensitive-marker'); } };
    },
  }), 'API_EXACT_SCRIPT_RESPONSE_INVALID');
  assert.equal(mutations, 0);
});

test('Cloudflare preflight gives an auth envelope precedence over mixed code-10007 absence', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let mutations = 0;
  await assertDiagnostic(() => api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url, options = {}) => {
      if ((options.method ?? 'GET') !== 'GET') mutations++;
      return response({ success: false, errors: [{ code: 10007 }, { code: 10000, message: 'Permission denied sensitive-marker' }] }, 404);
    },
  }), 'API_AUTH_OR_PERMISSION');
  assert.equal(mutations, 0);
});

test('Cloudflare preflight classifies another valid unsuccessful envelope as a request failure', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let mutations = 0;
  await assertDiagnostic(() => api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url, options = {}) => {
      if ((options.method ?? 'GET') !== 'GET') mutations++;
      return response({ success: false, errors: [{ code: 10001, message: 'Rate limited sensitive-marker' }] }, 429);
    },
  }), 'API_REQUEST_FAILED');
  assert.equal(mutations, 0);
});

for (const [label, payload, expectedCode] of [
  ['auth envelope', { success: false, errors: [{ code: 10000, message: 'Authentication error sensitive-marker' }] }, 'API_AUTH_OR_PERMISSION'],
  ['non-auth envelope', { success: false, errors: [{ code: 10001, message: 'Request rejected sensitive-marker' }] }, 'API_REQUEST_FAILED'],
  ['missing errors', { success: false }, 'API_WORKERS_LIST_RESPONSE_INVALID'],
  ['empty errors', { success: false, errors: [] }, 'API_WORKERS_LIST_RESPONSE_INVALID'],
  ['malformed errors', { success: false, errors: [{ code: 10001, message: 17 }] }, 'API_WORKERS_LIST_RESPONSE_INVALID'],
  ['non-object result metadata', { success: false, errors: [{ code: 10001 }], result_info: 'invalid' }, 'API_WORKERS_LIST_RESPONSE_INVALID'],
  ['incomplete result metadata', { success: false, errors: [{ code: 10001 }], result_info: {} }, 'API_WORKERS_LIST_RESPONSE_INVALID'],
  ['malformed result value', { success: false, errors: [{ code: 10001 }], result: 'invalid' }, 'API_WORKERS_LIST_RESPONSE_INVALID'],
]) test('HTTP 200 success:false classifies a valid or malformed ' + label, async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let mutations = 0;
  await assertDiagnostic(() => api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url, options = {}) => {
      if ((options.method ?? 'GET') !== 'GET') mutations++;
      const path = new URL(url).pathname;
      if (path.endsWith('/workers/scripts/' + identity.workerName)) return notFound();
      return response(payload);
    },
  }), expectedCode);
  assert.equal(mutations, 0);
});

for (const [label, payload] of [
  ['malformed result', { success: true, result: {}, result_info: { page: 1, per_page: 100, total_pages: 0, count: 0, total_count: 0 } }],
  ['malformed pagination', { success: true, result: [], result_info: { page: 2, per_page: 100 } }],
]) test('Cloudflare preflight classifies successful ' + label + ' as an invalid response', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let mutations = 0;
  await assertDiagnostic(() => api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url, options = {}) => {
      if ((options.method ?? 'GET') !== 'GET') mutations++;
      const path = new URL(url).pathname;
      if (path.endsWith('/workers/scripts/' + identity.workerName)) return notFound();
      return response(payload);
    },
  }), 'API_WORKERS_LIST_RESPONSE_INVALID');
  assert.equal(mutations, 0);
});

test('Wrangler deployment failures are classified without exposing command diagnostics', async () => {
  const mod = await deployment(); let stderr = '', exitCode;
  const failure = new mod.ExternalCommandFailure(new Error('Wrangler API request failed: token-marker account-marker'));
  await mod.runDeploymentProcess([], {}, { runDeploymentCli: async () => { throw failure; } }, {
    error: (value) => { stderr += value; }, setExitCode: (value) => { exitCode = value; },
  });
  assert.equal(exitCode, 1);
  assert.equal(stderr, 'Remote DDS deployment failed [API_REQUEST_FAILED].\n');
  assert.equal(stderr.includes('token-marker'), false);
});

test('ownership-wrapped API failures preserve their safe category at the process boundary', async () => {
  const mod = await deployment();
  const { diagnostic } = await import('../scripts/remote-dds-public-errors.mjs');
  const { OwnershipRefusal } = await import('../scripts/cloudflare-temporary-worker-api.mjs');
  let stderr = '', exitCode;
  await mod.runDeploymentProcess([], {}, {
    runDeploymentCli: async () => { throw new OwnershipRefusal('ownership evidence failed', { cause: diagnostic('API_RESPONSE_INVALID', new Error('private response')) }); },
  }, { error: (value) => { stderr += value; }, setExitCode: (value) => { exitCode = value; } });
  assert.equal(exitCode, 1);
  assert.equal(stderr, 'Remote DDS deployment failed [API_RESPONSE_INVALID].\n');
});

for (const [stage, expectedCode] of [
  ['exact script', 'API_EXACT_SCRIPT_RESPONSE_INVALID'],
  ['Workers list', 'API_WORKERS_LIST_RESPONSE_INVALID'],
  ['scripts search', 'API_SCRIPTS_SEARCH_RESPONSE_INVALID'],
]) test('absence preflight safely identifies an invalid ' + stage + ' response', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity();
  await assertDiagnostic(() => api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/workers/scripts/' + identity.workerName)) {
        return stage === 'exact script' ? jsonResponse({ success: true }) : notFound();
      }
      if (path.endsWith('/workers/workers')) {
        return stage === 'Workers list' ? response({ success: true, result: [], result_info: { page: 2, per_page: 100 } }) : response(page([]));
      }
      if (path.endsWith('/workers/scripts-search')) return response({ success: true, result: {} });
      throw new Error('unexpected request');
    },
  }), expectedCode);
});

test('only confirmExactAbsence classifies a successful exact endpoint as a collision', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let mutations = 0;
  await assertDiagnostic(() => api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url, options = {}) => {
      if ((options.method ?? 'GET') !== 'GET') mutations++;
      return response({});
    },
  }), 'TEMPORARY_WORKER_COLLISION');
  assert.equal(mutations, 0);
});

test('only confirmExactAbsence classifies an exact match from a fully validated list as a collision', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let mutations = 0;
  await assertDiagnostic(() => api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url, options = {}) => {
      if ((options.method ?? 'GET') !== 'GET') mutations++;
      const path = new URL(url).pathname;
      if (path.endsWith('/workers/scripts/' + identity.workerName)) return notFound();
      if (path.endsWith('/workers/workers')) return response(page([{ id: WORKER_ID, name: identity.workerName }]));
      throw new Error('must stop after the proven collision');
    },
  }), 'TEMPORARY_WORKER_COLLISION');
  assert.equal(mutations, 0);
});

test('code-10007-only responses still prove exact absence without mutation', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let mutations = 0;
  const result = await api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url, options = {}) => {
      if ((options.method ?? 'GET') !== 'GET') mutations++;
      const path = new URL(url).pathname;
      if (path.endsWith('/workers/scripts/' + identity.workerName)) return notFound();
      return response(page([]));
    },
  });
  assert.deepEqual(result, { absent: true }); assert.equal(mutations, 0);
});

test('scripts-search accepts an unfiltered account total while proving exact name absence', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let mutations = 0;
  const result = await api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url, options = {}) => {
      if ((options.method ?? 'GET') !== 'GET') mutations++;
      const path = new URL(url).pathname;
      if (path.endsWith('/workers/scripts/' + identity.workerName)) return notFound();
      if (path.endsWith('/workers/workers')) return response(page([]));
      if (path.endsWith('/workers/scripts-search')) return response(page([], 1, 1, 100, 7));
      throw new Error('unexpected request');
    },
  });
  assert.deepEqual(result, { absent: true }); assert.equal(mutations, 0);
});

for (const [label, resultInfo] of [
  ['no result_info', undefined],
  ['null result_info', null],
  ['partial result_info', { page: 1, per_page: 100, count: 0 }],
]) test('scripts-search accepts the documented optional pagination metadata: ' + label, async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let reads = 0;
  const result = await api.listLegacyExactScript({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url) => {
      reads++; const parsed = new URL(url);
      assert.equal(parsed.pathname.endsWith('/workers/scripts-search'), true);
      assert.equal(parsed.searchParams.get('name'), identity.workerName);
      const payload = { success: true, result: [] };
      if (resultInfo !== undefined) payload.result_info = resultInfo;
      return response(payload);
    },
  });
  assert.equal(result, null); assert.equal(reads, 1);
});

for (const status of [400, 404]) {
  for (const [label, metadata] of [['result', { result: 'malformed' }], ['result_info', { result_info: 'malformed' }]]) {
    test(`HTTP ${status} code-10007-only absence ignores unrelated malformed ${label}`, async () => {
      const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let mutations = 0;
      const result = await api.readWorkerVersions({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
        fetchImpl: async (url, options = {}) => {
          if ((options.method ?? 'GET') !== 'GET') mutations++;
          return response({ success: false, errors: [{ code: 10007, message: 'Worker not found' }], ...metadata }, status);
        },
      });
      assert.deepEqual(result, { status: 'ABSENT_ENDPOINT', versions: [] });
      assert.equal(mutations, 0);
    });
  }
}

test('deployment requires a persisted preflight and rederives ownership from trusted arguments before any request', async () => {
  const f = await deploymentFixture();
  try {
    for (const changes of [
      { preDeploymentIdentity: undefined },
      { apiToken: 'wrong-fake-token' },
      { context: { ...CONTEXT, runAttempt: '3' } },
      { preDeploymentIdentity: { ...f.options.preDeploymentIdentity, workerName: 'ss-dds-soak-gh-1-1-aaaaaaaaaaaa' } },
    ]) {
      let calls = 0;
      await assert.rejects(() => f.mod.deployAndVerifyWorkers({ ...f.options, ...changes, fetchImpl: async () => { calls++; throw new Error('must not request'); }, execFile: () => { calls++; } }), /predeployment|identity|ownership|context|attestation/i);
      assert.equal(calls, 0);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('deployment repeats collision checks before mutation and passes the same validated name and ownership tag on code-10007 retry', async () => {
  const f = await deploymentFixture(); let attempts = 0; const configs = [];
  try {
    const verified = await f.mod.deployAndVerifyWorkers({ ...f.options,
      execFile: (command, args, options) => {
        if (args[0] === 'deploy') {
          attempts++;
          const config = JSON.parse(require('node:fs').readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
          configs.push(config);
          assert.equal(config.name, f.identity.workerName);
          assert.ok(args.includes('--tag=' + f.identity.ownershipTag));
          assert.equal(JSON.stringify(config).includes('DDS_REMOTE_TEST_KEY'), false);
          f.setDeployed(true);
          if (attempts === 1) throw new Error('Worker does not exist [code: 10007]');
        }
        return f.execFile(command, args, options);
      },
    });
    assert.equal(attempts, 2);
    assert.deepEqual(configs[1], configs[0]);
    assert.equal(verified.versionId, 'deployed-v1');
    assert.equal(verified.temporaryWorkerName, f.identity.workerName);
    const firstDeploy = f.events.findIndex((e) => e.args?.[0] === 'deploy');
    for (const suffix of ['/workers/workers', '/workers/scripts-search']) {
      assert.ok(f.events.slice(0, firstDeploy).filter((e) => e.url && new URL(e.url).pathname.endsWith(suffix)).length >= 2);
    }
    const secret = f.events.find((e) => e.args?.[1] === 'secret');
    assert.equal(secret.input, KEY + '\n');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('both deploy attempts pass a canonical leading-hyphen ownership tag as one argument', async () => {
  const f = await deploymentFixture({ apiToken: 'leading-tag-fake-54' }); let attempts = 0;
  try {
    assert.match(f.identity.ownershipTag, /^-[A-Za-z0-9_-]{42}$/);
    assert.equal(Buffer.from(f.identity.ownershipTag, 'base64url').toString('base64url'), f.identity.ownershipTag);
    await f.mod.deployAndVerifyWorkers({ ...f.options, execFile: (command, args, options) => {
      if (args[0] === 'deploy') {
        attempts++;
        assert.equal(args.filter((arg) => arg.startsWith('--tag=')).length, 1);
        assert.ok(args.includes('--tag=' + f.identity.ownershipTag));
        assert.equal(args.includes('--tag'), false);
        assert.equal(args.includes(f.identity.ownershipTag), false);
        f.execFile(command, args, options);
        if (attempts === 1) throw new Error('Worker does not exist [code: 10007]');
        return '';
      }
      return f.execFile(command, args, options);
    } });
    assert.equal(attempts, 2);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('deployment records the SHA-256 of the exact local temporary configuration bytes consumed by Wrangler', async () => {
  const f = await deploymentFixture(); let bytes;
  try {
    const verified = await f.mod.deployAndVerifyWorkers({ ...f.options, execFile: (command, args, options) => {
      if (args[0] === 'deploy') bytes = require('node:fs').readFileSync(args[args.indexOf('--config') + 1]);
      return f.execFile(command, args, options);
    } });
    assert.equal(verified.localConfigurationSha256, require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Wrangler uses the same explicit account and source token as the collision and ownership API checks', async () => {
  const f = await deploymentFixture();
  try {
    await f.mod.deployAndVerifyWorkers({ ...f.options, execFile: (command, args, options) => {
      assert.equal(options.env?.CLOUDFLARE_ACCOUNT_ID, 'acct');
      assert.equal(options.env?.CLOUDFLARE_API_TOKEN, TOKEN);
      return f.execFile(command, args, options);
    } });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('default Wrangler invocation uses the project-local CLI for deploy, secret, and version', async () => {
  const f = await deploymentFixture(); const calls = [];
  const cliPath = join(__dirname, '../node_modules/wrangler/bin/wrangler.js');
  try {
    await f.mod.deployAndVerifyWorkers({ ...f.options, wrangler: undefined, execFile: (command, args, options) => {
      calls.push({ command, args: [...args] });
      const logicalArgs = args[0] === cliPath && args[1] !== 'secret' ? args.slice(1) : args;
      return f.execFile(command, logicalArgs, options);
    } });
    assert.deepEqual(calls.map(({ command }) => command), [process.execPath, process.execPath, process.execPath]);
    assert.deepEqual(calls.map(({ args }) => args.slice(0, 2)), [
      [cliPath, 'deploy'],
      [cliPath, 'secret'],
      [cliPath, '--version'],
    ]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('every Wrangler invocation uses the shared bounded UTF-8 child options', async () => {
  const f = await deploymentFixture(); const calls = [];
  try {
    await f.mod.deployAndVerifyWorkers({ ...f.options, execFile: (command, args, options) => {
      calls.push({ args: [...args], options: { ...options } });
      return f.execFile(command, args, options);
    } });
    const deploy = calls.find(({ args }) => args[0] === 'deploy');
    const secret = calls.find(({ args }) => args[1] === 'secret');
    const version = calls.find(({ args }) => args[0] === '--version');
    for (const call of [deploy, secret, version]) {
      assert.equal(call.options.encoding, 'utf8');
      assert.equal(call.options.windowsHide, true);
      assert.equal(call.options.killSignal, 'SIGTERM');
      assert.equal(call.options.maxBuffer, 4 * 1024 * 1024);
    }
    assert.equal(deploy.options.timeout, 120_000);
    assert.equal(secret.options.timeout, 120_000);
    assert.equal(version.options.timeout, 15_000);
    assert.equal(Object.hasOwn(deploy.options, 'input'), false);
    assert.equal(secret.options.input, KEY + '\n');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('direct subdomain lookup and workers.dev verification compose bounded request signals', async () => {
  const f = await deploymentFixture(); const direct = [];
  try {
    await f.mod.deployAndVerifyWorkers({ ...f.options, fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/workers/subdomain') || parsed.hostname.endsWith('.workers.dev')) {
        direct.push({ url, signal: options.signal });
      }
      return f.fetchImpl(url, options);
    } });
    assert.equal(direct.length, 2);
    for (const request of direct) assert.equal(request.signal instanceof AbortSignal, true, request.url);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('temporary directory cleanup failure becomes primary only after otherwise successful deployment', async () => {
  const f = await deploymentFixture();
  try {
    await assertDiagnostic(() => f.mod.deployAndVerifyWorkers({ ...f.options,
      removeDir: () => { throw new Error('private-temp-path-marker'); },
    }), 'TEMP_DIRECTORY_CLEANUP_FAILED');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const [label, configure, code] of [
    ['deploy failure', (f) => ({ execFile: (command, args, options) => {
      if (args[0] === 'deploy') throw new Error('private-deploy-marker');
      return f.execFile(command, args, options);
    } }), 'WRANGLER_DEPLOY_FAILED'],
    ['deploy timeout', (f) => ({ execFile: (command, args, options) => {
      if (args[0] === 'deploy') throw Object.assign(new Error('private-timeout-marker'), { code: 'ETIMEDOUT' });
      return f.execFile(command, args, options);
    } }), 'WRANGLER_DEPLOY_TIMEOUT'],
    ['secret failure', (f) => ({ execFile: (command, args, options) => {
      if (args[1] === 'secret') throw new Error('private-secret-marker');
      return f.execFile(command, args, options);
    } }), 'SECRET_UPLOAD_FAILED'],
    ['secret timeout', (f) => ({ execFile: (command, args, options) => {
      if (args[1] === 'secret') throw Object.assign(new Error('private-timeout-marker'), { code: 'ETIMEDOUT' });
      return f.execFile(command, args, options);
    } }), 'SECRET_UPLOAD_TIMEOUT'],
    ['subdomain failure', (f) => ({ fetchImpl: async (url, options) => {
      if (new URL(url).pathname.endsWith('/workers/subdomain')) throw new Error('private-subdomain-marker');
      return f.fetchImpl(url, options);
    } }), 'SUBDOMAIN_LOOKUP_FAILED'],
    ['subdomain timeout', (f) => ({ fetchImpl: async (url, options) => {
      if (new URL(url).pathname.endsWith('/workers/subdomain')) throw new DOMException('private-timeout-marker', 'TimeoutError');
      return f.fetchImpl(url, options);
    } }), 'SUBDOMAIN_LOOKUP_TIMEOUT'],
    ['version failure', (f) => ({ execFile: (command, args, options) => {
      if (args[0] === '--version') throw new Error('private-version-marker');
      return f.execFile(command, args, options);
    } }), 'IMMUTABLE_VERSION_UNVERIFIED'],
    ['version timeout', (f) => ({ execFile: (command, args, options) => {
      if (args[0] === '--version') throw Object.assign(new Error('private-timeout-marker'), { code: 'ETIMEDOUT' });
      return f.execFile(command, args, options);
    } }), 'IMMUTABLE_VERSION_TIMEOUT'],
    ['endpoint failure', (f) => ({ fetchImpl: async (url, options) => {
      if (new URL(url).hostname.endsWith('.workers.dev')) throw new Error('private-endpoint-marker');
      return f.fetchImpl(url, options);
    } }), 'ENDPOINT_VERIFICATION_FAILED'],
    ['endpoint timeout', (f) => ({ fetchImpl: async (url, options) => {
      if (new URL(url).hostname.endsWith('.workers.dev')) throw new DOMException('private-timeout-marker', 'TimeoutError');
      return f.fetchImpl(url, options);
    } }), 'ENDPOINT_VERIFICATION_TIMEOUT'],
]) test('deployment stage classification: ' + label, async () => {
  const f = await deploymentFixture();
  try { await assertDiagnostic(() => f.mod.deployAndVerifyWorkers({ ...f.options, ...configure(f) }), code); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('preflight and ownership reads map nested request deadlines to their current stages', async () => {
  const identity = await ciIdentity(); const mod = await deployment();
  await assertDiagnostic(() => mod.preflightTemporaryWorkerIdentity({ accountId: 'acct', apiToken: TOKEN, identity, context: CONTEXT,
    fetchImpl: async () => { throw new DOMException('private-timeout-marker', 'TimeoutError'); },
  }), 'PREFLIGHT_TIMEOUT');

  for (const afterSecret of [false, true]) {
    const f = await deploymentFixture(); let deployed = false, uploaded = false;
    try {
      await assertDiagnostic(() => f.mod.deployAndVerifyWorkers({ ...f.options,
        execFile: (command, args, options) => {
          if (args[0] === 'deploy') deployed = true;
          if (args[1] === 'secret') uploaded = true;
          return f.execFile(command, args, options);
        },
        fetchImpl: async (url, options) => {
          const path = new URL(url).pathname;
          if (deployed && uploaded === afterSecret && path.endsWith('/workers/workers')) {
            throw new DOMException('private-timeout-marker', 'TimeoutError');
          }
          return f.fetchImpl(url, options);
        },
      }), afterSecret ? 'POST_SECRET_OWNERSHIP_TIMEOUT' : 'DEPLOYED_OWNERSHIP_TIMEOUT');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('deployment failure stays primary while rollback is secondary and directory cleanup is suppressed', async () => {
  const f = await deploymentFixture(); const dir = mkdtempSync(join(tmpdir(), 'remote-dds-precedence-'));
  try {
    const input = join(dir, 'predeployment.json'); writeFileSync(input, JSON.stringify(f.options.preDeploymentIdentity));
    const out = join(dir, 'deployment.json'); let stderr = '', exitCode;
    await f.mod.runDeploymentProcess(deploymentArgs('--deploy-from-identity', input, out),
      { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: TOKEN, DDS_REMOTE_TEST_KEY: KEY }, {
        root: f.root, fetchImpl: f.fetchImpl, wrangler: f.options.wrangler,
        execFile: (command, args, options) => {
          if (args[0] === 'deploy') { f.setDeployed(true); throw new Error('private-primary-marker'); }
          return f.execFile(command, args, options);
        },
        cleanupImpl: async () => { throw new Error('private-rollback-marker'); },
        removeDir: () => { throw new Error('private-directory-marker'); },
      }, { error: (value) => { stderr += value; }, setExitCode: (value) => { exitCode = value; } });
    assert.equal(exitCode, 1);
    assert.equal(stderr, 'Remote DDS deployment failed [WRANGLER_DEPLOY_FAILED].\n' +
      'Remote DDS rollback also failed [ROLLBACK_CLEANUP_FAILED].\n');
    for (const marker of ['private-primary-marker', 'private-rollback-marker', 'private-directory-marker']) {
      assert.equal(stderr.includes(marker), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(f.root, { recursive: true, force: true }); }
});

test('rollback cleanup timeout is secondary to the original deployment failure', async () => {
  const f = await deploymentFixture(); const dir = mkdtempSync(join(tmpdir(), 'remote-dds-rollback-timeout-'));
  try {
    const input = join(dir, 'predeployment.json'); writeFileSync(input, JSON.stringify(f.options.preDeploymentIdentity)); let stderr = '';
    await f.mod.runDeploymentProcess(deploymentArgs('--deploy-from-identity', input, join(dir, 'deployment.json')),
      { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: TOKEN, DDS_REMOTE_TEST_KEY: KEY }, {
        root: f.root, fetchImpl: f.fetchImpl, wrangler: f.options.wrangler,
        execFile: (command, args, options) => {
          if (args[0] === 'deploy') { f.setDeployed(true); throw new Error('private-primary-marker'); }
          return f.execFile(command, args, options);
        },
        cleanupImpl: async () => { throw new DOMException('private-timeout-marker', 'TimeoutError'); },
      }, { error: (value) => { stderr += value; }, setExitCode: () => {} });
    assert.equal(stderr, 'Remote DDS deployment failed [WRANGLER_DEPLOY_FAILED].\n' +
      'Remote DDS rollback also failed [ROLLBACK_CLEANUP_TIMEOUT].\n');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(f.root, { recursive: true, force: true }); }
});

test('deployment failure suppresses directory cleanup failure when rollback succeeds', async () => {
  const f = await deploymentFixture(); const dir = mkdtempSync(join(tmpdir(), 'remote-dds-directory-precedence-'));
  try {
    const input = join(dir, 'predeployment.json'); writeFileSync(input, JSON.stringify(f.options.preDeploymentIdentity));
    let stderr = '';
    await f.mod.runDeploymentProcess(deploymentArgs('--deploy-from-identity', input, join(dir, 'deployment.json')),
      { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: TOKEN, DDS_REMOTE_TEST_KEY: KEY }, {
        root: f.root, fetchImpl: f.fetchImpl, wrangler: f.options.wrangler,
        execFile: (command, args, options) => {
          if (args[0] === 'deploy') { f.setDeployed(true); throw new Error('private-primary-marker'); }
          return f.execFile(command, args, options);
        },
        cleanupImpl: async () => ({ status: 'deleted' }),
        removeDir: () => { throw new Error('private-directory-marker'); },
      }, { error: (value) => { stderr += value; }, setExitCode: () => {} });
    assert.equal(stderr, 'Remote DDS deployment failed [WRANGLER_DEPLOY_FAILED].\n');
    assert.equal(stderr.includes('private-directory-marker'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(f.root, { recursive: true, force: true }); }
});

for (const [label, rollbackFailure, rollbackCode] of [
  ['discovery failure', new Error('private-discovery-marker'), 'ROLLBACK_DISCOVERY_FAILED'],
  ['discovery timeout', new DOMException('private-timeout-marker', 'TimeoutError'), 'ROLLBACK_DISCOVERY_TIMEOUT'],
]) test('rollback classification: ' + label, async () => {
  const f = await deploymentFixture(); const dir = mkdtempSync(join(tmpdir(), 'remote-dds-rollback-stage-')); let deployed = false;
  try {
    const input = join(dir, 'predeployment.json'); writeFileSync(input, JSON.stringify(f.options.preDeploymentIdentity)); let stderr = '';
    await f.mod.runDeploymentProcess(deploymentArgs('--deploy-from-identity', input, join(dir, 'deployment.json')),
      { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: TOKEN, DDS_REMOTE_TEST_KEY: KEY }, {
        root: f.root, wrangler: f.options.wrangler,
        execFile: (command, args, options) => {
          if (args[0] === 'deploy') { deployed = true; f.setDeployed(true); throw new Error('private-primary-marker'); }
          return f.execFile(command, args, options);
        },
        fetchImpl: async (url, options) => {
          if (deployed && new URL(url).pathname.endsWith('/workers/workers')) throw rollbackFailure;
          return f.fetchImpl(url, options);
        },
      }, { error: (value) => { stderr += value; }, setExitCode: () => {} });
    assert.equal(stderr, 'Remote DDS deployment failed [WRANGLER_DEPLOY_FAILED].\n' +
      `Remote DDS rollback also failed [${rollbackCode}].\n`);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(f.root, { recursive: true, force: true }); }
});

test('a real timed-out synchronous Wrangler child returns control with a safe stage code', { skip: process.platform !== 'win32' }, async () => {
  const f = await deploymentFixture(); const dir = mkdtempSync(join(tmpdir(), 'remote-dds-child-timeout-'));
  const command = join(dir, 'slow-wrangler.cmd');
  writeFileSync(command, `@echo off\r\n"${process.execPath}" -e "setTimeout(()=>{},5000)"\r\n`, 'utf8');
  const started = Date.now();
  try {
    await assertDiagnostic(() => f.mod.deployAndVerifyWorkers({ ...f.options, wrangler: command,
      execFile: require('node:child_process').execFileSync, wranglerOperationTimeoutMs: 50,
    }), 'WRANGLER_DEPLOY_TIMEOUT');
    assert.ok(Date.now() - started < 2_000, 'timed-out synchronous child did not return control promptly');
  } finally {
    // On hosted Windows runners, killing a timed-out .cmd process can leave its
    // descendant alive just long enough to hold its command or cwd open.
    removeTreeAfterWindowsChildExit(dir);
    removeTreeAfterWindowsChildExit(f.root);
  }
});

test('Windows child cleanup retries only transient directory locks with bounded linear backoff', () => {
  const delays = [];
  let attempts = 0;
  removeTreeAfterWindowsChildExit('fixture', {
    remove(path, options) {
      assert.equal(path, 'fixture');
      assert.deepEqual(options, { recursive: true, force: true });
      attempts++;
      if (attempts < 3) throw Object.assign(new Error('locked'), { code: attempts === 1 ? 'EBUSY' : 'EPERM' });
    },
    sleep(delayMs) { delays.push(delayMs); },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);

  assert.throws(() => removeTreeAfterWindowsChildExit('fixture', {
    remove() { throw Object.assign(new Error('unexpected'), { code: 'EIO' }); },
    sleep() { throw new Error('must not sleep'); },
  }), { code: 'EIO' });
});

test('a new collision between persisted preflight and deployment causes zero mutation', async () => {
  const f = await deploymentFixture(); f.setDeployed(true);
  try {
    await assert.rejects(() => f.mod.deployAndVerifyWorkers(f.options), /collision|already exists/i);
    assert.equal(f.events.filter((e) => e.command || e.method === 'DELETE').length, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('version verification requires the immutable version id and matching workers/tag annotation', async () => {
  const mod = await deployment(); const identity = await ciIdentity();
  const args = { accountId: 'acct / one', scriptName: identity.workerName, apiToken: TOKEN, expectedVersionId: 'deployed-v1', ownershipTag: identity.ownershipTag, wranglerVersion: '4.33.0' };
  const verified = await mod.verifyWorkersDeployment({ ...args, fetchImpl: async (url) => {
    assert.ok(url.includes('/accounts/acct%20%2F%20one/workers/scripts/' + identity.workerName + '/versions/deployed-v1'));
    return response(versionDetail(identity));
  } });
  assert.equal(verified.scriptETag, 'script-etag-1');
  for (const tag of [null, 'b'.repeat(43)]) await assert.rejects(() => mod.verifyWorkersDeployment({ ...args, fetchImpl: async () => response(versionDetail(identity, tag)) }), /ownership|tag/i);
  await assertDiagnostic(() => mod.verifyWorkersDeployment({ ...args, fetchImpl: async () => response({ ...versionDetail(identity), result: { ...versionDetail(identity).result, id: 'other' } }) }), 'API_RESPONSE_INVALID');
});

for (const [label, tag, versions, deletes] of [
  ['no deployed versions', null, false, true],
  ['matching immutable ownership', 'matching', true, true],
  ['missing ownership', null, true, false],
  ['foreign ownership', 'b'.repeat(43), true, false],
]) test('failed deployment partial cleanup: ' + label, async () => {
  const f = await deploymentFixture(); let attempts = 0, deleted = false;
  try {
    await assertDiagnostic(() => f.mod.deployAndVerifyWorkers({ ...f.options,
      execFile: (command, args) => {
        assert.equal(args[0], 'deploy'); attempts++; f.setDeployed(true);
        throw new Error('Worker does not exist [code: 10007]');
      },
      fetchImpl: async (url, options = {}) => {
        if (options.method === 'DELETE' && !url.endsWith('/subdomain')) { deleted = true; assert.ok(url.endsWith('/workers/workers/' + WORKER_ID)); return f.fetchImpl(url, options); }
        if (!versions && new URL(url).pathname.endsWith('/workers/scripts/' + f.identity.workerName)) return notFound();
        if (!versions && new URL(url).pathname.endsWith('/workers/scripts-search')) return response(page([]));
        if (new URL(url).pathname.endsWith('/versions')) return response(versionPage(versions ? [{ id: 'deployed-v1' }] : []));
        if (url.endsWith('/versions/deployed-v1')) return response(versionDetail(f.identity, tag === 'matching' ? f.identity.ownershipTag : tag));
        return f.fetchImpl(url, options);
      },
    }), deletes ? 'WRANGLER_DEPLOY_FAILED' : 'DEPLOYED_OWNERSHIP_UNVERIFIED');
    assert.equal(attempts, deletes ? 2 : 1); assert.equal(deleted, deletes);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('deployment refuses mismatched remote build/version evidence before generating a manifest', async () => {
  for (const field of ['buildId', 'workerVersionId']) {
    const f = await deploymentFixture();
    try {
      await assertDiagnostic(() => f.mod.deployAndVerifyWorkers({ ...f.options, fetchImpl: async (url, options) => {
        if (new URL(url).hostname.endsWith('.workers.dev')) {
          const payload = await (await f.fetchImpl(url, options)).json(); payload.operationResult[field] = 'wrong-' + field;
          return response(payload);
        }
        return f.fetchImpl(url, options);
      } }), 'ENDPOINT_VERIFICATION_FAILED');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('shared API finds later-page exact objects and legacy scripts without treating dual API representations as duplicates', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity();
  const reads = [];
  const options = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName, fetchImpl: async (url) => {
    const parsed = new URL(url), number = Number(parsed.searchParams.get('page') ?? '1'); reads.push(url);
    assert.equal(parsed.searchParams.get('per_page'), '100');
    if (parsed.pathname.endsWith('/workers/workers')) return response(page(number === 1 ? [{ id: 'c'.repeat(32), name: 'other' }] : [{ id: WORKER_ID, name: identity.workerName }], number, 2, 1, 2));
    if (parsed.pathname.endsWith('/workers/scripts-search')) {
      assert.equal(parsed.searchParams.get('name'), identity.workerName);
      return response(page(number === 1 ? [{ script_name: 'near-' + identity.workerName }] : [{ script_name: identity.workerName }], number, 2, 1, 2));
    }
    throw new Error('unexpected');
  } };
  assert.deepEqual(await api.findExactWorker(options), { id: WORKER_ID, name: identity.workerName });
  assert.equal((await api.listLegacyExactScript(options)).name, identity.workerName);
  assert.equal(reads.length, 4);
});

test('presence readers preserve normalized records for ownership and cleanup consumers', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity();
  const options = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName, ownershipTag: identity.ownershipTag,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/workers/workers')) return response(page([{ id: WORKER_ID, name: identity.workerName }]));
      if (path.endsWith('/workers/scripts-search')) return response(page([{ script_name: identity.workerName }]));
      if (path.endsWith('/workers/scripts/' + identity.workerName)) return response({});
      if (path.endsWith('/versions')) return response(versionPage([{ id: 'deployed-v1' }]));
      if (path.endsWith('/versions/deployed-v1')) return response(versionDetail(identity));
      throw new Error('unexpected presence read');
    },
  };
  const worker = await api.findExactWorker(options);
  const legacy = await api.listLegacyExactScript({ ...options, includeExact: true });
  assert.deepEqual(worker, { id: WORKER_ID, name: identity.workerName });
  assert.deepEqual(legacy, { name: identity.workerName });
  const snapshot = await api.readOwnershipSnapshot(options);
  assert.deepEqual(snapshot.worker, worker);
  assert.deepEqual(snapshot.legacy, legacy);
  assert.equal(snapshot.versionEvidence.status, 'PRESENT');
  assert.equal(snapshot.versionEvidence.versions[0].id, 'deployed-v1');
});

const strictPaginationFailures = ['missing count', 'missing total count', 'count mismatch', 'total count exceeds capacity', 'total pages mismatch', 'total count drift', 'short nonfinal page', 'short final page'];
const permittedSearchTotalShapes = new Set(['missing count', 'missing total count', 'total count exceeds capacity', 'total pages mismatch', 'total count drift', 'short nonfinal page', 'short final page']);

for (const target of ['objects', 'legacy', 'versions']) {
  const failures = target === 'objects'
    ? ['inconsistent pages', 'non-advancing page', 'duplicate exact']
    : target === 'legacy'
      ? ['inconsistent pages', 'non-advancing page', 'duplicate exact']
      : ['inconsistent pages', 'non-advancing page', 'duplicate exact'];
  for (const bad of failures) {
    test(target + ' pagination fails closed on ' + bad, async () => {
      const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let reads = 0;
      const item = target === 'objects' ? { id: WORKER_ID, name: identity.workerName } : target === 'legacy' ? { script_name: identity.workerName } : { id: 'deployed-v1' };
      const fetchImpl = async (url) => {
        if (url.endsWith('/versions/deployed-v1')) return response(versionDetail(identity));
        reads++;
        const items = ['duplicate exact', 'inconsistent pages', 'non-advancing page'].includes(bad) ? [item] : [];
        let metadata;
        if (bad === 'malformed cursor') metadata = { cursor: 123 };
        else if (bad === 'repeated cursor') metadata = { cursor: 'same' };
        else if (bad === 'cyclic cursor') metadata = { cursor: reads % 2 ? 'a' : 'b' };
        else if (bad === 'inconsistent pages') metadata = { page: reads, per_page: 1, total_pages: reads === 1 ? 2 : 3, count: 1, total_count: reads === 1 ? 2 : 3 };
        else if (bad === 'non-advancing page') metadata = { page: 1, per_page: 1, total_pages: 2, count: 1, total_count: 2 };
        else if (bad === 'duplicate exact') metadata = { page: reads, per_page: 1, total_pages: 2, count: 1, total_count: 2 };
        const payload = { success: true, result: target === 'versions' ? { items } : items };
        if (metadata) payload.result_info = metadata;
        return response(payload);
      };
      const options = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName, fetchImpl };
      const method = target === 'objects' ? api.findExactWorker : target === 'legacy' ? api.listLegacyExactScript : api.readWorkerVersions;
      await assertDiagnostic(() => method(options), 'API_RESPONSE_INVALID');
      assert.ok(reads <= 3);
    });
  }
}

function listingItem(target, index) {
  return target === 'objects' ? { id: (index + 1).toString(16).padStart(32, '0'), name: 'other-' + index }
    : target === 'legacy' ? { script_name: 'other-' + index } : { id: 'other-v' + index };
}
function listingPayload(target, items, ...args) { return target === 'versions' ? versionPage(items, ...args) : page(items, ...args); }
function listingMethod(api, target) { return target === 'objects' ? api.findExactWorker : target === 'legacy' ? api.listLegacyExactScript : api.readWorkerVersions; }

for (const target of ['objects', 'legacy', 'versions']) {
  test(target + ' complete listing rejects duplicate non-target identities on different pages', async () => {
    const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity();
    const options = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes('/versions/')) {
        const detail = versionDetail(identity); detail.result.id = 'other-v0'; return response(detail);
      }
      return response(listingPayload(target, [listingItem(target, 0)], Number(parsed.searchParams.get('page')), 2, 1, 2));
    } };
    await assertDiagnostic(() => listingMethod(api, target)(options), 'API_RESPONSE_INVALID');
  });

  for (const bad of target === 'versions' ? [] : strictPaginationFailures) {
    const searchShapeIsDocumented = target === 'legacy' && permittedSearchTotalShapes.has(bad);
    test(target + ' pagination ' + (searchShapeIsDocumented ? 'accepts documented ' : 'refuses ') + bad, async () => {
      const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity();
      const options = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName, fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.includes('/versions/')) {
          const detail = versionDetail(identity); detail.result.id = decodeURIComponent(parsed.pathname.split('/').at(-1)); return response(detail);
        }
        const number = Number(parsed.searchParams.get('page'));
        const count = number === 1 ? (bad === 'short nonfinal page' ? 1 : 100) : bad === 'short final page' ? 0 : 1;
        const items = Array.from({ length: count }, (_, i) => listingItem(target, (number - 1) * 100 + i));
        const payload = listingPayload(target, items, number, 2, 100, 101);
        if (bad === 'missing count') delete payload.result_info.count;
        if (bad === 'missing total count') delete payload.result_info.total_count;
        if (bad === 'count mismatch') payload.result_info.count++;
        if (bad === 'total count exceeds capacity') payload.result_info.total_count = 201;
        if (bad === 'total pages mismatch') payload.result_info.total_pages = 3;
        if (bad === 'total count drift' && number === 2) payload.result_info.total_count = 102;
        return response(payload);
      } };
      if (searchShapeIsDocumented) assert.equal(await listingMethod(api, target)(options), null);
      else await assertDiagnostic(() => listingMethod(api, target)(options), 'API_RESPONSE_INVALID');
    });
  }

  test(target + ' pagination accepts a full first page and smaller final page with consistent totals', async () => {
    const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let pages = 0;
    const options = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName, fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes('/versions/')) {
        const detail = versionDetail(identity); detail.result.id = decodeURIComponent(parsed.pathname.split('/').at(-1)); return response(detail);
      }
      pages++; const number = Number(parsed.searchParams.get('page'));
      return response(listingPayload(target, Array.from({ length: number === 1 ? 100 : 1 }, (_, i) => listingItem(target, (number - 1) * 100 + i)), number, 2, 100, 101));
    } };
    const result = await listingMethod(api, target)(options);
    assert.equal(pages, 2);
    if (target === 'versions') assert.equal(result.versions.length, 101);
    else assert.equal(result, null);
  });
}

test('legacy search traverses every reported page when unfiltered totals and sparse filtered pages diverge', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let pages = 0;
  const result = await api.listLegacyExactScript({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url) => {
      pages++; const number = Number(new URL(url).searchParams.get('page'));
      return response(page(number === 1 ? [{ script_name: 'other' }] : [], number, 2, 100, 201));
    },
  });
  assert.equal(pages, 2); assert.equal(result, null);
});

test('current Worker list refuses one immutable ID associated with conflicting names', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity();
  await assertDiagnostic(() => api.findExactWorker({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async () => response(page([{ id: WORKER_ID, name: 'other' }, { id: WORKER_ID, name: 'changed' }])),
  }), 'API_RESPONSE_INVALID');
});

for (const [label, resultInfo] of [
  ['only page and per_page', (number) => ({ page: number, per_page: 100 })],
  ['no result_info', () => undefined],
  ['null result_info', () => null],
]) test('current Worker list accepts official V4 pagination with ' + label, async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let pages = 0;
  const result = await api.findExactWorker({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url) => {
      pages++; const number = Number(new URL(url).searchParams.get('page'));
      const payload = { success: true, result: number === 1 ? [{ id: WORKER_ID, name: 'other' }] : [] };
      const info = resultInfo(number);
      if (info !== undefined) payload.result_info = info;
      return response(payload);
    },
  });
  assert.equal(result, null); assert.equal(pages, 2);
});

test('current Worker V4 pagination rejects a repeated nonempty page without totals', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let pages = 0;
  await assertDiagnostic(() => api.findExactWorker({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url) => {
      pages++;
      if (pages > 2) throw new Error('pagination continued after a repeated page');
      const number = Number(new URL(url).searchParams.get('page'));
      return response({ success: true, result: [{ id: WORKER_ID, name: 'other' }], result_info: { page: number, per_page: 100 } });
    },
  }), 'API_RESPONSE_INVALID');
  assert.equal(pages, 2);
});

test('immutable version list accepts official V4 pagination without result_info', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let pages = 0;
  const options = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName, fetchImpl: async (url) => {
    const parsed = new URL(url); const number = Number(parsed.searchParams.get('page'));
    if (parsed.pathname.endsWith('/versions/deployed-v1')) return response(versionDetail(identity));
    pages++;
    return response({ success: true, result: { items: number === 1 ? [{ id: 'deployed-v1' }] : [] } });
  } };
  const result = await api.readWorkerVersions(options);
  assert.equal(pages, 2);
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.versions[0].id, 'deployed-v1');
});

test('immutable version list accepts official V4 pagination with null result_info', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let pages = 0;
  const result = await api.readWorkerVersions({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/versions/deployed-v1')) return response(versionDetail(identity));
      pages++; return response({ success: true, result: { items: pages === 1 ? [{ id: 'deployed-v1' }] : [] }, result_info: null });
    } });
  assert.equal(pages, 2); assert.equal(result.versions[0].id, 'deployed-v1');
});

test('immutable version detail accepts documented object-shaped bindings', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity();
  const detail = versionDetail(identity); detail.result.resources.bindings = {};
  const result = await api.readWorkerVersions({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url) => url.endsWith('/versions/deployed-v1') ? response(detail) : response(versionPage([{ id: 'deployed-v1' }])) });
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.versions[0].ownershipTag, identity.ownershipTag);
});

for (const bad of ['duplicate non-target Worker', 'total_count 201 on two pages']) test('absence confirmation refuses ' + bad, async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity();
  await assertDiagnostic(() => api.confirmExactAbsence({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async (url) => {
      const parsed = new URL(url), number = Number(parsed.searchParams.get('page'));
      if (parsed.pathname.endsWith('/workers/scripts/' + identity.workerName)) return notFound();
      if (parsed.pathname.endsWith('/workers/scripts-search')) return response(page([]));
      const items = Array.from({ length: number === 1 ? 100 : 1 }, (_, i) => listingItem('objects', number === 2 && bad === 'duplicate non-target Worker' ? 0 : (number - 1) * 100 + i));
      return response(page(items, number, 2, 100, bad === 'total_count 201 on two pages' ? 201 : 101));
    },
  }), 'API_WORKERS_LIST_RESPONSE_INVALID');
});

test('shared API normalizes every immutable version with script ETag and canonical config fingerprint without credentials', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity();
  const { canonicalJson } = await import('../scripts/remote-dds-soak-state.mjs'); const crypto = require('node:crypto');
  const detail = versionDetail(identity);
  const result = await api.readWorkerVersions({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName, fetchImpl: async (url) => {
    if (url.endsWith('/versions/deployed-v1')) return response(detail);
    return response(versionPage([{ id: 'deployed-v1' }]));
  } });
  assert.equal(result.status, 'PRESENT'); const records = result.versions;
  assert.equal(records.length, 1); assert.equal(records[0].id, 'deployed-v1'); assert.equal(records[0].ownershipTag, identity.ownershipTag);
  assert.equal(records[0].scriptETag, 'script-etag-1');
  assert.equal(records[0].versionConfigurationSha256, crypto.createHash('sha256').update(canonicalJson({ bindings: detail.result.resources.bindings, script_runtime: detail.result.resources.script_runtime })).digest('hex'));
  assert.equal(JSON.stringify(records).includes(TOKEN), false);
});

test('a missing versions endpoint returns typed absence, while missing immutable detail and permission failures refuse', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity();
  const options = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName };
  for (const payload of [notFound(), notFound(400)]) {
    assert.deepEqual(await api.readWorkerVersions({ ...options, fetchImpl: async () => payload }), { status: 'ABSENT_ENDPOINT', versions: [] });
  }
  for (const [status, code] of [[401, 'API_AUTH_OR_PERMISSION'], [403, 'API_AUTH_OR_PERMISSION'], [500, 'API_RESPONSE_INVALID']]) {
    await assertDiagnostic(() => api.readWorkerVersions({ ...options, fetchImpl: async () => response({ success: false }, status) }), code);
  }
  await assertDiagnostic(() => api.readWorkerVersions({ ...options, versionId: 'missing', fetchImpl: async () => response({}, 404) }), 'API_RESPONSE_INVALID');
});

const unsafeAbsenceCases = [
  ['HTTP 401 with not-found code', 401, [{ code: 10007 }], 'API_AUTH_OR_PERMISSION'],
  ['HTTP 403 with not-found code', 403, [{ code: 10007 }], 'API_AUTH_OR_PERMISSION'],
  ['HTTP 500 with not-found code', 500, [{ code: 10007 }], 'API_REQUEST_FAILED'],
  ['HTTP 503 with not-found code', 503, [{ code: 10007 }], 'API_REQUEST_FAILED'],
  ['HTTP 429 with not-found code', 429, [{ code: 10007 }], 'API_REQUEST_FAILED'],
  ['HTTP 200 with failure envelope', 200, [{ code: 10007 }], 'API_REQUEST_FAILED'],
  ['HTTP 404 without errors', 404, undefined, 'API_RESPONSE_INVALID'],
  ['HTTP 404 with empty errors', 404, [], 'API_RESPONSE_INVALID'],
  ['HTTP 404 with mixed errors', 404, [{ code: 10007 }, { code: 10000, message: 'Authentication error' }], 'API_AUTH_OR_PERMISSION'],
  ['HTTP 400 with mixed errors', 400, [{ code: 10007 }, { code: 10000, message: 'Authentication error' }], 'API_AUTH_OR_PERMISSION'],
  ['HTTP 404 with permission error', 404, [{ code: 10007, message: 'Permission denied' }], 'API_AUTH_OR_PERMISSION'],
  ['HTTP 400 with service error', 400, [{ code: 10007, message: 'Internal service error' }], 'API_REQUEST_FAILED'],
  ['HTTP 404 with an unknown code', 404, [{ code: 10000 }], 'API_REQUEST_FAILED'],
];

for (const [label, status, errors, expectedCode] of unsafeAbsenceCases) {
  const failedResponse = () => response({ success: false, ...(errors === undefined ? {} : { errors }) }, status);
  test('typed versions absence refuses ' + label, async () => {
    const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity();
    await assertDiagnostic(() => api.readWorkerVersions({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
      fetchImpl: async () => failedResponse(),
    }), expectedCode);
  });

  test('placeholder cleanup is never authorized by ' + label, async () => {
    const f = await deploymentFixture(); let attempts = 0, deletes = 0, secrets = 0;
    try {
      await assertDiagnostic(() => f.mod.deployAndVerifyWorkers({ ...f.options,
        execFile: (command, args) => {
          if (args[1] === 'secret') secrets++;
          attempts++; f.setDeployed(true); throw new Error('Worker does not exist [code: 10007]');
        },
        fetchImpl: async (url, options = {}) => {
          if (options.method === 'DELETE') deletes++;
          const path = new URL(url).pathname;
          if (path.endsWith('/versions')) return failedResponse();
          if (path.endsWith('/workers/scripts/' + f.identity.workerName)) return notFound();
          if (path.endsWith('/workers/scripts-search')) return response(page([]));
          return f.fetchImpl(url, options);
        },
      }), expectedCode);
      assert.equal(attempts, 1); assert.equal(secrets, 0); assert.equal(deletes, 0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

for (const method of ['confirmExactAbsence', 'listLegacyExactScript']) test(method + ' refuses an exact HTTP 404 carrying mixed not-found and permission errors', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity();
  await assertDiagnostic(() => api[method]({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName, includeExact: true,
    fetchImpl: async (url) => new URL(url).pathname.endsWith('/workers/scripts/' + identity.workerName)
      ? response({ success: false, errors: [{ code: 10007 }, { code: 10000 }] }, 404) : response(page([])),
  }), 'API_REQUEST_FAILED');
});

test('an absent versions endpoint permits cleanup only for a current exact placeholder with both legacy readers absent', async () => {
  for (const legacyExists of [false, true]) {
    const f = await deploymentFixture(); let deletes = 0;
    try {
      await assertDiagnostic(() => f.mod.deployAndVerifyWorkers({ ...f.options,
        execFile: () => { f.setDeployed(true); throw new Error('Worker does not exist [code: 10007]'); },
        fetchImpl: async (url, options = {}) => {
          if (options.method === 'DELETE' && !url.endsWith('/subdomain')) deletes++;
          const path = new URL(url).pathname;
          if (path.endsWith('/versions')) return notFound();
          if (!legacyExists && path.endsWith('/workers/scripts/' + f.identity.workerName)) return notFound();
          if (!legacyExists && path.endsWith('/workers/scripts-search')) return response(page([]));
          return f.fetchImpl(url, options);
        },
      }), legacyExists ? 'DEPLOYED_OWNERSHIP_UNVERIFIED' : 'WRANGLER_DEPLOY_FAILED');
      assert.equal(deletes, legacyExists ? 0 : 1);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('PRESENT empty versions with a legacy exact script cannot authorize retry or rollback cleanup', async () => {
  const f = await deploymentFixture(); let attempts = 0, deletes = 0;
  try {
    await assertDiagnostic(() => f.mod.deployAndVerifyWorkers({ ...f.options,
      execFile: () => { attempts++; f.setDeployed(true); throw new Error('Worker does not exist [code: 10007]'); },
      fetchImpl: async (url, options = {}) => {
        if (options.method === 'DELETE') deletes++;
        if (new URL(url).pathname.endsWith('/versions')) return response(versionPage([]));
        return f.fetchImpl(url, options);
      },
    }), 'DEPLOYED_OWNERSHIP_UNVERIFIED');
    assert.equal(attempts, 1); assert.equal(deletes, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('temporary configuration removes production routes and rejects persisted test key material', async () => {
  const mod = await deployment(); const root = repo(); const identity = await ciIdentity();
  try {
    writeFileSync(join(root, 'workers/wrangler.jsonc'), JSON.stringify({ name: 'normal-worker', main: 'src/index.mjs', workers_dev: false, routes: [{ pattern: 'stepstone.hogetsu.uk/*' }] }));
    const config = mod.createTemporaryWorkersConfig({ root, temporaryWorkerName: identity.workerName });
    assert.equal(config.name, identity.workerName); assert.equal(config.workers_dev, true); assert.equal('routes' in config, false);
    writeFileSync(join(root, 'workers/wrangler.jsonc'), JSON.stringify({ name: 'normal', main: 'src/index.mjs', vars: { DDS_REMOTE_TEST_KEY: KEY } }));
    assert.throws(() => mod.createTemporaryWorkersConfig({ root, temporaryWorkerName: identity.workerName }), /test key|DDS_REMOTE_TEST_KEY/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shared timeout helper exports bounded deadlines and rejects unsafe timeout values locally', async () => {
  const timeouts = await import('../scripts/remote-dds-timeouts.mjs');
  assert.equal(timeouts.MANAGEMENT_API_TIMEOUT_MS, 30_000);
  assert.equal(timeouts.ENDPOINT_PROBE_TIMEOUT_MS, 15_000);
  for (const timeoutMs of [undefined, null, '100', 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    assert.throws(() => timeouts.deadlineSignal({ timeoutMs }), /positive safe integer|supported timeout/i);
  }
});

test('shared timeout helper composes caller cancellation and classifies timeouts structurally', async () => {
  const { deadlineSignal, isTimeoutError } = await import('../scripts/remote-dds-timeouts.mjs');
  const caller = new AbortController();
  const composed = deadlineSignal({ signal: caller.signal, timeoutMs: 1_000 });
  caller.abort(new DOMException('caller-private-marker', 'AbortError'));
  assert.equal(composed.aborted, true);
  assert.equal(composed.reason, caller.signal.reason);
  assert.equal(isTimeoutError(composed.reason), false);

  const timeout = deadlineSignal({ timeoutMs: 1 });
  await new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('deadline did not abort')), 1_000);
    timeout.addEventListener('abort', () => { clearTimeout(keepAlive); resolve(); }, { once: true });
  });
  assert.equal(timeout.aborted, true);
  assert.equal(isTimeoutError(timeout.reason), true);
  assert.equal(isTimeoutError(Object.assign(new Error('private-marker'), { code: 'ETIMEDOUT' })), true);
  assert.equal(isTimeoutError(Object.assign(new Error('private-marker'), { name: 'AbortError', cause: timeout.reason })), true);
  assert.equal(isTimeoutError(new Error('timeout private-marker')), false);
  assert.equal(isTimeoutError(new DOMException('private-marker', 'AbortError')), false);
});

test('every shared management request receives a composed abort signal', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs');
  const identity = await ciIdentity();
  let present = false;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, signal: init.signal });
    const path = new URL(url).pathname;
    if (path.endsWith(`/workers/scripts/${identity.workerName}`)) return present ? response({}) : notFound();
    if (path.endsWith('/workers/workers')) return response(page(present ? [{ id: WORKER_ID, name: identity.workerName }] : []));
    if (path.endsWith('/workers/scripts-search')) return response(page(present ? [{ script_name: identity.workerName }] : []));
    if (path.endsWith('/versions')) return response(versionPage([{ id: 'deployed-v1' }]));
    if (path.endsWith('/versions/deployed-v1')) return response(versionDetail(identity));
    if (init.method === 'DELETE' && path.endsWith('/subdomain')) {
      return response({ success: true, result: { enabled: false, previews_enabled: false }, errors: [], messages: [] });
    }
    if (init.method === 'DELETE' && path.endsWith(`/workers/workers/${WORKER_ID}`)) return response({ success: true });
    throw new Error('Unexpected test request');
  };
  const options = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName, fetchImpl };

  const assertOperationSignals = async (operation) => {
    const start = calls.length;
    await operation();
    const operationCalls = calls.slice(start);
    assert.ok(operationCalls.length > 0);
    assert.ok(operationCalls.every(({ signal }) => signal instanceof AbortSignal));
  };

  await assertOperationSignals(() => api.confirmExactAbsence(options));
  present = true;
  let snapshot;
  await assertOperationSignals(async () => {
    snapshot = await api.readOwnershipSnapshot({ ...options, ownershipTag: identity.ownershipTag });
  });
  await assertOperationSignals(() => api.disableWorkersDevSubdomain({ ...options, worker: snapshot.worker }));
  await assertOperationSignals(() => api.deleteExactWorker({ ...options, worker: snapshot.worker }));
});

test('management API safely brands caller aborts and internal request deadlines', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs');
  const timeouts = await import('../scripts/remote-dds-timeouts.mjs');
  const errors = await import('../scripts/remote-dds-public-errors.mjs');
  const identity = await ciIdentity();
  const privateMarker = 'arbitrary-fetch-error-marker-must-not-leak';
  const abortAwareFetch = async (url, { signal }) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('request deadline did not abort')), 1_000);
    const fail = () => { clearTimeout(keepAlive); reject(new Error(privateMarker, { cause: signal.reason })); };
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  const base = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName, fetchImpl: abortAwareFetch };

  const caller = new AbortController();
  caller.abort(new DOMException(privateMarker, 'AbortError'));
  await assert.rejects(() => api.confirmExactAbsence({ ...base, signal: caller.signal }), (error) => {
    assert.equal(errors.publicDiagnosticCode(error), 'API_REQUEST_FAILED');
    assert.equal(timeouts.isTimeoutError(error), false);
    assert.equal(errors.renderRemoteDdsFailure(error), 'Remote DDS deployment failed [API_REQUEST_FAILED].');
    assert.equal(errors.renderRemoteDdsFailure(error).includes(privateMarker), false);
    return true;
  });

  await assert.rejects(() => api.confirmExactAbsence({ ...base, requestTimeoutMs: 1 }), (error) => {
    assert.equal(errors.publicDiagnosticCode(error), 'API_REQUEST_FAILED');
    assert.equal(timeouts.isTimeoutError(error), true);
    assert.equal(errors.renderRemoteDdsFailure(error), 'Remote DDS deployment failed [API_REQUEST_FAILED].');
    assert.equal(errors.renderRemoteDdsFailure(error).includes(privateMarker), false);
    return true;
  });
});

test('shared mutation API disables only the exact workers.dev subdomain and deletes only the verified immutable object', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); const calls = [];
  const options = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName, fetchImpl: async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'GET') return response(page([{ id: WORKER_ID, name: identity.workerName }]));
    calls.push({ url, init }); return response(url.endsWith('/subdomain')
      ? { success: true, result: { enabled: false, previews_enabled: false }, errors: [], messages: [] } : { success: true });
  } };
  options.worker = await api.findExactWorker(options);
  await api.disableWorkersDevSubdomain(options);
  await api.deleteExactWorker(options);
  assert.ok(calls[0].url.endsWith('/workers/scripts/' + identity.workerName + '/subdomain'));
  assert.equal(calls[0].init.method, 'DELETE'); assert.equal(calls[0].init.body, undefined);
  assert.ok(calls[1].url.endsWith('/workers/workers/' + WORKER_ID)); assert.equal(calls[1].init.method, 'DELETE');
  await assert.rejects(() => api.deleteExactWorker({ ...options, worker: { id: WORKER_ID, name: 'production-worker' } }), /exact|temporary Worker/i);
  await assert.rejects(() => api.deleteExactWorker({ ...options, worker: { id: WORKER_ID, name: identity.workerName } }), /verified|normalized|exact/i);
  await assert.rejects(() => api.disableWorkersDevSubdomain({ ...options, worker: undefined }), /verified|normalized|exact/i);
  await assert.rejects(() => api.deleteExactWorker({ ...options, accountId: 'other-account' }), /verified|normalized|exact/i);
  await assert.rejects(() => api.disableWorkersDevSubdomain({ ...options, accountId: 'other-account' }), /verified|normalized|exact/i);
  assert.equal(calls.length, 2);
});

test('deployment CLI classifies invalid arguments and GitHub context without leaking boundary markers', async () => {
  for (const args of [
    ['--deploy-and-verify', '--out', 'unused.json'],
    ['--preflight', '--identity', 'x', '--out', 'unused.json'],
    ['--preflight', '--preflight', '--out', 'unused.json'],
    ['--preflight', '--deploy-from-identity', 'x', '--out', 'unused.json'],
    ['--unknown', '--out', 'unused.json'],
    ['--preflight', '--identity', SECRET_MARKERS[2], '--repository', SECRET_MARKERS[3], ...CONTEXT_ARGS.slice(2), '--out', SECRET_MARKERS[4]],
  ]) {
    const result = spawnSync(process.execPath, [DEPLOYMENT_CLI, ...args], { encoding: 'utf8', env: deploymentEnvironment() });
    assertDeploymentCliFailure(result, 'CLI_INPUT_INVALID');
  }
});

test('deployment CLI classifies overlong run identity components as CLI input before supplied identity validation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-dds-deployment-context-length-'));
  try {
    const input = join(dir, SECRET_MARKERS[2] + '.json'); writeFileSync(input, '{}');
    for (const [field, marker] of [['runId', '9'.repeat(80)], ['runAttempt', '8'.repeat(80)]]) {
      const context = { ...CONTEXT, [field]: marker };
      const args = ['--preflight', '--identity', input, '--repository', context.repository, '--workflow', context.workflow,
        '--run-id', context.runId, '--run-attempt', context.runAttempt, '--commit-sha', context.commitSha, '--out', join(dir, SECRET_MARKERS[5])];
      const result = spawnSync(process.execPath, [DEPLOYMENT_CLI, ...args], { encoding: 'utf8', env: deploymentEnvironment() });
      assertDeploymentCliFailure(result, 'CLI_INPUT_INVALID', [...SECRET_MARKERS, marker]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deployment CLI classifies missing, unreadable, and invalid-JSON input without leaking paths or content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-dds-deployment-input-'));
  try {
    const missing = join(dir, 'missing-' + SECRET_MARKERS[2]);
    const unreadable = join(dir, 'unreadable-' + SECRET_MARKERS[2]); mkdirSync(unreadable);
    const invalid = join(dir, 'invalid.json'); writeFileSync(invalid, `{${SECRET_MARKERS[4]} ${SECRET_MARKERS[5]}`);
    for (const input of [missing, unreadable, invalid]) {
      const result = spawnSync(process.execPath, [DEPLOYMENT_CLI, ...deploymentArgs('--preflight', input, join(dir, 'out.json'))],
        { encoding: 'utf8', env: deploymentEnvironment() });
      assertDeploymentCliFailure(result, 'CLI_INPUT_INVALID');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deployment CLI classifies missing account, token, and deploy-time key as required configuration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-dds-deployment-config-'));
  try {
    const identity = (await import('../scripts/remote-dds-ci-identity.mjs')).deriveCiIdentity({ ...CONTEXT, secret: SECRET_MARKERS[1] });
    const identityPath = join(dir, 'identity.json'); writeFileSync(identityPath, JSON.stringify(identity));
    for (const missing of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) {
      const result = spawnSync(process.execPath, [DEPLOYMENT_CLI, ...deploymentArgs('--preflight', identityPath, join(dir, `${missing}.json`))],
        { encoding: 'utf8', env: deploymentEnvironment({ [missing]: undefined }) });
      assertDeploymentCliFailure(result, 'REQUIRED_CONFIG_MISSING', [...SECRET_MARKERS, identity.workerName]);
    }
    const predeployment = (await import('../scripts/remote-dds-ci-identity.mjs')).createPreDeploymentIdentity({
      identity, noCollisionVerifiedAt: '2026-10-01T00:00:00.000Z',
    });
    const predeploymentPath = join(dir, 'predeployment.json'); writeFileSync(predeploymentPath, JSON.stringify(predeployment));
    const result = spawnSync(process.execPath, [DEPLOYMENT_CLI, ...deploymentArgs('--deploy-from-identity', predeploymentPath, join(dir, 'deployment.json'))],
      { encoding: 'utf8', env: deploymentEnvironment({ DDS_REMOTE_TEST_KEY: undefined }) });
    assertDeploymentCliFailure(result, 'REQUIRED_CONFIG_MISSING', [...SECRET_MARKERS, identity.workerName]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deployment CLI classifies malformed and trusted-mismatched parsed identities without leaking identity material', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-dds-deployment-identity-'));
  try {
    const identityModule = await import('../scripts/remote-dds-ci-identity.mjs');
    const malformedPath = join(dir, 'malformed.json');
    writeFileSync(malformedPath, JSON.stringify({ workerName: SECRET_MARKERS[2], endpoint: SECRET_MARKERS[3], body: SECRET_MARKERS[4], stack: SECRET_MARKERS[5] }));
    const mismatched = identityModule.deriveCiIdentity({ ...CONTEXT, secret: 'different-token-marker-must-not-leak' });
    const mismatchPath = join(dir, 'mismatch.json'); writeFileSync(mismatchPath, JSON.stringify(mismatched));
    for (const input of [malformedPath, mismatchPath]) {
      const result = spawnSync(process.execPath, [DEPLOYMENT_CLI, ...deploymentArgs('--preflight', input, join(dir, 'out.json'))],
        { encoding: 'utf8', env: deploymentEnvironment() });
      assertDeploymentCliFailure(result, 'IDENTITY_INVALID', [...SECRET_MARKERS, mismatched.workerName, 'different-token-marker-must-not-leak']);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deployment process wrapper renders an unbranded internal failure as UNKNOWN', async () => {
  const mod = await deployment(); let stderr = '', exitCode;
  const internal = new Error(SECRET_MARKERS.join(' ')); internal.stack += `\n${SECRET_MARKERS[5]}`;
  const result = await mod.runDeploymentProcess([], {}, { runDeploymentCli: async () => { throw internal; } }, {
    error: (value) => { stderr += value; }, setExitCode: (value) => { exitCode = value; },
  });
  assert.equal(result, undefined); assert.equal(exitCode, 1);
  assert.equal(stderr, 'Remote DDS deployment failed [UNKNOWN].\n');
  for (const marker of SECRET_MARKERS) assert.equal(stderr.includes(marker), false);
});

test('deployment process wrapper preserves every branded Cloudflare diagnostic', async () => {
  const mod = await deployment(); const { diagnostic } = await import('../scripts/remote-dds-public-errors.mjs');
  for (const code of [
    'API_AUTH_OR_PERMISSION',
    'TEMPORARY_WORKER_COLLISION',
    'API_RESPONSE_INVALID',
    'API_EXACT_SCRIPT_RESPONSE_INVALID',
    'API_WORKERS_LIST_RESPONSE_INVALID',
    'API_SCRIPTS_SEARCH_RESPONSE_INVALID',
    'API_REQUEST_FAILED',
  ]) {
    let stderr = '', exitCode;
    await mod.runDeploymentProcess([], {}, { runDeploymentCli: async () => { throw diagnostic(code, new Error(SECRET_MARKERS.join(' '))); } }, {
      error: (value) => { stderr += value; }, setExitCode: (value) => { exitCode = value; },
    });
    assert.equal(exitCode, 1); assert.equal(stderr, `Remote DDS deployment failed [${code}].\n`);
    for (const marker of SECRET_MARKERS) assert.equal(stderr.includes(marker), false);
  }
});

test('deployment process wrapper classifies an injected report checkpoint write failure as LOCAL_IO_FAILED', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-dds-deployment-report-'));
  try {
    const identity = (await import('../scripts/remote-dds-ci-identity.mjs')).deriveCiIdentity({ ...CONTEXT, secret: SECRET_MARKERS[1] });
    const input = join(dir, 'identity.json'); writeFileSync(input, JSON.stringify(identity));
    let stderr = '', exitCode;
    await (await deployment()).runDeploymentProcess(deploymentArgs('--preflight', input, join(dir, 'out.json')), deploymentEnvironment(), {
      fetchImpl: async (url) => new URL(url).pathname.includes('/workers/scripts/') ? notFound() : response(page([])),
      writeReportCheckpoint: () => { throw new Error(SECRET_MARKERS.join(' ')); },
    }, { error: (value) => { stderr += value; }, setExitCode: (value) => { exitCode = value; } });
    assert.equal(exitCode, 1); assert.equal(stderr, 'Remote DDS deployment failed [LOCAL_IO_FAILED].\n');
    for (const marker of [...SECRET_MARKERS, identity.workerName]) assert.equal(stderr.includes(marker), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preflight and deploy CLI forms atomically persist secret-free records with trusted context', async () => {
  const f = await deploymentFixture(); const outputRoot = mkdtempSync(join(process.cwd(), '.remote-dds-deployment-output-'));
  try {
    const input = join(f.root, 'identity.json'), pre = join(outputRoot, 'pre-deployment.json'), out = join(outputRoot, 'deployment.json');
    writeFileSync(input, JSON.stringify(f.identity));
    const context = ['--repository', CONTEXT.repository, '--workflow', CONTEXT.workflow, '--run-id', CONTEXT.runId, '--run-attempt', CONTEXT.runAttempt, '--commit-sha', CONTEXT.commitSha];
    const env = { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: TOKEN, DDS_REMOTE_TEST_KEY: KEY };
    const dependencies = { root: f.root, fetchImpl: f.fetchImpl, execFile: f.execFile, wrangler: f.options.wrangler };
    const identity = await f.mod.runDeploymentCli(['--preflight', '--identity', input, ...context, '--out', pre], env, dependencies);
    assert.deepEqual(JSON.parse(require('node:fs').readFileSync(pre, 'utf8')), identity);
    assert.equal(f.events.filter((e) => e.command).length, 0);
    const manifest = await f.mod.runDeploymentCli(['--deploy-from-identity', pre, ...context, '--out', out], env, dependencies);
    assert.deepEqual(JSON.parse(require('node:fs').readFileSync(out, 'utf8')), manifest);
    f.mod.assertDeploymentManifest(manifest, { root: f.root });
    assert.equal(require('node:fs').readFileSync(out, 'utf8').includes(KEY), false);
    assert.equal(require('node:fs').readFileSync(out, 'utf8').includes(TOKEN), false);
    assert.equal(require('node:fs').readdirSync(outputRoot).some((name) => name.endsWith('.tmp')), false);
  } finally { rmSync(outputRoot, { recursive: true, force: true }); rmSync(f.root, { recursive: true, force: true }); }
});

test('partial cleanup refuses a replacement immutable object after a code-10007 retry', async () => {
  const f = await deploymentFixture(); let currentReads = 0, deletes = 0;
  try {
    await assertDiagnostic(() => f.mod.deployAndVerifyWorkers({ ...f.options,
      execFile: () => { f.setDeployed(true); throw new Error('Worker does not exist [code: 10007]'); },
      fetchImpl: async (url, options = {}) => {
        const path = new URL(url).pathname;
        if (options.method === 'DELETE') deletes++;
        if (path.endsWith('/workers/workers')) {
          currentReads++;
          if (currentReads >= 3) return response(page([{ id: 'c'.repeat(32), name: f.identity.workerName }]));
        }
        if (path.endsWith('/versions')) return response(versionPage([]));
        return f.fetchImpl(url, options);
      },
    }), 'DEPLOYED_OWNERSHIP_UNVERIFIED');
    assert.equal(deletes, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('the existing teardown adapter requires attestation and delegates to exact disable-probe-revalidate cleanup', async () => {
  const f = await deploymentFixture(); f.setDeployed(true);
  try {
    const result = await f.mod.teardownTemporaryWorkers({ ...f.options, temporaryWorkerName: f.identity.workerName,
      workersDevUrl: 'https://' + f.identity.workerName + '.example.workers.dev', fetchImpl: async (url, options) => {
        if (new URL(url).hostname.endsWith('.workers.dev')) return response({}, 404);
        return f.fetchImpl(url, options);
      },
    });
    assert.equal(result.status, 'deleted'); assert.equal(result.currentAbsent, true); assert.equal(result.legacyAbsent, true); assert.equal(f.isDeleted(), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('legacy name-only teardown input fails before any external request', async () => {
  const m = await deployment(); let calls = 0;
  await assert.rejects(() => m.teardownTemporaryWorkers({ accountId: 'acct', apiToken: TOKEN, remoteTestKey: KEY,
    temporaryWorkerName: 'ss-dds-soak-00000000-0000-4000-8000-000000000001', workersDevUrl: 'https://other.example.workers.dev',
    fetchImpl: async () => { calls++; }, execFile: () => { calls++; } }), /identity|context|predeployment|attestation/i);
  assert.equal(calls, 0);
});

test('teardown wrapper accepts a full deployment record and rejects supplemental identity mismatches', async () => {
  const f = await deploymentFixture();
  try {
    const verified = await f.mod.deployAndVerifyWorkers(f.options);
    const deploymentRecord = f.mod.createDeploymentManifest({ root: f.root, verifiedDeployment: verified });
    for (const mismatch of [{ temporaryWorkerName: 'ss-dds-soak-gh-1-1-aaaaaaaaaaaa' }, { workersDevUrl: `https://${f.identity.workerName}.other.workers.dev` }]) {
      const prior = f.events.filter((e) => e.method === 'DELETE' || e.command).length;
      await assert.rejects(() => f.mod.teardownTemporaryWorkers({ ...f.options, deploymentRecord, ...mismatch }));
      assert.equal(f.events.filter((e) => e.method === 'DELETE' || e.command).length, prior);
    }
    const result = await f.mod.teardownTemporaryWorkers({ ...f.options, deploymentRecord });
    assert.equal(result.status, 'deleted');
    assert.equal(f.events.filter((e) => e.args?.[0] === 'deploy').length, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('retry refuses Worker replacement during the sleep window with no second deploy, secret, or cleanup', async () => {
  const f = await deploymentFixture(); let sleepingComplete = false, attempts = 0, secrets = 0, deletes = 0;
  try {
    await assert.rejects(() => f.mod.deployAndVerifyWorkers({ ...f.options,
      sleepImpl: async () => { sleepingComplete = true; },
      execFile: (command, args) => {
        if (args[0] === 'deploy') { attempts++; f.setDeployed(true); if (attempts === 1) throw new Error('Worker does not exist [code: 10007]'); return ''; }
        if (args[1] === 'secret') { secrets++; return ''; }
        return '4.33.0';
      },
      fetchImpl: async (url, options = {}) => {
        if (options.method === 'DELETE') deletes++;
        if (sleepingComplete && new URL(url).pathname.endsWith('/workers/workers')) return response(page([{ id: 'c'.repeat(32), name: f.identity.workerName }]));
        return f.fetchImpl(url, options);
      },
    }), /refus|immutable|ownership/i);
    assert.equal(attempts, 1); assert.equal(secrets, 0); assert.equal(deletes, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('retry refuses ownership-state drift during sleep even if immutable Worker ID and tag remain unchanged', async () => {
  const f = await deploymentFixture(); let afterSleep = false, attempts = 0, secrets = 0, deletes = 0;
  try {
    await assert.rejects(() => f.mod.deployAndVerifyWorkers({ ...f.options,
      sleepImpl: async () => { afterSleep = true; },
      execFile: (command, args) => {
        if (args[0] === 'deploy') { attempts++; f.setDeployed(true); throw new Error('Worker does not exist [code: 10007]'); }
        if (args[1] === 'secret') secrets++;
        return '';
      },
      fetchImpl: async (url, options = {}) => {
        if (options.method === 'DELETE') deletes++;
        if (afterSleep && new URL(url).pathname.endsWith('/versions/deployed-v1')) {
          const detail = versionDetail(f.identity); detail.result.resources.script.etag = 'replacement-script-etag'; return response(detail);
        }
        return f.fetchImpl(url, options);
      },
    }), /refus|changed|snapshot|ownership/i);
    assert.equal(attempts, 1); assert.equal(secrets, 0); assert.equal(deletes, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const tag of [null, 'b'.repeat(43)]) test('successful Wrangler deploy with unowned version refuses secret mutation and cleanup: ' + (tag === null ? 'missing tag' : 'foreign tag'), async () => {
  const f = await deploymentFixture(); let secrets = 0, deletes = 0;
  try {
    await assert.rejects(() => f.mod.deployAndVerifyWorkers({ ...f.options,
      execFile: (command, args, options) => { if (args[1] === 'secret') secrets++; return f.execFile(command, args, options); },
      fetchImpl: async (url, options = {}) => {
        if (options.method === 'DELETE') deletes++;
        if (new URL(url).pathname.endsWith('/versions/deployed-v1')) return response(versionDetail(f.identity, tag));
        return f.fetchImpl(url, options);
      },
    }), /ownership|tag|refus/i);
    assert.equal(secrets, 0); assert.equal(deletes, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const target of ['objects', 'legacy', 'versions']) test('official ' + target + ' page reader accepts an empty cursor-only envelope', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity();
  const options = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async () => response({ success: true, result: target === 'versions' ? { items: [] } : [], result_info: { cursor: null } }),
  };
  const method = target === 'objects' ? api.findExactWorker : target === 'legacy' ? api.listLegacyExactScript : api.readWorkerVersions;
  if (target !== 'versions') assert.equal(await method(options), null);
  else assert.deepEqual(await method(options), { status: 'PRESENT', versions: [] });
});

test('secret upload is bracketed by complete exact object, legacy, and immutable version ownership reads', async () => {
  const f = await deploymentFixture(); let uploaded = false, boundary;
  try {
    await f.mod.deployAndVerifyWorkers({ ...f.options, execFile: (command, args, options) => {
      if (args[1] === 'secret') {
        const deployedAt = f.events.findLastIndex((e) => e.args?.[0] === 'deploy');
        const before = f.events.slice(deployedAt + 1);
        for (const suffix of ['/workers/workers', '/workers/scripts-search', '/workers/scripts/' + f.identity.workerName, '/versions/deployed-v1']) {
          assert.ok(before.some((e) => e.url && new URL(e.url).pathname.endsWith(suffix)), 'ownership read missing before secret: ' + suffix);
        }
        boundary = f.events.length; uploaded = true;
      }
      return f.execFile(command, args, options);
    } });
    assert.equal(uploaded, true);
    const after = f.events.slice(boundary);
    for (const suffix of ['/workers/workers', '/workers/scripts-search', '/workers/scripts/' + f.identity.workerName, '/versions/deployed-v1']) {
      assert.ok(after.some((e) => e.url && new URL(e.url).pathname.endsWith(suffix)), 'ownership read missing after secret: ' + suffix);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a replaced immutable Worker after secret upload is refused without cleanup', async () => {
  const f = await deploymentFixture(); let uploaded = false, deletes = 0;
  try {
    await assert.rejects(() => f.mod.deployAndVerifyWorkers({ ...f.options,
      execFile: (command, args, options) => { if (args[1] === 'secret') uploaded = true; return f.execFile(command, args, options); },
      fetchImpl: async (url, options = {}) => {
        if (options.method === 'DELETE') deletes++;
        if (uploaded && new URL(url).pathname.endsWith('/workers/workers')) return response(page([{ id: 'c'.repeat(32), name: f.identity.workerName }]));
        return f.fetchImpl(url, options);
      },
    }), /immutable|refus|ownership/i);
    assert.equal(uploaded, true); assert.equal(deletes, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const tag of [null, 'b'.repeat(43)]) test('post-secret ownership refusal cannot authorize cleanup through a later owned response: ' + (tag === null ? 'missing tag' : 'foreign tag'), async () => {
  const f = await deploymentFixture(); let uploaded = false, rejectedOnce = false, deletes = 0;
  try {
    await assert.rejects(() => f.mod.deployAndVerifyWorkers({ ...f.options,
      execFile: (command, args, options) => { if (args[1] === 'secret') uploaded = true; return f.execFile(command, args, options); },
      fetchImpl: async (url, options = {}) => {
        if (options.method === 'DELETE') deletes++;
        if (uploaded && !rejectedOnce && new URL(url).pathname.endsWith('/versions/deployed-v1')) {
          rejectedOnce = true; return response(versionDetail(f.identity, tag));
        }
        return f.fetchImpl(url, options);
      },
    }), /ownership|tag|refus/i);
    assert.equal(uploaded, true); assert.equal(rejectedOnce, true); assert.equal(deletes, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a secret-created immutable version is reverified and supplies the final id, ETag, and configuration fingerprint', async () => {
  const f = await deploymentFixture(); let uploaded = false;
  const finalDetail = versionDetail(f.identity); finalDetail.result.id = 'deployed-v2'; finalDetail.result.resources.script.etag = 'script-etag-2';
  finalDetail.result.resources.bindings.push({ type: 'secret_text', name: 'DDS_REMOTE_TEST_KEY' });
  try {
    const verified = await f.mod.deployAndVerifyWorkers({ ...f.options,
      execFile: (command, args, options) => { if (args[1] === 'secret') uploaded = true; return f.execFile(command, args, options); },
      fetchImpl: async (url, options = {}) => {
        const path = new URL(url).pathname;
        if (uploaded && path.endsWith('/versions')) return response(versionPage([{ id: 'deployed-v2' }, { id: 'deployed-v1' }]));
        if (uploaded && path.endsWith('/versions/deployed-v2')) return response(finalDetail);
        if (new URL(url).hostname.endsWith('.workers.dev')) {
          const payload = await (await f.fetchImpl(url, options)).json(); payload.operationResult.workerVersionId = 'deployed-v2'; return response(payload);
        }
        return f.fetchImpl(url, options);
      },
    });
    assert.equal(verified.versionId, 'deployed-v2'); assert.equal(verified.scriptETag, 'script-etag-2');
    const { canonicalJson } = await import('../scripts/remote-dds-soak-state.mjs');
    assert.equal(verified.versionConfigurationSha256, require('node:crypto').createHash('sha256').update(canonicalJson({ bindings: finalDetail.result.resources.bindings, script_runtime: finalDetail.result.resources.script_runtime })).digest('hex'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const boundary of ['after secret', 'final detail', 'partial cleanup']) {
  for (const drift of ['ownership tag', 'script ETag', 'version config']) test('observed immutable metadata refuses ' + drift + ' drift at ' + boundary, async () => {
    const f = await deploymentFixture(); let detailReads = 0, attempts = 0, secrets = 0, deletes = 0, driftSeen = false, laterMutations = 0;
    try {
      await assertDiagnostic(() => f.mod.deployAndVerifyWorkers({ ...f.options,
        execFile: (command, args, options) => {
          if (driftSeen && (args[0] === 'deploy' || args[1] === 'secret')) laterMutations++;
          if (args[0] === 'deploy') {
            attempts++;
            if (boundary === 'partial cleanup') {
              f.execFile(command, args, options);
              throw new Error(attempts === 1 ? 'Worker does not exist [code: 10007]' : 'Second deployment failed');
            }
          }
          if (args[1] === 'secret') secrets++;
          return f.execFile(command, args, options);
        },
        fetchImpl: async (url, options = {}) => {
          if (options.method === 'DELETE') { deletes++; if (driftSeen) laterMutations++; }
          if (new URL(url).pathname.endsWith('/versions/deployed-v1')) {
            detailReads++;
            if ((boundary === 'after secret' && detailReads >= 2) || (boundary !== 'after secret' && detailReads === 3)) {
              driftSeen = true;
              const detail = versionDetail(f.identity, drift === 'ownership tag' ? 'b'.repeat(43) : f.identity.ownershipTag);
              if (drift === 'script ETag') detail.result.resources.script.etag = 'changed-etag';
              if (drift === 'version config') detail.result.resources.script_runtime.compatibility_date = '2026-09-30';
              return response(detail);
            }
          }
          return f.fetchImpl(url, options);
        },
      }), boundary === 'partial cleanup' ? 'WRANGLER_DEPLOY_FAILED'
        : boundary === 'after secret' ? 'POST_SECRET_OWNERSHIP_UNVERIFIED' : 'IMMUTABLE_VERSION_UNVERIFIED');
      assert.equal(driftSeen, true);
      assert.equal(detailReads, boundary === 'after secret' ? 2 : 3);
      assert.equal(attempts, boundary === 'partial cleanup' ? 2 : 1);
      assert.equal(secrets, boundary === 'partial cleanup' ? 0 : 1);
      assert.equal(laterMutations, 0);
      assert.equal(deletes, 0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

for (const drift of ['missing tag', 'foreign tag', 'script ETag', 'version config']) test('final exact-version detail refuses ' + drift + ' drift without cleanup', async () => {
  const f = await deploymentFixture(); let detailReads = 0, deletes = 0;
  try {
    await assertDiagnostic(() => f.mod.deployAndVerifyWorkers({ ...f.options, fetchImpl: async (url, options = {}) => {
      if (options.method === 'DELETE') deletes++;
      if (new URL(url).pathname.endsWith('/versions/deployed-v1')) {
        detailReads++;
        if (detailReads === 3) {
          const detail = versionDetail(f.identity, drift === 'missing tag' ? null : drift === 'foreign tag' ? 'b'.repeat(43) : f.identity.ownershipTag);
          if (drift === 'script ETag') detail.result.resources.script.etag = 'changed-etag';
          if (drift === 'version config') detail.result.resources.script_runtime.compatibility_date = '2026-09-30';
          return response(detail);
        }
      }
      return f.fetchImpl(url, options);
    } }), 'IMMUTABLE_VERSION_UNVERIFIED');
    assert.equal(deletes, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('remote runner permits only a workers.dev HTTPS endpoint and checks endpoint build ID', async () => {
  const mod = await runner();
  assert.equal(mod.assertRemoteEndpoint('https://bridge-dds.example.workers.dev/'), 'https://bridge-dds.example.workers.dev');
  for (const url of ['http://bridge-dds.example.workers.dev', 'https://example.com', 'https://bridge-dds.workers.dev/path']) {
    assert.throws(() => mod.assertRemoteEndpoint(url), /HTTPS.*workers\.dev|root/i);
  }
  assert.throws(() => mod.assertEndpointBuild({ ok: true, buildId: 'other' }, 'wanted'), /build ID/i);
});

test('runner plans exactly 22,000 seeded cases across eleven shards and requires resume for a nonempty directory', async () => {
  const mod = await runner();
  const operations = mod.createSeededOperations();
  assert.equal(operations.length, 22000);
  assert.deepEqual(operations.map((op) => op.shard).filter((value, index, all) => index === all.indexOf(value)), Array.from({ length: 11 }, (_, i) => i));
  const depthCounts = operations.filter((op) => op.kind === 'solve').reduce((counts, op) => { counts[op.depth] = (counts[op.depth] || 0) + 1; return counts; }, {});
  assert.equal(Object.keys(depthCounts).length, 13);
  assert.equal(Object.values(depthCounts).reduce((sum, count) => sum + count, 0), 21780);
  assert.ok(Object.values(depthCounts).every((count) => count >= 1675));
  const root = mkdtempSync(join(tmpdir(), 'remote-dds-run-'));
  try {
    writeFileSync(join(root, 'present'), 'x');
    assert.throws(() => mod.assertRunDirectory(root, false), /--resume/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runner options require a URL and key without exposing the key or accepting an operation-count override', async () => {
  const mod = await runner();
  assert.throws(() => mod.parseOptions(['--url', 'https://a.workers.dev'], {}), /DDS_REMOTE_TEST_KEY/i);
  assert.throws(() => mod.parseOptions(['--url', 'https://a.workers.dev', '--count', '1'], { DDS_REMOTE_TEST_KEY: 'secret-value' }), /count/i);
  const options = mod.parseOptions(['--url', 'https://a.workers.dev', '--run-dir', 'x'], { DDS_REMOTE_TEST_KEY: 'secret-value' });
  assert.equal(options.endpoint, 'https://a.workers.dev');
  assert.equal(JSON.stringify(options).includes('secret-value'), false);
});

test('runner accepts bounded segment limits and validates their values', async () => {
  const mod = await runner();
  const env = { DDS_REMOTE_TEST_KEY: 'secret-value' };
  const base = ['--url', 'https://a.workers.dev'];
  const bounded = mod.parseOptions([...base, '--max-new-operations', '6000', '--deadline-ms', '17100000'], env);
  assert.equal(bounded.maxNewOperations, 6000);
  assert.equal(bounded.deadlineMs, 17_100_000);

  const unbounded = mod.parseOptions(base, env);
  assert.equal(unbounded.maxNewOperations, 22000);
  assert.equal(unbounded.deadlineMs, null);

  for (const option of ['--max-new-operations', '--deadline-ms']) {
    for (const value of ['0', '-1', '1.5', '9007199254740992']) {
      assert.throws(() => mod.parseOptions([...base, option, value], env), /positive safe integer/i, `${option} ${value}`);
    }
    assert.throws(() => mod.parseOptions([...base, option], env), /requires.*value|positive safe integer/i, `${option} missing value`);
    assert.throws(() => mod.parseOptions([...base, option, '10', option, '20'], env), /duplicate|must not be repeated/i, `${option} duplicate`);
  }
  assert.throws(() => mod.parseOptions([...base, '--max-new-operations', '22001'], env), /22000/i);
});

test('remote runner retries one ambiguous transport failure with the identical idempotency identity', async () => {
  const mod = await runner();
  const calls = [];
  const args = {
    key: 'test-key', runId: 'run-1', operationId: 'op.000001', route: '/__dds/ordered-probe',
    body: '{"deal":"fixture"}', shard: 0,
  };
  const payload = {
    operationResult: { ok: true }, accounting: { workerInbound: 1 }, accountingActivationId: 'activation-1', replayed: false,
  };
  const retryBudget = { remaining: 1, used: 0 };
  const result = await mod.remotePost('https://bridge-dds.example.workers.dev', args, {
    retryBudget,
    sleepImpl: async () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNRESET' };
        throw error;
      }
      return { ok: true, status: 200, json: async () => payload };
    },
  });
  assert.equal(result, payload);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(retryBudget, { remaining: 0, used: 1 });
});

test('remote runner reports a safe transport code and attempt count when its one retry also fails', async () => {
  const mod = await runner();
  let attempts = 0;
  const args = {
    key: 'must-not-appear', runId: 'run-1', operationId: 'op.000001', route: '/__dds/ordered-probe',
    body: '{"deal":"fixture"}', shard: 0,
  };
  await assert.rejects(() => mod.remotePost('https://bridge-dds.example.workers.dev', args, {
    retryBudget: { remaining: 1, used: 0 },
    sleepImpl: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ECONNRESET' };
      throw error;
    },
  }), (error) => {
    assert.match(error.message, /ECONNRESET/);
    assert.match(error.message, /2 attempts/);
    assert.equal(error.message.includes(args.key), false);
    return true;
  });
  assert.equal(attempts, 2);
});

test('runner fails closed when observed accounting differs from its durable physical-request ledger', async () => {
  const mod = await runner();
  const accounting = { workerInbound: 1, doFetchArrivals: 1, queuedDoCommands: 0, sqliteRows: { reads: 1, writes: 1 } };
  const ledger = [{ route: '/__dds/metrics', replayed: false }];
  assert.deepEqual(mod.reconcileObservedLedger(accounting, ledger), accounting);
  assert.throws(() => mod.reconcileObservedLedger({ ...accounting, workerInbound: 2 }, ledger), /reconcile/i);
});

test('runner persists the endpoint build and verified Worker version from its preflight response', async () => {
  const mod = await runner();
  const evidence = mod.buildPreflightEvidence({ accounting: { workerInbound: 1 }, accountingActivationId: 'accounting-activation', replayed: false,
    operationResult: { buildId: 'build-bound', workerVersionId: 'version-bound', activationId: 'activation' } });
  assert.deepEqual(evidence, { accounting: { workerInbound: 1 }, accountingActivationId: 'accounting-activation', remote: { buildId: 'build-bound', workerVersionId: 'version-bound', activationId: 'activation' }, activationId: 'activation', replayed: false,
    endpointBuildId: 'build-bound', endpointWorkerVersionId: 'version-bound' });
});

test('completion projection requires one durable preflight, every fixture, and every seeded operation before accepting its physical ledger', async () => {
  const mod = await runner();
  const operations = [
    { route: '/__dds/table', shard: 0 },
    { route: '/__dds/ordered-probe', shard: 0 },
  ];
  const fixtures = [{ kind: 'table' }, { kind: 'solve' }];
  const physical = [
    { operationId: 'preflight.metrics', route: '/__dds/metrics', replayed: false },
    { operationId: 'fixture.000000', route: '/__dds/table', replayed: false },
    { operationId: 'fixture.000001', route: '/__dds/ordered-probe', replayed: false },
    { operationId: 'op.000000', route: '/__dds/table', replayed: false },
    { operationId: 'op.000001', route: '/__dds/ordered-probe', replayed: false },
  ];
  const projection = mod.projectCompletionLedger({ operations, fixtures, physicalOperations: physical });
  assert.deepEqual(projection, { workerInbound: 5, doFetchArrivals: 5, queuedDoCommands: 6, sqliteRows: { reads: 5, writes: 5 } });
  assert.throws(() => mod.projectCompletionLedger({ operations, fixtures, physicalOperations: physical.filter((item) => item.operationId !== 'preflight.metrics') }), /preflight/i);
  assert.throws(() => mod.projectCompletionLedger({ operations, fixtures, physicalOperations: [...physical, { operationId: 'preflight.metrics', route: '/__dds/metrics', replayed: false }] }), /more than two|preflight/i);
  const replayOnly = physical.map((item) => item.operationId === 'op.000000' ? { ...item, replayed: true } : item);
  assert.throws(() => mod.projectCompletionLedger({ operations, fixtures, physicalOperations: replayOnly }), /invalid replay count/i);
  const recovered = [...physical, { operationId: 'op.000000', route: '/__dds/table', replayed: true }];
  assert.doesNotThrow(() => mod.projectCompletionLedger({ operations, fixtures, physicalOperations: recovered }));
  const tamperedReplayOrder = [...recovered];
  const replay = tamperedReplayOrder.pop(); tamperedReplayOrder.splice(3, 0, replay);
  assert.throws(() => mod.projectCompletionLedger({ operations, fixtures, physicalOperations: tamperedReplayOrder }), /invalid replay count/i);
});
