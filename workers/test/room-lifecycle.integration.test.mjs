import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { LIMITS, WEBSOCKET_CLOSE } from '../src/room-foundation/constants.mjs';
import { createRoomWorkerRuntime } from './helpers/room-worker-runtime.mjs';

let runtime;
let sequence = 0;

before(async () => {
  runtime = await createRoomWorkerRuntime();
});

after(async () => {
  await runtime?.close();
});

function id(label) {
  sequence += 1;
  return `${label}_${String(sequence).padStart(16, '0')}`;
}

function token(seed = ++sequence) {
  return Buffer.from(Uint8Array.from(
    { length: 32 },
    (_, index) => (seed * 43 + index * 31) % 256,
  )).toString('base64url');
}

async function post(path, body) {
  return runtime.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createRoom(label) {
  const reconnectToken = token();
  const response = await post('/api/rooms', {
    v: 1,
    requestId: id(label),
    displayName: 'North',
    reconnectToken,
  });
  assert.equal(response.status, 200, response.text);
  return { ...response.body, reconnectToken };
}

async function joinRoom(room, label, requestedRole = 'player') {
  const reconnectToken = token();
  const response = await post(`/api/rooms/${room.roomCode}/join`, {
    v: 1,
    requestId: id(label),
    displayName: label,
    reconnectToken,
    requestedRole,
  });
  assert.equal(response.status, 200, response.text);
  return { ...response.body, reconnectToken };
}

function wsPath(room, incarnation = room.incarnation) {
  return `/api/rooms/${room.roomCode}/${incarnation}/ws`;
}

async function authenticate(room, session) {
  const socket = await runtime.openWebSocket(wsPath(room));
  const nextReconnectToken = token();
  const rotationId = id('lifecycle_rotation');
  socket.send({
    v: 1,
    type: 'hello',
    id: rotationId,
    reconnectToken: session.reconnectToken,
    nextReconnectToken,
  });
  const reply = JSON.parse(await socket.nextMessage());
  assert.equal(reply.type, 'hello-ok');
  return {
    socket,
    session: { ...session, reconnectToken: nextReconnectToken },
    reply,
  };
}

async function inspectRoom(room) {
  return runtime.room('inspectRoom', {
    code: room.roomCode,
    incarnation: room.incarnation,
  });
}

async function inspectRegistry() {
  const response = await runtime.registry('inspect');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.value;
}

async function waitForRoom(room, predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await inspectRoom(room);
    if (predicate(latest)) return latest;
    await runtime.wait(25);
  }
  assert.fail(`${message}: ${JSON.stringify(latest?.body)}`);
}

test('non-owner authentication cannot prevent owner timeout, terminal response loss, deletion, or safe reuse', async () => {
  const oldRoom = await createRoom('lifecycle_old_owner');
  const player = await joinRoom(oldRoom, 'LifecycleEast');
  const authenticated = await authenticate(oldRoom, player);
  const before = await inspectRoom(oldRoom);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const ownerExpiry = before.body.value.pendingActions.find(
    (action) => action.kind === 'owner-auth-expiry',
  );
  assert.equal(ownerExpiry.actionId, 'owner-auth-expiry');
  assert.equal(
    before.body.value.pendingActions.some((action) => action.kind === 'handshake-timeout'),
    false,
  );

  const configured = await runtime.registry('setReleaseFault', {
    code: oldRoom.roomCode,
    incarnation: oldRoom.incarnation,
    type: 'after-release-before-response',
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  const firstAlarm = await runtime.room('runRoomAlarmAt', {
    code: oldRoom.roomCode,
    incarnation: oldRoom.incarnation,
    now: ownerExpiry.dueAt,
  });
  assert.equal(firstAlarm.status, 200, JSON.stringify(firstAlarm.body));
  assert.equal((await authenticated.socket.closed()).code, WEBSOCKET_CLOSE.ROOM_EXPIRED);

  const closing = await inspectRoom(oldRoom);
  assert.equal(closing.status, 200, JSON.stringify(closing.body));
  assert.equal(closing.body.value.roomState.status, 'CLOSING');
  assert.ok(closing.body.value.sessions.every((session) => session.connectionId === null));
  assert.equal(closing.body.value.pendingActions.length, 1);
  assert.deepEqual(
    closing.body.value.pendingActions.map((action) => action.actionId),
    ['registry-release'],
  );
  assert.equal(closing.body.value.pendingActions[0].payload.attempt, 1);
  assert.equal(closing.body.value.pendingActions[0].payload.phase, 'RELEASE');

  const tombstoned = await inspectRegistry();
  const oldRegistryRow = tombstoned.roomCodes.find((row) => row.code === oldRoom.roomCode);
  assert.equal(oldRegistryRow.status, 'TOMBSTONE');
  const retryAt = closing.body.value.pendingActions[0].dueAt;
  const reuseNow = oldRegistryRow.tombstoneUntil;
  const reuseRequestId = id('lifecycle_reuse_owner');
  const allocation = await runtime.registry('allocateAt', {
    requestId: reuseRequestId,
    requestHash: 'a'.repeat(64),
    now: reuseNow,
  });
  assert.equal(allocation.status, 200, JSON.stringify(allocation.body));
  assert.equal(allocation.body.value.code, oldRoom.roomCode);
  assert.equal(allocation.body.value.incarnation, oldRoom.incarnation + 1);
  const nextRoom = allocation.body.value;
  const initialized = await runtime.room('initializeRoomAt', {
    code: nextRoom.code,
    incarnation: nextRoom.incarnation,
    leaseId: nextRoom.leaseId,
    leaseExpiresAt: nextRoom.leaseExpiresAt,
    requestId: reuseRequestId,
    requestHash: 'a'.repeat(64),
    tokenHash: 'b'.repeat(64),
    sessionId: id('lifecycle_reuse_session'),
    now: reuseNow,
  });
  assert.equal(initialized.status, 200, JSON.stringify(initialized.body));
  const activated = await runtime.registry('activateAt', {
    requestId: reuseRequestId,
    code: nextRoom.code,
    incarnation: nextRoom.incarnation,
    leaseId: nextRoom.leaseId,
    response: initialized.body.value.response,
    now: reuseNow,
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));

  const retry = await runtime.room('runRoomAlarmAt', {
    code: oldRoom.roomCode,
    incarnation: oldRoom.incarnation,
    now: Math.max(retryAt, reuseNow + 1),
  });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  const deleted = await inspectRoom(oldRoom);
  assert.equal(deleted.body.error.code, 'ROOM_NOT_FOUND');

  await assert.rejects(runtime.openWebSocket(wsPath(oldRoom)), /upgrade failed/u);
  const delayedJoin = await runtime.room('joinRoomAt', {
    code: oldRoom.roomCode,
    incarnation: oldRoom.incarnation,
    requestId: id('delayed_old_join'),
    requestHash: 'c'.repeat(64),
    tokenHash: 'd'.repeat(64),
    requestedRole: 'player',
  });
  assert.equal(delayedJoin.body.error.code, 'ROOM_NOT_FOUND');
  assert.deepEqual((await runtime.registry('releaseAt', {
    code: oldRoom.roomCode,
    incarnation: oldRoom.incarnation,
    now: reuseNow + 1,
  })).body.value, { result: 'SUPERSEDED' });

  const delayedCommandRejection = await authenticated.socket.closed();
  assert.equal(delayedCommandRejection.code, WEBSOCKET_CLOSE.ROOM_EXPIRED);
  assert.equal(authenticated.socket.raw.readyState, WebSocket.CLOSED);
  const newInspection = await inspectRoom({
    roomCode: nextRoom.code,
    incarnation: nextRoom.incarnation,
  });
  assert.equal(newInspection.body.value.roomState.revision, 0);
  assert.equal(newInspection.body.value.roomState.foundationCounter, 0);
  const currentJoin = await joinRoom({
    roomCode: nextRoom.code,
    incarnation: nextRoom.incarnation,
  }, 'CurrentEast');
  assert.equal(currentJoin.incarnation, nextRoom.incarnation);
});

test('an exact committed mark-release response loss converges through retry and deletes the room', async () => {
  const room = await createRoom('mark_response_loss_owner');
  const before = await inspectRoom(room);
  const ownerExpiry = before.body.value.pendingActions.find(
    (action) => action.kind === 'owner-auth-expiry',
  );

  const configured = await runtime.registry('setReleaseFault', {
    code: room.roomCode,
    incarnation: room.incarnation,
    type: 'after-mark-before-response',
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  const firstAlarm = await runtime.room('runRoomAlarmAt', {
    code: room.roomCode,
    incarnation: room.incarnation,
    now: ownerExpiry.dueAt,
  });
  assert.equal(firstAlarm.status, 200, JSON.stringify(firstAlarm.body));
  const closing = await inspectRoom(room);
  assert.equal(closing.body.value.roomState.status, 'CLOSING');
  assert.equal(closing.body.value.pendingActions.length, 1);
  const retry = closing.body.value.pendingActions[0];
  assert.equal(retry.actionId, 'registry-release');
  assert.deepEqual(retry.payload, { attempt: 1, phase: 'MARK' });

  const retryAlarm = await runtime.room('runRoomAlarmAt', {
    code: room.roomCode,
    incarnation: room.incarnation,
    now: retry.dueAt,
  });
  assert.equal(retryAlarm.status, 200, JSON.stringify(retryAlarm.body));
  const deleted = await inspectRoom(room);
  assert.equal(deleted.body?.error?.code, 'ROOM_NOT_FOUND', JSON.stringify(deleted.body));

  const registry = await inspectRegistry();
  const released = registry.roomCodes.find((row) => row.code === room.roomCode);
  assert.equal(released.incarnation, room.incarnation);
  assert.equal(released.status, 'TOMBSTONE');
});

test('owner authentication cancels owner expiry and reconnect cancels one deterministic 24-hour expiry', async () => {
  const room = await createRoom('reconnect_owner');
  const first = await authenticate(room, room);
  let state = await inspectRoom(room);
  assert.equal(state.body.value.pendingActions.length, 0);

  const closedAt = Date.now();
  first.socket.close();
  state = await waitForRoom(
    room,
    (inspection) => inspection.body?.value?.pendingActions
      ?.some((action) => action.kind === 'room-expiry'),
    'timed out waiting for first final-socket expiry',
  );
  assert.equal(state.status, 200, JSON.stringify(state.body));
  const expiry = state.body.value.pendingActions.filter((action) => action.kind === 'room-expiry');
  assert.equal(expiry.length, 1);
  assert.equal(expiry[0].actionId, 'room-expiry');
  assert.ok(expiry[0].dueAt >= closedAt + LIMITS.roomExpiryMs);
  assert.ok(expiry[0].dueAt <= Date.now() + LIMITS.roomExpiryMs);
  assert.equal(state.body.value.roomState.expiresAt, expiry[0].dueAt);
  assert.equal(state.body.value.alarmAt, expiry[0].dueAt);

  const reconnected = await authenticate(room, first.session);
  state = await inspectRoom(room);
  assert.equal(state.body.value.pendingActions.some((action) => action.kind === 'room-expiry'), false);
  assert.equal(state.body.value.roomState.expiresAt, null);
  assert.equal(state.body.value.alarmAt, null);

  reconnected.socket.close();
  state = await waitForRoom(
    room,
    (inspection) => inspection.body?.value?.pendingActions
      ?.some((action) => action.kind === 'room-expiry'),
    'timed out waiting for reconnected final-socket expiry',
  );
  assert.deepEqual(
    state.body.value.pendingActions.map((action) => action.actionId),
    ['room-expiry'],
  );
  const expired = await runtime.room('runRoomAlarmAt', {
    code: room.roomCode,
    incarnation: room.incarnation,
    now: state.body.value.pendingActions[0].dueAt,
  });
  assert.equal(expired.status, 200, JSON.stringify(expired.body));
  assert.equal((await inspectRoom(room)).body.error.code, 'ROOM_NOT_FOUND');
});

test('wake clears persisted authority without a matching socket and schedules final-socket expiry', async () => {
  const room = await createRoom('wake_orphan_owner');
  const player = await joinRoom(room, 'WakeOrphanEast');
  const authenticated = await authenticate(room, player);
  const orphaned = await runtime.room('orphanRoomSessionAuthority', {
    code: room.roomCode,
    incarnation: room.incarnation,
    sessionId: player.sessionId,
    connectionId: id('missing_attachment'),
  });
  assert.equal(orphaned.status, 200, JSON.stringify(orphaned.body));

  await runtime.restartRoom(room.roomCode, room.incarnation);
  const recovered = await waitForRoom(
    room,
    (inspection) => {
      const value = inspection.body?.value;
      const recoveredPlayer = value?.sessions?.find(
        (session) => session.sessionId === player.sessionId,
      );
      return recoveredPlayer?.connectionId === null
        && value.pendingActions.some((action) => action.actionId === 'room-expiry');
    },
    'wake did not clear orphaned persisted authority',
  );
  assert.equal((await authenticated.socket.closed()).code, WEBSOCKET_CLOSE.SESSION_REPLACED);
  assert.ok(recovered.body.value.pendingActions.some(
    (action) => action.actionId === 'owner-auth-expiry',
  ));
  assert.equal(recovered.body.value.alarmAt, Math.min(
    ...recovered.body.value.pendingActions.map((action) => action.dueAt),
  ));
  const accounting = await runtime.room('inspectRoomCommandAccounting', {
    code: room.roomCode,
    incarnation: room.incarnation,
  });
  assert.equal(accounting.status, 200, JSON.stringify(accounting.body));
  assert.equal(accounting.body.value.cache.ready, true);
  assert.equal(accounting.body.value.cache.authorityCount, 2);
  assert.ok(accounting.body.value.lastWake.totalRowsRead <= 17);

  const reconnected = await authenticate(room, authenticated.session);
  reconnected.socket.send({
    v: 1,
    type: 'command',
    id: id('wake_recovered_command'),
    name: 'foundation.increment',
    payload: { expectedRevision: 0 },
  });
  const command = JSON.parse(await reconnected.socket.nextMessage());
  assert.equal(command.type, 'reply');
  assert.equal(command.payload.revision, 1);
  const active = await inspectRoom(room);
  assert.equal(active.body.value.pendingActions.some(
    (action) => action.actionId === 'room-expiry',
  ), false);
  assert.ok(active.body.value.pendingActions.some(
    (action) => action.actionId === 'owner-auth-expiry',
  ));
});

test('release failures keep one action and use bounded exponential retry before deletion', async () => {
  const room = await createRoom('retry_owner');
  const before = await inspectRoom(room);
  const ownerExpiry = before.body.value.pendingActions[0];
  const configured = await runtime.registry('setReleaseFault', {
    code: room.roomCode,
    incarnation: room.incarnation,
    type: 'release-always',
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  let now = ownerExpiry.dueAt;
  let previousDelay = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const alarm = await runtime.room('runRoomAlarmAt', {
      code: room.roomCode,
      incarnation: room.incarnation,
      now,
    });
    assert.equal(alarm.status, 200, JSON.stringify(alarm.body));
    const state = await inspectRoom(room);
    assert.equal(state.body.value.roomState.status, 'CLOSING');
    assert.equal(state.body.value.pendingActions.length, 1);
    const retry = state.body.value.pendingActions[0];
    assert.equal(retry.actionId, 'registry-release');
    assert.equal(retry.payload.attempt, attempt);
    const delay = retry.dueAt - now;
    assert.ok(delay >= previousDelay);
    assert.ok(delay <= LIMITS.registryReleaseBackoffMaxMs);
    previousDelay = delay;
    now = retry.dueAt;
    if (attempt === 1) {
      const recovered = await runtime.room('recoverRoomAlarmAt', {
        code: room.roomCode,
        incarnation: room.incarnation,
        now,
        currentAlarmAt: now,
      });
      assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
      assert.equal(recovered.body.value.alarmAt, now);
    }
  }
  const jumped = await runtime.room('setRoomReleaseRetryAttempt', {
    code: room.roomCode,
    incarnation: room.incarnation,
    attempt: 12,
    dueAt: now,
  });
  assert.equal(jumped.status, 200, JSON.stringify(jumped.body));
  const cappedAlarm = await runtime.room('runRoomAlarmAt', {
    code: room.roomCode,
    incarnation: room.incarnation,
    now,
  });
  assert.equal(cappedAlarm.status, 200, JSON.stringify(cappedAlarm.body));
  const cappedState = await inspectRoom(room);
  const cappedRetry = cappedState.body.value.pendingActions[0];
  assert.equal(cappedRetry.actionId, 'registry-release');
  assert.equal(cappedRetry.payload.attempt, 13);
  assert.equal(cappedRetry.dueAt - now, LIMITS.registryReleaseBackoffMaxMs);
  now = cappedRetry.dueAt;

  const cleared = await runtime.registry('setReleaseFault', {
    code: room.roomCode,
    incarnation: room.incarnation,
    type: null,
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const completed = await runtime.room('runRoomAlarmAt', {
    code: room.roomCode,
    incarnation: room.incarnation,
    now,
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal((await inspectRoom(room)).body.error.code, 'ROOM_NOT_FOUND');
});

test('registry reconciliation recovers a stale release-pending room whose alarm was lost', async () => {
  const room = await createRoom('registry_fallback_owner');
  const before = await inspectRoom(room);
  const ownerExpiry = before.body.value.pendingActions.find(
    (action) => action.kind === 'owner-auth-expiry',
  );
  const configured = await runtime.registry('setReleaseFault', {
    code: room.roomCode,
    incarnation: room.incarnation,
    type: 'release-once',
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  const firstAlarm = await runtime.room('runRoomAlarmAt', {
    code: room.roomCode,
    incarnation: room.incarnation,
    now: ownerExpiry.dueAt,
  });
  assert.equal(firstAlarm.status, 200, JSON.stringify(firstAlarm.body));
  const closing = await inspectRoom(room);
  assert.equal(closing.body.value.roomState.status, 'CLOSING');
  assert.deepEqual(closing.body.value.pendingActions.map((action) => action.actionId), [
    'registry-release',
  ]);
  assert.equal(closing.body.value.pendingActions[0].payload.phase, 'RELEASE');

  const dropped = await runtime.room('dropRoomAlarm', {
    code: room.roomCode,
    incarnation: room.incarnation,
  });
  assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
  assert.equal((await inspectRoom(room)).body.value.alarmAt, null);

  const registryBefore = await inspectRegistry();
  const pending = registryBefore.roomCodes.find((row) => row.code === room.roomCode);
  assert.equal(pending.status, 'RELEASE_PENDING');
  const fallbackAt = pending.updatedAt + 60_000;
  assert.equal(registryBefore.alarmAt, fallbackAt);
  const releaseWallStart = Date.now();
  const reconciled = await runtime.registry('reconcile', { now: fallbackAt });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
  assert.equal((await inspectRoom(room)).body?.error?.code, 'ROOM_NOT_FOUND');

  const registryAfter = await inspectRegistry();
  const released = registryAfter.roomCodes.find((row) => row.code === room.roomCode);
  assert.equal(released.incarnation, room.incarnation);
  assert.equal(released.status, 'TOMBSTONE');
  assert.ok(released.tombstoneUntil >= releaseWallStart + LIMITS.registryTombstoneMs);
  assert.ok(released.tombstoneUntil <= Date.now() + LIMITS.registryTombstoneMs);
});

test('registry fallback is idempotent and cannot release an exact ACTIVE room', async () => {
  const room = await createRoom('active_fallback_owner');
  const markedAt = Date.now();
  const marked = await runtime.registry('markReleasePendingAt', {
    code: room.roomCode,
    incarnation: room.incarnation,
    now: markedAt,
  });
  assert.equal(marked.status, 200, JSON.stringify(marked.body));

  for (const now of [markedAt + 60_000, markedAt + 61_000]) {
    const reconciled = await runtime.registry('reconcile', { now });
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
    const active = await inspectRoom(room);
    assert.equal(active.body.value.roomState.status, 'ACTIVE');
    assert.equal(active.body.value.sessions[0].incarnation, room.incarnation);
    const registry = await inspectRegistry();
    const pending = registry.roomCodes.find((row) => row.code === room.roomCode);
    assert.equal(pending.incarnation, room.incarnation);
    assert.equal(pending.status, 'RELEASE_PENDING');
    assert.equal(pending.updatedAt, markedAt);
  }
});

test('the 64-row cap counts only live actions and rejects an upgrade without partial acceptance', async () => {
  const room = await createRoom('action_capacity_owner');
  const seeded = await runtime.room('seedRoomPendingActions', {
    code: room.roomCode,
    incarnation: room.incarnation,
    count: LIMITS.pendingActions,
    dueAt: Date.now() + LIMITS.roomExpiryMs,
  });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  const before = await inspectRoom(room);
  assert.equal(before.body.value.pendingActions.length, LIMITS.pendingActions);

  await assert.rejects(runtime.openWebSocket(wsPath(room)), /upgrade failed/u);
  const after = await inspectRoom(room);
  assert.equal(after.body.value.pendingActions.length, LIMITS.pendingActions);
  assert.equal(after.body.value.sockets.length, 0);
  assert.equal(after.body.value.alarmAt, before.body.value.alarmAt);
});

test('a malformed due handshake action is physically deleted without an alarm loop', async () => {
  const room = await createRoom('malformed_handshake_owner');
  await authenticate(room, room);
  const dueAt = Date.now();
  const seeded = await runtime.room('seedRoomMalformedHandshakeAction', {
    code: room.roomCode,
    incarnation: room.incarnation,
    dueAt,
  });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));

  const alarm = await runtime.room('runRoomAlarmAt', {
    code: room.roomCode,
    incarnation: room.incarnation,
    now: dueAt,
  });
  assert.equal(alarm.status, 200, JSON.stringify(alarm.body));
  const cleaned = await inspectRoom(room);
  assert.deepEqual(cleaned.body.value.pendingActions, []);
  assert.equal(cleaned.body.value.alarmAt, null);
});

test('room expiry reserves one slot outside the 64 ordinary-action allowance', async () => {
  const room = await createRoom('reserved_expiry_owner');
  const authenticated = await authenticate(room, room);
  const seeded = await runtime.room('seedRoomPendingActions', {
    code: room.roomCode,
    incarnation: room.incarnation,
    count: LIMITS.pendingActions - 1,
    dueAt: Date.now() + LIMITS.roomExpiryMs,
  });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));

  authenticated.socket.close();
  await waitForRoom(
    room,
    (inspection) => inspection.body?.value?.pendingActions
      ?.some((action) => action.actionId === 'room-expiry'),
    'final close did not schedule the reserved room expiry',
  );

  const socket = await runtime.openWebSocket(wsPath(room));
  const admitted = await waitForRoom(
    room,
    (inspection) => inspection.body?.value?.pendingActions?.length === LIMITS.pendingActions + 1,
    '64th ordinary action was not admitted beside the reserved expiry',
  );
  assert.equal(admitted.body.value.pendingActions.filter(
    (action) => action.actionId !== 'room-expiry',
  ).length, LIMITS.pendingActions);

  const nextReconnectToken = token();
  socket.send({
    v: 1,
    type: 'hello',
    id: id('reserved_expiry_rotation'),
    reconnectToken: authenticated.session.reconnectToken,
    nextReconnectToken,
  });
  const reply = JSON.parse(await socket.nextMessage());
  assert.equal(reply.type, 'hello-ok');
  const connected = await inspectRoom(room);
  assert.equal(connected.body.value.pendingActions.length, LIMITS.pendingActions - 1);
  assert.equal(connected.body.value.pendingActions.some(
    (action) => action.actionId === 'room-expiry',
  ), false);
  socket.close();
});

test('concurrent reconnects cannot exceed the reserved-plus-ordinary hard bound', async () => {
  const room = await createRoom('reserved_expiry_race_owner');
  const authenticated = await authenticate(room, room);
  const seeded = await runtime.room('seedRoomPendingActions', {
    code: room.roomCode,
    incarnation: room.incarnation,
    count: LIMITS.pendingActions - 1,
    dueAt: Date.now() + LIMITS.roomExpiryMs,
  });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  authenticated.socket.close();
  await waitForRoom(
    room,
    (inspection) => inspection.body?.value?.pendingActions
      ?.some((action) => action.actionId === 'room-expiry'),
    'race setup did not schedule the reserved room expiry',
  );

  const attempts = await Promise.allSettled([
    runtime.openWebSocket(wsPath(room)),
    runtime.openWebSocket(wsPath(room)),
  ]);
  const accepted = attempts.filter((attempt) => attempt.status === 'fulfilled');
  const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /upgrade failed/u);
  const bounded = await inspectRoom(room);
  assert.equal(bounded.body.value.pendingActions.length, LIMITS.pendingActions + 1);
  assert.equal(bounded.body.value.sockets.length, 1);
  accepted[0].value.close();
});

test('final authenticated socket close clears authority and schedules expiry at ordinary action capacity', async () => {
  const room = await createRoom('capacity_close_owner');
  const authenticated = await authenticate(room, room);
  const seeded = await runtime.room('seedRoomPendingActions', {
    code: room.roomCode,
    incarnation: room.incarnation,
    count: LIMITS.pendingActions,
    dueAt: Date.now() + LIMITS.roomExpiryMs,
  });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));

  authenticated.socket.close();
  const closed = await waitForRoom(
    room,
    (inspection) => {
      const value = inspection.body?.value;
      return value?.sessions?.every((session) => session.connectionId === null)
        && value.pendingActions.some((action) => action.actionId === 'room-expiry');
    },
    'final close rolled back at ordinary action capacity',
  );
  assert.equal(closed.body.value.pendingActions.length, LIMITS.pendingActions + 1);
  const expiry = closed.body.value.pendingActions.find(
    (action) => action.actionId === 'room-expiry',
  );
  assert.equal(closed.body.value.roomState.expiresAt, expiry.dueAt);
  assert.equal(closed.body.value.alarmAt, Math.min(
    ...closed.body.value.pendingActions.map((action) => action.dueAt),
  ));
  await assert.rejects(runtime.openWebSocket(wsPath(room)), /upgrade failed/u);
  const rejected = await inspectRoom(room);
  assert.equal(rejected.body.value.pendingActions.length, LIMITS.pendingActions + 1);
  assert.equal(rejected.body.value.sockets.length, 0);
});
