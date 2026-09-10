'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  canonicalizeCompileArgs,
  computeBuildFingerprint,
  createCompileArgs,
  discoverDdsSources,
  isBuildCacheHit,
  readBuildManifest,
  validateDdsOverrides,
  validateExecutable,
} = require('../scripts/dds-build');

const temporaryDirectories = [];

test.afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stepstone-dds-plan-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeFile(filePath, contents = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function makeSourceFixture() {
  const projectRoot = makeTempDirectory();
  const sourceRoot = path.join(projectRoot, 'dds', 'library', 'src');
  const cliSources = [
    writeFile(path.join(projectRoot, 'dds', 'dds_calc.cpp'), 'int calc() { return 1; }'),
    writeFile(path.join(projectRoot, 'dds', 'dds_solve.cpp'), 'int solve() { return 2; }'),
  ];
  writeFile(path.join(sourceRoot, 'core', 'dds.cpp'), 'int dds() { return 0; }');
  writeFile(path.join(sourceRoot, 'calc_dd_table.cpp'), 'int calc_table() { return 0; }');
  writeFile(path.join(sourceRoot, 'nested', 'solve_board.cpp'), 'int solve_board() { return 0; }');
  return { projectRoot, sourceRoot, cliSources };
}

function fingerprint(plan, compileArgsByProgram = { dds_calc: ['semantic-calc'] }) {
  return computeBuildFingerprint({
    files: plan.fingerprintFiles,
    platform: 'darwin',
    arch: 'arm64',
    compilerIdentity: 'Apple clang version 18.0.0',
    compileArgsByProgram,
  });
}

test('discovery is recursive and sorted, fingerprints headers and selected CLIs, and excludes external test sources', () => {
  const fixture = makeSourceFixture();
  const alpha = writeFile(path.join(fixture.sourceRoot, 'alpha.cpp'), 'alpha');
  const zeta = writeFile(path.join(fixture.sourceRoot, 'nested', 'zeta.cpp'), 'zeta');
  const h = writeFile(path.join(fixture.sourceRoot, 'include', 'cards.h'), 'h');
  const hpp = writeFile(path.join(fixture.sourceRoot, 'include', 'solver.hpp'), 'hpp');
  writeFile(path.join(fixture.sourceRoot, 'ignored.txt'), 'ignored');
  const externalTest = writeFile(path.join(fixture.projectRoot, 'test', 'fake.cpp'), 'external');

  const result = discoverDdsSources(fixture);
  const dds = path.join(fixture.sourceRoot, 'core', 'dds.cpp');
  const calc = path.join(fixture.sourceRoot, 'calc_dd_table.cpp');
  const solve = path.join(fixture.sourceRoot, 'nested', 'solve_board.cpp');

  assert.deepEqual(result.compileSources, [alpha, calc, dds, solve, zeta].sort());
  assert.deepEqual(
    result.fingerprintFiles.map(({ absolutePath }) => absolutePath),
    [alpha, calc, dds, solve, zeta, h, hpp, ...fixture.cliSources].sort(),
  );
  assert.deepEqual(
    result.fingerprintFiles.map(({ relativePath }) => relativePath),
    [alpha, calc, dds, solve, zeta, h, hpp, ...fixture.cliSources]
      .map((filePath) => path.relative(fixture.projectRoot, filePath).split(path.sep).join('/'))
      .sort(),
  );
  assert.equal(result.fingerprintFiles.some(({ absolutePath }) => absolutePath === externalTest), false);
});

test('empty source discovery rejects and names the source root', () => {
  const projectRoot = makeTempDirectory();
  const sourceRoot = path.join(projectRoot, 'dds', 'library', 'src');
  fs.mkdirSync(sourceRoot, { recursive: true });
  const cliSources = [
    writeFile(path.join(projectRoot, 'dds_calc.cpp')),
    writeFile(path.join(projectRoot, 'dds_solve.cpp')),
  ];

  assert.throws(
    () => discoverDdsSources({ sourceRoot, projectRoot, cliSources }),
    (error) => error.message.includes(sourceRoot),
  );
});

test('discovery rejects fixtures missing each required translation unit by basename', () => {
  for (const missing of ['dds.cpp', 'calc_dd_table.cpp', 'solve_board.cpp']) {
    const projectRoot = makeTempDirectory();
    const sourceRoot = path.join(projectRoot, 'dds', 'library', 'src');
    const cliSources = [
      writeFile(path.join(projectRoot, 'dds_calc.cpp')),
      writeFile(path.join(projectRoot, 'dds_solve.cpp')),
      writeFile(path.join(projectRoot, 'shadow', missing)),
    ];
    for (const required of ['dds.cpp', 'calc_dd_table.cpp', 'solve_board.cpp']) {
      if (required !== missing) writeFile(path.join(sourceRoot, required));
    }
    if (missing === 'dds.cpp') writeFile(path.join(sourceRoot, 'other.cpp'));

    assert.throws(
      () => discoverDdsSources({ sourceRoot, projectRoot, cliSources }),
      (error) => error.message.includes(missing),
    );
  }
});

test('a header byte changes the lowercase SHA-256 build fingerprint', () => {
  const fixture = makeSourceFixture();
  const header = writeFile(path.join(fixture.sourceRoot, 'dds.hpp'), 'A');
  const firstPlan = discoverDdsSources(fixture);
  const first = fingerprint(firstPlan);
  fs.writeFileSync(header, 'B');
  const second = fingerprint(discoverDdsSources(fixture));

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.match(second, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);

  const collisionRoot = makeTempDirectory();
  const leftFiles = [
    { absolutePath: writeFile(path.join(collisionRoot, 'left-a'), Buffer.from('x\0b')), relativePath: 'a' },
    { absolutePath: writeFile(path.join(collisionRoot, 'left-c'), Buffer.from('d')), relativePath: 'c' },
  ];
  const rightFiles = [
    { absolutePath: writeFile(path.join(collisionRoot, 'right-a'), Buffer.from('x')), relativePath: 'a' },
    { absolutePath: writeFile(path.join(collisionRoot, 'right-b'), Buffer.from('c\0d')), relativePath: 'b' },
  ];
  assert.notEqual(
    fingerprint({ fingerprintFiles: leftFiles }),
    fingerprint({ fingerprintFiles: rightFiles }),
  );
});

test('CLI content is fingerprinted stably and canonical output paths do not affect the fingerprint', () => {
  const fixture = makeSourceFixture();
  const plan = discoverDdsSources(fixture);
  const includeDir = path.join(fixture.projectRoot, 'dds', 'library', 'include');
  const firstOutput = path.join(fixture.projectRoot, '.stage-one', 'dds_calc');
  const secondOutput = path.join(fixture.projectRoot, '.stage-two', 'dds_calc');
  const outsideCollision = `${fixture.projectRoot}-outside${path.sep}header`;
  const makeCanonical = (outputPath) => canonicalizeCompileArgs({
    args: createCompileArgs({
      arch: 'arm64',
      includeDir,
      librarySources: [...plan.compileSources, outsideCollision],
      cliSource: fixture.cliSources[0],
      outputPath,
    }),
    projectRoot: fixture.projectRoot,
    outputPath,
    programName: 'dds_calc',
  });
  const canonicalOne = makeCanonical(firstOutput);
  const canonicalTwo = makeCanonical(secondOutput);
  const initial = fingerprint(plan, { dds_calc: canonicalOne });

  assert.deepEqual(canonicalOne, canonicalTwo);
  assert.equal(canonicalOne.includes(outsideCollision), true);
  assert.equal(canonicalOne.at(-1), '<OUTPUT>/dds_calc');
  assert.throws(
    () => canonicalizeCompileArgs({
      args: createCompileArgs({
        arch: 'arm64',
        includeDir,
        librarySources: plan.compileSources,
        cliSource: fixture.cliSources[0],
        outputPath: firstOutput,
      }),
      projectRoot: fixture.projectRoot,
      outputPath: secondOutput,
      programName: 'dds_calc',
    }),
    (error) => error.message.includes(firstOutput) && error.message.includes(secondOutput),
  );
  assert.equal(fingerprint(plan, { dds_calc: canonicalOne }), initial);
  assert.equal(fingerprint(plan, { dds_calc: canonicalTwo }), initial);

  const secondCheckout = makeSourceFixture();
  const secondCheckoutPlan = discoverDdsSources(secondCheckout);
  const checkoutArgs = (checkout, checkoutPlan) => {
    const checkoutOutput = path.join(checkout.projectRoot, '.stage', 'dds_calc');
    return canonicalizeCompileArgs({
      args: createCompileArgs({
        arch: 'arm64',
        includeDir: path.join(checkout.projectRoot, 'dds', 'library', 'include'),
        librarySources: checkoutPlan.compileSources,
        cliSource: checkout.cliSources[0],
        outputPath: checkoutOutput,
      }),
      projectRoot: checkout.projectRoot,
      outputPath: checkoutOutput,
      programName: 'dds_calc',
    });
  };
  assert.equal(
    fingerprint(plan, { dds_calc: checkoutArgs(fixture, plan) }),
    fingerprint(secondCheckoutPlan, { dds_calc: checkoutArgs(secondCheckout, secondCheckoutPlan) }),
  );

  fs.writeFileSync(fixture.cliSources[0], 'int calc() { return 99; }');
  assert.notEqual(fingerprint(discoverDdsSources(fixture), { dds_calc: canonicalOne }), initial);
});

test('compile arguments are deterministic for arm64 and x64 and reject unsupported architectures', () => {
  const includeDir = path.resolve('include');
  const sources = [path.resolve('z.cpp'), path.resolve('a.cpp')];
  const cliSource = path.resolve('calc_dd_table.cpp');
  const outputPath = path.resolve('out', 'dds_calc');
  const common = [
    '-std=c++20', '-O3', '-mtune=generic', '-fPIC', '-pthread',
    '-I', includeDir,
  ];

  assert.deepEqual(createCompileArgs({ arch: 'arm64', includeDir, librarySources: sources, cliSource, outputPath }), [
    ...common, '-arch', 'arm64', ...sources.sort(), cliSource, '-o', outputPath,
  ]);
  assert.deepEqual(createCompileArgs({ arch: 'x64', includeDir, librarySources: sources, cliSource, outputPath }), [
    ...common, '-arch', 'x86_64', ...sources.sort(), cliSource, '-o', outputPath,
  ]);
  assert.throws(
    () => createCompileArgs({ arch: 'ppc', includeDir, librarySources: sources, cliSource, outputPath }),
    /unsupported.*ppc/i,
  );
});

test('build manifests parse only when present, valid JSON, and structurally valid', () => {
  const activeDir = makeTempDirectory();
  const manifestPath = path.join(activeDir, 'manifest.json');
  const valid = {
    version: 1,
    fingerprint: 'a'.repeat(64),
    platform: 'darwin',
    arch: 'arm64',
    programs: ['dds_calc', 'dds_solve'],
  };

  assert.equal(readBuildManifest(path.join(activeDir, 'missing')), null);
  fs.writeFileSync(manifestPath, '{bad json');
  assert.equal(readBuildManifest(activeDir), null);
  fs.writeFileSync(manifestPath, JSON.stringify({ ...valid, programs: 'dds_calc' }));
  assert.equal(readBuildManifest(activeDir), null);
  fs.writeFileSync(manifestPath, JSON.stringify(valid));
  assert.deepEqual(readBuildManifest(activeDir), valid);
});

test('cache hits require the matching manifest, every named program, and executable artifacts', () => {
  const activeDir = makeTempDirectory();
  const expectedFingerprint = 'b'.repeat(64);
  const programs = ['dds_calc', 'dds_solve'];
  for (const program of programs) writeFile(path.join(activeDir, program), program);
  const writeManifest = (value) => fs.writeFileSync(path.join(activeDir, 'manifest.json'), JSON.stringify(value));
  writeManifest({ version: 1, fingerprint: expectedFingerprint, platform: 'darwin', arch: 'arm64', programs });
  const nonExecutable = new Set();
  const validateExecutableFn = (filePath) => {
    if (!fs.existsSync(filePath) || nonExecutable.has(filePath)) throw new Error(`not executable: ${filePath}`);
    return true;
  };
  const check = (fingerprintValue = expectedFingerprint) => isBuildCacheHit({
    activeDir,
    fingerprint: fingerprintValue,
    requiredPrograms: programs,
    validateExecutableFn,
  });

  assert.equal(check(), true);
  assert.equal(check('c'.repeat(64)), false);
  writeManifest({ version: 1, fingerprint: expectedFingerprint, platform: 'darwin', arch: 'arm64', programs: ['dds_calc'] });
  assert.equal(check(), false);
  writeManifest({ version: 1, fingerprint: expectedFingerprint, platform: 'darwin', arch: 'arm64', programs });
  fs.rmSync(path.join(activeDir, 'dds_solve'));
  assert.equal(check(), false);
  writeFile(path.join(activeDir, 'dds_solve'), 'dds_solve');
  nonExecutable.add(path.join(activeDir, 'dds_solve'));
  assert.equal(check(), false);
});

test('executable validation follows stat results, requires a file, and checks Darwin execute access', () => {
  const followedSymlink = path.resolve('linked-dds');
  const calls = [];
  assert.equal(validateExecutable(followedSymlink, {
    platform: 'darwin',
    statSync(filePath) {
      calls.push(['stat', filePath]);
      return { isFile: () => true };
    },
    accessSync(filePath, mode) {
      calls.push(['access', filePath, mode]);
    },
  }), true);
  assert.deepEqual(calls, [
    ['stat', followedSymlink],
    ['access', followedSymlink, fs.constants.X_OK],
  ]);

  const directoryPath = path.resolve('dds-directory');
  assert.throws(
    () => validateExecutable(directoryPath, { platform: 'darwin', statSync: () => ({ isFile: () => false }) }),
    (error) => error.message.includes(directoryPath),
  );
  const nonExecutablePath = path.resolve('non-executable-dds');
  assert.throws(
    () => validateExecutable(nonExecutablePath, {
      platform: 'darwin',
      statSync: () => ({ isFile: () => true }),
      accessSync: () => { throw new Error('EACCES'); },
    }),
    (error) => error.message.includes(nonExecutablePath),
  );
});

test('override validation is independent, preserves resolved paths, accepts symlinks, and propagates invalid paths', () => {
  const absoluteCalc = path.resolve('custom', 'dds_calc');
  const resolvedRelativeSolve = path.resolve('fixture-root', 'resolved', 'dds_solve');
  const linkedCalc = path.resolve('links', 'dds_calc');
  const seen = [];
  const validator = (filePath) => {
    seen.push(filePath);
    return true;
  };

  assert.deepEqual(validateDdsOverrides({
    calc: absoluteCalc,
    solve: resolvedRelativeSolve,
    overridden: { calc: true, solve: false },
  }, { validateExecutableFn: validator }), { calc: true, solve: false });
  assert.deepEqual(seen, [absoluteCalc]);
  assert.deepEqual(validateDdsOverrides({
    calc: absoluteCalc,
    solve: resolvedRelativeSolve,
    overridden: { calc: false, solve: true },
  }, { validateExecutableFn: validator }), { calc: false, solve: true });
  assert.deepEqual(validateDdsOverrides({
    calc: linkedCalc,
    solve: resolvedRelativeSolve,
    overridden: { calc: true, solve: false },
  }, { validateExecutableFn: validator }), { calc: true, solve: false });

  for (const invalidPath of [path.resolve('missing-dds'), path.resolve('non-executable-dds')]) {
    assert.throws(
      () => validateDdsOverrides({
        calc: invalidPath,
        solve: resolvedRelativeSolve,
        overridden: { calc: true, solve: false },
      }, { validateExecutableFn: (filePath) => { throw new Error(`invalid ${filePath}`); } }),
      (error) => error.message.includes(invalidPath),
    );
  }
});
