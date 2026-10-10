'use strict';

const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const YAML = require('yaml');

const ROOT = resolve(__dirname, '..');
const WORKFLOW_PATH = resolve(ROOT, '.github/workflows/remote-dds-soak.yml');
const CLEANUP_WORKFLOW_PATH = resolve(ROOT, '.github/workflows/remote-dds-soak-cleanup.yml');
const WINDOWS_DDS_WORKFLOW_PATH = resolve(ROOT, '.github/workflows/windows-dds-ci.yml');
const WINDOWS_DDS_BUILD_PATH = resolve(ROOT, 'scripts/build-windows-dds.ps1');
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE = 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1';
const UPLOAD = 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9';
const DOWNLOAD = 'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333';
const POWERSHELL = 'pwsh';
const APPROVED_ACTIONS = new Set([
  CHECKOUT,
  SETUP_NODE,
  UPLOAD,
  DOWNLOAD,
]);
const expression = (body) => '${{ ' + body + ' }}';
const artifact = (kind, suffix = '') => `remote-dds-${kind}-${expression('github.run_id')}-${expression('github.run_attempt')}${suffix}`;

function loadWorkflow() {
  const source = readFileSync(WORKFLOW_PATH, 'utf8');
  const workflow = YAML.parse(source);
  assert.ok(workflow && typeof workflow === 'object' && !Array.isArray(workflow), 'workflow must parse as a mapping');
  return { source, workflow };
}
function loadCleanupWorkflow() {
  const source = readFileSync(CLEANUP_WORKFLOW_PATH, 'utf8');
  const workflow = YAML.parse(source);
  assert.ok(workflow && typeof workflow === 'object' && !Array.isArray(workflow), 'cleanup workflow must parse as a mapping');
  return { source, workflow };
}
function loadWindowsDdsWorkflow() {
  const source = readFileSync(WINDOWS_DDS_WORKFLOW_PATH, 'utf8');
  const workflow = YAML.parse(source);
  assert.ok(workflow && typeof workflow === 'object' && !Array.isArray(workflow), 'Windows DDS workflow must parse as a mapping');
  return { source, workflow };
}
function steps(job) {
  assert.ok(Array.isArray(job?.steps), 'job must have steps');
  return job.steps;
}
function uploads(workflow) {
  return Object.values(workflow.jobs).flatMap((job) => steps(job).filter((step) => step.uses === UPLOAD));
}
function downloads(workflow) {
  return Object.values(workflow.jobs).flatMap((job) => steps(job).filter((step) => step.uses === DOWNLOAD));
}
function runText(step) { return typeof step?.run === 'string' ? step.run : ''; }
function findRun(job, pattern) {
  const found = steps(job).find((step) => pattern.test(runText(step)) || pattern.test(step.name ?? ''));
  assert.ok(found, `missing run step matching ${pattern}`);
  return found;
}
function stepIndex(job, pattern) {
  const index = steps(job).findIndex((step) => pattern.test(runText(step)) || pattern.test(step.name ?? ''));
  assert.notEqual(index, -1, `missing step matching ${pattern}`);
  return index;
}
function exactContext(command) {
  for (const [flag, value] of [
    ['--repository', expression('github.repository')],
    ['--workflow', 'Remote DDS Soak'],
    ['--run-id', expression('github.run_id')],
    ['--run-attempt', expression('github.run_attempt')],
    ['--commit-sha', expression('github.sha')],
  ]) {
    const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(command, new RegExp(`${escapedFlag}[^\\r\\n]{0,24}${escapedValue}`));
  }
}

test('manual entry point, permissions, concurrency, and action pins are locked down', () => {
  const { workflow } = loadWorkflow();
  assert.equal(workflow.name, 'Remote DDS Soak');
  assert.equal(workflow['run-name'], `Remote DDS Soak ${expression('inputs.request_id')}`);
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.on.workflow_dispatch, { inputs: { request_id: { description: 'Unique request identifier', required: true, type: 'string' } } });
  assert.deepEqual(workflow.concurrency, { group: 'stepstone-remote-dds-soak', 'cancel-in-progress': false, queue: 'max' });
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' });
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job['runs-on'], 'windows-2022');
    assert.equal(job.permissions, undefined, 'jobs may not broaden workflow permissions');
    for (const step of steps(job)) if (step.uses !== undefined) assert.ok(APPROVED_ACTIONS.has(step.uses), `unapproved action: ${step.uses}`);
  }
  assert.equal(workflow.jobs.prepare['timeout-minutes'], 30);
  assert.equal(workflow.jobs.cleanup['timeout-minutes'], 20);
});

test('all remote soak jobs use the Wrangler-supported Node.js 22 runtime', () => {
  for (const [workflowName, workflow, expectedSetupCount] of [
    ['primary', loadWorkflow().workflow, 9],
    ['cleanup backstop', loadCleanupWorkflow().workflow, 1],
  ]) {
    const setups = Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
      steps(job)
        .filter((step) => step.uses === SETUP_NODE)
        .map((step) => ({ jobName, step })),
    );
    assert.equal(setups.length, expectedSetupCount, `${workflowName} setup-node coverage changed`);
    for (const { jobName, step } of setups) {
      assert.equal(step.with?.['node-version'], 22, `${workflowName} ${jobName} must use Node.js 22`);
    }
  }
});

test('embedded workflow contract harnesses execute under PowerShell 7', () => {
  assert.equal(POWERSHELL, 'pwsh');
  assert.doesNotMatch(readFileSync(__filename, 'utf8'), /powershell\.exe/i);
});

test('no-secret Windows DDS gate runs the exact native and focused verification sequence', () => {
  const { source, workflow } = loadWindowsDdsWorkflow();
  assert.equal(workflow.name, 'Windows DDS CI');
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push']);
  assert.deepEqual(workflow.on.push, { branches: ['master'] });
  assert.equal(workflow.on.pull_request, null);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['verify']);

  const job = workflow.jobs.verify;
  assert.equal(job['runs-on'], 'windows-2022');
  assert.equal(job['timeout-minutes'], 30);
  assert.equal(job.permissions, undefined);
  const checkout = steps(job).find((step) => step.uses === CHECKOUT);
  assert.equal(checkout?.with?.submodules, 'recursive');
  const setup = steps(job).find((step) => step.uses === SETUP_NODE);
  assert.equal(setup?.with?.['node-version'], 22);
  for (const step of steps(job)) if (step.uses !== undefined) assert.ok(new Set([CHECKOUT, SETUP_NODE]).has(step.uses), `unapproved native gate action: ${step.uses}`);

  assert.deepEqual(steps(job).filter((step) => step.run !== undefined).map((step) => runText(step).trim()), [
    'npm ci',
    './scripts/build-windows-dds.ps1',
    'npm run test:dds:smoke',
    'npm run test:commands',
    'node --test test/remote-dds-deployment-runner.test.js test/remote-dds-cleanup.test.js test/remote-dds-workflow-contract.test.js test/assert-remote-soak-prerequisites.test.js test/gitattributes-contract.test.js',
  ]);
  assert.doesNotMatch(source, /secrets\.|CLOUDFLARE_|DDS_REMOTE_TEST_KEY|wrangler\s+deploy|prepare-remote-dds-deployment|cleanup-remote-dds-deployment|deleteExactWorker|disableWorkersDevSubdomain/i);
});

test('native DDS jobs initialize the pinned submodule and build both CLI baselines before use', () => {
  const { workflow } = loadWorkflow();
  const nativeJobs = ['prepare', ...Array.from({ length: 6 }, (_, index) => `segment-${index + 1}`)];

  for (const jobName of nativeJobs) {
    const job = workflow.jobs[jobName];
    const checkout = steps(job).find((step) => step.uses === CHECKOUT);
    assert.equal(checkout?.with?.submodules, 'recursive', `${jobName} must initialize the pinned DDS submodule`);

    const install = stepIndex(job, /^npm ci$/m);
    const build = stepIndex(job, /scripts[\\/]build-windows-dds\.ps1/);
    const smoke = stepIndex(job, /^npm run test:dds:smoke$/m);
    const consumer = jobName === 'prepare'
      ? stepIndex(job, /^npm test$/m)
      : stepIndex(job, /remote-worker-dds-soak\.mjs/);
    assert.ok(install < build && build < smoke && smoke < consumer, `${jobName} must build and smoke DDS before consuming it`);
  }

  for (const jobName of ['gate', 'cleanup']) {
    const job = workflow.jobs[jobName];
    assert.equal(steps(job).some((step) => /build-windows-dds\.ps1/.test(runText(step))), false);
  }

  const buildSource = readFileSync(WINDOWS_DDS_BUILD_PATH, 'utf8');
  assert.match(buildSource, /vswhere\.exe/i);
  assert.match(buildSource, /Microsoft\.VisualStudio\.Component\.VC\.Tools\.x86\.x64/);
  assert.match(buildSource, /solution[\\/]DDS\.vcxproj/i);
  assert.match(buildSource, /native[\\/]dds-cli[\\/]dds_calc\.cpp/i);
  assert.match(buildSource, /native[\\/]dds-cli[\\/]dds_solve\.cpp/i);
  assert.match(buildSource, /\/MD(?:['"\s,]|$)/);
  assert.match(buildSource, /dds_calc\.exe/i);
  assert.match(buildSource, /dds_solve\.exe/i);
});

test('prepare proves the repository before authorizing and recording deployment', () => {
  const { workflow } = loadWorkflow();
  const prepare = workflow.jobs.prepare;
  assert.ok(prepare);
  const install = stepIndex(prepare, /^npm ci$/m);
  const commandPreflight = stepIndex(prepare, /^npm run test:commands$/m);
  const build = stepIndex(prepare, /scripts[\\/]build-windows-dds\.ps1/);
  const unit = stepIndex(prepare, /^npm test$/m);
  const workers = stepIndex(prepare, /^npm run test:workers$/m);
  const smoke = stepIndex(prepare, /^npm run test:dds:smoke$/m);
  const preflight = stepIndex(prepare, /--preflight/);
  const identityUpload = steps(prepare).findIndex((step) => step.uses === UPLOAD && step.with?.name === artifact('identity'));
  const deploy = stepIndex(prepare, /--deploy-from-identity/);
  const ready = stepIndex(prepare, /--create-ready/);
  assert.ok(install < commandPreflight && commandPreflight < build && build < smoke && smoke < unit && unit < workers && workers < preflight && preflight < identityUpload && identityUpload < deploy && deploy < ready);
  const derive = findRun(prepare, /remote-dds-ci-identity\.mjs/);
  exactContext(derive.run);
  assert.match(derive.run, /--identity-out\s+"?\$env:RUNNER_TEMP[\\/]remote-dds-trusted-identity\.json"?/i);
  assert.equal(derive.env.CLOUDFLARE_API_TOKEN, expression('secrets.CLOUDFLARE_API_TOKEN'));
  assert.match(derive.run, /--github-env\s+"?\$env:GITHUB_ENV"?/i);
  const identity = steps(prepare)[identityUpload];
  assert.deepEqual(identity.with, { name: artifact('identity'), path: 'identity/predeployment-identity.json', 'if-no-files-found': 'error', 'retention-days': 7 });
  const state = steps(prepare).find((step) => step.uses === UPLOAD && step.with?.name === artifact('state', '-0'));
  assert.deepEqual(state.with, { name: artifact('state', '-0'), path: 'state-0', 'if-no-files-found': 'error', 'retention-days': 7 });
});

test('six fixed-budget segments enforce trusted predecessor lineage', () => {
  const { workflow } = loadWorkflow();
  const expectedJobs = ['prepare', ...Array.from({ length: 6 }, (_, index) => `segment-${index + 1}`), 'gate', 'cleanup'];
  assert.deepEqual(Object.keys(workflow.jobs), expectedJobs);
  for (let segment = 1; segment <= 6; segment++) {
    const job = workflow.jobs[`segment-${segment}`];
    const predecessor = segment === 1 ? 'prepare' : `segment-${segment - 1}`;
    assert.equal(job.needs, predecessor);
    const predecessorResult = predecessor === 'prepare' ? 'needs.prepare.result' : `needs['${predecessor}'].result`;
    assert.equal(job.if, expression(`${predecessorResult} == 'success'`));
    assert.equal(job['timeout-minutes'], 355);
    const derive = findRun(job, /remote-dds-ci-identity\.mjs/);
    exactContext(derive.run);
    assert.match(derive.run, /--identity-out\s+"?\$env:RUNNER_TEMP[\\/]remote-dds-trusted-identity\.json"?/i);
    const jobDownloads = steps(job).filter((step) => step.uses === DOWNLOAD);
    assert.deepEqual(jobDownloads.map((step) => step.with), [
      { name: artifact('identity'), path: 'identity' },
      { name: artifact('deployment'), path: 'deployment' },
      { name: artifact('state', `-${segment - 1}`), path: `state-${segment - 1}` },
    ]);
    const validate = findRun(job, /--validate-input/);
    exactContext(validate.run);
    for (const fragment of [`--segment ${segment}`, `--state "state-${segment - 1}"`, '--trusted-identity "$env:RUNNER_TEMP\\remote-dds-trusted-identity.json"', '--identity "identity\\predeployment-identity.json"', '--deployment "deployment\\deployment.json"']) assert.ok(validate.run.includes(fragment), `segment ${segment} validation missing ${fragment}`);
    const runner = findRun(job, /remote-worker-dds-soak\.mjs/);
    assert.equal(runner['continue-on-error'], true);
    assert.match(runner.run, /--max-new-operations 6000\s+--deadline-ms 17100000/);
    assert.equal(runner.env?.CLOUDFLARE_API_TOKEN, undefined);
    const finalize = findRun(job, /--finalize/);
    assert.equal(finalize.if, expression('always()'));
    exactContext(finalize.run);
    for (const fragment of [`--segment ${segment}`, `--state-in "state-${segment - 1}"`, `--out "state-${segment}"`]) assert.ok(finalize.run.includes(fragment));
    const output = steps(job).find((step) => step.uses === UPLOAD);
    assert.equal(output.if, expression('always()'));
    assert.deepEqual(output.with, { name: artifact('state', `-${segment}`), path: `state-${segment}`, 'if-no-files-found': 'error', 'retention-days': 7 });
    const rethrow = steps(job).at(-1);
    assert.equal(rethrow.if, expression("always() && steps.runner.outcome == 'failure'"));
  }
});

test('gate consumes only state-6 and publishes fixed failure-safe evidence', () => {
  const { workflow } = loadWorkflow();
  const gate = workflow.jobs.gate;
  assert.equal(gate.needs, 'segment-6');
  assert.equal(gate.if, expression("needs['segment-6'].result == 'success'"));
  assert.deepEqual(steps(gate).filter((step) => step.uses === DOWNLOAD).map((step) => step.with), [
    { name: artifact('deployment'), path: 'deployment' },
    { name: artifact('state', '-6'), path: 'state-6' },
  ]);
  const checker = findRun(gate, /check-remote-worker-dds-gates\.mjs/);
  assert.equal(checker['continue-on-error'], true);
  assert.match(checker.run, /--run-dir\s+"state-6\\run"/);
  assert.match(checker.run, /--deployment-manifest\s+"deployment\\deployment\.json"/);
  assert.match(checker.run, /--simulator-report\s+"gate\\simulator-report\.json"/);
  assert.match(checker.run, /--out\s+"gate\\gate-result\.json"/);
  assert.match(checker.run, />\s*"gate\\stdout\.log"\s+2>\s*"gate\\stderr\.log"/);
  const build = findRun(gate, /final-evidence/);
  assert.equal(build.if, expression('always()'));
  assert.equal(build['continue-on-error'], true);
  for (const path of ['deployment/deployment.json', 'state-6/state-manifest.json', 'state-6/run/manifest.json', 'state-6/run/journal.jsonl', 'state-6/run/report.json', 'state-6/run/evidence.json', 'state-6/run/segment-result.json', 'gate/gate-result.json', 'gate/simulator-report.json', 'gate/stdout.log', 'gate/stderr.log']) assert.ok(build.run.replaceAll('\\', '/').includes(path), `missing final evidence path ${path}`);
  const upload = steps(gate).find((step) => step.uses === UPLOAD);
  assert.equal(upload.if, expression('always()'));
  assert.deepEqual(upload.with, { name: artifact('final-evidence'), path: 'final-evidence', 'if-no-files-found': 'error', 'retention-days': 30 });
  assert.match(steps(gate).at(-1).if, /steps\.(checker|evidence|upload_evidence)\.outcome == 'failure'/);
});

test('final-evidence builder preserves every available file before reporting missing evidence', () => {
  const { workflow } = loadWorkflow();
  const build = findRun(workflow.jobs.gate, /final-evidence/);
  const root = mkdtempSync(join(tmpdir(), 'remote-dds-final-evidence-'));
  const available = [
    'deployment/deployment.json', 'state-6/state-manifest.json', 'state-6/run/manifest.json',
    'state-6/run/journal.jsonl', 'state-6/run/report.json', 'state-6/run/evidence.json',
    'state-6/run/segment-result.json', 'gate/simulator-report.json', 'gate/stdout.log', 'gate/stderr.log',
  ];
  try {
    for (const path of available) {
      const absolute = join(root, ...path.split('/'));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, `evidence:${path}`);
    }
    const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', build.run], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    for (const path of available) {
      const copied = join(root, 'final-evidence', ...path.split('/'));
      assert.equal(existsSync(copied), true, `available evidence was not preserved: ${path}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('artifact names, retention, and download cardinality are exact', () => {
  const { workflow } = loadWorkflow();
  const expected = [artifact('identity'), artifact('deployment'), ...Array.from({ length: 7 }, (_, index) => artifact('state', `-${index}`)), artifact('final-evidence'), artifact('primary-cleanup')];
  const actual = uploads(workflow).map((step) => step.with?.name);
  assert.deepEqual(actual.sort(), expected.sort());
  for (const upload of uploads(workflow)) {
    assert.equal(upload.with['if-no-files-found'], 'error');
    assert.equal(upload.with['retention-days'], /(?:final-evidence|primary-cleanup)/.test(upload.with.name) ? 30 : 7);
  }
  for (const download of downloads(workflow)) {
    assert.deepEqual(Object.keys(download.with).sort(), ['name', 'path']);
    assert.ok(expected.includes(download.with.name));
  }
});

test('cleanup lists artifacts before secret use and covers authorized and absent schemas', () => {
  const { workflow } = loadWorkflow();
  const cleanup = workflow.jobs.cleanup;
  assert.equal(cleanup.if, expression('always()'));
  assert.deepEqual(cleanup.needs, ['prepare', 'segment-1', 'segment-2', 'segment-3', 'segment-4', 'segment-5', 'segment-6', 'gate']);
  const listing = findRun(cleanup, /actions\/runs\/\$\{env:GITHUB_RUN_ID\}\/artifacts/);
  assert.equal(listing.env.CLOUDFLARE_API_TOKEN, undefined);
  const listIndex = steps(cleanup).indexOf(listing);
  assert.equal(listIndex, 0, 'artifact inventory must precede checkout, install, and all secret-bearing work');
  const secretIndexes = steps(cleanup).flatMap((step, index) => step.env?.CLOUDFLARE_API_TOKEN === expression('secrets.CLOUDFLARE_API_TOKEN') ? [index] : []);
  assert.ok(secretIndexes.length > 0 && secretIndexes.every((index) => index > listIndex));
  const absent = findRun(cleanup, /no-deployment-authorized/);
  for (const field of ['version', 'status', 'repository', 'workflow', 'runId', 'runAttempt', 'commitSha', 'workerName', 'subdomainDisabled', 'objectDeleted', 'currentAbsent', 'legacyAbsent', 'failureCode']) assert.match(absent.run, new RegExp(`['\"]?${field}['\"]?\\s*=`));
  assert.match(absent.run, /version\s*=\s*2/);
  assert.match(absent.run, /workerName\s*=\s*\$null/);
  assert.match(absent.run, /subdomainDisabled\s*=\s*\$false/);
  assert.match(absent.run, /objectDeleted\s*=\s*\$false/);
  assert.match(absent.run, /currentAbsent\s*=\s*\$true/);
  assert.match(absent.run, /legacyAbsent\s*=\s*\$true/);
  assert.match(absent.run, /failureCode\s*=\s*\$null/);
  const cleanupCli = findRun(cleanup, /cleanup-remote-dds-deployment\.mjs/);
  exactContext(cleanupCli.run);
  assert.equal(cleanupCli['continue-on-error'], true);
  const resultText = runText(findRun(cleanup, /Ensure cleanup result/));
  for (const field of ['version', 'status', 'repository', 'workflow', 'runId', 'runAttempt', 'commitSha', 'workerName', 'subdomainDisabled', 'objectDeleted', 'currentAbsent', 'legacyAbsent', 'failureCode']) assert.match(resultText, new RegExp(`['\"]?${field}['\"]?`));
  assert.match(resultText, /Compare-Object/);
  assert.match(resultText, /version\s*-ne\s*2/);
  assert.match(resultText, /CLEANUP_RESULT_WRITE_FAILED/);
  assert.match(resultText, /CLEANUP_FINAL_ABSENCE_TIMEOUT/);
  const upload = steps(cleanup).find((step) => step.uses === UPLOAD);
  assert.equal(upload.if, expression('always()'));
  assert.deepEqual(upload.with, { name: artifact('primary-cleanup'), path: 'cleanup/cleanup-result.json', 'if-no-files-found': 'error', 'retention-days': 30 });
});

test('cleanup inventories every attempt and fails closed when a prior attempt authorized deployment', () => {
  const { workflow } = loadWorkflow();
  const cleanup = workflow.jobs.cleanup;
  const inventory = steps(cleanup)[0];
  assert.match(runText(inventory), /do\s*\{/i, 'artifact inventory must paginate');
  assert.match(runText(inventory), /[?&]per_page=100&page=\$page/i);
  assert.match(runText(inventory), /remote-dds-identity-\$env:GITHUB_RUN_ID-\(\?<attempt>\\d\+\)/);
  assert.match(runText(inventory), /remote-dds-deployment-\$env:GITHUB_RUN_ID-\(\?<attempt>\\d\+\)/);
  for (const output of ['identity-count', 'deployment-count', 'prior-identity-count', 'prior-deployment-count']) {
    assert.match(runText(inventory), new RegExp(`['"]?${output}=`));
  }
  const reject = findRun(cleanup, /Reject ambiguous cleanup authorization/);
  assert.match(runText(reject), /prior-(?:identity|deployment)-count/);
  assert.match(runText(reject), /identity-count[^\r\n]*-eq 0/, 'prior-attempt evidence must only reject early when the current identity is absent');
  assert.match(runText(reject), /restore|rollback|backstop/i, 'failure must explain how cleanup can be recovered');
  const absent = findRun(cleanup, /no-deployment-authorized/);
  assert.match(absent.if, /identity-count == '0'/);
  assert.match(absent.if, /prior-identity-count == '0'/);
  assert.match(absent.if, /prior-deployment-count == '0'/);
  const result = findRun(cleanup, /Ensure cleanup result/);
  const cleanupWorker = findRun(cleanup, /Clean exact authorized temporary Worker/);
  const upload = steps(cleanup).find((step) => step.uses === UPLOAD);
  const finalFailure = steps(cleanup).at(-1);
  assert.equal(result.if, expression('always()'));
  assert.equal(upload.if, expression('always()'));
  assert.match(cleanupWorker.if, /identity-count == '1'/);
  assert.doesNotMatch(cleanupWorker.if, /prior-/, 'prior evidence must not suppress cleanup of the current exact Worker');
  assert.ok(steps(cleanup).indexOf(cleanupWorker) < steps(cleanup).indexOf(upload), 'current cleanup result must upload before prior-attempt failure propagation');
  assert.match(finalFailure.if, /steps\.reject\.outcome == 'failure'/);
  assert.match(finalFailure.if, /identity-count == '1'/, 'a present current identity must still fail finally when prior evidence remains');
  assert.match(finalFailure.if, /prior-identity-count != '0'/);
  assert.match(finalFailure.if, /prior-deployment-count != '0'/);
  assert.match(runText(finalFailure), /prior-attempt/i);
  assert.match(runText(finalFailure), /recover|backstop/i, 'final failure must direct operators to prior-attempt recovery');
});

test('Cloudflare token is step-scoped to derivation, deployment, and cleanup only', () => {
  const { source, workflow } = loadWorkflow();
  assert.equal(workflow.env?.CLOUDFLARE_API_TOKEN, undefined);
  const tokenSteps = [];
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.env?.CLOUDFLARE_API_TOKEN, undefined);
    for (const step of steps(job)) {
      const token = step.env?.CLOUDFLARE_API_TOKEN;
      if (token !== undefined) {
        assert.equal(token, expression('secrets.CLOUDFLARE_API_TOKEN'));
        assert.match(runText(step), /remote-dds-ci-identity\.mjs|prepare-remote-dds-deployment\.mjs|cleanup-remote-dds-deployment\.mjs/);
        tokenSteps.push(step);
      }
      if (/remote-worker-dds-soak\.mjs|remote-dds-ci-state\.mjs|check-remote-worker-dds-gates\.mjs|Compress-Archive|final-evidence/i.test(runText(step)) || [UPLOAD, DOWNLOAD].includes(step.uses)) assert.equal(token, undefined, `${jobName}/${step.name} may not receive the Cloudflare token`);
    }
  }
  assert.equal((source.match(/secrets\.CLOUDFLARE_API_TOKEN/g) ?? []).length, tokenSteps.length, 'secret references must only occur in step env maps');
});

test('the exported remote key is masked from every later step that does not consume it', () => {
  const { workflow } = loadWorkflow();
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    const deriveIndex = steps(job).findIndex((step) => /remote-dds-ci-identity\.mjs[^\r\n]*--derive/.test(runText(step)));
    if (deriveIndex === -1) continue;
    for (const step of steps(job).slice(deriveIndex + 1)) {
      const consumesKey = jobName === 'prepare'
        ? /prepare-remote-dds-deployment\.mjs[^\r\n]*--deploy-from-identity/.test(runText(step))
        : /^segment-\d+$/.test(jobName) && /remote-worker-dds-soak\.mjs/.test(runText(step));
      if (consumesKey) {
        assert.notEqual(step.env?.DDS_REMOTE_TEST_KEY, '', `${jobName}/${step.name} must receive the derived key`);
      } else if (step.run !== undefined || step.uses !== undefined) {
        assert.equal(step.env?.DDS_REMOTE_TEST_KEY, '', `${jobName}/${step.name} must mask the exported key`);
      }
    }
  }
});

const cleanupExpression = (body) => '${{ ' + body + ' }}';
const cleanupArtifact = (kind) => `remote-dds-${kind}-${cleanupExpression('github.event.workflow_run.id')}-${cleanupExpression('github.event.workflow_run.run_attempt')}`;
const cleanupBackstopArtifact = () => `${cleanupArtifact('backstop-cleanup')}-${cleanupExpression('github.run_attempt')}`;
const CLEANUP_TRUSTED = cleanupExpression('runner.temp') + '/remote-dds-trusted';
const CLEANUP_UNTRUSTED = cleanupExpression('runner.temp') + '/remote-dds-untrusted/'
  + cleanupExpression('github.event.workflow_run.id') + '/' + cleanupExpression('github.event.workflow_run.run_attempt');

function cleanupJob(workflow) {
  assert.deepEqual(Object.keys(workflow.jobs), ['cleanup'], 'backstop must have one cleanup job');
  return workflow.jobs.cleanup;
}

function cleanupStep(job, id) {
  const step = steps(job).find((candidate) => candidate.id === id);
  assert.ok(step, `missing cleanup step ${id}`);
  return step;
}

function executeCleanupInventory(inventory, { runId, runAttempt, artifactNames }) {
  const root = mkdtempSync(join(tmpdir(), 'remote-dds-backstop-inventory-'));
  const output = join(root, 'github-output.txt');
  const script = runText(inventory)
    .replaceAll(cleanupExpression('github.event.workflow_run.id'), runId)
    .replaceAll(cleanupExpression('github.event.workflow_run.run_attempt'), runAttempt);
  const harness = `
function global:Invoke-RestMethod {
  param($Headers, $Uri)
  $parsedNames = ConvertFrom-Json -InputObject $env:ARTIFACT_NAMES_JSON
  $names = @($parsedNames)
  [pscustomobject]@{ artifacts = @($names | ForEach-Object { [pscustomobject]@{ name = [string]$_ } }) }
}
${script}`;
  try {
    const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', harness], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ARTIFACT_NAMES_JSON: JSON.stringify(artifactNames),
        GITHUB_OUTPUT: output,
        GITHUB_TOKEN: 'contract-test-token',
        PRIMARY_REPOSITORY: 'owner/repository',
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const bytes = readFileSync(output);
    const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
    return Object.fromEntries(text.trim().split(/\r?\n/).map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function exactCleanupContext(command) {
  for (const [flag, value] of [
    ['--repository', cleanupExpression('github.event.repository.full_name')],
    ['--workflow', 'Remote DDS Soak'],
    ['--run-id', cleanupExpression('github.event.workflow_run.id')],
    ['--run-attempt', cleanupExpression('github.event.workflow_run.run_attempt')],
    ['--commit-sha', cleanupExpression('github.event.workflow_run.head_sha')],
  ]) {
    const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(command, new RegExp(`${escapedFlag}[^\\r\\n]{0,32}${escapedValue}`));
  }
}

test('backstop is completed-workflow-only with minimum permissions and pinned actions', () => {
  const { workflow } = loadCleanupWorkflow();
  assert.equal(workflow['run-name'], `Cleanup primary ${cleanupExpression('github.event.workflow_run.id')} attempt ${cleanupExpression('github.event.workflow_run.run_attempt')}`);
  assert.deepEqual(Object.keys(workflow.on), ['workflow_run']);
  assert.deepEqual(workflow.on.workflow_run, { workflows: ['Remote DDS Soak'], types: ['completed'] });
  for (const forbidden of ['push', 'pull_request', 'schedule', 'workflow_dispatch']) assert.equal(workflow.on[forbidden], undefined);
  assert.deepEqual(workflow.permissions, { actions: 'read', contents: 'read' });
  const job = cleanupJob(workflow);
  assert.equal(job['runs-on'], 'windows-2022');
  assert.equal(job['timeout-minutes'], 20);
  assert.equal(job.permissions, undefined, 'job may not broaden workflow permissions');
  for (const step of steps(job)) {
    if (step.uses !== undefined) assert.ok(APPROVED_ACTIONS.has(step.uses), `unapproved action: ${step.uses}`);
  }
});

test('backstop inventories first and isolates trusted code from untrusted artifacts', () => {
  const { source, workflow } = loadCleanupWorkflow();
  const job = cleanupJob(workflow);
  const inventory = cleanupStep(job, 'inventory');
  const checkoutIndex = steps(job).findIndex((step) => step.uses === CHECKOUT);
  const moveIndex = steps(job).findIndex((step) => /Move-Item/.test(runText(step)) && /remote-dds-trusted/.test(runText(step)));
  const downloadIndexes = steps(job).flatMap((step, index) => step.uses === DOWNLOAD ? [index] : []);
  assert.equal(steps(job).indexOf(inventory), 0, 'token-free inventory must be the first step');
  assert.ok(checkoutIndex > 0 && moveIndex > checkoutIndex);
  assert.ok(downloadIndexes.length >= 1 && downloadIndexes.every((index) => index > moveIndex), 'trusted checkout must move before downloads');
  const checkout = steps(job)[checkoutIndex];
  assert.equal(checkout.with.ref, cleanupExpression('github.event.repository.default_branch'));
  assert.equal(checkout.with.path, 'remote-dds-trusted-staging');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.doesNotMatch(JSON.stringify(checkout), /head_sha|workflow_run\.head_repository|workflow_run\.repository|github\.sha/);
  assert.match(runText(steps(job)[moveIndex]), /GITHUB_WORKSPACE[\\/]remote-dds-trusted-staging/i);
  assert.match(runText(steps(job)[moveIndex]), /RUNNER_TEMP[\\/]remote-dds-trusted/i);
  const install = cleanupStep(job, 'install');
  assert.equal(install['working-directory'], CLEANUP_TRUSTED);
  const setup = steps(job).find((step) => step.uses === SETUP_NODE);
  assert.equal(setup.with['node-version'], 22);
  for (const download of steps(job).filter((step) => step.uses === DOWNLOAD)) {
    assert.ok(download.with.path.startsWith(CLEANUP_UNTRUSTED + '/'), `download escaped untrusted root: ${download.with.path}`);
    assert.equal(download.with.path.includes('remote-dds-trusted'), false);
  }
  assert.equal(source.includes(CLEANUP_UNTRUSTED + '/../'), false);
  assert.doesNotMatch(source, /github\.event\.workflow_run\.repository\.default_branch|github\.repository|GITHUB_REPOSITORY/);
});

test('backstop inventory derives exact current-attempt authorization and no-deployment evidence from the event', () => {
  const { workflow } = loadCleanupWorkflow();
  const job = cleanupJob(workflow);
  const inventory = cleanupStep(job, 'inventory');
  assert.equal(inventory.env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(inventory.env.CLOUDFLARE_ACCOUNT_ID, undefined);
  assert.equal(inventory.env.GITHUB_TOKEN, cleanupExpression('github.token'));
  assert.equal(inventory.env.PRIMARY_REPOSITORY, cleanupExpression('github.event.repository.full_name'));
  assert.match(runText(inventory), /repos\/\$env:PRIMARY_REPOSITORY\/actions\/runs/);
  assert.match(runText(inventory), /github\.event\.workflow_run\.id/);
  assert.match(runText(inventory), /github\.event\.workflow_run\.run_attempt/);
  assert.match(runText(inventory), /actions\/runs\/.+\/artifacts\?per_page=100&page=\$page/);
  assert.match(runText(inventory), /do\s*\{/i);
  assert.match(runText(inventory), /while\s*\(\$batch\.Count\s*-eq\s*100\)/i);
  assert.match(runText(inventory), /remote-dds-identity-\$runId-\$runAttempt/);
  assert.match(runText(inventory), /remote-dds-deployment-\$runId-\$runAttempt/);
  for (const output of ['identity-count', 'deployment-count', 'unexpected-count']) assert.match(runText(inventory), new RegExp(`['"]?${output}=`));
  const authorize = cleanupStep(job, 'authorize');
  assert.equal(authorize['continue-on-error'], true);
  assert.match(runText(authorize), /identity-count/);
  assert.match(runText(authorize), /deployment-count/);
  assert.match(runText(authorize), /unexpected-count/);
  assert.match(runText(authorize), /\$identityCount\s+-gt\s+1/i);
  assert.match(runText(authorize), /\$deploymentCount\s+-gt\s+1/i);
  assert.match(runText(authorize), /\$identityCount\s+-eq\s+0[^\r\n]*\$deploymentCount\s+-gt\s+0/i);
  const absent = cleanupStep(job, 'no_deployment');
  assert.match(absent.if, /steps\.inventory\.outcome == 'success'/);
  assert.match(absent.if, /steps\.authorize\.outcome == 'success'/);
  assert.match(absent.if, /identity-count == '0'/);
  assert.match(absent.if, /deployment-count == '0'/);
  assert.match(absent.if, /unexpected-count == '0'/);
  assert.equal(absent.env?.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(absent.env?.CLOUDFLARE_ACCOUNT_ID, undefined);
  for (const [field, value] of [
    ['version', '2'], ['status', "'no-deployment-authorized'"], ['repository', `'${cleanupExpression('github.event.repository.full_name')}'`],
    ['workflow', "'Remote DDS Soak'"], ['runId', `'${cleanupExpression('github.event.workflow_run.id')}'`],
    ['runAttempt', `'${cleanupExpression('github.event.workflow_run.run_attempt')}'`],
    ['commitSha', `'${cleanupExpression('github.event.workflow_run.head_sha')}'`], ['workerName', '$null'],
    ['subdomainDisabled', '$false'], ['objectDeleted', '$false'], ['currentAbsent', '$true'], ['legacyAbsent', '$true'], ['failureCode', '$null'],
  ]) assert.ok(runText(absent).includes(`${field} = ${value}`), `no-deployment result has wrong ${field}`);
});

test('backstop inventory ignores canonical prior attempts but rejects malformed or cross-run authorization names', () => {
  const { workflow } = loadCleanupWorkflow();
  const inventory = cleanupStep(cleanupJob(workflow), 'inventory');
  const runId = '424242';
  const runAttempt = '2';
  const currentIdentity = `remote-dds-identity-${runId}-${runAttempt}`;
  const currentDeployment = `remote-dds-deployment-${runId}-${runAttempt}`;
  const withPrior = executeCleanupInventory(inventory, {
    runId,
    runAttempt,
    artifactNames: [
      `remote-dds-identity-${runId}-1`,
      `remote-dds-deployment-${runId}-1`,
      currentIdentity,
      currentDeployment,
      `remote-dds-primary-cleanup-${runId}-1`,
      `remote-dds-backstop-cleanup-${runId}-1-1`,
    ],
  });
  assert.deepEqual(withPrior, {
    'identity-count': '1',
    'deployment-count': '1',
    'ignored-count': '2',
    'unexpected-count': '0',
  });

  const invalidNames = [
    'remote-dds-identity-424243-1',
    'remote-dds-deployment-424243-1',
    `remote-dds-identity-${runId}-0`,
    `remote-dds-deployment-${runId}-00`,
    `remote-dds-identity-${runId}-02`,
    `remote-dds-deployment-${runId}-x`,
    `remote-dds-identity-${runId}-${runAttempt}-extra`,
    `remote-dds-deployment-alias-${runId}-${runAttempt}`,
    `REMOTE-DDS-IDENTITY-${runId}-1`,
  ];
  const malformed = executeCleanupInventory(inventory, {
    runId,
    runAttempt,
    artifactNames: [currentIdentity, currentDeployment, ...invalidNames],
  });
  assert.deepEqual(malformed, {
    'identity-count': '1',
    'deployment-count': '1',
    'ignored-count': '0',
    'unexpected-count': String(invalidNames.length),
  });

  const duplicate = executeCleanupInventory(inventory, {
    runId,
    runAttempt,
    artifactNames: [currentIdentity, currentIdentity],
  });
  assert.equal(duplicate['identity-count'], '2');
  assert.match(runText(cleanupStep(cleanupJob(workflow), 'authorize')), /\$identityCount\s+-gt\s+1/i);
});

test('backstop downloads only exact triggering-run artifacts into the untrusted root', () => {
  const { workflow } = loadCleanupWorkflow();
  const job = cleanupJob(workflow);
  const identity = cleanupStep(job, 'download_identity');
  const deployment = cleanupStep(job, 'download_deployment');
  assert.deepEqual(identity.with, {
    name: cleanupArtifact('identity'),
    path: CLEANUP_UNTRUSTED + '/identity',
    'run-id': cleanupExpression('github.event.workflow_run.id'),
    'github-token': cleanupExpression('github.token'),
  });
  assert.deepEqual(deployment.with, {
    name: cleanupArtifact('deployment'),
    path: CLEANUP_UNTRUSTED + '/deployment',
    'run-id': cleanupExpression('github.event.workflow_run.id'),
    'github-token': cleanupExpression('github.token'),
  });
  assert.match(identity.if, /identity-count == '1'/);
  assert.match(deployment.if, /deployment-count == '1'/);
  assert.doesNotMatch(JSON.stringify([identity.with, deployment.with]), /steps\.inventory\.outputs\.(?:identity|deployment)-name|newest|pattern|merge-multiple/i);
});

test('backstop recomputes ownership with trusted code and scopes Cloudflare secrets to authorized steps', () => {
  const { source, workflow } = loadCleanupWorkflow();
  const job = cleanupJob(workflow);
  const derive = cleanupStep(job, 'derive');
  const cleanup = cleanupStep(job, 'cleanup_worker');
  assert.equal(derive.env.CLOUDFLARE_API_TOKEN, cleanupExpression('secrets.CLOUDFLARE_API_TOKEN'));
  assert.equal(derive.env.CLOUDFLARE_ACCOUNT_ID, undefined);
  assert.match(derive.if, /identity-count == '1'/);
  assert.match(runText(derive), /RUNNER_TEMP[\\/]remote-dds-trusted[\\/]scripts[\\/]remote-dds-ci-identity\.mjs/i);
  exactCleanupContext(runText(derive));
  assert.match(runText(derive), /--identity-out\s+"?\$env:RUNNER_TEMP[\\/]remote-dds-trusted-identity\.json"?/i);
  assert.equal(cleanup['continue-on-error'], true);
  assert.equal(cleanup.env.CLOUDFLARE_API_TOKEN, cleanupExpression('secrets.CLOUDFLARE_API_TOKEN'));
  assert.equal(cleanup.env.CLOUDFLARE_ACCOUNT_ID, cleanupExpression('secrets.CLOUDFLARE_ACCOUNT_ID'));
  assert.equal(cleanup.env.DDS_REMOTE_TEST_KEY, '');
  assert.match(cleanup.if, /identity-count == '1'/);
  assert.match(runText(cleanup), /RUNNER_TEMP[\\/]remote-dds-trusted[\\/]scripts[\\/]cleanup-remote-dds-deployment\.mjs/i);
  assert.match(runText(cleanup), /--identity[^\r\n]*RUNNER_TEMP[\\/]remote-dds-untrusted/i);
  assert.match(runText(cleanup), /--deployment-record[^\r\n]*RUNNER_TEMP[\\/]remote-dds-untrusted/i);
  exactCleanupContext(runText(cleanup));
  assert.doesNotMatch(runText(cleanup), /Invoke-Expression|Import-Module|\.\s+[^\r\n]*\.json|&\s+[^\r\n]*\.json|Get-Content|ConvertFrom-Json/i);
  const secretSteps = steps(job).filter((step) => step.env?.CLOUDFLARE_API_TOKEN !== undefined);
  assert.deepEqual(secretSteps.map((step) => step.id), ['derive', 'cleanup_worker']);
  assert.equal((source.match(/secrets\.CLOUDFLARE_API_TOKEN/g) ?? []).length, 2);
  assert.equal((source.match(/secrets\.CLOUDFLARE_ACCOUNT_ID/g) ?? []).length, 1);
  const deriveIndex = steps(job).indexOf(derive);
  for (const step of steps(job).slice(deriveIndex + 1)) {
    if (step.run !== undefined || step.uses !== undefined) assert.equal(step.env?.DDS_REMOTE_TEST_KEY, '', `${step.id ?? step.name} must mask DDS_REMOTE_TEST_KEY`);
  }
});

test('backstop always publishes a validated result and re-propagates every operational failure', () => {
  const { workflow } = loadCleanupWorkflow();
  const job = cleanupJob(workflow);
  const result = cleanupStep(job, 'result');
  const upload = cleanupStep(job, 'upload_cleanup');
  const reprop = cleanupStep(job, 'repropagate');
  assert.equal(result.if, cleanupExpression('always()'));
  assert.equal(result['continue-on-error'], true);
  assert.equal(result.env.DDS_REMOTE_TEST_KEY, '');
  assert.match(runText(result), /status\s*=\s*'failed'/);
  for (const field of ['version', 'status', 'repository', 'workflow', 'runId', 'runAttempt', 'commitSha', 'workerName', 'subdomainDisabled', 'objectDeleted', 'currentAbsent', 'legacyAbsent', 'failureCode']) {
    assert.match(runText(result), new RegExp(`['"]?${field}['"]?`));
  }
  assert.match(runText(result), /version\s*=\s*2/);
  assert.match(runText(result), /failureCode\s*=\s*'CLEANUP_RESULT_WRITE_FAILED'/);
  assert.match(runText(result), /Compare-Object/);
  assert.match(runText(result), /CLEANUP_FINAL_ABSENCE_TIMEOUT/);
  assert.match(runText(result), /github\.event\.workflow_run\.head_sha/);
  assert.match(runText(result), /ConvertFrom-Json/);
  assert.equal(upload.if, cleanupExpression('always()'));
  assert.equal(upload['continue-on-error'], true);
  assert.equal(upload.env.DDS_REMOTE_TEST_KEY, '');
  assert.deepEqual(upload.with, {
    name: cleanupBackstopArtifact(),
    path: cleanupExpression('runner.temp') + '/remote-dds-cleanup-result/cleanup-result.json',
    'if-no-files-found': 'error',
    'retention-days': 30,
  });
  assert.notEqual(upload.with.name, cleanupArtifact('backstop-cleanup'), 'backstop reruns may not reuse the immutable first-attempt artifact name');
  assert.equal(reprop, steps(job).at(-1), 'failure propagation must be final');
  assert.equal(reprop.env.DDS_REMOTE_TEST_KEY, '');
  assert.match(reprop.if, /always\(\)/);
  for (const id of ['inventory', 'authorize', 'checkout', 'install', 'download_identity', 'download_deployment', 'derive', 'cleanup_worker', 'result', 'upload_cleanup']) {
    assert.match(reprop.if, new RegExp(`steps\\.${id}\\.outcome == 'failure'`), `missing ${id} failure propagation`);
  }
  assert.match(runText(reprop), /throw/);
});
