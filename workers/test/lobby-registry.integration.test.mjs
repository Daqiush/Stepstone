import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { LIMITS } from '../src/room-foundation/constants.mjs';
import { createRoomWorkerRuntime } from './helpers/room-worker-runtime.mjs';

const requestId = (suffix) => `request_id_${suffix.padStart(8, '0')}`;
const requestHash = (digit) => digit.repeat(64);
const sessionId = (suffix) => `session_id_${suffix.padStart(8, '0')}`;

let runtime;
let now;

before(async () => {
  runtime = await createRoomWorkerRuntime();
  now = Date.now();
});

after(async () => {
  await runtime?.close();
});

async function ok(action, input = {}) {
  const result = await runtime.registry(action, input);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true, JSON.stringify(result.body));
  return result.body.value;
}

async function error(action, input, code, status = 409) {
  const result = await runtime.registry(action, input);
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.deepEqual(result.body, { ok: false, error: { code } });
}

async function waitForInspection(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inspection = await ok('inspect');
    if (predicate(inspection)) return inspection;
    await runtime.wait(25);
  }
  assert.fail('timed out waiting for registry state');
}

function roomRow(inspection, allocation) {
  return inspection.roomCodes.find((item) => item.code === allocation.code);
}

function creationRequest(inspection, id) {
  return inspection.creationRequests.find((item) => item.request_id === id);
}

function createResponse(id, allocation, overrides = {}) {
  return {
    v: 1,
    requestId: id,
    roomCode: allocation.code,
    incarnation: allocation.incarnation,
    sessionId: sessionId(id.slice(-8)),
    role: 'OWNER',
    seat: 'N',
    ...overrides,
  };
}

test('allocates atomically, activates an exact lease, and persists deterministic replay', async () => {
  const allocation = await ok('allocateAt', {
    requestId: requestId('allocate'), requestHash: requestHash('a'), incarnation: 99, now,
  });
  assert.equal(allocation.status, 'PROVISIONING');
  assert.equal(allocation.code, '000');
  assert.equal(allocation.incarnation, 1);
  assert.match(allocation.leaseId, /^[A-Za-z0-9_-]{16,64}$/u);
  assert.equal(allocation.replayed, false);
  assert.ok(allocation.leaseExpiresAt > now);

  await error('activateAt', {
    requestId: requestId('allocate'), code: '000', incarnation: 1,
    leaseId: requestId('wronglease'), response: createResponse(requestId('allocate'), allocation),
    now: now + 1,
  }, 'LEASE_MISMATCH');

  const response = createResponse(requestId('allocate'), allocation);
  const activated = await ok('activateAt', {
    requestId: requestId('allocate'), code: '000', incarnation: 1,
    leaseId: allocation.leaseId, response, now: now + 2,
  });
  assert.deepEqual(activated, { status: 'ACTIVE', response, replayed: false });
  const retained = await ok('inspect');
  const replayRecord = retained.creationRequests.find((item) => item.request_id === requestId('allocate'));
  assert.equal(replayRecord.expires_at, now + 2 + LIMITS.creationReplayTtlMs);
  assert.equal(retained.alarmAt, replayRecord.expires_at);

  const replay = await ok('allocateAt', {
    requestId: requestId('allocate'), requestHash: requestHash('a'), now: now + 3,
  });
  assert.deepEqual(replay, {
    status: 'ACTIVE', code: '000', incarnation: 1, response, replayed: true,
  });
  await error('allocateAt', {
    requestId: requestId('allocate'), requestHash: requestHash('b'), now: now + 3,
  }, 'REQUEST_CONFLICT');

  await runtime.restartRegistry();
  const afterRestart = await ok('allocateAt', {
    requestId: requestId('allocate'), requestHash: requestHash('a'), now: now + 4,
  });
  assert.deepEqual(afterRestart, replay);
});

test('reconciles expired provisioning leases against the exact room incarnation', async () => {
  const initialized = await ok('allocateAt', {
    requestId: requestId('initialized'), requestHash: requestHash('c'), now: now + 10,
  });
  const initializedResponse = createResponse(requestId('initialized'), initialized);
  await ok('setRoomInitialization', {
    code: initialized.code, incarnation: initialized.incarnation,
    leaseId: initialized.leaseId, leaseExpiresAt: initialized.leaseExpiresAt,
    response: initializedResponse,
  });
  await ok('reconcile', { now: initialized.leaseExpiresAt });
  const initializedReplay = await ok('allocateAt', {
    requestId: requestId('initialized'), requestHash: requestHash('c'),
    now: initialized.leaseExpiresAt + 1,
  });
  assert.deepEqual(initializedReplay, {
    status: 'ACTIVE', code: initialized.code, incarnation: initialized.incarnation,
    response: initializedResponse, replayed: true,
  });

  const absent = await ok('allocateAt', {
    requestId: requestId('absent'), requestHash: requestHash('d'), now: now + 20,
  });
  await ok('reconcile', { now: absent.leaseExpiresAt });
  const absentReplay = await ok('allocateAt', {
    requestId: requestId('absent'), requestHash: requestHash('d'),
    now: absent.leaseExpiresAt + 1,
  });
  assert.deepEqual(absentReplay, {
    status: 'FAILED', code: absent.code, incarnation: absent.incarnation, replayed: true,
  });

  const inspection = await ok('inspect');
  const tombstone = inspection.roomCodes.find((row) => row.code === absent.code);
  assert.equal(tombstone.status, 'TOMBSTONE');
  assert.equal(tombstone.tombstoneUntil, absent.leaseExpiresAt + LIMITS.registryTombstoneMs);
});

test('tombstones an exact provisioning lease when room inspection reports an identity mismatch', async () => {
  const id = requestId('mismatch');
  const allocation = await ok('allocateAt', {
    requestId: id, requestHash: requestHash('7'), now: Date.now(),
  });
  await ok('setRoomInitialization', {
    code: allocation.code,
    incarnation: allocation.incarnation,
    leaseId: `${allocation.leaseId}_wrong`,
    leaseExpiresAt: allocation.leaseExpiresAt,
    response: createResponse(id, allocation),
  });

  await ok('reconcile', { now: allocation.leaseExpiresAt });

  const inspection = await ok('inspect');
  assert.equal(roomRow(inspection, allocation).status, 'TOMBSTONE');
  assert.equal(creationRequest(inspection, id).status, 'FAILED');
});

test('keeps exact provisioning state and schedules a bounded retry after inspection failure', async () => {
  const id = requestId('rpcfail');
  const allocation = await ok('allocateAt', {
    requestId: id, requestHash: requestHash('8'), now: Date.now(),
  });
  await ok('setRoomInspectionFault', { ...allocation, type: 'throw' });
  const before = await ok('inspect');
  const expectedRoom = roomRow(before, allocation);
  const expectedRequest = creationRequest(before, id);

  const startedAt = Date.now();
  await ok('reconcile', { now: allocation.leaseExpiresAt });

  const after = await ok('inspect');
  assert.deepEqual(roomRow(after, allocation), expectedRoom);
  assert.deepEqual(creationRequest(after, id), expectedRequest);
  assert.ok(after.alarmAt > startedAt);
  assert.ok(after.alarmAt <= Date.now() + 5_000);

  await ok('setRoomInspectionFault', { ...allocation, type: null });
  await ok('reconcile', { now: allocation.leaseExpiresAt });
});

test('retry scheduling preserves the earliest provisioning deadline across leases', async () => {
  await ok('inspect');
  const wallStart = Date.now();
  const firstDue = wallStart + 5_000;
  const secondDue = wallStart + 5_500;
  const first = await ok('allocateAt', {
    requestId: requestId('retryfirst'),
    requestHash: requestHash('a'),
    now: firstDue - 60_000,
  });
  const other = await ok('allocateAt', {
    requestId: requestId('retryother'),
    requestHash: requestHash('b'),
    now: secondDue - 60_000,
  });
  assert.equal(first.leaseExpiresAt, firstDue);
  assert.equal(other.leaseExpiresAt, secondDue);

  try {
    await ok('scheduleRetryWithoutAlarm', { retryAt: wallStart + 6_000 });
    const inspection = await ok('inspect');
    assert.equal(roomRow(inspection, first).status, 'PROVISIONING');
    assert.equal(roomRow(inspection, other).status, 'PROVISIONING');
    assert.equal(inspection.alarmAt, firstDue);
  } finally {
    await ok('reconcile', { now: wallStart + 6_000 });
  }
});

test('keeps exact provisioning state for a malformed inspection response', async () => {
  const id = requestId('malformed');
  const allocation = await ok('allocateAt', {
    requestId: id, requestHash: requestHash('9'), now: Date.now(),
  });
  await ok('setRoomInspectionFault', { ...allocation, type: 'malformed' });
  const before = await ok('inspect');

  await ok('reconcile', { now: allocation.leaseExpiresAt });

  const after = await ok('inspect');
  assert.deepEqual(roomRow(after, allocation), roomRow(before, allocation));
  assert.deepEqual(creationRequest(after, id), creationRequest(before, id));
  await ok('setRoomInspectionFault', { ...allocation, type: null });
  await ok('reconcile', { now: allocation.leaseExpiresAt });
});

test('reconciles an expired lease through the Durable Object alarm handler', async () => {
  const id = requestId('alarmrun');
  const controlledNow = now + 30 * 60_000;
  const allocation = await ok('allocateAt', {
    requestId: id, requestHash: requestHash('a'), now: controlledNow,
  });
  const response = createResponse(id, allocation);
  await ok('setRoomInitialization', { ...allocation, response });
  await ok('runAlarmAt', { now: allocation.leaseExpiresAt });

  const inspection = await waitForInspection((state) => (
    roomRow(state, allocation)?.status === 'ACTIVE'
  ));
  assert.equal(creationRequest(inspection, id).status, 'ACTIVE');
});

test('reconstructs with a provisioning alarm due and subsequently reconciles it', async () => {
  const id = requestId('restartdue');
  const controlledNow = now + 45 * 60_000;
  const allocation = await ok('allocateAt', {
    requestId: id, requestHash: requestHash('b'), now: controlledNow,
  });
  const response = createResponse(id, allocation);
  await ok('setRoomInitialization', { ...allocation, response });
  const beforeRestart = await ok('inspect');
  assert.equal(beforeRestart.alarmAt, allocation.leaseExpiresAt);
  await runtime.restartRegistry();

  await ok('runAlarmAt', { now: allocation.leaseExpiresAt });
  const inspection = await waitForInspection((state) => (
    roomRow(state, allocation)?.status === 'ACTIVE'
  ));
  assert.equal(creationRequest(inspection, id).status, 'ACTIVE');
});

test('terminal release atomically replaces its fallback alarm with earliest live work', async () => {
  const isolated = await createRoomWorkerRuntime();
  const call = async (action, input = {}) => {
    const response = await isolated.registry(action, input);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.ok, true, JSON.stringify(response.body));
    return response.body.value;
  };
  try {
    const markAt = Date.now() + 10 * 60_000;
    const id = requestId('alarmclear');
    const allocation = await call('allocateAt', {
      requestId: id,
      requestHash: requestHash('c'),
      now: markAt - 2,
    });
    const response = createResponse(id, allocation);
    await call('activateAt', {
      requestId: id,
      code: allocation.code,
      incarnation: allocation.incarnation,
      leaseId: allocation.leaseId,
      response,
      now: markAt - 1,
    });
    await call('markReleasePendingAt', {
      code: allocation.code,
      incarnation: allocation.incarnation,
      now: markAt,
    });
    let inspection = await call('inspect');
    assert.equal(inspection.alarmAt, markAt + 60_000);

    assert.deepEqual(await call('releaseAt', {
      code: allocation.code,
      incarnation: allocation.incarnation,
      now: markAt + 1,
    }), { result: 'RELEASED' });
    inspection = await call('inspect');
    const replay = creationRequest(inspection, id);
    assert.equal(inspection.alarmAt, replay.expires_at);
    assert.notEqual(inspection.alarmAt, markAt + 60_000);

    await call('reconcile', { now: replay.expires_at });
    inspection = await call('inspect');
    assert.equal(inspection.alarmAt, null);
  } finally {
    await isolated.close();
  }
});

test('mark-release transition and fallback alarm roll back together at the crash window', async () => {
  const isolated = await createRoomWorkerRuntime();
  const call = async (action, input = {}) => {
    const response = await isolated.registry(action, input);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.ok, true, JSON.stringify(response.body));
    return response.body.value;
  };
  try {
    const activatedAt = Date.now() + 20 * 60_000;
    const id = requestId('markatomic');
    const allocation = await call('allocateAt', {
      requestId: id,
      requestHash: requestHash('d'),
      now: activatedAt - 1,
    });
    const response = createResponse(id, allocation);
    await call('activateAt', {
      requestId: id,
      code: allocation.code,
      incarnation: allocation.incarnation,
      leaseId: allocation.leaseId,
      response,
      now: activatedAt,
    });
    const before = await call('inspect');
    await call('setReleaseFault', {
      code: allocation.code,
      incarnation: allocation.incarnation,
      type: 'after-mark-before-alarm',
    });

    await assert.rejects(isolated.request('/api/rooms/__test/registry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'markReleasePending',
        code: allocation.code,
        incarnation: allocation.incarnation,
      }),
    }), /injected registry mark\/alarm crash window/u);
    const after = await call('inspect');
    assert.equal(roomRow(after, allocation).status, 'ACTIVE');
    assert.equal(after.alarmAt, before.alarmAt);
  } finally {
    await isolated.close();
  }
});

test('resets an already-due provisioning alarm to now before reconciliation', async () => {
  const id = requestId('recoverdue');
  const allocation = await ok('allocateAt', {
    requestId: id, requestHash: requestHash('1'), now: Date.now(),
  });
  const response = createResponse(id, allocation);
  await ok('setRoomInitialization', { ...allocation, response });

  const recovery = await ok('recoverAlarmAt', { now: allocation.leaseExpiresAt });
  assert.equal(recovery.beforeAlarmAt, allocation.leaseExpiresAt);
  assert.ok(recovery.beforeAlarmAt <= recovery.recoveryNow);
  assert.ok(recovery.afterAlarmAt <= recovery.wallClockNow, JSON.stringify(recovery));

  const inspection = await waitForInspection((state) => (
    roomRow(state, allocation)?.status === 'ACTIVE'
  ));
  assert.equal(creationRequest(inspection, id).status, 'ACTIVE');
});

test('rejects non-string registry identities without coercion or persistence', async () => {
  const validId = requestId('badtypes');
  const validHash = requestHash('2');
  const before = await ok('inspect');
  const invalidAllocations = [
    { requestId: 1234567890123456, requestHash: validHash },
    { requestId: [validId], requestHash: validHash },
    { requestId: { value: validId }, requestHash: validHash },
    { requestId: validId, requestHash: [validHash] },
    { requestId: validId, requestHash: { value: validHash } },
    { requestId: validId, requestHash: 1 },
  ];
  for (const input of invalidAllocations) {
    await error('allocate', input, 'INVALID_REQUEST', 400);
  }
  const afterAllocations = await ok('inspect');
  assert.deepEqual(afterAllocations.roomCodes, before.roomCodes);
  assert.deepEqual(afterAllocations.creationRequests, before.creationRequests);

  const id = requestId('typedlease');
  const allocation = await ok('allocateAt', {
    requestId: id, requestHash: requestHash('3'), now: Date.now(),
  });
  const response = createResponse(id, allocation);
  const beforeMutations = await ok('inspect');
  const invalidActivations = [
    { requestId: 1234567890123456, code: allocation.code, leaseId: allocation.leaseId },
    { requestId: [id], code: allocation.code, leaseId: allocation.leaseId },
    { requestId: { value: id }, code: allocation.code, leaseId: allocation.leaseId },
    { requestId: id, code: Number(allocation.code), leaseId: allocation.leaseId },
    { requestId: id, code: [allocation.code], leaseId: allocation.leaseId },
    { requestId: id, code: { value: allocation.code }, leaseId: allocation.leaseId },
    { requestId: id, code: allocation.code, leaseId: 1234567890123456 },
    { requestId: id, code: allocation.code, leaseId: [allocation.leaseId] },
    { requestId: id, code: allocation.code, leaseId: { value: allocation.leaseId } },
  ];
  for (const invalid of invalidActivations) {
    await error('activateAt', {
      ...invalid, incarnation: allocation.incarnation, response, now: Date.now(),
    }, 'INVALID_REQUEST', 400);
  }
  for (const code of [Number(allocation.code), [allocation.code], { value: allocation.code }]) {
    await error('markReleasePendingAt', {
      code, incarnation: allocation.incarnation, now: Date.now(),
    }, 'INVALID_REQUEST', 400);
    await error('releaseAt', {
      code, incarnation: allocation.incarnation, now: Date.now(),
    }, 'INVALID_REQUEST', 400);
  }
  const afterMutations = await ok('inspect');
  assert.deepEqual(roomRow(afterMutations, allocation), roomRow(beforeMutations, allocation));
  assert.deepEqual(creationRequest(afterMutations, id), creationRequest(beforeMutations, id));
});

test('production registry RPCs ignore caller-supplied clocks and preserve tombstone delay', async () => {
  const id = requestId('prodclock');
  const startedAt = Date.now();
  const allocation = await ok('allocate', {
    requestId: id,
    requestHash: requestHash('4'),
    now: startedAt + 10 * 60_000,
  });
  assert.ok(allocation.leaseExpiresAt >= startedAt + 59_000);
  assert.ok(allocation.leaseExpiresAt <= Date.now() + 61_000);
  const response = createResponse(id, allocation);
  assert.deepEqual(await ok('activate', {
    requestId: id,
    code: allocation.code,
    incarnation: allocation.incarnation,
    leaseId: allocation.leaseId,
    response,
    now: allocation.leaseExpiresAt,
  }), { status: 'ACTIVE', response, replayed: false });

  assert.deepEqual(await ok('markReleasePending', {
    code: allocation.code, incarnation: allocation.incarnation, now: 0,
  }), { status: 'RELEASE_PENDING' });
  assert.deepEqual(await ok('release', {
    code: allocation.code, incarnation: allocation.incarnation, now: 0,
  }), { result: 'RELEASED' });
  const replacement = await ok('allocate', {
    requestId: requestId('clocknext'),
    requestHash: requestHash('5'),
    now: Date.now() + LIMITS.registryTombstoneMs + 1,
  });
  assert.notEqual(replacement.code, allocation.code);
});

test('activation accepts only the exact normalized owner create response', async () => {
  const id = requestId('response');
  const allocation = await ok('allocateAt', {
    requestId: id, requestHash: requestHash('6'), now: Date.now(),
  });
  const valid = createResponse(id, allocation);
  const { seat: omittedSeat, ...missingSeat } = valid;
  assert.equal(omittedSeat, 'N');
  const invalidResponses = [
    null,
    [],
    missingSeat,
    { ...valid, reconnectToken: 'not-persistable' },
    { ...valid, v: 2 },
    { ...valid, requestId: requestId('different') },
    { ...valid, roomCode: '999' },
    { ...valid, incarnation: allocation.incarnation + 1 },
    { ...valid, sessionId: 1234567890123456 },
    { ...valid, sessionId: [valid.sessionId] },
    { ...valid, sessionId: { value: valid.sessionId } },
    { ...valid, role: 'PLAYER' },
    { ...valid, seat: 'E' },
  ];
  for (const response of invalidResponses) {
    await error('activateAt', {
      requestId: id,
      code: allocation.code,
      incarnation: allocation.incarnation,
      leaseId: allocation.leaseId,
      response,
      now: Date.now(),
    }, 'INVALID_REQUEST', 400);
  }
  const activated = await ok('activateAt', {
    requestId: id,
    code: allocation.code,
    incarnation: allocation.incarnation,
    leaseId: allocation.leaseId,
    response: { seat: 'N', role: 'OWNER', ...valid },
    now: Date.now(),
  });
  assert.deepEqual(activated, { status: 'ACTIVE', response: valid, replayed: false });
  const inspection = await ok('inspect');
  assert.deepEqual(JSON.parse(creationRequest(inspection, id).response_json), valid);
});

test('retains a failed-inspection provisioning replay past 24 hours and counts it toward capacity', async () => {
  const id = requestId('longretry');
  const allocation = await ok('allocateAt', {
    requestId: id, requestHash: requestHash('7'), now: Date.now(),
  });
  await ok('setRoomInspectionFault', { ...allocation, type: 'throw' });
  const before = await ok('inspect');
  const expectedRequest = creationRequest(before, id);
  const longFuture = allocation.leaseExpiresAt + LIMITS.creationReplayTtlMs + 1;
  try {
    await ok('reconcile', { now: longFuture });
    const afterFailure = await ok('inspect');
    assert.deepEqual(creationRequest(afterFailure, id), expectedRequest);
    assert.deepEqual(await ok('allocateAt', {
      requestId: id, requestHash: requestHash('7'), now: longFuture,
    }), { ...allocation, replayed: true });

    await ok('seedCapacity', {
      count: LIMITS.creationRequests,
      now: longFuture,
      expiresAt: longFuture + 1,
    });
    await error('allocateAt', {
      requestId: requestId('stillfull'), requestHash: requestHash('8'), now: longFuture,
    }, 'SERVICE_CAPACITY', 503);
    const afterTerminalExpiry = await ok('allocateAt', {
      requestId: requestId('afterfull'), requestHash: requestHash('9'), now: longFuture + 1,
    });
    assert.equal(afterTerminalExpiry.status, 'PROVISIONING');
    assert.notEqual(afterTerminalExpiry.code, allocation.code);
  } finally {
    await ok('setRoomInspectionFault', { ...allocation, type: null });
    await ok('reconcile', { now: longFuture + 1 });
  }
});

test('release is exact, terminal, and cannot affect a reused incarnation', async () => {
  await error('markReleasePendingAt', { code: '000', incarnation: 2, now: now + 100 }, 'INCARNATION_MISMATCH');
  await error('releaseAt', { code: '000', incarnation: 1, now: now + 100 }, 'INVALID_STATE');

  assert.deepEqual(await ok('markReleasePendingAt', {
    code: '000', incarnation: 1, now: now + 101,
  }), { status: 'RELEASE_PENDING' });
  assert.deepEqual(await ok('releaseAt', {
    code: '000', incarnation: 1, now: now + 102,
  }), { result: 'RELEASED' });
  assert.deepEqual(await ok('releaseAt', {
    code: '000', incarnation: 1, now: now + 103,
  }), { result: 'RELEASED' });

  const beforeReuse = await ok('allocateAt', {
    requestId: requestId('beforeuse'), requestHash: requestHash('e'),
    now: now + 102 + LIMITS.registryTombstoneMs - 1,
  });
  assert.notEqual(beforeReuse.code, '000');

  const reused = await ok('allocateAt', {
    requestId: requestId('reuse'), requestHash: requestHash('f'),
    now: now + 102 + LIMITS.registryTombstoneMs,
  });
  assert.equal(reused.code, '000');
  assert.equal(reused.incarnation, 2);
  assert.deepEqual(await ok('releaseAt', {
    code: '000', incarnation: 1,
    now: now + 103 + LIMITS.registryTombstoneMs,
  }), { result: 'SUPERSEDED' });

  const inspection = await ok('inspect');
  const current = inspection.roomCodes.find((row) => row.code === '000');
  assert.equal(current.status, 'PROVISIONING');
  assert.equal(current.incarnation, 2);
});

test('bounds live replay records, physically expires them, and keeps only budgeted indexes', async () => {
  const capacityNow = now + 6 * 60 * 60 * 1000;
  await ok('seedCapacity', {
    count: LIMITS.creationRequests,
    now: capacityNow,
    expiresAt: capacityNow + 60_000,
  });
  await error('allocateAt', {
    requestId: requestId('capacity'), requestHash: requestHash('1'), now: capacityNow,
  }, 'SERVICE_CAPACITY', 503);

  const afterExpiry = await ok('allocateAt', {
    requestId: requestId('capacity'), requestHash: requestHash('1'), now: capacityNow + 60_000,
  });
  assert.equal(afterExpiry.status, 'PROVISIONING');

  const inspection = await ok('inspect');
  assert.ok(inspection.creationRequests.length < LIMITS.creationRequests);
  assert.deepEqual(
    inspection.indexes.room_codes.filter((index) => index.origin === 'c')
      .map((index) => index.name).sort(),
    ['room_codes_available', 'room_codes_due_lease', 'room_codes_due_release'],
  );
  assert.deepEqual(
    inspection.indexes.creation_requests.filter((index) => index.origin === 'c')
      .map((index) => index.name).sort(),
    ['creation_requests_due', 'creation_requests_lease'],
  );
});
