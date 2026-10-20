import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectCommandCache,
  isValidCommandCache,
  storeCommandResult,
} from '../src/room-foundation/command-cache.mjs';
import { LIMITS } from '../src/room-foundation/constants.mjs';
import { fingerprintCommand } from '../src/room-foundation/protocol.mjs';

const SESSION_A = 'session_cache_a1';
const SESSION_B = 'session_cache_b1';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const NOW = 10_000;

function commandId(index) {
  return `command_cache_${String(index).padStart(4, '0')}`;
}

function entry(overrides = {}) {
  return {
    sessionId: SESSION_A,
    commandId: commandId(1),
    requestHash: HASH_A,
    committedRevision: 1,
    compactReply: { name: 'foundation.increment' },
    expiresAt: NOW + LIMITS.recentCommandTtlMs,
    ...overrides,
  };
}

test('stores compact command results immutably without snapshots', () => {
  const original = {};
  const stored = storeCommandResult(original, entry(), NOW);

  assert.deepEqual(original, {});
  assert.notEqual(stored, original);
  assert.deepEqual(stored, { [SESSION_A]: [entry()] });
  assert.equal(JSON.stringify(stored).includes('snapshot'), false);
  assert.deepEqual(inspectCommandCache(stored, {
    sessionId: SESSION_A,
    commandId: commandId(1),
    requestHash: HASH_A,
    now: NOW,
  }), { kind: 'duplicate', entry: entry() });
});

test('accepts only allowlisted classic compact replies with an exact phase', () => {
  for (const [name, phase] of [
    ['classic.start', 'BIDDING'],
    ['classic.bid', 'PLAYING'],
    ['classic.play', 'SCORING'],
    ['classic.ready-next', 'BIDDING'],
  ]) {
    const classicEntry = entry({ compactReply: { name, phase } });
    const stored = storeCommandResult({}, classicEntry, NOW);
    assert.equal(isValidCommandCache(stored), true);
    assert.deepEqual(inspectCommandCache(stored, {
      sessionId: SESSION_A,
      commandId: classicEntry.commandId,
      requestHash: HASH_A,
      now: NOW,
    }), { kind: 'duplicate', entry: classicEntry });
  }

  for (const compactReply of [
    { name: 'foundation.increment', phase: 'LOBBY' },
    { name: 'classic.start' },
    { name: 'classic.unknown', phase: 'BIDDING' },
    { name: 'classic.start', phase: 'CORRUPTED' },
    { name: 'classic.start', phase: 'BIDDING', extra: true },
  ]) {
    assert.equal(isValidCommandCache({
      [SESSION_A]: [entry({ compactReply })],
    }), false);
  }
});

test('bounds each session independently to the newest 128 live entries', () => {
  let cache = {};
  for (let index = 0; index < LIMITS.recentCommandsPerPlayer + 2; index += 1) {
    cache = storeCommandResult(cache, entry({
      commandId: commandId(index),
      committedRevision: index + 1,
    }), NOW);
  }
  cache = storeCommandResult(cache, entry({
    sessionId: SESSION_B,
    commandId: commandId(999),
    committedRevision: 999,
  }), NOW);

  assert.equal(cache[SESSION_A].length, LIMITS.recentCommandsPerPlayer);
  assert.equal(cache[SESSION_A][0].commandId, commandId(2));
  assert.equal(cache[SESSION_A].at(-1).commandId, commandId(129));
  assert.equal(cache[SESSION_B].length, 1);
});

test('prunes expired entries from every session on writes and treats expiry as a miss', () => {
  const expired = entry({ expiresAt: NOW });
  const liveOtherSession = entry({
    sessionId: SESSION_B,
    commandId: commandId(2),
    expiresAt: NOW + 1,
  });
  const persisted = {
    [SESSION_A]: [expired],
    [SESSION_B]: [liveOtherSession],
  };

  assert.deepEqual(inspectCommandCache(persisted, {
    sessionId: SESSION_A,
    commandId: expired.commandId,
    requestHash: expired.requestHash,
    now: NOW,
  }), { kind: 'miss' });

  const stored = storeCommandResult(persisted, entry({ commandId: commandId(3) }), NOW);
  assert.deepEqual(persisted, {
    [SESSION_A]: [expired],
    [SESSION_B]: [liveOtherSession],
  });
  assert.deepEqual(Object.keys(stored).sort(), [SESSION_A, SESSION_B].sort());
  assert.deepEqual(stored[SESSION_A].map((item) => item.commandId), [commandId(3)]);
  assert.deepEqual(stored[SESSION_B].map((item) => item.commandId), [commandId(2)]);
});

test('retains command idempotency through the exact 24-hour TTL boundary', () => {
  assert.equal(LIMITS.recentCommandTtlMs, 24 * 60 * 60 * 1000);
  const cached = storeCommandResult({}, entry(), NOW);
  const lookup = {
    sessionId: SESSION_A,
    commandId: commandId(1),
    requestHash: HASH_A,
  };

  assert.equal(inspectCommandCache(cached, {
    ...lookup, now: NOW + LIMITS.recentCommandTtlMs - 1,
  }).kind, 'duplicate');
  assert.deepEqual(inspectCommandCache(cached, {
    ...lookup, now: NOW + LIMITS.recentCommandTtlMs,
  }), { kind: 'miss' });
});

test('detects deterministic canonical reuse conflicts within one session only', async () => {
  const first = {
    v: 1,
    type: 'command',
    id: commandId(4),
    name: 'foundation.increment',
    payload: { expectedRevision: 0 },
  };
  const reordered = {
    payload: { expectedRevision: 0 },
    name: 'foundation.increment',
    id: commandId(4),
    type: 'command',
    v: 1,
  };
  const changed = { ...first, payload: { expectedRevision: 1 } };
  const options = { foundationTestEnabled: true };
  const firstHash = await fingerprintCommand(first, options);
  const cache = storeCommandResult({}, entry({
    commandId: first.id,
    requestHash: firstHash,
  }), NOW);

  assert.equal(await fingerprintCommand(reordered, options), firstHash);
  assert.equal((await fingerprintCommand(changed, options)) === firstHash, false);
  assert.equal(inspectCommandCache(cache, {
    sessionId: SESSION_A,
    commandId: first.id,
    requestHash: await fingerprintCommand(reordered, options),
    now: NOW,
  }).kind, 'duplicate');
  assert.deepEqual(inspectCommandCache(cache, {
    sessionId: SESSION_A,
    commandId: first.id,
    requestHash: await fingerprintCommand(changed, options),
    now: NOW,
  }), { kind: 'conflict' });
  assert.deepEqual(inspectCommandCache(cache, {
    sessionId: SESSION_B,
    commandId: first.id,
    requestHash: await fingerprintCommand(changed, options),
    now: NOW,
  }), { kind: 'miss' });
});

test('fails closed for malformed persisted caches without mutating them', () => {
  const malformedCaches = [
    null,
    [],
    { [SESSION_A]: 'not-an-array' },
    { [SESSION_A]: [{ ...entry(), requestHash: 'secret' }] },
    { [SESSION_A]: [{ ...entry(), sessionId: SESSION_B }] },
    { [SESSION_A]: [entry(), entry()] },
    { [SESSION_A]: [{ ...entry(), compactReply: { name: 'foundation.increment', snapshot: {} } }] },
  ];

  for (const malformed of malformedCaches) {
    const before = JSON.stringify(malformed);
    assert.deepEqual(inspectCommandCache(malformed, {
      sessionId: SESSION_A,
      commandId: commandId(1),
      requestHash: HASH_A,
      now: NOW,
    }), { kind: 'invalid' });
    assert.throws(() => storeCommandResult(malformed, entry(), NOW), TypeError);
    assert.equal(JSON.stringify(malformed), before);
  }
});

test('validates a persisted cache for wake reconstruction without exposing normalized state', () => {
  const valid = { [SESSION_A]: [entry()] };
  assert.equal(isValidCommandCache(valid), true);
  assert.equal(isValidCommandCache({ [SESSION_A]: [{ ...entry(), requestHash: 'bad' }] }), false);
  assert.equal(isValidCommandCache(null), false);
  assert.deepEqual(valid, { [SESSION_A]: [entry()] });
});
