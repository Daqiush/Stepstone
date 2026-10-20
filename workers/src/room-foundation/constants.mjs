export const PROTOCOL_VERSION = 1;

export const LIMITS = Object.freeze({
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

export const ERROR_CODES = Object.freeze([
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

export const ERROR_HTTP_STATUS = Object.freeze({
  PROTOCOL_MISMATCH: 400,
  INVALID_REQUEST: 400,
  INVALID_COMMAND: 400,
  REQUEST_CONFLICT: 409,
  AUTH_INVALID: 401,
  ROOM_NOT_FOUND: 404,
  ROOM_EXPIRED: 410,
  SESSION_REPLACED: 409,
  FORBIDDEN: 403,
  REVISION_CONFLICT: 409,
  COMMAND_CONFLICT: 409,
  ROOM_CAPACITY_EXCEEDED: 409,
  SERVICE_CAPACITY: 503,
  CLASSIC_WRONG_PHASE: 409,
  CLASSIC_FORBIDDEN: 403,
  CLASSIC_SEATS_INCOMPLETE: 409,
  CLASSIC_NOT_YOUR_TURN: 409,
  CLASSIC_INVALID_BID: 409,
  CLASSIC_CARD_NOT_HELD: 409,
  CLASSIC_MUST_FOLLOW_SUIT: 409,
});

export const REGISTRY_STATUSES = Object.freeze([
  'FREE',
  'PROVISIONING',
  'ACTIVE',
  'RELEASE_PENDING',
  'TOMBSTONE',
]);

export const REGISTRY_RELEASE_RESULTS = Object.freeze(['RELEASED', 'SUPERSEDED']);

export const ROLES = Object.freeze(['OWNER', 'PLAYER', 'SPECTATOR']);
export const PLAYER_SEATS = Object.freeze(['N', 'E', 'S', 'W']);

export const WEBSOCKET_CLOSE = Object.freeze({
  PROTOCOL_ERROR: 1002,
  AUTH_INVALID: 4401,
  FORBIDDEN: 4403,
  AUTH_TIMEOUT: 4408,
  SESSION_REPLACED: 4409,
  ROOM_EXPIRED: 4410,
});

export const WEBSOCKET_CLOSE_REASON = Object.freeze({
  PROTOCOL_ERROR: 'protocol error',
  AUTH_INVALID: 'authentication invalid',
  FORBIDDEN: 'forbidden',
  AUTH_TIMEOUT: 'authentication timeout',
  SESSION_REPLACED: 'session replaced',
  ROOM_EXPIRED: 'room expired',
});
