'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  canonicalizeCompileArgs,
  buildMacDds,
  computeBuildFingerprint,
  createCompileArgs,
  discoverDdsSources,
  isBuildCacheHit,
  publishBuild,
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

function makeBuildFixture() {
  const fixture = makeSourceFixture();
  const releaseDir = path.join(fixture.projectRoot, 'dds', 'Build', 'bin', 'darwin-arm64', 'Release');
  fs.mkdirSync(releaseDir, { recursive: true });
  return {
    ...fixture,
    releaseDir,
    sourcePlan: {
      compileSources: discoverDdsSources(fixture).compileSources,
      includeDir: fixture.sourceRoot,
      cliSources: { calc: fixture.cliSources[0], solve: fixture.cliSources[1] },
    },
  };
}

function createRealBuildFsOps(events, initialLinks = new Map()) {
  const links = new Map(initialLinks);
  const resolveLinkedPath = (filePath) => {
    for (const [linkPath, target] of links) {
      if (filePath === linkPath || filePath.startsWith(`${linkPath}${path.sep}`)) {
        return path.join(path.resolve(path.dirname(linkPath), target), path.relative(linkPath, filePath));
      }
    }
    return filePath;
  };
  return {
    links,
    fsOps: {
      mkdirSync: fs.mkdirSync,
      mkdtempSync(prefix) {
        const result = fs.mkdtempSync(prefix);
        events.push(['stage', result]);
        return result;
      },
      writeFileSync(filePath, contents) {
        events.push(['write', path.basename(filePath)]);
        return fs.writeFileSync(filePath, contents);
      },
      readFileSync(filePath, encoding) { return fs.readFileSync(resolveLinkedPath(filePath), encoding); },
      chmodSync(filePath, mode) {
        events.push(['chmod', path.basename(filePath), mode]);
        return fs.chmodSync(filePath, mode);
      },
      statSync(filePath) {
        events.push(['validate', filePath]);
        return fs.statSync(resolveLinkedPath(filePath));
      },
      accessSync(filePath, mode) { return fs.accessSync(resolveLinkedPath(filePath), mode); },
      existsSync(filePath) { return links.has(filePath) || fs.existsSync(resolveLinkedPath(filePath)); },
      renameSync(from, to) {
        events.push(['rename', from, to]);
        if (links.has(from)) {
          const target = links.get(from);
          links.delete(from);
          links.set(to, target);
          return;
        }
        return fs.renameSync(from, to);
      },
      symlinkSync(target, linkPath) {
        events.push(['symlink', target, linkPath]);
        if (links.has(linkPath) || fs.existsSync(linkPath)) throw new Error(`EEXIST: ${linkPath}`);
        links.set(linkPath, target);
      },
      readlinkSync(linkPath) {
        if (!links.has(linkPath)) throw new Error(`EINVAL: ${linkPath}`);
        return links.get(linkPath);
      },
      unlinkSync(filePath) {
        events.push(['unlink', filePath]);
        if (!links.delete(filePath)) fs.unlinkSync(filePath);
      },
      rmSync(filePath, options) {
        events.push(['rm', filePath]);
        links.delete(filePath);
        return fs.rmSync(filePath, options);
      },
    },
  };
}

function createFsHarness({ failSymlink = false, failCurrentRename = false } = {}) {
  const directories = new Set();
  const files = new Map();
  const links = new Map();
  const events = [];
  let temporaryIndex = 0;
  const normalize = (value) => path.resolve(value);
  const within = (candidate, parent) => candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
  const resolveLinkedPath = (filePath) => {
    const absolute = normalize(filePath);
    for (const [linkPath, target] of links) {
      if (within(absolute, linkPath)) {
        return path.join(path.resolve(path.dirname(linkPath), target), path.relative(linkPath, absolute));
      }
    }
    return absolute;
  };
  const moveEntries = (collection, from, to) => {
    for (const [entry, value] of [...collection.entries()]) {
      if (!within(entry, from)) continue;
      collection.delete(entry);
      collection.set(path.join(to, path.relative(from, entry)), value);
    }
  };
  const fsOps = {
    mkdirSync(directory) {
      const absolute = normalize(directory);
      events.push(['mkdir', absolute]);
      for (let current = absolute; !directories.has(current); current = path.dirname(current)) {
        directories.add(current);
        if (path.dirname(current) === current) break;
      }
    },
    mkdtempSync(prefix) {
      const result = normalize(`${prefix}${++temporaryIndex}`);
      directories.add(result);
      events.push(['mkdtemp', result]);
      return result;
    },
    writeFileSync(filePath, contents) {
      const absolute = normalize(filePath);
      files.set(absolute, Buffer.isBuffer(contents) ? contents : String(contents));
      events.push(['write', absolute]);
    },
    readFileSync(filePath, encoding) {
      const resolved = resolveLinkedPath(filePath);
      if (!files.has(resolved)) throw new Error(`ENOENT: ${filePath}`);
      const value = files.get(resolved);
      return encoding ? value.toString() : value;
    },
    chmodSync(filePath, mode) { events.push(['chmod', normalize(filePath), mode]); },
    statSync(filePath) {
      const resolved = resolveLinkedPath(filePath);
      events.push(['stat', normalize(filePath)]);
      if (!files.has(resolved)) throw new Error(`ENOENT: ${filePath}`);
      return { isFile: () => true };
    },
    accessSync(filePath) {
      const resolved = resolveLinkedPath(filePath);
      events.push(['access', normalize(filePath)]);
      if (!files.has(resolved)) throw new Error(`EACCES: ${filePath}`);
    },
    existsSync(filePath) {
      const absolute = normalize(filePath);
      const resolved = resolveLinkedPath(absolute);
      return links.has(absolute) || directories.has(resolved) || files.has(resolved);
    },
    renameSync(fromPath, toPath) {
      const from = normalize(fromPath);
      const to = normalize(toPath);
      events.push(['rename', from, to]);
      if (failCurrentRename && path.basename(to) === 'current') throw new Error(`rename denied: ${to}`);
      if (links.has(from)) {
        const target = links.get(from);
        links.delete(from);
        links.set(to, target);
        return;
      }
      if (!directories.has(from)) throw new Error(`ENOENT: ${from}`);
      directories.delete(from);
      directories.add(to);
      moveEntries(files, from, to);
      moveEntries(links, from, to);
    },
    symlinkSync(target, linkPath) {
      const absolute = normalize(linkPath);
      events.push(['symlink', target, absolute]);
      if (failSymlink) throw new Error(`symlink denied: ${absolute}`);
      links.set(absolute, target);
    },
    readlinkSync(linkPath) {
      const absolute = normalize(linkPath);
      if (!links.has(absolute)) throw new Error(`EINVAL: ${absolute}`);
      return links.get(absolute);
    },
    unlinkSync(filePath) {
      const absolute = normalize(filePath);
      events.push(['unlink', absolute]);
      if (!links.delete(absolute) && !files.delete(absolute)) throw new Error(`ENOENT: ${absolute}`);
    },
    rmSync(filePath) {
      const absolute = normalize(filePath);
      events.push(['rm', absolute]);
      directories.delete(absolute);
      for (const candidate of [...files.keys()]) if (within(candidate, absolute)) files.delete(candidate);
      for (const candidate of [...links.keys()]) if (within(candidate, absolute)) links.delete(candidate);
    },
  };
  return {
    directories,
    files,
    links,
    events,
    fsOps,
    directory(directory) { directories.add(normalize(directory)); },
    file(filePath, contents = 'binary') {
      const absolute = normalize(filePath);
      directories.add(path.dirname(absolute));
      files.set(absolute, contents);
    },
    link(linkPath, target) { links.set(normalize(linkPath), target); },
  };
}

function seedPublishedBuild(harness, releaseDir, name = 'old', programs = ['dds_calc', 'dds_solve']) {
  const buildDir = path.join(releaseDir, 'builds', name);
  harness.directory(buildDir);
  for (const program of programs) harness.file(path.join(buildDir, program));
  harness.link(path.join(releaseDir, 'current'), path.join('builds', name));
  return buildDir;
}

function seedStaging(harness, releaseDir, programs = ['dds_calc', 'dds_solve']) {
  const stagingDir = path.join(releaseDir, '.staging-fixture');
  harness.directory(stagingDir);
  for (const program of programs) harness.file(path.join(stagingDir, program));
  return stagingDir;
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

test('both programs are compiled into one staging directory before publication', async () => {
  const fixture = makeBuildFixture();
  const events = [];
  const { fsOps } = createRealBuildFsOps(events);
  const outputs = [];
  const runCommand = (command, args) => {
    const outputPath = args.at(-1);
    outputs.push(outputPath);
    events.push(['compile', path.basename(outputPath)]);
    fs.writeFileSync(outputPath, path.basename(outputPath));
    return { status: 0, stdout: '', stderr: '', error: null };
  };
  const smoke = async (programPath) => {
    assert.equal(outputs.length, 2);
    assert.equal(events.some(([name]) => name === 'rename'), false);
    assert.equal(fs.existsSync(programPath), true);
  };

  const result = await buildMacDds({
    rootDir: fixture.projectRoot,
    arch: 'arm64',
    compilerPath: '/usr/bin/clang++',
    compilerIdentity: 'fixture clang',
    paths: {},
    overridden: { calc: false, solve: false },
    sourcePlan: fixture.sourcePlan,
    fingerprint: '1'.repeat(64),
    releaseDir: fixture.releaseDir,
    runCommand,
    smokeCalc: smoke,
    smokeSolve: smoke,
    fsOps,
  });

  assert.deepEqual(result.compiledPrograms, ['dds_calc', 'dds_solve']);
  assert.equal(path.dirname(outputs[0]), path.dirname(outputs[1]));
  assert.match(path.dirname(outputs[0]), /\.staging-/);
});

test('one override builds, smokes, and publishes only the other program in both directions', async () => {
  for (const overriddenProgram of ['calc', 'solve']) {
    const fixture = makeBuildFixture();
    const events = [];
    const { fsOps } = createRealBuildFsOps(events);
    const compiled = [];
    const smoked = [];
    const runCommand = (command, args) => {
      const outputPath = args.at(-1);
      compiled.push(path.basename(outputPath));
      fs.writeFileSync(outputPath, 'binary');
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    const result = await buildMacDds({
      rootDir: fixture.projectRoot,
      arch: 'arm64',
      compilerPath: '/usr/bin/clang++',
      compilerIdentity: 'fixture clang',
      paths: {},
      overridden: { calc: overriddenProgram === 'calc', solve: overriddenProgram === 'solve' },
      sourcePlan: fixture.sourcePlan,
      fingerprint: (overriddenProgram === 'calc' ? '2' : '3').repeat(64),
      releaseDir: fixture.releaseDir,
      runCommand,
      smokeCalc: async () => smoked.push('dds_calc'),
      smokeSolve: async () => smoked.push('dds_solve'),
      fsOps,
    });
    const expected = overriddenProgram === 'calc' ? ['dds_solve'] : ['dds_calc'];
    assert.deepEqual(compiled, expected);
    assert.deepEqual(smoked, expected);
    assert.deepEqual(result.compiledPrograms, expected);
    assert.equal(fs.existsSync(path.join(result.buildDir, expected[0])), true);
  }
});

test('compile failure reports diagnostics and architecture, cleans staging, and preserves current', async () => {
  const fixture = makeBuildFixture();
  const oldBuild = path.join(fixture.releaseDir, 'builds', 'old');
  fs.mkdirSync(oldBuild, { recursive: true });
  for (const program of ['dds_calc', 'dds_solve']) writeFile(path.join(oldBuild, program), 'old');
  const current = path.join(fixture.releaseDir, 'current');
  const events = [];
  const { fsOps } = createRealBuildFsOps(events, new Map([[current, path.join('builds', 'old')]]));

  await assert.rejects(
    buildMacDds({
      rootDir: fixture.projectRoot,
      arch: 'arm64',
      compilerPath: '/usr/bin/clang++',
      compilerIdentity: 'fixture clang',
      paths: {},
      overridden: { calc: false, solve: false },
      sourcePlan: fixture.sourcePlan,
      fingerprint: '4'.repeat(64),
      releaseDir: fixture.releaseDir,
      runCommand: () => ({ status: 1, stdout: '', stderr: 'compile broke', error: null }),
      smokeCalc: async () => {},
      smokeSolve: async () => {},
      fsOps,
    }),
    (error) => error.message.includes('compile broke') && error.message.includes('arm64'),
  );
  assert.equal(fsOps.readlinkSync(current), path.join('builds', 'old'));
  assert.equal(fs.readdirSync(fixture.releaseDir).some((name) => name.startsWith('.staging-')), false);
});

test('smoke rejection cleans staging and preserves the old current link', async () => {
  const fixture = makeBuildFixture();
  const current = path.join(fixture.releaseDir, 'current');
  const oldBuild = path.join(fixture.releaseDir, 'builds', 'old');
  fs.mkdirSync(oldBuild, { recursive: true });
  const events = [];
  const { fsOps } = createRealBuildFsOps(events, new Map([[current, path.join('builds', 'old')]]));
  const runner = (command, args) => {
    fs.writeFileSync(args.at(-1), 'binary');
    return { status: 0, stdout: '', stderr: '', error: null };
  };

  await assert.rejects(
    buildMacDds({
      rootDir: fixture.projectRoot,
      arch: 'arm64',
      compilerPath: '/usr/bin/clang++',
      compilerIdentity: 'fixture clang',
      paths: {},
      overridden: { calc: false, solve: false },
      sourcePlan: fixture.sourcePlan,
      fingerprint: '5'.repeat(64),
      releaseDir: fixture.releaseDir,
      runCommand: runner,
      smokeCalc: async () => { throw new Error('calc smoke broke'); },
      smokeSolve: async () => {},
      fsOps,
    }),
    /calc smoke broke/,
  );
  assert.equal(fsOps.readlinkSync(current), path.join('builds', 'old'));
  assert.equal(fs.readdirSync(fixture.releaseDir).some((name) => name.startsWith('.staging-')), false);
});

test('successful build orders compile, validation, awaited smoke, manifest, and atomic publication', async () => {
  const wrapperModulePath = require.resolve('../dds-wrapper');
  const smokeModulePath = require.resolve('../scripts/smoke-dds');
  const wrapperModule = require(wrapperModulePath);
  const originalCreateDdsClient = wrapperModule.createDdsClient;
  wrapperModule.createDdsClient = () => ({
    solveBoard: async () => ({
      score: 1,
      cards: [{ suit: 'S', rank: 2 }, { suit: 'H', rank: 2 }],
    }),
  });
  delete require.cache[smokeModulePath];
  try {
    const { smokeSolve } = require(smokeModulePath);
    await assert.doesNotReject(smokeSolve(path.resolve('fixture-dds-solve')));
  } finally {
    wrapperModule.createDdsClient = originalCreateDdsClient;
    delete require.cache[smokeModulePath];
  }

  const fixture = makeBuildFixture();
  const events = [];
  const { fsOps } = createRealBuildFsOps(events);
  const runner = (command, args) => {
    const program = path.basename(args.at(-1));
    events.push(['compile', program]);
    fs.writeFileSync(args.at(-1), 'binary');
    return { status: 0, stdout: '', stderr: '', error: null };
  };
  const smoke = async (programPath) => {
    const program = path.basename(programPath);
    events.push(['smoke-start', program]);
    await new Promise((resolve) => setImmediate(resolve));
    events.push(['smoke-done', program]);
  };
  await buildMacDds({
    rootDir: fixture.projectRoot,
    arch: 'arm64',
    compilerPath: '/usr/bin/clang++',
    compilerIdentity: 'fixture clang',
    paths: {},
    overridden: { calc: false, solve: false },
    sourcePlan: fixture.sourcePlan,
    fingerprint: '6'.repeat(64),
    releaseDir: fixture.releaseDir,
    runCommand: runner,
    smokeCalc: smoke,
    smokeSolve: smoke,
    fsOps,
  });
  const significant = events.filter(([name, value]) => (
    name === 'compile'
    || name === 'chmod'
    || (name === 'validate' && String(value).includes('.staging-'))
    || name === 'smoke-start'
    || name === 'smoke-done'
    || (name === 'write' && value === 'manifest.json')
    || name === 'symlink'
    || (name === 'rename' && (String(value).includes('.staging-') || path.basename(value) !== 'current'))
    || (name === 'rename' && path.basename(value) === 'current')
  ));
  const labels = significant.map(([name, value, destination]) => {
    if (name === 'rename' && String(value).includes('.staging-')) return 'staging rename';
    if (name === 'rename' && path.basename(destination) === 'current') return 'current rename';
    if (name === 'symlink') return 'temp symlink';
    if (name === 'write') return 'manifest';
    if (name === 'validate') return `validate ${path.basename(value)}`;
    return `${name} ${path.basename(value)}`;
  });
  assert.deepEqual(labels, [
    'compile dds_calc', 'compile dds_solve',
    'chmod dds_calc', 'chmod dds_solve',
    'validate dds_calc', 'validate dds_solve',
    'smoke-start dds_calc', 'smoke-start dds_solve',
    'smoke-done dds_calc', 'smoke-done dds_solve',
    'manifest', 'staging rename', 'temp symlink', 'current rename',
  ]);
  const firstSmoke = events.findIndex(([name]) => name === 'smoke-start');
  const validationIndexes = events
    .map(([name], index) => name === 'validate' ? index : -1)
    .filter((index) => index >= 0);
  assert.equal(validationIndexes.filter((index) => index < firstSmoke).length, 2);
});

test('publication returns immutable destination and reuses an identical concurrent build', async () => {
  const releaseDir = path.resolve('virtual', 'Release');
  const fingerprintValue = '7'.repeat(64);
  const requiredPrograms = ['dds_calc', 'dds_solve'];
  const first = createFsHarness();
  const firstStaging = seedStaging(first, releaseDir, requiredPrograms);
  const result = await publishBuild({
    stagingDir: firstStaging,
    releaseDir,
    fingerprint: fingerprintValue,
    requiredPrograms,
    validateExecutable: (filePath) => first.fsOps.statSync(filePath),
    fsOps: first.fsOps,
  });
  assert.deepEqual(result, {
    buildDir: path.join(releaseDir, 'builds', fingerprintValue),
    activeDir: path.join(releaseDir, 'current'),
  });
  assert.equal(first.events.some(([name, from, to]) => name === 'rename' && from === path.resolve(firstStaging) && to === path.resolve(result.buildDir)), true);

  const concurrent = createFsHarness();
  const concurrentStaging = seedStaging(concurrent, releaseDir, requiredPrograms);
  concurrent.directory(result.buildDir);
  for (const program of requiredPrograms) concurrent.file(path.join(result.buildDir, program));
  await publishBuild({
    stagingDir: concurrentStaging,
    releaseDir,
    fingerprint: fingerprintValue,
    requiredPrograms,
    validateExecutable: (filePath) => concurrent.fsOps.statSync(filePath),
    fsOps: concurrent.fsOps,
  });
  assert.equal(concurrent.events.some(([name, from]) => name === 'rename' && from === path.resolve(concurrentStaging)), false);
  assert.equal(concurrent.events.some(([name, target]) => name === 'rm' && target === path.resolve(concurrentStaging)), true);
});

test('post-switch validation uses current and atomically restores the old target on failure', async () => {
  const releaseDir = path.resolve('virtual-rollback', 'Release');
  const harness = createFsHarness();
  const current = path.join(releaseDir, 'current');
  seedPublishedBuild(harness, releaseDir);
  const stagingDir = seedStaging(harness, releaseDir);
  const finalPaths = [];
  await assert.rejects(
    publishBuild({
      stagingDir,
      releaseDir,
      fingerprint: '8'.repeat(64),
      requiredPrograms: ['dds_calc', 'dds_solve'],
      validateExecutable(filePath) {
        finalPaths.push(filePath);
        if (filePath === path.join(current, 'dds_solve')) throw new Error('post-switch verify broke');
        return harness.fsOps.statSync(filePath);
      },
      fsOps: harness.fsOps,
    }),
    /post-switch verify broke/,
  );
  assert.deepEqual(finalPaths.slice(-2), [path.join(current, 'dds_calc'), path.join(current, 'dds_solve')]);
  assert.equal(harness.fsOps.readlinkSync(current), path.join('builds', 'old'));
  assert.equal(harness.events.filter(([name, , to]) => name === 'rename' && to === path.resolve(current)).length, 2);
});

test('publication link creation or pre-switch rename failure preserves current and names its path', async () => {
  for (const failure of ['symlink', 'rename']) {
    const releaseDir = path.resolve(`virtual-${failure}-failure`, 'Release');
    const harness = createFsHarness({
      failSymlink: failure === 'symlink',
      failCurrentRename: failure === 'rename',
    });
    const current = path.join(releaseDir, 'current');
    seedPublishedBuild(harness, releaseDir);
    const stagingDir = seedStaging(harness, releaseDir);
    await assert.rejects(
      publishBuild({
        stagingDir,
        releaseDir,
        fingerprint: '9'.repeat(64),
        requiredPrograms: ['dds_calc', 'dds_solve'],
        validateExecutable: (filePath) => harness.fsOps.statSync(filePath),
        fsOps: harness.fsOps,
      }),
      (error) => error.message.includes(current),
    );
    assert.equal(harness.fsOps.readlinkSync(current), path.join('builds', 'old'));
  }
});

test('first install creates current and failed post-verification restores its absence', async () => {
  for (const shouldFail of [false, true]) {
    const releaseDir = path.resolve(`virtual-first-${shouldFail}`, 'Release');
    const harness = createFsHarness();
    const current = path.join(releaseDir, 'current');
    const stagingDir = seedStaging(harness, releaseDir);
    const operation = publishBuild({
      stagingDir,
      releaseDir,
      fingerprint: (shouldFail ? 'a' : 'b').repeat(64),
      requiredPrograms: ['dds_calc', 'dds_solve'],
      validateExecutable(filePath) {
        if (shouldFail && filePath.startsWith(`${current}${path.sep}`)) throw new Error('first verify broke');
        return harness.fsOps.statSync(filePath);
      },
      fsOps: harness.fsOps,
    });
    if (shouldFail) {
      await assert.rejects(operation, /first verify broke/);
      assert.equal(harness.fsOps.existsSync(current), false);
      assert.equal(harness.events.some(([name, target]) => name === 'unlink' && target === path.resolve(current)), true);
    } else {
      const result = await operation;
      assert.equal(harness.fsOps.readlinkSync(result.activeDir), path.join('builds', 'b'.repeat(64)));
    }
  }
});
