import {
  LIMITS,
  REGISTRY_STATUSES,
} from './constants.mjs';

const statusSet = new Set(REGISTRY_STATUSES);
const codePattern = /^\d{3}$/;
const idPattern = /^[A-Za-z0-9_-]{16,64}$/;

export class RegistryTransitionError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'RegistryTransitionError';
    this.reason = reason;
  }
}

function fail(reason) {
  throw new RegistryTransitionError(reason);
}

function validTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) fail('INVALID_ROW');
  if (!codePattern.test(row.code) || !statusSet.has(row.status)) fail('INVALID_ROW');
  if (!Number.isSafeInteger(row.incarnation) || row.incarnation < 0) fail('INVALID_ROW');
  if (row.status !== 'FREE' && row.incarnation < 1) fail('INVALID_ROW');
  if (!validTime(row.updatedAt)) fail('INVALID_ROW');
  if (row.status === 'PROVISIONING') {
    if (!idPattern.test(row.leaseId) || !validTime(row.leaseExpiresAt)) fail('INVALID_ROW');
  }
  if (row.status === 'TOMBSTONE' && !validTime(row.tombstoneUntil)) fail('INVALID_ROW');
}

function validateNow(now) {
  if (!validTime(now)) fail('INVALID_INPUT');
}

function validateIncarnation(incarnation) {
  if (!Number.isSafeInteger(incarnation) || incarnation < 1) fail('INVALID_INPUT');
}

function validateLease(leaseId) {
  if (typeof leaseId !== 'string' || !idPattern.test(leaseId)) fail('INVALID_INPUT');
}

function requireExactIncarnation(row, incarnation) {
  if (row.incarnation !== incarnation) fail('INCARNATION_MISMATCH');
}

function requireProvisioningLease(row, incarnation, leaseId) {
  requireExactIncarnation(row, incarnation);
  if (row.status !== 'PROVISIONING') fail('INVALID_STATE');
  if (row.leaseId !== leaseId) fail('LEASE_MISMATCH');
}

function activate(row, now) {
  return {
    ...row,
    status: 'ACTIVE',
    leaseId: null,
    leaseExpiresAt: null,
    tombstoneUntil: null,
    updatedAt: now,
  };
}

function tombstone(row, now) {
  return {
    ...row,
    status: 'TOMBSTONE',
    leaseId: null,
    leaseExpiresAt: null,
    tombstoneUntil: now + LIMITS.registryTombstoneMs,
    updatedAt: now,
  };
}

export function allocateRegistryCode(row, { leaseId, leaseExpiresAt, now }) {
  validateRow(row);
  validateLease(leaseId);
  validateNow(now);
  if (!validTime(leaseExpiresAt) || leaseExpiresAt <= now) fail('INVALID_INPUT');
  const available = row.status === 'FREE'
    || (row.status === 'TOMBSTONE' && row.tombstoneUntil <= now);
  if (!available) fail('CODE_UNAVAILABLE');
  return {
    code: row.code,
    incarnation: row.incarnation + 1,
    status: 'PROVISIONING',
    leaseId,
    leaseExpiresAt,
    tombstoneUntil: null,
    updatedAt: now,
  };
}

export function activateRegistryCode(row, { incarnation, leaseId, now }) {
  validateRow(row);
  validateIncarnation(incarnation);
  validateLease(leaseId);
  validateNow(now);
  requireProvisioningLease(row, incarnation, leaseId);
  if (now >= row.leaseExpiresAt) fail('LEASE_EXPIRED');
  return activate(row, now);
}

export function reconcileProvisioning(row, {
  incarnation, leaseId, initialized, now,
}) {
  validateRow(row);
  validateIncarnation(incarnation);
  validateLease(leaseId);
  validateNow(now);
  if (typeof initialized !== 'boolean') fail('INVALID_INPUT');
  requireProvisioningLease(row, incarnation, leaseId);
  if (now < row.leaseExpiresAt) fail('LEASE_NOT_EXPIRED');
  return initialized ? activate(row, now) : tombstone(row, now);
}

export function markRegistryReleasePending(row, { incarnation, now }) {
  validateRow(row);
  validateIncarnation(incarnation);
  validateNow(now);
  requireExactIncarnation(row, incarnation);
  if (row.status !== 'ACTIVE') fail('INVALID_STATE');
  return { ...row, status: 'RELEASE_PENDING', updatedAt: now };
}

export function releaseRegistryCode(row, { incarnation, now }) {
  validateRow(row);
  validateIncarnation(incarnation);
  validateNow(now);
  if (row.incarnation > incarnation) return { result: 'SUPERSEDED', row };
  requireExactIncarnation(row, incarnation);
  if (row.status === 'TOMBSTONE') return { result: 'RELEASED', row };
  if (row.status !== 'RELEASE_PENDING') fail('INVALID_STATE');
  return { result: 'RELEASED', row: tombstone(row, now) };
}
