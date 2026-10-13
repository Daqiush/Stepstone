import { LIMITS } from './constants.mjs';

const ID = /^[A-Za-z0-9_-]{16,64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ENTRY_KEYS = Object.freeze([
  'sessionId',
  'commandId',
  'requestHash',
  'committedRevision',
  'compactReply',
  'expiresAt',
]);

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function validEntry(value, sessionId) {
  return exactKeys(value, ENTRY_KEYS)
    && value.sessionId === sessionId
    && ID.test(value.sessionId)
    && ID.test(value.commandId)
    && SHA256.test(value.requestHash)
    && Number.isSafeInteger(value.committedRevision)
    && value.committedRevision >= 0
    && exactKeys(value.compactReply, ['name'])
    && value.compactReply.name === 'foundation.increment'
    && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt >= 0;
}

function validatedCache(value) {
  if (!plainObject(value)) return null;
  const normalized = {};
  for (const [sessionId, entries] of Object.entries(value)) {
    if (!ID.test(sessionId) || !Array.isArray(entries)
      || entries.length > LIMITS.recentCommandsPerPlayer) return null;
    const ids = new Set();
    normalized[sessionId] = [];
    for (const candidate of entries) {
      if (!validEntry(candidate, sessionId) || ids.has(candidate.commandId)) return null;
      ids.add(candidate.commandId);
      normalized[sessionId].push({
        ...candidate,
        compactReply: { ...candidate.compactReply },
      });
    }
  }
  return normalized;
}

export function inspectCommandCache(cache, {
  sessionId, commandId, requestHash, now,
} = {}) {
  if (!ID.test(sessionId ?? '') || !ID.test(commandId ?? '')
    || !SHA256.test(requestHash ?? '') || !Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('invalid command cache lookup');
  }
  const normalized = validatedCache(cache);
  if (normalized === null) return { kind: 'invalid' };
  const existing = normalized[sessionId]?.find((candidate) => (
    candidate.commandId === commandId && candidate.expiresAt > now
  ));
  if (!existing) return { kind: 'miss' };
  if (existing.requestHash !== requestHash) return { kind: 'conflict' };
  return { kind: 'duplicate', entry: existing };
}

export function storeCommandResult(cache, newEntry, now) {
  if (!Number.isSafeInteger(now) || now < 0 || !validEntry(newEntry, newEntry?.sessionId)) {
    throw new TypeError('invalid command cache entry');
  }
  const normalized = validatedCache(cache);
  if (normalized === null) throw new TypeError('malformed persisted command cache');

  const pruned = {};
  for (const [sessionId, entries] of Object.entries(normalized)) {
    const live = entries.filter((candidate) => candidate.expiresAt > now);
    if (live.length > 0) pruned[sessionId] = live;
  }
  const sessionEntries = pruned[newEntry.sessionId] ?? [];
  if (sessionEntries.some((candidate) => candidate.commandId === newEntry.commandId)) {
    throw new TypeError('duplicate live command cache entry');
  }
  pruned[newEntry.sessionId] = [...sessionEntries, {
    ...newEntry,
    compactReply: { ...newEntry.compactReply },
  }].slice(-LIMITS.recentCommandsPerPlayer);
  return pruned;
}
