import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  REGISTRY_RELEASE_RESULTS,
  REGISTRY_STATUSES,
} from '../src/room-foundation/constants.mjs';
import {
  RegistryTransitionError,
  activateRegistryCode,
  allocateRegistryCode,
  markRegistryReleasePending,
  reconcileProvisioning,
  releaseRegistryCode,
} from '../src/room-foundation/registry-state.mjs';

const now = 1_800_000_000_000;
const leaseId = 'lease_1234567890';
const base = Object.freeze({
  code: '123',
  incarnation: 7,
  status: 'PROVISIONING',
  leaseId,
  leaseExpiresAt: now + 30_000,
  tombstoneUntil: null,
  updatedAt: now,
});

function expectTransitionError(fn, reason) {
  assert.throws(fn, (error) => (
    error instanceof RegistryTransitionError && error.reason === reason
  ));
}

test('registry statuses and terminal release results are exact closed constants', () => {
  assert.deepEqual(REGISTRY_STATUSES, [
    'FREE', 'PROVISIONING', 'ACTIVE', 'RELEASE_PENDING', 'TOMBSTONE',
  ]);
  assert.deepEqual(REGISTRY_RELEASE_RESULTS, ['RELEASED', 'SUPERSEDED']);
  assert.equal(Object.isFrozen(REGISTRY_STATUSES), true);
  assert.equal(Object.isFrozen(REGISTRY_RELEASE_RESULTS), true);
});

test('allocation transitions a free code and an elapsed tombstone to provisioning', () => {
  const cases = [
    [
      { code: '123', incarnation: 0, status: 'FREE', leaseId: null, leaseExpiresAt: null, tombstoneUntil: null, updatedAt: now - 1 },
      1,
    ],
    [
      { ...base, status: 'TOMBSTONE', leaseId: null, leaseExpiresAt: null, tombstoneUntil: now },
      8,
    ],
  ];
  for (const [row, incarnation] of cases) {
    assert.deepEqual(allocateRegistryCode(row, {
      leaseId: 'next_lease_12345', leaseExpiresAt: now + 60_000, now,
    }), {
      code: '123',
      incarnation,
      status: 'PROVISIONING',
      leaseId: 'next_lease_12345',
      leaseExpiresAt: now + 60_000,
      tombstoneUntil: null,
      updatedAt: now,
    });
  }
});

test('allocation rejects live tombstones and every advertised or leased state', () => {
  for (const row of [
    { ...base, status: 'TOMBSTONE', leaseId: null, leaseExpiresAt: null, tombstoneUntil: now + 1 },
    base,
    { ...base, status: 'ACTIVE', leaseId: null, leaseExpiresAt: null },
    { ...base, status: 'RELEASE_PENDING', leaseId: null, leaseExpiresAt: null },
  ]) {
    expectTransitionError(
      () => allocateRegistryCode(row, { leaseId: 'next_lease_12345', leaseExpiresAt: now + 1, now }),
      'CODE_UNAVAILABLE',
    );
  }
});

test('activation requires the exact provisioning incarnation and lease', () => {
  assert.deepEqual(activateRegistryCode(base, { incarnation: 7, leaseId, now: now + 2 }), {
    ...base,
    status: 'ACTIVE',
    leaseId: null,
    leaseExpiresAt: null,
    updatedAt: now + 2,
  });

  for (const [input, reason] of [
    [{ incarnation: 8, leaseId, now }, 'INCARNATION_MISMATCH'],
    [{ incarnation: 7, leaseId: 'other_lease_1234', now }, 'LEASE_MISMATCH'],
  ]) {
    expectTransitionError(() => activateRegistryCode(base, input), reason);
  }
  expectTransitionError(
    () => activateRegistryCode({ ...base, status: 'ACTIVE' }, { incarnation: 7, leaseId, now }),
    'INVALID_STATE',
  );
  expectTransitionError(
    () => activateRegistryCode(base, { incarnation: 7, leaseId, now: base.leaseExpiresAt }),
    'LEASE_EXPIRED',
  );
});

test('lease reconciliation activates an initialized exact room or tombstones an absent one', () => {
  const reconcileAt = base.leaseExpiresAt;
  assert.equal(
    reconcileProvisioning(base, { incarnation: 7, leaseId, initialized: true, now: reconcileAt }).status,
    'ACTIVE',
  );
  assert.deepEqual(
    reconcileProvisioning(base, { incarnation: 7, leaseId, initialized: false, now: reconcileAt }),
    {
      ...base,
      status: 'TOMBSTONE',
      leaseId: null,
      leaseExpiresAt: null,
      tombstoneUntil: reconcileAt + 5 * 60 * 1000,
      updatedAt: reconcileAt,
    },
  );
  expectTransitionError(
    () => reconcileProvisioning(base, { incarnation: 7, leaseId: 'other_lease_1234', initialized: true, now }),
    'LEASE_MISMATCH',
  );
  expectTransitionError(
    () => reconcileProvisioning(base, { incarnation: 7, leaseId, initialized: true, now: base.leaseExpiresAt - 1 }),
    'LEASE_NOT_EXPIRED',
  );
});

test('mark-release-pending requires the exact active incarnation', () => {
  const active = { ...base, status: 'ACTIVE', leaseId: null, leaseExpiresAt: null };
  assert.deepEqual(markRegistryReleasePending(active, { incarnation: 7, now: now + 4 }), {
    ...active,
    status: 'RELEASE_PENDING',
    updatedAt: now + 4,
  });
  expectTransitionError(
    () => markRegistryReleasePending(active, { incarnation: 6, now }),
    'INCARNATION_MISMATCH',
  );
  expectTransitionError(
    () => markRegistryReleasePending(base, { incarnation: 7, now }),
    'INVALID_STATE',
  );
});

test('exact release-pending transitions to a five-minute tombstone and returns RELEASED', () => {
  const pending = {
    ...base, status: 'RELEASE_PENDING', leaseId: null, leaseExpiresAt: null,
  };
  assert.deepEqual(releaseRegistryCode(pending, { incarnation: 7, now: now + 5 }), {
    result: 'RELEASED',
    row: {
      ...pending,
      status: 'TOMBSTONE',
      tombstoneUntil: now + 5 + 5 * 60 * 1000,
      updatedAt: now + 5,
    },
  });
});

test('release replay is terminal for the exact tombstone and does not extend it', () => {
  const tombstone = {
    ...base,
    status: 'TOMBSTONE',
    leaseId: null,
    leaseExpiresAt: null,
    tombstoneUntil: now + 5 * 60 * 1000,
  };
  const replay = releaseRegistryCode(tombstone, { incarnation: 7, now: now + 100 });
  assert.equal(replay.result, 'RELEASED');
  assert.strictEqual(replay.row, tombstone);
});

test('release replay from an older incarnation is terminal SUPERSEDED and cannot mutate the newer row', () => {
  for (const status of REGISTRY_STATUSES) {
    const newer = {
      ...base,
      incarnation: 8,
      status,
      leaseId: status === 'PROVISIONING' ? leaseId : null,
      leaseExpiresAt: status === 'PROVISIONING' ? now + 1 : null,
      tombstoneUntil: status === 'TOMBSTONE' ? now + 1 : null,
    };
    const replay = releaseRegistryCode(newer, { incarnation: 7, now: now + 100 });
    assert.equal(replay.result, 'SUPERSEDED', status);
    assert.strictEqual(replay.row, newer, status);
  }
});

test('release rejects future incarnations and exact active/provisioning rows', () => {
  for (const [row, incarnation, reason] of [
    [base, 8, 'INCARNATION_MISMATCH'],
    [base, 7, 'INVALID_STATE'],
    [{ ...base, status: 'ACTIVE', leaseId: null, leaseExpiresAt: null }, 7, 'INVALID_STATE'],
  ]) {
    expectTransitionError(() => releaseRegistryCode(row, { incarnation, now }), reason);
  }
});

test('registry transitions validate row and transition input without partial mutation', () => {
  const original = { ...base };
  for (const action of [
    () => allocateRegistryCode({ ...base, code: '12' }, { leaseId, leaseExpiresAt: now + 1, now }),
    () => allocateRegistryCode({ ...base, status: 'FREE' }, { leaseId: 'short', leaseExpiresAt: now + 1, now }),
    () => activateRegistryCode(base, { incarnation: 7.5, leaseId, now }),
    () => reconcileProvisioning(base, { incarnation: 7, leaseId, initialized: 'yes', now }),
  ]) {
    assert.throws(action, RegistryTransitionError);
  }
  assert.deepEqual(base, original);
});
