import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import fixturesModule from '../../test/helpers/classic-fixtures.js';
import {
  CLASSIC_DDS_ACTION_ID,
  CLASSIC_DDS_ACTION_KIND,
  buildClassicDdsAction,
  classicHandsToInteger,
  parseClassicDdsActionPayload,
  retryClassicDdsAction,
  validateClassicDdsTable,
} from '../src/room-foundation/classic-dds-contract.mjs';
import { createRoomWorkerRuntime } from './helpers/room-worker-runtime.mjs';

const { orderedDeal } = fixturesModule;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TABLE = Array.from({ length: 5 }, (_, strain) => (
  Array.from({ length: 4 }, (_, seat) => (strain + seat) % 14)
));
const ACTION_SOURCE_URL = new URL('../src/room-foundation/classic-dds-action.mjs', import.meta.url);
let runtime;
let sequence = 0;

before(async () => {
  runtime = await createRoomWorkerRuntime({
    vars: {
      CLASSIC_TEST_DEALS_JSON: JSON.stringify([orderedDeal(), orderedDeal()]),
      CLASSIC_TEST_DDS_PAUSE: 'true',
    },
  });
});

after(async () => runtime.close());

function id(label) {
  sequence += 1;
  return `${label}_${String(sequence).padStart(8, '0')}`;
}

function token() { return randomBytes(32).toString('base64url'); }

async function post(path, body, target = runtime) {
  return target.request(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function createRoom(label, target = runtime) {
  const reconnectToken = token();
  const response = await post('/api/rooms', {
    v: 1, requestId: id(`${label}_create`), displayName: label, reconnectToken,
  }, target);
  assert.equal(response.status, 200, response.text);
  return { ...response.body, reconnectToken };
}

async function join(room, label, target = runtime, requestedRole = 'player') {
  const reconnectToken = token();
  const response = await post(`/api/rooms/${room.roomCode}/join`, {
    v: 1, requestId: id(`${label}_join`), displayName: label, reconnectToken,
    requestedRole,
  }, target);
  assert.equal(response.status, 200, response.text);
  return { ...response.body, reconnectToken };
}

async function next(socket) { return JSON.parse(await socket.nextMessage()); }

async function authenticate(room, session, target = runtime) {
  const socket = await target.openWebSocket(`/api/rooms/${room.roomCode}/${room.incarnation}/ws`);
  const nextReconnectToken = token();
  socket.send({
    v: 1, type: 'hello', id: id('dds_hello'), reconnectToken: session.reconnectToken,
    nextReconnectToken,
  });
  assert.equal((await next(socket)).type, 'hello-ok');
  return socket;
}

async function setupConnectedRoom(label, target = runtime) {
  const room = await createRoom(label, target);
  const sessions = [room];
  for (const suffix of ['e', 's', 'w']) {
    sessions.push(await join(room, `${label}_${suffix}`, target));
  }
  const sockets = [];
  for (const session of sessions) sockets.push(await authenticate(room, session, target));
  return { room, sessions, sockets };
}

async function setupStartedRoom(label, target = runtime) {
  const connected = await setupConnectedRoom(label, target);
  const { room, sessions, sockets } = connected;
  sockets[0].send({
    v: 1, type: 'command', id: id(`${label}_start`), name: 'classic.start',
    payload: { expectedRevision: 0 },
  });
  assert.equal((await next(sockets[0])).type, 'reply');
  for (const socket of sockets) {
    assert.equal((await next(socket)).name, 'classic.started');
    assert.equal((await next(socket)).name, 'classic.bidding-updated');
    assert.equal((await next(socket)).name, 'room.snapshot');
  }
  return connected;
}

async function inspect(room, target = runtime) {
  const response = await target.room('inspectRoom', {
    code: room.roomCode, incarnation: room.incarnation,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.value;
}

async function ddsControl(room, action, input = {}, target = runtime) {
  const response = await target.room(action, {
    code: room.roomCode, incarnation: room.incarnation, ...input,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.value;
}

async function waitFor(room, predicate, target = runtime) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await inspect(room, target);
    if (await predicate(value)) return value;
    await target.wait(10);
  }
  assert.fail('timed out waiting for classic DDS state');
}

function command(name, expectedRevision, payload = {}) {
  return {
    v: 1,
    type: 'command',
    id: id(`dds_${name.replaceAll('.', '_')}`),
    name,
    payload: { expectedRevision, ...payload },
  };
}

function socketsBySeat(sessions, sockets) {
  return new Map(sessions.map((session, index) => [session.seat, sockets[index]]));
}

async function commitAndDrain(bySeat, seat, frame) {
  bySeat.get(seat).send(frame);
  const reply = await next(bySeat.get(seat));
  assert.equal(reply.type, 'reply');
  for (const socket of bySeat.values()) {
    let observed;
    do { observed = await next(socket); }
    while (observed.name !== 'room.snapshot');
  }
  return reply;
}

async function waitForPaused(room, count, target = runtime) {
  return waitFor(room, async () => (
    await ddsControl(room, 'inspectRoomClassicDds', {}, target)
  ).paused.length >= count, target);
}

async function runDdsAlarm(room, action, target = runtime) {
  const response = await target.room('runRoomAlarmAt', {
    code: room.roomCode, incarnation: room.incarnation, now: action.dueAt,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

async function passOutAndReadyNext(room, sessions, sockets) {
  const bySeat = socketsBySeat(sessions, sockets);
  let revision = 1;
  for (const seat of ['N', 'E', 'S', 'W']) {
    await commitAndDrain(bySeat, seat, command('classic.bid', revision, {
      bid: 'Pass', alert: false, explain: null,
    }));
    revision += 1;
  }
  for (const seat of ['N', 'E', 'S', 'W']) {
    await commitAndDrain(bySeat, seat, command('classic.ready-next', revision));
    revision += 1;
  }
  return revision;
}

test('builds an exact bounded attempt-1 action with a five-second backstop', () => {
  const action = buildClassicDdsAction({ dealNumber: 7, now: 1_000 });
  assert.equal(action.actionId, CLASSIC_DDS_ACTION_ID);
  assert.equal(action.kind, CLASSIC_DDS_ACTION_KIND);
  assert.equal(action.dueAt, 6_000);
  assert.deepEqual(Object.keys(action.payload).sort(), ['attempt', 'dealNumber', 'generationId']);
  assert.match(action.payload.generationId, UUID);
  assert.deepEqual(action.payload, parseClassicDdsActionPayload(action.payload));
  assert.notEqual(buildClassicDdsAction({ dealNumber: 7, now: 1_000 }).payload.generationId,
    action.payload.generationId);
});

test('production classic DDS action statically embeds the Worker Wasm asset', async () => {
  const source = await readFile(ACTION_SOURCE_URL, 'utf8');
  assert.match(source,
    /import ddsWasm from '\.\.\/\.\.\/vendor\/bridge-dds\/dds-worker\.wasm';/u);
  assert.doesNotMatch(source, /await import\([^)]*dds-worker\.wasm/u);
  assert.match(source, /loadDdsModule\(ddsWasm\)/u);
});

test('rejects malformed action payloads and unknown keys', () => {
  const good = buildClassicDdsAction({ dealNumber: 1, now: 0 }).payload;
  for (const payload of [
    null,
    { ...good, extra: true },
    { ...good, generationId: 'not-a-uuid' },
    { ...good, dealNumber: 0 },
    { ...good, dealNumber: Number.MAX_SAFE_INTEGER + 1 },
    { ...good, attempt: 0 },
    { ...good, attempt: 4 },
  ]) assert.throws(() => parseClassicDdsActionPayload(payload), TypeError);
});

test('uses exact bounded retry timing and makes attempt three terminal', () => {
  const action = buildClassicDdsAction({ dealNumber: 2, now: 100 });
  assert.deepEqual(retryClassicDdsAction(action.payload, 1_000), {
    payload: { ...action.payload, attempt: 2 }, dueAt: 6_000,
  });
  assert.deepEqual(retryClassicDdsAction({ ...action.payload, attempt: 2 }, 2_000), {
    payload: { ...action.payload, attempt: 3 }, dueAt: 32_000,
  });
  assert.equal(retryClassicDdsAction({ ...action.payload, attempt: 3 }, 3_000), null);
  assert.throws(
    () => buildClassicDdsAction({ dealNumber: 2, now: Number.MAX_SAFE_INTEGER }),
    TypeError,
  );
  assert.throws(
    () => retryClassicDdsAction(action.payload, Number.MAX_SAFE_INTEGER),
    TypeError,
  );
  assert.throws(
    () => retryClassicDdsAction({ ...action.payload, attempt: 3 }, -1),
    TypeError,
  );
});

test('converts canonical classic hands to detached integer-rank DDS hands', () => {
  const source = orderedDeal();
  const converted = classicHandsToInteger(source);
  assert.deepEqual(converted.N[0], { suit: source.N[0].suit, rank: 2 });
  assert.equal(Object.values(converted).flat().length, 52);
  converted.N[0].rank = 14;
  assert.notEqual(source.N[0].rank, 14);

  for (const mutate of [
    hands => { hands.N[0].rank = 14; },
    hands => { hands.N[0].extra = true; },
    hands => { hands.N.pop(); },
    hands => { hands.N[0] = { ...hands.E[0] }; },
    hands => { hands.X = []; },
  ]) {
    const malformed = orderedDeal();
    mutate(malformed);
    assert.throws(() => classicHandsToInteger(malformed), TypeError);
  }
});

test('accepts only a strict detached 5x4 DDS table', () => {
  const table = Array.from({ length: 5 }, (_, strain) => (
    Array.from({ length: 4 }, (_, seat) => (strain + seat) % 14)
  ));
  const validated = validateClassicDdsTable(table);
  assert.deepEqual(validated, table);
  validated[0][0] = 13;
  assert.notEqual(table[0][0], 13);
  for (const malformed of [
    table.slice(0, 4),
    table.map((row, index) => index === 0 ? row.slice(0, 3) : row),
    table.map((row, index) => index === 0 ? row.map((value, column) => column === 0 ? 14 : value) : row),
    Object.assign(table.map(row => [...row]), { extra: true }),
  ]) assert.throws(() => validateClassicDdsTable(malformed), TypeError);
});

test('deal start atomically persists one bounded DDS action and starts an immediate attempt', async () => {
  const { room } = await setupStartedRoom('dds_action');
  const observed = await waitFor(room, value => value.pendingActions.some(
    action => action.actionId === CLASSIC_DDS_ACTION_ID,
  ));
  const action = observed.pendingActions.find(entry => entry.actionId === CLASSIC_DDS_ACTION_ID);
  assert.equal(observed.classicState.ddsStatus, 'PENDING');
  assert.equal(action.kind, CLASSIC_DDS_ACTION_KIND);
  assert.equal(action.incarnation, room.incarnation);
  assert.equal(action.payload.dealNumber, 1);
  assert.equal(action.payload.attempt, 1);
  assert.match(action.payload.generationId, UUID);
  assert.equal(JSON.stringify(action).includes('hands'), false);
  assert.equal(observed.alarmAt, action.dueAt);
  const dds = await ddsControl(room, 'inspectRoomClassicDds');
  assert.equal(dds.calls, 1);
  assert.deepEqual(dds.paused.map(item => item.descriptor.attempt), [1]);
});

test('matching completion merges into the latest bid and broadcasts one DDS event then snapshots', async () => {
  const { room, sessions, sockets } = await setupStartedRoom('dds_bid_race');
  sockets[0].send({
    v: 1, type: 'command', id: id('dds_bid'), name: 'classic.bid',
    payload: { expectedRevision: 1, bid: '1H', alert: false, explain: null },
  });
  assert.equal((await next(sockets[0])).type, 'reply');
  for (const socket of sockets) {
    assert.equal((await next(socket)).name, 'classic.bidding-updated');
    assert.equal((await next(socket)).name, 'room.snapshot');
  }

  await ddsControl(room, 'resolveRoomClassicDds', { result: 'success', table: TABLE });
  const settled = await waitFor(room, value => value.classicState.ddsStatus === 'READY');
  assert.equal(settled.roomState.revision, 3);
  assert.equal(settled.classicState.biddingHistory.length, 1);
  assert.equal(settled.classicState.biddingHistory[0].bid, '1H');
  assert.deepEqual(settled.classicState.ddTable, TABLE);
  assert.equal(settled.pendingActions.some(action => action.actionId === CLASSIC_DDS_ACTION_ID), false);
  for (let index = 0; index < sockets.length; index += 1) {
    assert.equal((await next(sockets[index])).name, 'classic.dd-table-ready');
    const snapshot = await next(sockets[index]);
    assert.equal(snapshot.name, 'room.snapshot');
    assert.equal(snapshot.payload.revision, 3);
    assert.equal(snapshot.payload.snapshot.classic.hands[sessions[index].seat] !== null, true);
  }
});

for (const [label, firstResult, secondResult, expected] of [
  ['success/success', 'success', 'success', { status: 'READY', attempt: null, revision: 2 }],
  ['success/failure', 'success', 'failure', { status: 'READY', attempt: null, revision: 2 }],
  ['failure/failure', 'failure', 'failure', { status: 'PENDING', attempt: 2, revision: 1 }],
]) {
  test(`immediate/backstop ${label} overlap lets only the first exact settlement win`, async () => {
    const { room } = await setupStartedRoom(`dds_overlap_${label.replace('/', '_')}`);
    const initial = await inspect(room);
    const attempt1 = initial.pendingActions.find(
      action => action.actionId === CLASSIC_DDS_ACTION_ID,
    );
    await runDdsAlarm(room, attempt1);
    await waitForPaused(room, 2);

    await ddsControl(room, 'resolveRoomClassicDds', {
      result: firstResult,
      ...(firstResult === 'success' ? { table: TABLE } : {}),
    });
    await waitFor(room, value => (
      expected.attempt === null
        ? value.classicState.ddsStatus === expected.status
        : value.pendingActions.find(
          action => action.actionId === CLASSIC_DDS_ACTION_ID,
        )?.payload.attempt === expected.attempt
    ));
    const afterFirst = await inspect(room);

    await ddsControl(room, 'resolveRoomClassicDds', {
      result: secondResult,
      ...(secondResult === 'success' ? { table: TABLE } : {}),
    });
    await runtime.wait(50);
    const afterSecond = await inspect(room);
    const retained = afterSecond.pendingActions.find(
      action => action.actionId === CLASSIC_DDS_ACTION_ID,
    );
    assert.equal(afterSecond.classicState.ddsStatus, expected.status);
    assert.equal(afterSecond.roomState.revision, expected.revision);
    assert.equal(retained?.payload.attempt ?? null, expected.attempt);
    assert.deepEqual(afterSecond.classicState, afterFirst.classicState);
    assert.deepEqual(afterSecond.pendingActions, afterFirst.pendingActions);
  });
}

test('fourth ready atomically replaces deal one DDS work and an old late result is inert', async () => {
  const { room, sessions, sockets } = await setupStartedRoom('dds_next_deal');
  const first = await inspect(room);
  const deal1 = first.pendingActions.find(action => action.actionId === CLASSIC_DDS_ACTION_ID);
  assert.equal(deal1.payload.dealNumber, 1);

  const nextRevision = await passOutAndReadyNext(room, sessions, sockets);
  const second = await waitFor(room, value => value.classicState.dealNumber === 2
    && value.pendingActions.find(
      action => action.actionId === CLASSIC_DDS_ACTION_ID,
    )?.payload.dealNumber === 2);
  const deal2 = second.pendingActions.find(action => action.actionId === CLASSIC_DDS_ACTION_ID);
  assert.equal(nextRevision, 9);
  assert.equal(second.roomState.revision, 9);
  assert.equal(second.classicState.ddsStatus, 'PENDING');
  assert.equal(deal2.payload.attempt, 1);
  assert.notEqual(deal2.payload.generationId, deal1.payload.generationId);
  assert.equal(second.alarmAt, deal2.dueAt);
  await waitForPaused(room, 2);

  await ddsControl(room, 'resolveRoomClassicDds', { result: 'success', table: TABLE });
  await runtime.wait(50);
  const afterLateDeal1 = await inspect(room);
  const retained = afterLateDeal1.pendingActions.find(
    action => action.actionId === CLASSIC_DDS_ACTION_ID,
  );
  assert.equal(afterLateDeal1.roomState.revision, 9);
  assert.equal(afterLateDeal1.classicState.dealNumber, 2);
  assert.equal(afterLateDeal1.classicState.ddsStatus, 'PENDING');
  assert.deepEqual(retained, deal2);
  assert.equal(afterLateDeal1.alarmAt, deal2.dueAt);
});

test('paused DDS holds neither the mutation gate nor its storage transaction', async () => {
  const { room, sessions, sockets } = await setupStartedRoom('dds_nonblocking');
  const bySeat = socketsBySeat(sessions, sockets);
  await waitForPaused(room, 1);

  const faultedId = id('dds_nonblocking_fault');
  await ddsControl(room, 'setRoomCommandFault', {
    sessionId: sessions.find(session => session.seat === 'N').sessionId,
    commandId: faultedId,
    type: 'before-commit',
  });
  bySeat.get('N').send({
    ...command('classic.bid', 1, { bid: '1H', alert: false, explain: null }),
    id: faultedId,
  });
  const failed = await next(bySeat.get('N'));
  assert.equal(failed.type, 'error');
  assert.equal(failed.payload.code, 'SERVICE_CAPACITY');
  const rolledBack = await inspect(room);
  assert.equal(rolledBack.roomState.revision, 1);
  assert.equal(rolledBack.classicState.biddingHistory.length, 0);

  await commitAndDrain(bySeat, 'N', command('classic.bid', 1, {
    bid: '1H', alert: false, explain: null,
  }));
  const spectator = await join(room, 'dds_nonblocking_spectator', runtime, 'spectator');
  assert.equal(spectator.role, 'SPECTATOR');
  const observed = await inspect(room);
  assert.equal(observed.roomState.revision, 2);
  assert.equal(observed.classicState.biddingHistory[0].bid, '1H');
  assert.equal(observed.classicState.ddsStatus, 'PENDING');
  assert.ok(observed.sessions.some(session => session.sessionId === spectator.sessionId));
});

test('overlapping failures advance only the first exact attempt and terminal failure reaches every recipient', async () => {
  const { room, sockets } = await setupStartedRoom('dds_retry');
  const initial = await waitFor(room, value => value.pendingActions.some(
    action => action.actionId === CLASSIC_DDS_ACTION_ID,
  ));
  const attempt1 = initial.pendingActions.find(action => action.actionId === CLASSIC_DDS_ACTION_ID);
  await runtime.room('runRoomAlarmAt', {
    code: room.roomCode, incarnation: room.incarnation, now: attempt1.dueAt,
  });
  await waitFor(room, async () => (await ddsControl(room, 'inspectRoomClassicDds')).calls >= 2);
  await ddsControl(room, 'resolveRoomClassicDds', { result: 'failure' });
  await ddsControl(room, 'resolveRoomClassicDds', { result: 'failure' });
  const retry2 = await waitFor(room, value => value.pendingActions.find(
    action => action.actionId === CLASSIC_DDS_ACTION_ID,
  )?.payload.attempt === 2);
  assert.equal(retry2.roomState.revision, 1);

  let action = retry2.pendingActions.find(entry => entry.actionId === CLASSIC_DDS_ACTION_ID);
  await runtime.room('runRoomAlarmAt', {
    code: room.roomCode, incarnation: room.incarnation, now: action.dueAt,
  });
  await waitFor(room, async () => (await ddsControl(room, 'inspectRoomClassicDds')).paused.length >= 1);
  await ddsControl(room, 'resolveRoomClassicDds', { result: 'malformed' });
  const retry3 = await waitFor(room, value => value.pendingActions.find(
    entry => entry.actionId === CLASSIC_DDS_ACTION_ID,
  )?.payload.attempt === 3);
  assert.equal(retry3.roomState.revision, 1);

  action = retry3.pendingActions.find(entry => entry.actionId === CLASSIC_DDS_ACTION_ID);
  await runtime.room('runRoomAlarmAt', {
    code: room.roomCode, incarnation: room.incarnation, now: action.dueAt,
  });
  await waitFor(room, async () => (await ddsControl(room, 'inspectRoomClassicDds')).paused.length >= 1);
  await ddsControl(room, 'resolveRoomClassicDds', { result: 'failure' });
  const terminal = await waitFor(room, value => value.classicState.ddsStatus === 'FAILED');
  assert.equal(terminal.roomState.revision, 2);
  assert.equal(terminal.classicState.ddTable, null);
  assert.equal(terminal.pendingActions.some(entry => entry.actionId === CLASSIC_DDS_ACTION_ID), false);
  assert.equal(terminal.alarmAt, null);
  for (const socket of sockets) {
    const snapshot = await next(socket);
    assert.equal(snapshot.name, 'room.snapshot');
    assert.equal(snapshot.payload.revision, 2);
    assert.equal(snapshot.payload.snapshot.classic.ddsStatus, 'FAILED');
    assert.equal(snapshot.payload.snapshot.classic.ddTable, null);
  }
});

test('attempt two survives eviction and its persisted alarm resumes the retry', async () => {
  const isolated = await createRoomWorkerRuntime({
    vars: {
      CLASSIC_TEST_DEALS_JSON: JSON.stringify([orderedDeal()]),
      CLASSIC_TEST_DDS_PAUSE: 'true',
    },
  });
  try {
    const { room } = await setupStartedRoom('dds_retry_evict', isolated);
    await ddsControl(room, 'resolveRoomClassicDds', { result: 'failure' }, isolated);
    const retry2 = await waitFor(room, value => value.pendingActions.find(
      action => action.actionId === CLASSIC_DDS_ACTION_ID,
    )?.payload.attempt === 2, isolated);
    const action2 = retry2.pendingActions.find(
      action => action.actionId === CLASSIC_DDS_ACTION_ID,
    );

    await isolated.restartRoom(room.roomCode, room.incarnation);
    await runDdsAlarm(room, action2, isolated);
    await waitForPaused(room, 1, isolated);
    const resumed = await ddsControl(room, 'inspectRoomClassicDds', {}, isolated);
    assert.equal(resumed.calls, 1);
    assert.deepEqual(resumed.paused[0].descriptor, {
      incarnation: room.incarnation,
      ...action2.payload,
    });

    await ddsControl(room, 'resolveRoomClassicDds', { result: 'failure' }, isolated);
    const retry3 = await waitFor(room, value => value.pendingActions.find(
      action => action.actionId === CLASSIC_DDS_ACTION_ID,
    )?.payload.attempt === 3, isolated);
    assert.equal(retry3.roomState.revision, 1);
    assert.equal(retry3.classicState.ddsStatus, 'PENDING');
  } finally {
    await isolated.close();
  }
});

test('a precommit failure rolls back classic state, action row, and alarm together', async () => {
  const { room, sessions, sockets } = await setupConnectedRoom('dds_rollback');
  const commandId = id('dds_rollback_start');
  await ddsControl(room, 'setRoomCommandFault', {
    sessionId: sessions[0].sessionId, commandId, type: 'before-commit',
  });
  sockets[0].send({
    v: 1, type: 'command', id: commandId, name: 'classic.start',
    payload: { expectedRevision: 0 },
  });
  const response = await next(sockets[0]);
  assert.equal(response.type, 'error');
  assert.equal(response.payload.code, 'SERVICE_CAPACITY');
  const observed = await inspect(room);
  assert.equal(observed.roomState.revision, 0);
  assert.equal(observed.classicState.ddsStatus, 'IDLE');
  assert.equal(observed.pendingActions.some(action => action.actionId === CLASSIC_DDS_ACTION_ID), false);
  assert.equal(observed.alarmAt, null);
});

test('late and repeated completions cannot mutate or delete a replacement generation', async () => {
  const { room } = await setupStartedRoom('dds_replacement');
  const before = await inspect(room);
  const original = before.pendingActions.find(action => action.actionId === CLASSIC_DDS_ACTION_ID);
  const replacement = buildClassicDdsAction({ dealNumber: 1, now: original.dueAt + 100 });
  await ddsControl(room, 'seedRoomClassicDdsAction', {
    dueAt: replacement.dueAt, payload: replacement.payload,
  });
  await ddsControl(room, 'resolveRoomClassicDds', { result: 'success', table: TABLE });
  await runtime.wait(50);
  await ddsControl(room, 'attemptRoomClassicDds', {
    descriptor: { incarnation: room.incarnation, ...original.payload },
  });
  const observed = await inspect(room);
  const retained = observed.pendingActions.find(action => action.actionId === CLASSIC_DDS_ACTION_ID);
  assert.deepEqual(retained.payload, replacement.payload);
  assert.equal(observed.classicState.ddsStatus, 'PENDING');
  assert.equal(observed.roomState.revision, 1);
});

test('alarm fails a malformed classic action closed without changing pending game state', async () => {
  const { room } = await setupStartedRoom('dds_malformed_row');
  const dueAt = Date.now();
  await ddsControl(room, 'seedRoomClassicDdsAction', {
    dueAt, payload: { generationId: 'malformed', dealNumber: 1, attempt: 1 },
  });
  const response = await runtime.room('runRoomAlarmAt', {
    code: room.roomCode, incarnation: room.incarnation, now: dueAt,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const observed = await inspect(room);
  assert.equal(observed.pendingActions.some(action => action.actionId === CLASSIC_DDS_ACTION_ID), false);
  assert.equal(observed.classicState.ddsStatus, 'PENDING');
  assert.equal(observed.roomState.revision, 1);
});

test('room closing removes the DDS row and leaves only the lifecycle alarm', async () => {
  const { room, sockets } = await setupStartedRoom('dds_close_cleanup');
  const configured = await runtime.registry('setReleaseFault', {
    code: room.roomCode,
    incarnation: room.incarnation,
    type: 'release-once',
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  for (const socket of sockets) socket.close();
  const disconnected = await waitFor(room, value => value.pendingActions.some(
    action => action.actionId === 'room-expiry',
  ));
  const expiry = disconnected.pendingActions.find(action => action.actionId === 'room-expiry');
  await runDdsAlarm(room, expiry);

  const closing = await waitFor(room, value => value.roomState.status === 'CLOSING');
  assert.equal(closing.pendingActions.some(
    action => action.actionId === CLASSIC_DDS_ACTION_ID,
  ), false);
  assert.deepEqual(closing.pendingActions.map(action => action.actionId), ['registry-release']);
  assert.equal(closing.pendingActions[0].kind, 'registry-release');
  assert.equal(closing.alarmAt, closing.pendingActions[0].dueAt);
});

test('eviction reconstructs a due action and resumes it through the alarm', async () => {
  const isolated = await createRoomWorkerRuntime({
    vars: {
      CLASSIC_TEST_DEALS_JSON: JSON.stringify([orderedDeal()]),
      CLASSIC_TEST_DDS_PAUSE: 'idle',
    },
  });
  try {
    const { room } = await setupStartedRoom('dds_evict', isolated);
    const before = await inspect(room, isolated);
    const action = before.pendingActions.find(entry => entry.actionId === CLASSIC_DDS_ACTION_ID);
    assert.equal((await ddsControl(room, 'inspectRoomClassicDds', {}, isolated)).calls, 1);
    await isolated.restartRoom(room.roomCode, room.incarnation);
    const alarm = await isolated.room('runRoomAlarmAt', {
      code: room.roomCode, incarnation: room.incarnation, now: action.dueAt,
    });
    assert.equal(alarm.status, 200, JSON.stringify(alarm.body));
    const resumed = await waitFor(
      room,
      async () => (await ddsControl(room, 'inspectRoomClassicDds', {}, isolated)).calls === 1,
      isolated,
    );
    assert.equal(resumed.pendingActions.some(entry => entry.actionId === CLASSIC_DDS_ACTION_ID), true);
  } finally {
    await isolated.close();
  }
});
