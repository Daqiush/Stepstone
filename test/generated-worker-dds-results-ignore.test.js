const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const repoRoot = join(__dirname, '..');
const generatedReports = [
  'workers/test/results/dds-feasibility-full-ordered.json',
  'workers/test/results/dds-feasibility-full.json',
  'workers/test/results/dds-feasibility-remote-smoke.json',
];

function git(...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

test('ignores generated Workers DDS JSON reports without affecting tracked fixtures', () => {
  for (const report of generatedReports) {
    assert.ok(existsSync(join(repoRoot, report)), `${report} must remain on disk`);
    assert.doesNotThrow(() => git('check-ignore', '-q', report), `${report} must be ignored`);
  }

  assert.throws(() => git('check-ignore', '-q', 'workers/test/results/.gitkeep'));
  assert.equal(git('ls-files', '--error-unmatch', 'workers/test/results/.gitkeep'), 'workers/test/results/.gitkeep');
  assert.equal(git('ls-files', '--error-unmatch', 'workers/test/results/dds-feasibility-small.json'), 'workers/test/results/dds-feasibility-small.json');
});
