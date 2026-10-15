import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MEASURED_ROOM_SQL_PROFILES,
  PLAN_B_TARGETS,
  assertPlanBBudget,
  createHandlerLatencyRecorder,
  measuredRegistrySqlProfiles,
  simulatePlanBBudget,
} from '../src/room-foundation/budget-model.mjs';

test('models the approved Plan B request and duration envelope exactly', () => {
  const report = simulatePlanBBudget();

  assert.equal(report.scenario.roomsPerDay, 50);
  assert.deepEqual(report.requests.perRoomFormula, {
    createRpcs: 3,
    joinLookupRpcs: 4,
    joinRoomRpcs: 4,
    websocketLookupRpcs: 9,
    websocketRoomRequests: 9,
    websocketMessages: 1_009,
    websocketMessageBillingGroups: 51,
    alarmInvocations: 2,
    releaseRpcs: 3,
    reuseRpcs: 3,
  });
  assert.equal(report.requests.billedPerRoom, 88);
  assert.equal(report.requests.billedPerDay, 4_400);
  assert.equal(report.duration.requestTriggeredHandlerExecutionsPerRoom, 1_046);
  assert.equal(report.duration.websocketCloseHandlersPerRoom, 9);
  assert.equal(report.duration.handlerExecutionsPerRoom, 1_055);
  assert.equal(report.duration.activeSecondsPerHandler, 0.5);
  assert.equal(report.duration.memoryGb, 0.128);
  assert.equal(report.duration.requestTriggeredGbSecondsPerDay, 3_347.2);
  assert.equal(report.duration.gbSecondsPerDay, 3_376);
  assert.equal(PLAN_B_TARGETS.storageBytes, 3_500_000_000);
  assert.equal(report.storage.gigabytes, report.storage.bytes / 1_000_000_000);
});

test('fails closed when any budget gate is missing or malformed', () => {
  const valid = simulatePlanBBudget();
  assert.equal(assertPlanBBudget(valid), valid);
  for (const malformed of [
    undefined,
    {},
    { gates: [] },
    { gates: valid.gates.slice(1) },
    { gates: valid.gates.map((gate) => ({ ...gate, passed: undefined })) },
    { gates: valid.gates.map((gate) => ({ ...gate, actual: Number.NaN })) },
    { ...valid, gates: valid.gates.map((gate, index) => (
      index === 0 ? { ...gate, target: gate.target + 1 } : gate
    )) },
    { ...valid, gates: valid.gates.map((gate, index) => (
      index === 0 ? { ...gate, actual: gate.actual - 1 } : gate
    )) },
  ]) {
    assert.throws(() => assertPlanBBudget(malformed), /invalid|missing|exceeded/iu);
  }
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
    deletedRowsWritten: 8,
  });
  assert.equal(
    report.rows.operations['creation request retention cleanup'].total.deletedRowsWritten
      + report.rows.operations['creation request retention cleanup'].total.indexRowsWritten,
    8,
  );
  assert.ok(report.rows.operations['registry release fallback reservation']);
  for (const [operationName, profileName] of [
    ['allocation', 'allocation'],
    ['activation', 'activation'],
    ['registry release fallback reservation', 'markReleasePending'],
    ['terminal registry release', 'release'],
    ['reuse allocation', 'reuseAllocation'],
    ['reuse activation', 'reuseActivation'],
  ]) {
    const operation = report.rows.operations[operationName].costEach;
    assert.equal(
      operation.tableRowsWritten + operation.indexRowsWritten,
      report.sqlProfiles.registry[profileName].rowsWritten,
      operationName,
    );
  }
  assert.equal(report.rows.writtenPerRoom, 1_269);
  assert.equal(report.rows.writtenPerDay, 63_450);
  assert.equal(report.rows.readPerDay, 194_050);
  assert.equal(report.rows.indexRowsWrittenPerDay, 6_550);
  assert.equal(report.rows.alarmRowsWrittenPerDay, 1_550);
  assert.equal(report.rows.deletedRowsWrittenPerDay, 1_100);
  assert.ok(report.rows.readPerDay <= report.targets.rowsReadPerDay);
  assert.ok(report.storage.bytes <= report.targets.storageBytes);
  assert.equal(report.gates.every((gate) => gate.passed), true);
});

test('derives registry scans from measured cardinality formulas and explicit runtime profiles', () => {
  const ten = measuredRegistrySqlProfiles({ roomCodeCount: 10, creationRequestCount: 20 });
  const fifty = measuredRegistrySqlProfiles({ roomCodeCount: 50, creationRequestCount: 100 });
  assert.deepEqual(ten.allocation, { rowsRead: 49, rowsWritten: 9 });
  assert.deepEqual(fifty.allocation, { rowsRead: 129, rowsWritten: 9 });
  assert.deepEqual(fifty.activation, { rowsRead: 11, rowsWritten: 7 });
  assert.deepEqual(fifty.markReleasePending, { rowsRead: 9, rowsWritten: 4 });
  assert.deepEqual(fifty.release, { rowsRead: 9, rowsWritten: 4 });
  assert.deepEqual(fifty.reuseAllocation, { rowsRead: 226, rowsWritten: 8 });
  assert.deepEqual(fifty.reuseActivation, { rowsRead: 11, rowsWritten: 7 });
  assert.deepEqual(MEASURED_ROOM_SQL_PROFILES.command, { rowsRead: 1, rowsWritten: 1 });
  assert.equal(fifty.fallbackAlarm.rowsRead, 22);
  assert.ok(fifty.allocation.rowsRead > ten.allocation.rowsRead);

  const injected = simulatePlanBBudget({
    sqlProfiles: {
      registry: { ...fifty, allocation: { rowsRead: 900, rowsWritten: 4 } },
      room: MEASURED_ROOM_SQL_PROFILES,
    },
  });
  assert.equal(injected.rows.operations.allocation.costEach.rowsRead, 900);
  assert.equal(injected.rows.readPerDay, 232_600);
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
  let logicalNow = 0;
  const recorder = createHandlerLatencyRecorder({
    now: () => 0,
    logicalNow: () => logicalNow,
  });

  await assert.rejects(
    recorder.measure('ordinaryCommand', async () => { logicalNow += 500; }),
    /ordinaryCommand exceeded 500 ms/u,
  );
});

test('controlled handler gate ignores host scheduling delay while retaining wall diagnostics', async () => {
  let wallNow = 0;
  let logicalNow = 0;
  const recorder = createHandlerLatencyRecorder({
    now: () => wallNow,
    logicalNow: () => logicalNow,
  });

  await recorder.measure('ordinaryCommand', async () => {
    wallNow += 5_000;
    logicalNow += 10;
  });

  const summary = recorder.assertComplete({ requireAll: false });
  assert.equal(summary.ordinaryCommand.milliseconds, 10);
  assert.equal(summary.ordinaryCommand.wallMilliseconds, 5_000);
  assert.equal(summary.ordinaryCommand.passed, true);
});

test('room budget simulator runs independently and can merge an optional DDS report', () => {
  const standalone = spawnSync(process.execPath, ['scripts/simulate-worker-room-budget.mjs'], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(standalone.status, 0, standalone.stderr);
  assert.match(standalone.stdout, /4,400 billed requests/u);
  assert.match(standalone.stdout, /3,376 GB-s/u);

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
  assert.equal(saved.budget.requestsPerDay, 4_400);
  assert.equal(saved.budget.requestTriggeredHandlerExecutionsPerRoom, 1_046);
  assert.equal(saved.budget.handlerExecutionsPerRoom, 1_055);
  assert.equal(saved.budget.durationGbSecondsPerDay, 3_376);
  assert.equal(saved.budget.writesPerDay, 63_450);
  assert.equal(saved.budget.readsPerDay, 194_050);
});
