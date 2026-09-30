const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const CONTEXT = { repository: 'Daqiush/Stepstone', workflow: 'Remote DDS Soak', runId: '123456789', runAttempt: '2', commitSha: 'a'.repeat(40) };
const FILES = ['manifest.json', 'journal.jsonl', 'report.json', 'evidence.json', 'segment-result.json'];
const cli = resolve(__dirname, '../scripts/remote-dds-ci-state.mjs');
const mod = () => import('../scripts/remote-dds-ci-state.mjs');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const identityModule = await import('../scripts/remote-dds-ci-identity.mjs');
  const root = mkdtempSync(join(tmpdir(), 'dds-ci-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trustedIdentity = identityModule.deriveCiIdentity({ ...CONTEXT, secret: 'not-persisted' });
  const identity = identityModule.createPreDeploymentIdentity({ identity: trustedIdentity, noCollisionVerifiedAt: '2026-09-30T12:00:00.000Z' });
  const deployment = identityModule.createDeploymentRecord({ identity, endpoint: `https://${identity.workerName}.example.workers.dev`,
    deploymentManifest: { version: 1, buildId: '1'.repeat(64), workerVersionId: 'worker-v1', verifiedDeployment: { apiVerified: true, versionId: 'worker-v1', wranglerVersion: '4.33.0', temporaryWorkerName: identity.workerName },
      assets: { wasm: { path: 'workers/vendor/bridge-dds/dds-worker.wasm', bytes: 4, sha256: '2'.repeat(64) }, harness: {
        'workers/src/index.mjs': { path: 'workers/src/index.mjs', bytes: 8, sha256: '3'.repeat(64) },
        'workers/src/harness-router.mjs': { path: 'workers/src/harness-router.mjs', bytes: 9, sha256: '4'.repeat(64) },
      } } }, localConfigurationSha256: '5'.repeat(64), scriptETag: '"observed-etag"', versionConfigurationSha256: '6'.repeat(64) });
  const inputs = { trustedIdentity, identity, deployment, context: CONTEXT };
  for (const [name, value] of [['trusted', trustedIdentity], ['identity', identity], ['deployment', deployment]]) writeFileSync(join(root, `${name}.json`), JSON.stringify(value));
  const args = ['--trusted-identity', join(root, 'trusted.json'), '--identity', join(root, 'identity.json'), '--deployment', join(root, 'deployment.json'),
    '--repository', CONTEXT.repository, '--workflow', CONTEXT.workflow, '--run-id', CONTEXT.runId, '--run-attempt', CONTEXT.runAttempt, '--commit-sha', CONTEXT.commitSha];
  return { root, inputs, args };
}
function saveState(dir, manifest, runDir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state-manifest.json'), JSON.stringify(manifest));
  if (runDir) {
    mkdirSync(join(dir, 'run'));
    for (const name of FILES) copyFileSync(join(runDir, name), join(dir, 'run', name));
  }
}
function makeRun(root, disposition = 'PAUSED') {
  const dir = join(root, `run-${disposition}`); mkdirSync(dir);
  for (const name of FILES) writeFileSync(join(dir, name), name === 'journal.jsonl' ? '{"event":1}\r\n' : '{ "fixture": true }\n');
  writeFileSync(join(dir, 'segment-result.json'), JSON.stringify({ version: 1, disposition, reason: disposition === 'PAUSED' ? 'MAX_NEW_OPERATIONS' : null, completedCursor: 1, completedThisSegment: 1, startedAt: '2026-09-30T12:00:00.000Z', finishedAt: '2026-09-30T12:01:00.000Z' }));
  return dir;
}
function runCli(args) { return spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, CLOUDFLARE_API_TOKEN: '', DDS_REMOTE_TEST_KEY: '' }, encoding: 'utf8' }); }

test('state-0 is a versioned READY envelope with no run directory', async (t) => {
  const f = await fixture(t); const m = await mod();
  const state = m.createReadyState(f.inputs);
  assert.deepEqual(state, { schemaVersion: 1, kind: 'remote-dds-ci-state', segment: 0, disposition: 'READY', identity: f.inputs.identity, deployment: f.inputs.deployment, files: {} });
  assert.deepEqual(m.assertStateManifest(state), state);
  const stateDir = join(f.root, 'state-0'); saveState(stateDir, state);
  assert.deepEqual(m.validateInputState({ ...f.inputs, stateDir, segment: 1 }), state);
  assert.equal(existsSync(join(stateDir, 'run')), false);
  mkdirSync(join(stateDir, 'run'));
  assert.throws(() => m.validateInputState({ ...f.inputs, stateDir, segment: 1 }), /READY|run|layout/i);
});

test('finalize hashes the exact bytes of all five run files and enforces immediate predecessor lineage', async (t) => {
  const f = await fixture(t); const m = await mod(); const stateDir = join(f.root, 'state-0');
  saveState(stateDir, m.createReadyState(f.inputs));
  const runDir = makeRun(f.root); const state = m.finalizeState({ ...f.inputs, stateDir, runDir, segment: 1 });
  assert.equal(state.segment, 1); assert.equal(state.disposition, 'PAUSED');
  assert.deepEqual(state.files, Object.fromEntries(FILES.map((name) => [`run/${name}`, sha(readFileSync(join(runDir, name)))])));
  const nextDir = join(f.root, 'state-1'); saveState(nextDir, state, runDir);
  assert.deepEqual(m.validateInputState({ ...f.inputs, stateDir: nextDir, segment: 2 }), state);
  for (const segment of [1, 3, 6, 0, 7, '2']) assert.throws(() => m.validateInputState({ ...f.inputs, stateDir: nextDir, segment }), /segment|predecessor|lineage/i);
});

test('state validation rejects any changed journal byte or any other run file byte', async (t) => {
  const f = await fixture(t); const m = await mod(); const stateDir = join(f.root, 'state-0');
  saveState(stateDir, m.createReadyState(f.inputs)); const runDir = makeRun(f.root);
  const state = m.finalizeState({ ...f.inputs, stateDir, runDir, segment: 1 });
  const nextDir = join(f.root, 'state-1'); saveState(nextDir, state, runDir);
  for (const name of FILES) {
    const target = join(nextDir, 'run', name); const bytes = readFileSync(target);
    writeFileSync(target, Buffer.concat([bytes, Buffer.from(' ')]));
    assert.throws(() => m.validateInputState({ ...f.inputs, stateDir: nextDir, segment: 2 }), /hash|bytes/i, name);
    writeFileSync(target, bytes);
  }
});

test('state bindings reject every GitHub or independent deployment drift including harness key additions/deletions', async (t) => {
  const f = await fixture(t); const m = await mod(); const stateDir = join(f.root, 'state-0');
  const state = m.createReadyState(f.inputs); saveState(stateDir, state);
  const changes = [
    (s) => { s.identity.repository = 'Other/Stepstone'; }, (s) => { s.identity.workflow = 'Other Workflow'; },
    (s) => { s.identity.runId = '123456790'; }, (s) => { s.identity.runAttempt = '3'; }, (s) => { s.identity.commitSha = 'b'.repeat(40); },
    (s) => { s.identity.workerName = 'ss-dds-soak-gh-123456789-2-000000000000'; }, (s) => { s.identity.ownershipTag = 'a'.repeat(43); },
    (s) => { s.identity.noCollisionVerifiedAt = '2026-09-30T12:02:00.000Z'; },
    (s) => { s.deployment.endpoint = `https://${s.identity.workerName}.other.workers.dev`; },
    (s) => { s.deployment.workerVersionId = 'worker-v2'; }, (s) => { s.deployment.deploymentManifestVersion = 2; },
    (s) => { s.deployment.wranglerVersion = '4.34.0'; }, (s) => { s.deployment.buildId = '7'.repeat(64); },
    (s) => { s.deployment.localConfigurationSha256 = '7'.repeat(64); }, (s) => { s.deployment.scriptETag = 'other-etag'; },
    (s) => { s.deployment.versionConfigurationSha256 = '7'.repeat(64); }, (s) => { s.deployment.assets.wasmSha256 = '7'.repeat(64); },
    (s) => { s.deployment.assets.harnessSha256['workers/src/index.mjs'] = '7'.repeat(64); },
    (s) => { s.deployment.assets.harnessSha256['workers/src/extra.mjs'] = '7'.repeat(64); },
    (s) => { delete s.deployment.assets.harnessSha256['workers/src/index.mjs']; },
  ];
  for (const mutate of changes) {
    const changed = structuredClone(state); mutate(changed); saveState(stateDir, changed);
    assert.throws(() => m.validateInputState({ ...f.inputs, stateDir, segment: 1 }), /match|identity|deployment|version|name|ownership/i);
  }
  saveState(stateDir, state);
  for (const [field, value] of [['repository', 'Other/Stepstone'], ['workflow', 'Other Workflow'], ['runId', '123456790'], ['runAttempt', '3'], ['commitSha', 'b'.repeat(40)]]) {
    assert.throws(() => m.validateInputState({ ...f.inputs, context: { ...CONTEXT, [field]: value }, stateDir, segment: 1 }), /context|match/i);
  }
  const independent = structuredClone(f.inputs.deployment); independent.scriptETag = 'independently-changed';
  assert.throws(() => m.validateInputState({ ...f.inputs, deployment: independent, stateDir, segment: 1 }), /deployment|match/i);
  const identityModule = await import('../scripts/remote-dds-ci-identity.mjs');
  const otherTrusted = identityModule.deriveCiIdentity({ ...CONTEXT, secret: 'different-current-job-secret' });
  assert.throws(() => m.validateInputState({ ...f.inputs, trustedIdentity: otherTrusted, stateDir, segment: 1 }), /trusted|ownership|match/i);
});

test('state manifests reject unexpected fields, unsafe file names, incomplete files, and invalid dispositions', async (t) => {
  const f = await fixture(t); const m = await mod(); const state = m.createReadyState(f.inputs);
  for (const changed of [{ ...state, schemaVersion: 2 }, { ...state, kind: 'other' }, { ...state, extra: true }, { ...state, files: { '../journal.jsonl': '7'.repeat(64) } }, { ...state, disposition: 'PAUSED' }, { ...state, segment: 1, disposition: 'PAUSED', files: {} }]) {
    assert.throws(() => m.assertStateManifest(changed), /schema|kind|field|file|disposition|READY/i);
  }
});

test('finalize accepts only validated runner dispositions and requires every run file', async (t) => {
  const f = await fixture(t); const m = await mod(); const stateDir = join(f.root, 'state-0'); saveState(stateDir, m.createReadyState(f.inputs));
  for (const disposition of ['PAUSED', 'COMPLETE', 'FAILED']) {
    const runDir = makeRun(f.root, disposition);
    assert.equal(m.finalizeState({ ...f.inputs, stateDir, runDir, segment: 1 }).disposition, disposition);
    const resultPath = join(runDir, 'segment-result.json'); const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    for (const changed of [{ ...result, version: 2 }, { ...result, disposition: 'READY' }, { ...result, disposition: 'UNKNOWN' }, { ...result, extra: true }, { ...result, completedCursor: -1 }]) {
      writeFileSync(resultPath, JSON.stringify(changed));
      assert.throws(() => m.finalizeState({ ...f.inputs, stateDir, runDir, segment: 1 }), /segment.result|version|disposition|field|cursor/i);
    }
  }
  const missing = join(f.root, 'missing-run'); mkdirSync(missing);
  assert.throws(() => m.finalizeState({ ...f.inputs, stateDir, runDir: missing, segment: 1 }), /missing|file|ENOENT/i);
});

test('state CLI creates READY, finalizes exact run bytes atomically, and validates without a token', async (t) => {
  const f = await fixture(t); const readyDir = join(f.root, 'state-0');
  let result = runCli(['--create-ready', ...f.args, '--out', readyDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(readyDir), ['state-manifest.json']);
  result = runCli(['--validate-input', '--state', readyDir, ...f.args, '--segment', '1']);
  assert.equal(result.status, 0, result.stderr);
  const runDir = makeRun(f.root); writeFileSync(join(runDir, 'not-an-envelope-file.txt'), 'excluded');
  const nextDir = join(f.root, 'state-1');
  result = runCli(['--finalize', '--state-in', readyDir, '--run-dir', runDir, ...f.args, '--segment', '1', '--out', nextDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(nextDir).sort(), ['run', 'state-manifest.json']);
  assert.deepEqual(readdirSync(join(nextDir, 'run')).sort(), [...FILES].sort());
  for (const name of FILES) assert.deepEqual(readFileSync(join(nextDir, 'run', name)), readFileSync(join(runDir, name)));
  result = runCli(['--validate-input', '--state', nextDir, ...f.args, '--segment', '2']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(`${result.stdout}${result.stderr}`.includes('not-persisted'), false);
  writeFileSync(join(nextDir, 'run', 'journal.jsonl'), 'changed');
  result = runCli(['--validate-input', '--state', nextDir, ...f.args, '--segment', '2']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hash|bytes/i);
});

test('state CLI strictly rejects mixed modes, unknown/duplicate/missing parameters, and malformed segments before writing', async (t) => {
  const f = await fixture(t); const out = join(f.root, 'never-written'); const base = ['--create-ready', ...f.args, '--out', out];
  for (const args of [base.concat('--finalize'), base.concat('--create-ready'), base.concat('--unknown', 'x'), base.concat('--run-id', CONTEXT.runId), base.concat('--segment', '1'), base.slice(0, -1), f.args.concat('--out', out), ['--validate-input', ...f.args, '--state', out, '--segment', '01'], ['--finalize', ...f.args, '--state-in', out, '--run-dir', out, '--out', out, '--segment', '7']]) {
    const result = runCli(args); assert.notEqual(result.status, 0); assert.equal(existsSync(out), false);
    assert.match(result.stderr, /state CLI|segment/i);
    assert.equal(`${result.stdout}${result.stderr}`.includes('not-persisted'), false);
  }
});

test('all CLI modes bind fresh trusted identity to explicit GitHub context before producing any output', async (t) => {
  const f = await fixture(t); const out = join(f.root, 'never-written');
  const args = [...f.args]; args[args.indexOf('--run-attempt') + 1] = '3';
  for (const mode of [ ['--create-ready', '--out', out], ['--validate-input', '--state', join(f.root, 'missing'), '--segment', '1'], ['--finalize', '--state-in', join(f.root, 'missing'), '--run-dir', join(f.root, 'missing'), '--out', out, '--segment', '1'] ]) {
    const result = runCli([...mode, ...args]); assert.notEqual(result.status, 0); assert.match(result.stderr, /context|match/i); assert.equal(existsSync(out), false);
  }
});
