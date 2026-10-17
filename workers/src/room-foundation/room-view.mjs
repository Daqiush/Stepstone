import viewsModule from '../../../classic/views.cjs';

import { LIMITS, PROTOCOL_VERSION } from './constants.mjs';

const { classicEventFor, classicViewFor } = viewsModule;
const SEATS = Object.freeze(['N', 'E', 'S', 'W']);
const IDENTITY = /^[A-Za-z0-9_-]{16,64}$/u;
const ROOM_CODE = /^\d{3}$/u;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

function isValidDisplayName(value, { legacyEmpty = false } = {}) {
  if (typeof value !== 'string') return false;
  let count = 0;
  for (const scalar of value) {
    const point = scalar.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) return false;
    count += 1;
    if (count > LIMITS.displayNameMaxScalars) return false;
  }
  return (legacyEmpty && count === 0) || count >= LIMITS.displayNameMinScalars;
}

function assertViewer(viewer) {
  if (!hasExactKeys(viewer, ['role', 'seat'])
    || !['OWNER', 'PLAYER', 'SPECTATOR'].includes(viewer.role)
    || (viewer.role === 'SPECTATOR' ? viewer.seat !== null : !SEATS.includes(viewer.seat))) {
    throw new TypeError('invalid room snapshot viewer');
  }
}

function assertStoredState(stored) {
  if (!isPlainObject(stored)
    || stored.schemaVersion !== 1
    || typeof stored.roomCode !== 'string'
    || !ROOM_CODE.test(stored.roomCode)
    || !Number.isSafeInteger(stored.incarnation)
    || stored.incarnation < 1
    || !Number.isSafeInteger(stored.revision)
    || stored.revision < 0
    || !['ACTIVE', 'CLOSING'].includes(stored.status)
    || !Number.isSafeInteger(stored.foundationCounter)
    || stored.foundationCounter < 0
    || !Number.isSafeInteger(stored.createdAt)
    || stored.createdAt < 0
    || !(stored.expiresAt === null
      || (Number.isSafeInteger(stored.expiresAt) && stored.expiresAt >= 0))) {
    throw new TypeError('invalid persisted room state');
  }
}

function playerNamesFor(authorities, incarnation) {
  if (!(authorities instanceof Map)) throw new TypeError('invalid room authorities');
  const names = { N: null, E: null, S: null, W: null };
  for (const [sessionId, authority] of authorities) {
    if (typeof sessionId !== 'string'
      || !IDENTITY.test(sessionId)
      || !isPlainObject(authority)
      || authority.sessionId !== sessionId
      || authority.incarnation !== incarnation
      || !['OWNER', 'PLAYER', 'SPECTATOR'].includes(authority.role)
      || !Number.isSafeInteger(authority.connectionEpoch)
      || authority.connectionEpoch < 0
      || !(authority.connectionId === null
        || (typeof authority.connectionId === 'string' && IDENTITY.test(authority.connectionId)))
      || !(authority.expiresAt === null
        || (Number.isSafeInteger(authority.expiresAt) && authority.expiresAt >= 0))
      || !isValidDisplayName(authority.displayName, { legacyEmpty: true })) {
      throw new TypeError('invalid room authority');
    }
    if (authority.role === 'SPECTATOR') {
      if (authority.seat !== null) throw new TypeError('spectator authority cannot occupy a seat');
      continue;
    }
    if (!SEATS.includes(authority.seat)
      || (authority.role === 'OWNER' && authority.seat !== 'N')
      || names[authority.seat] !== null) {
      throw new TypeError('invalid occupied room seat');
    }
    names[authority.seat] = authority.displayName === '' ? null : authority.displayName;
  }
  return names;
}

export function composeRoomSnapshot(stored, authorities, viewer) {
  assertStoredState(stored);
  assertViewer(viewer);
  const names = playerNamesFor(authorities, stored.incarnation);
  const publicViewer = { role: viewer.role, seat: viewer.seat };
  return {
    schemaVersion: stored.schemaVersion,
    roomCode: stored.roomCode,
    incarnation: stored.incarnation,
    revision: stored.revision,
    status: stored.status,
    foundationCounter: stored.foundationCounter,
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
    viewer: publicViewer,
    playerNames: names,
    classic: classicViewFor(stored.classic, publicViewer),
  };
}

export function composeClassicEventFrame(event, revision, viewer) {
  assertViewer(viewer);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError('invalid classic event revision');
  }
  const projected = classicEventFor(event, { role: viewer.role, seat: viewer.seat });
  return {
    v: PROTOCOL_VERSION,
    type: 'event',
    name: projected.name,
    payload: { revision, event: projected.payload },
  };
}

export function isTrustedDisplayName(value) {
  return isValidDisplayName(value);
}
