'use strict';
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');

const checkpoint = import('../scripts/worker-dds-checkpoint.mjs');

test('a failed partial checkpoint preserves the previous complete report and removes temp file', async () => {
  const { writeReportCheckpoint } = await checkpoint;
  const dir = mkdtempSync(join(tmpdir(), 'dds-checkpoint-'));
  try {
    const file = join(dir, 'report.json');
    writeFileSync(file, '{"status":"old"}\n');
    assert.throws(() => writeReportCheckpoint(file, { status: 'new' }, {
      writeTemp: (temp) => { writeFileSync(temp, '{"broken":'); throw new Error('disk write failed'); },
    }), /disk write failed/);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { status: 'old' });
    assert.deepEqual(readdirSync(dir), ['report.json']);
    writeReportCheckpoint(file, { status: 'new' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { status: 'new' });
    assert.deepEqual(readdirSync(dir), ['report.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed atomic replacement leaves the previous report intact', async () => {
  const { writeReportCheckpoint } = await checkpoint;
  const dir = mkdtempSync(join(tmpdir(), 'dds-checkpoint-'));
  try {
    const file = join(dir, 'report.json');
    writeFileSync(file, '{"status":"old"}\n');
    assert.throws(() => writeReportCheckpoint(file, { status: 'new' }, {
      replaceTemp: () => { throw new Error('replace failed'); },
    }), /replace failed/);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { status: 'old' });
    assert.deepEqual(readdirSync(dir), ['report.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('syncs the parent directory after durable create and atomic replacement', async () => {
  const { writeReportCheckpoint } = await checkpoint;
  const dir = mkdtempSync(join(tmpdir(), 'dds-checkpoint-'));
  try {
    const synced = [];
    writeReportCheckpoint(join(dir, 'report.json'), { status: 'new' }, {
      syncDirectory: (directory) => synced.push(directory),
    });
    assert.deepEqual(synced, [dir, dir]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
