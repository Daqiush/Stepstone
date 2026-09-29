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

test('deployment manifest binds the exact wasm and harness bytes to a deterministic build ID', async () => {
  const mod = await deployment(); const root = repo();
  try {
    const manifest = mod.createDeploymentManifest({ root, verifiedDeployment: { versionId: 'v-123', apiVerified: true, wranglerVersion: '4.0.0', workersDevUrl: 'https://temporary.example.workers.dev', temporaryWorkerName: 'ss-dds-soak-00000000-0000-4000-8000-000000000001' } });
    assert.equal(manifest.version, 1);
    assert.match(manifest.buildId, /^[a-f0-9]{64}$/);
    assert.match(manifest.assets.wasm.sha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.keys(manifest.assets.harness).length, 2);
    assert.equal(JSON.stringify(manifest).includes('temporary.example.workers.dev'), false);
    writeFileSync(join(root, 'workers/vendor/bridge-dds/dds-worker.wasm'), 'wasm-v2');
    assert.throws(() => mod.assertDeploymentManifest(manifest, { root }), /Wasm asset hash changed/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deployment manifest rejects a missing version instead of assuming compatibility', async () => {
  const mod = await deployment(); const root = repo();
  try {
    const manifest = mod.createDeploymentManifest({ root, verifiedDeployment: { versionId: 'v-123', apiVerified: true, wranglerVersion: '4.0.0', workersDevUrl: 'https://temporary.example.workers.dev', temporaryWorkerName: 'ss-dds-soak-00000000-0000-4000-8000-000000000001' } }); delete manifest.version;
    assert.throws(() => mod.assertDeploymentManifest(manifest, { root }), /version/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deployment manifest records Wasm bytes and requires an explicit deployed Worker version', async () => {
  const mod = await deployment(); const root = repo();
  try {
    assert.throws(() => mod.createDeploymentManifest({ root, workerVersionId: 'v-123' }), /verified deployment/i);
    const manifest = mod.createDeploymentManifest({ root, verifiedDeployment: { versionId: 'v-123', apiVerified: true, wranglerVersion: '4.0.0', workersDevUrl: 'https://temporary.example.workers.dev', temporaryWorkerName: 'ss-dds-soak-00000000-0000-4000-8000-000000000001' } });
    assert.equal(manifest.assets.wasm.bytes, 7);
    assert.equal(manifest.workerVersionId, 'v-123');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deployment verification reads the exact deployed script-version resource and rejects a mismatched API id', async () => {
  const mod = await deployment();
  const calls = [];
  const verified = await mod.verifyWorkersDeployment({
    accountId: 'acct / one', scriptName: 'temporary dds', apiToken: 'test-token', expectedVersionId: 'version-123', wranglerVersion: '4.33.0',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ success: true, result: { id: 'version-123' } }) };
    },
  });
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct%20%2F%20one/workers/scripts/temporary%20dds/versions/version-123');
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-token');
  assert.equal(verified.versionId, 'version-123');
  await assert.rejects(() => mod.verifyWorkersDeployment({
    accountId: 'acct', scriptName: 'script', apiToken: 'test-token', expectedVersionId: 'version-123', wranglerVersion: '4.33.0',
    fetchImpl: async () => ({ ok: true, json: async () => ({ success: true, result: { id: 'other-version' } }) }),
  }), /did not verify/i);
});

test('deployment integration resolves version and workers.dev URL from Cloudflare APIs and fails closed without secure inputs', async () => {
  const mod = await deployment(); const root = repo();
  try {
    const calls = [];
    const verified = await mod.deployAndVerifyWorkers({ root, accountId: 'acct', apiToken: 'token', remoteTestKey: 'a'.repeat(43), randomUUID: () => '11111111-1111-4111-8111-111111111111',
      execFile: (command, args) => {
        calls.push({ command, args });
        if (args[0] === 'secret') return '';
        if (args[0] === 'deploy') return 'deployed';
        if (args[0] === '--version') return '4.33.0\n';
        throw new Error('unexpected command');
      },
      fetchImpl: async (url) => {
        if (url.endsWith('/versions')) return { ok: true, json: async () => ({ result: { items: [{ id: 'deployed-v1' }] } }) };
        if (url.endsWith('/workers/subdomain')) return { ok: true, json: async () => ({ result: { subdomain: 'example' } }) };
        assert.match(url, /workers\/scripts\/ss-dds-soak-11111111-1111-4111-8111-111111111111\/versions\/deployed-v1$/);
        return { ok: true, json: async () => ({ result: { id: 'deployed-v1' } }) };
      },
    });
    assert.equal(verified.versionId, 'deployed-v1');
    assert.equal(verified.temporaryWorkerName, 'ss-dds-soak-11111111-1111-4111-8111-111111111111');
    assert.equal(calls[1].args.includes('--json'), false);
    await assert.rejects(() => mod.deployAndVerifyWorkers({ root, accountId: 'acct', apiToken: '' }), /requires account/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('temporary remote deployment enables only workers.dev and keeps the test key out of generated configuration', async () => {
  const mod = await deployment(); const root = repo();
  try {
    writeFileSync(join(root, 'workers/wrangler.jsonc'), JSON.stringify({ name: 'normal-worker', main: 'src/index.mjs', workers_dev: false, routes: [{ pattern: 'stepstone.hogetsu.uk/*' }] }));
    const name = 'ss-dds-soak-11111111-1111-4111-8111-111111111111';
    const config = mod.createTemporaryWorkersConfig({ root, temporaryWorkerName: name });
    assert.equal(config.name, name);
    assert.equal(config.workers_dev, true);
    assert.equal('routes' in config, false);
    assert.equal(JSON.stringify(config).includes('DDS_REMOTE_TEST_KEY'), false);
    assert.throws(() => mod.createTemporaryWorkersConfig({ root, temporaryWorkerName: 'normal-worker' }), /temporary Worker/i);
    assert.throws(() => mod.createTemporaryWorkersConfig({ root, scriptName: 'normal-worker' }), /temporary Worker/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('temporary remote deployment requires an in-memory test key and obtains a workers.dev URL from Cloudflare APIs', async () => {
  const mod = await deployment(); const root = repo();
  try {
    const calls = [];
    const deployed = await mod.deployAndVerifyWorkers({ root, accountId: 'acct', apiToken: 'token', remoteTestKey: 'a'.repeat(43), randomUUID: () => '22222222-2222-4222-8222-222222222222',
      execFile: (command, args, options = {}) => {
        calls.push({ command, args, options });
        if (args[0] === 'secret') { assert.equal(options.input, 'a'.repeat(43)); return ''; }
        if (args[0] === 'deploy') return 'deployed';
        if (args[0] === '--version') return '4.33.0\n';
        throw new Error('unexpected command');
      },
      fetchImpl: async (url) => url.endsWith('/versions')
        ? ({ ok: true, json: async () => ({ result: { items: [{ id: 'deployed-v1' }] } }) })
        : url.endsWith('/workers/subdomain')
          ? ({ ok: true, json: async () => ({ result: { subdomain: 'example' } }) })
          : ({ ok: true, json: async () => ({ result: { id: 'deployed-v1' } }) }),
    });
    assert.equal(deployed.workersDevUrl, 'https://ss-dds-soak-22222222-2222-4222-8222-222222222222.example.workers.dev');
    assert.equal(calls[0].args.slice(0, 3).join(' '), 'secret put DDS_REMOTE_TEST_KEY');
    await assert.rejects(() => mod.deployAndVerifyWorkers({ root, accountId: 'acct', apiToken: 'token' }), /test key/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('temporary Worker teardown uses only a generated identity, closes the keyed route, then deletes and confirms absence', async () => {
  const mod = await deployment(); const root = repo();
  try {
    const calls = [];
    const temporaryWorkerName = 'ss-dds-soak-33333333-3333-4333-8333-333333333333';
    const workersDevUrl = 'https://ss-dds-soak-33333333-3333-4333-8333-333333333333.example.workers.dev';
    await mod.teardownTemporaryWorkers({ root, accountId: 'acct', temporaryWorkerName, workersDevUrl, remoteTestKey: 'a'.repeat(43), apiToken: 'token', randomUUID: () => '44444444-4444-4444-8444-444444444444',
      execFile: (command, args, options) => { calls.push({ command, args, options }); return args[0] === 'deploy' ? 'deployed' : ''; },
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url === `${workersDevUrl}/__dds/metrics`) return { ok: false, status: 404, json: async () => ({}) };
        if (options.method === 'DELETE') return { ok: true, json: async () => ({ success: true }) };
        return { ok: false, status: 404, json: async () => ({ success: false }) };
      },
    });
    assert.ok(calls.find((call) => call.args?.includes('DDS_REMOTE_TEST:false')));
    const closeDeploy = calls.find((call) => call.args?.[0] === 'deploy');
    assert.equal(closeDeploy.args.includes('--json'), false);
    if (process.platform === 'win32') {
      assert.equal(closeDeploy.command, 'wrangler.cmd');
      assert.equal(closeDeploy.options.shell, true);
    }
    const closureProbe = calls.find((call) => call.url === `${workersDevUrl}/__dds/metrics`);
    assert.equal(closureProbe.options.method, 'POST');
    assert.equal(closureProbe.options.headers['x-dds-test-key'], 'a'.repeat(43));
    assert.match(closureProbe.options.headers['x-dds-run-id'], /^[0-9a-f-]{36}$/i);
    assert.equal(closureProbe.options.headers['x-dds-operation-id'], 'teardown.close.000001');
    assert.equal(calls.find((call) => call.options?.method === 'DELETE').url, `https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/${temporaryWorkerName}`);
    assert.equal(JSON.stringify(calls).includes('DDS_REMOTE_TEST_KEY'), false);
    await assert.rejects(() => mod.teardownTemporaryWorkers({ root, accountId: 'acct', temporaryWorkerName, workersDevUrl, remoteTestKey: 'a'.repeat(43), apiToken: 'token',
      execFile: () => '', fetchImpl: async (url) => url === `${workersDevUrl}/__dds/metrics` ? ({ ok: true, status: 200, json: async () => ({}) }) : ({ ok: false, status: 404, json: async () => ({}) }),
    }), /opaque 404/i);
    await assert.rejects(() => mod.teardownTemporaryWorkers({ root, accountId: 'acct', temporaryWorkerName: 'production-worker', workersDevUrl, remoteTestKey: 'a'.repeat(43), apiToken: 'token' }), /temporary Worker/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
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

test('runner fails closed when observed accounting differs from its durable physical-request ledger', async () => {
  const mod = await runner();
  const accounting = { workerInbound: 1, doFetchArrivals: 1, queuedDoCommands: 0, sqliteRows: { reads: 1, writes: 1 } };
  const ledger = [{ route: '/__dds/metrics', replayed: false }];
  assert.deepEqual(mod.reconcileObservedLedger(accounting, ledger), accounting);
  assert.throws(() => mod.reconcileObservedLedger({ ...accounting, workerInbound: 2 }, ledger), /reconcile/i);
});

test('runner persists the endpoint build and verified Worker version from its preflight response', async () => {
  const mod = await runner();
  const evidence = mod.buildPreflightEvidence({ accounting: { workerInbound: 1 }, replayed: false,
    operationResult: { buildId: 'build-bound', workerVersionId: 'version-bound', activationId: 'activation' } });
  assert.deepEqual(evidence, { accounting: { workerInbound: 1 }, remote: { buildId: 'build-bound', workerVersionId: 'version-bound', activationId: 'activation' }, activationId: 'activation', replayed: false,
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
