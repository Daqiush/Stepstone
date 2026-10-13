import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { createHash, randomBytes } from 'node:crypto';

import { WEBSOCKET_CLOSE } from '../src/room-foundation/constants.mjs';
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
    'createdAt',
    'expiresAt',
    'foundationCounter',
    'incarnation',
    'revision',
    'roomCode',
    'schemaVersion',
    'status',
  ]);
  assert.equal(snapshot.revision, revision);
  assert.equal(snapshot.foundationCounter, counter);
  assert.equal(snapshot.status, 'ACTIVE');
  const serialized = JSON.stringify(snapshot);
  for (const privateName of [
    'recentCommands', 'requestHash', 'commandId', 'sessionId', 'token', 'initialization', 'leaseId',
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
  assert.deepEqual(await accounting(room), before);
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
  assert.deepEqual(await accounting(room), committedAccounting);
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
  assert.deepEqual(await accounting(room), afterFirst);
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
  assert.deepEqual(await accounting(room), beforeSync);
});

test('normal mutations update exactly one room_state row and no command table or index exists', async () => {
  const room = await createRoom('accounting_owner');
  const ownerAuth = await authenticate(room, room);
  ownerAuth.socket.send(increment(id('accounted_increment'), 0));
  await parseMessage(ownerAuth.socket);
  await parseMessage(ownerAuth.socket);

  const measured = await accounting(room);
  assert.deepEqual(measured.lastMutation, {
    roomStateRowsWritten: 1,
    sessionRowsWritten: 0,
    actionRowsWritten: 0,
  });
  assert.deepEqual(measured.commandSchemaObjects, []);
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
