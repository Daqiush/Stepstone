import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { createHash, randomBytes } from 'node:crypto';

import { WEBSOCKET_CLOSE } from '../src/room-foundation/constants.mjs';
import { simulatePlanBBudget } from '../src/room-foundation/budget-model.mjs';
import { createRoomWorkerRuntime } from './helpers/room-worker-runtime.mjs';

let runtime;
let sequence = 0;

before(async () => {
  runtime = await createRoomWorkerRuntime();
});

after(async () => {
  await runtime.close();
});

function id(label) {
  sequence += 1;
  return `${label}_${String(sequence).padStart(8, '0')}`;
}

function token() {
  return randomBytes(32).toString('base64url');
}

async function request(path, body) {
  return runtime.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createRoom(label = 'command_owner') {
  const reconnectToken = token();
  const response = await request('/api/rooms', {
    v: 1,
    requestId: id(`${label}_create`),
    displayName: label,
    reconnectToken,
  });
  assert.equal(response.status, 200);
  return { ...response.body, reconnectToken };
}

async function join(room, requestedRole, label) {
  const reconnectToken = token();
  const response = await request(`/api/rooms/${room.roomCode}/join`, {
    v: 1,
    requestId: id(`${label}_join`),
    displayName: label,
    reconnectToken,
    requestedRole,
  });
  assert.equal(response.status, 200);
  return { ...response.body, reconnectToken };
}

function wsPath(room) {
  return `/api/rooms/${room.roomCode}/${room.incarnation}/ws`;
}

async function parseMessage(socket, timeoutMs) {
  return JSON.parse(await socket.nextMessage(timeoutMs));
}

async function authenticate(room, session) {
  const socket = await runtime.openWebSocket(wsPath(room));
  const nextReconnectToken = token();
  const rotationId = id('command_rotation');
  socket.send({
    v: 1,
    type: 'hello',
    id: rotationId,
    reconnectToken: session.reconnectToken,
    nextReconnectToken,
  });
  const hello = await parseMessage(socket);
  assert.equal(hello.type, 'hello-ok');
  return {
    socket,
    hello,
    session: { ...session, reconnectToken: nextReconnectToken },
  };
}

function increment(commandId, expectedRevision) {
  return {
    v: 1,
    type: 'command',
    id: commandId,
    name: 'foundation.increment',
    payload: { expectedRevision },
  };
}

function sync(commandId = id('room_sync')) {
  return { v: 1, type: 'command', id: commandId, name: 'room.sync', payload: {} };
}

function publicSnapshot(snapshot, revision, counter) {
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'classic',
    'createdAt',
    'expiresAt',
    'foundationCounter',
    'incarnation',
    'playerNames',
    'revision',
    'roomCode',
    'schemaVersion',
    'status',
    'viewer',
  ]);
  assert.equal(snapshot.revision, revision);
  assert.equal(snapshot.foundationCounter, counter);
  assert.equal(snapshot.status, 'ACTIVE');
  assert.deepEqual(Object.keys(snapshot.viewer).sort(), ['role', 'seat']);
  assert.deepEqual(Object.keys(snapshot.playerNames), ['N', 'E', 'S', 'W']);
  assert.equal(snapshot.classic.mode, 'classic');
  const serialized = JSON.stringify(snapshot);
  for (const privateName of [
    'recentCommands', 'requestHash', 'commandId', 'sessionId', 'token', 'initialization', 'leaseId',
    'initialHands', 'pendingActions', 'connectionId',
  ]) assert.equal(serialized.includes(privateName), false);
}

async function inspect(room) {
  const response = await runtime.room('inspectRoom', {
    code: room.roomCode,
    incarnation: room.incarnation,
  });
  assert.equal(response.status, 200);
  return response.body.value;
}

async function accounting(room) {
  const response = await runtime.room('inspectRoomCommandAccounting', {
    code: room.roomCode,
    incarnation: room.incarnation,
  });
  assert.equal(response.status, 200);
  return response.body.value;
}

async function collectMessages(socket, count) {
  const messages = [];
  while (messages.length < count) messages.push(await parseMessage(socket));
  return messages;
}

async function waitForCommandHook(room, commandId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await runtime.room('inspectRoomCommandHook', {
      code: room.roomCode,
      incarnation: room.incarnation,
      commandId,
    });
    assert.equal(response.status, 200);
    if (response.body.value.reached) return;
    await runtime.wait(10);
  }
  assert.fail('command overlap hook was not reached');
}

test('owner and player increment once, spectators are forbidden, and sync is read-only', async () => {
  const room = await createRoom('roles_owner');
  const player = await join(room, 'player', 'roles_player');
  const spectator = await join(room, 'spectator', 'roles_spectator');
  const ownerAuth = await authenticate(room, room);
  const playerAuth = await authenticate(room, player);
  const spectatorAuth = await authenticate(room, spectator);

  const ownerCommand = increment(id('owner_increment'), 0);
  ownerAuth.socket.send(ownerCommand);
  const ownerReply = await parseMessage(ownerAuth.socket);
  assert.deepEqual({ ...ownerReply, payload: { ...ownerReply.payload, snapshot: null } }, {
    v: 1,
    type: 'reply',
    id: ownerCommand.id,
    name: 'foundation.increment',
    payload: { revision: 1, snapshot: null },
  });
  publicSnapshot(ownerReply.payload.snapshot, 1, 1);
  const ownerEvent = await parseMessage(ownerAuth.socket);
  const playerEvent = await parseMessage(playerAuth.socket);
  const spectatorEvent = await parseMessage(spectatorAuth.socket);
  for (const event of [ownerEvent, playerEvent, spectatorEvent]) {
    assert.equal(event.type, 'event');
    assert.equal(event.name, 'room.snapshot');
    assert.equal(event.payload.revision, 1);
    publicSnapshot(event.payload.snapshot, 1, 1);
  }

  const playerCommand = increment(id('player_increment'), 1);
  playerAuth.socket.send(playerCommand);
  const playerReply = await parseMessage(playerAuth.socket);
  assert.equal(playerReply.payload.revision, 2);
  publicSnapshot(playerReply.payload.snapshot, 2, 2);
  await parseMessage(ownerAuth.socket);
  await parseMessage(playerAuth.socket);
  await parseMessage(spectatorAuth.socket);

  const spectatorCommand = increment(id('spectator_increment'), 2);
  spectatorAuth.socket.send(spectatorCommand);
  const forbidden = await parseMessage(spectatorAuth.socket);
  assert.deepEqual(forbidden, {
    v: 1,
    type: 'error',
    id: spectatorCommand.id,
    payload: { code: 'FORBIDDEN', revision: 2 },
  });
  await ownerAuth.socket.expectNoMessage();
  await playerAuth.socket.expectNoMessage();

  const before = await accounting(room);
  const syncCommand = sync();
  spectatorAuth.socket.send(syncCommand);
  const synchronized = await parseMessage(spectatorAuth.socket);
  assert.equal(synchronized.type, 'reply');
  assert.equal(synchronized.id, syncCommand.id);
  assert.equal(synchronized.name, 'room.sync');
  assert.equal(synchronized.payload.revision, 2);
  publicSnapshot(synchronized.payload.snapshot, 2, 2);
  const afterSync = await accounting(room);
  assert.equal(afterSync.cumulative.roomStateRowsWritten, before.cumulative.roomStateRowsWritten);
  assert.deepEqual(afterSync.lastCommand.statements, []);
  assert.equal(afterSync.lastCommand.totalRowsRead, 0);
  assert.equal(afterSync.lastCommand.totalRowsWritten, 0);
});

test('rejects stale revisions and conflicting command reuse without writes or broadcasts', async () => {
  const room = await createRoom('conflict_owner');
  const peer = await join(room, 'player', 'conflict_peer');
  const ownerAuth = await authenticate(room, room);
  const peerAuth = await authenticate(room, peer);

  const stale = increment(id('stale_revision'), 9);
  ownerAuth.socket.send(stale);
  const staleError = await parseMessage(ownerAuth.socket);
  assert.equal(staleError.payload.code, 'REVISION_CONFLICT');
  assert.equal(staleError.payload.revision, 0);
  publicSnapshot(staleError.payload.snapshot, 0, 0);
  await peerAuth.socket.expectNoMessage();

  const command = increment(id('conflicting_reuse'), 0);
  ownerAuth.socket.send(command);
  await parseMessage(ownerAuth.socket);
  await parseMessage(ownerAuth.socket);
  await parseMessage(peerAuth.socket);
  const committedAccounting = await accounting(room);

  ownerAuth.socket.send({ ...command, payload: { expectedRevision: 1 } });
  assert.deepEqual(await parseMessage(ownerAuth.socket), {
    v: 1,
    type: 'error',
    id: command.id,
    payload: { code: 'COMMAND_CONFLICT', revision: 1 },
  });
  await peerAuth.socket.expectNoMessage();
  assert.deepEqual((await accounting(room)).cumulative, committedAccounting.cumulative);
});

test('deduplicates exact retries, combines compact replay with current state, and rebroadcasts', async () => {
  const room = await createRoom('duplicate_owner');
  const peer = await join(room, 'player', 'duplicate_peer');
  const ownerAuth = await authenticate(room, room);
  const peerAuth = await authenticate(room, peer);
  const command = increment(id('duplicate_increment'), 0);

  ownerAuth.socket.send(command);
  await parseMessage(ownerAuth.socket);
  await parseMessage(ownerAuth.socket);
  await parseMessage(peerAuth.socket);
  const afterFirst = await accounting(room);

  ownerAuth.socket.send(command);
  const replay = await parseMessage(ownerAuth.socket);
  assert.equal(replay.type, 'reply');
  assert.equal(replay.payload.revision, 1);
  publicSnapshot(replay.payload.snapshot, 1, 1);
  const ownerRecovery = await parseMessage(ownerAuth.socket);
  const peerRecovery = await parseMessage(peerAuth.socket);
  for (const event of [ownerRecovery, peerRecovery]) {
    assert.equal(event.payload.revision, 1);
    publicSnapshot(event.payload.snapshot, 1, 1);
  }
  assert.deepEqual((await accounting(room)).cumulative, afterFirst.cumulative);
  assert.equal((await inspect(room)).roomState.revision, 1);
});

test('allows different sessions to reuse a command ID independently', async () => {
  const room = await createRoom('independent_owner');
  const player = await join(room, 'player', 'independent_player');
  const ownerAuth = await authenticate(room, room);
  const playerAuth = await authenticate(room, player);
  const sharedId = id('shared_command_id');
  const ownerCommand = increment(sharedId, 0);

  ownerAuth.socket.send(ownerCommand);
  await parseMessage(ownerAuth.socket);
  await parseMessage(ownerAuth.socket);
  await parseMessage(playerAuth.socket);

  playerAuth.socket.send(increment(sharedId, 1));
  const reply = await parseMessage(playerAuth.socket);
  assert.equal(reply.payload.revision, 2);
  assert.equal(reply.payload.snapshot.foundationCounter, 2);
  await parseMessage(ownerAuth.socket);
  await parseMessage(playerAuth.socket);

  ownerAuth.socket.send(ownerCommand);
  const replay = await parseMessage(ownerAuth.socket);
  assert.equal(replay.payload.revision, 1);
  publicSnapshot(replay.payload.snapshot, 2, 2);
  assert.equal((await parseMessage(ownerAuth.socket)).payload.revision, 2);
  assert.equal((await parseMessage(playerAuth.socket)).payload.revision, 2);
});

test('persists revision through eviction and repairs commit-before-delivery with duplicate rebroadcast', async () => {
  const room = await createRoom('recovery_owner');
  const peer = await join(room, 'player', 'recovery_peer');
  const ownerAuth = await authenticate(room, room);
  const peerAuth = await authenticate(room, peer);
  const command = increment(id('lost_delivery'), 0);

  const configured = await runtime.room('setRoomCommandFault', {
    code: room.roomCode,
    incarnation: room.incarnation,
    sessionId: room.sessionId,
    commandId: command.id,
    type: 'after-commit-before-delivery',
  });
  assert.equal(configured.status, 200);
  ownerAuth.socket.send(command);
  await ownerAuth.socket.expectNoMessage();
  await peerAuth.socket.expectNoMessage();
  assert.equal((await inspect(room)).roomState.revision, 1);

  await runtime.restartRoom(room.roomCode, room.incarnation);
  ownerAuth.socket.send(command);
  const replay = await parseMessage(ownerAuth.socket);
  assert.equal(replay.payload.revision, 1);
  publicSnapshot(replay.payload.snapshot, 1, 1);
  assert.equal((await parseMessage(ownerAuth.socket)).payload.revision, 1);
  assert.equal((await parseMessage(peerAuth.socket)).payload.revision, 1);

  ownerAuth.socket.send(sync());
  const syncReply = await parseMessage(ownerAuth.socket);
  publicSnapshot(syncReply.payload.snapshot, 1, 1);
});

test('a revision gap is repaired by room.sync without another write', async () => {
  const room = await createRoom('gap_owner');
  const peer = await join(room, 'player', 'gap_peer');
  const ownerAuth = await authenticate(room, room);
  const peerAuth = await authenticate(room, peer);

  ownerAuth.socket.send(increment(id('gap_first'), 0));
  await parseMessage(ownerAuth.socket);
  await parseMessage(ownerAuth.socket);
  const deliberatelyMissed = await parseMessage(peerAuth.socket);
  assert.equal(deliberatelyMissed.payload.revision, 1);

  ownerAuth.socket.send(increment(id('gap_second'), 1));
  await parseMessage(ownerAuth.socket);
  await parseMessage(ownerAuth.socket);
  const gapEvent = await parseMessage(peerAuth.socket);
  assert.equal(gapEvent.payload.revision, 2);
  const beforeSync = await accounting(room);

  peerAuth.socket.send(sync());
  const recovered = await parseMessage(peerAuth.socket);
  assert.equal(recovered.payload.revision, 2);
  publicSnapshot(recovered.payload.snapshot, 2, 2);
  assert.deepEqual((await accounting(room)).cumulative, beforeSync.cumulative);
});

test('normal mutations update exactly one room_state row and no command table or index exists', async () => {
  const room = await createRoom('accounting_owner');
  const ownerAuth = await authenticate(room, room);
  ownerAuth.socket.send(increment(id('accounted_increment'), 0));
  await parseMessage(ownerAuth.socket);
  await parseMessage(ownerAuth.socket);

  const measured = await accounting(room);
  assert.equal(measured.lastCommand.roomStateRowsWritten, 1);
  assert.equal(measured.lastCommand.sessionRowsWritten, 0);
  assert.equal(measured.lastCommand.actionRowsWritten, 0);
  assert.equal(measured.lastCommand.totalRowsWritten, 1);
  assert.ok(measured.lastCommand.totalRowsRead <= 4);
  assert.deepEqual(measured.lastCommand.statements.map((statement) => ({
    operation: statement.operation,
    table: statement.table,
    rowsWritten: statement.rowsWritten,
  })), [{ operation: 'UPDATE', table: 'room_state', rowsWritten: 1 }]);
  const modeled = simulatePlanBBudget().rows.operations['ordinary command'].costEach;
  assert.equal(modeled.rowsRead, measured.lastCommand.totalRowsRead);
  assert.equal(modeled.tableRowsWritten, measured.lastCommand.totalRowsWritten);
  assert.equal(modeled.indexRowsWritten, 0);
  const projectedRowsRead = measured.lastCommand.totalRowsRead * 50_000
    + measured.lastWake.totalRowsRead * 50;
  assert.ok(projectedRowsRead <= 250_000, `${projectedRowsRead} projected rows read`);
  assert.deepEqual(measured.commandSchemaObjects, []);
});

test('wake reconstructs cached room and authority once and fails closed on malformed persisted cache', async () => {
  const room = await createRoom('wake_cache_owner');
  const ownerAuth = await authenticate(room, room);
  ownerAuth.socket.send(increment(id('wake_cache_increment'), 0));
  await collectMessages(ownerAuth.socket, 2);

  await runtime.restartRoom(room.roomCode, room.incarnation);
  ownerAuth.socket.send(sync(id('wake_cache_sync')));
  const synchronized = await parseMessage(ownerAuth.socket);
  publicSnapshot(synchronized.payload.snapshot, 1, 1);
  const reconstructed = await accounting(room);
  assert.equal(reconstructed.cache.ready, true);
  assert.equal(reconstructed.cache.revision, 1);
  assert.equal(reconstructed.cache.authorityCount, 1);
  assert.equal(reconstructed.lastWake.totalRowsRead, 2);
  assert.deepEqual(reconstructed.lastCommand.statements, []);

  const corrupted = await runtime.room('corruptRoomCommandCache', {
    code: room.roomCode,
    incarnation: room.incarnation,
  });
  assert.equal(corrupted.status, 200);
  await runtime.restartRoom(room.roomCode, room.incarnation);
  ownerAuth.socket.send(sync(id('wake_cache_rejected')));
  assert.equal((await ownerAuth.socket.closed()).code, WEBSOCKET_CLOSE.ROOM_EXPIRED);
  const persisted = await inspect(room);
  assert.equal(persisted.roomState.revision, 1);
  assert.equal(persisted.roomState.foundationCounter, 1);
});

test('repeated forced wakes keep auth and commands correct with a constant private authority read', async () => {
  const room = await createRoom('bounded_wake_owner');
  for (const [role, label] of [
    ['player', 'bounded_wake_east'],
    ['player', 'bounded_wake_south'],
    ['player', 'bounded_wake_west'],
    ['spectator', 'bounded_wake_watch'],
  ]) await join(room, role, label);

  let authenticated = await authenticate(room, room);
  for (let revision = 0; revision < 3; revision += 1) {
    await runtime.restartRoom(room.roomCode, room.incarnation);
    authenticated.socket.send(increment(id('bounded_wake_command'), revision));
    const reply = await parseMessage(authenticated.socket);
    assert.equal(reply.type, 'reply');
    assert.equal(reply.payload.revision, revision + 1);
    publicSnapshot(reply.payload.snapshot, revision + 1, revision + 1);
    await parseMessage(authenticated.socket);
    const measured = await accounting(room);
    assert.equal(
      measured.lastWake.totalRowsRead,
      simulatePlanBBudget().rows.operations['worst-case room wake reconstruction'].costEach.rowsRead,
    );

    await runtime.restartRoom(room.roomCode, room.incarnation);
    const replacedSocket = authenticated.socket;
    const replacement = await authenticate(room, authenticated.session);
    assert.equal((await replacedSocket.closed()).code, WEBSOCKET_CLOSE.SESSION_REPLACED);
    assert.equal(replacement.hello.payload.revision, revision + 1);
    publicSnapshot(replacement.hello.payload.snapshot, revision + 1, revision + 1);
    authenticated = replacement;
    assert.equal(
      (await accounting(room)).lastWake.totalRowsRead,
      simulatePlanBBudget().rows.operations['worst-case room wake reconstruction'].costEach.rowsRead,
    );
  }
});

test('two sockets racing the same expected revision commit exactly once', async () => {
  const room = await createRoom('revision_race_owner');
  const player = await join(room, 'player', 'revision_race_player');
  const ownerAuth = await authenticate(room, room);
  const playerAuth = await authenticate(room, player);
  const ownerCommand = increment(id('revision_race_a'), 0);
  const playerCommand = increment(id('revision_race_b'), 0);

  ownerAuth.socket.send(ownerCommand);
  playerAuth.socket.send(playerCommand);
  const ownerMessages = await collectMessages(ownerAuth.socket, 2);
  const playerMessages = await collectMessages(playerAuth.socket, 2);
  const commandOutcomes = [...ownerMessages, ...playerMessages]
    .filter((message) => message.id === ownerCommand.id || message.id === playerCommand.id);
  assert.equal(commandOutcomes.filter((message) => message.type === 'reply').length, 1);
  assert.equal(commandOutcomes.filter((message) => (
    message.type === 'error' && message.payload.code === 'REVISION_CONFLICT'
  )).length, 1);
  for (const event of [...ownerMessages, ...playerMessages].filter((message) => message.type === 'event')) {
    assert.equal(event.payload.revision, 1);
  }
  const persisted = await inspect(room);
  assert.equal(persisted.roomState.revision, 1);
  assert.equal(persisted.roomState.foundationCounter, 1);
  assert.equal((await accounting(room)).cumulative.roomStateRowsWritten, 1);
});

test('overlapping duplicate frames commit once and both recover through current rebroadcast', async () => {
  const room = await createRoom('duplicate_race_owner');
  const ownerAuth = await authenticate(room, room);
  const command = increment(id('duplicate_race_command'), 0);

  ownerAuth.socket.send(command);
  ownerAuth.socket.send(command);
  const messages = await collectMessages(ownerAuth.socket, 4);
  assert.equal(messages.filter((message) => message.type === 'reply').length, 2);
  assert.equal(messages.filter((message) => message.type === 'event').length, 2);
  for (const message of messages) assert.equal(message.payload.revision, 1);
  const persisted = await inspect(room);
  assert.equal(persisted.roomState.revision, 1);
  assert.equal(persisted.roomState.foundationCounter, 1);
  assert.equal((await accounting(room)).cumulative.roomStateRowsWritten, 1);
});

test('a command held after hashing loses authority to a connection takeover before CAS', async () => {
  const room = await createRoom('takeover_race_owner');
  const first = await authenticate(room, room);
  const command = increment(id('takeover_race_command'), 0);
  const configured = await runtime.room('setRoomCommandFault', {
    code: room.roomCode,
    incarnation: room.incarnation,
    sessionId: room.sessionId,
    commandId: command.id,
    type: 'delay-before-transaction',
    delayMs: 250,
  });
  assert.equal(configured.status, 200);

  first.socket.send(command);
  await waitForCommandHook(room, command.id);
  const replacementSocket = await runtime.openWebSocket(wsPath(room));
  const replacementToken = token();
  replacementSocket.send({
    v: 1,
    type: 'hello',
    id: id('takeover_race_rotation'),
    reconnectToken: first.session.reconnectToken,
    nextReconnectToken: replacementToken,
  });
  assert.equal((await parseMessage(replacementSocket, 5_000)).payload.connectionEpoch, 2);
  assert.equal((await first.socket.closed(5_000)).code, WEBSOCKET_CLOSE.SESSION_REPLACED);
  await replacementSocket.expectNoMessage(350);
  const persisted = await inspect(room);
  assert.equal(persisted.roomState.revision, 0);
  assert.equal(persisted.roomState.foundationCounter, 0);
  assert.equal((await accounting(room)).cumulative.roomStateRowsWritten, 0);
});

test('transaction failure rolls back, reloads persisted state, and broadcasts nothing', async () => {
  const room = await createRoom('rollback_command_owner');
  const peer = await join(room, 'player', 'rollback_command_peer');
  const ownerAuth = await authenticate(room, room);
  const peerAuth = await authenticate(room, peer);
  const command = increment(id('rollback_increment'), 0);
  await runtime.room('setRoomCommandFault', {
    code: room.roomCode,
    incarnation: room.incarnation,
    sessionId: room.sessionId,
    commandId: command.id,
    type: 'before-commit',
  });

  ownerAuth.socket.send(command);
  assert.deepEqual(await parseMessage(ownerAuth.socket), {
    v: 1,
    type: 'error',
    id: command.id,
    payload: { code: 'SERVICE_CAPACITY', revision: 0 },
  });
  await peerAuth.socket.expectNoMessage();
  const persisted = await inspect(room);
  assert.equal(persisted.roomState.revision, 0);
  assert.equal(persisted.roomState.foundationCounter, 0);

  ownerAuth.socket.send(command);
  assert.equal((await parseMessage(ownerAuth.socket)).payload.revision, 1);
  await parseMessage(ownerAuth.socket);
  await parseMessage(peerAuth.socket);
});

test('same-revision persisted corruption before CAS fails closed without a stale commit', async () => {
  const room = await createRoom('cas_corruption_owner');
  const peer = await join(room, 'player', 'cas_corruption_peer');
  const ownerAuth = await authenticate(room, room);
  const peerAuth = await authenticate(room, peer);
  const command = increment(id('cas_corruption_increment'), 0);
  const configured = await runtime.room('setRoomCommandFault', {
    code: room.roomCode,
    incarnation: room.incarnation,
    sessionId: room.sessionId,
    commandId: command.id,
    type: 'corrupt-state-before-cas',
  });
  assert.equal(configured.status, 200);

  ownerAuth.socket.send(sync(id('cas_corruption_unrelated_sync')));
  assert.equal((await parseMessage(ownerAuth.socket)).payload.revision, 0);
  ownerAuth.socket.send(command);
  assert.deepEqual(await parseMessage(ownerAuth.socket), {
    v: 1,
    type: 'error',
    id: command.id,
    payload: { code: 'SERVICE_CAPACITY', revision: 0 },
  });
  await ownerAuth.socket.expectNoMessage();
  await peerAuth.socket.expectNoMessage();
  const persisted = await inspect(room);
  assert.equal(persisted.roomState.revision, 0);
  assert.equal(persisted.roomState.foundationCounter, 0);
  assert.equal((await accounting(room)).cumulative.roomStateRowsWritten, 0);
});

test('same-revision valid persisted mutation before CAS is preserved and not overwritten', async () => {
  const room = await createRoom('cas_mutation_owner');
  const peer = await join(room, 'player', 'cas_mutation_peer');
  const ownerAuth = await authenticate(room, room);
  const peerAuth = await authenticate(room, peer);
  const command = increment(id('cas_mutation_increment'), 0);
  const configured = await runtime.room('setRoomCommandFault', {
    code: room.roomCode,
    incarnation: room.incarnation,
    sessionId: room.sessionId,
    commandId: command.id,
    type: 'mutate-state-before-cas',
  });
  assert.equal(configured.status, 200);

  ownerAuth.socket.send(command);
  assert.deepEqual(await parseMessage(ownerAuth.socket), {
    v: 1,
    type: 'error',
    id: command.id,
    payload: { code: 'SERVICE_CAPACITY', revision: 0 },
  });
  await ownerAuth.socket.expectNoMessage();
  await peerAuth.socket.expectNoMessage();
  const persisted = await inspect(room);
  assert.equal(persisted.roomState.revision, 0);
  assert.equal(persisted.roomState.foundationCounter, 7);
  assert.equal((await accounting(room)).cumulative.roomStateRowsWritten, 0);
});

test('fresh persisted authority is required for every command frame', async () => {
  const room = await createRoom('fresh_authority_owner');
  const first = await authenticate(room, room);
  const replacementSocket = await runtime.openWebSocket(wsPath(room));
  const nextToken = token();
  const rotationId = id('fresh_authority_takeover');
  replacementSocket.send({
    v: 1,
    type: 'hello',
    id: rotationId,
    reconnectToken: first.session.reconnectToken,
    nextReconnectToken: nextToken,
  });
  assert.equal((await parseMessage(replacementSocket)).payload.connectionEpoch, 2);

  first.socket.send(sync(id('revoked_sync')));
  assert.equal((await first.socket.closed()).code, WEBSOCKET_CLOSE.SESSION_REPLACED);
});

test('command envelopes never expose tokens, token hashes, or embedded command-cache metadata', async () => {
  const room = await createRoom('privacy_owner');
  const ownerAuth = await authenticate(room, room);
  const command = increment(id('privacy_increment'), 0);
  ownerAuth.socket.send(command);
  const messages = [await parseMessage(ownerAuth.socket), await parseMessage(ownerAuth.socket)];
  const serialized = JSON.stringify(messages);
  const tokenHash = createHash('sha256').update(Buffer.from(ownerAuth.session.reconnectToken, 'base64url')).digest('hex');
  for (const secret of [
    room.reconnectToken,
    ownerAuth.session.reconnectToken,
    tokenHash,
    'recentCommands',
    'requestHash',
    'initialization',
  ]) assert.equal(serialized.includes(secret), false);
});
