'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FINGERPRINT_EXTENSIONS = new Set(['.cpp', '.hpp', '.h']);
const REQUIRED_SOURCE_BASENAMES = ['dds.cpp', 'calc_dd_table.cpp', 'solve_board.cpp'];
const MANIFEST_NAME = 'manifest.json';

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
    if (index > 0 && args[index - 1] === '-o') return `<OUTPUT>/${programName}`;
    if (argument === outputPath && index > 0 && args[index - 1] === '-o') return `<OUTPUT>/${programName}`;
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

function computeBuildFingerprint({ files, platform, arch, compilerIdentity, compileArgsByProgram }) {
  const hash = crypto.createHash('sha256');
  const sortedFiles = files
    .map((file) => ({ ...file, relativePath: normalizeRelativePath(file.relativePath) }))
    .sort((left, right) => compareLexically(left.relativePath, right.relativePath));

  for (const file of sortedFiles) {
    hash.update(file.relativePath, 'utf8');
    hash.update('\0');
    hash.update(fs.readFileSync(file.absolutePath));
    hash.update('\0');
  }

  hash.update(stableJson({ platform, arch, compilerIdentity, compileArgsByProgram }), 'utf8');
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

module.exports = {
  canonicalizeCompileArgs,
  computeBuildFingerprint,
  createCompileArgs,
  discoverDdsSources,
  isBuildCacheHit,
  readBuildManifest,
  validateDdsOverrides,
  validateExecutable,
};
