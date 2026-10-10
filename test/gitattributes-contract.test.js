'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
const test = require('node:test');

const ROOT = resolve(__dirname, '..');

function attributes(path) {
  const output = execFileSync('git', ['check-attr', 'text', 'eol', 'whitespace', '--', path], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return Object.fromEntries(output.trim().split(/\r?\n/).map((line) => {
    const match = line.match(/^[^:]+: ([^:]+): (.+)$/);
    assert.ok(match, `unexpected git check-attr output: ${line}`);
    return [match[1], match[2]];
  }));
}

test('root attributes normalize every designed source extension to LF', () => {
  assert.equal(attributes('unclassified.asset').text, 'auto');
  for (const extension of ['js', 'cjs', 'mjs', 'json', 'jsonc', 'yml', 'yaml', 'ps1', 'md', 'cpp', 'h']) {
    const actual = attributes(`attribute-contract.${extension}`);
    assert.equal(actual.text, 'set', `${extension} must be text`);
    assert.equal(actual.eol, 'lf', `${extension} must use LF`);
  }
  assert.equal(attributes('attribute-contract.wasm').text, 'unset');
});

test('vendored generated and license files remain byte-for-byte opaque', () => {
  for (const name of ['dds-worker.mjs', 'dds-worker.wasm', 'LICENSE.bridge-dds', 'LICENSE.dds']) {
    const actual = attributes(`workers/vendor/bridge-dds/${name}`);
    assert.equal(actual.text, 'unset', `${name} text conversion must be disabled`);
    assert.equal(actual.whitespace, 'unset', `${name} whitespace checks must be disabled`);
  }
});
