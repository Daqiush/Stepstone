import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MEASURED_CLASSIC_DDS_SQL_PROFILES,
  MEASURED_ROOM_SQL_PROFILES,
  PLAN_B_TARGETS,
  assertPlanBBudget,
  createHandlerLatencyRecorder,
  measuredRegistrySqlProfiles,
  simulatePlanBBudget,
} from '../src/room-foundation/budget-model.mjs';

test('models one complete classic deal with bounded overlapping DDS recovery variants', () => {
  const report = simulatePlanBBudget();

  assert.deepEqual(report.scenario, {
    roomsPerDay: 50,
    commandsPerRoom: 1_000,
    initialSocketsPerRoom: 5,
    reconnectsPerRoom: 4,
    classicDealsPerRoom: 1,
    logicalDdsAttemptsPerDeal: 3,
    maxDdsComputationsPerDeal: 4,
  });
  assert.deepEqual(report.classicDeal.commandReservation, {
    dealStarts: 1,
    maximumLegalAuctionCalls: 319,
    cardPlays: 52,
    reconnectSnapshots: 4,
    commandsUsed: 372,
    commandsReserved: 1_000,
    commandsRemaining: 628,
  });
  assert.deepEqual(report.dds, {
    logicalAttemptsPerDeal: 3,
    computationsPerDeal: 4,
    immediateComputationsPerDeal: 1,
    alarmComputationsPerDeal: 3,
    alarmHandlerInvocationsPerDeal: 3,
    variants: {
      successAfterEviction: {
        outcome: 'READY',
        evictions: 1,
        logicalAttempts: 3,
        computations: 4,
      },
      attempt3Exhaustion: {
        outcome: 'FAILED',
        evictions: 0,
        logicalAttempts: 3,
        computations: 4,
      },
    },
  });

  const { successAfterEviction, attempt3Exhaustion } = report.rows.variants;
  assert.ok(successAfterEviction.operations['classic DDS successful trusted settlement']);
  assert.equal(successAfterEviction.operations['classic DDS exhausted trusted settlement'], undefined);
  assert.ok(attempt3Exhaustion.operations['classic DDS exhausted trusted settlement']);
  assert.equal(attempt3Exhaustion.operations['classic DDS successful trusted settlement'], undefined);
  for (const variant of [successAfterEviction, attempt3Exhaustion]) {
    assert.equal(variant.operations['ordinary command'].countPerRoom, 1_000);
    assert.equal(variant.operations['classic DDS action creation'].countPerRoom, 1);
    assert.equal(variant.operations['classic DDS alarm computation'].countPerRoom, 3);
    assert.equal(variant.operations['classic DDS guarded retry update'].countPerRoom, 2);
    assert.equal(variant.operations['classic DDS stale overlap guard'].countPerRoom, 1);
    assert.equal(variant.gates.every(gate => gate.passed), true);
    assert.equal(variant.gates.every(gate => gate.freePassed), true);
  }

  for (const [operation, profile] of [
    ['classic DDS action creation', MEASURED_CLASSIC_DDS_SQL_PROFILES.actionCreation],
    ['classic DDS alarm computation', MEASURED_CLASSIC_DDS_SQL_PROFILES.alarmComputation],
    ['classic DDS guarded retry update', MEASURED_CLASSIC_DDS_SQL_PROFILES.retryUpdate],
    ['classic DDS stale overlap guard', MEASURED_CLASSIC_DDS_SQL_PROFILES.staleOverlapGuard],
  ]) {
    assert.deepEqual(successAfterEviction.operations[operation].costEach, profile, operation);
    assert.deepEqual(attempt3Exhaustion.operations[operation].costEach, profile, operation);
  }
  assert.deepEqual(
    successAfterEviction.operations['classic DDS successful trusted settlement'].costEach,
    MEASURED_CLASSIC_DDS_SQL_PROFILES.successfulSettlement,
  );
  assert.deepEqual(
    attempt3Exhaustion.operations['classic DDS exhausted trusted settlement'].costEach,
    MEASURED_CLASSIC_DDS_SQL_PROFILES.exhaustedSettlement,
  );
  assert.equal(report.gates.every(gate => gate.passed), true);
  assert.equal(report.gates.every(gate => gate.freePassed), true);
});

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
    lifecycleAlarmInvocations: 2,
    ddsAlarmInvocations: 3,
    alarmInvocations: 5,
    releaseRpcs: 3,
    reuseRpcs: 3,
  });
  assert.equal(report.requests.billedPerRoom, 91);
  assert.equal(report.requests.billedPerDay, 4_550);
  assert.equal(report.duration.requestTriggeredHandlerExecutionsPerRoom, 1_049);
  assert.equal(report.duration.websocketCloseHandlersPerRoom, 9);
  assert.equal(report.duration.handlerExecutionsPerRoom, 1_058);
  assert.equal(report.duration.ddsComputeExecutionsPerRoom, 4);
  assert.equal(report.duration.durationExecutionUnitsPerRoom, 1_062);
  assert.equal(report.duration.activeSecondsPerHandler, 0.5);
  assert.equal(report.duration.memoryGb, 0.128);
  assert.equal(report.duration.requestTriggeredGbSecondsPerDay, 3_356.8);
  assert.equal(report.duration.gbSecondsPerDay, 3_398.4);
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

  const variantFailure = structuredClone(valid);
  variantFailure.rows.variants.successAfterEviction.gates[0].passed = false;
  assert.throws(() => assertPlanBBudget(variantFailure), /invalid|missing|exceeded/iu);
  const freeFailure = structuredClone(valid);
  freeFailure.rows.variants.attempt3Exhaustion.gates[0].freePassed = false;
  assert.throws(() => assertPlanBBudget(freeFailure), /invalid|missing|exceeded/iu);
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
  assert.equal(report.rows.writtenPerRoom, 1_282);
  assert.equal(report.rows.writtenPerDay, 64_100);
  assert.equal(report.rows.readPerDay, 195_850);
  assert.equal(report.rows.indexRowsWrittenPerDay, 6_750);
  assert.equal(report.rows.alarmRowsWrittenPerDay, 1_750);
  assert.equal(report.rows.deletedRowsWrittenPerDay, 1_150);
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
  assert.equal(injected.rows.readPerDay, 234_400);
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
  assert.match(standalone.stdout, /one complete classic deal.*372 of 1,000 commands/iu);
  assert.match(standalone.stdout, /success after eviction.*READY/iu);
  assert.match(standalone.stdout, /attempt-3 exhaustion.*FAILED/iu);
  assert.match(standalone.stdout, /DDS.*3 logical attempts.*4 computations.*3 alarm requests/iu);
  assert.match(standalone.stdout, /DDS rows.*30 read.*13 written/iu);
  assert.match(standalone.stdout,
    /Gates.*billedRequests=true\/true.*duration=true\/true.*rowsRead=true\/true.*rowsWritten=true\/true.*storage=true\/true/iu);
  assert.match(standalone.stdout, /4,550 billed requests/u);
  assert.match(standalone.stdout, /3,398.4 GB-s/u);

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
  assert.equal(saved.budget.classicDealsPerRoom, 1);
  assert.equal(saved.budget.logicalDdsAttemptsPerDeal, 3);
  assert.equal(saved.budget.maxDdsComputationsPerDeal, 4);
  assert.equal(saved.budget.requestsPerDay, 4_550);
  assert.equal(saved.budget.requestTriggeredHandlerExecutionsPerRoom, 1_049);
  assert.equal(saved.budget.handlerExecutionsPerRoom, 1_058);
  assert.equal(saved.budget.ddsComputeExecutionsPerRoom, 4);
  assert.equal(saved.budget.durationGbSecondsPerDay, 3_398.4);
  assert.equal(saved.budget.writesPerDay, 64_100);
  assert.equal(saved.budget.readsPerDay, 195_850);
  assert.equal(saved.budget.variants.successAfterEviction.rowsReadPerRoom, 3_917);
  assert.equal(saved.budget.variants.successAfterEviction.rowsWrittenPerRoom, 1_282);
  assert.equal(saved.budget.variants.attempt3Exhaustion.rowsWrittenPerRoom, 1_282);
});
