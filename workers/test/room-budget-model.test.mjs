import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MEASURED_ROOM_SQL_PROFILES,
  createHandlerLatencyRecorder,
  measuredRegistrySqlProfiles,
  simulatePlanBBudget,
} from '../src/room-foundation/budget-model.mjs';

test('models the approved Plan B request and duration envelope exactly', () => {
  const report = simulatePlanBBudget();

  assert.equal(report.scenario.roomsPerDay, 50);
  assert.deepEqual(report.requests.perRoomFormula, {
    createRpcs: 3,
    joinRpcs: 4,
    websocketConnections: 9,
    websocketMessages: 1_009,
    websocketMessageBillingGroups: 51,
    alarmInvocations: 2,
    releaseRpcs: 3,
    reuseRpcs: 3,
  });
  assert.equal(report.requests.billedPerRoom, 75);
  assert.equal(report.requests.billedPerDay, 3_750);
  assert.equal(report.duration.handlerExecutionsPerRoom, 1_033);
  assert.equal(report.duration.activeSecondsPerHandler, 0.5);
  assert.equal(report.duration.memoryGb, 0.128);
  assert.equal(report.duration.gbSecondsPerDay, 3_305.6);
});

test('counts current table, index, alarm, retention, and deleteAll write costs', () => {
  const report = simulatePlanBBudget();

  assert.equal(report.rows.operations['ordinary command'].countPerRoom, 1_000);
  assert.deepEqual(report.rows.operations['ordinary command'].costEach, {
    rowsRead: 1,
    tableRowsWritten: 1,
    indexRowsWritten: 0,
    alarmRowsWritten: 0,
    deletedRowsWritten: 0,
  });
  assert.equal(
    report.rows.operations.initialization.costEach.tableRowsWritten
      + report.rows.operations.initialization.costEach.indexRowsWritten,
    MEASURED_ROOM_SQL_PROFILES.initialization.rowsWritten,
  );
  assert.equal(
    report.rows.operations['session join'].costEach.tableRowsWritten
      + report.rows.operations['session join'].costEach.indexRowsWritten,
    MEASURED_ROOM_SQL_PROFILES.join.rowsWritten,
  );
  assert.deepEqual(report.rows.operations['room deleteAll'].costEach, {
    rowsRead: 0,
    tableRowsWritten: 0,
    indexRowsWritten: 12,
    alarmRowsWritten: 1,
    deletedRowsWritten: 7,
  });
  assert.equal(
    report.rows.operations['creation request retention cleanup'].total.deletedRowsWritten
      + report.rows.operations['creation request retention cleanup'].total.indexRowsWritten,
    4,
  );
  assert.ok(report.rows.operations['registry release fallback reservation']);
  assert.equal(report.rows.writtenPerRoom, 1_217);
  assert.equal(report.rows.writtenPerDay, 60_850);
  assert.equal(report.rows.readPerDay, 211_700);
  assert.equal(report.rows.indexRowsWrittenPerDay, 5_050);
  assert.equal(report.rows.alarmRowsWrittenPerDay, 1_550);
  assert.equal(report.rows.deletedRowsWrittenPerDay, 1_050);
  assert.ok(report.rows.readPerDay <= report.targets.rowsReadPerDay);
  assert.ok(report.storage.bytes <= report.targets.storageBytes);
  assert.equal(report.gates.every((gate) => gate.passed), true);
});

test('derives registry scans from measured cardinality formulas and explicit runtime profiles', () => {
  const ten = measuredRegistrySqlProfiles(10);
  const fifty = measuredRegistrySqlProfiles(50);
  assert.deepEqual(ten.allocation, { rowsRead: 145, rowsWritten: 4 });
  assert.deepEqual(fifty.allocation, { rowsRead: 705, rowsWritten: 4 });
  assert.deepEqual(fifty.activation, { rowsRead: 157, rowsWritten: 2 });
  assert.deepEqual(fifty.markReleasePending, { rowsRead: 155, rowsWritten: 1 });
  assert.deepEqual(fifty.release, { rowsRead: 155, rowsWritten: 1 });
  assert.deepEqual(fifty.reuseAllocation, { rowsRead: 615, rowsWritten: 3 });
  assert.deepEqual(fifty.reuseActivation, { rowsRead: 158, rowsWritten: 2 });
  assert.deepEqual(MEASURED_ROOM_SQL_PROFILES.command, { rowsRead: 1, rowsWritten: 1 });
  assert.ok(fifty.fallbackAlarm.rowsRead >= 902);

  const injected = simulatePlanBBudget({
    sqlProfiles: {
      registry: { ...fifty, allocation: { rowsRead: 900, rowsWritten: 4 } },
      room: MEASURED_ROOM_SQL_PROFILES,
    },
  });
  assert.equal(injected.rows.operations.allocation.costEach.rowsRead, 900);
  assert.equal(injected.rows.readPerDay, 221_450);
});

test('fails the write gate for a command table or a command-maintained secondary index', () => {
  const commandTable = simulatePlanBBudget({
    regression: { commandTableRowsWritten: 1, commandIndexRowsWritten: 1 },
  });
  const commandIndex = simulatePlanBBudget({
    regression: { commandIndexRowsWritten: 2 },
  });

  assert.ok(commandTable.rows.writtenPerDay > commandTable.targets.rowsWrittenPerDay);
  assert.equal(commandTable.gatesByName.rowsWritten.passed, false);
  assert.ok(commandIndex.rows.writtenPerDay > commandIndex.targets.rowsWrittenPerDay);
  assert.equal(commandIndex.gatesByName.rowsWritten.passed, false);
});

test('fails the read gate for per-command recipient SQL', () => {
  const report = simulatePlanBBudget({
    regression: { recipientRowsReadPerCommand: 4 },
  });

  assert.ok(report.rows.readPerDay > report.targets.rowsReadPerDay);
  assert.equal(report.gatesByName.rowsRead.passed, false);
});

test('rejects a controlled handler duration at the 500 ms envelope', async () => {
  let now = 0;
  const recorder = createHandlerLatencyRecorder({ now: () => now });

  await assert.rejects(
    recorder.measure('ordinaryCommand', async () => { now += 500; }),
    /ordinaryCommand exceeded 500 ms/u,
  );
});

test('room budget simulator runs independently and can merge an optional DDS report', () => {
  const standalone = spawnSync(process.execPath, ['scripts/simulate-worker-room-budget.mjs'], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(standalone.status, 0, standalone.stderr);
  assert.match(standalone.stdout, /3,750 billed requests/u);
  assert.match(standalone.stdout, /3,305\.6 GB-s/u);

  const directory = mkdtempSync(join(tmpdir(), 'stepstone-room-budget-'));
  const reportPath = join(directory, 'dds-report.json');
  writeFileSync(reportPath, `${JSON.stringify({ benchmark: { seed: 1 } })}\n`);
  const merged = spawnSync(process.execPath, [
    'scripts/simulate-worker-room-budget.mjs', '--report', reportPath,
  ], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(merged.status, 0, merged.stderr);
  const saved = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(saved.budget.rooms, 50);
  assert.equal(saved.budget.requestsPerDay, 3_750);
  assert.equal(saved.budget.handlerExecutionsPerRoom, 1_033);
  assert.equal(saved.budget.durationGbSecondsPerDay, 3_305.6);
  assert.equal(saved.budget.writesPerDay, 60_850);
  assert.equal(saved.budget.readsPerDay, 211_700);
});
