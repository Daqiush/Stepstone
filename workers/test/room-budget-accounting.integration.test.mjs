import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';

import {
  MEASURED_CLASSIC_DDS_SQL_PROFILES,
  MEASURED_ROOM_SQL_PROFILES,
  measuredRegistrySqlProfiles,
  simulatePlanBBudget,
} from '../src/room-foundation/budget-model.mjs';
import {
  CLASSIC_DDS_ACTION_ID,
} from '../src/room-foundation/classic-dds-contract.mjs';
import { LIMITS } from '../src/room-foundation/constants.mjs';
import fixturesModule from '../../test/helpers/classic-fixtures.js';
import { createRoomWorkerRuntime } from './helpers/room-worker-runtime.mjs';

const { orderedDeal } = fixturesModule;
const DDS_TABLE = Array.from({ length: 5 }, (_, strain) => (
  Array.from({ length: 4 }, (_, seat) => (strain + seat) % 14)
));

let runtime;

before(async () => {
  runtime = await createRoomWorkerRuntime();
});

after(async () => {
  await runtime?.close();
});

async function registry(action, input = {}) {
  const response = await runtime.registry(action, input);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.value;
}

test('registry allocation accounting observes indexed scans at 50 rooms and 100 replay records', async () => {
  const now = Date.now();
  await registry('seedRegistryBudgetCardinality', {
    roomCodeCount: 50, creationRequestCount: 100, now,
  });
  await registry('resetRegistrySqlAccounting');

  await registry('allocateAt', {
    requestId: 'budget_allocate_00000001',
    requestHash: 'a'.repeat(64),
    now,
  });
  const observed = await registry('inspectRegistrySqlAccounting');
  const modeled = measuredRegistrySqlProfiles({ roomCodeCount: 50, creationRequestCount: 100 }).allocation;

  assert.equal(observed.totalRowsRead, modeled.rowsRead, JSON.stringify(observed));
  assert.equal(observed.totalRowsWritten, modeled.rowsWritten, JSON.stringify(observed));
  assert.ok(observed.totalRowsRead < 150, JSON.stringify(observed));
  assert.ok(observed.statements.every((statement) => Number.isSafeInteger(statement.rowsRead)));
});

test('registry lookup profile is measured at 50 rooms for every join and WebSocket lookup', async () => {
  const isolated = await createRoomWorkerRuntime();
  try {
    const call = async (action, input = {}) => {
      const response = await isolated.registry(action, input);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body.value;
    };
    const now = Date.now();
    await call('seedRegistryBudgetCardinality', {
      roomCodeCount: 50, creationRequestCount: 100, now,
    });
    await call('resetRegistrySqlAccounting');
    await call('lookupActive', { code: '049' });
    const accounting = await call('inspectRegistrySqlAccounting');
    const observed = {
      rowsRead: accounting.totalRowsRead,
      rowsWritten: accounting.totalRowsWritten,
    };
    const profiles = measuredRegistrySqlProfiles({
      roomCodeCount: 50, creationRequestCount: 100,
    });
    assert.deepEqual(observed, profiles.lookupActive);
    const report = simulatePlanBBudget({ sqlProfiles: {
      registry: profiles,
      room: MEASURED_ROOM_SQL_PROFILES,
    } });
    assert.equal(report.rows.operations['join registry lookup'].countPerRoom, 4);
    assert.equal(report.rows.operations['WebSocket registry lookup'].countPerRoom, 9);
  } finally {
    await isolated.close();
  }
});

test('registry allocation scan cost scales with 10/20 and 50/100 retained cardinalities', async () => {
  for (const count of [10, 50]) {
    const isolated = await createRoomWorkerRuntime();
    try {
      const now = Date.now();
      const call = async (action, input = {}) => {
        const response = await isolated.registry(action, input);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return response.body.value;
      };
      await call('seedRegistryBudgetCardinality', {
        roomCodeCount: count, creationRequestCount: count * 2, now,
      });
      await call('resetRegistrySqlAccounting');
      await call('allocateAt', {
        requestId: `scale_allocate_${String(count).padStart(16, '0')}`,
        requestHash: 'c'.repeat(64),
        now,
      });
      const observed = await call('inspectRegistrySqlAccounting');
      assert.equal(observed.totalRowsRead, measuredRegistrySqlProfiles({
        roomCodeCount: count, creationRequestCount: count * 2,
      }).allocation.rowsRead);
    } finally {
      await isolated.close();
    }
  }
});

test('registry lifecycle, fallback, and maximum reuse profiles cover 50/100 cardinality', async () => {
  const isolated = await createRoomWorkerRuntime();
  try {
    const call = async (action, input = {}) => {
      const response = await isolated.registry(action, input);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body.value;
    };
    const now = Date.now();
    const profiles = measuredRegistrySqlProfiles({ roomCodeCount: 50, creationRequestCount: 100 });
    await call('seedRegistryBudgetCardinality', {
      roomCodeCount: 50, creationRequestCount: 99, eligibleTombstoneCount: 50, now,
    });
    const allocation = await call('allocateAt', {
      requestId: 'lifecycle_allocate_000001',
      requestHash: 'd'.repeat(64),
      now,
    });
    const response = {
      v: 1,
      requestId: 'lifecycle_allocate_000001',
      roomCode: allocation.code,
      incarnation: allocation.incarnation,
      sessionId: 'lifecycle_session_000001',
      role: 'OWNER',
      seat: 'N',
    };

    for (const [name, action, input] of [
      ['activation', 'activateAt', {
        requestId: response.requestId,
        code: allocation.code,
        incarnation: allocation.incarnation,
        leaseId: allocation.leaseId,
        response,
        now: now + 1,
      }],
      ['markReleasePending', 'markReleasePendingAt', {
        code: allocation.code, incarnation: allocation.incarnation, now: now + 2,
      }],
      ['release', 'releaseAt', {
        code: allocation.code, incarnation: allocation.incarnation, now: now + 3,
      }],
    ]) {
      await call('resetRegistrySqlAccounting');
      await call(action, input);
      const observed = await call('inspectRegistrySqlAccounting');
      assert.equal(observed.totalRowsRead, profiles[name].rowsRead, `${name}: ${JSON.stringify(observed)}`);
      assert.equal(observed.totalRowsWritten, profiles[name].rowsWritten, name);
    }

    const reuseNow = now + LIMITS.registryTombstoneMs + 4;
    const maximumReuseState = await call('inspect');
    assert.equal(maximumReuseState.roomCodes.length, 50);
    assert.equal(maximumReuseState.creationRequests.length, 100);
    assert.equal(maximumReuseState.roomCodes.filter((item) => (
      item.status === 'TOMBSTONE' && item.tombstoneUntil <= reuseNow
    )).length, 50);
    await call('resetRegistrySqlAccounting');
    const reused = await call('allocateAt', {
      requestId: 'lifecycle_reuse_00000001',
      requestHash: 'e'.repeat(64),
      now: reuseNow,
    });
    const reuseAllocationProfile = await call('inspectRegistrySqlAccounting');
    assert.equal(reuseAllocationProfile.totalRowsRead, 226, JSON.stringify(reuseAllocationProfile));
    assert.equal(reuseAllocationProfile.totalRowsRead, profiles.reuseAllocation.rowsRead);
    assert.equal(reuseAllocationProfile.totalRowsWritten, profiles.reuseAllocation.rowsWritten);
    const initializedReuse = await isolated.room('initializeRoomAt', {
      code: reused.code,
      incarnation: reused.incarnation,
      leaseId: reused.leaseId,
      leaseExpiresAt: reused.leaseExpiresAt,
      requestId: 'lifecycle_reuse_00000001',
      requestHash: 'e'.repeat(64),
      tokenHash: 'f'.repeat(64),
      displayName: 'Reuse North',
      sessionId: 'reuse_session_000000001',
      now: now + LIMITS.registryTombstoneMs + 5,
    });
    assert.equal(initializedReuse.status, 200, JSON.stringify(initializedReuse.body));
    const reuseRoomProfile = await isolated.room('inspectRoomSqlAccounting', {
      code: reused.code,
      incarnation: reused.incarnation,
    });
    assert.equal(reuseRoomProfile.status, 200, JSON.stringify(reuseRoomProfile.body));
    assert.equal(
      reuseRoomProfile.body.value.totalRowsRead,
      MEASURED_ROOM_SQL_PROFILES.initialization.rowsRead,
    );
    assert.equal(
      reuseRoomProfile.body.value.totalRowsWritten,
      MEASURED_ROOM_SQL_PROFILES.initialization.rowsWritten,
    );
    await call('resetRegistrySqlAccounting');
    await call('activateAt', {
      requestId: 'lifecycle_reuse_00000001',
      code: reused.code,
      incarnation: reused.incarnation,
      leaseId: reused.leaseId,
      response: initializedReuse.body.value.response,
      now: now + LIMITS.registryTombstoneMs + 6,
    });
    const reuseActivationProfile = await call('inspectRegistrySqlAccounting');
    assert.equal(reuseActivationProfile.totalRowsRead, profiles.reuseActivation.rowsRead);
    assert.equal(reuseActivationProfile.totalRowsWritten, profiles.reuseActivation.rowsWritten);

    const fallbackRuntime = await createRoomWorkerRuntime();
    try {
      const fallback = async (action, input = {}) => {
        const result = await fallbackRuntime.registry(action, input);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        return result.body.value;
      };
      await fallback('seedRegistryBudgetCardinality', {
        roomCodeCount: 50, creationRequestCount: 100, now,
      });
      await fallback('markReleasePendingAt', { code: '000', incarnation: 1, now });
      await fallback('resetRegistrySqlAccounting');
      await fallback('reconcile', { now: now + 60_001 });
      const observed = await fallback('inspectRegistrySqlAccounting');
      assert.equal(observed.totalRowsRead, profiles.fallbackAlarm.rowsRead, JSON.stringify(observed));
    } finally {
      await fallbackRuntime.close();
    }
  } finally {
    await isolated.close();
  }
});

test('room initialization, join, auth, command, action, and alarm SQL match measured profiles', async () => {
  const isolated = await createRoomWorkerRuntime();
  let sequence = 0;
  const nextId = (label) => `${label}_${String(++sequence).padStart(16, '0')}`;
  const token = () => randomBytes(32).toString('base64url');
  const post = (path, body) => isolated.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    const reconnectToken = token();
    const created = await post('/api/rooms', {
      v: 1,
      requestId: nextId('profile_create'),
      displayName: 'North',
      reconnectToken,
    });
    assert.equal(created.status, 200, created.text);
    const room = created.body;
    const roomCall = async (action, input = {}) => {
      const response = await isolated.room(action, {
        code: room.roomCode,
        incarnation: room.incarnation,
        ...input,
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body.value;
    };
    const registryCall = async (action, input = {}) => {
      const response = await isolated.registry(action, input);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body.value;
    };
    const assertProfile = async (name) => {
      const observed = await roomCall('inspectRoomSqlAccounting');
      assert.equal(observed.totalRowsRead, MEASURED_ROOM_SQL_PROFILES[name].rowsRead, name);
      assert.equal(observed.totalRowsWritten, MEASURED_ROOM_SQL_PROFILES[name].rowsWritten, name);
      return observed;
    };

    await assertProfile('initialization');
    await roomCall('resetRoomSqlAccounting');
    const playerToken = token();
    const player = await post(`/api/rooms/${room.roomCode}/join`, {
      v: 1,
      requestId: nextId('profile_join'),
      displayName: 'East',
      reconnectToken: playerToken,
      requestedRole: 'player',
    });
    assert.equal(player.status, 200, player.text);
    const joinReads = [(await roomCall('inspectRoomSqlAccounting')).totalRowsRead];
    for (const [displayName, requestedRole] of [
      ['South', 'player'], ['West', 'player'], ['Watcher', 'spectator'],
    ]) {
      await roomCall('resetRoomSqlAccounting');
      const joined = await post(`/api/rooms/${room.roomCode}/join`, {
        v: 1,
        requestId: nextId('profile_join'),
        displayName,
        reconnectToken: token(),
        requestedRole,
      });
      assert.equal(joined.status, 200, joined.text);
      joinReads.push((await roomCall('inspectRoomSqlAccounting')).totalRowsRead);
    }
    assert.deepEqual(joinReads, [8, 13, 18, 19]);
    assert.equal(
      joinReads.reduce((sum, value) => sum + value, 0),
      MEASURED_ROOM_SQL_PROFILES.join.rowsRead * 4,
    );

    await roomCall('resetRoomSqlAccounting');
    await registryCall('resetRegistrySqlAccounting');
    const socket = await isolated.openWebSocket(`/api/rooms/${room.roomCode}/${room.incarnation}/ws`);
    const upgradeRoom = await roomCall('inspectRoomSqlAccounting');
    const upgradeRegistry = await registryCall('inspectRegistrySqlAccounting');
    assert.equal(upgradeRoom.totalRowsRead, MEASURED_ROOM_SQL_PROFILES.upgrade.rowsRead);
    assert.equal(upgradeRoom.totalRowsWritten, MEASURED_ROOM_SQL_PROFILES.upgrade.rowsWritten);
    assert.deepEqual({
      rowsRead: upgradeRegistry.totalRowsRead,
      rowsWritten: upgradeRegistry.totalRowsWritten,
    }, measuredRegistrySqlProfiles({
      roomCodeCount: 1, creationRequestCount: 1,
    }).lookupActive);

    await roomCall('resetRoomSqlAccounting');
    const nextToken = token();
    socket.send({
      v: 1,
      type: 'hello',
      id: nextId('profile_hello'),
      reconnectToken,
      nextReconnectToken: nextToken,
    });
    assert.equal(JSON.parse(await socket.nextMessage()).type, 'hello-ok');
    await assertProfile('hello');

    socket.close();
    await isolated.wait(100);
    const reconnectSocket = await isolated.openWebSocket(
      `/api/rooms/${room.roomCode}/${room.incarnation}/ws`,
    );
    await roomCall('resetRoomSqlAccounting');
    const finalToken = token();
    reconnectSocket.send({
      v: 1,
      type: 'hello',
      id: nextId('profile_reconnect'),
      reconnectToken: nextToken,
      nextReconnectToken: finalToken,
    });
    assert.equal(JSON.parse(await reconnectSocket.nextMessage()).type, 'hello-ok');
    await assertProfile('reconnectHello');

    await roomCall('resetRoomSqlAccounting');
    reconnectSocket.send({
      v: 1,
      type: 'command',
      id: nextId('profile_command'),
      name: 'foundation.increment',
      payload: { expectedRevision: 0 },
    });
    assert.equal(JSON.parse(await reconnectSocket.nextMessage()).type, 'reply');
    assert.equal(JSON.parse(await reconnectSocket.nextMessage()).type, 'event');
    const ordinaryCommand = await assertProfile('command');
    assert.equal(ordinaryCommand.roomStateRowsRead ?? ordinaryCommand.statements
      .filter(statement => statement.table === 'room_state')
      .reduce((sum, statement) => sum + statement.rowsRead, 0), 1);
    assert.equal(ordinaryCommand.roomStateRowsWritten ?? ordinaryCommand.statements
      .filter(statement => statement.table === 'room_state')
      .reduce((sum, statement) => sum + statement.rowsWritten, 0), 1);
    assert.equal(ordinaryCommand.statements
      .filter(statement => statement.table === 'sessions')
      .reduce((sum, statement) => sum + statement.rowsRead, 0), 0);

    await registryCall('setReleaseFault', {
      code: room.roomCode,
      incarnation: room.incarnation,
      type: 'release-always',
    });
    await roomCall('resetRoomSqlAccounting');
    reconnectSocket.close();
    await isolated.wait(100);
    await assertProfile('finalSocketClose');
    await roomCall('resetRoomSqlAccounting');
    await roomCall('runRoomAlarmAt', { now: Date.now() + LIMITS.roomExpiryMs + 1 });
    await assertProfile('expiryAlarmWithReleaseRetry');
    const closing = await isolated.room('inspectRoom', {
      code: room.roomCode,
      incarnation: room.incarnation,
    });
    assert.equal(closing.status, 200, JSON.stringify(closing.body));
    const deleteAll = simulatePlanBBudget().rows.operations['room deleteAll'].costEach;
    assert.equal(1 + closing.body.value.sessions.length + closing.body.value.pendingActions.length, 7);
    assert.equal(deleteAll.deletedRowsWritten, 8);
    assert.equal(
      closing.body.value.sessions.length * 2 + closing.body.value.pendingActions.length * 2,
      deleteAll.indexRowsWritten,
    );
  } finally {
    await isolated.close();
  }
});

function splitMeasuredProfile(accounting, { alarmRowsWritten, subtractOrdinary = false } = {}) {
  const profile = {
    rowsRead: accounting.totalRowsRead,
    tableRowsWritten: 0,
    indexRowsWritten: 0,
    alarmRowsWritten,
    deletedRowsWritten: 0,
  };
  for (const statement of accounting.statements) {
    if (statement.rowsWritten === 0) continue;
    if (statement.operation === 'DELETE') {
      profile.deletedRowsWritten += 1;
      profile.indexRowsWritten += statement.rowsWritten - 1;
    } else if (statement.table === 'pending_actions') {
      profile.tableRowsWritten += 1;
      profile.indexRowsWritten += statement.rowsWritten - 1;
    } else {
      profile.tableRowsWritten += statement.rowsWritten;
    }
  }
  if (subtractOrdinary) {
    profile.rowsRead -= MEASURED_ROOM_SQL_PROFILES.command.rowsRead;
    profile.tableRowsWritten -= MEASURED_ROOM_SQL_PROFILES.command.rowsWritten;
  }
  return profile;
}

async function createMeasuredClassicRoom(target, label) {
  let sequence = 0;
  const nextId = suffix => `${label}_${suffix}_${String(++sequence).padStart(8, '0')}`;
  const token = () => randomBytes(32).toString('base64url');
  const post = (path, body) => target.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ownerToken = token();
  const created = await post('/api/rooms', {
    v: 1, requestId: nextId('create'), displayName: 'North', reconnectToken: ownerToken,
  });
  assert.equal(created.status, 200, created.text);
  const room = created.body;
  const sessions = [{ ...room, reconnectToken: ownerToken }];
  for (const displayName of ['East', 'South', 'West']) {
    const reconnectToken = token();
    const joined = await post(`/api/rooms/${room.roomCode}/join`, {
      v: 1, requestId: nextId('join'), displayName, reconnectToken, requestedRole: 'player',
    });
    assert.equal(joined.status, 200, joined.text);
    sessions.push({ ...joined.body, reconnectToken });
  }
  const sockets = [];
  for (const session of sessions) {
    const socket = await target.openWebSocket(
      `/api/rooms/${room.roomCode}/${room.incarnation}/ws`,
    );
    socket.send({
      v: 1, type: 'hello', id: nextId('hello'), reconnectToken: session.reconnectToken,
      nextReconnectToken: token(),
    });
    assert.equal(JSON.parse(await socket.nextMessage()).type, 'hello-ok');
    sockets.push(socket);
  }
  return { room, sockets, nextId };
}

async function roomValue(target, room, action, input = {}) {
  const response = await target.room(action, {
    code: room.roomCode, incarnation: room.incarnation, ...input,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.value;
}

async function accounting(target, room) {
  return roomValue(target, room, 'inspectRoomSqlAccounting');
}

async function waitForAccounting(target, room, predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const observed = await accounting(target, room);
    if (predicate(observed)) return observed;
    await target.wait(10);
  }
  assert.fail('timed out waiting for measured classic DDS SQL');
}

async function inspectRoom(target, room) {
  return roomValue(target, room, 'inspectRoom');
}

async function waitForRoom(target, room, predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await inspectRoom(target, room);
    if (predicate(state)) return state;
    await target.wait(10);
  }
  assert.fail('timed out waiting for classic DDS room state');
}

async function startMeasuredClassicDeal(target, label) {
  const { room, sockets, nextId } = await createMeasuredClassicRoom(target, label);
  await roomValue(target, room, 'resetRoomSqlAccounting');
  sockets[0].send({
    v: 1,
    type: 'command',
    id: nextId('start'),
    name: 'classic.start',
    payload: { expectedRevision: 0 },
  });
  assert.equal(JSON.parse(await sockets[0].nextMessage()).type, 'reply');
  for (const socket of sockets) {
    for (let index = 0; index < 3; index += 1) await socket.nextMessage();
  }
  const creationAccounting = await waitForAccounting(target, room, observed => (
    observed.statements.some(statement => (
      statement.table === 'pending_actions' && statement.operation === 'SELECT'
    ))
  ));
  const creation = splitMeasuredProfile(creationAccounting, {
    alarmRowsWritten: 1,
    subtractOrdinary: true,
  });
  return { room, sockets, creation };
}

async function pendingDdsAction(target, room) {
  const state = await inspectRoom(target, room);
  return state.pendingActions.find(action => action.actionId === CLASSIC_DDS_ACTION_ID);
}

async function resolveDds(target, room, result, table = undefined) {
  await roomValue(target, room, 'resolveRoomClassicDds', {
    result,
    ...(table === undefined ? {} : { table }),
  });
}

test('Miniflare measures exact classic DDS action, retry, stale, and terminal SQL splits', async () => {
  const successRuntime = await createRoomWorkerRuntime({
    vars: {
      CLASSIC_TEST_DEALS_JSON: JSON.stringify([orderedDeal()]),
      CLASSIC_TEST_DDS_PAUSE: 'true',
    },
  });
  const failureRuntime = await createRoomWorkerRuntime({
    vars: {
      CLASSIC_TEST_DEALS_JSON: JSON.stringify([orderedDeal()]),
      CLASSIC_TEST_DDS_PAUSE: 'true',
    },
  });
  try {
    const success = await startMeasuredClassicDeal(successRuntime, 'budget_dds_success');
    assert.deepEqual(success.creation, MEASURED_CLASSIC_DDS_SQL_PROFILES.actionCreation);

    const initialState = await inspectRoom(successRuntime, success.room);
    const attempt1 = initialState.pendingActions.find(
      action => action.actionId === CLASSIC_DDS_ACTION_ID,
    );
    assert.equal(initialState.alarmAt, attempt1.dueAt);
    await roomValue(successRuntime, success.room, 'resetRoomSqlAccounting');
    await roomValue(successRuntime, success.room, 'runRoomAlarmAt', { now: attempt1.dueAt });
    const alarmAccounting = await waitForAccounting(successRuntime, success.room, observed => (
      observed.statements.filter(statement => statement.table === 'pending_actions').length >= 2
    ));
    assert.deepEqual(
      splitMeasuredProfile(alarmAccounting, { alarmRowsWritten: 0 }),
      MEASURED_CLASSIC_DDS_SQL_PROFILES.alarmComputation,
    );
    await roomValue(successRuntime, success.room, 'dropRoomAlarm');
    const overlap = await roomValue(successRuntime, success.room, 'inspectRoomClassicDds');
    assert.equal(overlap.paused.length, 2);

    await roomValue(successRuntime, success.room, 'resetRoomSqlAccounting');
    await resolveDds(successRuntime, success.room, 'failure');
    const retryAccounting = await waitForAccounting(successRuntime, success.room, observed => (
      observed.statements.some(statement => (
        statement.table === 'pending_actions' && statement.operation === 'UPDATE'
      ))
    ));
    const retry = splitMeasuredProfile(retryAccounting, { alarmRowsWritten: 1 });
    assert.deepEqual(retry, MEASURED_CLASSIC_DDS_SQL_PROFILES.retryUpdate);
    await roomValue(successRuntime, success.room, 'resetRoomSqlAccounting');
    await resolveDds(successRuntime, success.room, 'failure');
    const staleAccounting = await waitForAccounting(successRuntime, success.room, observed => (
      observed.statements.some(statement => statement.table === 'pending_actions')
    ));
    const stale = splitMeasuredProfile(staleAccounting, { alarmRowsWritten: 0 });
    assert.deepEqual(stale, MEASURED_CLASSIC_DDS_SQL_PROFILES.staleOverlapGuard);

    const attempt2 = await pendingDdsAction(successRuntime, success.room);
    await successRuntime.restartRoom(success.room.roomCode, success.room.incarnation);
    await roomValue(successRuntime, success.room, 'runRoomAlarmAt', { now: attempt2.dueAt });
    await roomValue(successRuntime, success.room, 'dropRoomAlarm');
    await roomValue(successRuntime, success.room, 'resetRoomSqlAccounting');
    await resolveDds(successRuntime, success.room, 'failure');
    const retry2Accounting = await waitForAccounting(successRuntime, success.room, observed => (
      observed.statements.some(statement => (
        statement.table === 'pending_actions' && statement.operation === 'UPDATE'
      ))
    ));
    assert.deepEqual(
      splitMeasuredProfile(retry2Accounting, { alarmRowsWritten: 1 }),
      MEASURED_CLASSIC_DDS_SQL_PROFILES.retryUpdate,
    );
    const attempt3 = await pendingDdsAction(successRuntime, success.room);
    await roomValue(successRuntime, success.room, 'runRoomAlarmAt', { now: attempt3.dueAt });
    await roomValue(successRuntime, success.room, 'dropRoomAlarm');
    await roomValue(successRuntime, success.room, 'resetRoomSqlAccounting');
    await resolveDds(successRuntime, success.room, 'success', DDS_TABLE);
    const successAccounting = await waitForAccounting(successRuntime, success.room, observed => (
      observed.statements.some(statement => (
        statement.table === 'pending_actions' && statement.operation === 'DELETE'
      ))
    ));
    assert.deepEqual(
      splitMeasuredProfile(successAccounting, { alarmRowsWritten: 1 }),
      MEASURED_CLASSIC_DDS_SQL_PROFILES.successfulSettlement,
    );
    const readyState = await waitForRoom(
      successRuntime,
      success.room,
      state => state.classicState.ddsStatus === 'READY',
    );
    assert.equal(readyState.classicState.ddsStatus, 'READY');
    assert.equal(readyState.pendingActions.some(
      action => action.actionId === CLASSIC_DDS_ACTION_ID,
    ), false);

    const failure = await startMeasuredClassicDeal(failureRuntime, 'budget_dds_failure');
    assert.deepEqual(failure.creation, MEASURED_CLASSIC_DDS_SQL_PROFILES.actionCreation);
    const failureAttempt1 = await pendingDdsAction(failureRuntime, failure.room);
    await roomValue(failureRuntime, failure.room, 'runRoomAlarmAt', {
      now: failureAttempt1.dueAt,
    });
    await roomValue(failureRuntime, failure.room, 'dropRoomAlarm');
    assert.equal((await roomValue(
      failureRuntime,
      failure.room,
      'inspectRoomClassicDds',
    )).paused.length, 2);
    for (const attempt of [1, 2, 3]) {
      if (attempt > 1) {
        const action = await pendingDdsAction(failureRuntime, failure.room);
        await roomValue(failureRuntime, failure.room, 'runRoomAlarmAt', { now: action.dueAt });
        await roomValue(failureRuntime, failure.room, 'dropRoomAlarm');
      }
      await roomValue(failureRuntime, failure.room, 'resetRoomSqlAccounting');
      await resolveDds(failureRuntime, failure.room, 'failure');
      const terminal = attempt === 3;
      const observed = await waitForAccounting(failureRuntime, failure.room, profile => (
        profile.statements.some(statement => (
          statement.table === 'pending_actions'
          && statement.operation === (terminal ? 'DELETE' : 'UPDATE')
        ))
      ));
      assert.deepEqual(
        splitMeasuredProfile(observed, { alarmRowsWritten: 1 }),
        terminal
          ? MEASURED_CLASSIC_DDS_SQL_PROFILES.exhaustedSettlement
          : MEASURED_CLASSIC_DDS_SQL_PROFILES.retryUpdate,
      );
      const state = await waitForRoom(
        failureRuntime,
        failure.room,
        value => terminal
          ? value.classicState.ddsStatus === 'FAILED'
          : value.pendingActions.some(item => item.actionId === CLASSIC_DDS_ACTION_ID),
      );
      const action = state.pendingActions.find(
        item => item.actionId === CLASSIC_DDS_ACTION_ID,
      );
      if (terminal) {
        assert.equal(state.classicState.ddsStatus, 'FAILED');
        assert.equal(action, undefined);
      }
      if (attempt === 1) {
        await roomValue(failureRuntime, failure.room, 'resetRoomSqlAccounting');
        await resolveDds(failureRuntime, failure.room, 'failure');
        const staleObserved = await waitForAccounting(
          failureRuntime,
          failure.room,
          profile => profile.statements.some(statement => statement.table === 'pending_actions'),
        );
        assert.deepEqual(
          splitMeasuredProfile(staleObserved, { alarmRowsWritten: 0 }),
          MEASURED_CLASSIC_DDS_SQL_PROFILES.staleOverlapGuard,
        );
      }
    }
  } finally {
    await successRuntime.close();
    await failureRuntime.close();
  }
});
