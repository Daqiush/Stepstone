'use strict';

const path = require('node:path');

function resolveOverride(rootDir, override, variableName) {
  if (override == null) return null;
  if (override === '') throw new Error(`${variableName} must not be empty`);
  return path.isAbsolute(override) ? override : path.resolve(rootDir, override);
}

function resolveDdsPaths(options = {}) {
  const {
    rootDir = __dirname,
    platform = process.platform,
    arch = process.arch,
    env = process.env,
  } = options;
  const absoluteRoot = path.resolve(rootDir);
  let binaryDir;
  let extension;

  if (platform === 'win32') {
    binaryDir = path.join(absoluteRoot, 'dds', 'Build', 'bin', 'x64', 'Release');
    extension = '.exe';
  } else if (platform === 'darwin') {
    if (!['arm64', 'x64'].includes(arch)) {
      throw new Error(`Unsupported DDS architecture on darwin: ${arch}`);
    }
    binaryDir = path.join(absoluteRoot, 'dds', 'Build', 'bin', `darwin-${arch}`, 'Release', 'current');
    extension = '';
  } else {
    throw new Error(`Unsupported DDS platform: ${platform}`);
  }

  const calcOverride = resolveOverride(absoluteRoot, env.DDS_CALC_PATH, 'DDS_CALC_PATH');
  const solveOverride = resolveOverride(absoluteRoot, env.DDS_SOLVE_PATH, 'DDS_SOLVE_PATH');

  return {
    calc: calcOverride ?? path.join(binaryDir, `dds_calc${extension}`),
    solve: solveOverride ?? path.join(binaryDir, `dds_solve${extension}`),
    overridden: {
      calc: calcOverride !== null,
      solve: solveOverride !== null,
    },
    platform,
    arch,
  };
}

function ddsSetupHint(resolvedPaths) {
  return [
    `DDS platform: ${resolvedPaths.platform}`,
    `architecture: ${resolvedPaths.arch}`,
    `calculator: ${resolvedPaths.calc}`,
    `solver: ${resolvedPaths.solve}`,
    'Run npm install to prepare DDS',
  ].join('; ');
}

module.exports = { resolveDdsPaths, ddsSetupHint };
