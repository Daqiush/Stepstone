'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FINGERPRINT_EXTENSIONS = new Set(['.cpp', '.hpp', '.h']);
const REQUIRED_SOURCE_BASENAMES = ['dds.cpp', 'calc_dd_table.cpp', 'solve_board.cpp'];
const MANIFEST_NAME = 'manifest.json';
const PROGRAMS = [
  { key: 'calc', name: 'dds_calc' },
  { key: 'solve', name: 'dds_solve' },
];
const DEFAULT_FS_OPS = {
  mkdirSync: fs.mkdirSync,
  mkdtempSync: fs.mkdtempSync,
  writeFileSync: fs.writeFileSync,
  readFileSync: fs.readFileSync,
  chmodSync: fs.chmodSync,
  statSync: fs.statSync,
  accessSync: fs.accessSync,
  existsSync: fs.existsSync,
  renameSync: fs.renameSync,
  symlinkSync: fs.symlinkSync,
  readlinkSync: fs.readlinkSync,
  unlinkSync: fs.unlinkSync,
  rmSync: fs.rmSync,
};
let publicationTemporaryIndex = 0;

function compareLexically(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function normalizeRelativePath(filePath) {
  return path.posix.normalize(filePath.replaceAll('\\', '/'));
}

function discoverDdsSources({ sourceRoot, projectRoot, cliSources }) {
  const absoluteSourceRoot = path.resolve(sourceRoot);
  const absoluteProjectRoot = path.resolve(projectRoot);
  const compileSources = [];
  const fingerprintPaths = [];

  function walk(directory) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Unable to discover DDS sources under ${absoluteSourceRoot}: ${error.message}`, { cause: error });
    }

    entries.sort((left, right) => compareLexically(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile() && FINGERPRINT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        fingerprintPaths.push(absolutePath);
        if (path.extname(entry.name).toLowerCase() === '.cpp') compileSources.push(absolutePath);
      }
    }
  }

  walk(absoluteSourceRoot);
  compileSources.sort();
  if (compileSources.length === 0) {
    throw new Error(`No DDS C++ sources found under ${absoluteSourceRoot}`);
  }

  for (const cliSource of cliSources || []) fingerprintPaths.push(path.resolve(cliSource));

  const basenames = new Set(compileSources.map((filePath) => path.basename(filePath)));
  const missing = REQUIRED_SOURCE_BASENAMES.filter((basename) => !basenames.has(basename));
  if (missing.length > 0) {
    throw new Error(`Missing required DDS source unit${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
  }

  const uniqueFingerprintPaths = [...new Set(fingerprintPaths)];
  const fingerprintFiles = uniqueFingerprintPaths
    .map((absolutePath) => ({
      absolutePath,
      relativePath: toPosixPath(path.relative(absoluteProjectRoot, absolutePath)),
    }))
    .sort((left, right) => compareLexically(left.relativePath, right.relativePath));

  return { compileSources, fingerprintFiles };
}

function createCompileArgs({ arch, includeDir, librarySources, cliSource, outputPath }) {
  const compilerArch = {
    arm64: 'arm64',
    x64: 'x86_64',
  }[arch];
  if (!compilerArch) throw new Error(`Unsupported DDS build architecture: ${arch}`);

  return [
    '-std=c++20',
    '-O3',
    '-mtune=generic',
    '-fPIC',
    '-pthread',
    '-I',
    includeDir,
    '-arch',
    compilerArch,
    ...[...librarySources].sort(),
    cliSource,
    '-o',
    outputPath,
  ];
}

function isPathInsideRoot(candidatePath, rootPath) {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === ''
    || (!path.isAbsolute(relativePath)
      && relativePath !== '..'
      && !relativePath.startsWith(`..${path.sep}`));
}

function canonicalizeCompileArgs({ args, projectRoot, outputPath, programName }) {
  const absoluteProjectRoot = path.resolve(projectRoot);

  return args.map((argument, index) => {
    if (index > 0 && args[index - 1] === '-o') {
      if (argument !== outputPath) {
        throw new Error(`Compiler output argument ${argument} does not match outputPath ${outputPath}`);
      }
      return `<OUTPUT>/${programName}`;
    }
    if (typeof argument !== 'string' || !path.isAbsolute(argument)) return argument;

    const absoluteArgument = path.resolve(argument);
    if (!isPathInsideRoot(absoluteArgument, absoluteProjectRoot)) return argument;
    const relativePath = path.relative(absoluteProjectRoot, absoluteArgument);
    return relativePath
      ? `<PROJECT_ROOT>/${toPosixPath(relativePath)}`
      : '<PROJECT_ROOT>';
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function updateUint64(hash, value) {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(BigInt(value));
  hash.update(encoded);
}

function updateLengthPrefixed(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  updateUint64(hash, bytes.length);
  hash.update(bytes);
}

function computeBuildFingerprint({ files, platform, arch, compilerIdentity, compileArgsByProgram }) {
  const hash = crypto.createHash('sha256');
  const sortedFiles = files
    .map((file) => ({ ...file, relativePath: normalizeRelativePath(file.relativePath) }))
    .sort((left, right) => compareLexically(left.relativePath, right.relativePath));

  hash.update('stepstone-dds-build-fingerprint-v1', 'utf8');
  updateUint64(hash, sortedFiles.length);
  for (const file of sortedFiles) {
    updateLengthPrefixed(hash, file.relativePath);
    updateLengthPrefixed(hash, fs.readFileSync(file.absolutePath));
  }

  updateLengthPrefixed(hash, stableJson({ platform, arch, compilerIdentity, compileArgsByProgram }));
  return hash.digest('hex');
}

function validateExecutable(filePath, {
  platform = process.platform,
  statSync = fs.statSync,
  accessSync = fs.accessSync,
} = {}) {
  try {
    const stats = statSync(filePath);
    if (!stats || typeof stats.isFile !== 'function' || !stats.isFile()) {
      throw new Error('not a regular file');
    }
    if (platform === 'darwin') accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (error) {
    throw new Error(`Invalid DDS executable ${filePath}: ${error.message}`, { cause: error });
  }
}

function validateDdsOverrides(paths, { validateExecutableFn = validateExecutable } = {}) {
  const validated = { calc: false, solve: false };
  for (const program of ['calc', 'solve']) {
    if (paths.overridden && paths.overridden[program] === true) {
      validateExecutableFn(paths[program]);
      validated[program] = true;
    }
  }
  return validated;
}

function isValidBuildManifest(manifest) {
  return Boolean(
    manifest
    && typeof manifest === 'object'
    && !Array.isArray(manifest)
    && manifest.version === 1
    && typeof manifest.fingerprint === 'string'
    && /^[0-9a-f]{64}$/.test(manifest.fingerprint)
    && typeof manifest.platform === 'string'
    && manifest.platform.length > 0
    && typeof manifest.arch === 'string'
    && manifest.arch.length > 0
    && Array.isArray(manifest.programs)
    && manifest.programs.every((program) => typeof program === 'string' && program.length > 0)
  );
}

function readBuildManifest(activeDir, { readFileSync = fs.readFileSync } = {}) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(activeDir, MANIFEST_NAME), 'utf8'));
    if (!isValidBuildManifest(manifest)) return null;
    return {
      version: manifest.version,
      fingerprint: manifest.fingerprint,
      platform: manifest.platform,
      arch: manifest.arch,
      programs: manifest.programs,
    };
  } catch {
    return null;
  }
}

function isBuildCacheHit({
  activeDir,
  fingerprint,
  requiredPrograms,
  readManifestFn = readBuildManifest,
  validateExecutableFn = validateExecutable,
}) {
  try {
    const manifest = readManifestFn(activeDir);
    if (!manifest || manifest.fingerprint !== fingerprint || !Array.isArray(manifest.programs)) return false;

    for (const program of requiredPrograms) {
      if (!manifest.programs.includes(program)) return false;
      validateExecutableFn(path.join(activeDir, program));
    }
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

function withFsDefaults(fsOps) {
  return { ...DEFAULT_FS_OPS, ...(fsOps || {}) };
}

function validatePrograms(directory, requiredPrograms, validateExecutableFn) {
  for (const program of requiredPrograms) {
    validateExecutableFn(path.join(directory, program));
  }
}

function removeOwnedPath(fsOps, ownedPath) {
  if (!ownedPath || !fsOps.existsSync(ownedPath)) return;
  fsOps.rmSync(ownedPath, { recursive: true, force: true });
}

async function publishBuild({
  stagingDir,
  releaseDir,
  fingerprint,
  requiredPrograms,
  validateExecutable: validateExecutableFn = validateExecutable,
  fsOps: suppliedFsOps,
}) {
  const fsOps = withFsDefaults(suppliedFsOps);
  const buildsDir = path.join(releaseDir, 'builds');
  const buildDir = path.join(buildsDir, fingerprint);
  const activeDir = path.join(releaseDir, 'current');
  const relativeTarget = path.join('builds', fingerprint);
  let oldTarget = null;
  let stagingOwned = true;
  let temporaryLink = null;

  try {
    fsOps.mkdirSync(buildsDir, { recursive: true });
    if (fsOps.existsSync(activeDir)) oldTarget = fsOps.readlinkSync(activeDir);

    if (fsOps.existsSync(buildDir)) {
      validatePrograms(buildDir, requiredPrograms, validateExecutableFn);
    } else {
      try {
        fsOps.renameSync(stagingDir, buildDir);
        stagingOwned = false;
      } catch (error) {
        if (!fsOps.existsSync(buildDir)) throw error;
        validatePrograms(buildDir, requiredPrograms, validateExecutableFn);
      }
    }

    temporaryLink = path.join(
      releaseDir,
      `.current-${process.pid}-${++publicationTemporaryIndex}`,
    );
    fsOps.symlinkSync(relativeTarget, temporaryLink, 'dir');
    fsOps.renameSync(temporaryLink, activeDir);
    temporaryLink = null;

    try {
      validatePrograms(activeDir, requiredPrograms, validateExecutableFn);
    } catch (verificationError) {
      if (oldTarget === null) {
        fsOps.unlinkSync(activeDir);
      } else {
        const rollbackLink = path.join(
          releaseDir,
          `.current-rollback-${process.pid}-${++publicationTemporaryIndex}`,
        );
        temporaryLink = rollbackLink;
        fsOps.symlinkSync(oldTarget, rollbackLink, 'dir');
        fsOps.renameSync(rollbackLink, activeDir);
        temporaryLink = null;
      }
      throw verificationError;
    }

    return { buildDir, activeDir };
  } catch (error) {
    throw new Error(`Failed to publish DDS build at ${activeDir}: ${error.message}`, { cause: error });
  } finally {
    if (temporaryLink) {
      try {
        fsOps.unlinkSync(temporaryLink);
      } catch {
        // Preserve the publication error; this link is private to this attempt.
      }
    }
    if (stagingOwned) removeOwnedPath(fsOps, stagingDir);
  }
}

function resolveCliSource(rootDir, sourcePlan, program, index) {
  if (sourcePlan.cliSources && !Array.isArray(sourcePlan.cliSources) && sourcePlan.cliSources[program.key]) {
    return sourcePlan.cliSources[program.key];
  }
  if (Array.isArray(sourcePlan.cliSources) && sourcePlan.cliSources[index]) {
    return sourcePlan.cliSources[index];
  }
  return path.join(rootDir, 'dds', `${program.name}.cpp`);
}

async function buildMacDds({
  rootDir,
  arch,
  compilerPath,
  compilerIdentity,
  paths,
  overridden,
  sourcePlan,
  fingerprint,
  releaseDir,
  runCommand: runCommandFn = runCommand,
  smokeCalc,
  smokeSolve,
  fsOps: suppliedFsOps,
}) {
  const fsOps = withFsDefaults(suppliedFsOps);
  const selected = PROGRAMS.filter((program) => !(overridden && overridden[program.key]));
  const compiledPrograms = selected.map((program) => program.name);
  const includeDir = sourcePlan.includeDir || path.join(rootDir, 'dds', 'library', 'src');
  const smokeFunctions = { calc: smokeCalc, solve: smokeSolve };
  if (!smokeFunctions.calc || !smokeFunctions.solve) {
    const defaults = require('./smoke-dds');
    smokeFunctions.calc ||= defaults.smokeCalc;
    smokeFunctions.solve ||= defaults.smokeSolve;
  }
  fsOps.mkdirSync(releaseDir, { recursive: true });
  const stagingDir = fsOps.mkdtempSync(path.join(releaseDir, '.staging-'));
  let stagingOwned = true;

  try {
    for (const program of selected) {
      const outputPath = path.join(stagingDir, program.name);
      const args = createCompileArgs({
        arch,
        includeDir,
        librarySources: sourcePlan.compileSources,
        cliSource: resolveCliSource(rootDir, sourcePlan, program, PROGRAMS.indexOf(program)),
        outputPath,
      });
      const result = runCommandFn(compilerPath, args, { cwd: rootDir });
      if (!result || result.status !== 0 || result.error) {
        const diagnostics = [result && result.stderr, result && result.error && result.error.message]
          .filter(Boolean)
          .join('\n');
        throw new Error(
          `DDS compile failed for ${program.name} (${arch})${diagnostics ? `: ${diagnostics}` : ''}`,
          result && result.error ? { cause: result.error } : undefined,
        );
      }
    }

    for (const program of selected) {
      const outputPath = path.join(stagingDir, program.name);
      fsOps.chmodSync(outputPath, 0o755);
    }
    for (const program of selected) {
      validateExecutable(path.join(stagingDir, program.name), {
        platform: 'darwin',
        statSync: fsOps.statSync,
        accessSync: fsOps.accessSync,
      });
    }

    await Promise.all(selected.map((program) => (
      smokeFunctions[program.key](path.join(stagingDir, program.name))
    )));

    fsOps.writeFileSync(path.join(stagingDir, MANIFEST_NAME), `${JSON.stringify({
      version: 1,
      fingerprint,
      platform: 'darwin',
      arch,
      programs: compiledPrograms,
    }, null, 2)}\n`);

    const published = await publishBuild({
      stagingDir,
      releaseDir,
      fingerprint,
      requiredPrograms: compiledPrograms,
      validateExecutable: (filePath) => validateExecutable(filePath, {
        platform: 'darwin',
        statSync: fsOps.statSync,
        accessSync: fsOps.accessSync,
      }),
      fsOps,
    });
    stagingOwned = false;
    return {
      fingerprint,
      ...published,
      compiledPrograms,
    };
  } finally {
    if (stagingOwned) removeOwnedPath(fsOps, stagingDir);
  }
}

module.exports = {
  buildMacDds,
  canonicalizeCompileArgs,
  computeBuildFingerprint,
  createCompileArgs,
  discoverDdsSources,
  isBuildCacheHit,
  publishBuild,
  readBuildManifest,
  runCommand,
  validateDdsOverrides,
  validateExecutable,
};
