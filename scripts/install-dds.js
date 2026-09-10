'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { resolveDdsPaths } = require('../dds-paths');
const {
  buildMacDds,
  canonicalizeCompileArgs,
  computeBuildFingerprint,
  createCompileArgs,
  discoverDdsSources,
  isBuildCacheHit,
  runCommand,
  validateDdsOverrides,
} = require('./dds-build');

const PROGRAMS = [
  { key: 'calc', name: 'dds_calc', source: path.join('native', 'dds-cli', 'dds_calc.cpp') },
  { key: 'solve', name: 'dds_solve', source: path.join('native', 'dds-cli', 'dds_solve.cpp') },
];
const SUBMODULE_ARGS = ['submodule', 'update', '--init', '--recursive', '--', 'dds'];
const SUBMODULE_COMMAND = `git ${SUBMODULE_ARGS.join(' ')}`;

function commandDiagnostics(result) {
  return [result && result.stderr, result && result.error && result.error.message]
    .filter(Boolean)
    .join('\n');
}

async function ensureDdsSource({
  rootDir,
  runCommand: runCommandFn = runCommand,
  existsSync = fs.existsSync,
}) {
  const sourcePath = path.join(rootDir, 'dds', 'library', 'src');
  if (existsSync(sourcePath)) return sourcePath;

  const gitMetadataPath = path.join(rootDir, '.git');
  let diagnostics = '';
  if (existsSync(gitMetadataPath)) {
    const result = runCommandFn('git', SUBMODULE_ARGS, { cwd: rootDir });
    diagnostics = commandDiagnostics(result);
    if (result && result.status === 0 && !result.error && existsSync(sourcePath)) return sourcePath;
  } else {
    diagnostics = 'This installation is not a Git checkout (it may be a source archive).';
  }

  const detail = diagnostics ? ` Diagnostics: ${diagnostics}` : '';
  throw new Error(
    `DDS source directory is missing: ${sourcePath}. Run ${SUBMODULE_COMMAND} from the project root or initialize the DDS sources manually.${detail}`,
  );
}

function requireSuccessfulCommand(result, description) {
  if (result && result.status === 0 && !result.error) return result;
  const diagnostics = commandDiagnostics(result);
  throw new Error(
    `${description} failed. Install Apple's command line tools with xcode-select --install${diagnostics ? `: ${diagnostics}` : ''}`,
    result && result.error ? { cause: result.error } : undefined,
  );
}

async function installDds(options = {}) {
  const {
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    rootDir = path.resolve(__dirname, '..'),
    logger = console,
    deps: suppliedDeps = {},
  } = options;

  if (platform !== 'darwin') {
    logger.log(`[DDS install] Skipping DDS build on ${platform}.`);
    return { status: 'skipped', paths: null };
  }

  const deps = {
    resolveDdsPaths,
    validateDdsOverrides,
    ensureDdsSource,
    runCommand,
    discoverDdsSources,
    createCompileArgs,
    canonicalizeCompileArgs,
    computeBuildFingerprint,
    isBuildCacheHit,
    buildMacDds,
    ...suppliedDeps,
  };
  const absoluteRoot = path.resolve(rootDir);
  const paths = deps.resolveDdsPaths({ rootDir: absoluteRoot, platform, arch, env });
  const overridden = deps.validateDdsOverrides(paths);
  if (overridden.calc && overridden.solve) return { status: 'overridden', paths };

  await deps.ensureDdsSource({ rootDir: absoluteRoot, runCommand: deps.runCommand });

  const xcrun = requireSuccessfulCommand(
    deps.runCommand('xcrun', ['--find', 'clang++'], { cwd: absoluteRoot }),
    'Unable to locate clang++ with xcrun',
  );
  const compilerPath = xcrun.stdout.trim();
  if (!compilerPath) {
    throw new Error('xcrun returned no clang++ path. Install Apple\'s command line tools with xcode-select --install');
  }
  const version = requireSuccessfulCommand(
    deps.runCommand(compilerPath, ['--version'], { cwd: absoluteRoot }),
    `Unable to run compiler ${compilerPath}`,
  );
  const compilerIdentity = `${compilerPath}\n${version.stdout.trim()}`;

  const selectedPrograms = PROGRAMS.filter((program) => !overridden[program.key]);
  const sourceRoot = path.join(absoluteRoot, 'dds', 'library', 'src');
  const cliSources = selectedPrograms.map((program) => path.join(absoluteRoot, program.source));
  const sourcePlan = deps.discoverDdsSources({
    sourceRoot,
    projectRoot: absoluteRoot,
    cliSources,
  });
  sourcePlan.cliSources = Object.fromEntries(selectedPrograms.map((program) => [
    program.key,
    path.join(absoluteRoot, program.source),
  ]));
  const releaseDir = path.join(absoluteRoot, 'dds', 'Build', 'bin', `darwin-${arch}`, 'Release');
  const compileArgsByProgram = {};
  for (const program of selectedPrograms) {
    const cliSource = path.join(absoluteRoot, program.source);
    const outputPath = path.join(releaseDir, '.fingerprint-output', program.name);
    const args = deps.createCompileArgs({
      arch,
      includeDir: sourceRoot,
      librarySources: sourcePlan.compileSources,
      cliSource,
      outputPath,
    });
    compileArgsByProgram[program.name] = deps.canonicalizeCompileArgs({
      args,
      projectRoot: absoluteRoot,
      outputPath,
      programName: program.name,
    });
  }

  const fingerprint = deps.computeBuildFingerprint({
    files: sourcePlan.fingerprintFiles,
    platform,
    arch,
    compilerIdentity,
    compileArgsByProgram,
  });
  const requiredPrograms = selectedPrograms.map((program) => program.name);
  const activeDir = path.join(releaseDir, 'current');
  if (deps.isBuildCacheHit({ activeDir, fingerprint, requiredPrograms })) {
    return { status: 'cached', paths, fingerprint };
  }

  try {
    await deps.buildMacDds({
      rootDir: absoluteRoot,
      arch,
      compilerPath,
      compilerIdentity,
      paths,
      overridden,
      sourcePlan,
      fingerprint,
      releaseDir,
      runCommand: deps.runCommand,
    });
  } catch (error) {
    throw new Error(`DDS build failed for ${arch}: ${error.message}`, { cause: error });
  }
  return { status: 'built', paths, fingerprint };
}

async function main() {
  await installDds();
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[DDS install] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { ensureDdsSource, installDds };
