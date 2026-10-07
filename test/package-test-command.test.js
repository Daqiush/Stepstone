'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('npm test uses a Node 20 compatible directory path instead of a shell glob', () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
  );

  assert.equal(packageJson.scripts.test, 'node --test test');
});
