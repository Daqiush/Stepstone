'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveDdsPaths, ddsSetupHint } = require('../dds-paths');

const ROOT = path.resolve('test-fixture-root');

test('Windows path is preserved for arm64 Node', () => {
  const resolved = resolveDdsPaths({
    rootDir: ROOT,
    platform: 'win32',
    arch: 'arm64',
    env: {},
  });

  assert.equal(resolved.calc, path.join(ROOT, 'dds', 'Build', 'bin', 'x64', 'Release', 'dds_calc.exe'));
  assert.equal(resolved.solve, path.join(ROOT, 'dds', 'Build', 'bin', 'x64', 'Release', 'dds_solve.exe'));
});

test('Darwin arm64 resolves the solve binary', () => {
  const resolved = resolveDdsPaths({ rootDir: ROOT, platform: 'darwin', arch: 'arm64', env: {} });

  assert.equal(resolved.solve, path.join(ROOT, 'dds', 'Build', 'bin', 'darwin-arm64', 'Release', 'current', 'dds_solve'));
});

test('Darwin x64 resolves the calc binary', () => {
  const resolved = resolveDdsPaths({ rootDir: ROOT, platform: 'darwin', arch: 'x64', env: {} });

  assert.equal(resolved.calc, path.join(ROOT, 'dds', 'Build', 'bin', 'darwin-x64', 'Release', 'current', 'dds_calc'));
});

test('calc-only relative override retains the default solve path and reports override flags', () => {
  const resolved = resolveDdsPaths({
    rootDir: ROOT,
    platform: 'darwin',
    arch: 'arm64',
    env: { DDS_CALC_PATH: path.join('custom', 'dds_calc') },
  });

  assert.equal(resolved.calc, path.resolve(ROOT, 'custom', 'dds_calc'));
  assert.equal(resolved.solve, path.join(ROOT, 'dds', 'Build', 'bin', 'darwin-arm64', 'Release', 'current', 'dds_solve'));
  assert.deepEqual(resolved.overridden, { calc: true, solve: false });
  assert.throws(
    () => resolveDdsPaths({ rootDir: ROOT, platform: 'darwin', arch: 'arm64', env: { DDS_CALC_PATH: '' } }),
    /DDS_CALC_PATH.*empty/i,
  );
});

test('solve-only absolute override retains the default calc path and reports override flags', () => {
  const absoluteSolve = path.resolve('absolute-solve');
  const resolved = resolveDdsPaths({
    rootDir: ROOT,
    platform: 'win32',
    arch: 'x64',
    env: { DDS_SOLVE_PATH: absoluteSolve },
  });

  assert.equal(resolved.calc, path.join(ROOT, 'dds', 'Build', 'bin', 'x64', 'Release', 'dds_calc.exe'));
  assert.equal(resolved.solve, absoluteSolve);
  assert.deepEqual(resolved.overridden, { calc: false, solve: true });
  assert.throws(
    () => resolveDdsPaths({ rootDir: ROOT, platform: 'win32', arch: 'x64', env: { DDS_SOLVE_PATH: '' } }),
    /DDS_SOLVE_PATH.*empty/i,
  );
});

test('omitted runtime inputs use process platform and architecture', {
  skip: !['win32', 'darwin'].includes(process.platform),
}, () => {
  const resolved = resolveDdsPaths({ rootDir: ROOT, env: {} });

  assert.equal(resolved.platform, process.platform);
  assert.equal(resolved.arch, process.arch);
});

test('Darwin rejects unsupported ppc architecture', () => {
  assert.throws(
    () => resolveDdsPaths({ rootDir: ROOT, platform: 'darwin', arch: 'ppc', env: {} }),
    (error) => /unsupported/i.test(error.message) && error.message.includes('ppc'),
  );
});

test('setup hint describes the runtime, binaries, and preparation command', () => {
  const resolved = resolveDdsPaths({ rootDir: ROOT, platform: 'darwin', arch: 'arm64', env: {} });
  const hint = ddsSetupHint(resolved);

  assert.match(hint, /darwin/);
  assert.match(hint, /arm64/);
  assert.match(hint, /dds_calc/);
  assert.match(hint, /dds_solve/);
  assert.match(hint, /Run npm install to prepare DDS/);
});
