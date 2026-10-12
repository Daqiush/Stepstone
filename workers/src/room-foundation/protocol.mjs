import {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  LIMITS,
  PROTOCOL_VERSION,
} from './constants.mjs';

const encoder = new TextEncoder();
const idPattern = /^[A-Za-z0-9_-]{16,64}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const errorCodeSet = new Set(ERROR_CODES);

export class ProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function fail(code) {
  throw new ProtocolError(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertVersion(value) {
  if (!isPlainObject(value)) return;
  if (value.v !== PROTOCOL_VERSION) fail('PROTOCOL_MISMATCH');
}

function isValidId(value) {
  return typeof value === 'string' && idPattern.test(value);
}

function isUnicodeScalarString(value, minimum, maximum) {
  if (typeof value !== 'string') return false;
  let count = 0;
  for (const scalar of value) {
    const point = scalar.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) return false;
    count += 1;
    if (count > maximum) return false;
  }
  return count >= minimum;
}

function bytesFromBase64Url(value) {
  if (typeof value !== 'string' || !tokenPattern.test(value)) return null;
  try {
    const binary = atob(`${value.replaceAll('-', '+').replaceAll('_', '/')}=`);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength !== LIMITS.reconnectTokenBytes) return null;
    const canonical = btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/u, '');
    return canonical === value ? bytes : null;
  } catch {
    return null;
  }
}

function assertToken(value, code) {
  if (bytesFromBase64Url(value) === null) fail(code);
}

function byteLength(value) {
  if (typeof value === 'string') return encoder.encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  throw new TypeError('value must be a string, ArrayBuffer, or typed array');
}

function assertByteLimit(value, maximum, code) {
  if (byteLength(value) > maximum) fail(code);
}

export function assertHttpJsonSize(value) {
  assertByteLimit(value, LIMITS.httpJsonBytes, 'INVALID_REQUEST');
}

export function assertWebSocketFrameSize(value) {
  assertByteLimit(value, LIMITS.webSocketFrameBytes, 'INVALID_COMMAND');
}

export function assertCommandPayloadSize(payload) {
  let serialized;
  try {
    serialized = canonicalJson(payload);
  } catch {
    fail('INVALID_COMMAND');
  }
  assertByteLimit(serialized, LIMITS.commandPayloadBytes, 'INVALID_COMMAND');
}

export function assertRoomSnapshotSize(serializedSnapshot) {
  assertByteLimit(serializedSnapshot, LIMITS.roomSnapshotBytes, 'SERVICE_CAPACITY');
}

export function parseCreateRequest(value) {
  assertVersion(value);
  if (!hasExactKeys(value, ['v', 'requestId', 'displayName', 'reconnectToken'])) {
    fail('INVALID_REQUEST');
  }
  if (!isValidId(value.requestId)) fail('INVALID_REQUEST');
  if (!isUnicodeScalarString(
    value.displayName,
    LIMITS.displayNameMinScalars,
    LIMITS.displayNameMaxScalars,
  )) fail('INVALID_REQUEST');
  assertToken(value.reconnectToken, 'INVALID_REQUEST');
  return { ...value };
}

export function parseJoinRequest(value) {
  assertVersion(value);
  if (!hasExactKeys(
    value,
    ['v', 'requestId', 'displayName', 'reconnectToken', 'requestedRole'],
  )) fail('INVALID_REQUEST');
  if (!isValidId(value.requestId)) fail('INVALID_REQUEST');
  if (!isUnicodeScalarString(
    value.displayName,
    LIMITS.displayNameMinScalars,
    LIMITS.displayNameMaxScalars,
  )) fail('INVALID_REQUEST');
  assertToken(value.reconnectToken, 'INVALID_REQUEST');
  if (value.requestedRole !== 'player' && value.requestedRole !== 'spectator') {
    fail('INVALID_REQUEST');
  }
  return { ...value };
}

export function parseHelloFrame(value) {
  assertVersion(value);
  if (!hasExactKeys(
    value,
    ['v', 'type', 'id', 'reconnectToken', 'nextReconnectToken'],
  )) fail('INVALID_COMMAND');
  if (value.type !== 'hello' || !isValidId(value.id)) fail('INVALID_COMMAND');
  assertToken(value.reconnectToken, 'AUTH_INVALID');
  assertToken(value.nextReconnectToken, 'AUTH_INVALID');
  return { ...value };
}

export function parseCommandFrame(value) {
  assertVersion(value);
  if (!hasExactKeys(value, ['v', 'type', 'id', 'name', 'payload'])) fail('INVALID_COMMAND');
  if (value.type !== 'command' || !isValidId(value.id)) fail('INVALID_COMMAND');
  assertCommandPayloadSize(value.payload);

  if (value.name === 'foundation.increment') {
    if (!hasExactKeys(value.payload, ['expectedRevision'])) fail('INVALID_COMMAND');
    if (!Number.isSafeInteger(value.payload.expectedRevision) || value.payload.expectedRevision < 0) {
      fail('INVALID_COMMAND');
    }
  } else if (value.name === 'room.sync') {
    if (!hasExactKeys(value.payload, [])) fail('INVALID_COMMAND');
  } else {
    fail('INVALID_COMMAND');
  }

  return { ...value, payload: { ...value.payload } };
}

export function canonicalJson(value) {
  const ancestors = new Set();

  function serialize(current) {
    if (current === null || typeof current === 'boolean' || typeof current === 'string') {
      return JSON.stringify(current);
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('canonical JSON requires finite numbers');
      return JSON.stringify(current);
    }
    if (Array.isArray(current)) {
      if (ancestors.has(current)) throw new TypeError('canonical JSON cannot contain cycles');
      ancestors.add(current);
      const result = `[${current.map(serialize).join(',')}]`;
      ancestors.delete(current);
      return result;
    }
    if (!isPlainObject(current)) throw new TypeError('canonical JSON requires plain JSON values');
    if (ancestors.has(current)) throw new TypeError('canonical JSON cannot contain cycles');
    ancestors.add(current);
    const members = [];
    for (const key of Object.keys(current).sort()) {
      const item = current[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
        throw new TypeError('canonical JSON requires plain JSON values');
      }
      members.push(`${JSON.stringify(key)}:${serialize(item)}`);
    }
    ancestors.delete(current);
    return `{${members.join(',')}}`;
  }

  return serialize(value);
}

function bytesToHex(bytes) {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function fingerprintParsed(parsed) {
  return bytesToHex(await sha256(encoder.encode(canonicalJson(parsed))));
}

export async function fingerprintCreateRequest(value) {
  return fingerprintParsed(parseCreateRequest(value));
}

export async function fingerprintJoinRequest(value) {
  return fingerprintParsed(parseJoinRequest(value));
}

export async function fingerprintCommand(value) {
  return fingerprintParsed(parseCommandFrame(value));
}

export async function hashReconnectToken(value) {
  const bytes = bytesFromBase64Url(value);
  if (bytes === null) fail('AUTH_INVALID');
  return bytesToHex(await sha256(bytes));
}

function digestBytes(value) {
  if (typeof value === 'string') {
    if (!digestPattern.test(value)) return { bytes: new Uint8Array(32), valid: false };
    const bytes = new Uint8Array(32);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return { bytes, valid: true };
  }
  if (value instanceof ArrayBuffer) value = new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const bytes = new Uint8Array(32);
    bytes.set(source.subarray(0, 32));
    return { bytes, valid: source.byteLength === 32 };
  }
  return { bytes: new Uint8Array(32), valid: false };
}

export function constantTimeDigestEqual(left, right) {
  const a = digestBytes(left);
  const b = digestBytes(right);
  let difference = Number(!a.valid) | Number(!b.valid);
  for (let index = 0; index < 32; index += 1) difference |= a.bytes[index] ^ b.bytes[index];
  return difference === 0;
}

export function publicErrorResponse(code) {
  if (!errorCodeSet.has(code)) throw new TypeError('unknown public error code');
  return new Response(JSON.stringify({ v: PROTOCOL_VERSION, error: { code } }), {
    status: ERROR_HTTP_STATUS[code],
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
