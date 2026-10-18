import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { randomBytes } from 'node:crypto';

import fixturesModule from '../../test/helpers/classic-fixtures.js';
import engineModule from '../../classic/engine.cjs';
import rulesModule from '../../classic/rules.cjs';
import stateModule from '../../classic/state.cjs';
import viewsModule from '../../classic/views.cjs';
import { createRoomWorkerRuntime } from './helpers/room-worker-runtime.mjs';
import { composeClassicEventFrame } from '../src/room-foundation/room-view.mjs';

const { orderedDeal } = fixturesModule;
const { applyClassicCommand, preflightClassicCommand } = engineModule;
const { boardInfoFor } = rulesModule;
const { createClassicLobbyState } = stateModule;
const { classicViewFor } = viewsModule;

let runtime;
let sequence = 0;

before(async () => {
  runtime = await createRoomWorkerRuntime({
    vars: { CLASSIC_TEST_DEALS_JSON: JSON.stringify([orderedDeal(), orderedDeal()]) },
  });
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

async function request(path, body, target = runtime) {
  return target.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createRoom(label, target = runtime) {
  const reconnectToken = token();
  const response = await request('/api/rooms', {
    v: 1,
    requestId: id(`${label}_create`),
    displayName: label,
    reconnectToken,
  }, target);
  assert.equal(response.status, 200);
  return { ...response.body, reconnectToken };
}

async function join(room, requestedRole, label, target = runtime) {
  const reconnectToken = token();
  const response = await request(`/api/rooms/${room.roomCode}/join`, {
    v: 1,
    requestId: id(`${label}_join`),
    displayName: label,
    reconnectToken,
    requestedRole,
  }, target);
  assert.equal(response.status, 200);
  return { ...response.body, reconnectToken };
}

async function message(socket) {
  return JSON.parse(await socket.nextMessage());
}

async function authenticate(room, session, target = runtime) {
  const socket = await target.openWebSocket(
    `/api/rooms/${room.roomCode}/${room.incarnation}/ws`,
  );
  const nextReconnectToken = token();
  socket.send({
    v: 1,
    type: 'hello',
    id: id('classic_rotation'),
    reconnectToken: session.reconnectToken,
    nextReconnectToken,
  });
  const hello = await message(socket);
  assert.equal(hello.type, 'hello-ok');
  return { socket, hello, session: { ...session, reconnectToken: nextReconnectToken } };
}

function command(name, commandId, expectedRevision, payload = {}) {
  return {
    v: 1,
    type: 'command',
    id: commandId,
    name,
    payload: { expectedRevision, ...payload },
  };
}

function canonicalDeal(dealNumber) {
  return { hands: orderedDeal(), boardInfo: boardInfoFor(dealNumber) };
}

async function inspect(room) {
  const response = await runtime.room('inspectRoom', {
    code: room.roomCode,
    incarnation: room.incarnation,
  });
  assert.equal(response.status, 200);
  return response.body.value;
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
  assert.fail('classic command mutation hook was not reached');
}

test('real Durable Object initializes with the canonical classic lobby state', async () => {
  const room = await createRoom('classic_initial_owner');
  const observed = await inspect(room);
  assert.deepEqual(observed.roomState.classic,
    classicViewFor(createClassicLobbyState(), { role: 'SPECTATOR', seat: null }));
});

test('classic start commits one revision and delivers filtered events before snapshots', async () => {
  const room = await createRoom('classic_start_owner');
  const players = [
    room,
    await join(room, 'player', 'classic_start_east'),
    await join(room, 'player', 'classic_start_south'),
    await join(room, 'player', 'classic_start_west'),
  ];
  const authenticated = [];
  for (const player of players) authenticated.push(await authenticate(room, player));

  const start = command('classic.start', id('classic_start'), 0);
  authenticated[0].socket.send(start);
  const reply = await message(authenticated[0].socket);
  assert.equal(reply.type, 'reply');
  assert.equal(reply.id, start.id);
  assert.equal(reply.name, 'classic.start');
  assert.equal(reply.payload.revision, 1);
  assert.equal(reply.payload.snapshot.classic.phase, 'BIDDING');
  assert.deepEqual(reply.payload.snapshot.classic.hands.N, orderedDeal().N);
  assert.equal(reply.payload.snapshot.classic.hands.E, null);

  for (let index = 0; index < authenticated.length; index += 1) {
    const frames = [
      await message(authenticated[index].socket),
      await message(authenticated[index].socket),
      await message(authenticated[index].socket),
    ];
    assert.deepEqual(frames.map(frame => frame.name), [
      'classic.started',
      'classic.bidding-updated',
      'room.snapshot',
    ]);
    assert.equal(frames[0].payload.revision, 1);
    assert.equal(frames[1].payload.revision, 1);
    assert.equal(frames[2].payload.revision, 1);
    const seat = players[index].seat;
    assert.deepEqual(frames[2].payload.snapshot.classic.hands[seat], orderedDeal()[seat]);
    for (const other of ['N', 'E', 'S', 'W'].filter(candidate => candidate !== seat)) {
      assert.equal(frames[2].payload.snapshot.classic.hands[other], null);
    }
    assert.equal(JSON.stringify(frames).includes('initialHands'), false);
  }

  const observed = await inspect(room);
  assert.equal(observed.roomState.revision, 1);
  assert.equal(observed.roomState.foundationCounter, 0);
  assert.equal(observed.roomState.classic.phase, 'BIDDING');
});

test('spectator, stale revision, and malformed classic commands fail without mutation or broadcast', async () => {
  const room = await createRoom('classic_denied_owner');
  const players = [
    room,
    await join(room, 'player', 'classic_denied_east'),
    await join(room, 'player', 'classic_denied_south'),
    await join(room, 'player', 'classic_denied_west'),
  ];
  const spectator = await join(room, 'spectator', 'classic_denied_spectator');
  const ownerAuth = await authenticate(room, players[0]);
  const spectatorAuth = await authenticate(room, spectator);

  const denied = command('classic.start', id('classic_spectator_start'), 0);
  spectatorAuth.socket.send(denied);
  assert.deepEqual(await message(spectatorAuth.socket), {
    v: 1,
    type: 'error',
    id: denied.id,
    payload: { code: 'CLASSIC_FORBIDDEN', revision: 0 },
  });
  await ownerAuth.socket.expectNoMessage();

  const stale = command('classic.start', id('classic_stale_start'), 9);
  ownerAuth.socket.send(stale);
  const staleReply = await message(ownerAuth.socket);
  assert.equal(staleReply.payload.code, 'REVISION_CONFLICT');
  assert.equal(staleReply.payload.revision, 0);
  assert.equal(staleReply.payload.snapshot.classic.phase, 'LOBBY');
  await spectatorAuth.socket.expectNoMessage();

  const invalid = command('classic.bid', id('classic_invalid_bid'), 0, {
    bid: 'not-a-bid', alert: false, explain: null,
  });
  ownerAuth.socket.send(invalid);
  assert.deepEqual(await message(ownerAuth.socket), {
    v: 1,
    type: 'error',
    id: invalid.id,
    payload: { code: 'INVALID_COMMAND', revision: 0 },
  });
  await spectatorAuth.socket.expectNoMessage();
  assert.equal((await inspect(room)).roomState.revision, 0);
});

test('classic duplicate returns cached reply with current snapshot and does not replay events', async () => {
  const room = await createRoom('classic_duplicate_owner');
  const players = [
    room,
    await join(room, 'player', 'classic_duplicate_east'),
    await join(room, 'player', 'classic_duplicate_south'),
    await join(room, 'player', 'classic_duplicate_west'),
  ];
  const authenticated = [];
  for (const player of players) authenticated.push(await authenticate(room, player));
  const start = command('classic.start', id('classic_duplicate_start'), 0);
  authenticated[0].socket.send(start);
  await message(authenticated[0].socket);
  for (const auth of authenticated) {
    await message(auth.socket);
    await message(auth.socket);
    await message(auth.socket);
  }

  const bid = command('classic.bid', id('classic_duplicate_bid'), 1, {
    bid: '1NT', alert: false, explain: null,
  });
  authenticated[0].socket.send(bid);
  assert.equal((await message(authenticated[0].socket)).payload.revision, 2);
  for (const auth of authenticated) {
    await message(auth.socket);
    await message(auth.socket);
  }

  await runtime.restartRoom(room.roomCode, room.incarnation);
  authenticated[0].socket.send(start);
  const duplicate = await message(authenticated[0].socket);
  assert.deepEqual({ ...duplicate, payload: { ...duplicate.payload, snapshot: null } }, {
    v: 1,
    type: 'reply',
    id: start.id,
    name: 'classic.start',
    payload: { revision: 1, snapshot: null },
  });
  assert.equal(duplicate.payload.snapshot.revision, 2);
  assert.equal(duplicate.payload.snapshot.classic.currentContract.suit, 'NT');
  for (const auth of authenticated) await auth.socket.expectNoMessage();

  authenticated[0].socket.send({ ...start, payload: { expectedRevision: 2 } });
  assert.deepEqual(await message(authenticated[0].socket), {
    v: 1,
    type: 'error',
    id: start.id,
    payload: { code: 'COMMAND_CONFLICT', revision: 2 },
  });
  for (const auth of authenticated) await auth.socket.expectNoMessage();
  assert.equal((await inspect(room)).roomState.revision, 2);
});

test('classic state and command cache roll back together on a precommit failure', async () => {
  const room = await createRoom('classic_rollback_owner');
  const players = [
    room,
    await join(room, 'player', 'classic_rollback_east'),
    await join(room, 'player', 'classic_rollback_south'),
    await join(room, 'player', 'classic_rollback_west'),
  ];
  const authenticated = [];
  for (const player of players) authenticated.push(await authenticate(room, player));
  const start = command('classic.start', id('classic_rollback_start'), 0);
  await runtime.room('setRoomCommandFault', {
    code: room.roomCode,
    incarnation: room.incarnation,
    sessionId: room.sessionId,
    commandId: start.id,
    type: 'before-commit',
  });

  authenticated[0].socket.send(start);
  assert.deepEqual(await message(authenticated[0].socket), {
    v: 1,
    type: 'error',
    id: start.id,
    payload: { code: 'SERVICE_CAPACITY', revision: 0 },
  });
  for (const auth of authenticated.slice(1)) await auth.socket.expectNoMessage();
  let observed = await inspect(room);
  assert.equal(observed.roomState.revision, 0);
  assert.equal(observed.roomState.classic.phase, 'LOBBY');

  authenticated[0].socket.send(start);
  assert.equal((await message(authenticated[0].socket)).payload.revision, 1);
  for (const auth of authenticated) {
    await message(auth.socket);
    await message(auth.socket);
    await message(auth.socket);
  }
  observed = await inspect(room);
  assert.equal(observed.roomState.revision, 1);
  assert.equal(observed.roomState.classic.phase, 'BIDDING');
});

test('serialized mutation gate preserves a delayed classic commit across a lifecycle transition', async () => {
  const room = await createRoom('classic_gate_owner');
  const players = [
    room,
    await join(room, 'player', 'classic_gate_east'),
    await join(room, 'player', 'classic_gate_south'),
    await join(room, 'player', 'classic_gate_west'),
  ];
  const authenticated = [];
  for (const player of players) authenticated.push(await authenticate(room, player));
  const start = command('classic.start', id('classic_gate_start'), 0);
  const configured = await runtime.room('setRoomCommandFault', {
    code: room.roomCode,
    incarnation: room.incarnation,
    sessionId: room.sessionId,
    commandId: start.id,
    type: 'delay-inside-mutation',
    delayMs: 250,
  });
  assert.equal(configured.status, 200);

  authenticated[0].socket.send(start);
  await waitForCommandHook(room, start.id);
  const closingPromise = runtime.room('setRoomStatus', {
    code: room.roomCode,
    incarnation: room.incarnation,
    status: 'CLOSING',
  });
  assert.equal((await message(authenticated[0].socket)).payload.revision, 1);
  const closing = await closingPromise;
  assert.equal(closing.status, 200);
  const observed = await inspect(room);
  assert.equal(observed.roomState.status, 'CLOSING');
  assert.equal(observed.roomState.revision, 1);
  assert.equal(observed.roomState.classic.phase, 'BIDDING');
});

test('deterministic Durable Object transcript matches the shared core through a second deal', async () => {
  const room = await createRoom('classic_transcript_owner');
  const players = [
    room,
    await join(room, 'player', 'classic_transcript_east'),
    await join(room, 'player', 'classic_transcript_south'),
    await join(room, 'player', 'classic_transcript_west'),
  ];
  const bySeat = new Map();
  for (const player of players) bySeat.set(player.seat, await authenticate(room, player));

  let classic = createClassicLobbyState();
  let revision = 0;
  async function applyAndAssert(seat, name, publicPayload, corePayload = publicPayload) {
    const actor = { role: seat === 'N' ? 'OWNER' : 'PLAYER', seat };
    const coreCommand = { name, payload: { expectedRevision: revision, ...corePayload } };
    const context = { actor, occupiedSeats: ['N', 'E', 'S', 'W'] };
    const preflight = preflightClassicCommand(classic, coreCommand, context);
    assert.equal(preflight.ok, true);
    const result = applyClassicCommand(classic, coreCommand, {
      ...context,
      deal: preflight.needsDeal ? canonicalDeal(preflight.nextDealNumber) : null,
    });
    assert.equal(result.ok, true);

    const frame = command(name, id('classic_transcript_command'), revision, publicPayload);
    bySeat.get(seat).socket.send(frame);
    revision += 1;
    const reply = await message(bySeat.get(seat).socket);
    assert.equal(reply.type, 'reply');
    assert.equal(reply.id, frame.id);
    assert.equal(reply.name, result.reply.name);
    assert.equal(reply.payload.revision, revision);
    assert.deepEqual(reply.payload.snapshot.classic,
      classicViewFor(result.state, actor));

    for (const [viewerSeat, authenticated] of bySeat) {
      const viewer = { role: viewerSeat === 'N' ? 'OWNER' : 'PLAYER', seat: viewerSeat };
      for (const event of result.events) {
        assert.deepEqual(await message(authenticated.socket),
          composeClassicEventFrame(event, revision, viewer));
      }
      const snapshot = await message(authenticated.socket);
      assert.equal(snapshot.name, 'room.snapshot');
      assert.equal(snapshot.payload.revision, revision);
      assert.deepEqual(snapshot.payload.snapshot.classic,
        classicViewFor(result.state, viewer));
      assert.equal(JSON.stringify(snapshot).includes('initialHands'), false);
    }
    const persisted = await inspect(room);
    assert.deepEqual(persisted.classicState, result.state);
    assert.equal(persisted.roomState.revision, revision);
    classic = result.state;
  }

  await applyAndAssert('N', 'classic.start', {});
  for (const [seat, bid] of [
    ['N', '1NT'], ['E', 'Pass'], ['S', 'Pass'], ['W', 'Pass'],
  ]) {
    await applyAndAssert(seat, 'classic.bid', {
      bid, alert: false, explain: null,
    });
  }
  assert.equal(classic.phase, 'PLAYING');

  const rankNumbers = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
    T: 10, J: 11, Q: 12, K: 13, A: 14 };
  for (const rank of ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']) {
    for (const [actorSeat, effectiveSeat, suit] of [
      ['E', 'E', 'H'], ['N', 'S', 'D'], ['W', 'W', 'C'], ['N', 'N', 'S'],
    ]) {
      assert.equal(classic.currentPlayer, effectiveSeat);
      await applyAndAssert(
        actorSeat,
        'classic.play',
        { card: { suit, rank: rankNumbers[rank] } },
        { card: { suit, rank } },
      );
    }
  }
  assert.equal(classic.phase, 'SCORING');
  assert.equal(classic.completedTricks.length, 13);

  for (const seat of ['N', 'E', 'S', 'W']) {
    if (seat === 'W') await runtime.restartRoom(room.roomCode, room.incarnation);
    await applyAndAssert(seat, 'classic.ready-next', {});
  }
  assert.equal(classic.phase, 'BIDDING');
  assert.equal(classic.dealNumber, 2);
  assert.equal(revision, 61);

  const persisted = await inspect(room);
  assert.equal(persisted.roomState.revision, 61);
  assert.equal(persisted.roomState.foundationCounter, 0);
  assert.deepEqual(persisted.roomState.classic,
    classicViewFor(classic, { role: 'SPECTATOR', seat: null }));
});

test('classic commands survive hibernation and use one state-row write with no recipient reads', async () => {
  const room = await createRoom('classic_wake_owner');
  const players = [
    room,
    await join(room, 'player', 'classic_wake_east'),
    await join(room, 'player', 'classic_wake_south'),
    await join(room, 'player', 'classic_wake_west'),
  ];
  const spectator = await join(room, 'spectator', 'classic_wake_watch');
  const authenticated = [];
  for (const player of [...players, spectator]) {
    authenticated.push(await authenticate(room, player));
  }
  const start = command('classic.start', id('classic_wake_start'), 0);
  authenticated[0].socket.send(start);
  await message(authenticated[0].socket);
  for (const auth of authenticated) {
    await message(auth.socket);
    await message(auth.socket);
    await message(auth.socket);
  }

  await runtime.restartRoom(room.roomCode, room.incarnation);
  const reset = await runtime.room('resetRoomSqlAccounting', {
    code: room.roomCode,
    incarnation: room.incarnation,
  });
  assert.equal(reset.status, 200);
  const bid = command('classic.bid', id('classic_wake_bid'), 1, {
    bid: '1NT', alert: false, explain: null,
  });
  authenticated[0].socket.send(bid);
  const reply = await message(authenticated[0].socket);
  assert.equal(reply.payload.revision, 2);
  for (const auth of authenticated) {
    assert.equal((await message(auth.socket)).name, 'classic.bidding-updated');
    const snapshot = await message(auth.socket);
    assert.equal(snapshot.name, 'room.snapshot');
    assert.equal(snapshot.payload.snapshot.classic.phase, 'BIDDING');
    assert.deepEqual(snapshot.payload.snapshot.playerNames, {
      N: 'classic_wake_owner',
      E: 'classic_wake_east',
      S: 'classic_wake_south',
      W: 'classic_wake_west',
    });
    if (snapshot.payload.snapshot.viewer.role === 'SPECTATOR') {
      assert.deepEqual(snapshot.payload.snapshot.classic.hands,
        { N: null, E: null, S: null, W: null });
    }
  }

  const profile = await runtime.room('inspectRoomSqlAccounting', {
    code: room.roomCode,
    incarnation: room.incarnation,
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.value.totalRowsWritten, 1);
  assert.deepEqual(profile.body.value.statements.map(({ operation, table, rowsWritten }) => ({
    operation, table, rowsWritten,
  })), [{ operation: 'UPDATE', table: 'room_state', rowsWritten: 1 }]);

  const replacement = await authenticate(room, authenticated[0].session);
  assert.equal((await authenticated[0].socket.closed()).code, 4409);
  assert.equal(replacement.hello.payload.revision, 2);
  assert.equal(replacement.hello.payload.snapshot.classic.phase, 'BIDDING');
  assert.deepEqual(replacement.hello.payload.snapshot.classic.hands.N, orderedDeal().N);
  await replacement.socket.expectNoMessage();

  const syncFrame = { v: 1, type: 'command', id: id('classic_wake_sync'), name: 'room.sync', payload: {} };
  authenticated.at(-1).socket.send(syncFrame);
  const synchronized = await message(authenticated.at(-1).socket);
  assert.equal(synchronized.payload.revision, 2);
  assert.deepEqual(synchronized.payload.snapshot.classic.hands,
    { N: null, E: null, S: null, W: null });
  assert.equal(JSON.stringify(synchronized).includes('initialHands'), false);
});

test('malformed gated deal fixtures fail the command without preventing room recovery', async () => {
  const isolated = await createRoomWorkerRuntime({
    vars: { CLASSIC_TEST_DEALS_JSON: '{malformed' },
  });
  try {
    const room = await createRoom('classic_bad_fixture_owner', isolated);
    const players = [
      room,
      await join(room, 'player', 'classic_bad_fixture_east', isolated),
      await join(room, 'player', 'classic_bad_fixture_south', isolated),
      await join(room, 'player', 'classic_bad_fixture_west', isolated),
    ];
    const authenticated = [];
    for (const player of players) {
      authenticated.push(await authenticate(room, player, isolated));
    }
    const start = command('classic.start', id('classic_bad_fixture_start'), 0);
    authenticated[0].socket.send(start);
    assert.deepEqual(await message(authenticated[0].socket), {
      v: 1,
      type: 'error',
      id: start.id,
      payload: { code: 'SERVICE_CAPACITY', revision: 0 },
    });
    for (const auth of authenticated.slice(1)) await auth.socket.expectNoMessage();
    const observed = await isolated.room('inspectRoom', {
      code: room.roomCode,
      incarnation: room.incarnation,
    });
    assert.equal(observed.status, 200);
    assert.equal(observed.body.value.roomState.revision, 0);
    assert.equal(observed.body.value.roomState.classic.phase, 'LOBBY');
  } finally {
    await isolated.close();
  }
});
