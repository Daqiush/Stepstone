import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';

import { LIMITS } from '../src/room-foundation/constants.mjs';
import { canonicalJson } from '../src/room-foundation/protocol.mjs';
import { createRoomWorkerRuntime } from './helpers/room-worker-runtime.mjs';

const TOKEN_BYTES = 32;

let runtime;
let sequence = 0;

before(async () => {
  runtime = await createRoomWorkerRuntime();
});

after(async () => {
  await runtime?.close();
});

function nextId(label) {
  sequence += 1;
  return `${label}_${String(sequence).padStart(16, '0')}`;
}

function token(seed) {
  return Buffer.from(Uint8Array.from(
    { length: TOKEN_BYTES },
    (_, index) => (seed * 37 + index * 17) % 256,
  )).toString('base64url');
}

function createBody(label = 'create', overrides = {}) {
  const seed = ++sequence;
  return {
    v: 1,
    requestId: `${label}_${String(seed).padStart(16, '0')}`,
    displayName: 'North',
    reconnectToken: token(seed),
    ...overrides,
  };
}

function joinBody(label, requestedRole = 'player', overrides = {}) {
  const seed = ++sequence;
  return {
    v: 1,
    requestId: `${label}_${String(seed).padStart(16, '0')}`,
    displayName: label,
    reconnectToken: token(seed),
    requestedRole,
    ...overrides,
  };
}

async function post(path, body) {
  return runtime.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function successShape(requestId, roomCode, incarnation, sessionId, role, seat) {
  return { v: 1, requestId, roomCode, incarnation, sessionId, role, seat };
}

function assertPublicError(result, code, status) {
  assert.equal(result.status, status, result.text);
  assert.deepEqual(result.body, { v: 1, error: { code } });
}

async function createRoom(body = createBody()) {
  const result = await post('/api/rooms', body);
  assert.equal(result.status, 200, result.text);
  assert.match(result.body.roomCode, /^\d{3}$/u);
  assert.ok(Number.isSafeInteger(result.body.incarnation));
  assert.match(result.body.sessionId, /^[A-Za-z0-9_-]{16,64}$/u);
  assert.deepEqual(result.body, successShape(
    body.requestId,
    result.body.roomCode,
    result.body.incarnation,
    result.body.sessionId,
    'OWNER',
    'N',
  ));
  return result.body;
}

async function joinRoom(created, body) {
  return post(`/api/rooms/${created.roomCode}/join`, body);
}

async function inspectRoom(created) {
  const inspected = await runtime.room('inspectRoom', {
    code: created.roomCode,
    incarnation: created.incarnation,
  });
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
  assert.equal(inspected.body.ok, true, JSON.stringify(inspected.body));
  return inspected.body.value;
}

test('creates owner N, allocates E/S/W without downgrade, and persists a spectator', async () => {
  const ownerBody = createBody('owner');
  const startedAt = Date.now();
  const created = await createRoom(ownerBody);
  assert.ok(Date.now() >= startedAt);
  assert.equal(JSON.stringify(created).includes(ownerBody.reconnectToken), false);

  for (const [label, seat] of [['East', 'E'], ['South', 'S'], ['West', 'W']]) {
    const body = joinBody(label);
    const result = await joinRoom(created, body);
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.body, successShape(
      body.requestId, created.roomCode, created.incarnation,
      result.body.sessionId, 'PLAYER', seat,
    ));
    assert.equal(result.text.includes(body.reconnectToken), false);
  }

  const spectatorBody = joinBody('Watcher', 'spectator');
  const spectator = await joinRoom(created, spectatorBody);
  assert.equal(spectator.status, 200, spectator.text);
  assert.deepEqual(spectator.body, successShape(
    spectatorBody.requestId, created.roomCode, created.incarnation,
    spectator.body.sessionId, 'SPECTATOR', null,
  ));

  const fifthPlayerBody = joinBody('Fifth');
  const fifthPlayer = await joinRoom(created, fifthPlayerBody);
  assertPublicError(fifthPlayer, 'ROOM_CAPACITY_EXCEEDED', 409);
  assert.equal(fifthPlayer.text.includes(fifthPlayerBody.reconnectToken), false);

  const inspection = await inspectRoom(created);
  assert.equal(inspection.roomState.status, 'ACTIVE');
  assert.equal(inspection.roomState.roomCode, created.roomCode);
  assert.equal(inspection.roomState.incarnation, created.incarnation);
  assert.equal(inspection.sessions.length, 5);
  assert.deepEqual(inspection.sessions.map(({ role, seat }) => [role, seat]), [
    ['OWNER', 'N'], ['PLAYER', 'E'], ['PLAYER', 'S'], ['PLAYER', 'W'], ['SPECTATOR', null],
  ]);
  assert.equal(inspection.pendingActions.length, 1);
  assert.equal(inspection.pendingActions[0].kind, 'owner-auth-expiry');
  assert.ok(inspection.pendingActions[0].dueAt >= startedAt + LIMITS.ownerAuthExpiryMs);
  assert.ok(inspection.pendingActions[0].dueAt <= Date.now() + LIMITS.ownerAuthExpiryMs);
  assert.equal(inspection.alarmAt, inspection.pendingActions[0].dueAt);

  const persistedView = JSON.stringify(inspection);
  assert.equal(persistedView.includes(ownerBody.reconnectToken), false);
  const ownerTokenHash = createHash('sha256')
    .update(Buffer.from(ownerBody.reconnectToken, 'base64url'))
    .digest('hex');
  assert.equal(persistedView.includes(ownerTokenHash), false);
  assert.equal(/token_hash|tokenHash|reconnectToken/u.test(persistedView), false);
});

test('caps spectators at twelve and total sessions at sixteen', async () => {
  const created = await createRoom(createBody('capacity_owner'));
  for (const seat of ['E', 'S', 'W']) {
    const body = joinBody(`Player${seat}`);
    const result = await joinRoom(created, body);
    assert.equal(result.status, 200, result.text);
    assert.equal(result.body.seat, seat);
  }
  for (let index = 0; index < LIMITS.spectatorSessions; index += 1) {
    const result = await joinRoom(created, joinBody(`Spectator${index}`, 'spectator'));
    assert.equal(result.status, 200, result.text);
    assert.equal(result.body.role, 'SPECTATOR');
    assert.equal(result.body.seat, null);
  }
  const overflow = await joinRoom(created, joinBody('SpectatorOverflow', 'spectator'));
  assertPublicError(overflow, 'ROOM_CAPACITY_EXCEEDED', 409);
  const inspection = await inspectRoom(created);
  assert.equal(inspection.sessions.length, LIMITS.totalSessions);
});

test('rejects malformed, non-v1, and oversized JSON before bootstrap parsing', async () => {
  assertPublicError(await post('/api/rooms', '{'), 'INVALID_REQUEST', 400);
  assertPublicError(await post('/api/rooms', { ...createBody('wrong_version'), v: 2 }), 'PROTOCOL_MISMATCH', 400);

  const oversized = JSON.stringify({
    ...createBody('oversized'),
    padding: 'x'.repeat(LIMITS.httpJsonBytes),
  });
  assert.ok(Buffer.byteLength(oversized) > LIMITS.httpJsonBytes);
  const oversizedResult = await post('/api/rooms', oversized);
  assertPublicError(oversizedResult, 'INVALID_REQUEST', 400);
  assert.equal(oversizedResult.text.includes('padding'), false);
});

test('replays create and join exactly after response loss, eviction, and request conflict', async () => {
  const ownerBody = createBody('replay_owner');
  const firstCreate = await post('/api/rooms', ownerBody);
  assert.equal(firstCreate.status, 200, firstCreate.text);
  const created = firstCreate.body;

  await runtime.restartRegistry();
  await runtime.restartRoom(created.roomCode, created.incarnation);
  const createReplay = await post('/api/rooms', ownerBody);
  assert.deepEqual(createReplay.body, created);
  assertPublicError(
    await post('/api/rooms', { ...ownerBody, displayName: 'Changed' }),
    'REQUEST_CONFLICT',
    409,
  );

  const playerBody = joinBody('ReplayEast');
  const firstJoin = await joinRoom(created, playerBody);
  assert.equal(firstJoin.status, 200, firstJoin.text);
  const joined = firstJoin.body;

  await runtime.restartRoom(created.roomCode, created.incarnation);
  const joinReplay = await joinRoom(created, playerBody);
  assert.deepEqual(joinReplay.body, joined);
  assertPublicError(
    await joinRoom(created, { ...playerBody, displayName: 'Changed' }),
    'REQUEST_CONFLICT',
    409,
  );

  const inspection = await inspectRoom(created);
  assert.equal(inspection.sessions.length, 2);
});

test('rejects duplicate reconnect-token digests without leaking the credential or SQL details', async () => {
  const ownerBody = createBody('duplicate_owner');
  const created = await createRoom(ownerBody);
  const duplicateBody = joinBody('DuplicateToken', 'spectator', {
    reconnectToken: ownerBody.reconnectToken,
  });
  const result = await joinRoom(created, duplicateBody);
  assertPublicError(result, 'REQUEST_CONFLICT', 409);
  assert.equal(result.text.includes(ownerBody.reconnectToken), false);
  assert.equal(/SQL|UNIQUE|token_hash/iu.test(result.text), false);
});

test('failed initialization stays unadvertised and lease reconciliation tombstones it', async () => {
  const body = createBody('failed_init');
  const requestHash = createHash('sha256').update(canonicalJson(body)).digest('hex');
  const allocation = await runtime.registry('allocate', {
    requestId: body.requestId,
    requestHash,
  });
  assert.equal(allocation.status, 200, JSON.stringify(allocation.body));
  assert.equal(allocation.body.value.status, 'PROVISIONING');
  const lease = allocation.body.value;

  const configured = await runtime.room('setRoomInitializationFault', {
    code: lease.code,
    incarnation: lease.incarnation,
    leaseId: lease.leaseId,
    type: 'throw',
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  const failed = await post('/api/rooms', body);
  assertPublicError(failed, 'SERVICE_CAPACITY', 503);
  assert.equal(failed.text.includes(body.reconnectToken), false);

  const beforeReconcile = await runtime.registry('inspect');
  const row = beforeReconcile.body.value.roomCodes.find((item) => item.code === lease.code);
  assert.equal(row.status, 'PROVISIONING');
  assertPublicError(
    await post(`/api/rooms/${lease.code}/join`, joinBody('Invisible')),
    'ROOM_NOT_FOUND',
    404,
  );

  const cleared = await runtime.room('setRoomInitializationFault', {
    code: lease.code,
    incarnation: lease.incarnation,
    leaseId: lease.leaseId,
    type: null,
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const reconciled = await runtime.registry('reconcile', { now: lease.leaseExpiresAt });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
  const afterReconcile = await runtime.registry('inspect');
  const tombstone = afterReconcile.body.value.roomCodes.find((item) => item.code === lease.code);
  assert.equal(tombstone.status, 'TOMBSTONE');
});
