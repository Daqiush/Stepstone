const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'remote-dds-deployment-'));
  mkdirSync(join(root, 'workers/vendor/bridge-dds'), { recursive: true });
  mkdirSync(join(root, 'workers/src'), { recursive: true });
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
    const manifest = mod.createDeploymentManifest({ root, workerVersionId: 'v-123' });
    assert.equal(manifest.version, 1);
    assert.match(manifest.buildId, /^[a-f0-9]{64}$/);
    assert.match(manifest.assets.wasm.sha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.keys(manifest.assets.harness).length, 2);
    writeFileSync(join(root, 'workers/vendor/bridge-dds/dds-worker.wasm'), 'wasm-v2');
    assert.throws(() => mod.assertDeploymentManifest(manifest, { root }), /Wasm asset hash changed/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deployment manifest rejects a missing version instead of assuming compatibility', async () => {
  const mod = await deployment(); const root = repo();
  try {
    const manifest = mod.createDeploymentManifest({ root, workerVersionId: 'v-123' }); delete manifest.version;
    assert.throws(() => mod.assertDeploymentManifest(manifest, { root }), /version/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deployment manifest records Wasm bytes and requires an explicit deployed Worker version', async () => {
  const mod = await deployment(); const root = repo();
  try {
    assert.throws(() => mod.createDeploymentManifest({ root }), /Worker version ID/i);
    const manifest = mod.createDeploymentManifest({ root, workerVersionId: 'v-123' });
    assert.equal(manifest.assets.wasm.bytes, 7);
    assert.equal(manifest.workerVersionId, 'v-123');
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
