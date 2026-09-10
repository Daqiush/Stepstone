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
  lstatSync: fs.lstatSync,
  accessSync: fs.accessSync,
  existsSync: fs.existsSync,
  renameSync: fs.renameSync,
  symlinkSync: fs.symlinkSync,
  readlinkSync: fs.readlinkSync,
  unlinkSync: fs.unlinkSync,
  rmSync: fs.rmSync,
};
const BUILD_MANIFEST_KEYS = ['arch', 'fingerprint', 'hashes', 'platform', 'programs', 'version'];
const KNOWN_PROGRAMS = new Set(['dds_calc', 'dds_solve']);
const DEFAULT_COMPILE_TIMEOUT_MS = 600_000;
const DEFAULT_LOCK_RETRY_MS = 50;
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;

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
  const keys = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    ? Object.keys(manifest).sort()
    : [];
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
    && manifest.hashes
    && typeof manifest.hashes === 'object'
    && !Array.isArray(manifest.hashes)
    && sameStringSet(Object.keys(manifest.hashes), manifest.programs)
    && Object.values(manifest.hashes).every((hash) => /^[0-9a-f]{64}$/.test(hash))
    && JSON.stringify(keys) === JSON.stringify(BUILD_MANIFEST_KEYS)
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
      hashes: manifest.hashes,
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
  lstatSync = fs.lstatSync,
  readFileSync = fs.readFileSync,
}) {
  try {
    const manifestStats = lstatSync(path.join(activeDir, MANIFEST_NAME));
    if (!manifestStats || typeof manifestStats.isFile !== 'function' || !manifestStats.isFile()) return false;
    const manifest = readManifestFn(activeDir);
    if (
      !manifest
      || manifest.fingerprint !== fingerprint
      || !sameStringSet(manifest.programs, requiredPrograms)
    ) return false;

    for (const program of requiredPrograms) {
      if (!KNOWN_PROGRAMS.has(program) || !manifest.programs.includes(program)) return false;
      const programPath = path.join(activeDir, program);
      const stats = lstatSync(programPath);
      if (!stats.isFile()) return false;
      validateExecutableFn(programPath);
      if (sha256(readFileSync(programPath)) !== manifest.hashes[program]) return false;
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

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function validateProgramNames(requiredPrograms) {
  if (!Array.isArray(requiredPrograms) || requiredPrograms.some((program) => (
    !KNOWN_PROGRAMS.has(program) || path.basename(program) !== program
  ))) {
    throw new Error(`Invalid DDS program set: ${JSON.stringify(requiredPrograms)}`);
  }
}

function sameStringSet(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function validateImmutableBuild({
  directory,
  fingerprint,
  platform,
  arch,
  requiredPrograms,
  validateExecutableFn,
  fsOps,
}) {
  validateProgramNames(requiredPrograms);
  let manifest;
  const manifestPath = path.join(directory, MANIFEST_NAME);
  try {
    const manifestStats = fsOps.lstatSync(manifestPath);
    if (!manifestStats || typeof manifestStats.isFile !== 'function' || !manifestStats.isFile()) {
      throw new Error('manifest is not a regular file');
    }
    manifest = JSON.parse(fsOps.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid DDS build manifest in ${directory}: ${error.message}`, { cause: error });
  }
  const keys = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    ? Object.keys(manifest).sort()
    : [];
  if (
    JSON.stringify(keys) !== JSON.stringify(BUILD_MANIFEST_KEYS)
    || manifest.version !== 1
    || manifest.fingerprint !== fingerprint
    || manifest.platform !== platform
    || manifest.arch !== arch
    || !sameStringSet(manifest.programs, requiredPrograms)
    || !manifest.hashes
    || typeof manifest.hashes !== 'object'
    || Array.isArray(manifest.hashes)
    || !sameStringSet(Object.keys(manifest.hashes), requiredPrograms)
  ) {
    throw new Error(`Invalid DDS build manifest in ${directory}`);
  }
  for (const program of requiredPrograms) {
    const programPath = path.join(directory, program);
    const stats = fsOps.lstatSync(programPath);
    if (!stats || typeof stats.isFile !== 'function' || !stats.isFile()) {
      throw new Error(`DDS build artifact must be a regular file: ${programPath}`);
    }
    validateExecutableFn(programPath);
    const expectedHash = manifest.hashes[program];
    const actualHash = sha256(fsOps.readFileSync(programPath));
    if (!/^[0-9a-f]{64}$/.test(expectedHash) || expectedHash !== actualHash) {
      throw new Error(`DDS build artifact hash mismatch: ${programPath}`);
    }
  }
  return manifest;
}

function removeOwnedPath(fsOps, ownedPath) {
  if (!ownedPath || !fsOps.existsSync(ownedPath)) return;
  fsOps.rmSync(ownedPath, { recursive: true, force: true });
}

function attachCleanupError(primaryError, cleanupError) {
  if (!primaryError.cleanupError) primaryError.cleanupError = cleanupError;
  else if (!Array.isArray(primaryError.additionalCleanupErrors)) primaryError.additionalCleanupErrors = [cleanupError];
  else primaryError.additionalCleanupErrors.push(cleanupError);
}

function randomSuffix(randomBytesFn) {
  return randomBytesFn(16).toString('hex');
}

function validatePublicationBoundary({ stagingDir, releaseDir, fingerprint }) {
  const absoluteReleaseDir = path.resolve(releaseDir);
  const absoluteStagingDir = path.resolve(stagingDir);
  const stagingName = path.basename(absoluteStagingDir);
  if (path.dirname(absoluteStagingDir) !== absoluteReleaseDir || !/^\.staging-.+/.test(stagingName)) {
    throw new Error(`DDS staging path must be a direct child named .staging-* of ${absoluteReleaseDir}: ${absoluteStagingDir}`);
  }
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error(`Invalid DDS build fingerprint: ${fingerprint}`);
  }
}

function validateRealDirectory(directory, fsOps, label) {
  let stats;
  try {
    stats = fsOps.lstatSync(directory);
  } catch (error) {
    throw new Error(`${label} must be a real directory (not a symbolic link): ${directory}: ${error.message}`, { cause: error });
  }
  if (
    !stats
    || typeof stats.isDirectory !== 'function'
    || !stats.isDirectory()
    || (typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink())
  ) {
    throw new Error(`${label} must be a real directory (not a symbolic link): ${directory}`);
  }
}

async function acquirePublicationLock({
  releaseDir,
  fsOps,
  randomBytesFn,
  nowFn,
  sleepFn,
  lockRetryMs,
  lockTimeoutMs,
  lockMaxAttempts,
}) {
  const lockDir = path.join(releaseDir, '.publish-lock');
  const ownerPath = path.join(lockDir, 'owner.json');
  const owner = randomSuffix(randomBytesFn);
  const startedAt = nowFn();
  let attempts = 0;

  while (attempts++ < lockMaxAttempts) {
    let madeLockDirectory = false;
    try {
      fsOps.mkdirSync(lockDir);
      madeLockDirectory = true;
      try {
        fsOps.writeFileSync(ownerPath, JSON.stringify({ owner, pid: process.pid, createdAt: nowFn() }));
      } catch (metadataError) {
        try {
          fsOps.rmSync(lockDir, { recursive: true, force: true });
        } catch (cleanupError) {
          attachCleanupError(metadataError, cleanupError);
        }
        throw metadataError;
      }
      const assertOwned = () => {
        let metadata;
        try {
          metadata = JSON.parse(fsOps.readFileSync(ownerPath, 'utf8'));
        } catch (error) {
          throw new Error(`DDS publication lock ownership lost at ${lockDir}: ${error.message}`, { cause: error });
        }
        if (metadata.owner !== owner) {
          throw new Error(`DDS publication lock ownership lost at ${lockDir}`);
        }
      };
      return {
        assertOwned,
        release() {
          assertOwned();
          fsOps.rmSync(lockDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (madeLockDirectory) {
        throw new Error(`Unable to acquire DDS publication lock ${lockDir}: ${error.message}`, { cause: error });
      }
      if (error.code !== 'EEXIST') throw new Error(`Unable to acquire DDS publication lock ${lockDir}: ${error.message}`, { cause: error });
    }

    if (nowFn() - startedAt >= lockTimeoutMs || attempts >= lockMaxAttempts) {
      throw new Error(
        `Timed out acquiring DDS publication lock ${lockDir}. `
        + 'Another publisher may still be active; if none is running, remove this lock directory manually and retry.',
      );
    }
    await sleepFn(lockRetryMs);
  }
  throw new Error(
    `Timed out acquiring DDS publication lock ${lockDir}. `
    + 'Another publisher may still be active; if none is running, remove this lock directory manually and retry.',
  );
}

async function publishBuild({
  stagingDir,
  releaseDir,
  fingerprint,
  requiredPrograms,
  validateExecutable: validateExecutableFn = validateExecutable,
  fsOps: suppliedFsOps,
  platform = 'darwin',
  arch = process.arch,
  smokeProgram,
  randomBytes: randomBytesFn = crypto.randomBytes,
  now: nowFn = Date.now,
  sleep: sleepFn = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  lockRetryMs = DEFAULT_LOCK_RETRY_MS,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  lockMaxAttempts = 1_200,
}) {
  validatePublicationBoundary({ stagingDir, releaseDir, fingerprint });
  const fsOps = withFsDefaults(suppliedFsOps);
  validateRealDirectory(stagingDir, fsOps, 'DDS staging path');
  const buildsDir = path.join(releaseDir, 'builds');
  const buildDir = path.join(buildsDir, fingerprint);
  const activeDir = path.join(releaseDir, 'current');
  const relativeTarget = path.join('builds', fingerprint);
  const smokeProgramFn = smokeProgram || ((programPath, programName) => {
    const smoke = require('./smoke-dds');
    return programName === 'dds_calc'
      ? smoke.smokeCalc(programPath)
      : smoke.smokeSolve(programPath);
  });
  let stagingOwned = true;
  let temporaryLink = null;
  let primaryError = null;
  let publicationLock;

  try {
    fsOps.mkdirSync(buildsDir, { recursive: true });
    publicationLock = await acquirePublicationLock({
      releaseDir,
      fsOps,
      randomBytesFn,
      nowFn,
      sleepFn,
      lockRetryMs,
      lockTimeoutMs,
      lockMaxAttempts,
    });
    const assertLockOwned = () => publicationLock.assertOwned();
    const oldTarget = fsOps.existsSync(activeDir) ? fsOps.readlinkSync(activeDir) : null;

    if (fsOps.existsSync(buildDir)) {
      let reusable = true;
      try {
        validateRealDirectory(buildDir, fsOps, 'DDS immutable build path');
        validateImmutableBuild({
          directory: buildDir,
          fingerprint,
          platform,
          arch,
          requiredPrograms,
          validateExecutableFn,
          fsOps,
        });
        const smokeResults = await Promise.allSettled(requiredPrograms.map((program) => (
          smokeProgramFn(path.join(buildDir, program), program)
        )));
        const smokeFailure = smokeResults.find((result) => result.status === 'rejected');
        if (smokeFailure) throw smokeFailure.reason;
      } catch {
        reusable = false;
      }
      if (!reusable) {
        const quarantinePath = path.join(
          buildsDir,
          `${fingerprint}.invalid-${randomSuffix(randomBytesFn)}`,
        );
        assertLockOwned();
        fsOps.renameSync(buildDir, quarantinePath);
        try {
          assertLockOwned();
          fsOps.renameSync(stagingDir, buildDir);
          stagingOwned = false;
        } catch (repairError) {
          try {
            assertLockOwned();
            fsOps.renameSync(quarantinePath, buildDir);
          } catch (restorationError) {
            repairError.restorationError = restorationError;
          }
          throw repairError;
        }
      }
    } else {
      try {
        assertLockOwned();
        fsOps.renameSync(stagingDir, buildDir);
        stagingOwned = false;
      } catch (error) {
        if (!fsOps.existsSync(buildDir)) throw error;
        validateRealDirectory(buildDir, fsOps, 'DDS immutable build path');
        validateImmutableBuild({
          directory: buildDir,
          fingerprint,
          platform,
          arch,
          requiredPrograms,
          validateExecutableFn,
          fsOps,
        });
        const smokeResults = await Promise.allSettled(requiredPrograms.map((program) => (
          smokeProgramFn(path.join(buildDir, program), program)
        )));
        const smokeFailure = smokeResults.find((result) => result.status === 'rejected');
        if (smokeFailure) throw smokeFailure.reason;
      }
    }

    temporaryLink = path.join(
      releaseDir,
      `.current-${randomSuffix(randomBytesFn)}`,
    );
    fsOps.symlinkSync(relativeTarget, temporaryLink, 'dir');
    assertLockOwned();
    fsOps.renameSync(temporaryLink, activeDir);
    temporaryLink = null;

    try {
      validateImmutableBuild({
        directory: activeDir,
        fingerprint,
        platform,
        arch,
        requiredPrograms,
        validateExecutableFn,
        fsOps,
      });
    } catch (verificationError) {
      try {
        if (oldTarget === null) {
          assertLockOwned();
          fsOps.unlinkSync(activeDir);
        } else {
          const rollbackLink = path.join(
            releaseDir,
            `.current-rollback-${randomSuffix(randomBytesFn)}`,
          );
          temporaryLink = rollbackLink;
          fsOps.symlinkSync(oldTarget, rollbackLink, 'dir');
          assertLockOwned();
          fsOps.renameSync(rollbackLink, activeDir);
          temporaryLink = null;
        }
      } catch (rollbackError) {
        verificationError.rollbackError = rollbackError;
      }
      throw verificationError;
    }

    return { buildDir, activeDir };
  } catch (error) {
    primaryError = new Error(`Failed to publish DDS build at ${activeDir}: ${error.message}`, { cause: error });
    if (error.restorationError) primaryError.restorationError = error.restorationError;
    if (error.rollbackError) primaryError.rollbackError = error.rollbackError;
    throw primaryError;
  } finally {
    let cleanupFailure = null;
    if (temporaryLink) {
      try {
        fsOps.unlinkSync(temporaryLink);
      } catch (cleanupError) {
        if (primaryError) attachCleanupError(primaryError, cleanupError);
        else cleanupFailure = cleanupError;
      }
    }
    if (stagingOwned) {
      try {
        removeOwnedPath(fsOps, stagingDir);
      } catch (cleanupError) {
        if (primaryError) attachCleanupError(primaryError, cleanupError);
        else cleanupFailure ||= cleanupError;
      }
    }
    if (publicationLock) {
      try {
        publicationLock.release();
      } catch (cleanupError) {
        if (primaryError) attachCleanupError(primaryError, cleanupError);
        else cleanupFailure ||= cleanupError;
      }
    }
    if (cleanupFailure) throw cleanupFailure;
  }
}

function resolveCliSource(rootDir, sourcePlan, program, index) {
  if (sourcePlan.cliSources && !Array.isArray(sourcePlan.cliSources) && sourcePlan.cliSources[program.key]) {
    return sourcePlan.cliSources[program.key];
  }
  if (Array.isArray(sourcePlan.cliSources) && sourcePlan.cliSources[index]) {
    return sourcePlan.cliSources[index];
  }
  return path.join(rootDir, 'native', 'dds-cli', `${program.name}.cpp`);
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
      const result = runCommandFn(compilerPath, args, {
        cwd: rootDir,
        timeout: DEFAULT_COMPILE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      if (!result || result.status !== 0 || result.error) {
        const diagnostics = [result && result.stderr, result && result.error && result.error.message]
          .filter(Boolean)
          .join('\n');
        const timedOut = result
          && result.error
          && (result.error.code === 'ETIMEDOUT' || result.error.killed === true);
        throw new Error(
          `DDS compile ${timedOut ? 'timed out' : 'failed'} for ${program.name} (${arch})${diagnostics ? `: ${diagnostics}` : ''}`,
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

    const smokeResults = await Promise.allSettled(selected.map((program) => (
      smokeFunctions[program.key](path.join(stagingDir, program.name))
    )));
    const smokeFailures = smokeResults
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (smokeFailures.length > 0) {
      const primarySmokeError = smokeFailures[0] instanceof Error
        ? smokeFailures[0]
        : new Error(String(smokeFailures[0]));
      if (smokeFailures.length > 1) primarySmokeError.siblingErrors = smokeFailures.slice(1);
      throw primarySmokeError;
    }

    const hashes = Object.fromEntries(selected.map((program) => [
      program.name,
      sha256(fsOps.readFileSync(path.join(stagingDir, program.name))),
    ]));

    fsOps.writeFileSync(path.join(stagingDir, MANIFEST_NAME), `${JSON.stringify({
      version: 1,
      fingerprint,
      platform: 'darwin',
      arch,
      programs: compiledPrograms,
      hashes,
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
      platform: 'darwin',
      arch,
      smokeProgram: (programPath, programName) => {
        const program = PROGRAMS.find((candidate) => candidate.name === programName);
        return smokeFunctions[program.key](programPath);
      },
    });
    stagingOwned = false;
    return {
      fingerprint,
      ...published,
      compiledPrograms,
    };
  } catch (error) {
    try {
      if (stagingOwned) removeOwnedPath(fsOps, stagingDir);
    } catch (cleanupError) {
      attachCleanupError(error, cleanupError);
    }
    throw error;
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
