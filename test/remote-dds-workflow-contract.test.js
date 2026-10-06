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
const APPROVED_ACTIONS = new Set([
  'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
]);
const UPLOAD = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02';
const DOWNLOAD = 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093';
const expression = (body) => '${{ ' + body + ' }}';
const artifact = (kind, suffix = '') => `remote-dds-${kind}-${expression('github.run_id')}-${expression('github.run_attempt')}${suffix}`;

function loadWorkflow() {
  const source = readFileSync(WORKFLOW_PATH, 'utf8');
  const workflow = YAML.parse(source);
  assert.ok(workflow && typeof workflow === 'object' && !Array.isArray(workflow), 'workflow must parse as a mapping');
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
  assert.deepEqual(workflow.concurrency, { group: 'stepstone-remote-dds-soak', 'cancel-in-progress': false });
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' });
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job['runs-on'], 'windows-latest');
    assert.equal(job.permissions, undefined, 'jobs may not broaden workflow permissions');
    for (const step of steps(job)) if (step.uses !== undefined) assert.ok(APPROVED_ACTIONS.has(step.uses), `unapproved action: ${step.uses}`);
  }
});

test('prepare proves the repository before authorizing and recording deployment', () => {
  const { workflow } = loadWorkflow();
  const prepare = workflow.jobs.prepare;
  assert.ok(prepare);
  const install = stepIndex(prepare, /^npm ci$/m);
  const unit = stepIndex(prepare, /^npm test$/m);
  const workers = stepIndex(prepare, /^npm run test:workers$/m);
  const smoke = stepIndex(prepare, /^npm run test:dds:smoke$/m);
  const preflight = stepIndex(prepare, /--preflight/);
  const identityUpload = steps(prepare).findIndex((step) => step.uses === UPLOAD && step.with?.name === artifact('identity'));
  const deploy = stepIndex(prepare, /--deploy-from-identity/);
  const ready = stepIndex(prepare, /--create-ready/);
  assert.ok(install < unit && unit < workers && workers < smoke && smoke < preflight && preflight < identityUpload && identityUpload < deploy && deploy < ready);
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
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', build.run], { cwd: root, encoding: 'utf8' });
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
  for (const field of ['version', 'status', 'repository', 'workflow', 'runId', 'runAttempt', 'commitSha', 'workerName', 'subdomainDisabled', 'objectDeleted', 'currentAbsent', 'legacyAbsent']) assert.match(absent.run, new RegExp(`['\"]?${field}['\"]?\\s*=`));
  assert.match(absent.run, /workerName\s*=\s*\$null/);
  assert.match(absent.run, /subdomainDisabled\s*=\s*\$false/);
  assert.match(absent.run, /objectDeleted\s*=\s*\$false/);
  assert.match(absent.run, /currentAbsent\s*=\s*\$true/);
  assert.match(absent.run, /legacyAbsent\s*=\s*\$true/);
  const cleanupCli = findRun(cleanup, /cleanup-remote-dds-deployment\.mjs/);
  exactContext(cleanupCli.run);
  assert.equal(cleanupCli['continue-on-error'], true);
  for (const field of ['repository', 'workflow', 'runId', 'runAttempt', 'commitSha', 'workerName', 'subdomainDisabled', 'objectDeleted', 'currentAbsent', 'legacyAbsent']) assert.match(runText(findRun(cleanup, /Ensure cleanup result/)), new RegExp(`['\"]?${field}['\"]?\\s*=`));
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
  assert.match(runText(reject), /restore|rollback|backstop/i, 'failure must explain how cleanup can be recovered');
  const absent = findRun(cleanup, /no-deployment-authorized/);
  assert.match(absent.if, /identity-count == '0'/);
  assert.match(absent.if, /prior-identity-count == '0'/);
  assert.match(absent.if, /prior-deployment-count == '0'/);
  const result = findRun(cleanup, /Ensure cleanup result/);
  const upload = steps(cleanup).find((step) => step.uses === UPLOAD);
  assert.equal(result.if, expression('always()'));
  assert.equal(upload.if, expression('always()'));
  assert.match(steps(cleanup).at(-1).if, /steps\.reject\.outcome == 'failure'/);
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
