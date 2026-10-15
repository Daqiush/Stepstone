import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { LIMITS, WEBSOCKET_CLOSE } from '../src/room-foundation/constants.mjs';
import { hashReconnectToken } from '../src/room-foundation/protocol.mjs';
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
    (_, index) => (seed * 41 + index * 29) % 256,
  )).toString('base64url');
}

async function post(path, body) {
  return runtime.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createRoom(label = 'ws_owner') {
  const reconnectToken = token();
  const body = {
    v: 1,
    requestId: id(label),
    displayName: 'North',
    reconnectToken,
  };
  const response = await post('/api/rooms', body);
  assert.equal(response.status, 200, response.text);
  return { ...response.body, reconnectToken };
}

async function joinRoom(room, label, requestedRole) {
  const reconnectToken = token();
  const body = {
    v: 1,
    requestId: id(label),
    displayName: label,
    reconnectToken,
    requestedRole,
  };
  const response = await post(`/api/rooms/${room.roomCode}/join`, body);
  assert.equal(response.status, 200, response.text);
  return { ...response.body, reconnectToken };
}

function wsPath(room, incarnation = room.incarnation) {
  return `/api/rooms/${room.roomCode}/${incarnation}/ws`;
}

function hello(session, nextReconnectToken = token(), rotationId = id('rotation')) {
  return {
    frame: {
      v: 1,
      type: 'hello',
      id: rotationId,
      reconnectToken: session.reconnectToken,
      nextReconnectToken,
    },
    nextReconnectToken,
    rotationId,
  };
}

async function inspect(room) {
  const response = await runtime.room('inspectRoom', {
    code: room.roomCode,
    incarnation: room.incarnation,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.value;
}

async function parseMessage(socket, timeoutMs) {
  return JSON.parse(await socket.nextMessage(timeoutMs));
}

async function waitForAuthHook(room) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await runtime.room('inspectRoomAuthHook', {
      code: room.roomCode,
      incarnation: room.incarnation,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    if (response.body.value.reached) return;
    await runtime.wait(10);
  }
  assert.fail('authentication overlap hook was not reached');
}

async function authenticate(room, session, options = {}) {
  const socket = await runtime.openWebSocket(wsPath(room));
  const request = hello(session, options.nextReconnectToken, options.rotationId);
  socket.send(request.frame);
  const response = await parseMessage(socket);
  assert.equal(response.type, 'hello-ok');
  return {
    socket,
    response,
    session: { ...session, reconnectToken: request.nextReconnectToken },
    previousToken: session.reconnectToken,
    rotationId: request.rotationId,
  };
}

test('exact ACTIVE identity upgrades with zero preauth disclosure and survives hibernation reconstruction', async () => {
  const room = await createRoom('opaque_owner');
  await assert.rejects(runtime.openWebSocket(wsPath(room, room.incarnation + 1)), /upgrade failed/u);

  const socket = await runtime.openWebSocket(wsPath(room));
  await socket.expectNoMessage();
  let state = await inspect(room);
  assert.equal(state.sockets.length, 1);
  assert.equal(state.sockets[0].authenticated, false);
  assert.equal(state.sockets[0].sessionId, null);
  assert.equal(state.pendingActions.filter((item) => item.kind === 'handshake-timeout').length, 1);
  assert.equal(JSON.stringify(state).includes(room.reconnectToken), false);

  await runtime.restartRoom(room.roomCode, room.incarnation);
  await socket.expectNoMessage();
  state = await inspect(room);
  assert.equal(state.sockets.length, 1);
  assert.equal(state.sockets[0].authenticated, false);
  socket.close();
});

test('closes oversized, malformed, non-hello, and protocol-mismatched preauth frames with 1002', async () => {
  const room = await createRoom('bad_frames_owner');
  for (const frame of [
    'x'.repeat(LIMITS.webSocketFrameBytes + 1),
    '{',
    { v: 1, type: 'command', id: id('not_hello'), name: 'room.sync', payload: {} },
    { ...hello(room).frame, v: 2 },
  ]) {
    const socket = await runtime.openWebSocket(wsPath(room));
    socket.send(frame);
    const closed = await socket.closed();
    assert.equal(closed.code, WEBSOCKET_CLOSE.PROTOCOL_ERROR);
  }
});

test('expectNoMessage rejects when the socket closes before its quiet period', async () => {
  const room = await createRoom('quiet_close_owner');
  const socket = await runtime.openWebSocket(wsPath(room));
  const quiet = socket.expectNoMessage(1_000);
  socket.send('{');
  await assert.rejects(quiet, /closed before quiet period/u);
  assert.equal((await socket.closed()).code, WEBSOCKET_CLOSE.PROTOCOL_ERROR);
});

test('caps reconstructed unauthenticated sockets at eight and times them out durably with 4408', async () => {
  const room = await createRoom('preauth_cap_owner');
  const sockets = [];
  for (let index = 0; index < LIMITS.unauthenticatedSockets; index += 1) {
    sockets.push(await runtime.openWebSocket(wsPath(room)));
  }
  await runtime.restartRoom(room.roomCode, room.incarnation);
  await assert.rejects(runtime.openWebSocket(wsPath(room)), /upgrade failed/u);

  const state = await inspect(room);
  assert.equal(state.sockets.length, LIMITS.unauthenticatedSockets);
  const deadlines = state.pendingActions.filter((item) => item.kind === 'handshake-timeout');
  assert.equal(deadlines.length, LIMITS.unauthenticatedSockets);
  const alarm = await runtime.room('runRoomAlarmAt', {
    code: room.roomCode,
    incarnation: room.incarnation,
    now: Math.max(...deadlines.map((item) => item.dueAt)),
  });
  assert.equal(alarm.status, 200, JSON.stringify(alarm.body));
  const after = await inspect(room);
  assert.equal(after.sockets.length, 0);
  assert.equal(after.pendingActions.some((item) => item.kind === 'handshake-timeout'), false);
  assert.equal(after.alarmAt, after.pendingActions[0]?.dueAt ?? null);
  for (const socket of sockets) socket.close();
});

test('rotates only token digests, returns the exact role snapshot, and keeps same-socket replay idempotent', async () => {
  const room = await createRoom('rotate_owner');
  const player = await joinRoom(room, 'RotateEast', 'player');
  const before = await inspect(room);
  assert.equal(before.pendingActions.some((item) => item.kind === 'owner-auth-expiry'), true);

  const authenticated = await authenticate(room, player);
  assert.deepEqual(authenticated.response, {
    v: 1,
    type: 'hello-ok',
    id: authenticated.rotationId,
    payload: {
      sessionId: player.sessionId,
      role: 'PLAYER',
      seat: 'E',
      connectionEpoch: 1,
      revision: 0,
      snapshot: {
        schemaVersion: 1,
        roomCode: room.roomCode,
        incarnation: room.incarnation,
        revision: 0,
        status: 'ACTIVE',
        foundationCounter: 0,
        createdAt: authenticated.response.payload.snapshot.createdAt,
        expiresAt: null,
      },
    },
  });
  const serialized = JSON.stringify(authenticated.response);
  assert.equal(serialized.includes(player.reconnectToken), false);
  assert.equal(serialized.includes(authenticated.session.reconnectToken), false);
  assert.equal(serialized.includes(await hashReconnectToken(player.reconnectToken)), false);
  assert.equal(serialized.includes(await hashReconnectToken(authenticated.session.reconnectToken)), false);

  authenticated.socket.send({
    ...hello(authenticated.session, token(), authenticated.rotationId).frame,
    reconnectToken: player.reconnectToken,
    nextReconnectToken: authenticated.session.reconnectToken,
  });
  const replay = await parseMessage(authenticated.socket);
  assert.equal(replay.payload.connectionEpoch, 1);
  const after = await inspect(room);
  assert.equal(after.sessions.find((item) => item.sessionId === player.sessionId).connectionEpoch, 1);
  assert.equal(after.pendingActions.some((item) => item.kind === 'owner-auth-expiry'), true);
  const storedView = JSON.stringify(after);
  assert.equal(storedView.includes(player.reconnectToken), false);
  assert.equal(storedView.includes(authenticated.session.reconnectToken), false);
  assert.equal(storedView.includes(await hashReconnectToken(player.reconnectToken)), false);
  assert.equal(storedView.includes(await hashReconnectToken(authenticated.session.reconnectToken)), false);
  authenticated.socket.close();
});

test('join replay stays exact after repeated reconnect-token rotations', async () => {
  const room = await createRoom('rotated_join_replay_owner');
  const joinRequest = {
    v: 1,
    requestId: id('rotated_join_replay'),
    displayName: 'Rotating East',
    reconnectToken: token(),
    requestedRole: 'player',
  };
  const joined = await post(`/api/rooms/${room.roomCode}/join`, joinRequest);
  assert.equal(joined.status, 200, joined.text);
  const session = { ...joined.body, reconnectToken: joinRequest.reconnectToken };

  const firstRotation = await authenticate(room, session);
  const firstReplay = await post(`/api/rooms/${room.roomCode}/join`, joinRequest);
  assert.equal(firstReplay.status, 200, firstReplay.text);
  assert.deepEqual(firstReplay.body, joined.body);

  const secondRotation = await authenticate(room, firstRotation.session);
  const secondReplay = await post(`/api/rooms/${room.roomCode}/join`, joinRequest);
  assert.equal(secondReplay.status, 200, secondReplay.text);
  assert.deepEqual(secondReplay.body, joined.body);

  const changedToken = await post(`/api/rooms/${room.roomCode}/join`, {
    ...joinRequest,
    reconnectToken: token(),
  });
  assert.equal(changedToken.status, 409, changedToken.text);
  assert.deepEqual(changedToken.body, { v: 1, error: { code: 'REQUEST_CONFLICT' } });
  const changedPayload = await post(`/api/rooms/${room.roomCode}/join`, {
    ...joinRequest,
    displayName: 'Changed East',
  });
  assert.equal(changedPayload.status, 409, changedPayload.text);
  assert.deepEqual(changedPayload.body, { v: 1, error: { code: 'REQUEST_CONFLICT' } });

  firstRotation.socket.close();
  secondRotation.socket.close();
});

test('create replay stays exact after repeated owner reconnect-token rotations', async () => {
  const createRequest = {
    v: 1,
    requestId: id('rotated_create_replay'),
    displayName: 'Rotating North',
    reconnectToken: token(),
  };
  const created = await post('/api/rooms', createRequest);
  assert.equal(created.status, 200, created.text);
  const session = { ...created.body, reconnectToken: createRequest.reconnectToken };

  const firstRotation = await authenticate(created.body, session);
  const firstReplay = await post('/api/rooms', createRequest);
  assert.equal(firstReplay.status, 200, firstReplay.text);
  assert.deepEqual(firstReplay.body, created.body);

  const secondRotation = await authenticate(created.body, firstRotation.session);
  const secondReplay = await post('/api/rooms', createRequest);
  assert.equal(secondReplay.status, 200, secondReplay.text);
  assert.deepEqual(secondReplay.body, created.body);

  const changedToken = await post('/api/rooms', {
    ...createRequest,
    reconnectToken: token(),
  });
  assert.equal(changedToken.status, 409, changedToken.text);
  assert.deepEqual(changedToken.body, { v: 1, error: { code: 'REQUEST_CONFLICT' } });

  firstRotation.socket.close();
  secondRotation.socket.close();
});

test('rejects a non-rotating next credential with 4401 without changing its epoch', async () => {
  const room = await createRoom('same_token_owner');
  const socket = await runtime.openWebSocket(wsPath(room));
  socket.send(hello(room, room.reconnectToken).frame);
  assert.equal((await socket.closed()).code, WEBSOCKET_CLOSE.AUTH_INVALID);
  assert.equal((await inspect(room)).sessions[0].connectionEpoch, 0);
});

test('rejects another session credential as the next token with 4401', async () => {
  const room = await createRoom('colliding_token_owner');
  const player = await joinRoom(room, 'CollidingEast', 'player');
  const socket = await runtime.openWebSocket(wsPath(room));
  socket.send(hello(player, room.reconnectToken).frame);
  assert.equal((await socket.closed()).code, WEBSOCKET_CLOSE.AUTH_INVALID);
  const state = await inspect(room);
  assert.equal(state.sessions.find((item) => item.sessionId === player.sessionId).connectionEpoch, 0);
});

test('reserves another session previous credential against rotation', async () => {
  const room = await createRoom('previous_collision_owner');
  const player = await joinRoom(room, 'PreviousCollisionEast', 'player');
  const ownerAuth = await authenticate(room, room);
  const playerSocket = await runtime.openWebSocket(wsPath(room));
  playerSocket.send(hello(player, ownerAuth.previousToken).frame);
  assert.equal((await playerSocket.closed()).code, WEBSOCKET_CLOSE.AUTH_INVALID);
  const state = await inspect(room);
  assert.equal(state.sessions.find((item) => item.sessionId === player.sessionId).connectionEpoch, 0);
  ownerAuth.socket.close();
});

test('reserves the same session previous credential against rollback rotation', async () => {
  const room = await createRoom('history_rollback_owner');
  const ownerAuth = await authenticate(room, room);
  ownerAuth.socket.send(hello(ownerAuth.session, ownerAuth.previousToken).frame);
  assert.equal((await ownerAuth.socket.closed()).code, WEBSOCKET_CLOSE.AUTH_INVALID);
  const state = await inspect(room);
  assert.equal(state.sessions[0].connectionEpoch, 1);
});

test('bootstrap rejects a credential reserved in another session history', async () => {
  const room = await createRoom('history_bootstrap_owner');
  const ownerAuth = await authenticate(room, room);
  const response = await post(`/api/rooms/${room.roomCode}/join`, {
    v: 1,
    requestId: id('history_bootstrap_join'),
    displayName: 'History watcher',
    reconnectToken: ownerAuth.previousToken,
    requestedRole: 'spectator',
  });
  assert.equal(response.status, 409, response.text);
  assert.deepEqual(response.body, { v: 1, error: { code: 'REQUEST_CONFLICT' } });
  assert.equal((await inspect(room)).sessions.length, 1);
  ownerAuth.socket.close();
});

test('overlapping distinct rotations authorize exactly one socket', async () => {
  const room = await createRoom('overlap_owner');
  const first = await runtime.openWebSocket(wsPath(room));
  const second = await runtime.openWebSocket(wsPath(room));
  const firstHello = hello(room, token(), id('overlap_first'));
  const secondHello = hello(room, token(), id('overlap_second'));
  const configured = await runtime.room('setRoomAuthFault', {
    code: room.roomCode,
    incarnation: room.incarnation,
    type: 'delay-before-transaction',
    delayMs: 200,
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  first.send(firstHello.frame);
  await waitForAuthHook(room);
  second.send(secondHello.frame);
  const winner = await parseMessage(second, 5_000);
  assert.equal(winner.id, secondHello.rotationId);
  assert.equal(winner.payload.connectionEpoch, 1);
  assert.equal((await first.closed(5_000)).code, WEBSOCKET_CLOSE.AUTH_INVALID);

  const state = await inspect(room);
  assert.equal(state.sessions[0].connectionEpoch, 1);
  const authoritative = state.sockets.filter((socket) => socket.authenticated);
  assert.equal(authoritative.length, 1);
  assert.equal(authoritative[0].connectionEpoch, 1);
  second.close();
});

test('owner authentication alone cancels owner expiry and invalid credentials close with 4401', async () => {
  const room = await createRoom('owner_expiry_owner');
  const spectator = await joinRoom(room, 'OwnerExpiryWatcher', 'spectator');
  const spectatorAuth = await authenticate(room, spectator);
  assert.equal((await inspect(room)).pendingActions.some((item) => item.kind === 'owner-auth-expiry'), true);

  const invalid = await runtime.openWebSocket(wsPath(room));
  invalid.send(hello({ ...room, reconnectToken: token() }).frame);
  assert.equal((await invalid.closed()).code, WEBSOCKET_CLOSE.AUTH_INVALID);

  const ownerAuth = await authenticate(room, room);
  assert.equal((await inspect(room)).pendingActions.some((item) => item.kind === 'owner-auth-expiry'), false);
  spectatorAuth.socket.close();
  ownerAuth.socket.close();
});

test('response-loss replay on a new socket preserves rotation and immediately revokes the old epoch', async () => {
  const room = await createRoom('response_loss_owner');
  const player = await joinRoom(room, 'ResponseLossEast', 'player');
  const nextReconnectToken = token();
  const rotationId = id('response_loss_rotation');
  const first = await runtime.openWebSocket(wsPath(room));

  await runtime.room('setRoomAuthFault', {
    code: room.roomCode,
    incarnation: room.incarnation,
    type: 'after-commit-before-reply',
  });
  first.send(hello(player, nextReconnectToken, rotationId).frame);
  await first.expectNoMessage();
  assert.equal((await inspect(room)).sessions.find((item) => item.sessionId === player.sessionId).connectionEpoch, 1);

  const replacement = await runtime.openWebSocket(wsPath(room));
  replacement.send(hello(player, nextReconnectToken, rotationId).frame);
  const recovered = await parseMessage(replacement);
  assert.equal(recovered.payload.connectionEpoch, 2);
  assert.equal((await first.closed()).code, WEBSOCKET_CLOSE.SESSION_REPLACED);

  first.send?.('{}');
  const unrelated = await runtime.openWebSocket(wsPath(room));
  unrelated.send(hello(player, token(), id('unrelated_rotation')).frame);
  assert.equal((await unrelated.closed()).code, WEBSOCKET_CLOSE.AUTH_INVALID);
  replacement.close();
});

test('precommit rollback leaves attachment epoch unauthorized until the live timeout fails closed', async () => {
  const room = await createRoom('rollback_owner');
  const player = await joinRoom(room, 'RollbackEast', 'player');
  const socket = await runtime.openWebSocket(wsPath(room));
  await runtime.room('setRoomAuthFault', {
    code: room.roomCode,
    incarnation: room.incarnation,
    type: 'before-commit',
  });
  socket.send(hello(player).frame);
  await socket.expectNoMessage();

  const state = await inspect(room);
  const persisted = state.sessions.find((item) => item.sessionId === player.sessionId);
  const attached = state.sockets.find((item) => item.sessionId === player.sessionId);
  assert.equal(persisted.connectionEpoch, 0);
  assert.equal(attached.connectionEpoch, 1);
  assert.equal(attached.authenticated, true);
  const timeout = state.pendingActions.find((item) => item.kind === 'handshake-timeout');
  assert.ok(timeout);
  await runtime.room('runRoomAlarmAt', {
    code: room.roomCode,
    incarnation: room.incarnation,
    now: timeout.dueAt,
  });
  assert.equal((await socket.closed()).code, WEBSOCKET_CLOSE.AUTH_TIMEOUT);
});

test('a newer authenticated socket has sole authority across hibernation and expired rooms close 4410', async () => {
  const room = await createRoom('authority_owner');
  const first = await authenticate(room, room);
  const nextToken = token();
  const nextRotation = id('takeover_rotation');
  const secondSocket = await runtime.openWebSocket(wsPath(room));
  await runtime.room('setRoomAuthFault', {
    code: room.roomCode,
    incarnation: room.incarnation,
    type: 'after-commit-before-reply',
  });
  secondSocket.send(hello(first.session, nextToken, nextRotation).frame);
  await secondSocket.expectNoMessage();
  first.socket.send({ v: 1, type: 'command', id: id('revoked_old'), name: 'room.sync', payload: {} });
  assert.equal((await first.socket.closed()).code, WEBSOCKET_CLOSE.SESSION_REPLACED);

  await runtime.restartRoom(room.roomCode, room.incarnation);
  secondSocket.send({
    ...hello(first.session, nextToken, nextRotation).frame,
    reconnectToken: first.session.reconnectToken,
  });
  const replay = await parseMessage(secondSocket);
  assert.equal(replay.payload.connectionEpoch, 2);
  secondSocket.send({ v: 1, type: 'command', id: id('unsupported'), name: 'room.sync', payload: {} });
  const synchronized = await parseMessage(secondSocket);
  assert.equal(synchronized.type, 'reply');
  assert.equal(synchronized.name, 'room.sync');
  assert.equal(synchronized.payload.revision, 0);

  const expiredRoom = await createRoom('expired_socket_owner');
  const expiredSocket = await runtime.openWebSocket(wsPath(expiredRoom));
  await runtime.room('setRoomStatus', {
    code: expiredRoom.roomCode,
    incarnation: expiredRoom.incarnation,
    status: 'CLOSING',
  });
  expiredSocket.send(hello(expiredRoom).frame);
  assert.equal((await expiredSocket.closed()).code, WEBSOCKET_CLOSE.ROOM_EXPIRED);
});

test('wake closes every socket for persisted CLOSING state and removes handshake actions', async () => {
  const room = await createRoom('closing_wake_owner');
  const authenticated = await authenticate(room, room);
  const preauth = await runtime.openWebSocket(wsPath(room));
  const configured = await runtime.room('setRoomStatus', {
    code: room.roomCode,
    incarnation: room.incarnation,
    status: 'CLOSING',
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  await runtime.restartRoom(room.roomCode, room.incarnation);
  const wakeState = await inspect(room);
  assert.equal(
    wakeState.pendingActions.some((action) => action.kind === 'handshake-timeout'),
    false,
  );
  const delivered = await Promise.allSettled([
    authenticated.socket.closed(500),
    preauth.closed(500),
  ]);
  const closeCodes = delivered
    .filter((item) => item.status === 'fulfilled')
    .map((item) => item.value.code);
  assert.ok(closeCodes.length >= 1, 'Wrangler delivered no close frame for reconstructed sockets');
  assert.deepEqual([...new Set(closeCodes)], [WEBSOCKET_CLOSE.ROOM_EXPIRED]);
  assert.notEqual(authenticated.socket.raw.readyState, WebSocket.OPEN);
  assert.notEqual(preauth.raw.readyState, WebSocket.OPEN);
  authenticated.socket.close();
  preauth.close();
  await runtime.wait(25);
  const state = await inspect(room);
  assert.equal(state.sockets.length, 0);
  assert.equal(state.pendingActions.some((action) => action.kind === 'handshake-timeout'), false);
});

test('alarm recovery never postpones an already-due alarm behind a later action', async () => {
  const room = await createRoom('due_alarm_owner');
  const now = Date.now() + 5_000;
  const recovered = await runtime.room('recoverRoomAlarmAt', {
    code: room.roomCode,
    incarnation: room.incarnation,
    now,
    currentAlarmAt: now - 1_000,
  });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.value.alarmAt, now);
});
