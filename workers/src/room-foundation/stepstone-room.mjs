import {
  LIMITS,
  PROTOCOL_VERSION,
  WEBSOCKET_CLOSE,
  WEBSOCKET_CLOSE_REASON,
} from './constants.mjs';
import {
  ProtocolError,
  assertRoomSnapshotSize,
  constantTimeDigestEqual,
  fingerprintCommand,
  hashReconnectToken,
  parseCommandFrame,
  parseHelloFrame,
  parseWebSocketJson,
  publicErrorResponse,
} from './protocol.mjs';
import {
  inspectCommandCache,
  isValidCommandCache,
  storeCommandResult,
} from './command-cache.mjs';
import {
  accountedRow,
  accountedRows,
  addSqlAccounting,
  emptySqlAccounting,
  executeAccountedSql,
} from './sql-accounting.mjs';

const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/u;
const REQUEST_HASH = /^[0-9a-f]{64}$/u;
const ROOM_CODE = /^\d{3}$/u;
const PLAYER_SEATS = ['E', 'S', 'W'];
const WEBSOCKET_PATH = /^\/api\/rooms\/(\d{3})\/([1-9][0-9]*)\/ws$/u;
const OWNER_AUTH_ACTION_ID = 'owner-auth-expiry';
const ROOM_EXPIRY_ACTION_ID = 'room-expiry';
const REGISTRY_RELEASE_ACTION_ID = 'registry-release';
const RELEASE_RETRY_BASE_MS = 1_000;

function result(value) {
  return { ok: true, value };
}

function failure(error) {
  return { ok: false, error };
}

function row(cursor) {
  return cursor.toArray()[0] ?? null;
}

function rows(cursor) {
  return cursor.toArray();
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function validCodeIncarnation(code, incarnation) {
  return typeof code === 'string' && ROOM_CODE.test(code)
    && Number.isSafeInteger(incarnation) && incarnation >= 1;
}

function validIdentity(value) {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

function validHash(value) {
  return typeof value === 'string' && REQUEST_HASH.test(value);
}

function validTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

class SocketAuthenticationError extends Error {}
class SocketRoomExpiredError extends Error {}
class SocketSessionReplacedError extends Error {}
class CommandCasError extends Error {}

function normalizeBootstrapResponse(response, expected) {
  const keys = ['v', 'requestId', 'roomCode', 'incarnation', 'sessionId', 'role', 'seat'];
  if (!exactKeys(response, keys)
    || response.v !== 1
    || response.requestId !== expected.requestId
    || response.roomCode !== expected.code
    || response.incarnation !== expected.incarnation
    || !validIdentity(response.sessionId)
    || response.role !== expected.role
    || response.seat !== expected.seat) return null;
  return {
    v: 1,
    requestId: response.requestId,
    roomCode: response.roomCode,
    incarnation: response.incarnation,
    sessionId: response.sessionId,
    role: response.role,
    seat: response.seat,
  };
}

function publicRoomState(stored, _session = null) {
  return {
    schemaVersion: stored.schemaVersion,
    roomCode: stored.roomCode,
    incarnation: stored.incarnation,
    revision: stored.revision,
    status: stored.status,
    foundationCounter: stored.foundationCounter,
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
  };
}

export class StepstoneRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx?.storage?.sql;
    this.commandState = null;
    this.commandStateJson = null;
    this.sessionAuthorities = new Map();
    this.commandCacheReady = false;
    this.lastCommandAccounting = emptySqlAccounting();
    this.cumulativeCommandAccounting = emptySqlAccounting();
    this.lastWakeAccounting = emptySqlAccounting();
    this.deleted = false;
    if (!this.sql) return;
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => {
        this.sql.exec(`CREATE TABLE IF NOT EXISTS room_state (
          incarnation INTEGER PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          status TEXT NOT NULL,
          expires_at INTEGER,
          state_json TEXT NOT NULL
        )`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          token_hash TEXT UNIQUE NOT NULL,
          previous_token_hash TEXT,
          last_rotation_id TEXT,
          last_rotation_next_hash TEXT,
          current_connection_id TEXT,
          bootstrap_request_id TEXT NOT NULL,
          bootstrap_request_hash TEXT NOT NULL,
          bootstrap_response_json TEXT NOT NULL,
          incarnation INTEGER NOT NULL,
          role TEXT NOT NULL,
          seat TEXT,
          connection_epoch INTEGER NOT NULL,
          expires_at INTEGER
        )`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS pending_actions (
          action_id TEXT PRIMARY KEY,
          incarnation INTEGER NOT NULL,
          due_at INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL
        )`);
        this.sql.exec('CREATE INDEX IF NOT EXISTS pending_actions_due_at ON pending_actions(due_at)');
      });
      this.rebuildCommandAuthority();
      await this.reconcileWebSockets(Date.now());
      await this.recoverAlarm();
    });
  }

  cacheSessionAuthority(session) {
    this.sessionAuthorities.set(session.session_id, {
      sessionId: session.session_id,
      incarnation: session.incarnation,
      role: session.role,
      seat: session.seat,
      connectionId: session.current_connection_id,
      connectionEpoch: session.connection_epoch,
      expiresAt: session.expires_at,
    });
  }

  rebuildCommandAuthority() {
    const accounting = emptySqlAccounting();
    try {
      const stored = accountedRow(
        this.sql,
        accounting,
        'SELECT * FROM room_state LIMIT 1',
      );
      if (!stored) {
        this.commandState = null;
        this.commandStateJson = null;
        this.sessionAuthorities = new Map();
        this.commandCacheReady = true;
        this.lastWakeAccounting = accounting;
        return true;
      }
      const state = JSON.parse(stored.state_json);
      const validState = Number.isSafeInteger(state?.schemaVersion)
        && state.schemaVersion === stored.schema_version
        && validCodeIncarnation(state.roomCode, state.incarnation)
        && state.incarnation === stored.incarnation
        && Number.isSafeInteger(state.revision)
        && state.revision >= 0
        && state.revision === stored.revision
        && state.status === stored.status
        && Number.isSafeInteger(state.foundationCounter)
        && state.foundationCounter >= 0
        && validTime(state.createdAt)
        && (state.expiresAt === null || validTime(state.expiresAt))
        && isValidCommandCache(state.recentCommands);
      if (!validState) throw new TypeError('invalid persisted command state');

      const persistedSessions = accountedRows(
        this.sql,
        accounting,
        `SELECT session_id, incarnation, role, seat, current_connection_id,
                connection_epoch, expires_at FROM sessions ORDER BY rowid`,
      );
      const authorities = new Map();
      for (const session of persistedSessions) {
        const validSession = validIdentity(session.session_id)
          && session.incarnation === state.incarnation
          && ['OWNER', 'PLAYER', 'SPECTATOR'].includes(session.role)
          && (session.seat === null || ['N', 'E', 'S', 'W'].includes(session.seat))
          && (session.current_connection_id === null
            || validIdentity(session.current_connection_id))
          && Number.isSafeInteger(session.connection_epoch)
          && session.connection_epoch >= 0
          && (session.expires_at === null || validTime(session.expires_at));
        if (!validSession || authorities.has(session.session_id)) {
          throw new TypeError('invalid persisted session authority');
        }
        authorities.set(session.session_id, {
          sessionId: session.session_id,
          incarnation: session.incarnation,
          role: session.role,
          seat: session.seat,
          connectionId: session.current_connection_id,
          connectionEpoch: session.connection_epoch,
          expiresAt: session.expires_at,
        });
      }
      this.commandState = state;
      this.commandStateJson = stored.state_json;
      this.sessionAuthorities = authorities;
      this.commandCacheReady = true;
      this.lastWakeAccounting = accounting;
      return true;
    } catch {
      this.commandState = null;
      this.commandStateJson = null;
      this.sessionAuthorities = new Map();
      this.commandCacheReady = false;
      this.lastWakeAccounting = accounting;
      return false;
    }
  }

  cachedRoomIdentity() {
    if (!this.commandCacheReady || !this.commandState) return null;
    return {
      stored: {
        incarnation: this.commandState.incarnation,
        revision: this.commandState.revision,
        status: this.commandState.status,
      },
      state: this.commandState,
    };
  }

  socketAttachment(socket) {
    try {
      const attachment = socket.deserializeAttachment();
      return attachment && typeof attachment === 'object' ? attachment : null;
    } catch {
      return null;
    }
  }

  closeSocket(socket, code, reason) {
    try { socket.close(code, reason); }
    catch { /* A concurrently closed socket has no remaining authority. */ }
  }

  roomIdentity() {
    if (this.deleted) return null;
    const stored = row(this.sql.exec('SELECT * FROM room_state LIMIT 1'));
    if (!stored) return null;
    const state = JSON.parse(stored.state_json);
    return { stored, state };
  }

  attachmentHasAuthority(attachment) {
    if (!attachment?.authenticated
      || attachment.protocolVersion !== PROTOCOL_VERSION
      || !validIdentity(attachment.sessionId)
      || !validIdentity(attachment.connectionId)
      || !Number.isSafeInteger(attachment.connectionEpoch)) return false;
    if (!this.commandCacheReady) return false;
    const session = this.sessionAuthorities.get(attachment.sessionId);
    return session?.incarnation === attachment.incarnation
      && session.connectionId === attachment.connectionId
      && session.connectionEpoch === attachment.connectionEpoch
      && (session.expiresAt === null || session.expiresAt > Date.now());
  }

  async reconcileWebSockets(now) {
    const sockets = this.ctx.getWebSockets();
    const completedHandshakeActions = [];
    const attachedAuthorityIds = new Set();
    const identity = this.cachedRoomIdentity();
    const roomInactive = !identity
      || identity.stored.status !== 'ACTIVE'
      || identity.state.status !== 'ACTIVE'
      || identity.stored.incarnation !== identity.state.incarnation;
    for (const socket of sockets) {
      const attachment = this.socketAttachment(socket);
      if (roomInactive || attachment?.incarnation !== identity.stored.incarnation) {
        this.closeSocket(
          socket,
          WEBSOCKET_CLOSE.ROOM_EXPIRED,
          WEBSOCKET_CLOSE_REASON.ROOM_EXPIRED,
        );
        if (validIdentity(attachment?.connectionId)) {
          completedHandshakeActions.push(`handshake-timeout:${attachment.connectionId}`);
        }
        continue;
      }
      if (!attachment || !validIdentity(attachment.connectionId)) {
        this.closeSocket(socket, WEBSOCKET_CLOSE.PROTOCOL_ERROR, WEBSOCKET_CLOSE_REASON.PROTOCOL_ERROR);
        continue;
      }
      if (this.attachmentHasAuthority(attachment)) {
        attachedAuthorityIds.add(attachment.connectionId);
        completedHandshakeActions.push(`handshake-timeout:${attachment.connectionId}`);
        continue;
      }
      const action = row(this.sql.exec(
        `SELECT due_at FROM pending_actions
         WHERE action_id = ? AND kind = 'handshake-timeout' LIMIT 1`,
        `handshake-timeout:${attachment.connectionId}`,
      ));
      if (attachment.authenticated === true && !action) {
        this.closeSocket(
          socket,
          WEBSOCKET_CLOSE.SESSION_REPLACED,
          WEBSOCKET_CLOSE_REASON.SESSION_REPLACED,
        );
        continue;
      }
      const acceptedAt = Number.isSafeInteger(attachment.acceptedAt)
        ? attachment.acceptedAt : Number.MAX_SAFE_INTEGER;
      if ((action && action.due_at <= now)
        || (!action && acceptedAt + LIMITS.helloDeadlineMs <= now)) {
        this.closeSocket(socket, WEBSOCKET_CLOSE.AUTH_TIMEOUT, WEBSOCKET_CLOSE_REASON.AUTH_TIMEOUT);
        completedHandshakeActions.push(`handshake-timeout:${attachment.connectionId}`);
      }
    }
    const orphanedAuthorities = roomInactive ? [] : rows(this.sql.exec(
      `SELECT session_id, current_connection_id FROM sessions
       WHERE incarnation = ? AND current_connection_id IS NOT NULL`,
      identity.stored.incarnation,
    )).filter((session) => !attachedAuthorityIds.has(session.current_connection_id));
    if (completedHandshakeActions.length > 0 || orphanedAuthorities.length > 0) {
      await this.ctx.storage.transaction(async () => {
        for (const actionId of completedHandshakeActions) {
          this.sql.exec('DELETE FROM pending_actions WHERE action_id = ?', actionId);
        }
        for (const session of orphanedAuthorities) {
          this.sql.exec(
            `UPDATE sessions SET current_connection_id = NULL
             WHERE session_id = ? AND incarnation = ? AND current_connection_id = ?`,
            session.session_id,
            identity.stored.incarnation,
            session.current_connection_id,
          );
        }
        if (orphanedAuthorities.length > 0) {
          const connected = row(this.sql.exec(
            `SELECT COUNT(*) AS count FROM sessions
             WHERE incarnation = ? AND current_connection_id IS NOT NULL`,
            identity.stored.incarnation,
          )).count;
          if (connected === 0) {
            const dueAt = now + LIMITS.roomExpiryMs;
            this.persistRoomExpiry(
              identity,
              identity.stored.incarnation,
              dueAt,
              { recoveredOrphanedConnections: orphanedAuthorities.length },
            );
          }
        }
        await this.recomputeAlarm();
      });
      if (orphanedAuthorities.length > 0) this.rebuildCommandAuthority();
    }
  }

  unauthenticatedSocketCount() {
    let count = 0;
    for (const socket of this.ctx.getWebSockets()) {
      if (!this.attachmentHasAuthority(this.socketAttachment(socket))) count += 1;
    }
    return count;
  }

  async fetch(request) {
    const match = new URL(request.url).pathname.match(WEBSOCKET_PATH);
    if (!match || request.method !== 'GET'
      || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response(null, { status: 404 });
    }
    const incarnation = Number(match[2]);
    const identity = this.cachedRoomIdentity();
    if (!identity
      || identity.stored.status !== 'ACTIVE'
      || identity.stored.incarnation !== incarnation
      || identity.state.roomCode !== match[1]
      || identity.state.incarnation !== incarnation) return publicErrorResponse('ROOM_NOT_FOUND');

    if (this.unauthenticatedSocketCount() >= LIMITS.unauthenticatedSockets) {
      return publicErrorResponse('SERVICE_CAPACITY');
    }
    const pendingCount = row(this.sql.exec('SELECT COUNT(*) AS count FROM pending_actions')).count;
    if (pendingCount >= LIMITS.pendingActions) return publicErrorResponse('SERVICE_CAPACITY');

    const connectionId = crypto.randomUUID();
    const acceptedAt = Date.now();
    const dueAt = acceptedAt + LIMITS.helloDeadlineMs;
    const actionId = `handshake-timeout:${connectionId}`;
    await this.ctx.storage.transaction(async () => {
      this.sql.exec(
        `INSERT INTO pending_actions (action_id, incarnation, due_at, kind, payload_json)
         VALUES (?, ?, ?, 'handshake-timeout', ?)`,
        actionId,
        incarnation,
        dueAt,
        JSON.stringify({ connectionId }),
      );
      await this.recomputeAlarm();
    });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    try {
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        sessionId: null,
        incarnation,
        protocolVersion: PROTOCOL_VERSION,
        connectionId,
        connectionEpoch: 0,
        acceptedAt,
        authenticated: false,
      });
    } catch (error) {
      await this.ctx.storage.transaction(async () => {
        this.sql.exec('DELETE FROM pending_actions WHERE action_id = ?', actionId);
        await this.recomputeAlarm();
      });
      throw error;
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  nextDue() {
    return row(this.sql.exec('SELECT MIN(due_at) AS due_at FROM pending_actions'))?.due_at ?? null;
  }

  async recoverAlarm(now = Date.now()) {
    const current = await this.ctx.storage.getAlarm();
    if (current !== null && current <= now) {
      await this.ctx.storage.setAlarm(now);
      return;
    }
    const next = this.nextDue();
    if (next === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const target = Math.max(next, now);
    if (current === null || current > target) {
      await this.ctx.storage.setAlarm(target);
    }
  }

  async recomputeAlarm() {
    const next = this.nextDue();
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
  }

  alarm() {
    return this.consumeDueActions(Date.now());
  }

  registryStub() {
    const id = this.env.LOBBY_REGISTRY.idFromName('singleton');
    return this.env.LOBBY_REGISTRY.get(id);
  }

  hasLiveAuthenticatedSocket() {
    for (const socket of this.ctx.getWebSockets()) {
      if (this.attachmentHasAuthority(this.socketAttachment(socket))) return true;
    }
    return false;
  }

  async deletePendingAction(actionId) {
    await this.ctx.storage.transaction(async () => {
      this.sql.exec('DELETE FROM pending_actions WHERE action_id = ?', actionId);
      await this.recomputeAlarm();
    });
  }

  persistRoomExpiry(identity, incarnation, dueAt, payload) {
    const state = { ...identity.state, expiresAt: dueAt };
    const serialized = JSON.stringify(state);
    assertRoomSnapshotSize(serialized);
    this.sql.exec(
      `UPDATE room_state SET expires_at = ?, state_json = ?
       WHERE incarnation = ? AND status = 'ACTIVE'`,
      dueAt,
      serialized,
      incarnation,
    );
    this.sql.exec(
      `INSERT INTO pending_actions
         (action_id, incarnation, due_at, kind, payload_json)
       VALUES (?, ?, ?, 'room-expiry', ?)
       ON CONFLICT(action_id) DO UPDATE SET
         incarnation = excluded.incarnation,
         due_at = excluded.due_at,
         kind = excluded.kind,
         payload_json = excluded.payload_json`,
      ROOM_EXPIRY_ACTION_ID,
      incarnation,
      dueAt,
      JSON.stringify(payload),
    );
    return { state, serialized };
  }

  async cancelRoomExpiry() {
    let lifecycleState = null;
    await this.ctx.storage.transaction(async () => {
      const identity = this.roomIdentity();
      this.sql.exec('DELETE FROM pending_actions WHERE action_id = ?', ROOM_EXPIRY_ACTION_ID);
      if (identity?.stored.status === 'ACTIVE' && identity.state.expiresAt !== null) {
        const state = { ...identity.state, expiresAt: null };
        const serialized = JSON.stringify(state);
        assertRoomSnapshotSize(serialized);
        this.sql.exec(
          `UPDATE room_state SET expires_at = NULL, state_json = ?
           WHERE incarnation = ? AND status = 'ACTIVE'`,
          serialized,
          identity.stored.incarnation,
        );
        lifecycleState = { state, serialized };
      }
      await this.recomputeAlarm();
    });
    if (lifecycleState !== null) {
      this.commandState = lifecycleState.state;
      this.commandStateJson = lifecycleState.serialized;
    }
  }

  async beginClosing(action, now) {
    let transitioned = false;
    await this.ctx.storage.transaction(async () => {
      const identity = this.roomIdentity();
      if (!identity || identity.stored.incarnation !== action.incarnation) {
        this.sql.exec('DELETE FROM pending_actions WHERE action_id = ?', action.action_id);
        await this.recomputeAlarm();
        return;
      }
      const persistedAction = row(this.sql.exec(
        'SELECT * FROM pending_actions WHERE action_id = ? AND incarnation = ?',
        action.action_id,
        action.incarnation,
      ));
      if (!persistedAction || persistedAction.due_at > now) {
        await this.recomputeAlarm();
        return;
      }
      if (identity.stored.status !== 'ACTIVE' || identity.state.status !== 'ACTIVE') {
        this.sql.exec('DELETE FROM pending_actions WHERE action_id = ?', action.action_id);
        await this.recomputeAlarm();
        return;
      }

      const state = { ...identity.state, status: 'CLOSING', expiresAt: now };
      const serialized = JSON.stringify(state);
      assertRoomSnapshotSize(serialized);
      this.sql.exec(
        `UPDATE room_state SET status = 'CLOSING', expires_at = ?, state_json = ?
         WHERE incarnation = ? AND status = 'ACTIVE'`,
        now,
        serialized,
        action.incarnation,
      );
      this.sql.exec(
        `UPDATE sessions SET current_connection_id = NULL,
           connection_epoch = connection_epoch + 1
         WHERE incarnation = ? AND current_connection_id IS NOT NULL`,
        action.incarnation,
      );
      this.sql.exec('DELETE FROM pending_actions');
      this.sql.exec(
        `INSERT INTO pending_actions (action_id, incarnation, due_at, kind, payload_json)
         VALUES (?, ?, ?, 'registry-release', ?)`,
        REGISTRY_RELEASE_ACTION_ID,
        action.incarnation,
        now,
        JSON.stringify({ attempt: 0, phase: 'MARK' }),
      );
      await this.ctx.storage.setAlarm(Math.max(now, Date.now()));
      transitioned = true;
    });
    if (!transitioned) return false;

    this.rebuildCommandAuthority();
    for (const socket of this.ctx.getWebSockets()) {
      this.closeSocket(socket, WEBSOCKET_CLOSE.ROOM_EXPIRED, WEBSOCKET_CLOSE_REASON.ROOM_EXPIRED);
    }
    return true;
  }

  releaseRetryDelay(attempt) {
    const exponent = Math.min(Math.max(attempt - 1, 0), 52);
    return Math.min(
      RELEASE_RETRY_BASE_MS * (2 ** exponent),
      LIMITS.registryReleaseBackoffMaxMs,
    );
  }

  async scheduleReleaseRetry(action, payload, now) {
    const attempt = payload.attempt + 1;
    const dueAt = now + this.releaseRetryDelay(attempt);
    await this.ctx.storage.transaction(async () => {
      this.sql.exec(
        `UPDATE pending_actions SET due_at = ?, payload_json = ?
         WHERE action_id = ? AND incarnation = ? AND kind = 'registry-release'`,
        dueAt,
        JSON.stringify({ attempt, phase: payload.phase }),
        action.action_id,
        action.incarnation,
      );
      await this.recomputeAlarm();
    });
  }

  async processRegistryRelease(now) {
    const action = row(this.sql.exec(
      `SELECT * FROM pending_actions
       WHERE action_id = ? AND kind = 'registry-release' LIMIT 1`,
      REGISTRY_RELEASE_ACTION_ID,
    ));
    if (!action || action.due_at > now) return false;
    const identity = this.roomIdentity();
    if (!identity
      || identity.stored.incarnation !== action.incarnation
      || identity.stored.status !== 'CLOSING'
      || identity.state.status !== 'CLOSING') {
      await this.deletePendingAction(action.action_id);
      return false;
    }

    let payload;
    try { payload = JSON.parse(action.payload_json); }
    catch { payload = null; }
    if (!exactKeys(payload, ['attempt', 'phase'])
      || !Number.isSafeInteger(payload.attempt)
      || payload.attempt < 0
      || !['MARK', 'RELEASE'].includes(payload.phase)) {
      payload = { attempt: 0, phase: 'MARK' };
    }

    try {
      const registry = this.registryStub();
      if (payload.phase === 'MARK') {
        const marked = await registry.markReleasePending({
          code: identity.state.roomCode,
          incarnation: identity.state.incarnation,
        });
        if (!marked?.ok || marked.value?.status !== 'RELEASE_PENDING') {
          throw new Error('registry mark release rejected');
        }
        payload = { ...payload, phase: 'RELEASE' };
        await this.ctx.storage.transaction(async () => {
          this.sql.exec(
            `UPDATE pending_actions SET payload_json = ?
             WHERE action_id = ? AND incarnation = ? AND kind = 'registry-release'`,
            JSON.stringify(payload),
            action.action_id,
            action.incarnation,
          );
          await this.ctx.storage.setAlarm(Math.max(now, Date.now()));
        });
      }

      const released = await registry.release({
        code: identity.state.roomCode,
        incarnation: identity.state.incarnation,
      });
      if (!released?.ok || !['RELEASED', 'SUPERSEDED'].includes(released.value?.result)) {
        throw new Error('registry release rejected');
      }
      await this.ctx.storage.deleteAll();
      this.deleted = true;
      this.commandState = null;
      this.commandStateJson = null;
      this.sessionAuthorities = new Map();
      this.commandCacheReady = true;
      return true;
    } catch {
      await this.scheduleReleaseRetry(action, payload, now);
      return false;
    }
  }

  async reconcileClosingRelease({ code, incarnation, now } = {}) {
    if (!validCodeIncarnation(code, incarnation) || !validTime(now)) {
      return failure('INVALID_REQUEST');
    }
    const identity = this.roomIdentity();
    if (!identity
      || identity.state.roomCode !== code
      || identity.stored.incarnation !== incarnation
      || identity.state.incarnation !== incarnation
      || identity.stored.status !== 'CLOSING'
      || identity.state.status !== 'CLOSING') return result({ reconciled: false });

    await this.ctx.storage.transaction(async () => {
      const existing = row(this.sql.exec(
        `SELECT due_at FROM pending_actions
         WHERE action_id = ? AND incarnation = ? AND kind = 'registry-release'`,
        REGISTRY_RELEASE_ACTION_ID,
        incarnation,
      ));
      if (existing) {
        this.sql.exec(
          `UPDATE pending_actions SET due_at = MIN(due_at, ?)
           WHERE action_id = ? AND incarnation = ? AND kind = 'registry-release'`,
          now,
          REGISTRY_RELEASE_ACTION_ID,
          incarnation,
        );
      } else {
        this.sql.exec(
          `INSERT INTO pending_actions (action_id, incarnation, due_at, kind, payload_json)
           VALUES (?, ?, ?, 'registry-release', ?)`,
          REGISTRY_RELEASE_ACTION_ID,
          incarnation,
          now,
          JSON.stringify({ attempt: 0, phase: 'RELEASE' }),
        );
      }
      await this.recomputeAlarm();
    });
    return result({ reconciled: await this.processRegistryRelease(now) });
  }

  async consumeDueActions(now) {
    if (this.deleted) return result({ consumed: true });
    const due = rows(this.sql.exec(
      'SELECT * FROM pending_actions WHERE due_at <= ? ORDER BY due_at, action_id', now,
    ));
    const timedOutConnections = new Set();
    const dueHandshakeActionIds = [];
    for (const action of due) {
      if (action.kind === 'handshake-timeout') {
        dueHandshakeActionIds.push(action.action_id);
        try { timedOutConnections.add(JSON.parse(action.payload_json).connectionId); }
        catch { /* The action is still completed and removed below. */ }
      }
    }
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(socket);
      if (timedOutConnections.has(attachment?.connectionId)) {
        this.closeSocket(socket, WEBSOCKET_CLOSE.AUTH_TIMEOUT, WEBSOCKET_CLOSE_REASON.AUTH_TIMEOUT);
      }
    }
    if (dueHandshakeActionIds.length > 0) {
      await this.ctx.storage.transaction(async () => {
        for (const actionId of dueHandshakeActionIds) {
          this.sql.exec(
            `DELETE FROM pending_actions
             WHERE action_id = ? AND kind = 'handshake-timeout'`,
            actionId,
          );
        }
        await this.recomputeAlarm();
      });
    }

    for (const action of due) {
      if (this.deleted || action.kind === 'handshake-timeout') continue;
      if (action.kind === 'owner-auth-expiry') {
        if (await this.beginClosing(action, now)) await this.processRegistryRelease(now);
      } else if (action.kind === 'room-expiry') {
        if (this.hasLiveAuthenticatedSocket()) await this.cancelRoomExpiry();
        else if (await this.beginClosing(action, now)) await this.processRegistryRelease(now);
      } else if (action.kind === 'registry-release') {
        await this.processRegistryRelease(now);
      } else {
        await this.deletePendingAction(action.action_id);
      }
    }
    return result({ consumed: true });
  }

  async initialize(input = {}) {
    return this.initializeWithSession(input, crypto.randomUUID(), Date.now());
  }

  async initializeWithSession(input = {}, proposedSessionId, now) {
    const {
      code, incarnation, leaseId, leaseExpiresAt, requestId, requestHash, tokenHash,
    } = input;
    if (!validCodeIncarnation(code, incarnation)
      || !validIdentity(leaseId)
      || !validTime(leaseExpiresAt)
      || !validIdentity(requestId)
      || !validHash(requestHash)
      || !validHash(tokenHash)
      || !validIdentity(proposedSessionId)
      || !validTime(now)) return failure('INVALID_REQUEST');

    const fault = this.env?.ROOM_FOUNDATION_TEST === 'true'
      ? await this.ctx.storage.get('roomInitializationFault') : null;
    if (fault?.type === 'throw'
      && fault.code === code
      && fault.incarnation === incarnation
      && fault.leaseId === leaseId) throw new Error('injected room initialization failure');
    if (fault?.type === 'delay'
      && fault.code === code
      && fault.incarnation === incarnation
      && fault.leaseId === leaseId) {
      await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
      now = Date.now();
    }

    const existing = row(this.sql.exec('SELECT * FROM room_state LIMIT 1'));
    if (existing) {
      const state = JSON.parse(existing.state_json);
      const owner = row(this.sql.exec("SELECT * FROM sessions WHERE role = 'OWNER' LIMIT 1"));
      const exact = existing.incarnation === incarnation
        && state.roomCode === code
        && state.initialization?.leaseId === leaseId
        && state.initialization?.leaseExpiresAt === leaseExpiresAt
        && state.initialization?.requestId === requestId
        && state.initialization?.requestHash === requestHash
        && owner?.bootstrap_request_id === requestId
        && owner?.bootstrap_request_hash === requestHash
        && constantTimeDigestEqual(owner?.token_hash, tokenHash);
      if (!exact) return failure('REQUEST_CONFLICT');
      return result({ response: JSON.parse(owner.bootstrap_response_json), replayed: true });
    }

    if (now >= leaseExpiresAt) return failure('LEASE_EXPIRED');
    const sessionId = proposedSessionId;
    const response = normalizeBootstrapResponse({
      v: 1, requestId, roomCode: code, incarnation, sessionId, role: 'OWNER', seat: 'N',
    }, { code, incarnation, requestId, role: 'OWNER', seat: 'N' });
    const dueAt = now + LIMITS.ownerAuthExpiryMs;
    const actionId = OWNER_AUTH_ACTION_ID;
    const state = {
      schemaVersion: 1,
      roomCode: code,
      incarnation,
      revision: 0,
      status: 'ACTIVE',
      foundationCounter: 0,
      createdAt: now,
      expiresAt: null,
      recentCommands: {},
      initialization: {
        leaseId, leaseExpiresAt, requestId, requestHash,
      },
    };
    const serializedState = JSON.stringify(state);

    await this.ctx.storage.transaction(async () => {
      this.sql.exec(
        `INSERT INTO room_state
          (incarnation, schema_version, revision, status, expires_at, state_json)
         VALUES (?, 1, 0, 'ACTIVE', NULL, ?)`,
        incarnation, serializedState,
      );
      this.sql.exec(
        `INSERT INTO sessions
          (session_id, token_hash, previous_token_hash, last_rotation_id,
           last_rotation_next_hash, current_connection_id, bootstrap_request_id,
           bootstrap_request_hash, bootstrap_response_json, incarnation, role,
           seat, connection_epoch, expires_at)
         VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, 'OWNER', 'N', 0, NULL)`,
        sessionId, tokenHash, requestId, requestHash, JSON.stringify(response), incarnation,
      );
      this.sql.exec(
        `INSERT INTO pending_actions (action_id, incarnation, due_at, kind, payload_json)
         VALUES (?, ?, ?, 'owner-auth-expiry', ?)`,
        actionId, incarnation, dueAt, JSON.stringify({ sessionId }),
      );
      await this.ctx.storage.setAlarm(dueAt);
    });
    this.commandState = state;
    this.commandStateJson = serializedState;
    this.commandCacheReady = true;
    this.cacheSessionAuthority({
      session_id: sessionId,
      incarnation,
      role: 'OWNER',
      seat: 'N',
      current_connection_id: null,
      connection_epoch: 0,
      expires_at: null,
    });
    return result({ response, replayed: false });
  }

  join(input = {}) {
    const {
      code, incarnation, requestId, requestHash, tokenHash, requestedRole,
    } = input;
    if (!validCodeIncarnation(code, incarnation)
      || !validIdentity(requestId)
      || !validHash(requestHash)
      || !validHash(tokenHash)
      || (requestedRole !== 'player' && requestedRole !== 'spectator')) {
      return failure('INVALID_REQUEST');
    }
    if (this.deleted || !this.commandState) return failure('ROOM_NOT_FOUND');

    let createdAuthority = null;
    const joined = this.ctx.storage.transactionSync(() => {
      const storedState = row(this.sql.exec('SELECT * FROM room_state LIMIT 1'));
      if (!storedState || storedState.incarnation !== incarnation) return failure('ROOM_NOT_FOUND');
      const state = JSON.parse(storedState.state_json);
      if (state.roomCode !== code) return failure('ROOM_NOT_FOUND');
      if (storedState.status !== 'ACTIVE') return failure('ROOM_EXPIRED');

      const replay = row(this.sql.exec(
        'SELECT * FROM sessions WHERE bootstrap_request_id = ? LIMIT 1', requestId,
      ));
      if (replay) {
        if (replay.bootstrap_request_hash !== requestHash) {
          return failure('REQUEST_CONFLICT');
        }
        return result({ response: JSON.parse(replay.bootstrap_response_json), replayed: true });
      }

      const duplicateToken = row(this.sql.exec(
        `SELECT session_id FROM sessions
         WHERE token_hash = ? OR previous_token_hash = ? LIMIT 1`,
        tokenHash,
        tokenHash,
      ));
      if (duplicateToken) return failure('REQUEST_CONFLICT');

      const counts = row(this.sql.exec(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN role IN ('OWNER', 'PLAYER') THEN 1 ELSE 0 END) AS players,
        SUM(CASE WHEN role = 'SPECTATOR' THEN 1 ELSE 0 END) AS spectators
        FROM sessions`));
      if (counts.total >= LIMITS.totalSessions) return failure('ROOM_CAPACITY_EXCEEDED');

      let role;
      let seat;
      if (requestedRole === 'player') {
        if (counts.players >= LIMITS.playerSessions) return failure('ROOM_CAPACITY_EXCEEDED');
        const occupied = new Set(rows(this.sql.exec(
          "SELECT seat FROM sessions WHERE role IN ('OWNER', 'PLAYER')",
        )).map((item) => item.seat));
        seat = PLAYER_SEATS.find((candidate) => !occupied.has(candidate));
        if (!seat) return failure('ROOM_CAPACITY_EXCEEDED');
        role = 'PLAYER';
      } else {
        if (counts.spectators >= LIMITS.spectatorSessions) {
          return failure('ROOM_CAPACITY_EXCEEDED');
        }
        role = 'SPECTATOR';
        seat = null;
      }

      const sessionId = crypto.randomUUID();
      const response = normalizeBootstrapResponse({
        v: 1, requestId, roomCode: code, incarnation, sessionId, role, seat,
      }, { code, incarnation, requestId, role, seat });
      this.sql.exec(
        `INSERT INTO sessions
          (session_id, token_hash, previous_token_hash, last_rotation_id,
           last_rotation_next_hash, current_connection_id, bootstrap_request_id,
           bootstrap_request_hash, bootstrap_response_json, incarnation, role,
           seat, connection_epoch, expires_at)
         VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, 0, NULL)`,
        sessionId, tokenHash, requestId, requestHash, JSON.stringify(response),
        incarnation, role, seat,
      );
      createdAuthority = {
        session_id: sessionId,
        incarnation,
        role,
        seat,
        current_connection_id: null,
        connection_epoch: 0,
        expires_at: null,
      };
      return result({ response, replayed: false });
    });
    if (createdAuthority !== null) this.cacheSessionAuthority(createdAuthority);
    return joined;
  }

  async takeAuthFault(code, incarnation) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return null;
    const fault = await this.ctx.storage.get('roomAuthFault');
    if (!fault || fault.code !== code || fault.incarnation !== incarnation) return null;
    await this.ctx.storage.delete('roomAuthFault');
    return fault;
  }

  closeForProtocol(socket, error) {
    const authenticationInvalid = error instanceof ProtocolError && error.code === 'AUTH_INVALID';
    this.closeSocket(
      socket,
      authenticationInvalid ? WEBSOCKET_CLOSE.AUTH_INVALID : WEBSOCKET_CLOSE.PROTOCOL_ERROR,
      authenticationInvalid
        ? WEBSOCKET_CLOSE_REASON.AUTH_INVALID : WEBSOCKET_CLOSE_REASON.PROTOCOL_ERROR,
    );
  }

  activeAuthority(attachment) {
    const identity = this.cachedRoomIdentity();
    if (!identity
      || identity.stored.status !== 'ACTIVE'
      || identity.state.status !== 'ACTIVE'
      || identity.stored.incarnation !== attachment?.incarnation) {
      return { ok: false, expired: true };
    }
    if (!this.attachmentHasAuthority(attachment)) return { ok: false, expired: false };
    return { ok: true, identity };
  }

  persistedRevision() {
    return Number.isSafeInteger(this.commandState?.revision) ? this.commandState.revision : 0;
  }

  sendSocketFrame(socket, frame) {
    try { socket.send(JSON.stringify(frame)); }
    catch { /* A concurrently closed socket cannot receive delivery. */ }
  }

  commandError(socket, commandId, code, revision, snapshot = null) {
    this.sendSocketFrame(socket, {
      v: PROTOCOL_VERSION,
      type: 'error',
      id: commandId,
      payload: {
        code,
        revision,
        ...(snapshot === null ? {} : { snapshot }),
      },
    });
  }

  authoritativeSession(attachment) {
    if (!attachment?.authenticated
      || attachment.protocolVersion !== PROTOCOL_VERSION
      || !validIdentity(attachment.sessionId)
      || !validIdentity(attachment.connectionId)
      || !Number.isSafeInteger(attachment.connectionEpoch)) return null;
    const session = this.sessionAuthorities.get(attachment.sessionId);
    if (session?.incarnation !== attachment.incarnation
      || session.connectionId !== attachment.connectionId
      || session.connectionEpoch !== attachment.connectionEpoch
      || (session.expiresAt !== null && session.expiresAt <= Date.now())) return null;
    return session;
  }

  broadcastRoomSnapshot(committedState) {
    for (const candidate of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(candidate);
      const session = this.authoritativeSession(attachment);
      if (!session
        || !this.commandCacheReady
        || this.commandState?.status !== 'ACTIVE'
        || this.commandState.incarnation !== committedState.incarnation
        || this.commandState.revision !== committedState.revision) continue;
      const snapshot = publicRoomState(committedState, session);
      this.sendSocketFrame(candidate, {
        v: PROTOCOL_VERSION,
        type: 'event',
        name: 'room.snapshot',
        payload: { revision: committedState.revision, snapshot },
      });
    }
  }

  async takeCommandFault(code, incarnation, sessionId, commandId) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return null;
    const fault = await this.ctx.storage.get('roomCommandFault');
    if (!fault
      || fault.code !== code
      || fault.incarnation !== incarnation
      || fault.sessionId !== sessionId
      || fault.commandId !== commandId) return null;
    await this.ctx.storage.delete('roomCommandFault');
    return fault;
  }

  async handleCommand(socket, attachment, frame) {
    let command;
    let requestHash;
    try {
      command = parseCommandFrame(frame);
      requestHash = await fingerprintCommand(command);
    } catch (error) {
      this.closeForProtocol(socket, error);
      return;
    }

    let fault = null;
    try {
      if (this.env?.ROOM_FOUNDATION_TEST === 'true' && this.commandState !== null) {
        fault = await this.takeCommandFault(
          this.commandState.roomCode,
          this.commandState.incarnation,
          attachment.sessionId,
          command.id,
        );
      }
    } catch {
      this.commandError(socket, command.id, 'SERVICE_CAPACITY', this.persistedRevision());
      return;
    }
    if (fault?.type === 'delay-before-transaction') {
      await this.ctx.storage.put('roomCommandHook', {
        code: this.commandState?.roomCode,
        incarnation: this.commandState?.incarnation,
        commandId: command.id,
        reached: true,
      });
      await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    }
    if (fault?.type === 'corrupt-state-before-cas'
      || fault?.type === 'mutate-state-before-cas') {
      try {
        this.ctx.storage.transactionSync(() => {
          const stored = row(this.sql.exec('SELECT * FROM room_state LIMIT 1'));
          if (!stored) throw new CommandCasError();
          const persisted = JSON.parse(stored.state_json);
          if (fault.type === 'corrupt-state-before-cas') {
            persisted.recentCommands = { malformed: true };
          } else {
            persisted.foundationCounter = 7;
          }
          this.sql.exec(
            'UPDATE room_state SET state_json = ? WHERE incarnation = ?',
            JSON.stringify(persisted),
            persisted.incarnation,
          );
        });
      } catch {
        this.rebuildCommandAuthority();
        this.commandError(socket, command.id, 'SERVICE_CAPACITY', this.persistedRevision());
        return;
      }
    }

    const accounting = emptySqlAccounting();
    let outcome;
    try {
      outcome = this.ctx.storage.transactionSync(() => {
        const state = this.commandState;
        const expectedStateJson = this.commandStateJson;
        if (!this.commandCacheReady
          || !state
          || typeof expectedStateJson !== 'string'
          || state.status !== 'ACTIVE'
          || state.incarnation !== attachment.incarnation) throw new SocketRoomExpiredError();
        const session = this.authoritativeSession(attachment);
        if (!session) throw new SocketSessionReplacedError();

        if (command.name === 'room.sync') {
          return { kind: 'sync', state, session };
        }
        if (session.role !== 'OWNER' && session.role !== 'PLAYER') {
          return { kind: 'forbidden', state, session };
        }

        const cached = inspectCommandCache(state.recentCommands, {
          sessionId: session.sessionId,
          commandId: command.id,
          requestHash,
          now: Date.now(),
        });
        if (cached.kind === 'invalid') throw new TypeError('malformed persisted command cache');
        if (cached.kind === 'conflict') return { kind: 'conflict', state, session };
        if (cached.kind === 'duplicate') {
          return {
            kind: 'duplicate',
            state,
            session,
            committedRevision: cached.entry.committedRevision,
            compactReply: cached.entry.compactReply,
          };
        }
        if (command.payload.expectedRevision !== state.revision) {
          return { kind: 'revision-conflict', state, session };
        }

        const now = Date.now();
        const committedRevision = state.revision + 1;
        const compactReply = { name: command.name };
        const proposed = {
          ...state,
          revision: committedRevision,
          foundationCounter: state.foundationCounter + 1,
          recentCommands: storeCommandResult(state.recentCommands, {
            sessionId: session.sessionId,
            commandId: command.id,
            requestHash,
            committedRevision,
            compactReply,
            expiresAt: now + LIMITS.recentCommandTtlMs,
          }, now),
        };
        const serialized = JSON.stringify(proposed);
        assertRoomSnapshotSize(serialized);
        const updateStatement =
          `UPDATE room_state SET revision = ?, status = ?, expires_at = ?, state_json = ?
           WHERE incarnation = ? AND revision = ? AND status = 'ACTIVE' AND state_json = ?`;
        const updated = executeAccountedSql(
          this.sql,
          accounting,
          updateStatement,
          proposed.revision,
          proposed.status,
          proposed.expiresAt,
          serialized,
          proposed.incarnation,
          state.revision,
          expectedStateJson,
        );
        if (updated.rowsWritten !== 1) throw new CommandCasError();
        if (fault?.type === 'before-commit') throw new Error('injected command precommit failure');
        return {
          kind: 'mutation', state: proposed, stateJson: serialized,
          session, committedRevision, compactReply,
        };
      });
    } catch (error) {
      if (error instanceof SocketRoomExpiredError) {
        this.closeSocket(socket, WEBSOCKET_CLOSE.ROOM_EXPIRED, WEBSOCKET_CLOSE_REASON.ROOM_EXPIRED);
        return;
      }
      if (error instanceof SocketSessionReplacedError) {
        this.closeSocket(
          socket,
          WEBSOCKET_CLOSE.SESSION_REPLACED,
          WEBSOCKET_CLOSE_REASON.SESSION_REPLACED,
        );
        return;
      }
      this.rebuildCommandAuthority();
      this.lastCommandAccounting = emptySqlAccounting();
      this.commandError(socket, command.id, 'SERVICE_CAPACITY', this.persistedRevision());
      return;
    }

    this.lastCommandAccounting = accounting;
    if (outcome.kind === 'sync') {
      const snapshot = publicRoomState(outcome.state, outcome.session);
      this.sendSocketFrame(socket, {
        v: PROTOCOL_VERSION,
        type: 'reply',
        id: command.id,
        name: command.name,
        payload: { revision: outcome.state.revision, snapshot },
      });
      return;
    }
    if (outcome.kind === 'forbidden') {
      this.commandError(socket, command.id, 'FORBIDDEN', outcome.state.revision);
      return;
    }
    if (outcome.kind === 'conflict') {
      this.commandError(socket, command.id, 'COMMAND_CONFLICT', outcome.state.revision);
      return;
    }
    if (outcome.kind === 'revision-conflict') {
      this.commandError(
        socket,
        command.id,
        'REVISION_CONFLICT',
        outcome.state.revision,
        publicRoomState(outcome.state, outcome.session),
      );
      return;
    }

    if (outcome.kind === 'mutation') {
      this.commandState = outcome.state;
      this.commandStateJson = outcome.stateJson;
      addSqlAccounting(this.cumulativeCommandAccounting, accounting);
    }
    if (outcome.kind === 'mutation' && fault?.type === 'after-commit-before-delivery') return;

    const current = outcome.state;
    if (!current
      || current.status !== 'ACTIVE'
      || current.incarnation !== attachment.incarnation) {
      this.closeSocket(socket, WEBSOCKET_CLOSE.ROOM_EXPIRED, WEBSOCKET_CLOSE_REASON.ROOM_EXPIRED);
      return;
    }
    const snapshot = publicRoomState(current, outcome.session);
    this.sendSocketFrame(socket, {
      v: PROTOCOL_VERSION,
      type: 'reply',
      id: command.id,
      name: outcome.compactReply.name,
      payload: { revision: outcome.committedRevision, snapshot },
    });
    this.broadcastRoomSnapshot(current);
  }

  closeReplacedSockets(sessionId, connectionId) {
    for (const candidate of this.ctx.getWebSockets()) {
      const attachment = this.socketAttachment(candidate);
      if (attachment?.sessionId === sessionId && attachment.connectionId !== connectionId) {
        this.closeSocket(
          candidate,
          WEBSOCKET_CLOSE.SESSION_REPLACED,
          WEBSOCKET_CLOSE_REASON.SESSION_REPLACED,
        );
      }
    }
  }

  async authenticateSocket(socket, attachment, frame, identity) {
    let parsed;
    try { parsed = parseHelloFrame(frame); }
    catch (error) {
      this.closeForProtocol(socket, error);
      return;
    }

    let currentDigest;
    let nextDigest;
    try {
      [currentDigest, nextDigest] = await Promise.all([
        hashReconnectToken(parsed.reconnectToken),
        hashReconnectToken(parsed.nextReconnectToken),
      ]);
    } catch (error) {
      this.closeForProtocol(socket, error);
      return;
    }

    const fault = await this.takeAuthFault(identity.state.roomCode, identity.stored.incarnation);
    if (fault?.type === 'delay-before-transaction') {
      await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    }
    let authenticated;
    let lifecycleState = null;
    try {
      await this.ctx.storage.transaction(async () => {
        const freshIdentity = this.roomIdentity();
        if (!freshIdentity
          || freshIdentity.stored.status !== 'ACTIVE'
          || freshIdentity.state.status !== 'ACTIVE'
          || freshIdentity.stored.incarnation !== attachment.incarnation
          || freshIdentity.state.incarnation !== attachment.incarnation) {
          throw new SocketRoomExpiredError();
        }

        const currentMatches = rows(this.sql.exec(
          'SELECT * FROM sessions WHERE incarnation = ? AND token_hash = ?',
          attachment.incarnation,
          currentDigest,
        ));
        const previousMatches = rows(this.sql.exec(
          'SELECT * FROM sessions WHERE incarnation = ? AND previous_token_hash = ?',
          attachment.incarnation,
          currentDigest,
        ));
        const currentCredential = currentMatches.length === 1 && previousMatches.length === 0;
        const replay = currentMatches.length === 0 && previousMatches.length === 1;
        if (!currentCredential && !replay) throw new SocketAuthenticationError();
        const session = currentCredential ? currentMatches[0] : previousMatches[0];
        if (session.expires_at !== null && session.expires_at <= Date.now()) {
          throw new SocketAuthenticationError();
        }
        if (replay && (session.last_rotation_id !== parsed.id
          || !constantTimeDigestEqual(session.last_rotation_next_hash, nextDigest)
          || !constantTimeDigestEqual(session.token_hash, nextDigest))) {
          throw new SocketAuthenticationError();
        }

        const nextReservations = rows(this.sql.exec(
          `SELECT session_id, token_hash, previous_token_hash FROM sessions
           WHERE incarnation = ? AND (token_hash = ? OR previous_token_hash = ?)`,
          attachment.incarnation,
          nextDigest,
          nextDigest,
        ));
        if (replay) {
          const exactReservation = nextReservations.length === 1
            && nextReservations[0].session_id === session.session_id
            && constantTimeDigestEqual(nextReservations[0].token_hash, nextDigest)
            && !constantTimeDigestEqual(nextReservations[0].previous_token_hash, nextDigest);
          if (!exactReservation) throw new SocketAuthenticationError();
        } else if (nextReservations.length !== 0) {
          throw new SocketAuthenticationError();
        }

        const sameConnection = replay
          && session.current_connection_id === attachment.connectionId;
        const proposedEpoch = sameConnection
          ? session.connection_epoch : session.connection_epoch + 1;
        const proposedAttachment = {
          sessionId: session.session_id,
          incarnation: attachment.incarnation,
          protocolVersion: PROTOCOL_VERSION,
          connectionId: attachment.connectionId,
          connectionEpoch: proposedEpoch,
          authenticated: true,
        };
        socket.serializeAttachment(proposedAttachment);

        if (!replay) {
          this.sql.exec(
            `UPDATE sessions SET
               previous_token_hash = token_hash,
               token_hash = ?,
               last_rotation_id = ?,
               last_rotation_next_hash = ?,
               current_connection_id = ?,
               connection_epoch = ?
             WHERE session_id = ? AND incarnation = ?`,
            nextDigest,
            parsed.id,
            nextDigest,
            attachment.connectionId,
            proposedEpoch,
            session.session_id,
            attachment.incarnation,
          );
        } else if (!sameConnection) {
          this.sql.exec(
            `UPDATE sessions SET current_connection_id = ?, connection_epoch = ?
             WHERE session_id = ? AND incarnation = ?`,
            attachment.connectionId,
            proposedEpoch,
            session.session_id,
            attachment.incarnation,
          );
        }
        this.sql.exec(
          'DELETE FROM pending_actions WHERE action_id = ?',
          `handshake-timeout:${attachment.connectionId}`,
        );
        this.sql.exec('DELETE FROM pending_actions WHERE action_id = ?', ROOM_EXPIRY_ACTION_ID);
        if (session.role === 'OWNER') {
          this.sql.exec(
            `DELETE FROM pending_actions
             WHERE action_id = ? AND kind = 'owner-auth-expiry'`,
            OWNER_AUTH_ACTION_ID,
          );
        }
        if (freshIdentity.state.expiresAt !== null) {
          lifecycleState = { ...freshIdentity.state, expiresAt: null };
          const serialized = JSON.stringify(lifecycleState);
          assertRoomSnapshotSize(serialized);
          this.sql.exec(
            `UPDATE room_state SET expires_at = NULL, state_json = ?
             WHERE incarnation = ? AND status = 'ACTIVE'`,
            serialized,
            attachment.incarnation,
          );
          lifecycleState = { state: lifecycleState, serialized };
        }
        await this.recomputeAlarm();
        if (fault?.type === 'before-commit') throw new Error('injected auth precommit failure');
        authenticated = {
          sessionId: session.session_id,
          incarnation: attachment.incarnation,
          role: session.role,
          seat: session.seat,
          connectionEpoch: proposedEpoch,
          connectionId: attachment.connectionId,
          expiresAt: session.expires_at,
        };
      });
    } catch (error) {
      if (error instanceof SocketAuthenticationError) {
        this.closeSocket(socket, WEBSOCKET_CLOSE.AUTH_INVALID, WEBSOCKET_CLOSE_REASON.AUTH_INVALID);
      } else if (error instanceof SocketRoomExpiredError) {
        this.closeSocket(socket, WEBSOCKET_CLOSE.ROOM_EXPIRED, WEBSOCKET_CLOSE_REASON.ROOM_EXPIRED);
      }
      return;
    }

    this.sessionAuthorities.set(authenticated.sessionId, authenticated);
    if (lifecycleState !== null) {
      this.commandState = lifecycleState.state;
      this.commandStateJson = lifecycleState.serialized;
    }
    if (fault?.type === 'after-commit-before-reply') return;
    this.closeReplacedSockets(authenticated.sessionId, authenticated.connectionId);
    const committed = this.cachedRoomIdentity();
    if (!committed || committed.stored.status !== 'ACTIVE') {
      this.closeSocket(socket, WEBSOCKET_CLOSE.ROOM_EXPIRED, WEBSOCKET_CLOSE_REASON.ROOM_EXPIRED);
      return;
    }
    socket.send(JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'hello-ok',
      id: parsed.id,
      payload: {
        sessionId: authenticated.sessionId,
        role: authenticated.role,
        seat: authenticated.seat,
        connectionEpoch: authenticated.connectionEpoch,
        revision: committed.state.revision,
        snapshot: publicRoomState(committed.state),
      },
    }));
  }

  async webSocketMessage(socket, message) {
    const attachment = this.socketAttachment(socket);
    let frame;
    try { frame = parseWebSocketJson(message); }
    catch (error) {
      this.closeForProtocol(socket, error);
      return;
    }

    if (attachment?.authenticated) {
      const authority = this.activeAuthority(attachment);
      if (!authority.ok) {
        this.closeSocket(
          socket,
          authority.expired ? WEBSOCKET_CLOSE.ROOM_EXPIRED : WEBSOCKET_CLOSE.SESSION_REPLACED,
          authority.expired
            ? WEBSOCKET_CLOSE_REASON.ROOM_EXPIRED : WEBSOCKET_CLOSE_REASON.SESSION_REPLACED,
        );
        return;
      }
      if (frame?.type === 'hello') {
        await this.authenticateSocket(socket, attachment, frame, authority.identity);
        return;
      }
      if (frame?.type === 'command') {
        await this.handleCommand(socket, attachment, frame);
        return;
      }
      this.closeSocket(socket, WEBSOCKET_CLOSE.PROTOCOL_ERROR, WEBSOCKET_CLOSE_REASON.PROTOCOL_ERROR);
      return;
    }

    const identity = this.cachedRoomIdentity();
    if (!identity
      || identity.stored.status !== 'ACTIVE'
      || identity.state.status !== 'ACTIVE'
      || identity.stored.incarnation !== attachment?.incarnation) {
      this.closeSocket(socket, WEBSOCKET_CLOSE.ROOM_EXPIRED, WEBSOCKET_CLOSE_REASON.ROOM_EXPIRED);
      return;
    }
    if (frame?.type !== 'hello') {
      this.closeSocket(socket, WEBSOCKET_CLOSE.PROTOCOL_ERROR, WEBSOCKET_CLOSE_REASON.PROTOCOL_ERROR);
      return;
    }
    await this.authenticateSocket(socket, attachment, frame, identity);
  }

  async cleanupClosedSocket(socket) {
    const attachment = this.socketAttachment(socket);
    if (this.deleted || !validIdentity(attachment?.connectionId)) return;
    let clearedAuthority = null;
    let lifecycleState = null;
    await this.ctx.storage.transaction(async () => {
      this.sql.exec(
        'DELETE FROM pending_actions WHERE action_id = ?',
        `handshake-timeout:${attachment.connectionId}`,
      );
      if (attachment.authenticated === true
        && validIdentity(attachment.sessionId)
        && Number.isSafeInteger(attachment.connectionEpoch)) {
        const session = row(this.sql.exec(
          `SELECT * FROM sessions WHERE session_id = ? AND incarnation = ?
           AND current_connection_id = ? AND connection_epoch = ? LIMIT 1`,
          attachment.sessionId,
          attachment.incarnation,
          attachment.connectionId,
          attachment.connectionEpoch,
        ));
        if (session) {
          const nextEpoch = session.connection_epoch;
          this.sql.exec(
            `UPDATE sessions SET current_connection_id = NULL, connection_epoch = ?
             WHERE session_id = ? AND incarnation = ?
             AND current_connection_id = ? AND connection_epoch = ?`,
            nextEpoch,
            attachment.sessionId,
            attachment.incarnation,
            attachment.connectionId,
            attachment.connectionEpoch,
          );
          clearedAuthority = {
            sessionId: session.session_id,
            incarnation: session.incarnation,
            role: session.role,
            seat: session.seat,
            connectionId: null,
            connectionEpoch: nextEpoch,
            expiresAt: session.expires_at,
          };

          const identity = this.roomIdentity();
          const connected = row(this.sql.exec(
            `SELECT COUNT(*) AS count FROM sessions
             WHERE incarnation = ? AND current_connection_id IS NOT NULL`,
            attachment.incarnation,
          )).count;
          if (identity?.stored.status === 'ACTIVE'
            && identity.state.status === 'ACTIVE'
            && connected === 0) {
            const dueAt = Date.now() + LIMITS.roomExpiryMs;
            lifecycleState = this.persistRoomExpiry(
              identity,
              attachment.incarnation,
              dueAt,
              { scheduledBySessionId: attachment.sessionId },
            );
          }
        }
      }
      await this.recomputeAlarm();
    });
    if (clearedAuthority !== null) {
      this.sessionAuthorities.set(clearedAuthority.sessionId, clearedAuthority);
    }
    if (lifecycleState !== null) {
      this.commandState = lifecycleState.state;
      this.commandStateJson = lifecycleState.serialized;
    }
  }

  webSocketClose(socket) {
    return this.cleanupClosedSocket(socket);
  }

  webSocketError(socket) {
    return this.cleanupClosedSocket(socket);
  }

  async inspectInitialization({ code, incarnation, leaseId, leaseExpiresAt } = {}) {
    if (!validCodeIncarnation(code, incarnation)
      || !validIdentity(leaseId)
      || !validTime(leaseExpiresAt)) {
      return { initialized: false };
    }
    if (this.deleted) return { initialized: false };
    if (this.env?.ROOM_FOUNDATION_TEST === 'true') {
      const fault = await this.ctx.storage.get('registryInspectionFault');
      const exactFault = fault?.code === code
        && fault?.incarnation === incarnation
        && fault?.leaseId === leaseId;
      if (exactFault && fault.type === 'throw') throw new Error('injected inspection failure');
      if (exactFault && fault.type === 'malformed') return { initialized: false, unexpected: true };
    }
    const stored = row(this.sql.exec('SELECT * FROM room_state LIMIT 1'));
    if (!stored || stored.incarnation !== incarnation) return { initialized: false };
    const state = JSON.parse(stored.state_json);
    if (state.roomCode !== code
      || state.initialization?.leaseId !== leaseId
      || state.initialization?.leaseExpiresAt !== leaseExpiresAt) {
      return { initialized: false };
    }
    const owner = row(this.sql.exec("SELECT bootstrap_response_json FROM sessions WHERE role = 'OWNER' LIMIT 1"));
    if (!owner) return { initialized: false };
    return { initialized: true, response: JSON.parse(owner.bootstrap_response_json) };
  }

  async testSetInitialization({ code, incarnation, leaseId, leaseExpiresAt, response } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    const normalized = normalizeBootstrapResponse(response, {
      code, incarnation, requestId: response?.requestId, role: 'OWNER', seat: 'N',
    });
    if (!normalized || !validIdentity(leaseId) || !validTime(leaseExpiresAt)) {
      return failure('INVALID_REQUEST');
    }
    const initialized = await this.initializeWithSession({
      code,
      incarnation,
      leaseId,
      leaseExpiresAt,
      requestId: normalized.requestId,
      requestHash: '0'.repeat(64),
      tokenHash: '1'.repeat(64),
    }, normalized.sessionId, Math.min(Date.now(), leaseExpiresAt - 1));
    return initialized.ok ? result({ initialized: true }) : initialized;
  }

  async testSetInspectionFault({ code, incarnation, leaseId, type } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validCodeIncarnation(code, incarnation) || !validIdentity(leaseId)
      || (type !== 'throw' && type !== 'malformed' && type !== null)) {
      return failure('INVALID_REQUEST');
    }
    const stored = await this.ctx.storage.get('registryInspectionFault');
    if (type === null) {
      if (stored?.code !== code || stored?.incarnation !== incarnation || stored?.leaseId !== leaseId) {
        return failure('INVALID_REQUEST');
      }
      await this.ctx.storage.delete('registryInspectionFault');
    } else {
      await this.ctx.storage.put('registryInspectionFault', { code, incarnation, leaseId, type });
    }
    return result({ configured: type !== null });
  }

  async testSetInitializationFault({ code, incarnation, leaseId, type, delayMs } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    const delayValid = type === 'delay'
      && Number.isSafeInteger(delayMs)
      && delayMs >= 1
      && delayMs <= 5_000;
    if (!validCodeIncarnation(code, incarnation) || !validIdentity(leaseId)
      || (type !== 'throw' && type !== null && !delayValid)) return failure('INVALID_REQUEST');
    const stored = await this.ctx.storage.get('roomInitializationFault');
    if (type === null) {
      if (stored?.code !== code || stored?.incarnation !== incarnation || stored?.leaseId !== leaseId) {
        return failure('INVALID_REQUEST');
      }
      await this.ctx.storage.delete('roomInitializationFault');
    } else {
      await this.ctx.storage.put('roomInitializationFault', {
        code,
        incarnation,
        leaseId,
        type,
        ...(type === 'delay' ? { delayMs } : {}),
      });
    }
    return result({ configured: type !== null });
  }

  async testSetAuthFault({ code, incarnation, type, delayMs } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    const delayed = type === 'delay-before-transaction'
      && Number.isSafeInteger(delayMs) && delayMs >= 1 && delayMs <= 5_000;
    if (!validCodeIncarnation(code, incarnation)
      || (!['before-commit', 'after-commit-before-reply', null].includes(type) && !delayed)) {
      return failure('INVALID_REQUEST');
    }
    if (type === null) await this.ctx.storage.delete('roomAuthFault');
    else await this.ctx.storage.put('roomAuthFault', {
      code,
      incarnation,
      type,
      ...(delayed ? { delayMs } : {}),
    });
    return result({ configured: type !== null });
  }

  async testSetCommandFault({
    code, incarnation, sessionId, commandId, type, delayMs,
  } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    const delayed = type === 'delay-before-transaction'
      && Number.isSafeInteger(delayMs) && delayMs >= 1 && delayMs <= 5_000;
    if (!validCodeIncarnation(code, incarnation)
      || !validIdentity(sessionId)
      || !validIdentity(commandId)
      || (![
        'before-commit',
        'after-commit-before-delivery',
        'corrupt-state-before-cas',
        'mutate-state-before-cas',
        null,
      ].includes(type) && !delayed)) {
      return failure('INVALID_REQUEST');
    }
    const identity = this.cachedRoomIdentity();
    if (!identity
      || identity.stored.incarnation !== incarnation
      || identity.state.roomCode !== code) return failure('ROOM_NOT_FOUND');
    await this.ctx.storage.delete('roomCommandHook');
    if (type === null) await this.ctx.storage.delete('roomCommandFault');
    else await this.ctx.storage.put('roomCommandFault', {
      code, incarnation, sessionId, commandId, type,
      ...(delayed ? { delayMs } : {}),
    });
    return result({ configured: type !== null });
  }

  async testInspectCommandHook({ code, incarnation, commandId } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validCodeIncarnation(code, incarnation) || !validIdentity(commandId)) {
      return failure('INVALID_REQUEST');
    }
    const hook = await this.ctx.storage.get('roomCommandHook');
    return result({
      reached: hook?.code === code
        && hook?.incarnation === incarnation
        && hook?.commandId === commandId
        && hook?.reached === true,
    });
  }

  testCorruptCommandCache({ code, incarnation } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validCodeIncarnation(code, incarnation)) return failure('INVALID_REQUEST');
    return this.ctx.storage.transactionSync(() => {
      const stored = row(this.sql.exec('SELECT * FROM room_state LIMIT 1'));
      if (!stored || stored.incarnation !== incarnation) return failure('ROOM_NOT_FOUND');
      const state = JSON.parse(stored.state_json);
      if (state.roomCode !== code) return failure('ROOM_NOT_FOUND');
      state.recentCommands = { malformed: true };
      this.sql.exec(
        'UPDATE room_state SET state_json = ? WHERE incarnation = ?',
        JSON.stringify(state),
        incarnation,
      );
      return result({ corrupted: true });
    });
  }

  testInspectCommandAccounting({ code, incarnation } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validCodeIncarnation(code, incarnation)) return failure('INVALID_REQUEST');
    const identity = this.roomIdentity();
    if (!identity
      || identity.stored.incarnation !== incarnation
      || identity.state.roomCode !== code) return failure('ROOM_NOT_FOUND');
    const commandSchemaObjects = rows(this.sql.exec(
      `SELECT type, name FROM sqlite_schema
       WHERE type IN ('table', 'index') AND lower(name) LIKE '%command%'
       ORDER BY type, name`,
    )).map((item) => ({ type: item.type, name: item.name }));
    return result({
      lastCommand: this.lastCommandAccounting,
      cumulative: this.cumulativeCommandAccounting,
      lastWake: this.lastWakeAccounting,
      cache: {
        ready: this.commandCacheReady,
        revision: this.commandState?.revision ?? null,
        authorityCount: this.sessionAuthorities.size,
      },
      commandSchemaObjects,
    });
  }

  async testRecoverAlarmAt({ code, incarnation, now, currentAlarmAt } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validCodeIncarnation(code, incarnation)
      || !validTime(now) || !validTime(currentAlarmAt)) return failure('INVALID_REQUEST');
    const identity = this.roomIdentity();
    if (!identity || identity.stored.incarnation !== incarnation
      || identity.state.roomCode !== code) return failure('ROOM_NOT_FOUND');
    await this.ctx.storage.setAlarm(currentAlarmAt);
    await this.recoverAlarm(now);
    return result({ alarmAt: await this.ctx.storage.getAlarm() });
  }

  testSetStatus({ code, incarnation, status } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validCodeIncarnation(code, incarnation) || status !== 'CLOSING') {
      return failure('INVALID_REQUEST');
    }
    const changed = this.ctx.storage.transactionSync(() => {
      const stored = row(this.sql.exec('SELECT * FROM room_state LIMIT 1'));
      if (!stored || stored.incarnation !== incarnation) return failure('ROOM_NOT_FOUND');
      const state = JSON.parse(stored.state_json);
      if (state.roomCode !== code) return failure('ROOM_NOT_FOUND');
      state.status = status;
      const serialized = JSON.stringify(state);
      this.sql.exec(
        'UPDATE room_state SET status = ?, state_json = ? WHERE incarnation = ?',
        status,
        serialized,
        incarnation,
      );
      return { response: result({ status }), state, serialized };
    });
    if (changed?.state) {
      this.commandState = changed.state;
      this.commandStateJson = changed.serialized;
    }
    return changed?.response ?? changed;
  }

  async testInspect({ code, incarnation } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validCodeIncarnation(code, incarnation)) return failure('INVALID_REQUEST');
    if (this.deleted) return failure('ROOM_NOT_FOUND');
    const stored = row(this.sql.exec('SELECT * FROM room_state LIMIT 1'));
    if (!stored || stored.incarnation !== incarnation) return failure('ROOM_NOT_FOUND');
    const state = JSON.parse(stored.state_json);
    if (state.roomCode !== code) return failure('ROOM_NOT_FOUND');
    return result({
      roomState: publicRoomState(state),
      sessions: rows(this.sql.exec('SELECT * FROM sessions ORDER BY rowid')).map((session) => ({
        sessionId: session.session_id,
        bootstrapRequestId: session.bootstrap_request_id,
        bootstrapResponse: JSON.parse(session.bootstrap_response_json),
        incarnation: session.incarnation,
        role: session.role,
        seat: session.seat,
        connectionId: session.current_connection_id,
        connectionEpoch: session.connection_epoch,
        expiresAt: session.expires_at,
      })),
      pendingActions: rows(this.sql.exec('SELECT * FROM pending_actions ORDER BY due_at, action_id'))
        .map((action) => ({
          actionId: action.action_id,
          incarnation: action.incarnation,
          dueAt: action.due_at,
          kind: action.kind,
          payload: JSON.parse(action.payload_json),
        })),
      sockets: this.ctx.getWebSockets().map((socket) => {
        const attachment = this.socketAttachment(socket);
        return {
          sessionId: attachment?.sessionId ?? null,
          incarnation: attachment?.incarnation ?? null,
          protocolVersion: attachment?.protocolVersion ?? null,
          connectionId: attachment?.connectionId ?? null,
          connectionEpoch: attachment?.connectionEpoch ?? null,
          acceptedAt: attachment?.acceptedAt ?? null,
          authenticated: attachment?.authenticated === true,
        };
      }),
      alarmAt: await this.ctx.storage.getAlarm(),
    });
  }

  async testInitializeAt(input = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    const { sessionId, now, ...initialization } = input;
    return this.initializeWithSession(initialization, sessionId, now);
  }

  testJoinAt(input = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    return this.join(input);
  }

  testOrphanSessionAuthority({ code, incarnation, sessionId, connectionId } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validCodeIncarnation(code, incarnation)
      || !validIdentity(sessionId)
      || !validIdentity(connectionId)) return failure('INVALID_REQUEST');
    const identity = this.cachedRoomIdentity();
    if (!identity
      || identity.state.roomCode !== code
      || identity.stored.incarnation !== incarnation
      || identity.stored.status !== 'ACTIVE') return failure('ROOM_NOT_FOUND');
    const session = row(this.sql.exec(
      'SELECT session_id FROM sessions WHERE session_id = ? AND incarnation = ?',
      sessionId,
      incarnation,
    ));
    if (!session) return failure('INVALID_REQUEST');
    this.sql.exec(
      `UPDATE sessions SET current_connection_id = ?
       WHERE session_id = ? AND incarnation = ?`,
      connectionId,
      sessionId,
      incarnation,
    );
    this.rebuildCommandAuthority();
    return result({ orphaned: true });
  }

  async testSeedMalformedHandshakeAction({ code, incarnation, dueAt } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validCodeIncarnation(code, incarnation) || !validTime(dueAt)) {
      return failure('INVALID_REQUEST');
    }
    const identity = this.cachedRoomIdentity();
    if (!identity
      || identity.state.roomCode !== code
      || identity.stored.incarnation !== incarnation
      || identity.stored.status !== 'ACTIVE') return failure('ROOM_NOT_FOUND');
    await this.ctx.storage.transaction(async () => {
      this.sql.exec(
        `INSERT INTO pending_actions (action_id, incarnation, due_at, kind, payload_json)
         VALUES ('handshake-timeout:malformed', ?, ?, 'handshake-timeout', '{"wrong":true}')`,
        incarnation,
        dueAt,
      );
      await this.recomputeAlarm();
    });
    return result({ seeded: true });
  }

  async testDropAlarm({ code, incarnation } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    const identity = this.cachedRoomIdentity();
    if (!validCodeIncarnation(code, incarnation)
      || !identity
      || identity.state.roomCode !== code
      || identity.stored.incarnation !== incarnation) return failure('ROOM_NOT_FOUND');
    await this.ctx.storage.deleteAlarm();
    return result({ dropped: true });
  }

  async testSeedPendingActions({ code, incarnation, count, dueAt } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validCodeIncarnation(code, incarnation)
      || !Number.isSafeInteger(count)
      || count < 0
      || count > LIMITS.pendingActions
      || !validTime(dueAt)) return failure('INVALID_REQUEST');
    const identity = this.cachedRoomIdentity();
    if (!identity
      || identity.stored.incarnation !== incarnation
      || identity.state.roomCode !== code
      || identity.stored.status !== 'ACTIVE') return failure('ROOM_NOT_FOUND');

    return this.ctx.storage.transaction(async () => {
      const current = row(this.sql.exec('SELECT COUNT(*) AS count FROM pending_actions')).count;
      if (current > count) return failure('INVALID_REQUEST');
      for (let index = current; index < count; index += 1) {
        const actionId = `test-live:${String(index).padStart(3, '0')}`;
        this.sql.exec(
          `INSERT INTO pending_actions (action_id, incarnation, due_at, kind, payload_json)
           VALUES (?, ?, ?, 'test-live', '{}')`,
          actionId,
          incarnation,
          dueAt,
        );
      }
      await this.recomputeAlarm();
      return result({ count });
    });
  }

  async testSetReleaseRetryAttempt({ code, incarnation, attempt, dueAt } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validCodeIncarnation(code, incarnation)
      || !Number.isSafeInteger(attempt)
      || attempt < 0
      || attempt > 52
      || !validTime(dueAt)) return failure('INVALID_REQUEST');
    const identity = this.cachedRoomIdentity();
    if (!identity
      || identity.stored.incarnation !== incarnation
      || identity.state.roomCode !== code
      || identity.stored.status !== 'CLOSING') return failure('ROOM_NOT_FOUND');

    return this.ctx.storage.transaction(async () => {
      const action = row(this.sql.exec(
        `SELECT action_id FROM pending_actions
         WHERE action_id = ? AND incarnation = ? AND kind = 'registry-release'`,
        REGISTRY_RELEASE_ACTION_ID,
        incarnation,
      ));
      if (!action) return failure('INVALID_STATE');
      this.sql.exec(
        `UPDATE pending_actions SET due_at = ?, payload_json = ?
         WHERE action_id = ? AND incarnation = ?`,
        dueAt,
        JSON.stringify({ attempt, phase: 'RELEASE' }),
        REGISTRY_RELEASE_ACTION_ID,
        incarnation,
      );
      await this.recomputeAlarm();
      return result({ attempt, dueAt });
    });
  }

  testAlarmAt({ code, incarnation, now } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validCodeIncarnation(code, incarnation) || !validTime(now)) {
      return failure('INVALID_REQUEST');
    }
    const stored = row(this.sql.exec('SELECT * FROM room_state LIMIT 1'));
    if (!stored || stored.incarnation !== incarnation) return failure('ROOM_NOT_FOUND');
    const state = JSON.parse(stored.state_json);
    if (state.roomCode !== code) return failure('ROOM_NOT_FOUND');
    return this.consumeDueActions(now);
  }

  async testProbeTokenStorage({
    code, incarnation, plaintextToken, expectedLeaseExpiresAt,
  } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validCodeIncarnation(code, incarnation) || !validTime(expectedLeaseExpiresAt)) {
      return failure('INVALID_REQUEST');
    }
    let expectedDigest;
    try { expectedDigest = await hashReconnectToken(plaintextToken); }
    catch { return failure('INVALID_REQUEST'); }

    const stored = row(this.sql.exec('SELECT * FROM room_state LIMIT 1'));
    if (!stored || stored.incarnation !== incarnation) return failure('ROOM_NOT_FOUND');
    const state = JSON.parse(stored.state_json);
    if (state.roomCode !== code) return failure('ROOM_NOT_FOUND');

    const textColumns = [
      ['room_state', ['status', 'state_json']],
      ['sessions', [
        'session_id', 'token_hash', 'previous_token_hash', 'last_rotation_id',
        'last_rotation_next_hash', 'current_connection_id', 'bootstrap_request_id',
        'bootstrap_request_hash', 'bootstrap_response_json', 'role', 'seat',
      ]],
      ['pending_actions', ['action_id', 'kind', 'payload_json']],
    ];
    let plaintextOccurrences = 0;
    let digestOutsideCredentialOccurrences = 0;
    for (const [table, columns] of textColumns) {
      for (const column of columns) {
        plaintextOccurrences += row(this.sql.exec(
          `SELECT COUNT(*) AS count FROM ${table} WHERE instr(COALESCE(${column}, ''), ?) > 0`,
          plaintextToken,
        )).count;
        if (!(table === 'sessions' && column === 'token_hash')) {
          digestOutsideCredentialOccurrences += row(this.sql.exec(
            `SELECT COUNT(*) AS count FROM ${table} WHERE instr(COALESCE(${column}, ''), ?) > 0`,
            expectedDigest,
          )).count;
        }
      }
    }
    const credentialDigestMatches = row(this.sql.exec(
      'SELECT COUNT(*) AS count FROM sessions WHERE token_hash = ?', expectedDigest,
    )).count;
    return result({
      plaintextOccurrences,
      credentialDigestMatches,
      digestOutsideCredentialOccurrences,
      initializationLeaseExpiresAtMatches:
        state.initialization?.leaseExpiresAt === expectedLeaseExpiresAt,
    });
  }
}
