const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

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

const CONTEXT = { repository: 'bridge/stepstone', workflow: 'Remote DDS Soak', runId: '12345', runAttempt: '2', commitSha: 'a'.repeat(40) };
const TOKEN = 'fake-source-token';
const KEY = 'a'.repeat(43);
const WORKER_ID = 'b'.repeat(32);
const page = (items, number = 1, total = 1) => ({ success: true, result: items, result_info: { page: number, per_page: 100, total_pages: total } });
const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
async function ciIdentity() { return (await import('../scripts/remote-dds-ci-identity.mjs')).deriveCiIdentity({ ...CONTEXT, secret: TOKEN }); }
function versionDetail(identity, tag = identity.ownershipTag) {
  return { success: true, result: { id: 'deployed-v1', annotations: tag === null ? {} : { 'workers/tag': tag }, resources: { script: { etag: 'script-etag-1' }, bindings: [{ type: 'plain_text', name: 'DDS_REMOTE_TEST', text: 'true' }], script_runtime: { compatibility_date: '2026-09-22' } } } };
}
async function deploymentFixture(overrides = {}) {
  const mod = await deployment(); const identity = await ciIdentity(); const root = repo();
  const events = []; let deployed = false, deleted = false, buildId;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url); events.push({ url, method: options.method ?? 'GET' });
    if (parsed.hostname.endsWith('.workers.dev')) return response({ operationResult: { buildId, workerVersionId: 'deployed-v1' } });
    if (options.method === 'DELETE') { deleted = true; return response({ success: true }); }
    if (parsed.pathname.endsWith(`/workers/scripts/${identity.workerName}`)) return response({}, deployed && !deleted ? 200 : 404);
    if (parsed.pathname.endsWith('/workers/workers')) return response(page(deployed && !deleted ? [{ id: WORKER_ID, name: identity.workerName }] : []));
    if (parsed.pathname.endsWith('/workers/scripts-search')) return response(page(deployed && !deleted ? [{ script_name: identity.workerName }] : []));
    if (parsed.pathname.endsWith('/versions')) return response({ ...page([]), result: { items: deployed && !deleted ? [{ id: 'deployed-v1' }] : [] } });
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
  const options = { root, accountId: 'acct', apiToken: TOKEN, remoteTestKey: KEY, context: CONTEXT, identity, fetchImpl, execFile, sleepImpl: async () => {}, ...overrides };
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

test('an exact-name collision rejects immediately with zero deployment or deletion', async () => {
  const mod = await deployment(); const identity = await ciIdentity(); let reads = 0, mutations = 0;
  await assert.rejects(() => mod.preflightTemporaryWorkerIdentity({ accountId: 'acct', apiToken: TOKEN, identity, context: CONTEXT,
    fetchImpl: async (url, options = {}) => { reads++; if (options.method && options.method !== 'GET') mutations++; assert.ok(url.endsWith('/workers/scripts/' + identity.workerName)); return response({}); },
    execFile: () => { mutations++; },
  }), /collision|already exists/i);
  assert.equal(reads, 1); assert.equal(mutations, 0);
});

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
          assert.equal(args[args.indexOf('--tag') + 1], f.identity.ownershipTag);
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
  await assert.rejects(() => mod.verifyWorkersDeployment({ ...args, fetchImpl: async () => response({ ...versionDetail(identity), result: { ...versionDetail(identity).result, id: 'other' } }) }), /version ID|immutable/i);
});

for (const [label, tag, versions, deletes] of [
  ['no deployed versions', null, false, true],
  ['matching immutable ownership', 'matching', true, true],
  ['missing ownership', null, true, false],
  ['foreign ownership', 'b'.repeat(43), true, false],
]) test('failed deployment partial cleanup: ' + label, async () => {
  const f = await deploymentFixture(); let attempts = 0, deleted = false;
  try {
    await assert.rejects(() => f.mod.deployAndVerifyWorkers({ ...f.options,
      execFile: (command, args) => {
        assert.equal(args[0], 'deploy'); attempts++; f.setDeployed(true);
        throw new Error('Worker does not exist [code: 10007]');
      },
      fetchImpl: async (url, options = {}) => {
        if (options.method === 'DELETE') { deleted = true; assert.ok(url.endsWith('/workers/workers/' + WORKER_ID)); return f.fetchImpl(url, options); }
        if (!versions && new URL(url).pathname.endsWith('/workers/scripts/' + f.identity.workerName)) return response({}, 404);
        if (!versions && new URL(url).pathname.endsWith('/workers/scripts-search')) return response(page([]));
        if (new URL(url).pathname.endsWith('/versions')) return response({ ...page([]), result: { items: versions ? [{ id: 'deployed-v1' }] : [] } });
        if (url.endsWith('/versions/deployed-v1')) return response(versionDetail(f.identity, tag === 'matching' ? f.identity.ownershipTag : tag));
        return f.fetchImpl(url, options);
      },
    }), deletes ? /10007/ : /ownership|tag|refus/i);
    assert.equal(attempts, deletes ? 2 : 1); assert.equal(deleted, deletes);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('deployment refuses mismatched remote build/version evidence before generating a manifest', async () => {
  for (const field of ['buildId', 'workerVersionId']) {
    const f = await deploymentFixture();
    try {
      await assert.rejects(() => f.mod.deployAndVerifyWorkers({ ...f.options, fetchImpl: async (url, options) => {
        if (new URL(url).hostname.endsWith('.workers.dev')) {
          const payload = await (await f.fetchImpl(url, options)).json(); payload.operationResult[field] = 'wrong-' + field;
          return response(payload);
        }
        return f.fetchImpl(url, options);
      } }), /remote.*evidence|build|version/i);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('shared API finds later-page exact objects and legacy scripts without treating dual API representations as duplicates', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity();
  const reads = [];
  const options = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName, fetchImpl: async (url) => {
    const parsed = new URL(url), number = Number(parsed.searchParams.get('page') ?? '1'); reads.push(url);
    assert.equal(parsed.searchParams.get('per_page'), '100');
    if (parsed.pathname.endsWith('/workers/workers')) return response(page(number === 1 ? [{ id: 'c'.repeat(32), name: 'other' }] : [{ id: WORKER_ID, name: identity.workerName }], number, 2));
    if (parsed.pathname.endsWith('/workers/scripts-search')) {
      assert.equal(parsed.searchParams.get('name'), identity.workerName);
      return response(page(number === 1 ? [{ script_name: 'near-' + identity.workerName }] : [{ script_name: identity.workerName }], number, 2));
    }
    throw new Error('unexpected');
  } };
  assert.deepEqual(await api.findExactWorker(options), { id: WORKER_ID, name: identity.workerName });
  assert.equal((await api.listLegacyExactScript(options)).name, identity.workerName);
  assert.equal(reads.length, 4);
});

for (const target of ['objects', 'legacy', 'versions']) {
  for (const bad of ['missing metadata', 'malformed cursor', 'repeated cursor', 'cyclic cursor', 'inconsistent pages', 'non-advancing page', 'duplicate exact']) {
    test(target + ' pagination fails closed on ' + bad, async () => {
      const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); let reads = 0;
      const item = target === 'objects' ? { id: WORKER_ID, name: identity.workerName } : target === 'legacy' ? { script_name: identity.workerName } : { id: 'deployed-v1' };
      const fetchImpl = async (url) => {
        if (url.endsWith('/versions/deployed-v1')) return response(versionDetail(identity));
        reads++;
        const items = bad === 'duplicate exact' ? [item] : [];
        let metadata;
        if (bad === 'malformed cursor') metadata = { cursor: 123 };
        else if (bad === 'repeated cursor') metadata = { cursor: 'same' };
        else if (bad === 'cyclic cursor') metadata = { cursor: reads % 2 ? 'a' : 'b' };
        else if (bad === 'inconsistent pages') metadata = { page: reads, per_page: 100, total_pages: reads === 1 ? 2 : 3 };
        else if (bad === 'non-advancing page') metadata = { page: 1, per_page: 100, total_pages: 2 };
        else if (bad === 'duplicate exact') metadata = { page: reads, per_page: 100, total_pages: 2 };
        const payload = { success: true, result: target === 'versions' ? { items } : items };
        if (metadata) payload.result_info = metadata;
        return response(payload);
      };
      const options = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName, fetchImpl };
      const method = target === 'objects' ? api.findExactWorker : target === 'legacy' ? api.listLegacyExactScript : api.readWorkerVersions;
      await assert.rejects(() => method(options), /pagination|cursor|duplicate|page/i);
      assert.ok(reads <= 3);
    });
  }
}

test('shared API normalizes every immutable version with script ETag and canonical config fingerprint without credentials', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity();
  const { canonicalJson } = await import('../scripts/remote-dds-soak-state.mjs'); const crypto = require('node:crypto');
  const detail = versionDetail(identity);
  const result = await api.readWorkerVersions({ accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName, fetchImpl: async (url) => {
    if (url.endsWith('/versions/deployed-v1')) return response(detail);
    return response({ ...page([]), result: { items: [{ id: 'deployed-v1' }] } });
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
  for (const payload of [response({}, 404), response({ success: false, errors: [{ code: 10007, message: 'Worker not found' }] }, 400)]) {
    assert.deepEqual(await api.readWorkerVersions({ ...options, fetchImpl: async () => payload }), { status: 'ABSENT_ENDPOINT', versions: [] });
  }
  for (const status of [401, 403, 500]) await assert.rejects(() => api.readWorkerVersions({ ...options, fetchImpl: async () => response({ success: false }, status) }), /failed|Cloudflare/i);
  await assert.rejects(() => api.readWorkerVersions({ ...options, versionId: 'missing', fetchImpl: async () => response({}, 404) }), /failed|immutable|Cloudflare/i);
});

test('an absent versions endpoint permits cleanup only for a current exact placeholder with both legacy readers absent', async () => {
  for (const legacyExists of [false, true]) {
    const f = await deploymentFixture(); let deletes = 0;
    try {
      await assert.rejects(() => f.mod.deployAndVerifyWorkers({ ...f.options,
        execFile: () => { f.setDeployed(true); throw new Error('Worker does not exist [code: 10007]'); },
        fetchImpl: async (url, options = {}) => {
          if (options.method === 'DELETE') deletes++;
          const path = new URL(url).pathname;
          if (path.endsWith('/versions')) return response({}, 404);
          if (!legacyExists && path.endsWith('/workers/scripts/' + f.identity.workerName)) return response({}, 404);
          if (!legacyExists && path.endsWith('/workers/scripts-search')) return response(page([]));
          return f.fetchImpl(url, options);
        },
      }), legacyExists ? /ownership|placeholder|refus/i : /10007/);
      assert.equal(deletes, legacyExists ? 0 : 1);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
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

test('shared mutation API disables only the exact workers.dev subdomain and deletes only the verified immutable object', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity(); const calls = [];
  const options = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName, worker: { id: WORKER_ID, name: identity.workerName }, fetchImpl: async (url, init) => { calls.push({ url, init }); return response({ success: true }); } };
  await api.disableWorkersDevSubdomain(options);
  await api.deleteExactWorker(options);
  assert.ok(calls[0].url.endsWith('/workers/scripts/' + identity.workerName + '/subdomain'));
  assert.equal(calls[0].init.method, 'POST'); assert.deepEqual(JSON.parse(calls[0].init.body), { enabled: false, previews_enabled: false });
  assert.ok(calls[1].url.endsWith('/workers/workers/' + WORKER_ID)); assert.equal(calls[1].init.method, 'DELETE');
  await assert.rejects(() => api.deleteExactWorker({ ...options, worker: { id: WORKER_ID, name: 'production-worker' } }), /exact|temporary Worker/i);
  assert.equal(calls.length, 2);
});

test('deployment CLI rejects unknown, duplicate, mixed modes, and missing trusted context before accessing secrets or network', async () => {
  const { spawnSync } = require('node:child_process');
  const script = join(__dirname, '../scripts/prepare-remote-dds-deployment.mjs');
  for (const args of [
    ['--deploy-and-verify', '--out', 'unused.json'],
    ['--preflight', '--identity', 'x', '--out', 'unused.json'],
    ['--preflight', '--preflight', '--out', 'unused.json'],
    ['--preflight', '--deploy-from-identity', 'x', '--out', 'unused.json'],
    ['--unknown', '--out', 'unused.json'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: TOKEN, DDS_REMOTE_TEST_KEY: KEY } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /argument|mode|required|Unknown|Duplicate/i);
    assert.equal(result.stderr.includes(TOKEN), false); assert.equal(result.stderr.includes(KEY), false);
  }
});

test('preflight and deploy CLI forms atomically persist secret-free records with trusted context', async () => {
  const f = await deploymentFixture();
  try {
    const input = join(f.root, 'identity.json'), pre = join(f.root, 'pre-deployment.json'), out = join(f.root, 'deployment.json');
    writeFileSync(input, JSON.stringify(f.identity));
    const context = ['--repository', CONTEXT.repository, '--workflow', CONTEXT.workflow, '--run-id', CONTEXT.runId, '--run-attempt', CONTEXT.runAttempt, '--commit-sha', CONTEXT.commitSha];
    const env = { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: TOKEN, DDS_REMOTE_TEST_KEY: KEY };
    const dependencies = { root: f.root, fetchImpl: f.fetchImpl, execFile: f.execFile };
    const identity = await f.mod.runDeploymentCli(['--preflight', '--identity', input, ...context, '--out', pre], env, dependencies);
    assert.deepEqual(JSON.parse(require('node:fs').readFileSync(pre, 'utf8')), identity);
    assert.equal(f.events.filter((e) => e.command).length, 0);
    const manifest = await f.mod.runDeploymentCli(['--deploy-from-identity', pre, ...context, '--out', out], env, dependencies);
    assert.deepEqual(JSON.parse(require('node:fs').readFileSync(out, 'utf8')), manifest);
    f.mod.assertDeploymentManifest(manifest, { root: f.root });
    assert.equal(require('node:fs').readFileSync(out, 'utf8').includes(KEY), false);
    assert.equal(require('node:fs').readFileSync(out, 'utf8').includes(TOKEN), false);
    assert.equal(require('node:fs').readdirSync(f.root).some((name) => name.endsWith('.tmp')), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('partial cleanup refuses a replacement immutable object after a code-10007 retry', async () => {
  const f = await deploymentFixture(); let currentReads = 0, deletes = 0;
  try {
    await assert.rejects(() => f.mod.deployAndVerifyWorkers({ ...f.options,
      execFile: () => { f.setDeployed(true); throw new Error('Worker does not exist [code: 10007]'); },
      fetchImpl: async (url, options = {}) => {
        const path = new URL(url).pathname;
        if (options.method === 'DELETE') deletes++;
        if (path.endsWith('/workers/workers')) {
          currentReads++;
          if (currentReads >= 3) return response(page([{ id: 'c'.repeat(32), name: f.identity.workerName }]));
        }
        if (path.endsWith('/versions')) return response({ ...page([]), result: { items: [] } });
        return f.fetchImpl(url, options);
      },
    }), /immutable.*(changed|mismatch)|replacement|refus/i);
    assert.equal(deletes, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('the existing teardown adapter supplies the exact name to shared deletion and confirms both API representations absent', async () => {
  const f = await deploymentFixture(); f.setDeployed(true);
  try {
    const result = await f.mod.teardownTemporaryWorkers({ ...f.options, temporaryWorkerName: f.identity.workerName,
      workersDevUrl: 'https://' + f.identity.workerName + '.example.workers.dev', fetchImpl: async (url, options) => {
        if (new URL(url).hostname.endsWith('.workers.dev')) return response({}, 404);
        return f.fetchImpl(url, options);
      },
    });
    assert.deepEqual(result, { deleted: true }); assert.equal(f.isDeleted(), true);
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

for (const target of ['objects', 'legacy', 'versions']) test('official ' + target + ' page reader rejects a cursor-only terminal envelope', async () => {
  const api = await import('../scripts/cloudflare-temporary-worker-api.mjs'); const identity = await ciIdentity();
  const options = { accountId: 'acct', apiToken: TOKEN, temporaryWorkerName: identity.workerName,
    fetchImpl: async () => response({ success: true, result: target === 'versions' ? { items: [] } : [], result_info: { cursor: null } }),
  };
  const method = target === 'objects' ? api.findExactWorker : target === 'legacy' ? api.listLegacyExactScript : api.readWorkerVersions;
  await assert.rejects(() => method(options), /pagination|page/i);
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
        if (uploaded && path.endsWith('/versions')) return response({ ...page([]), result: { items: [{ id: 'deployed-v2' }, { id: 'deployed-v1' }] } });
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

for (const drift of ['missing tag', 'foreign tag', 'script ETag', 'version config']) test('final exact-version detail refuses ' + drift + ' drift without cleanup', async () => {
  const f = await deploymentFixture(); let detailReads = 0, deletes = 0;
  try {
    await assert.rejects(() => f.mod.deployAndVerifyWorkers({ ...f.options, fetchImpl: async (url, options = {}) => {
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
    } }), /ownership|immutable|metadata|refus|changed/i);
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
