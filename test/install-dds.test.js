'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { ensureDdsSource, installDds } = require('../scripts/install-dds');

const ROOT = path.resolve('fixture-project');

function makePaths(overridden = { calc: false, solve: false }, arch = 'arm64') {
  const releaseDir = path.join(ROOT, 'dds', 'Build', 'bin', `darwin-${arch}`, 'Release');
  return {
    calc: overridden.calc ? path.join(ROOT, 'custom-calc') : path.join(releaseDir, 'current', 'dds_calc'),
    solve: overridden.solve ? path.join(ROOT, 'custom-solve') : path.join(releaseDir, 'current', 'dds_solve'),
    overridden,
    platform: 'darwin',
    arch,
  };
}

function recordingDeps(options = {}) {
  const calls = [];
  const paths = options.paths || makePaths();
  const deps = {
    resolveDdsPaths(args) {
      calls.push(['resolve', args.platform, args.arch]);
      if (args.arch === 'ppc') throw new Error('Unsupported DDS architecture on darwin: ppc');
      return paths;
    },
    validateDdsOverrides(received) {
      calls.push(['validate', received]);
      if (options.overrideError) throw options.overrideError;
      return { ...received.overridden };
    },
    async ensureDdsSource(args) {
      calls.push(['source', args.rootDir]);
    },
    runCommand(command, args, commandOptions) {
      calls.push(['command', command, args, commandOptions]);
      if (command === 'xcrun') return { status: 0, stdout: '/usr/bin/clang++\n', stderr: '', error: null };
      return { status: 0, stdout: 'Apple clang version 17.0.0\nTarget: test\n', stderr: '', error: null };
    },
    discoverDdsSources(args) {
      calls.push(['discover', args]);
      return { compileSources: ['lib.cpp'], fingerprintFiles: [{ relativePath: 'lib.cpp', absolutePath: 'lib.cpp' }] };
    },
    createCompileArgs(args) {
      calls.push(['compileArgs', args]);
      return ['-arch', args.arch, args.cliSource, '-o', args.outputPath];
    },
    canonicalizeCompileArgs(args) {
      calls.push(['canonicalize', args]);
      return [`canonical:${args.programName}`];
    },
    computeBuildFingerprint(args) {
      calls.push(['fingerprint', args]);
      return 'f'.repeat(64);
    },
    isBuildCacheHit(args) {
      calls.push(['cache', args]);
      return Boolean(options.cacheHit);
    },
    async buildMacDds(args) {
      calls.push(['build', args]);
      if (options.buildError) throw options.buildError;
      return { activeDir: path.dirname(paths.calc) };
    },
  };
  return { calls, deps, paths };
}

test('non-macOS installs are skipped without touching DDS build tooling', async (t) => {
  for (const platform of ['win32', 'linux']) {
    await t.test(platform, async () => {
      const { calls, deps } = recordingDeps();
      const logs = [];
      const result = await installDds({ platform, arch: 'x64', rootDir: ROOT, logger: { log: (line) => logs.push(line) }, deps });

      assert.deepEqual(result, { status: 'skipped', paths: null });
      assert.equal(logs.length, 1);
      assert.match(logs[0], /DDS.*skip/i);
      assert.deepEqual(calls, []);
    });
  }
});

test('Darwin rejects unsupported architecture before compiler discovery', async () => {
  const { calls, deps } = recordingDeps();
  await assert.rejects(installDds({ platform: 'darwin', arch: 'ppc', rootDir: ROOT, deps }), /unsupported.*ppc/i);
  assert.deepEqual(calls, [['resolve', 'darwin', 'ppc']]);
});

test('two valid overrides return overridden without source or build work', async () => {
  const paths = makePaths({ calc: true, solve: true });
  const { calls, deps } = recordingDeps({ paths });
  const result = await installDds({ platform: 'darwin', arch: 'arm64', rootDir: ROOT, deps });

  assert.deepEqual(result, { status: 'overridden', paths });
  assert.deepEqual(calls.map((call) => call[0]), ['resolve', 'validate']);
});

test('an invalid override fails before source and compiler discovery', async () => {
  const paths = makePaths({ calc: true, solve: false });
  const overrideError = new Error(`Invalid DDS executable ${paths.calc}`);
  const { calls, deps } = recordingDeps({ paths, overrideError });

  await assert.rejects(installDds({ platform: 'darwin', arch: 'arm64', rootDir: ROOT, deps }), new RegExp(paths.calc.replaceAll('\\', '\\\\')));
  assert.deepEqual(calls.map((call) => call[0]), ['resolve', 'validate']);
});

test('one calc override fingerprints and builds only the solver', async () => {
  const paths = makePaths({ calc: true, solve: false });
  const { calls, deps } = recordingDeps({ paths });
  const result = await installDds({ platform: 'darwin', arch: 'arm64', rootDir: ROOT, deps });

  assert.equal(result.status, 'built');
  const discover = calls.find((call) => call[0] === 'discover')[1];
  assert.deepEqual(discover.cliSources, [path.join(ROOT, 'native', 'dds-cli', 'dds_solve.cpp')]);
  assert.deepEqual(calls.filter((call) => call[0] === 'compileArgs').map((call) => call[1].cliSource), [path.join(ROOT, 'native', 'dds-cli', 'dds_solve.cpp')]);
  const build = calls.find((call) => call[0] === 'build')[1];
  assert.deepEqual(build.overridden, { calc: true, solve: false });
  assert.deepEqual(build.sourcePlan.cliSources, {
    solve: path.join(ROOT, 'native', 'dds-cli', 'dds_solve.cpp'),
  });
});

test('missing DDS source initializes the scoped git submodule and then continues', async () => {
  const sourcePath = path.join(ROOT, 'dds', 'library', 'src');
  const calls = [];
  let initialized = false;
  await ensureDdsSource({
    rootDir: ROOT,
    existsSync(candidate) {
      if (candidate === path.join(ROOT, '.git')) return true;
      if (candidate === sourcePath) return initialized;
      return false;
    },
    runCommand(command, args, options) {
      calls.push([command, args, options]);
      initialized = true;
      return { status: 0, stdout: '', stderr: '', error: null };
    },
  });

  assert.deepEqual(calls, [['git', ['submodule', 'update', '--init', '--recursive', '--', 'dds'], { cwd: ROOT }]]);
});

test('missing DDS source reports git diagnostics or source archive guidance before compilation', async (t) => {
  for (const scenario of ['failed-init', 'source-archive']) {
    await t.test(scenario, async () => {
      const hasGit = scenario === 'failed-init';
      const runCommand = () => ({ status: 1, stdout: '', stderr: 'fatal: network unavailable', error: null });
      await assert.rejects(
        ensureDdsSource({
          rootDir: ROOT,
          existsSync: (candidate) => candidate === path.join(ROOT, '.git') && hasGit,
          runCommand,
        }),
        (error) => {
          assert.match(error.message, /dds[\\/]library[\\/]src/);
          assert.match(error.message, /git submodule update --init --recursive -- dds/);
          assert.match(error.message, hasGit ? /network unavailable/ : /Git checkout|source archive/i);
          return true;
        },
      );
    });
  }
});

test('Darwin resolves clang before reading its version and fingerprints the compiler identity', async () => {
  const { calls, deps } = recordingDeps();
  await installDds({ platform: 'darwin', arch: 'arm64', rootDir: ROOT, deps });

  const commands = calls.filter((call) => call[0] === 'command');
  assert.deepEqual(commands.map((call) => [call[1], call[2]]), [
    ['xcrun', ['--find', 'clang++']],
    ['/usr/bin/clang++', ['--version']],
  ]);
  const fingerprint = calls.find((call) => call[0] === 'fingerprint')[1];
  assert.equal(fingerprint.compilerIdentity, '/usr/bin/clang++\nApple clang version 17.0.0\nTarget: test');
});

test('missing xcrun or compiler advises installing Xcode command line tools', async (t) => {
  for (const missing of ['xcrun', 'compiler']) {
    await t.test(missing, async () => {
      const { deps } = recordingDeps();
      deps.runCommand = (command) => {
        if (missing === 'xcrun' || command !== 'xcrun') {
          return { status: 1, stdout: '', stderr: `${command} missing`, error: new Error('ENOENT') };
        }
        return { status: 0, stdout: '/missing/clang++\n', stderr: '', error: null };
      };
      await assert.rejects(
        installDds({ platform: 'darwin', arch: 'arm64', rootDir: ROOT, deps }),
        /xcode-select --install/,
      );
    });
  }
});

test('cache hits skip builds, misses build, and build failures retain diagnostics and architecture', async (t) => {
  await t.test('cache hit', async () => {
    const { calls, deps, paths } = recordingDeps({ cacheHit: true });
    const result = await installDds({ platform: 'darwin', arch: 'x64', rootDir: ROOT, deps });
    assert.deepEqual(result, { status: 'cached', paths, fingerprint: 'f'.repeat(64) });
    assert.equal(calls.some((call) => call[0] === 'build'), false);
  });

  await t.test('cache miss', async () => {
    const { calls, deps } = recordingDeps();
    const result = await installDds({ platform: 'darwin', arch: 'arm64', rootDir: ROOT, deps });
    assert.equal(result.status, 'built');
    assert.equal(calls.some((call) => call[0] === 'build'), true);
  });

  await t.test('build failure', async () => {
    const { deps } = recordingDeps({ buildError: new Error('clang stderr: unknown argument') });
    await assert.rejects(
      installDds({ platform: 'darwin', arch: 'x64', rootDir: ROOT, deps }),
      (error) => /clang stderr: unknown argument/.test(error.message) && /x64/.test(error.message),
    );
  });
});
