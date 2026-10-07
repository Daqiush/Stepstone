const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const test = require('node:test');

const REQUIRED_PATHS = [
  'workers/wrangler.jsonc',
  'workers/src/index.mjs',
  'workers/src/feasibility-room.mjs',
  'workers/test/fixtures/dds-parity.json',
  'scripts/benchmark-worker-dds.mjs',
  'scripts/worker-dds-random-cases.mjs',
  'scripts/worker-dds-checkpoint.mjs',
  'scripts/simulate-worker-room-budget.mjs',
  'scripts/check-worker-dds-gates.mjs',
];

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(repo, relativePath, contents) {
  const target = join(repo, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function createBaselineRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'remote-soak-prerequisites-'));
  git(repo, 'init', '--quiet');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Prerequisite Test');
  git(repo, 'config', 'core.autocrlf', 'false');
  for (const [index, path] of REQUIRED_PATHS.entries()) {
    write(repo, path, `baseline ${index}\n`);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'baseline');
  return { repo, baseline: git(repo, 'rev-parse', 'HEAD') };
}

async function loadChecker() {
  return import('../scripts/assert-remote-soak-prerequisites.mjs');
}

test('compares prerequisite contents byte-for-byte independently of hash reporting', async () => {
  const { sameBytes } = await loadChecker();

  assert.equal(sameBytes(Buffer.from([0x00, 0x61]), Buffer.from([0x00, 0x61])), true);
  assert.equal(sameBytes(Buffer.from([0x00, 0x61]), Buffer.from([0x00, 0x62])), false);
  assert.equal(sameBytes(Buffer.from([0x00, 0x61]), Buffer.from([0x00, 0x61, 0x00])), false);
});

test('rejects a missing required prerequisite and reports expected/current hashes', async () => {
  const { assertRemoteSoakPrerequisites } = await loadChecker();
  const { repo, baseline } = createBaselineRepo();
  const missingPath = REQUIRED_PATHS[0];
  try {
    rmSync(join(repo, missingPath));
    assert.throws(
      () => assertRemoteSoakPrerequisites({ repoRoot: repo, baseline }),
      (error) => {
        assert.match(error.message, new RegExp(`Missing required path: ${missingPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        assert.match(error.message, /expected sha256: [a-f0-9]{64}/);
        assert.match(error.message, /current sha256: MISSING/);
        return true;
      },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('rejects an altered prerequisite even when the baseline commit is an ancestor', async () => {
  const { assertRemoteSoakPrerequisites } = await loadChecker();
  const { repo, baseline } = createBaselineRepo();
  const alteredPath = REQUIRED_PATHS[1];
  try {
    write(repo, alteredPath, 'changed after baseline\n');
    assert.throws(
      () => assertRemoteSoakPrerequisites({ repoRoot: repo, baseline }),
      (error) => {
        assert.match(error.message, new RegExp(`Byte mismatch: ${alteredPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        assert.match(error.message, /expected sha256: [a-f0-9]{64}/);
        assert.match(error.message, /current sha256: [a-f0-9]{64}/);
        return true;
      },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
