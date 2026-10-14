import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';

import {
  MEASURED_ROOM_SQL_PROFILES,
  measuredRegistrySqlProfiles,
  simulatePlanBBudget,
} from '../src/room-foundation/budget-model.mjs';
import { LIMITS } from '../src/room-foundation/constants.mjs';
import { createRoomWorkerRuntime } from './helpers/room-worker-runtime.mjs';

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

test('registry allocation accounting observes consumed scans at 50-room cardinality', async () => {
  const now = Date.now();
  await registry('seedRegistryBudgetCardinality', { count: 50, now });
  await registry('resetRegistrySqlAccounting');

  await registry('allocateAt', {
    requestId: 'budget_allocate_00000001',
    requestHash: 'a'.repeat(64),
    now,
  });
  const observed = await registry('inspectRegistrySqlAccounting');
  const modeled = measuredRegistrySqlProfiles(50).allocation;

  assert.equal(observed.totalRowsRead, modeled.rowsRead, JSON.stringify(observed));
  assert.equal(observed.totalRowsWritten, modeled.rowsWritten, JSON.stringify(observed));
  assert.ok(observed.statements.some((statement) => (
    statement.table === 'room_codes' && statement.rowsRead >= 50
  )));
  assert.ok(observed.statements.every((statement) => Number.isSafeInteger(statement.rowsRead)));
});

test('registry allocation scan cost scales with actual 10 and 50 row cardinalities', async () => {
  for (const count of [10, 50]) {
    const isolated = await createRoomWorkerRuntime();
    try {
      const now = Date.now();
      const call = async (action, input = {}) => {
        const response = await isolated.registry(action, input);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return response.body.value;
      };
      await call('seedRegistryBudgetCardinality', { count, now });
      await call('resetRegistrySqlAccounting');
      await call('allocateAt', {
        requestId: `scale_allocate_${String(count).padStart(16, '0')}`,
        requestHash: 'c'.repeat(64),
        now,
      });
      const observed = await call('inspectRegistrySqlAccounting');
      assert.equal(observed.totalRowsRead, measuredRegistrySqlProfiles(count).allocation.rowsRead);
    } finally {
      await isolated.close();
    }
  }
});

test('registry lifecycle and fallback profiles cover nextDue scans at 50 rows', async () => {
  const isolated = await createRoomWorkerRuntime();
  try {
    const call = async (action, input = {}) => {
      const response = await isolated.registry(action, input);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body.value;
    };
    const now = Date.now();
    const profiles = measuredRegistrySqlProfiles(50);
    await call('seedRegistryBudgetCardinality', { count: 50, now });
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

    await call('resetRegistrySqlAccounting');
    const reused = await call('allocateAt', {
      requestId: 'lifecycle_reuse_00000001',
      requestHash: 'e'.repeat(64),
      now: now + LIMITS.registryTombstoneMs + 4,
    });
    const reuseAllocationProfile = await call('inspectRegistrySqlAccounting');
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
      await fallback('seedRegistryBudgetCardinality', { count: 50, now });
      await fallback('markReleasePendingAt', { code: '000', incarnation: 1, now });
      await fallback('resetRegistrySqlAccounting');
      await fallback('reconcile', { now: now + 60_001 });
      const observed = await fallback('inspectRegistrySqlAccounting');
      assert.ok(observed.totalRowsRead > 50, JSON.stringify(observed));
      assert.ok(observed.totalRowsRead <= profiles.fallbackAlarm.rowsRead, JSON.stringify(observed));
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
    assert.deepEqual(joinReads, [5, 9, 13, 13]);
    assert.equal(
      joinReads.reduce((sum, value) => sum + value, 0),
      MEASURED_ROOM_SQL_PROFILES.join.rowsRead * 4,
    );

    await roomCall('resetRoomSqlAccounting');
    await registryCall('resetRegistrySqlAccounting');
    const socket = await isolated.openWebSocket(`/api/rooms/${room.roomCode}/${room.incarnation}/ws`);
    const upgradeRoom = await roomCall('inspectRoomSqlAccounting');
    const upgradeRegistry = await registryCall('inspectRegistrySqlAccounting');
    assert.equal(upgradeRoom.totalRowsRead + upgradeRegistry.totalRowsRead, MEASURED_ROOM_SQL_PROFILES.upgrade.rowsRead);
    assert.equal(upgradeRoom.totalRowsWritten + upgradeRegistry.totalRowsWritten, MEASURED_ROOM_SQL_PROFILES.upgrade.rowsWritten);

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
    await assertProfile('command');

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
    assert.equal(deleteAll.deletedRowsWritten, 7);
    assert.equal(
      closing.body.value.sessions.length * 2 + closing.body.value.pendingActions.length * 2,
      deleteAll.indexRowsWritten,
    );
  } finally {
    await isolated.close();
  }
});
