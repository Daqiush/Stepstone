import {
  LIMITS,
  PROTOCOL_VERSION,
  WEBSOCKET_CLOSE,
  WEBSOCKET_CLOSE_REASON,
} from './constants.mjs';
import {
  ProtocolError,
  constantTimeDigestEqual,
  hashReconnectToken,
  parseHelloFrame,
  parseWebSocketJson,
  publicErrorResponse,
} from './protocol.mjs';

const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/u;
const REQUEST_HASH = /^[0-9a-f]{64}$/u;
const ROOM_CODE = /^\d{3}$/u;
const PLAYER_SEATS = ['E', 'S', 'W'];
const WEBSOCKET_PATH = /^\/api\/rooms\/(\d{3})\/([1-9][0-9]*)\/ws$/u;

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

function publicRoomState(stored) {
  return {
    schemaVersion: stored.schemaVersion,
    roomCode: stored.roomCode,
    incarnation: stored.incarnation,
    revision: stored.revision,
    status: stored.status,
    foundationCounter: stored.foundationCounter,
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
    recentCommands: stored.recentCommands,
  };
}

export class StepstoneRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx?.storage?.sql;
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
      await this.reconcileWebSockets(Date.now());
      await this.recoverAlarm();
    });
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
    const session = row(this.sql.exec(
      `SELECT session_id FROM sessions
       WHERE session_id = ? AND incarnation = ? AND current_connection_id = ?
         AND connection_epoch = ? LIMIT 1`,
      attachment.sessionId,
      attachment.incarnation,
      attachment.connectionId,
      attachment.connectionEpoch,
    ));
    return session !== null;
  }

  async reconcileWebSockets(now) {
    const sockets = this.ctx.getWebSockets();
    const completedHandshakeActions = [];
    for (const socket of sockets) {
      const attachment = this.socketAttachment(socket);
      if (!attachment || !validIdentity(attachment.connectionId)) {
        this.closeSocket(socket, WEBSOCKET_CLOSE.PROTOCOL_ERROR, WEBSOCKET_CLOSE_REASON.PROTOCOL_ERROR);
        continue;
      }
      if (this.attachmentHasAuthority(attachment)) {
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
    if (completedHandshakeActions.length > 0) {
      await this.ctx.storage.transaction(async () => {
        for (const actionId of completedHandshakeActions) {
          this.sql.exec('DELETE FROM pending_actions WHERE action_id = ?', actionId);
        }
        await this.recomputeAlarm();
      });
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
    const identity = this.roomIdentity();
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

  async recoverAlarm() {
    const current = await this.ctx.storage.getAlarm();
    const next = this.nextDue();
    if (next === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    const target = Math.max(next, now);
    if (current === null || current > target || current < now) {
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

  async consumeDueActions(now) {
    const due = rows(this.sql.exec(
      'SELECT * FROM pending_actions WHERE due_at <= ? ORDER BY due_at, action_id', now,
    ));
    const timedOutConnections = new Set();
    for (const action of due) {
      if (action.kind === 'handshake-timeout') {
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
    await this.ctx.storage.transaction(async () => {
      this.sql.exec('DELETE FROM pending_actions WHERE due_at <= ?', now);
      await this.recomputeAlarm();
    });
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
    const actionId = `owner-auth-expiry:${sessionId}`;
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

    await this.ctx.storage.transaction(async () => {
      this.sql.exec(
        `INSERT INTO room_state
          (incarnation, schema_version, revision, status, expires_at, state_json)
         VALUES (?, 1, 0, 'ACTIVE', NULL, ?)`,
        incarnation, JSON.stringify(state),
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

    return this.ctx.storage.transactionSync(() => {
      const storedState = row(this.sql.exec('SELECT * FROM room_state LIMIT 1'));
      if (!storedState || storedState.incarnation !== incarnation) return failure('ROOM_NOT_FOUND');
      const state = JSON.parse(storedState.state_json);
      if (state.roomCode !== code) return failure('ROOM_NOT_FOUND');
      if (storedState.status !== 'ACTIVE') return failure('ROOM_EXPIRED');

      const replay = row(this.sql.exec(
        'SELECT * FROM sessions WHERE bootstrap_request_id = ? LIMIT 1', requestId,
      ));
      if (replay) {
        if (replay.bootstrap_request_hash !== requestHash
          || !constantTimeDigestEqual(replay.token_hash, tokenHash)) {
          return failure('REQUEST_CONFLICT');
        }
        return result({ response: JSON.parse(replay.bootstrap_response_json), replayed: true });
      }

      const duplicateToken = row(this.sql.exec(
        'SELECT session_id FROM sessions WHERE token_hash = ? LIMIT 1', tokenHash,
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
      return result({ response, replayed: false });
    });
  }

  async takeAuthFault(code, incarnation) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return null;
    const fault = await this.ctx.storage.get('roomAuthFault');
    if (!fault || fault.code !== code || fault.incarnation !== incarnation) return null;
    await this.ctx.storage.delete('roomAuthFault');
    return fault.type;
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
    const identity = this.roomIdentity();
    if (!identity
      || identity.stored.status !== 'ACTIVE'
      || identity.state.status !== 'ACTIVE'
      || identity.stored.incarnation !== attachment?.incarnation) {
      return { ok: false, expired: true };
    }
    if (!this.attachmentHasAuthority(attachment)) return { ok: false, expired: false };
    return { ok: true, identity };
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

    let session = row(this.sql.exec(
      'SELECT * FROM sessions WHERE incarnation = ? AND token_hash = ? LIMIT 1',
      identity.stored.incarnation,
      currentDigest,
    ));
    let replay = false;
    if (!session) {
      session = row(this.sql.exec(
        'SELECT * FROM sessions WHERE incarnation = ? AND previous_token_hash = ? LIMIT 1',
        identity.stored.incarnation,
        currentDigest,
      ));
      replay = session !== null;
    }
    if (!session || (session.expires_at !== null && session.expires_at <= Date.now())) {
      this.closeSocket(socket, WEBSOCKET_CLOSE.AUTH_INVALID, WEBSOCKET_CLOSE_REASON.AUTH_INVALID);
      return;
    }
    if (replay && (session.last_rotation_id !== parsed.id
      || !constantTimeDigestEqual(session.last_rotation_next_hash, nextDigest)
      || !constantTimeDigestEqual(session.token_hash, nextDigest))) {
      this.closeSocket(socket, WEBSOCKET_CLOSE.AUTH_INVALID, WEBSOCKET_CLOSE_REASON.AUTH_INVALID);
      return;
    }
    if (!replay) {
      const duplicateNextToken = row(this.sql.exec(
        'SELECT session_id FROM sessions WHERE token_hash = ? AND session_id <> ? LIMIT 1',
        nextDigest,
        session.session_id,
      ));
      if (constantTimeDigestEqual(currentDigest, nextDigest) || duplicateNextToken) {
        this.closeSocket(socket, WEBSOCKET_CLOSE.AUTH_INVALID, WEBSOCKET_CLOSE_REASON.AUTH_INVALID);
        return;
      }
    }

    const sameConnection = replay && session.current_connection_id === attachment.connectionId;
    const proposedEpoch = sameConnection
      ? session.connection_epoch : session.connection_epoch + 1;
    const proposedAttachment = {
      sessionId: session.session_id,
      incarnation: identity.stored.incarnation,
      protocolVersion: PROTOCOL_VERSION,
      connectionId: attachment.connectionId,
      connectionEpoch: proposedEpoch,
      authenticated: true,
    };
    socket.serializeAttachment(proposedAttachment);

    const fault = await this.takeAuthFault(identity.state.roomCode, identity.stored.incarnation);
    try {
      await this.ctx.storage.transaction(async () => {
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
            identity.stored.incarnation,
          );
        } else if (!sameConnection) {
          this.sql.exec(
            `UPDATE sessions SET current_connection_id = ?, connection_epoch = ?
             WHERE session_id = ? AND incarnation = ?`,
            attachment.connectionId,
            proposedEpoch,
            session.session_id,
            identity.stored.incarnation,
          );
        }
        this.sql.exec(
          'DELETE FROM pending_actions WHERE action_id = ?',
          `handshake-timeout:${attachment.connectionId}`,
        );
        this.sql.exec("DELETE FROM pending_actions WHERE kind = 'room-expiry'");
        if (session.role === 'OWNER') {
          this.sql.exec(
            `DELETE FROM pending_actions
             WHERE action_id = ? AND kind = 'owner-auth-expiry'`,
            `owner-auth-expiry:${session.session_id}`,
          );
        }
        await this.recomputeAlarm();
        if (fault === 'before-commit') throw new Error('injected auth precommit failure');
      });
    } catch {
      return;
    }

    if (fault === 'after-commit-before-reply') return;
    this.closeReplacedSockets(session.session_id, attachment.connectionId);
    const committed = this.roomIdentity();
    if (!committed || committed.stored.status !== 'ACTIVE') {
      this.closeSocket(socket, WEBSOCKET_CLOSE.ROOM_EXPIRED, WEBSOCKET_CLOSE_REASON.ROOM_EXPIRED);
      return;
    }
    socket.send(JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'hello-ok',
      id: parsed.id,
      payload: {
        sessionId: session.session_id,
        role: session.role,
        seat: session.seat,
        connectionEpoch: proposedEpoch,
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
      if (frame?.type !== 'hello') {
        this.closeSocket(socket, WEBSOCKET_CLOSE.PROTOCOL_ERROR, WEBSOCKET_CLOSE_REASON.PROTOCOL_ERROR);
        return;
      }
      await this.authenticateSocket(socket, attachment, frame, authority.identity);
      return;
    }

    const identity = this.roomIdentity();
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
    if (!validIdentity(attachment?.connectionId)) return;
    await this.ctx.storage.transaction(async () => {
      this.sql.exec(
        'DELETE FROM pending_actions WHERE action_id = ?',
        `handshake-timeout:${attachment.connectionId}`,
      );
      await this.recomputeAlarm();
    });
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

  async testSetAuthFault({ code, incarnation, type } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validCodeIncarnation(code, incarnation)
      || !['before-commit', 'after-commit-before-reply', null].includes(type)) {
      return failure('INVALID_REQUEST');
    }
    if (type === null) await this.ctx.storage.delete('roomAuthFault');
    else await this.ctx.storage.put('roomAuthFault', { code, incarnation, type });
    return result({ configured: type !== null });
  }

  testSetStatus({ code, incarnation, status } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validCodeIncarnation(code, incarnation) || status !== 'CLOSING') {
      return failure('INVALID_REQUEST');
    }
    return this.ctx.storage.transactionSync(() => {
      const stored = row(this.sql.exec('SELECT * FROM room_state LIMIT 1'));
      if (!stored || stored.incarnation !== incarnation) return failure('ROOM_NOT_FOUND');
      const state = JSON.parse(stored.state_json);
      if (state.roomCode !== code) return failure('ROOM_NOT_FOUND');
      state.status = status;
      this.sql.exec(
        'UPDATE room_state SET status = ?, state_json = ? WHERE incarnation = ?',
        status,
        JSON.stringify(state),
        incarnation,
      );
      return result({ status });
    });
  }

  async testInspect({ code, incarnation } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validCodeIncarnation(code, incarnation)) return failure('INVALID_REQUEST');
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
