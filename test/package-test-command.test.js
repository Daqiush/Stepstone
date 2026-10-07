'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const TEST_RUNNER = path.join(ROOT, 'scripts', 'run-node-tests.js');
const { discoverTestFiles } = require(TEST_RUNNER);

test('npm test commands use one cross-platform runner without shell globs', () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
  );

  assert.equal(packageJson.scripts.test, 'node scripts/run-node-tests.js test');
  assert.equal(packageJson.scripts['test:workers'], 'node scripts/run-node-tests.js workers/test');
  assert.equal(packageJson.scripts['test:commands'], 'node --test test/package-test-command.test.js');

  for (const [name, command] of Object.entries(packageJson.scripts)) {
    assert.doesNotMatch(command, /[*?\[]/, `${name} must not depend on shell glob expansion`);
  }
});

test('cross-platform runner recursively executes only sorted Node test files', () => {
  const fixtureRoot = mkdtempSync(path.join(ROOT, '.tmp-node-tests-'));
  try {
    mkdirSync(path.join(fixtureRoot, 'nested'));
    writeFileSync(path.join(fixtureRoot, 'zeta.test.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "import test from 'node:test';",
      "test('zeta fixture', () => writeFileSync(path.join(process.env.STEPSTONE_TEST_MARKER_ROOT, 'zeta.marker'), 'ok'));",
      '',
    ].join('\n'));
    writeFileSync(path.join(fixtureRoot, 'nested', 'alpha.test.js'), [
      "const { writeFileSync } = require('node:fs');",
      "const path = require('node:path');",
      "require('node:test')('alpha fixture', () => writeFileSync(path.join(process.env.STEPSTONE_TEST_MARKER_ROOT, 'alpha.marker'), 'ok'));",
      '',
    ].join('\n'));
    writeFileSync(path.join(fixtureRoot, 'ignored.js'), "throw new Error('must not run');\n");
    writeFileSync(path.join(fixtureRoot, 'nested', 'fixture.json'), '{}\n');

    assert.deepEqual(discoverTestFiles(fixtureRoot), [
      path.join(fixtureRoot, 'nested', 'alpha.test.js'),
      path.join(fixtureRoot, 'zeta.test.mjs'),
    ]);

    const childEnv = { ...process.env, STEPSTONE_TEST_MARKER_ROOT: fixtureRoot };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [TEST_RUNNER, fixtureRoot], {
      cwd: ROOT,
      encoding: 'utf8',
      env: childEnv,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(path.join(fixtureRoot, 'alpha.marker')), true);
    assert.equal(existsSync(path.join(fixtureRoot, 'zeta.marker')), true);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
