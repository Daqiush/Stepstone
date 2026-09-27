import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

export const REMOTE_SOAK_BASELINE = '5500bf5dda8dc56c385a202ad541b995f738069d';

export const REQUIRED_BASELINE_PATHS = [
  'workers/wrangler.jsonc',
  'workers/src/index.mjs',
  'workers/src/feasibility-room.mjs',
  'workers/test/fixtures/dds-parity.json',
  'scripts/benchmark-worker-dds.mjs',
  'scripts/worker-dds-random-cases.mjs',
  'scripts/worker-dds-checkpoint.mjs',
  'scripts/simulate-worker-room-budget.mjs',
  'scripts/check-worker-dds-gates.mjs',
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sameBytes(expected, current) {
  return expected.equals(current);
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'buffer' });
}

function isAncestor(repoRoot, baseline) {
  try {
    git(repoRoot, ['merge-base', '--is-ancestor', baseline, 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

function expectedBytes(repoRoot, baseline, path) {
  try {
    return git(repoRoot, ['show', `${baseline}:${path}`]);
  } catch (error) {
    throw new Error(`Unable to read baseline path ${path} from ${baseline}: ${error.message}`);
  }
}

function formatEntry(entry) {
  return [
    entry.issue ? `${entry.issue}: ${entry.path}` : `Verified: ${entry.path}`,
    `  expected sha256: ${entry.expectedSha256}`,
    `  current sha256: ${entry.currentSha256}`,
  ].join('\n');
}

export function assertRemoteSoakPrerequisites({
  repoRoot = process.cwd(),
  baseline = REMOTE_SOAK_BASELINE,
} = {}) {
  const resolvedRoot = resolve(repoRoot);
  if (!isAncestor(resolvedRoot, baseline)) {
    throw new Error(`Baseline commit ${baseline} is not HEAD or an ancestor of HEAD.`);
  }

  const entries = REQUIRED_BASELINE_PATHS.map((path) => {
    const expected = expectedBytes(resolvedRoot, baseline, path);
    const expectedSha256 = sha256(expected);
    const currentPath = join(resolvedRoot, path);

    if (!existsSync(currentPath)) {
      return { path, expectedSha256, currentSha256: 'MISSING', issue: 'Missing required path' };
    }

    const current = readFileSync(currentPath);
    const currentSha256 = sha256(current);
    return {
      path,
      expectedSha256,
      currentSha256,
      issue: sameBytes(expected, current) ? null : 'Byte mismatch',
    };
  });
  const failures = entries.filter((entry) => entry.issue);

  if (failures.length > 0) {
    throw new Error(`Remote soak prerequisites failed:\n${entries.map(formatEntry).join('\n')}`);
  }
  return entries;
}

function runCli() {
  try {
    const entries = assertRemoteSoakPrerequisites();
    console.log(`Remote soak prerequisites verified against ${REMOTE_SOAK_BASELINE}.`);
    console.log(entries.map(formatEntry).join('\n'));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
