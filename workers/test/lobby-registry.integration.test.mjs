import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { LIMITS } from '../src/room-foundation/constants.mjs';
import { createRoomWorkerRuntime } from './helpers/room-worker-runtime.mjs';

const requestId = (suffix) => `request_id_${suffix.padStart(8, '0')}`;
const requestHash = (digit) => digit.repeat(64);

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

test('allocates atomically, activates an exact lease, and persists deterministic replay', async () => {
  const allocation = await ok('allocate', {
    requestId: requestId('allocate'), requestHash: requestHash('a'), incarnation: 99, now,
  });
  assert.equal(allocation.status, 'PROVISIONING');
  assert.equal(allocation.code, '000');
  assert.equal(allocation.incarnation, 1);
  assert.match(allocation.leaseId, /^[A-Za-z0-9_-]{16,64}$/u);
  assert.equal(allocation.replayed, false);
  assert.ok(allocation.leaseExpiresAt > now);

  await error('activate', {
    requestId: requestId('allocate'), code: '000', incarnation: 1,
    leaseId: requestId('wronglease'), response: { roomCode: '000', incarnation: 1 }, now: now + 1,
  }, 'LEASE_MISMATCH');

  const response = { v: 1, requestId: requestId('allocate'), roomCode: '000', incarnation: 1 };
  const activated = await ok('activate', {
    requestId: requestId('allocate'), code: '000', incarnation: 1,
    leaseId: allocation.leaseId, response, now: now + 2,
  });
  assert.deepEqual(activated, { status: 'ACTIVE', response, replayed: false });
  const retained = await ok('inspect');
  const replayRecord = retained.creationRequests.find((item) => item.request_id === requestId('allocate'));
  assert.equal(replayRecord.expires_at, now + 2 + LIMITS.creationReplayTtlMs);
  assert.equal(retained.alarmAt, replayRecord.expires_at);

  const replay = await ok('allocate', {
    requestId: requestId('allocate'), requestHash: requestHash('a'), now: now + 3,
  });
  assert.deepEqual(replay, {
    status: 'ACTIVE', code: '000', incarnation: 1, response, replayed: true,
  });
  await error('allocate', {
    requestId: requestId('allocate'), requestHash: requestHash('b'), now: now + 3,
  }, 'REQUEST_CONFLICT');

  await runtime.restartRegistry();
  const afterRestart = await ok('allocate', {
    requestId: requestId('allocate'), requestHash: requestHash('a'), now: now + 4,
  });
  assert.deepEqual(afterRestart, replay);
});

test('reconciles expired provisioning leases against the exact room incarnation', async () => {
  const initialized = await ok('allocate', {
    requestId: requestId('initialized'), requestHash: requestHash('c'), now: now + 10,
  });
  const initializedResponse = {
    v: 1, requestId: requestId('initialized'), roomCode: initialized.code,
    incarnation: initialized.incarnation,
  };
  await ok('setRoomInitialization', {
    code: initialized.code, incarnation: initialized.incarnation,
    leaseId: initialized.leaseId, response: initializedResponse,
  });
  await ok('reconcile', { now: initialized.leaseExpiresAt });
  const initializedReplay = await ok('allocate', {
    requestId: requestId('initialized'), requestHash: requestHash('c'),
    now: initialized.leaseExpiresAt + 1,
  });
  assert.deepEqual(initializedReplay, {
    status: 'ACTIVE', code: initialized.code, incarnation: initialized.incarnation,
    response: initializedResponse, replayed: true,
  });

  const absent = await ok('allocate', {
    requestId: requestId('absent'), requestHash: requestHash('d'), now: now + 20,
  });
  await ok('reconcile', { now: absent.leaseExpiresAt });
  const absentReplay = await ok('allocate', {
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
  const allocation = await ok('allocate', {
    requestId: id, requestHash: requestHash('7'), now: Date.now(),
  });
  await ok('setRoomInitialization', {
    code: allocation.code,
    incarnation: allocation.incarnation,
    leaseId: `${allocation.leaseId}_wrong`,
    response: { roomCode: allocation.code, incarnation: allocation.incarnation },
  });

  await ok('reconcile', { now: allocation.leaseExpiresAt });

  const inspection = await ok('inspect');
  assert.equal(roomRow(inspection, allocation).status, 'TOMBSTONE');
  assert.equal(creationRequest(inspection, id).status, 'FAILED');
});

test('keeps exact provisioning state and schedules a bounded retry after inspection failure', async () => {
  const id = requestId('rpcfail');
  const allocation = await ok('allocate', {
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

test('keeps exact provisioning state for a malformed inspection response', async () => {
  const id = requestId('malformed');
  const allocation = await ok('allocate', {
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
  const allocation = await ok('allocate', {
    requestId: id, requestHash: requestHash('a'), now: Date.now() - 59_500,
  });
  const response = { roomCode: allocation.code, incarnation: allocation.incarnation };
  await ok('setRoomInitialization', { ...allocation, response });

  const inspection = await waitForInspection((state) => (
    roomRow(state, allocation)?.status === 'ACTIVE'
  ));
  assert.equal(creationRequest(inspection, id).status, 'ACTIVE');
});

test('reconstructs with a provisioning alarm due and subsequently reconciles it', async () => {
  const id = requestId('restartdue');
  const allocation = await ok('allocate', {
    requestId: id, requestHash: requestHash('b'), now: Date.now() - 59_500,
  });
  const response = { roomCode: allocation.code, incarnation: allocation.incarnation };
  await ok('setRoomInitialization', { ...allocation, response });
  await runtime.restartRegistry();

  await runtime.wait(750);
  const inspection = await ok('inspect');
  assert.equal(roomRow(inspection, allocation).status, 'ACTIVE');
  assert.equal(creationRequest(inspection, id).status, 'ACTIVE');
});

test('release is exact, terminal, and cannot affect a reused incarnation', async () => {
  await error('markReleasePending', { code: '000', incarnation: 2, now: now + 100 }, 'INCARNATION_MISMATCH');
  await error('release', { code: '000', incarnation: 1, now: now + 100 }, 'INVALID_STATE');

  assert.deepEqual(await ok('markReleasePending', {
    code: '000', incarnation: 1, now: now + 101,
  }), { status: 'RELEASE_PENDING' });
  assert.deepEqual(await ok('release', {
    code: '000', incarnation: 1, now: now + 102,
  }), { result: 'RELEASED' });
  assert.deepEqual(await ok('release', {
    code: '000', incarnation: 1, now: now + 103,
  }), { result: 'RELEASED' });

  const beforeReuse = await ok('allocate', {
    requestId: requestId('beforeuse'), requestHash: requestHash('e'),
    now: now + 102 + LIMITS.registryTombstoneMs - 1,
  });
  assert.notEqual(beforeReuse.code, '000');

  const reused = await ok('allocate', {
    requestId: requestId('reuse'), requestHash: requestHash('f'),
    now: now + 102 + LIMITS.registryTombstoneMs,
  });
  assert.equal(reused.code, '000');
  assert.equal(reused.incarnation, 2);
  assert.deepEqual(await ok('release', {
    code: '000', incarnation: 1,
    now: now + 103 + LIMITS.registryTombstoneMs,
  }), { result: 'SUPERSEDED' });

  const inspection = await ok('inspect');
  const current = inspection.roomCodes.find((row) => row.code === '000');
  assert.equal(current.status, 'PROVISIONING');
  assert.equal(current.incarnation, 2);
});

test('bounds live replay records, physically expires them, and creates only primary-key indexes', async () => {
  const capacityNow = now + 6 * 60 * 60 * 1000;
  await ok('seedCapacity', {
    count: LIMITS.creationRequests,
    now: capacityNow,
    expiresAt: capacityNow + 60_000,
  });
  await error('allocate', {
    requestId: requestId('capacity'), requestHash: requestHash('1'), now: capacityNow,
  }, 'SERVICE_CAPACITY', 503);

  const afterExpiry = await ok('allocate', {
    requestId: requestId('capacity'), requestHash: requestHash('1'), now: capacityNow + 60_000,
  });
  assert.equal(afterExpiry.status, 'PROVISIONING');

  const inspection = await ok('inspect');
  assert.ok(inspection.creationRequests.length < LIMITS.creationRequests);
  for (const [table, indexes] of Object.entries(inspection.indexes)) {
    assert.ok(indexes.every((index) => index.origin === 'pk'), `${table} has a secondary index`);
  }
});
