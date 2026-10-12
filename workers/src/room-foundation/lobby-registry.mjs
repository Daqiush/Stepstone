import { LIMITS } from './constants.mjs';

const REGISTRY_LEASE_MS = 60_000;
const RECONCILE_RETRY_MS = 1_000;
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
  if (!REQUEST_ID.test(requestId) || !REQUEST_HASH.test(requestHash)) return false;
  return true;
}

function assertCodeIncarnation(code, incarnation) {
  return ROOM_CODE.test(code) && Number.isSafeInteger(incarnation) && incarnation >= 1;
}

function exactInspectionShape(inspection, initialized) {
  if (inspection === null || typeof inspection !== 'object' || Array.isArray(inspection)) return false;
  const keys = Object.keys(inspection).sort();
  const expected = initialized ? ['initialized', 'response'] : ['initialized'];
  return inspection.initialized === initialized
    && keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function safeResponseJson(value) {
  const seen = new Set();
  const visit = (current) => {
    if (current === null || typeof current === 'boolean' || typeof current === 'string') return;
    if (typeof current === 'number' && Number.isFinite(current)) return;
    if (Array.isArray(current)) {
      if (seen.has(current)) throw new TypeError('cyclic response');
      seen.add(current);
      for (const item of current) visit(item);
      seen.delete(current);
      return;
    }
    if (typeof current !== 'object') throw new TypeError('invalid response');
    if (seen.has(current)) throw new TypeError('cyclic response');
    seen.add(current);
    for (const [key, item] of Object.entries(current)) {
      if (key.toLowerCase().includes('token')) throw new TypeError('secret response field');
      visit(item);
    }
    seen.delete(current);
  };
  visit(value);
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > LIMITS.httpJsonBytes) {
    throw new TypeError('response too large');
  }
  return serialized;
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
      'SELECT MIN(expires_at) AS due_at FROM creation_requests',
    ))?.due_at;
    const candidates = [lease, request].filter((value) => value !== null && value !== undefined);
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  async recoverAlarm() {
    const current = await this.ctx.storage.getAlarm();
    const now = Date.now();
    if (current !== null && current <= now) {
      await this.ctx.storage.setAlarm(now);
      return;
    }
    const next = this.nextDue();
    if (next === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
    } else if (current !== null && (current <= next
      || (next <= now && current <= now + RECONCILE_RETRY_MS))) {
      return;
    } else if (current !== next) {
      await this.ctx.storage.setAlarm(Math.max(next, now));
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
      const target = current !== null && current > now ? Math.min(current, retryAt) : retryAt;
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

  async allocate({ requestId, requestHash, now = Date.now() } = {}) {
    if (!assertRequest(requestId, requestHash) || !validTime(now)) return failure('INVALID_REQUEST');
    const leaseId = crypto.randomUUID();
    const leaseExpiresAt = now + REGISTRY_LEASE_MS;

    return this.ctx.storage.transaction(async () => {
      this.sql.exec('DELETE FROM creation_requests WHERE expires_at <= ?', now);
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
        now + LIMITS.creationReplayTtlMs,
      );
      await this.scheduleAlarm();
      return result({
        status: 'PROVISIONING', code: available.code, incarnation, leaseId,
        leaseExpiresAt, replayed: false,
      });
    });
  }

  async activate({
    requestId, code, incarnation, leaseId, response, now = Date.now(),
  } = {}) {
    if (!REQUEST_ID.test(requestId) || !assertCodeIncarnation(code, incarnation)
      || typeof leaseId !== 'string' || !validTime(now)) return failure('INVALID_REQUEST');
    let responseJson;
    try { responseJson = safeResponseJson(response); }
    catch { return failure('INVALID_REQUEST'); }

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
      return result({ status: 'ACTIVE', response, replayed: false });
    });
  }

  markReleasePending({ code, incarnation, now = Date.now() } = {}) {
    if (!assertCodeIncarnation(code, incarnation) || !validTime(now)) return failure('INVALID_REQUEST');
    return this.ctx.storage.transactionSync(() => {
      const current = row(this.sql.exec('SELECT * FROM room_codes WHERE code = ?', code));
      if (!current) return failure('INVALID_STATE');
      if (current.incarnation !== incarnation) return failure('INCARNATION_MISMATCH');
      if (current.status !== 'ACTIVE') return failure('INVALID_STATE');
      this.sql.exec(
        "UPDATE room_codes SET status = 'RELEASE_PENDING', updated_at = ? WHERE code = ?",
        now, code,
      );
      return result({ status: 'RELEASE_PENDING' });
    });
  }

  release({ code, incarnation, now = Date.now() } = {}) {
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
      `SELECT code, incarnation, lease_id, lease_expires_at FROM room_codes
       WHERE status = 'PROVISIONING' AND lease_expires_at <= ? ORDER BY code`,
      now,
    ));
    const decisions = [];
    for (const item of expired) {
      try {
        const id = this.env.STEPSTONE_ROOM.idFromName(`${item.code}:${item.incarnation}`);
        const inspection = await this.env.STEPSTONE_ROOM.get(id).inspectInitialization({
          code: item.code, incarnation: item.incarnation, leaseId: item.lease_id,
        });
        if (exactInspectionShape(inspection, false)) {
          decisions.push({ ...item, outcome: 'ABSENT' });
        } else if (exactInspectionShape(inspection, true)) {
          let responseJson;
          try { responseJson = safeResponseJson(inspection.response ?? null); }
          catch {
            decisions.push({ ...item, outcome: 'RETRY' });
            continue;
          }
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
      this.sql.exec('DELETE FROM creation_requests WHERE expires_at <= ?', now);
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

export class StepstoneRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  fetch() {
    return new Response(null, { status: 404 });
  }

  async inspectInitialization({ code, incarnation, leaseId } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST === 'true') {
      const fault = await this.ctx?.storage?.get('registryInspectionFault');
      const exactFault = fault?.code === code
        && fault?.incarnation === incarnation
        && fault?.leaseId === leaseId;
      if (exactFault && fault.type === 'throw') throw new Error('injected inspection failure');
      if (exactFault && fault.type === 'malformed') return { initialized: false, unexpected: true };
    }
    const stored = await this.ctx?.storage?.get('registryInitializationProbe');
    const initialized = stored?.code === code
      && stored?.incarnation === incarnation
      && stored?.leaseId === leaseId;
    return initialized ? { initialized: true, response: stored.response } : { initialized: false };
  }

  async testSetInitialization({ code, incarnation, leaseId, response } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return { ok: false, error: 'ROOM_NOT_FOUND' };
    await this.ctx.storage.put('registryInitializationProbe', { code, incarnation, leaseId, response });
    return { ok: true, value: { initialized: true } };
  }

  async testSetInspectionFault({ code, incarnation, leaseId, type } = {}) {
    if (this.env?.ROOM_FOUNDATION_TEST !== 'true') return { ok: false, error: 'ROOM_NOT_FOUND' };
    if (type !== 'throw' && type !== 'malformed' && type !== null) {
      return { ok: false, error: 'INVALID_REQUEST' };
    }
    const stored = await this.ctx.storage.get('registryInspectionFault');
    if (type === null) {
      if (stored?.code !== code || stored?.incarnation !== incarnation || stored?.leaseId !== leaseId) {
        return { ok: false, error: 'INVALID_REQUEST' };
      }
      await this.ctx.storage.delete('registryInspectionFault');
    } else {
      await this.ctx.storage.put('registryInspectionFault', { code, incarnation, leaseId, type });
    }
    return { ok: true, value: { configured: type !== null } };
  }
}
