import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { LIMITS } from '../src/room-foundation/constants.mjs';
import { canonicalJson, hashReconnectToken } from '../src/room-foundation/protocol.mjs';
import { fetchRoomFoundation } from '../src/room-foundation/router.mjs';
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

function unknownLengthOversizedBody() {
  const state = { cancelled: false, pulls: 0 };
  const chunk = new TextEncoder().encode('x'.repeat(4_096));
  const body = new ReadableStream({
    pull(controller) {
      state.pulls += 1;
      if (state.pulls <= 64) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

async function postStreaming(path, body) {
  return runtime.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    duplex: 'half',
  });
}

function closedUnknownLengthOversizedBody() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(LIMITS.httpJsonBytes + 1));
      controller.close();
    },
  });
}

async function directStreamingPost(path, body, bindingCalls, headers = {}) {
  const binding = {
    idFromName() {
      bindingCalls.push('idFromName');
      throw new Error('oversized input reached durable storage');
    },
  };
  const response = await fetchRoomFoundation(new Request(`https://stepstone.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    duplex: 'half',
  }), {
    LOBBY_REGISTRY: binding,
    STEPSTONE_ROOM: binding,
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text), text };
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

async function postWith(targetRuntime, path, body) {
  return targetRuntime.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function inspectRoomWith(targetRuntime, created) {
  const inspected = await targetRuntime.room('inspectRoom', {
    code: created.roomCode,
    incarnation: created.incarnation,
  });
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
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

test('rejects malformed, non-v1, and oversized join JSON without adding a session', async () => {
  const created = await createRoom(createBody('invalid_join_owner'));
  const path = `/api/rooms/${created.roomCode}/join`;
  assertPublicError(await post(path, '{'), 'INVALID_REQUEST', 400);
  assertPublicError(
    await post(path, { ...joinBody('wrong_join_version'), v: 2 }),
    'PROTOCOL_MISMATCH',
    400,
  );
  const oversized = JSON.stringify({
    ...joinBody('oversized_join'),
    padding: 'x'.repeat(LIMITS.httpJsonBytes),
  });
  assert.ok(Buffer.byteLength(oversized) > LIMITS.httpJsonBytes);
  assertPublicError(await post(path, oversized), 'INVALID_REQUEST', 400);
  assert.equal((await inspectRoom(created)).sessions.length, 1);
});

test('cancels unknown-length oversized create and join streams before reading the full body', async () => {
  const bindingCalls = [];
  for (const path of ['/api/rooms', '/api/rooms/123/join']) {
    const stream = unknownLengthOversizedBody();
    assertPublicError(
      await directStreamingPost(path, stream.body, bindingCalls),
      'INVALID_REQUEST',
      400,
    );
    assert.equal(stream.state.cancelled, true);
    assert.ok(stream.state.pulls < 64, `${path} consumed ${stream.state.pulls} chunks`);
  }
  assert.deepEqual(bindingCalls, []);

  const declaredOversized = unknownLengthOversizedBody();
  assertPublicError(
    await directStreamingPost('/api/rooms', declaredOversized.body, bindingCalls, {
      'content-length': String(LIMITS.httpJsonBytes + 1),
    }),
    'INVALID_REQUEST',
    400,
  );
  assert.equal(declaredOversized.state.cancelled, true);
  assert.deepEqual(bindingCalls, []);

  const registryBefore = await runtime.registry('inspect');
  assert.equal(registryBefore.status, 200, JSON.stringify(registryBefore.body));
  assertPublicError(
    await postStreaming('/api/rooms', closedUnknownLengthOversizedBody()),
    'INVALID_REQUEST',
    400,
  );

  const registryAfter = await runtime.registry('inspect');
  assert.equal(registryAfter.status, 200, JSON.stringify(registryAfter.body));
  assert.deepEqual(registryAfter.body.value.roomCodes, registryBefore.body.value.roomCodes);
  assert.deepEqual(
    registryAfter.body.value.creationRequests,
    registryBefore.body.value.creationRequests,
  );

  const created = await createRoom(createBody('stream_join_owner'));
  const sessionsBefore = (await inspectRoom(created)).sessions.length;
  assertPublicError(
    await postStreaming(
      `/api/rooms/${created.roomCode}/join`,
      closedUnknownLengthOversizedBody(),
    ),
    'INVALID_REQUEST',
    400,
  );
  assert.equal((await inspectRoom(created)).sessions.length, sessionsBefore);
});

test('consumes one due bootstrap placeholder without scheduling an immediate alarm loop', async () => {
  const created = await createRoom(createBody('placeholder_alarm_owner'));
  const before = await inspectRoom(created);
  assert.equal(before.pendingActions.length, 1);
  assert.equal(before.pendingActions[0].kind, 'owner-auth-expiry');

  const first = await runtime.room('runRoomAlarmAt', {
    code: created.roomCode,
    incarnation: created.incarnation,
    now: before.pendingActions[0].dueAt,
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  const afterFirst = await inspectRoom(created);
  assert.deepEqual(afterFirst.pendingActions, []);
  assert.equal(afterFirst.alarmAt, null);

  const second = await runtime.room('runRoomAlarmAt', {
    code: created.roomCode,
    incarnation: created.incarnation,
    now: before.pendingActions[0].dueAt + 1,
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const afterSecond = await inspectRoom(created);
  assert.deepEqual(afterSecond.pendingActions, []);
  assert.equal(afterSecond.alarmAt, null);
});

test('persists the authoritative lease expiry and stores only credential token digests', async () => {
  const body = createBody('storage_owner');
  const requestHash = createHash('sha256').update(canonicalJson(body)).digest('hex');
  const allocationResult = await runtime.registry('allocateAt', {
    requestId: body.requestId,
    requestHash,
    now: Date.now(),
  });
  assert.equal(allocationResult.status, 200, JSON.stringify(allocationResult.body));
  const allocation = allocationResult.body.value;

  const createResult = await post('/api/rooms', body);
  assert.equal(createResult.status, 200, createResult.text);
  const playerBody = joinBody('StorageEast');
  const joinResult = await joinRoom(createResult.body, playerBody);
  assert.equal(joinResult.status, 200, joinResult.text);

  for (const plaintextToken of [body.reconnectToken, playerBody.reconnectToken]) {
    const probe = await runtime.room('probeRoomTokenStorage', {
      code: allocation.code,
      incarnation: allocation.incarnation,
      plaintextToken,
      expectedLeaseExpiresAt: allocation.leaseExpiresAt,
    });
    assert.equal(probe.status, 200, JSON.stringify(probe.body));
    assert.deepEqual(probe.body.value, {
      plaintextOccurrences: 0,
      credentialDigestMatches: 1,
      digestOutsideCredentialOccurrences: 0,
      initializationLeaseExpiresAtMatches: true,
    });
    assert.equal(JSON.stringify(probe.body).includes(plaintextToken), false);
    assert.equal(JSON.stringify(probe.body).includes(await hashReconnectToken(plaintextToken)), false);
  }
});

test('rejects stale empty initialization while allowing exact committed initialization replay', async () => {
  const replayBody = createBody('expired_replay');
  const replayHash = createHash('sha256').update(canonicalJson(replayBody)).digest('hex');
  const replayAllocationResult = await runtime.registry('allocateAt', {
    requestId: replayBody.requestId,
    requestHash: replayHash,
    now: Date.now(),
  });
  const replayAllocation = replayAllocationResult.body.value;
  const sessionId = nextId('replay_session');
  const exactInput = {
    code: replayAllocation.code,
    incarnation: replayAllocation.incarnation,
    leaseId: replayAllocation.leaseId,
    leaseExpiresAt: replayAllocation.leaseExpiresAt,
    requestId: replayBody.requestId,
    requestHash: replayHash,
    tokenHash: await hashReconnectToken(replayBody.reconnectToken),
    sessionId,
  };
  const initialized = await runtime.room('initializeRoomAt', {
    ...exactInput,
    now: replayAllocation.leaseExpiresAt - 1,
  });
  assert.equal(initialized.status, 200, JSON.stringify(initialized.body));
  const replayed = await runtime.room('initializeRoomAt', {
    ...exactInput,
    now: replayAllocation.leaseExpiresAt,
  });
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  assert.equal(replayed.body.value.replayed, true);
  assert.deepEqual(replayed.body.value.response, initialized.body.value.response);

  const staleBody = createBody('stale_empty');
  const staleHash = createHash('sha256').update(canonicalJson(staleBody)).digest('hex');
  const staleAllocationResult = await runtime.registry('allocateAt', {
    requestId: staleBody.requestId,
    requestHash: staleHash,
    now: Date.now() - 59_000,
  });
  const staleAllocation = staleAllocationResult.body.value;
  const configured = await runtime.room('setRoomInitializationFault', {
    code: staleAllocation.code,
    incarnation: staleAllocation.incarnation,
    leaseId: staleAllocation.leaseId,
    type: 'delay',
    delayMs: 1_200,
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  const createPromise = post('/api/rooms', staleBody);
  await runtime.wait(1_050);
  const reconcilePromise = runtime.registry('reconcile', { now: staleAllocation.leaseExpiresAt });
  const [staleCreate, reconciled] = await Promise.all([createPromise, reconcilePromise]);
  assertPublicError(staleCreate, 'SERVICE_CAPACITY', 503);
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));

  const registry = await runtime.registry('inspect');
  const staleRow = registry.body.value.roomCodes.find((item) => item.code === staleAllocation.code);
  assert.equal(staleRow.status, 'TOMBSTONE');
  const absentRoom = await runtime.room('inspectRoom', {
    code: staleAllocation.code,
    incarnation: staleAllocation.incarnation,
  });
  assert.equal(absentRoom.status, 409, JSON.stringify(absentRoom.body));
  assert.deepEqual(absentRoom.body, { ok: false, error: { code: 'ROOM_NOT_FOUND' } });

  const cleared = await runtime.room('setRoomInitializationFault', {
    code: staleAllocation.code,
    incarnation: staleAllocation.incarnation,
    leaseId: staleAllocation.leaseId,
    type: null,
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
});

test('replays bootstrap state after closing and reopening a persisted Wrangler runtime', async () => {
  const persistenceDirectory = await mkdtemp(join(tmpdir(), 'stepstone-room-bootstrap-'));
  let persistentRuntime;
  try {
    persistentRuntime = await createRoomWorkerRuntime({ persistenceDirectory });
    const ownerBody = createBody('process_owner');
    const firstCreate = await postWith(persistentRuntime, '/api/rooms', ownerBody);
    assert.equal(firstCreate.status, 200, firstCreate.text);
    const created = firstCreate.body;
    const playerBody = joinBody('ProcessEast');
    const firstJoin = await postWith(
      persistentRuntime,
      `/api/rooms/${created.roomCode}/join`,
      playerBody,
    );
    assert.equal(firstJoin.status, 200, firstJoin.text);
    const spectatorBody = joinBody('ProcessWatcher', 'spectator');
    const firstSpectator = await postWith(
      persistentRuntime,
      `/api/rooms/${created.roomCode}/join`,
      spectatorBody,
    );
    assert.equal(firstSpectator.status, 200, firstSpectator.text);
    const before = await inspectRoomWith(persistentRuntime, created);

    await persistentRuntime.restartProcess();

    const replayCreate = await postWith(persistentRuntime, '/api/rooms', ownerBody);
    assert.deepEqual(replayCreate.body, created);
    const replayJoin = await postWith(
      persistentRuntime,
      `/api/rooms/${created.roomCode}/join`,
      playerBody,
    );
    assert.deepEqual(replayJoin.body, firstJoin.body);
    const replaySpectator = await postWith(
      persistentRuntime,
      `/api/rooms/${created.roomCode}/join`,
      spectatorBody,
    );
    assert.deepEqual(replaySpectator.body, firstSpectator.body);

    const afterRestart = await inspectRoomWith(persistentRuntime, created);
    assert.deepEqual(
      afterRestart.sessions.map(({ sessionId, role, seat }) => ({ sessionId, role, seat })),
      before.sessions.map(({ sessionId, role, seat }) => ({ sessionId, role, seat })),
    );
    assert.deepEqual(afterRestart.pendingActions, before.pendingActions);
    assert.equal(afterRestart.alarmAt, before.alarmAt);
  } finally {
    await persistentRuntime?.close();
    await rm(persistenceDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
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
