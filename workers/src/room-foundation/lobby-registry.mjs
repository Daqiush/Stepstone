import { LIMITS } from './constants.mjs';

const REGISTRY_LEASE_MS = 60_000;
const RECONCILE_RETRY_MS = 1_000;
const NONTERMINAL_EXPIRES_AT = Number.MAX_SAFE_INTEGER;
const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/u;
const REQUEST_HASH = /^[0-9a-f]{64}$/u;
const ROOM_CODE = /^\d{3}$/u;

function result(value) {
  return { ok: true, value };
}

function failure(error) {
  return { ok: false, error };
}

function validTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function row(cursor) {
  return cursor.toArray()[0] ?? null;
}

function rows(cursor) {
  return cursor.toArray();
}

function assertRequest(requestId, requestHash) {
  return typeof requestId === 'string' && REQUEST_ID.test(requestId)
    && typeof requestHash === 'string' && REQUEST_HASH.test(requestHash);
}

function assertCodeIncarnation(code, incarnation) {
  return typeof code === 'string' && ROOM_CODE.test(code)
    && Number.isSafeInteger(incarnation) && incarnation >= 1;
}

function assertLeaseId(leaseId) {
  return typeof leaseId === 'string' && REQUEST_ID.test(leaseId);
}

function exactInspectionShape(inspection, initialized) {
  if (inspection === null || typeof inspection !== 'object' || Array.isArray(inspection)) return false;
  const keys = Object.keys(inspection).sort();
  const expected = initialized ? ['initialized', 'response'] : ['initialized'];
  return inspection.initialized === initialized
    && keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function normalizeCreateResponse(response, { requestId, code, incarnation }) {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return null;
  const keys = Object.keys(response).sort();
  const expected = [
    'incarnation', 'requestId', 'role', 'roomCode', 'seat', 'sessionId', 'v',
  ];
  if (keys.length !== expected.length || !keys.every((key, index) => key === expected[index])) {
    return null;
  }
  if (response.v !== 1
    || response.requestId !== requestId
    || response.roomCode !== code
    || response.incarnation !== incarnation
    || typeof response.sessionId !== 'string'
    || !REQUEST_ID.test(response.sessionId)
    || response.role !== 'OWNER'
    || response.seat !== 'N') return null;
  return {
    v: 1,
    requestId,
    roomCode: code,
    incarnation,
    sessionId: response.sessionId,
    role: 'OWNER',
    seat: 'N',
  };
}

export class LobbyRegistry {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx?.storage?.sql;
    if (!this.sql) return;
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => {
        this.sql.exec(`CREATE TABLE IF NOT EXISTS room_codes (
          code TEXT PRIMARY KEY,
          incarnation INTEGER NOT NULL,
          status TEXT NOT NULL,
          lease_id TEXT,
          lease_expires_at INTEGER,
          tombstone_until INTEGER,
          updated_at INTEGER NOT NULL
        )`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS creation_requests (
          request_id TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          code TEXT NOT NULL,
          incarnation INTEGER NOT NULL,
          lease_id TEXT NOT NULL,
          status TEXT NOT NULL,
          response_json TEXT,
          expires_at INTEGER NOT NULL
        )`);
      });
      await this.recoverAlarm();
    });
  }

  fetch() {
    return new Response(null, { status: 404 });
  }

  nextDue() {
    const lease = row(this.sql.exec(
      "SELECT MIN(lease_expires_at) AS due_at FROM room_codes WHERE status = 'PROVISIONING'",
    ))?.due_at;
    const request = row(this.sql.exec(
      "SELECT MIN(expires_at) AS due_at FROM creation_requests WHERE status IN ('ACTIVE', 'FAILED')",
    ))?.due_at;
    const candidates = [lease, request].filter((value) => value !== null && value !== undefined);
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  nextFutureDue(now) {
    const lease = row(this.sql.exec(
      `SELECT MIN(lease_expires_at) AS due_at FROM room_codes
       WHERE status = 'PROVISIONING' AND lease_expires_at > ?`,
      now,
    ))?.due_at;
    const request = row(this.sql.exec(
      `SELECT MIN(expires_at) AS due_at FROM creation_requests
       WHERE status IN ('ACTIVE', 'FAILED') AND expires_at > ?`,
      now,
    ))?.due_at;
    const candidates = [lease, request].filter((value) => value !== null && value !== undefined);
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  async recoverAlarm() {
    const now = Date.now();
    await this.recoverAlarmAt(now, now);
  }

  async recoverAlarmAt(now, alarmNow) {
    const current = await this.ctx.storage.getAlarm();
    if (current !== null && current <= now) {
      await this.ctx.storage.setAlarm(alarmNow);
      return;
    }
    const next = this.nextDue();
    if (next === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
    } else if (current !== null && (current <= next
      || (next <= now && current <= now + RECONCILE_RETRY_MS))) {
      return;
    } else if (current !== next) {
      await this.ctx.storage.setAlarm(Math.max(next, alarmNow));
    }
  }

  async scheduleAlarm(retryAt = null) {
    const next = this.nextDue();
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    const current = await this.ctx.storage.getAlarm();
    if (retryAt !== null) {
      const futureDue = this.nextFutureDue(now);
      const candidates = [retryAt, futureDue, current !== null && current > now ? current : null]
        .filter((value) => value !== null);
      const target = Math.min(...candidates);
      await this.ctx.storage.setAlarm(Math.max(target, now));
    } else if (!(next <= now && current !== null && current > now
      && current <= now + RECONCILE_RETRY_MS)) {
      await this.ctx.storage.setAlarm(Math.max(next, now));
    }
  }

  replayValue(stored) {
    if (stored.status === 'ACTIVE') {
      return {
        status: 'ACTIVE', code: stored.code, incarnation: stored.incarnation,
        response: JSON.parse(stored.response_json), replayed: true,
      };
    }
    if (stored.status === 'FAILED') {
      return {
        status: 'FAILED', code: stored.code, incarnation: stored.incarnation, replayed: true,
      };
    }
    const code = row(this.sql.exec(
      'SELECT lease_expires_at FROM room_codes WHERE code = ?', stored.code,
    ));
    return {
      status: 'PROVISIONING', code: stored.code, incarnation: stored.incarnation,
      leaseId: stored.lease_id, leaseExpiresAt: code?.lease_expires_at ?? null, replayed: true,
    };
  }

  chooseAvailableCode(now) {
    let available = row(this.sql.exec(
      "SELECT * FROM room_codes WHERE status = 'TOMBSTONE' AND tombstone_until <= ? ORDER BY code LIMIT 1",
      now,
    ));
    if (available) return available;
    available = row(this.sql.exec(
      "SELECT * FROM room_codes WHERE status = 'FREE' ORDER BY code LIMIT 1",
    ));
    if (available) return available;

    const occupied = new Set(rows(this.sql.exec('SELECT code FROM room_codes')).map((item) => item.code));
    for (let number = 0; number < 1_000; number += 1) {
      const code = String(number).padStart(3, '0');
      if (!occupied.has(code)) return {
        code, incarnation: 0, status: 'FREE', lease_id: null,
        lease_expires_at: null, tombstone_until: null, updated_at: now,
      };
    }
    return null;
  }

  allocate({ requestId, requestHash } = {}) {
    return this.allocateAt({ requestId, requestHash, now: Date.now() });
  }

  async allocateAt({ requestId, requestHash, now } = {}) {
    if (!assertRequest(requestId, requestHash) || !validTime(now)) return failure('INVALID_REQUEST');
    const leaseId = crypto.randomUUID();
    const leaseExpiresAt = now + REGISTRY_LEASE_MS;

    return this.ctx.storage.transaction(async () => {
      this.sql.exec(
        "DELETE FROM creation_requests WHERE status IN ('ACTIVE', 'FAILED') AND expires_at <= ?",
        now,
      );
      const stored = row(this.sql.exec(
        'SELECT * FROM creation_requests WHERE request_id = ?', requestId,
      ));
      if (stored) {
        if (stored.request_hash !== requestHash) return failure('REQUEST_CONFLICT');
        return result(this.replayValue(stored));
      }

      const count = row(this.sql.exec('SELECT COUNT(*) AS count FROM creation_requests')).count;
      if (count >= LIMITS.creationRequests) return failure('SERVICE_CAPACITY');
      const available = this.chooseAvailableCode(now);
      if (!available) return failure('SERVICE_CAPACITY');
      if (available.incarnation >= Number.MAX_SAFE_INTEGER) return failure('SERVICE_CAPACITY');
      const incarnation = available.incarnation + 1;

      if (available.incarnation === 0) {
        this.sql.exec(
          `INSERT INTO room_codes
            (code, incarnation, status, lease_id, lease_expires_at, tombstone_until, updated_at)
           VALUES (?, ?, 'PROVISIONING', ?, ?, NULL, ?)`,
          available.code, incarnation, leaseId, leaseExpiresAt, now,
        );
      } else {
        this.sql.exec(
          `UPDATE room_codes SET incarnation = ?, status = 'PROVISIONING', lease_id = ?,
            lease_expires_at = ?, tombstone_until = NULL, updated_at = ? WHERE code = ?`,
          incarnation, leaseId, leaseExpiresAt, now, available.code,
        );
      }
      this.sql.exec(
        `INSERT INTO creation_requests
          (request_id, request_hash, code, incarnation, lease_id, status, response_json, expires_at)
         VALUES (?, ?, ?, ?, ?, 'PROVISIONING', NULL, ?)`,
        requestId, requestHash, available.code, incarnation, leaseId,
        NONTERMINAL_EXPIRES_AT,
      );
      await this.scheduleAlarm();
      return result({
        status: 'PROVISIONING', code: available.code, incarnation, leaseId,
        leaseExpiresAt, replayed: false,
      });
    });
  }

  activate({ requestId, code, incarnation, leaseId, response } = {}) {
    return this.activateAt({
      requestId, code, incarnation, leaseId, response, now: Date.now(),
    });
  }

  lookupActive({ code } = {}) {
    if (typeof code !== 'string' || !ROOM_CODE.test(code)) return failure('ROOM_NOT_FOUND');
    const current = row(this.sql.exec(
      "SELECT code, incarnation FROM room_codes WHERE code = ? AND status = 'ACTIVE'", code,
    ));
    return current
      ? result({ code: current.code, incarnation: current.incarnation })
      : failure('ROOM_NOT_FOUND');
  }

  async activateAt({ requestId, code, incarnation, leaseId, response, now } = {}) {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)
      || !assertCodeIncarnation(code, incarnation)
      || !assertLeaseId(leaseId) || !validTime(now)) return failure('INVALID_REQUEST');
    const normalizedResponse = normalizeCreateResponse(response, { requestId, code, incarnation });
    if (normalizedResponse === null) return failure('INVALID_REQUEST');
    const responseJson = JSON.stringify(normalizedResponse);

    return this.ctx.storage.transaction(async () => {
      const request = row(this.sql.exec(
        'SELECT * FROM creation_requests WHERE request_id = ?', requestId,
      ));
      if (!request) return failure('INVALID_STATE');
      if (request.code !== code || request.incarnation !== incarnation || request.lease_id !== leaseId) {
        return failure('LEASE_MISMATCH');
      }
      if (request.status === 'ACTIVE') {
        return result({ status: 'ACTIVE', response: JSON.parse(request.response_json), replayed: true });
      }
      const current = row(this.sql.exec('SELECT * FROM room_codes WHERE code = ?', code));
      if (!current || current.incarnation !== incarnation) return failure('INCARNATION_MISMATCH');
      if (current.status !== 'PROVISIONING') return failure('INVALID_STATE');
      if (current.lease_id !== leaseId) return failure('LEASE_MISMATCH');
      if (now >= current.lease_expires_at) return failure('LEASE_EXPIRED');

      this.sql.exec(
        `UPDATE room_codes SET status = 'ACTIVE', lease_id = NULL, lease_expires_at = NULL,
          tombstone_until = NULL, updated_at = ? WHERE code = ?`,
        now, code,
      );
      this.sql.exec(
        `UPDATE creation_requests SET status = 'ACTIVE', response_json = ?, expires_at = ?
         WHERE request_id = ?`,
        responseJson, now + LIMITS.creationReplayTtlMs, requestId,
      );
      await this.scheduleAlarm();
      return result({ status: 'ACTIVE', response: normalizedResponse, replayed: false });
    });
  }

  async markReleasePending({ code, incarnation } = {}) {
    const marked = this.markReleasePendingAt({ code, incarnation, now: Date.now() });
    if (this.env?.ROOM_FOUNDATION_TEST === 'true' && marked?.ok) {
      const fault = await this.ctx.storage.get('registryReleaseFault');
      const exact = fault?.code === code && fault?.incarnation === incarnation;
      if (exact && fault.type === 'after-mark-before-response') {
        await this.ctx.storage.delete('registryReleaseFault');
        throw new Error('injected registry mark response loss');
      }
    }
    return marked;
  }

  markReleasePendingAt({ code, incarnation, now } = {}) {
    if (!assertCodeIncarnation(code, incarnation) || !validTime(now)) return failure('INVALID_REQUEST');
    return this.ctx.storage.transactionSync(() => {
      const current = row(this.sql.exec('SELECT * FROM room_codes WHERE code = ?', code));
      if (!current) return failure('INVALID_STATE');
      if (current.incarnation !== incarnation) return failure('INCARNATION_MISMATCH');
      if (current.status === 'RELEASE_PENDING') return result({ status: 'RELEASE_PENDING' });
      if (current.status !== 'ACTIVE') return failure('INVALID_STATE');
      this.sql.exec(
        "UPDATE room_codes SET status = 'RELEASE_PENDING', updated_at = ? WHERE code = ?",
        now, code,
      );
      return result({ status: 'RELEASE_PENDING' });
    });
  }

  async release({ code, incarnation } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST === 'true') {
      const fault = await this.ctx.storage.get('registryReleaseFault');
      const exact = fault?.code === code && fault?.incarnation === incarnation;
      if (exact && (fault.type === 'release-once' || fault.type === 'release-always')) {
        if (fault.type === 'release-once') await this.ctx.storage.delete('registryReleaseFault');
        throw new Error('injected registry release failure');
      }
      const released = this.releaseAt({ code, incarnation, now: Date.now() });
      if (exact && fault.type === 'after-release-before-response') {
        await this.ctx.storage.delete('registryReleaseFault');
        throw new Error('injected terminal registry response loss');
      }
      return released;
    }
    return this.releaseAt({ code, incarnation, now: Date.now() });
  }

  releaseAt({ code, incarnation, now } = {}) {
    if (!assertCodeIncarnation(code, incarnation) || !validTime(now)) return failure('INVALID_REQUEST');
    return this.ctx.storage.transactionSync(() => {
      const current = row(this.sql.exec('SELECT * FROM room_codes WHERE code = ?', code));
      if (!current) return failure('INVALID_STATE');
      if (current.incarnation > incarnation) return result({ result: 'SUPERSEDED' });
      if (current.incarnation < incarnation) return failure('INCARNATION_MISMATCH');
      if (current.status === 'TOMBSTONE') return result({ result: 'RELEASED' });
      if (current.status !== 'RELEASE_PENDING') return failure('INVALID_STATE');
      this.sql.exec(
        `UPDATE room_codes SET status = 'TOMBSTONE', lease_id = NULL, lease_expires_at = NULL,
          tombstone_until = ?, updated_at = ? WHERE code = ?`,
        now + LIMITS.registryTombstoneMs, now, code,
      );
      return result({ result: 'RELEASED' });
    });
  }

  async reconcile(now = Date.now()) {
    if (!validTime(now)) return failure('INVALID_REQUEST');
    const expired = rows(this.sql.exec(
      `SELECT rooms.code, rooms.incarnation, rooms.lease_id, rooms.lease_expires_at,
        requests.request_id
       FROM room_codes AS rooms
       LEFT JOIN creation_requests AS requests
         ON requests.code = rooms.code
         AND requests.incarnation = rooms.incarnation
         AND requests.lease_id = rooms.lease_id
         AND requests.status = 'PROVISIONING'
       WHERE rooms.status = 'PROVISIONING' AND rooms.lease_expires_at <= ?
       ORDER BY rooms.code`,
      now,
    ));
    const decisions = [];
    for (const item of expired) {
      try {
        const id = this.env.STEPSTONE_ROOM.idFromName(`${item.code}:${item.incarnation}`);
        const inspection = await this.env.STEPSTONE_ROOM.get(id).inspectInitialization({
          code: item.code,
          incarnation: item.incarnation,
          leaseId: item.lease_id,
          leaseExpiresAt: item.lease_expires_at,
        });
        if (exactInspectionShape(inspection, false)) {
          decisions.push({ ...item, outcome: 'ABSENT' });
        } else if (exactInspectionShape(inspection, true)) {
          const normalizedResponse = normalizeCreateResponse(inspection.response, {
            requestId: item.request_id,
            code: item.code,
            incarnation: item.incarnation,
          });
          if (normalizedResponse === null) {
            decisions.push({ ...item, outcome: 'RETRY' });
            continue;
          }
          const responseJson = JSON.stringify(normalizedResponse);
          decisions.push({ ...item, outcome: 'ACTIVE', responseJson });
        } else {
          decisions.push({ ...item, outcome: 'RETRY' });
        }
      } catch {
        decisions.push({ ...item, outcome: 'RETRY' });
      }
    }

    let retryNeeded = false;
    await this.ctx.storage.transaction(async () => {
      for (const decision of decisions) {
        const current = row(this.sql.exec('SELECT * FROM room_codes WHERE code = ?', decision.code));
        if (!current || current.status !== 'PROVISIONING'
          || current.incarnation !== decision.incarnation
          || current.lease_id !== decision.lease_id
          || current.lease_expires_at > now) continue;
        if (decision.outcome === 'RETRY') {
          retryNeeded = true;
        } else if (decision.outcome === 'ACTIVE') {
          this.sql.exec(
            `UPDATE room_codes SET status = 'ACTIVE', lease_id = NULL, lease_expires_at = NULL,
              tombstone_until = NULL, updated_at = ? WHERE code = ?`,
            now, decision.code,
          );
          this.sql.exec(
            `UPDATE creation_requests SET status = 'ACTIVE', response_json = ?, expires_at = ?
             WHERE code = ? AND incarnation = ? AND lease_id = ?`,
            decision.responseJson, now + LIMITS.creationReplayTtlMs,
            decision.code, decision.incarnation, decision.lease_id,
          );
        } else {
          this.sql.exec(
            `UPDATE room_codes SET status = 'TOMBSTONE', lease_id = NULL, lease_expires_at = NULL,
              tombstone_until = ?, updated_at = ? WHERE code = ?`,
            now + LIMITS.registryTombstoneMs, now, decision.code,
          );
          this.sql.exec(
            `UPDATE creation_requests SET status = 'FAILED', response_json = NULL, expires_at = ?
             WHERE code = ? AND incarnation = ? AND lease_id = ?`,
            now + LIMITS.creationReplayTtlMs,
            decision.code, decision.incarnation, decision.lease_id,
          );
        }
      }
      this.sql.exec(
        "DELETE FROM creation_requests WHERE status IN ('ACTIVE', 'FAILED') AND expires_at <= ?",
        now,
      );
      await this.scheduleAlarm(retryNeeded ? Date.now() + RECONCILE_RETRY_MS : null);
    });
    return result({ reconciled: decisions.length });
  }

  alarm() {
    return this.reconcile(Date.now());
  }

  testReconcile({ now } = {}) {
    if (this.env.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    return this.reconcile(now);
  }

  async testScheduleRetryWithoutAlarm({ retryAt } = {}) {
    if (this.env.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validTime(retryAt)) return failure('INVALID_REQUEST');
    await this.ctx.storage.deleteAlarm();
    await this.scheduleAlarm(retryAt);
    return result({ scheduled: true });
  }

  async testRecoverAlarmAt({ now } = {}) {
    if (this.env.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!validTime(now)) return failure('INVALID_REQUEST');
    const beforeAlarmAt = await this.ctx.storage.getAlarm();
    const wallClockNow = Date.now();
    await this.recoverAlarmAt(now, wallClockNow);
    const afterAlarmAt = await this.ctx.storage.getAlarm();
    await this.reconcile(now);
    return result({
      beforeAlarmAt,
      afterAlarmAt,
      recoveryNow: now,
      wallClockNow,
    });
  }

  testAllocateAt(input) {
    if (this.env.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    return this.allocateAt(input);
  }

  testActivateAt(input) {
    if (this.env.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    return this.activateAt(input);
  }

  testMarkReleasePendingAt(input) {
    if (this.env.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    return this.markReleasePendingAt(input);
  }

  testReleaseAt(input) {
    if (this.env.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    return this.releaseAt(input);
  }

  async testSetReleaseFault({ code, incarnation, type } = {}) {
    if (this.env.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!assertCodeIncarnation(code, incarnation)
      || ![
        'release-once',
        'release-always',
        'after-mark-before-response',
        'after-release-before-response',
        null,
      ].includes(type)) {
      return failure('INVALID_REQUEST');
    }
    if (type === null) {
      const stored = await this.ctx.storage.get('registryReleaseFault');
      if (stored?.code !== code || stored?.incarnation !== incarnation) {
        return failure('INVALID_REQUEST');
      }
      await this.ctx.storage.delete('registryReleaseFault');
    } else {
      await this.ctx.storage.put('registryReleaseFault', { code, incarnation, type });
    }
    return result({ configured: type !== null });
  }

  async testInspect() {
    if (this.env.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    const indexRows = (table) => rows(this.sql.exec(`PRAGMA index_list(${table})`));
    const roomCodes = rows(this.sql.exec('SELECT * FROM room_codes ORDER BY code')).map((item) => ({
      code: item.code,
      incarnation: item.incarnation,
      status: item.status,
      leaseId: item.lease_id,
      leaseExpiresAt: item.lease_expires_at,
      tombstoneUntil: item.tombstone_until,
      updatedAt: item.updated_at,
    }));
    return result({
      roomCodes,
      creationRequests: rows(this.sql.exec('SELECT * FROM creation_requests ORDER BY request_id')),
      alarmAt: await this.ctx.storage.getAlarm(),
      indexes: {
        room_codes: indexRows('room_codes'),
        creation_requests: indexRows('creation_requests'),
      },
    });
  }

  testSeedCapacity({ count, now, expiresAt } = {}) {
    if (this.env.ROOM_FOUNDATION_TEST !== 'true') return failure('ROOM_NOT_FOUND');
    if (!Number.isSafeInteger(count) || count < 0 || count > LIMITS.creationRequests
      || !validTime(now) || !validTime(expiresAt) || expiresAt <= now) return failure('INVALID_REQUEST');
    return this.ctx.storage.transactionSync(() => {
      const current = row(this.sql.exec('SELECT COUNT(*) AS count FROM creation_requests')).count;
      for (let index = current; index < count; index += 1) {
        const id = `capacity_${String(index).padStart(16, '0')}`;
        this.sql.exec(
          `INSERT INTO creation_requests
            (request_id, request_hash, code, incarnation, lease_id, status, response_json, expires_at)
           VALUES (?, ?, '999', 1, ?, 'ACTIVE', '{}', ?)`,
          id, '0'.repeat(64), `capacity_lease_${String(index).padStart(16, '0')}`, expiresAt,
        );
      }
      return result({ count });
    });
  }
}
