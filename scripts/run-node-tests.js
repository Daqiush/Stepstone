'use strict';

const { readdirSync, statSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEST_FILE = /\.test\.(?:cjs|js|mjs)$/;

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function discoverTestFiles(rootPath) {
  const absoluteRoot = path.resolve(rootPath);
  if (!statSync(absoluteRoot).isDirectory()) {
    throw new TypeError(`Test root is not a directory: ${rootPath}`);
  }

  const files = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && TEST_FILE.test(entry.name)) files.push(entryPath);
    }
  };

  visit(absoluteRoot);
  return files;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) throw new TypeError('Usage: node scripts/run-node-tests.js <test-directory> [...]');

  const testFiles = argv.flatMap(discoverTestFiles).sort(comparePaths);
  if (testFiles.length === 0) throw new Error(`No Node test files found under: ${argv.join(', ')}`);

  const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return Number.isInteger(result.status) ? result.status : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { discoverTestFiles, main };
