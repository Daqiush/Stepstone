import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';

import {
  ERROR_CODES,
  LIMITS,
  PROTOCOL_VERSION,
} from '../src/room-foundation/constants.mjs';
import {
  ProtocolError,
  assertCommandPayloadSize,
  assertHttpJsonSize,
  assertRoomSnapshotSize,
  assertWebSocketFrameSize,
  canonicalJson,
  constantTimeDigestEqual,
  fingerprintCreateRequest,
  fingerprintJoinRequest,
  fingerprintCommand,
  hashReconnectToken,
  parseCommandFrame,
  parseCreateRequest,
  parseHelloFrame,
  parseJoinRequest,
  publicErrorResponse,
} from '../src/room-foundation/protocol.mjs';

const requestId = 'request_12345678';
const commandId = 'command_12345678';
const rotationId = 'rotation_1234567';
const tokenBytes = Uint8Array.from({ length: 32 }, (_, index) => index);
const nextTokenBytes = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const reconnectToken = Buffer.from(tokenBytes).toString('base64url');
const nextReconnectToken = Buffer.from(nextTokenBytes).toString('base64url');

const validCreate = Object.freeze({
  v: 1,
  requestId,
  displayName: 'North',
  reconnectToken,
});
const validJoin = Object.freeze({
  v: 1,
  requestId,
  displayName: 'East',
  reconnectToken,
  requestedRole: 'player',
});
const validHello = Object.freeze({
  v: 1,
  type: 'hello',
  id: rotationId,
  reconnectToken,
  nextReconnectToken,
});
const validCommand = Object.freeze({
  v: 1,
  type: 'command',
  id: commandId,
  name: 'foundation.increment',
  payload: { expectedRevision: 4 },
});
const foundationOptions = Object.freeze({ foundationTestEnabled: true });

function parseFoundationCommand(value) {
  return parseCommandFrame(value, foundationOptions);
}

function expectProtocolError(fn, code) {
  assert.throws(fn, (error) => error instanceof ProtocolError && error.code === code);
}

test('protocol version and exact design limits are exported as immutable values', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.deepEqual(LIMITS, {
    httpJsonBytes: 16 * 1024,
    webSocketFrameBytes: 16 * 1024,
    commandPayloadBytes: 8 * 1024,
    idMinScalars: 16,
    idMaxScalars: 64,
    displayNameMinScalars: 1,
    displayNameMaxScalars: 32,
    reconnectTokenBytes: 32,
    totalSessions: 16,
    playerSessions: 4,
    spectatorSessions: 12,
    unauthenticatedSockets: 8,
    helloDeadlineMs: 10_000,
    pendingActions: 64,
    roomSnapshotBytes: 512 * 1024,
    recentCommandsPerPlayer: 128,
    recentCommandTtlMs: 24 * 60 * 60 * 1000,
    creationRequests: 2_000,
    creationReplayTtlMs: 24 * 60 * 60 * 1000,
    ownerAuthExpiryMs: 10 * 60 * 1000,
    roomExpiryMs: 24 * 60 * 60 * 1000,
    registryTombstoneMs: 5 * 60 * 1000,
    registryReleaseBackoffMaxMs: 60 * 60 * 1000,
  });
  assert.equal(Object.isFrozen(LIMITS), true);
});

test('byte limits accept the exact boundary and reject one byte over', () => {
  for (const [assertSize, limit, code] of [
    [assertHttpJsonSize, LIMITS.httpJsonBytes, 'INVALID_REQUEST'],
    [assertWebSocketFrameSize, LIMITS.webSocketFrameBytes, 'INVALID_COMMAND'],
  ]) {
    assert.doesNotThrow(() => assertSize('x'.repeat(limit)));
    expectProtocolError(() => assertSize('x'.repeat(limit + 1)), code);
    assert.doesNotThrow(() => assertSize(new Uint8Array(limit)));
    expectProtocolError(() => assertSize(new Uint8Array(limit + 1)), code);
  }
  assert.doesNotThrow(() => assertHttpJsonSize('\u{1f600}'.repeat(LIMITS.httpJsonBytes / 4)));
  expectProtocolError(
    () => assertHttpJsonSize(`${'\u{1f600}'.repeat(LIMITS.httpJsonBytes / 4)}x`),
    'INVALID_REQUEST',
  );
});

test('create and join accept only their strict version-1 envelopes', () => {
  assert.deepEqual(parseCreateRequest(validCreate), validCreate);
  assert.deepEqual(parseJoinRequest(validJoin), validJoin);
  assert.deepEqual(parseJoinRequest({ ...validJoin, requestedRole: 'spectator' }), {
    ...validJoin, requestedRole: 'spectator',
  });

  const cases = [
    ['create unknown field', parseCreateRequest, { ...validCreate, extra: true }, 'INVALID_REQUEST'],
    ['create missing field', parseCreateRequest, { ...validCreate, displayName: undefined }, 'INVALID_REQUEST'],
    ['join unknown field', parseJoinRequest, { ...validJoin, extra: true }, 'INVALID_REQUEST'],
    ['join missing field', parseJoinRequest, { ...validJoin, requestedRole: undefined }, 'INVALID_REQUEST'],
    ['join invalid role', parseJoinRequest, { ...validJoin, requestedRole: 'owner' }, 'INVALID_REQUEST'],
    ['create wrong version', parseCreateRequest, { ...validCreate, v: 2 }, 'PROTOCOL_MISMATCH'],
    ['join wrong version', parseJoinRequest, { ...validJoin, v: 0 }, 'PROTOCOL_MISMATCH'],
    ['array is not an envelope', parseCreateRequest, [], 'INVALID_REQUEST'],
  ];
  for (const [label, parse, value, code] of cases) {
    assert.throws(() => parse(value), (error) => {
      assert.equal(error.code, code, label);
      return true;
    });
  }
});

test('request, command, and rotation IDs use exactly 16-64 URL-safe characters', () => {
  const fields = [
    [parseCreateRequest, validCreate, 'requestId'],
    [parseJoinRequest, validJoin, 'requestId'],
    [parseHelloFrame, validHello, 'id'],
    [parseFoundationCommand, validCommand, 'id'],
  ];
  for (const [parse, base, field] of fields) {
    for (const accepted of ['a'.repeat(16), 'Z'.repeat(64), 'abc_DEF-01234567']) {
      assert.equal(parse({ ...base, [field]: accepted })[field], accepted);
    }
    for (const rejected of ['a'.repeat(15), 'a'.repeat(65), 'not/url-safe-id!', 'contains space___']) {
      expectProtocolError(
        () => parse({ ...base, [field]: rejected }),
        parse === parseCreateRequest || parse === parseJoinRequest ? 'INVALID_REQUEST' : 'INVALID_COMMAND',
      );
    }
  }
});

test('display names contain exactly 1-32 Unicode scalar values', () => {
  for (const displayName of ['x', '界'.repeat(32), '\u{1f600}'.repeat(32)]) {
    assert.equal(parseCreateRequest({ ...validCreate, displayName }).displayName, displayName);
  }
  for (const displayName of ['', 'x'.repeat(33), '\u{1f600}'.repeat(33), '\ud800', `ok\udfff`]) {
    expectProtocolError(() => parseCreateRequest({ ...validCreate, displayName }), 'INVALID_REQUEST');
  }
});

test('reconnect tokens must be canonical unpadded base64url encoding of exactly 32 bytes', () => {
  const urlToken = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index % 2 ? 255 : 251)).toString('base64url');
  assert.match(urlToken, /-/);
  assert.match(urlToken, /_/);
  assert.equal(parseCreateRequest({ ...validCreate, reconnectToken: urlToken }).reconnectToken, urlToken);

  for (const reconnectToken of [
    Buffer.from(randomBytes(31)).toString('base64url'),
    Buffer.from(randomBytes(33)).toString('base64url'),
    `${validCreate.reconnectToken}=`,
    `${validCreate.reconnectToken.slice(0, -1)}+`,
    `${validCreate.reconnectToken.slice(0, -1)}/`,
    'not_base64url',
  ]) {
    expectProtocolError(() => parseCreateRequest({ ...validCreate, reconnectToken }), 'INVALID_REQUEST');
  }
});

test('hello and command frames have strict type-specific version-1 envelopes', () => {
  assert.deepEqual(parseHelloFrame(validHello), validHello);
  assert.deepEqual(parseCommandFrame(validCommand, foundationOptions), validCommand);
  expectProtocolError(() => parseCommandFrame(validCommand), 'INVALID_COMMAND');
  assert.deepEqual(parseCommandFrame({
    ...validCommand, name: 'room.sync', payload: {},
  }), {
    ...validCommand, name: 'room.sync', payload: {},
  });

  const cases = [
    ['hello type', parseHelloFrame, { ...validHello, type: 'command' }, 'INVALID_COMMAND'],
    ['hello unknown', parseHelloFrame, { ...validHello, extra: 1 }, 'INVALID_COMMAND'],
    ['hello next token', parseHelloFrame, { ...validHello, nextReconnectToken: 'x' }, 'AUTH_INVALID'],
    ['hello version', parseHelloFrame, { ...validHello, v: 2 }, 'PROTOCOL_MISMATCH'],
    ['command type', parseFoundationCommand, { ...validCommand, type: 'hello' }, 'INVALID_COMMAND'],
    ['command unknown', parseFoundationCommand, { ...validCommand, extra: 1 }, 'INVALID_COMMAND'],
    ['command name', parseFoundationCommand, { ...validCommand, name: 'foundation.reset' }, 'INVALID_COMMAND'],
    ['command payload unknown', parseFoundationCommand, { ...validCommand, payload: { expectedRevision: 4, extra: 1 } }, 'INVALID_COMMAND'],
    ['command revision negative', parseFoundationCommand, { ...validCommand, payload: { expectedRevision: -1 } }, 'INVALID_COMMAND'],
    ['sync payload nonempty', parseCommandFrame, { ...validCommand, name: 'room.sync', payload: { expectedRevision: 4 } }, 'INVALID_COMMAND'],
    ['command version', parseCommandFrame, { ...validCommand, v: 2 }, 'PROTOCOL_MISMATCH'],
  ];
  for (const [label, parse, value, code] of cases) {
    assert.throws(() => parse(value), (error) => {
      assert.equal(error.code, code, label);
      return true;
    });
  }
});

test('generic command parsing owns only classic envelopes and revisions', () => {
  const commands = [
    ['classic.start', { expectedRevision: 4 }],
    ['classic.bid', { expectedRevision: 4, bid: '1NT', alert: false, explain: null }],
    ['classic.play', { expectedRevision: 4, card: { suit: 'S', rank: 14 } }],
    ['classic.ready-next', { expectedRevision: 4 }],
  ];
  for (const [name, payload] of commands) {
    const frame = { ...validCommand, name, payload };
    assert.deepEqual(parseCommandFrame(frame), frame, name);
  }

  for (const payload of [
    { expectedRevision: 4, extra: true },
    { expectedRevision: 4 },
    { expectedRevision: 4, bid: 'garbage', alert: false, explain: 'not allowed' },
    { expectedRevision: 4, card: { suit: 'X', rank: 'A', extra: true } },
  ]) {
    assert.deepEqual(
      parseCommandFrame({ ...validCommand, name: 'classic.bid', payload }),
      { ...validCommand, name: 'classic.bid', payload },
    );
  }

  for (const frame of [
    { ...validCommand, name: 'classic.start', payload: {} },
    { ...validCommand, name: 'classic.start', payload: { expectedRevision: -1 } },
    { ...validCommand, name: 'classic.start', payload: { expectedRevision: 1.5 } },
    { ...validCommand, name: 'classic.start', payload: [] },
    { ...validCommand, name: 'classic.start', deal: {}, payload: { expectedRevision: 0 } },
    { ...validCommand, name: 'classic.start', seat: 'N', payload: { expectedRevision: 0 } },
  ]) expectProtocolError(() => parseCommandFrame(frame), 'INVALID_COMMAND');
});

test('command payload enforces the exact 8 KiB post-parse boundary', () => {
  const overhead = new TextEncoder().encode(JSON.stringify({ value: '' })).byteLength;
  const fitting = { value: 'x'.repeat(LIMITS.commandPayloadBytes - overhead) };
  const oversized = { value: 'x'.repeat(LIMITS.commandPayloadBytes - overhead + 1) };
  assert.doesNotThrow(() => assertCommandPayloadSize(fitting));
  expectProtocolError(() => assertCommandPayloadSize(oversized), 'INVALID_COMMAND');
});

test('serialized room snapshots enforce the exact 512 KiB boundary', () => {
  assert.doesNotThrow(() => assertRoomSnapshotSize('x'.repeat(LIMITS.roomSnapshotBytes)));
  expectProtocolError(
    () => assertRoomSnapshotSize('x'.repeat(LIMITS.roomSnapshotBytes + 1)),
    'SERVICE_CAPACITY',
  );
});

test('canonical JSON recursively sorts object keys while retaining array order', () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, x: [{ b: true, a: null }] } }),
    '{"a":{"x":[{"a":null,"b":true}],"y":2},"z":1}',
  );
  for (const invalid of [undefined, Number.NaN, Infinity, { value: undefined }, new Date(0)]) {
    assert.throws(() => canonicalJson(invalid), TypeError);
  }
});

test('canonical JSON preserves parsed __proto__ keys without colliding with an empty object', () => {
  const withProtoKey = JSON.parse('{"safe":1,"__proto__":{"polluted":true}}');
  assert.equal(
    canonicalJson(withProtoKey),
    '{"__proto__":{"polluted":true},"safe":1}',
  );
  assert.notEqual(
    createHash('sha256').update(canonicalJson(withProtoKey)).digest('hex'),
    createHash('sha256').update(canonicalJson({ safe: 1 })).digest('hex'),
  );
});

test('canonical JSON serializes integer-like keys in lexical sorted order', () => {
  const integerKeys = JSON.parse('{"2":"two","10":"ten","1":"one","a":"letter"}');
  assert.equal(
    canonicalJson(integerKeys),
    '{"1":"one","10":"ten","2":"two","a":"letter"}',
  );
  const reordered = JSON.parse('{"a":"letter","1":"one","10":"ten","2":"two"}');
  assert.equal(canonicalJson(integerKeys), canonicalJson(reordered));
  assert.notEqual(
    createHash('sha256').update(canonicalJson(integerKeys)).digest('hex'),
    createHash('sha256').update(canonicalJson({ 1: 'one', 2: 'two', 10: 'changed', a: 'letter' })).digest('hex'),
  );
});

test('canonical fingerprints are SHA-256 hashes and reject unknown fields before hashing', async () => {
  const reorderedCreate = {
    reconnectToken,
    displayName: 'North',
    requestId,
    v: 1,
  };
  const expectedCreate = createHash('sha256')
    .update(canonicalJson(validCreate))
    .digest('hex');
  assert.equal(await fingerprintCreateRequest(reorderedCreate), expectedCreate);
  assert.equal(await fingerprintCreateRequest(validCreate), expectedCreate);

  const reorderedJoin = {
    requestedRole: 'player', reconnectToken, displayName: 'East', requestId, v: 1,
  };
  assert.equal(await fingerprintJoinRequest(reorderedJoin), await fingerprintJoinRequest(validJoin));
  assert.equal(await fingerprintCommand({
    payload: { expectedRevision: 4 }, name: 'foundation.increment', id: commandId, type: 'command', v: 1,
  }, foundationOptions), await fingerprintCommand(validCommand, foundationOptions));

  await assert.rejects(
    fingerprintCreateRequest({ ...validCreate, secret: 'must-not-be-ignored' }),
    (error) => error.code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    fingerprintCommand({ ...validCommand, payload: { expectedRevision: 4, hidden: true } }, foundationOptions),
    (error) => error.code === 'INVALID_COMMAND',
  );
});

test('reconnect token hashing returns the canonical SHA-256 digest without retaining token material', async () => {
  assert.equal(
    await hashReconnectToken(reconnectToken),
    createHash('sha256').update(tokenBytes).digest('hex'),
  );
  await assert.rejects(hashReconnectToken('invalid'), (error) => error.code === 'AUTH_INVALID');
});

test('digest comparison handles equal, unequal, and malformed values with a fixed full digest scan', () => {
  const a = '00'.repeat(32);
  const b = `${'00'.repeat(31)}01`;
  assert.equal(constantTimeDigestEqual(a, a), true);
  assert.equal(constantTimeDigestEqual(a, b), false);
  assert.equal(constantTimeDigestEqual(a, `${a}00`), false);
  assert.equal(constantTimeDigestEqual(a, 'not-a-digest'), false);
  assert.equal(constantTimeDigestEqual(new Uint8Array(32), new Uint8Array(32)), true);
  assert.equal(constantTimeDigestEqual(new Uint8Array(32), Uint8Array.of(1)), false);
});

test('public error codes and responses are closed, stable, and do not expose internal details', async () => {
  assert.deepEqual(ERROR_CODES, [
    'PROTOCOL_MISMATCH',
    'INVALID_REQUEST',
    'INVALID_COMMAND',
    'REQUEST_CONFLICT',
    'AUTH_INVALID',
    'ROOM_NOT_FOUND',
    'ROOM_EXPIRED',
    'SESSION_REPLACED',
    'FORBIDDEN',
    'REVISION_CONFLICT',
    'COMMAND_CONFLICT',
    'ROOM_CAPACITY_EXCEEDED',
    'SERVICE_CAPACITY',
    'CLASSIC_WRONG_PHASE',
    'CLASSIC_FORBIDDEN',
    'CLASSIC_SEATS_INCOMPLETE',
    'CLASSIC_NOT_YOUR_TURN',
    'CLASSIC_INVALID_BID',
    'CLASSIC_CARD_NOT_HELD',
    'CLASSIC_MUST_FOLLOW_SUIT',
  ]);
  assert.equal(Object.isFrozen(ERROR_CODES), true);

  for (const [code, expectedStatus] of [
    ['INVALID_REQUEST', 400],
    ['PROTOCOL_MISMATCH', 400],
    ['INVALID_COMMAND', 400],
    ['AUTH_INVALID', 401],
    ['FORBIDDEN', 403],
    ['ROOM_NOT_FOUND', 404],
    ['ROOM_EXPIRED', 410],
    ['REQUEST_CONFLICT', 409],
    ['SESSION_REPLACED', 409],
    ['REVISION_CONFLICT', 409],
    ['COMMAND_CONFLICT', 409],
    ['ROOM_CAPACITY_EXCEEDED', 409],
    ['SERVICE_CAPACITY', 503],
    ['CLASSIC_WRONG_PHASE', 409],
    ['CLASSIC_FORBIDDEN', 403],
    ['CLASSIC_SEATS_INCOMPLETE', 409],
    ['CLASSIC_NOT_YOUR_TURN', 409],
    ['CLASSIC_INVALID_BID', 409],
    ['CLASSIC_CARD_NOT_HELD', 409],
    ['CLASSIC_MUST_FOLLOW_SUIT', 409],
  ]) {
    const response = publicErrorResponse(code, new Error('SQL token_hash secret'));
    assert.ok(response instanceof Response);
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(await response.text(), JSON.stringify({ v: 1, error: { code } }));
  }
  assert.throws(() => publicErrorResponse('INTERNAL_SQL_FAILURE'), TypeError);
  assert.throws(() => publicErrorResponse('CLASSIC_INVALID_DEAL_CONTEXT'), TypeError);
});
