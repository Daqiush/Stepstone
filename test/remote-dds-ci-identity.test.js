const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const INPUT = { repository: 'Daqiush/Stepstone', workflow: 'Remote DDS Soak', runId: '123456789', runAttempt: '2', commitSha: 'a'.repeat(40), secret: 'not-persisted' };
const cli = resolve(__dirname, '../scripts/remote-dds-ci-identity.mjs');
const mod = () => import('../scripts/remote-dds-ci-identity.mjs');
const contextArgs = ['--repository', INPUT.repository, '--workflow', INPUT.workflow, '--run-id', INPUT.runId, '--run-attempt', INPUT.runAttempt, '--commit-sha', INPUT.commitSha];

function assertCliFailure(result, code, markers = []) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `Remote DDS deployment failed [${code}].\n`);
  for (const marker of markers) assert.equal(`${result.stdout}${result.stderr}`.includes(marker), false, marker);
}

test('test key uses the pinned UTF-8 JSON HMAC vector and binds only repository/run/attempt', async () => {
  const { deriveRemoteTestKey } = await mod();
  const key = deriveRemoteTestKey(INPUT);
  assert.equal(key, 'EpcIq_vg1echjFz_T43uSTY6xxYXivOmobzaTD8CVVk');
  for (const [field, value] of [['repository', 'Other/Stepstone'], ['runId', '123456790'], ['runAttempt', '3']]) {
    assert.notEqual(deriveRemoteTestKey({ ...INPUT, [field]: value }), key);
  }
  for (const [field, value] of [['workflow', 'Other Workflow'], ['commitSha', 'b'.repeat(40)]]) {
    assert.equal(deriveRemoteTestKey({ ...INPUT, [field]: value }), key);
  }
});

test('ownership attestation uses the pinned JSON HMAC vector and binds every ownership field', async () => {
  const { deriveOwnershipAttestation } = await mod();
  const tag = deriveOwnershipAttestation(INPUT);
  assert.equal(tag, 'buVvZra9TTq74waSHSSg5gmurFfEANzVDcSnZvPZeMU');
  assert.match(tag, /^[A-Za-z0-9_-]{43}$/);
  for (const [field, value] of [['repository', 'Other/Stepstone'], ['workflow', 'Other Workflow'], ['runId', '123456790'], ['runAttempt', '3'], ['commitSha', 'b'.repeat(40)]]) {
    assert.notEqual(deriveOwnershipAttestation({ ...INPUT, [field]: value }), tag);
  }
});

test('deterministic CI identity contains only non-secret ownership metadata', async () => {
  const { deriveCiIdentity, deriveRemoteTestKey } = await mod();
  const identity = deriveCiIdentity(INPUT);
  assert.deepEqual(deriveCiIdentity(INPUT), identity);
  assert.match(identity.workerName, /^ss-dds-soak-gh-123456789-2-[a-z0-9_-]{12}$/);
  assert.equal(identity.workerName, 'ss-dds-soak-gh-123456789-2-6ee56f66b6bd');
  assert.equal(identity.ownershipTag, 'buVvZra9TTq74waSHSSg5gmurFfEANzVDcSnZvPZeMU');
  const persisted = JSON.stringify(identity);
  assert.equal(persisted.includes(INPUT.secret), false);
  assert.equal(persisted.includes(deriveRemoteTestKey(INPUT)), false);
  assert.equal('secret' in identity, false);
  assert.equal('remoteTestKey' in identity, false);
  assert.throws(() => deriveCiIdentity({ ...INPUT, workerName: `${identity.workerName.slice(0, -1)}z` }), /worker.*name/i);
});

function manifest(identity) {
  return { version: 2, buildId: '652571ef684a7acc3e4ebab4e58520d49b844f87cb964e71dd955ee68e8ac547', workerId: 'a'.repeat(32), workerVersionId: 'worker-v1',
    verifiedDeployment: { workerId: 'a'.repeat(32), versionId: 'worker-v1', apiVerified: true, wranglerVersion: '4.33.0', temporaryWorkerName: identity.workerName, ownershipTag: identity.ownershipTag },
    assets: { wasm: { path: 'workers/vendor/bridge-dds/dds-worker.wasm', bytes: 4, sha256: '2'.repeat(64) }, harness: {
      'workers/src/index.mjs': { path: 'workers/src/index.mjs', bytes: 8, sha256: '3'.repeat(64) },
      'workers/src/harness-router.mjs': { path: 'workers/src/harness-router.mjs', bytes: 9, sha256: '4'.repeat(64) },
    } } };
}

test('versioned predeployment schema requires a canonical no-collision ISO timestamp and exact identity', async () => {
  const m = await mod(); const trustedIdentity = m.deriveCiIdentity(INPUT);
  const identity = m.createPreDeploymentIdentity({ identity: trustedIdentity, noCollisionVerifiedAt: '2026-09-30T12:00:00.000Z' });
  assert.equal(identity.schemaVersion, 1);
  assert.equal(identity.kind, 'remote-dds-predeployment-identity');
  assert.deepEqual(m.assertPreDeploymentIdentity(identity, { trustedIdentity }), identity);
  for (const timestamp of ['', '2026-09-30', '2026-02-30T12:00:00.000Z', '2026-09-30T12:00:00Z']) {
    assert.throws(() => m.createPreDeploymentIdentity({ identity: trustedIdentity, noCollisionVerifiedAt: timestamp }), /timestamp|noCollisionVerifiedAt/i);
  }
  for (const [field, value] of [['schemaVersion', 2], ['kind', 'other'], ['workerName', 'ss-dds-soak-gh-123456789-2-000000000000'], ['ownershipTag', 'a'.repeat(43)], ['secret', 'cannot-persist']]) {
    assert.throws(() => m.assertPreDeploymentIdentity({ ...identity, [field]: value }, { trustedIdentity }), /identity|schema|kind|field|worker|ownership/i);
  }
  assert.throws(() => m.assertCiIdentity({ ...trustedIdentity, remoteTestKey: 'must-not-persist' }), /field/i);
});

test('deployment record binds the complete deployment manifest and Cloudflare observations', async () => {
  const m = await mod(); const trustedIdentity = m.deriveCiIdentity(INPUT);
  const identity = m.createPreDeploymentIdentity({ identity: trustedIdentity, noCollisionVerifiedAt: '2026-09-30T12:00:00.000Z' });
  const deploymentManifest = manifest(identity);
  const record = m.createDeploymentRecord({ identity, endpoint: `https://${identity.workerName}.example.workers.dev`, deploymentManifest,
    localConfigurationSha256: '5'.repeat(64), scriptETag: '"etag-observed"', versionConfigurationSha256: '6'.repeat(64) });
  assert.deepEqual(record, { schemaVersion: 1, kind: 'remote-dds-deployment-record', identity, endpoint: `https://${identity.workerName}.example.workers.dev`,
    version: 2, deploymentManifestVersion: 2, ownershipTag: identity.ownershipTag, verifiedDeployment: deploymentManifest.verifiedDeployment, buildId: deploymentManifest.buildId, workerId: 'a'.repeat(32), workerVersionId: 'worker-v1', wranglerVersion: '4.33.0',
    assets: deploymentManifest.assets,
    localConfigurationSha256: '5'.repeat(64), scriptETag: '"etag-observed"', versionConfigurationSha256: '6'.repeat(64) });
  assert.deepEqual(m.assertDeploymentRecord(record, { identity, deploymentManifest }), record);
  const boxedId = new String('a'.repeat(32));
  assert.throws(() => m.assertDeploymentRecord({ ...record, workerId: boxedId, verifiedDeployment: { ...record.verifiedDeployment, workerId: boxedId } }), /immutable Worker ID/i);
  for (const endpoint of ['http://worker.example.workers.dev', 'https://worker.example.workers.dev/path', 'https://worker.example.workers.dev?x=1', 'https://worker.example.workers.dev/', 'https://worker.example.com', `https://${identity.workerName}.example.workers.dev/#x`, `https://other.example.workers.dev`, `https://${identity.workerName}.workers.dev`]) {
    assert.throws(() => m.assertDeploymentRecord({ ...record, endpoint }), /endpoint|workers.dev/i);
  }
  for (const mutate of [
    (r) => { r.assets.harness['workers/src/extra.mjs'] = { path: 'workers/src/extra.mjs', bytes: 1, sha256: '7'.repeat(64) }; },
    (r) => { delete r.assets.harness['workers/src/index.mjs']; },
    (r) => { r.assets.harness['workers/src/index.mjs'].sha256 = '7'.repeat(64); },
    (r) => { r.assets.wasm.sha256 = '7'.repeat(64); },
    (r) => { r.workerVersionId = 'other'; },
    (r) => { delete r.workerId; },
    (r) => { r.workerId = 'b'.repeat(32); },
    (r) => { r.workerId = 'not-an-immutable-ID'; },
    (r) => { delete r.verifiedDeployment.workerId; },
    (r) => { r.verifiedDeployment.workerId = 'b'.repeat(32); },
    (r) => { r.workerId = r.verifiedDeployment.workerId = new String('a'.repeat(32)); },
    (r) => { r.wranglerVersion = 'other'; },
    (r) => { r.buildId = '7'.repeat(64); },
    (r) => { r.schemaVersion = 2; },
    (r) => { r.secret = 'must-not-persist'; },
  ]) {
    const changed = structuredClone(record); mutate(changed);
    assert.throws(() => m.assertDeploymentRecord(changed, { identity, deploymentManifest }), /deployment|manifest|asset|harness|version|field|build|wrangler/i);
  }
  for (const field of ['localConfigurationSha256', 'scriptETag', 'versionConfigurationSha256']) {
    assert.throws(() => m.assertDeploymentRecord({ ...record, [field]: '' }), /hash|ETag|Sha256/i);
  }
});

test('deployment record rejects independently changed build ID or assets without relying on an external manifest', async () => {
  const m = await mod(), trustedIdentity = m.deriveCiIdentity(INPUT);
  const identity = m.createPreDeploymentIdentity({ identity: trustedIdentity, noCollisionVerifiedAt: '2026-09-30T12:00:00.000Z' });
  const record = m.createDeploymentRecord({ identity, endpoint: `https://${identity.workerName}.example.workers.dev`, deploymentManifest: manifest(identity),
    localConfigurationSha256: '5'.repeat(64), scriptETag: '"etag-observed"', versionConfigurationSha256: '6'.repeat(64) });
  for (const mutate of [
    (r) => { r.buildId = '7'.repeat(64); },
    (r) => { r.assets.wasm.sha256 = '7'.repeat(64); },
    (r) => { r.assets.wasm.bytes++; },
    (r) => { r.assets.harness['workers/src/index.mjs'].sha256 = '7'.repeat(64); },
    (r) => { delete r.assets.harness['workers/src/index.mjs']; },
    (r) => { r.assets.harness['workers/src/extra.mjs'] = { path: 'workers/src/extra.mjs', bytes: 1, sha256: '7'.repeat(64) }; },
  ]) {
    const changed = structuredClone(record); mutate(changed);
    assert.throws(() => m.assertDeploymentRecord(changed), /build ID|assets/i);
  }
  assert.deepEqual(m.assertDeploymentRecord(record), record);
});

test('identity derivation strictly rejects invalid context and absent source secret', async () => {
  const { deriveCiIdentity } = await mod();
  const bad = [
    ['repository', 'Stepstone'], ['repository', 'owner/repo/extra'], ['repository', ' owner/repo'], ['repository', 'owner/../repo'],
    ['workflow', ''], ['workflow', ' Remote DDS Soak'], ['workflow', 'Remote\nDDS'],
    ['runId', '0'], ['runId', '01'], ['runId', 123], ['runId', '1e8'],
    ['runAttempt', '0'], ['runAttempt', '-1'], ['runAttempt', '01'], ['runAttempt', 2],
    ['commitSha', 'a'.repeat(39)], ['commitSha', 'G'.repeat(40)], ['commitSha', 'A'.repeat(40)],
    ['secret', ''], ['secret', undefined],
  ];
  for (const [field, value] of bad) assert.throws(() => deriveCiIdentity({ ...INPUT, [field]: value }), new RegExp(field === 'secret' ? 'secret' : field, 'i'), `${field}: ${value}`);
});

test('derive CLI masks the key after writing the environment and a secret-free identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dds-ci-identity-'));
  try {
    const githubEnv = join(dir, 'github.env'); const out = join(dir, 'current-job.json');
    writeFileSync(githubEnv, 'EXISTING=value\n');
    const result = spawnSync(process.execPath, [cli, '--derive', ...contextArgs, '--github-env', githubEnv, '--identity-out', out], { env: { ...process.env, CLOUDFLARE_API_TOKEN: INPUT.secret }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '::add-mask::EpcIq_vg1echjFz_T43uSTY6xxYXivOmobzaTD8CVVk\n');
    assert.equal(readFileSync(githubEnv, 'utf8'), 'EXISTING=value\nDDS_REMOTE_TEST_KEY=EpcIq_vg1echjFz_T43uSTY6xxYXivOmobzaTD8CVVk\n');
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), (await mod()).deriveCiIdentity(INPUT));
    assert.equal(readFileSync(out, 'utf8').includes(INPUT.secret), false);
    assert.equal(`${result.stdout}${result.stderr}`.includes(INPUT.secret), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('derive CLI rejects unknown, duplicate, mixed, and missing arguments without writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dds-ci-identity-invalid-'));
  try {
    const marker = 'cli-argument-marker-must-not-leak';
    const githubEnv = join(dir, `github-${marker}.env`); const base = [cli, '--derive', ...contextArgs, '--github-env', githubEnv];
    for (const args of [base.concat('--unknown', marker), base.concat('--derive'), base.concat('--repository', marker), base.concat('--create-ready'), base.slice(0, -1), [cli, ...contextArgs, '--github-env', githubEnv]]) {
      const result = spawnSync(process.execPath, args, { env: { ...process.env, CLOUDFLARE_API_TOKEN: INPUT.secret }, encoding: 'utf8' });
      assertCliFailure(result, 'CLI_INPUT_INVALID', [marker, INPUT.secret]);
      assert.equal(existsSync(githubEnv), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('derive CLI classifies invalid GitHub context without exposing argument or environment markers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dds-ci-identity-context-'));
  try {
    const argumentMarker = 'invalid-context-marker-must-not-leak';
    const environmentMarker = 'context-secret-marker-must-not-leak';
    const outputMarker = 'context-output-marker-must-not-leak';
    const githubEnv = join(dir, outputMarker);
    const args = [cli, '--derive', '--repository', argumentMarker, ...contextArgs.slice(2), '--github-env', githubEnv];
    const result = spawnSync(process.execPath, args, { env: { ...process.env, CLOUDFLARE_API_TOKEN: environmentMarker }, encoding: 'utf8' });
    assertCliFailure(result, 'CLI_INPUT_INVALID', [argumentMarker, environmentMarker, outputMarker]);
    assert.equal(existsSync(githubEnv), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('derive CLI classifies an absent source token without exposing arguments or inherited key material', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dds-ci-identity-token-'));
  try {
    const argumentMarker = 'required-config-argument-marker-must-not-leak';
    const inheritedKeyMarker = 'inherited-key-marker-must-not-leak';
    const outputMarker = 'required-config-output-marker-must-not-leak';
    const githubEnv = join(dir, outputMarker);
    const args = [cli, '--derive', ...contextArgs.slice(0, 3), argumentMarker, ...contextArgs.slice(4), '--github-env', githubEnv];
    const result = spawnSync(process.execPath, args, { env: { ...process.env, CLOUDFLARE_API_TOKEN: '', DDS_REMOTE_TEST_KEY: inheritedKeyMarker }, encoding: 'utf8' });
    assertCliFailure(result, 'REQUIRED_CONFIG_MISSING', [argumentMarker, inheritedKeyMarker, outputMarker]);
    assert.equal(existsSync(githubEnv), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('derive CLI classifies GitHub environment output failure without printing the derived key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dds-ci-identity-env-io-'));
  try {
    const argumentMarker = 'env-io-argument-marker-must-not-leak';
    const secretMarker = 'env-io-secret-marker-must-not-leak';
    const outputMarker = 'env-io-output-marker-must-not-leak';
    const failureMarker = 'append-failure-marker-must-not-leak';
    const githubEnv = join(dir, outputMarker); writeFileSync(githubEnv, 'EXISTING=value\n');
    const preload = `data:text/javascript,${encodeURIComponent(`
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      fs.appendFileSync = () => { throw new Error('${failureMarker}'); };
      syncBuiltinESMExports();
    `)}`;
    const args = [cli, '--derive', ...contextArgs.slice(0, 3), argumentMarker, ...contextArgs.slice(4), '--github-env', githubEnv];
    const result = spawnSync(process.execPath, ['--import', preload, ...args], { env: { ...process.env, CLOUDFLARE_API_TOKEN: secretMarker }, encoding: 'utf8' });
    assertCliFailure(result, 'LOCAL_IO_FAILED', [argumentMarker, secretMarker, outputMarker, failureMarker, 'EpcIq_vg1echjFz_T43uSTY6xxYXivOmobzaTD8CVVk']);
    assert.equal(readFileSync(githubEnv, 'utf8'), 'EXISTING=value\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('derive CLI classifies identity report output failure without printing the derived key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dds-ci-identity-report-io-'));
  try {
    const argumentMarker = 'report-io-argument-marker-must-not-leak';
    const secretMarker = 'report-io-secret-marker-must-not-leak';
    const outputMarker = 'report-io-output-marker-must-not-leak';
    const githubEnv = join(dir, 'github.env');
    const blockedParent = join(dir, outputMarker); writeFileSync(blockedParent, 'not-a-directory');
    const identityOut = join(blockedParent, 'identity.json');
    const args = [cli, '--derive', ...contextArgs.slice(0, 3), argumentMarker, ...contextArgs.slice(4), '--github-env', githubEnv, '--identity-out', identityOut];
    const result = spawnSync(process.execPath, args, { env: { ...process.env, CLOUDFLARE_API_TOKEN: secretMarker }, encoding: 'utf8' });
    assertCliFailure(result, 'LOCAL_IO_FAILED', [argumentMarker, secretMarker, outputMarker, 'EpcIq_vg1echjFz_T43uSTY6xxYXivOmobzaTD8CVVk']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('derive CLI classifies output canonicalization failure without exposing path or error markers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dds-ci-identity-canonical-io-'));
  try {
    const argumentMarker = 'canonical-io-argument-marker-must-not-leak';
    const secretMarker = 'canonical-io-secret-marker-must-not-leak';
    const envOutputMarker = 'canonical-env-output-marker-must-not-leak';
    const identityOutputMarker = 'canonical-identity-output-marker-must-not-leak';
    const failureMarker = 'canonical-failure-marker-must-not-leak';
    const githubEnv = join(dir, envOutputMarker); const identityOut = join(dir, identityOutputMarker);
    const preload = `data:text/javascript,${encodeURIComponent(`
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const fail = () => { throw new Error('${failureMarker}'); };
      fail.native = fail;
      fs.realpathSync = fail;
      syncBuiltinESMExports();
    `)}`;
    const args = [cli, '--derive', ...contextArgs.slice(0, 3), argumentMarker, ...contextArgs.slice(4), '--github-env', githubEnv, '--identity-out', identityOut];
    const result = spawnSync(process.execPath, ['--import', preload, ...args], { env: { ...process.env, CLOUDFLARE_API_TOKEN: secretMarker }, encoding: 'utf8' });
    assertCliFailure(result, 'LOCAL_IO_FAILED', [argumentMarker, secretMarker, envOutputMarker, identityOutputMarker, failureMarker, 'EpcIq_vg1echjFz_T43uSTY6xxYXivOmobzaTD8CVVk']);
    assert.equal(existsSync(githubEnv), false);
    assert.equal(existsSync(identityOut), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('derive CLI appends a separate GitHub environment assignment when its last line lacks a newline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dds-ci-env-newline-'));
  try {
    const githubEnv = join(dir, 'github.env'); writeFileSync(githubEnv, 'EXISTING=value');
    const result = spawnSync(process.execPath, [cli, '--derive', ...contextArgs, '--github-env', githubEnv], { env: { ...process.env, CLOUDFLARE_API_TOKEN: INPUT.secret }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(githubEnv, 'utf8'), 'EXISTING=value\nDDS_REMOTE_TEST_KEY=EpcIq_vg1echjFz_T43uSTY6xxYXivOmobzaTD8CVVk\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('derive CLI rejects Windows case aliases of one output before any writes', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dds-ci-output-case-'));
  try {
    const githubEnv = join(dir, 'github.env'); const out = join(dir, 'GITHUB.ENV');
    const original = 'EXISTING=case-sensitive-content\n'; writeFileSync(githubEnv, original);
    const result = spawnSync(process.execPath, [cli, '--derive', ...contextArgs, '--github-env', githubEnv, '--identity-out', out], { env: { ...process.env, CLOUDFLARE_API_TOKEN: INPUT.secret }, encoding: 'utf8' });
    assertCliFailure(result, 'CLI_INPUT_INVALID');
    assert.equal(readFileSync(githubEnv, 'utf8'), original);
    assert.equal(readFileSync(out, 'utf8'), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('derive CLI rejects parent junction/symlink output aliases before any writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dds-ci-output-parent-'));
  try {
    const parent = join(dir, 'real-parent'); const alias = join(dir, 'alias-parent'); mkdirSync(parent);
    symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const githubEnv = join(parent, 'github.env'); const out = join(alias, 'github.env');
    const original = 'EXISTING=junction-original-content\n'; writeFileSync(githubEnv, original);
    const result = spawnSync(process.execPath, [cli, '--derive', ...contextArgs, '--github-env', githubEnv, '--identity-out', out], { env: { ...process.env, CLOUDFLARE_API_TOKEN: INPUT.secret }, encoding: 'utf8' });
    assertCliFailure(result, 'CLI_INPUT_INVALID');
    assert.equal(readFileSync(githubEnv, 'utf8'), original);
    assert.equal(readFileSync(out, 'utf8'), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('derive CLI rejects aliased output paths even before the output file exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dds-ci-output-new-'));
  try {
    const parent = join(dir, 'real-parent'); const alias = join(dir, 'alias-parent'); mkdirSync(parent);
    symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const githubEnv = join(parent, 'github.env'); const out = join(alias, 'github.env');
    const result = spawnSync(process.execPath, [cli, '--derive', ...contextArgs, '--github-env', githubEnv, '--identity-out', out], { env: { ...process.env, CLOUDFLARE_API_TOKEN: INPUT.secret }, encoding: 'utf8' });
    assertCliFailure(result, 'CLI_INPUT_INVALID');
    assert.equal(existsSync(githubEnv), false);
    assert.equal(existsSync(out), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function nonPlainObjects(value) {
  class Record {}
  return [Object.assign(new Date(), value), Object.assign([], value), Object.assign(new Record(), value)];
}
function nullPrototypeData(value) {
  if (!value || typeof value !== 'object') return value;
  return Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, item]) => [key, nullPrototypeData(item)])));
}
function assertPlainData(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  for (const item of Object.values(value)) assertPlainData(item);
}

test('all identity assertions reject non-plain roots and recursive deployment maps', async () => {
  const m = await mod(); const identity = m.deriveCiIdentity(INPUT);
  const predeployment = m.createPreDeploymentIdentity({ identity, noCollisionVerifiedAt: '2026-09-30T12:00:00.000Z' });
  const deploymentManifest = manifest(identity);
  const record = m.createDeploymentRecord({ identity: predeployment, endpoint: `https://${identity.workerName}.example.workers.dev`, deploymentManifest,
    localConfigurationSha256: '5'.repeat(64), scriptETag: '"etag-observed"', versionConfigurationSha256: '6'.repeat(64) });
  const context = Object.fromEntries(['repository', 'workflow', 'runId', 'runAttempt', 'commitSha'].map((field) => [field, INPUT[field]]));
  for (const [assertion, value] of [[m.assertGithubContext, context], [m.assertCiIdentity, identity], [m.assertPreDeploymentIdentity, predeployment], [m.assertDeploymentRecord, record]]) {
    for (const nonPlain of nonPlainObjects(value)) assert.throws(() => assertion(nonPlain), /plain object/i);
  }
  for (const field of ['identity', 'assets']) {
    for (const nonPlain of nonPlainObjects(record[field])) assert.throws(() => m.assertDeploymentRecord({ ...record, [field]: nonPlain }), /plain object/i);
  }
  for (const nonPlain of nonPlainObjects(record.assets.harness)) {
    assert.throws(() => m.assertDeploymentRecord({ ...record, assets: { ...record.assets, harness: nonPlain } }), /plain object/i);
  }
  for (const nonPlain of nonPlainObjects(deploymentManifest)) assert.throws(() => m.assertDeploymentRecord(record, { deploymentManifest: nonPlain }), /plain object/i);
  for (const field of ['verifiedDeployment', 'assets']) {
    for (const nonPlain of nonPlainObjects(deploymentManifest[field])) assert.throws(() => m.assertDeploymentRecord(record, { deploymentManifest: { ...deploymentManifest, [field]: nonPlain } }), /plain object/i);
  }
  for (const field of ['wasm', 'harness']) {
    for (const nonPlain of nonPlainObjects(deploymentManifest.assets[field])) assert.throws(() => m.assertDeploymentRecord(record, { deploymentManifest: { ...deploymentManifest, assets: { ...deploymentManifest.assets, [field]: nonPlain } } }), /plain object/i);
  }
  for (const nonPlain of nonPlainObjects(deploymentManifest.assets.harness['workers/src/index.mjs'])) {
    assert.throws(() => m.assertDeploymentRecord(record, { deploymentManifest: { ...deploymentManifest, assets: { ...deploymentManifest.assets, harness: { ...deploymentManifest.assets.harness, 'workers/src/index.mjs': nonPlain } } } }), /plain object/i);
  }
});

test('identity assertions accept null-prototype maps and return normalized plain data', async () => {
  const m = await mod(); const identity = m.deriveCiIdentity(INPUT);
  const predeployment = m.createPreDeploymentIdentity({ identity, noCollisionVerifiedAt: '2026-09-30T12:00:00.000Z' });
  const record = m.createDeploymentRecord({ identity: predeployment, endpoint: `https://${identity.workerName}.example.workers.dev`, deploymentManifest: manifest(identity),
    localConfigurationSha256: '5'.repeat(64), scriptETag: '"etag-observed"', versionConfigurationSha256: '6'.repeat(64) });
  for (const [assertion, value] of [[m.assertGithubContext, INPUT], [m.assertCiIdentity, identity], [m.assertPreDeploymentIdentity, predeployment], [m.assertDeploymentRecord, record]]) {
    const normalized = assertion(nullPrototypeData(value));
    assertPlainData(normalized);
    assert.deepEqual(normalized, assertion(value));
  }
});
