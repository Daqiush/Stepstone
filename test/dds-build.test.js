'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
      lstatSync(filePath) { return fs.lstatSync(resolveLinkedPath(filePath)); },
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
    mkdirSync(directory, options = {}) {
      const absolute = normalize(directory);
      events.push(['mkdir', absolute]);
      if (directories.has(absolute) && !options.recursive) {
        const error = new Error(`EEXIST: ${absolute}`);
        error.code = 'EEXIST';
        throw error;
      }
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
    lstatSync(filePath) {
      const absolute = normalize(filePath);
      events.push(['lstat', absolute]);
      if (links.has(absolute)) return { isFile: () => false, isSymbolicLink: () => true };
      const resolved = resolveLinkedPath(absolute);
      if (files.has(resolved)) return { isFile: () => true, isSymbolicLink: () => false };
      if (directories.has(resolved)) return { isFile: () => false, isSymbolicLink: () => false, mtimeMs: 0 };
      throw new Error(`ENOENT: ${absolute}`);
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

function artifactHash(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function seedManifest(harness, directory, fingerprintValue, programs, arch = 'arm64') {
  const hashes = {};
  for (const program of programs) {
    hashes[program] = artifactHash(harness.files.get(path.resolve(directory, program)));
  }
  harness.file(path.join(directory, 'manifest.json'), JSON.stringify({
    version: 1,
    fingerprint: fingerprintValue,
    platform: 'darwin',
    arch,
    programs,
    hashes,
  }));
}

function deterministicPublishDeps(harness, overrides = {}) {
  let randomIndex = 0;
  return {
    platform: 'darwin',
    arch: 'arm64',
    smokeProgram: async (programPath) => harness.fsOps.statSync(programPath),
    randomBytes: () => Buffer.alloc(16, ++randomIndex),
    now: () => 10_000,
    sleep: async () => {},
    ...overrides,
  };
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
    hashes: {
      dds_calc: artifactHash('dds_calc'),
      dds_solve: artifactHash('dds_solve'),
    },
  };

  assert.equal(readBuildManifest(path.join(activeDir, 'missing')), null);
  fs.writeFileSync(manifestPath, '{bad json');
  assert.equal(readBuildManifest(activeDir), null);
  fs.writeFileSync(manifestPath, JSON.stringify({ ...valid, programs: 'dds_calc' }));
  assert.equal(readBuildManifest(activeDir), null);
  const { hashes, ...missingHashes } = valid;
  fs.writeFileSync(manifestPath, JSON.stringify(missingHashes));
  assert.equal(readBuildManifest(activeDir), null);
  fs.writeFileSync(manifestPath, JSON.stringify(valid));
  assert.deepEqual(readBuildManifest(activeDir), valid);
});

test('cache hits require the matching manifest, every named program, and executable artifacts', () => {
  const activeDir = makeTempDirectory();
  const expectedFingerprint = 'b'.repeat(64);
  const programs = ['dds_calc', 'dds_solve'];
  const hashes = Object.fromEntries(programs.map((program) => [program, artifactHash(program)]));
  for (const program of programs) writeFile(path.join(activeDir, program), program);
  const writeManifest = (value) => fs.writeFileSync(path.join(activeDir, 'manifest.json'), JSON.stringify(value));
  writeManifest({ version: 1, fingerprint: expectedFingerprint, platform: 'darwin', arch: 'arm64', programs, hashes });
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
  writeManifest({
    version: 1,
    fingerprint: expectedFingerprint,
    platform: 'darwin',
    arch: 'arm64',
    programs: ['dds_calc'],
    hashes: { dds_calc: hashes.dds_calc },
  });
  assert.equal(check(), false);
  writeManifest({ version: 1, fingerprint: expectedFingerprint, platform: 'darwin', arch: 'arm64', programs, hashes });
  fs.rmSync(path.join(activeDir, 'dds_solve'));
  assert.equal(check(), false);
  writeFile(path.join(activeDir, 'dds_solve'), 'dds_solve');
  nonExecutable.add(path.join(activeDir, 'dds_solve'));
  assert.equal(check(), false);
  nonExecutable.clear();
  fs.writeFileSync(path.join(activeDir, 'dds_solve'), 'tampered');
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
  const manifest = JSON.parse(fs.readFileSync(path.join(result.buildDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.hashes).sort(), ['dds_calc', 'dds_solve']);
  for (const program of manifest.programs) {
    assert.equal(manifest.hashes[program], artifactHash(fs.readFileSync(path.join(result.buildDir, program))));
  }
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
  let compileOptions;

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
      runCommand: (command, args, options) => {
        compileOptions = options;
        return { status: 1, stdout: '', stderr: 'compile broke', error: null };
      },
      smokeCalc: async () => {},
      smokeSolve: async () => {},
      fsOps,
    }),
    (error) => error.message.includes('compile broke') && error.message.includes('arm64'),
  );
  assert.equal(compileOptions.timeout, 600_000);
  assert.equal(fsOps.readlinkSync(current), path.join('builds', 'old'));
  assert.equal(fs.readdirSync(fixture.releaseDir).some((name) => name.startsWith('.staging-')), false);

  const cleanupFixture = makeBuildFixture();
  const cleanupEvents = [];
  const cleanupAdapter = createRealBuildFsOps(cleanupEvents);
  const cleanupFsOps = {
    ...cleanupAdapter.fsOps,
    rmSync() { throw new Error('cleanup broke'); },
  };
  await assert.rejects(
    buildMacDds({
      rootDir: cleanupFixture.projectRoot,
      arch: 'arm64',
      compilerPath: '/usr/bin/clang++',
      compilerIdentity: 'fixture clang',
      paths: {},
      overridden: { calc: false, solve: false },
      sourcePlan: cleanupFixture.sourcePlan,
      fingerprint: 'c'.repeat(64),
      releaseDir: cleanupFixture.releaseDir,
      runCommand: () => ({
        status: null,
        stdout: '',
        stderr: 'compiler still running',
        error: Object.assign(new Error('spawnSync timed out'), { code: 'ETIMEDOUT' }),
      }),
      smokeCalc: async () => {},
      smokeSolve: async () => {},
      fsOps: cleanupFsOps,
    }),
    (error) => {
      assert.match(error.message, /timed out/i);
      assert.match(error.message, /dds_calc/);
      assert.match(error.message, /compiler still running/);
      assert.match(error.cleanupError.message, /cleanup broke/);
      return true;
    },
  );
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

  let finishSolve;
  let solveFinished = false;
  const operation = buildMacDds({
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
      smokeSolve: async () => {
        await new Promise((resolve) => { finishSolve = resolve; });
        solveFinished = true;
      },
      fsOps,
    });
  await new Promise((resolve) => setImmediate(resolve));
  const stagedBeforeSiblingSettles = fs.readdirSync(fixture.releaseDir).some((name) => name.startsWith('.staging-'));
  finishSolve();
  await assert.rejects(operation, /calc smoke broke/);
  assert.equal(stagedBeforeSiblingSettles, true);
  assert.equal(solveFinished, true);
  assert.equal(fsOps.readlinkSync(current), path.join('builds', 'old'));
  assert.equal(fs.readdirSync(fixture.releaseDir).some((name) => name.startsWith('.staging-')), false);
});

test('successful build orders compile, validation, awaited smoke, manifest, and atomic publication', async () => {
  const wrapperModulePath = require.resolve('../dds-wrapper');
  const processModulePath = require.resolve('../dds-process');
  const smokeModulePath = require.resolve('../scripts/smoke-dds');
  const wrapperModule = require(wrapperModulePath);
  const processModule = require(processModulePath);
  const originalCreateDdsClient = wrapperModule.createDdsClient;
  const originalRunDdsProcess = processModule.runDdsProcess;
  let smokeTimeout;
  processModule.runDdsProcess = (programPath, input, spawnImpl, options) => {
    smokeTimeout = options.timeoutMs;
    return Promise.resolve('fixture');
  };
  wrapperModule.createDdsClient = ({ runProcess }) => ({
    solveBoard: async () => {
      await runProcess('fixture-dds-solve', 'fixture-input');
      return {
        score: 1,
        cards: [{ suit: 'S', rank: 2 }, { suit: 'H', rank: 2 }],
      };
    },
  });
  delete require.cache[smokeModulePath];
  try {
    const { smokeSolve } = require(smokeModulePath);
    await assert.doesNotReject(smokeSolve(path.resolve('fixture-dds-solve')));
    assert.equal(smokeTimeout, 30_000);
  } finally {
    wrapperModule.createDdsClient = originalCreateDdsClient;
    processModule.runDdsProcess = originalRunDdsProcess;
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
  seedManifest(first, firstStaging, fingerprintValue, requiredPrograms);
  const result = await publishBuild({
    stagingDir: firstStaging,
    releaseDir,
    fingerprint: fingerprintValue,
    requiredPrograms,
    validateExecutable: (filePath) => first.fsOps.statSync(filePath),
    fsOps: first.fsOps,
    ...deterministicPublishDeps(first),
  });
  assert.deepEqual(result, {
    buildDir: path.join(releaseDir, 'builds', fingerprintValue),
    activeDir: path.join(releaseDir, 'current'),
  });
  assert.equal(first.events.some(([name, from, to]) => name === 'rename' && from === path.resolve(firstStaging) && to === path.resolve(result.buildDir)), true);

  const concurrent = createFsHarness();
  const concurrentStaging = seedStaging(concurrent, releaseDir, requiredPrograms);
  seedManifest(concurrent, concurrentStaging, fingerprintValue, requiredPrograms);
  concurrent.directory(result.buildDir);
  for (const program of requiredPrograms) concurrent.file(path.join(result.buildDir, program));
  seedManifest(concurrent, result.buildDir, fingerprintValue, requiredPrograms);
  const reusedSmokes = [];
  await publishBuild({
    stagingDir: concurrentStaging,
    releaseDir,
    fingerprint: fingerprintValue,
    requiredPrograms,
    validateExecutable: (filePath) => concurrent.fsOps.statSync(filePath),
    fsOps: concurrent.fsOps,
    ...deterministicPublishDeps(concurrent, {
      smokeProgram: async (programPath) => reusedSmokes.push(programPath),
    }),
  });
  assert.equal(concurrent.events.some(([name, from]) => name === 'rename' && from === path.resolve(concurrentStaging)), false);
  assert.equal(concurrent.events.some(([name, target]) => name === 'rm' && target === path.resolve(concurrentStaging)), true);
  assert.deepEqual(reusedSmokes, requiredPrograms.map((program) => path.join(result.buildDir, program)));

  for (const defect of ['missing-manifest', 'corrupt-manifest', 'hash-mismatch', 'symlink-artifact']) {
    const repairRelease = path.resolve(`virtual-repair-${defect}`, 'Release');
    const repair = createFsHarness();
    const repairStaging = seedStaging(repair, repairRelease, requiredPrograms);
    seedManifest(repair, repairStaging, fingerprintValue, requiredPrograms);
    const corruptBuild = path.join(repairRelease, 'builds', fingerprintValue);
    repair.directory(corruptBuild);
    for (const program of requiredPrograms) repair.file(path.join(corruptBuild, program), 'corrupt');
    if (defect !== 'missing-manifest') seedManifest(repair, corruptBuild, fingerprintValue, requiredPrograms);
    if (defect === 'corrupt-manifest') {
      repair.file(path.join(corruptBuild, 'manifest.json'), '{not-json');
    }
    if (defect === 'hash-mismatch') {
      const manifestPath = path.join(corruptBuild, 'manifest.json');
      const manifest = JSON.parse(repair.files.get(path.resolve(manifestPath)));
      manifest.hashes.dds_calc = '0'.repeat(64);
      repair.file(manifestPath, JSON.stringify(manifest));
    }
    if (defect === 'symlink-artifact') {
      repair.files.delete(path.resolve(corruptBuild, 'dds_calc'));
      repair.link(path.join(corruptBuild, 'dds_calc'), path.join('..', 'outside-dds'));
    }
    const repaired = await publishBuild({
      stagingDir: repairStaging,
      releaseDir: repairRelease,
      fingerprint: fingerprintValue,
      requiredPrograms,
      validateExecutable: (filePath) => repair.fsOps.statSync(filePath),
      fsOps: repair.fsOps,
      ...deterministicPublishDeps(repair),
    });
    assert.equal(repair.fsOps.readFileSync(path.join(repaired.buildDir, 'dds_calc'), 'utf8'), 'binary');
    assert.equal(repair.events.some(([name, from, to]) => (
      name === 'rename'
      && from === path.resolve(corruptBuild)
      && path.basename(to).startsWith(`${fingerprintValue}.invalid-`)
    )), true);
  }
});

test('post-switch validation uses current and atomically restores the old target on failure', async () => {
  const releaseDir = path.resolve('virtual-rollback', 'Release');
  const harness = createFsHarness();
  const current = path.join(releaseDir, 'current');
  seedPublishedBuild(harness, releaseDir);
  const stagingDir = seedStaging(harness, releaseDir);
  seedManifest(harness, stagingDir, '8'.repeat(64), ['dds_calc', 'dds_solve']);
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
      ...deterministicPublishDeps(harness),
    }),
    /post-switch verify broke/,
  );
  assert.deepEqual(finalPaths.slice(-2), [path.join(current, 'dds_calc'), path.join(current, 'dds_solve')]);
  assert.equal(harness.fsOps.readlinkSync(current), path.join('builds', 'old'));
  assert.equal(harness.events.filter(([name, , to]) => name === 'rename' && to === path.resolve(current)).length, 2);

  const serializedRelease = path.resolve('virtual-serialized', 'Release');
  const serialized = createFsHarness();
  seedPublishedBuild(serialized, serializedRelease);
  const firstFingerprint = 'd'.repeat(64);
  const secondFingerprint = 'e'.repeat(64);
  const firstBuild = path.join(serializedRelease, 'builds', firstFingerprint);
  serialized.directory(firstBuild);
  serialized.file(path.join(firstBuild, 'dds_calc'));
  seedManifest(serialized, firstBuild, firstFingerprint, ['dds_calc']);
  const firstUnusedStage = seedStaging(serialized, serializedRelease, ['dds_calc']);
  seedManifest(serialized, firstUnusedStage, firstFingerprint, ['dds_calc']);
  const secondStage = path.join(serializedRelease, '.staging-second');
  serialized.directory(secondStage);
  serialized.file(path.join(secondStage, 'dds_solve'));
  seedManifest(serialized, secondStage, secondFingerprint, ['dds_solve']);
  let releaseFirstSmoke;
  const firstSmokeStarted = new Promise((resolve) => {
    releaseFirstSmoke = { started: resolve, finish: null };
  });
  const firstSmokeGate = new Promise((resolve) => { releaseFirstSmoke.finish = resolve; });
  let retrySecond;
  const secondWait = new Promise((resolve) => { retrySecond = resolve; });
  const firstPublish = publishBuild({
    stagingDir: firstUnusedStage,
    releaseDir: serializedRelease,
    fingerprint: firstFingerprint,
    requiredPrograms: ['dds_calc'],
    validateExecutable: (filePath) => serialized.fsOps.statSync(filePath),
    fsOps: serialized.fsOps,
    ...deterministicPublishDeps(serialized, {
      smokeProgram: async () => {
        releaseFirstSmoke.started();
        await firstSmokeGate;
      },
    }),
  });
  await Promise.race([
    firstSmokeStarted,
    firstPublish.then(() => { throw new Error('publication bypassed reused-build smoke'); }),
  ]);
  let secondValidated = false;
  const secondPublish = publishBuild({
    stagingDir: secondStage,
    releaseDir: serializedRelease,
    fingerprint: secondFingerprint,
    requiredPrograms: ['dds_solve'],
    validateExecutable(filePath) {
      secondValidated = true;
      return serialized.fsOps.statSync(filePath);
    },
    fsOps: serialized.fsOps,
    ...deterministicPublishDeps(serialized, { sleep: () => secondWait }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondValidated, false);
  assert.equal(serialized.fsOps.readlinkSync(path.join(serializedRelease, 'current')), path.join('builds', 'old'));
  releaseFirstSmoke.finish();
  await firstPublish;
  retrySecond();
  await secondPublish;
  assert.equal(serialized.fsOps.readlinkSync(path.join(serializedRelease, 'current')), path.join('builds', secondFingerprint));
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
    seedManifest(harness, stagingDir, '9'.repeat(64), ['dds_calc', 'dds_solve']);
    await assert.rejects(
      publishBuild({
        stagingDir,
        releaseDir,
        fingerprint: '9'.repeat(64),
        requiredPrograms: ['dds_calc', 'dds_solve'],
        validateExecutable: (filePath) => harness.fsOps.statSync(filePath),
        fsOps: harness.fsOps,
        ...deterministicPublishDeps(harness),
      }),
      (error) => error.message.includes(current),
    );
    assert.equal(harness.fsOps.readlinkSync(current), path.join('builds', 'old'));
  }

  const staleRelease = path.resolve('virtual-stale-lock', 'Release');
  const stale = createFsHarness();
  const staleFingerprint = 'f'.repeat(64);
  const staleStage = seedStaging(stale, staleRelease);
  seedManifest(stale, staleStage, staleFingerprint, ['dds_calc', 'dds_solve']);
  const lockDir = path.join(staleRelease, '.publish-lock');
  stale.directory(lockDir);
  stale.file(path.join(lockDir, 'owner.json'), JSON.stringify({ owner: 'dead', createdAt: 0 }));
  await publishBuild({
    stagingDir: staleStage,
    releaseDir: staleRelease,
    fingerprint: staleFingerprint,
    requiredPrograms: ['dds_calc', 'dds_solve'],
    validateExecutable: (filePath) => stale.fsOps.statSync(filePath),
    fsOps: stale.fsOps,
    ...deterministicPublishDeps(stale, { lockStaleMs: 100 }),
  });
  assert.equal(stale.events.some(([name, from, to]) => (
    name === 'rename'
    && from === path.resolve(lockDir)
    && path.basename(to).startsWith('.publish-lock.stale-')
  )), true);

  const metadataRelease = path.resolve('virtual-lock-metadata-failure', 'Release');
  const metadata = createFsHarness();
  const metadataStage = seedStaging(metadata, metadataRelease);
  seedManifest(metadata, metadataStage, staleFingerprint, ['dds_calc', 'dds_solve']);
  const metadataFsOps = {
    ...metadata.fsOps,
    writeFileSync(filePath, contents) {
      if (path.basename(filePath) === 'owner.json') throw new Error('owner metadata broke');
      return metadata.fsOps.writeFileSync(filePath, contents);
    },
  };
  await assert.rejects(publishBuild({
    stagingDir: metadataStage,
    releaseDir: metadataRelease,
    fingerprint: staleFingerprint,
    requiredPrograms: ['dds_calc', 'dds_solve'],
    validateExecutable: (filePath) => metadata.fsOps.statSync(filePath),
    fsOps: metadataFsOps,
    ...deterministicPublishDeps(metadata),
  }), /owner metadata broke/);
  assert.equal(metadata.fsOps.existsSync(path.join(metadataRelease, '.publish-lock')), false);

  const boundedRelease = path.resolve('virtual-bounded-lock', 'Release');
  const bounded = createFsHarness();
  const boundedStage = seedStaging(bounded, boundedRelease);
  seedManifest(bounded, boundedStage, staleFingerprint, ['dds_calc', 'dds_solve']);
  const boundedLock = path.join(boundedRelease, '.publish-lock');
  bounded.directory(boundedLock);
  bounded.file(path.join(boundedLock, 'owner.json'), JSON.stringify({ owner: 'live', createdAt: 1_000 }));
  let clock = 1_000;
  let waits = 0;
  await assert.rejects(publishBuild({
    stagingDir: boundedStage,
    releaseDir: boundedRelease,
    fingerprint: staleFingerprint,
    requiredPrograms: ['dds_calc', 'dds_solve'],
    validateExecutable: (filePath) => bounded.fsOps.statSync(filePath),
    fsOps: bounded.fsOps,
    ...deterministicPublishDeps(bounded, {
      now: () => clock,
      sleep: async (delayMs) => { waits += 1; clock += delayMs; },
      lockRetryMs: 2,
      lockTimeoutMs: 5,
      lockStaleMs: 100,
      lockMaxAttempts: 4,
    }),
  }), /timed out.*publication lock/i);
  assert.equal(waits, 3);
});

test('first install creates current and failed post-verification restores its absence', async () => {
  for (const shouldFail of [false, true]) {
    const releaseDir = path.resolve(`virtual-first-${shouldFail}`, 'Release');
    const harness = createFsHarness();
    const current = path.join(releaseDir, 'current');
    const stagingDir = seedStaging(harness, releaseDir);
    const fingerprintValue = (shouldFail ? 'a' : 'b').repeat(64);
    seedManifest(harness, stagingDir, fingerprintValue, ['dds_calc', 'dds_solve']);
    const operation = publishBuild({
      stagingDir,
      releaseDir,
      fingerprint: fingerprintValue,
      requiredPrograms: ['dds_calc', 'dds_solve'],
      validateExecutable(filePath) {
        if (shouldFail && filePath.startsWith(`${current}${path.sep}`)) throw new Error('first verify broke');
        return harness.fsOps.statSync(filePath);
      },
      fsOps: harness.fsOps,
      ...deterministicPublishDeps(harness),
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
