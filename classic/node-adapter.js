'use strict';

const {
  CLASSIC_STATE_KEYS,
  ClassicInvariantError,
  createClassicLobbyState,
  validateClassicState,
} = require('./state.cjs');
const { ClassicInputError } = require('./engine.cjs');
const { sideOf } = require('./rules.cjs');

const SILENT_FORBIDDEN_METHODS = new Set([
  'readyNext', 'clearReadyForDisconnect', 'editBidAnnotation', 'appendBidQuestion',
  'answerBidQuestion',
]);

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function projectClassicState(room) {
  const projected = {};
  for (const key of CLASSIC_STATE_KEYS) projected[key] = cloneValue(room[key]);
  validateClassicState(projected);
  return projected;
}

function applyClassicState(room, state) {
  validateClassicState(state);
  const cloned = {};
  for (const key of CLASSIC_STATE_KEYS) cloned[key] = cloneValue(state[key]);
  validateClassicState(cloned);
  for (const key of CLASSIC_STATE_KEYS) room[key] = cloned[key];
}

function invalidBidMessage(room, seat, bid) {
  const currentContract = room.currentContract;
  if (bid === 'X' || bid === 'Double') {
    if (!currentContract) return '没有可加倍的定约';
    if (sideOf(currentContract.seat) === sideOf(seat)) return '不能加倍己方定约';
    if (currentContract.doubled) return '定约已被加倍';
  }
  if (bid === 'XX' || bid === 'Redouble') {
    if (!currentContract || !currentContract.doubled) return '定约未被加倍';
    if (currentContract.redoubled) return '定约已被再加倍';
    if (sideOf(currentContract.doublerSeat) === sideOf(seat)) return '不能再加倍己方的加倍';
  }
  return '叫品必须高于当前定约';
}

function emitAppError(io, socketId, msg) {
  try {
    io.to(socketId).emit('appError', { msg });
  } catch {
    // Error delivery is best-effort; a broken transport must not escape a socket handler.
  }
}

function logServerFailure(logger, metadata) {
  try {
    logger.error('Classic Node adapter command failed', metadata);
  } catch {
    // Logging is best-effort and must never recurse into another failure path.
  }
}

function serverFailure({ io, logger, room, socketId, method, failure }) {
  logServerFailure(logger, {
    method,
    roomId: room.id,
    failureName: failure instanceof Error ? failure.name : null,
    failureKind: failure instanceof Error ? failure.kind || null : null,
    errorMessage: failure instanceof Error ? failure.message : null,
    failureCode: failure && typeof failure === 'object' ? failure.code || null : null,
  });
  emitAppError(io, socketId, '服务器暂时无法处理，请稍后重试');
  return { ok: false, code: 'CLASSIC_SERVER_ERROR' };
}

function mapClassicNodeFailure({
  io, logger, room, socketId, method, seat, bid, failure,
}) {
  if (failure instanceof ClassicInputError) {
    emitAppError(io, socketId, '请求格式无效');
    return { ok: false, code: 'CLASSIC_INPUT_INVALID' };
  }
  if (failure instanceof ClassicInvariantError || failure instanceof Error) {
    return serverFailure({ io, logger, room, socketId, method, failure });
  }

  const code = failure && failure.code;
  if (code === 'CLASSIC_WRONG_PHASE') return { ok: false, code };
  if (code === 'CLASSIC_FORBIDDEN') {
    if (SILENT_FORBIDDEN_METHODS.has(method)) return { ok: false, code };
    const message = {
      start: '只有房主可以开始游戏',
      bid: '还没到你叫牌',
      play: '还没到你出牌',
      settleClaim: '无法确定声称座位',
    }[method];
    if (message) emitAppError(io, socketId, message);
    return { ok: false, code };
  }
  const message = {
    CLASSIC_SEATS_INCOMPLETE: '需要4名玩家全部就座后才能开始',
    CLASSIC_CARD_NOT_HELD: '该牌不在你手中',
    CLASSIC_MUST_FOLLOW_SUIT: '必须跟出同花色',
  }[code];
  if (message) {
    emitAppError(io, socketId, message);
    return { ok: false, code };
  }
  if (code === 'CLASSIC_NOT_YOUR_TURN') {
    emitAppError(io, socketId, method === 'bid' ? '还没到你叫牌' : '还没到你出牌');
    return { ok: false, code };
  }
  if (code === 'CLASSIC_INVALID_BID') {
    emitAppError(io, socketId, invalidBidMessage(room, seat, bid));
    return { ok: false, code };
  }
  return serverFailure({ io, logger, room, socketId, method, failure });
}

function createClassicNodeAdapter({ io, dealFactory, calcDDTable, logger } = {}) {
  if (!io || typeof io.to !== 'function') throw new TypeError('invalid classic Node adapter io');
  let probeOperator;
  try {
    probeOperator = io.to('__classic_adapter_dependency_probe__');
  } catch {
    throw new TypeError('invalid classic Node adapter io.to().emit');
  }
  if (!probeOperator || typeof probeOperator.emit !== 'function') {
    throw new TypeError('invalid classic Node adapter io.to().emit');
  }
  if (typeof dealFactory !== 'function') {
    throw new TypeError('invalid classic Node adapter dealFactory');
  }
  if (typeof calcDDTable !== 'function') {
    throw new TypeError('invalid classic Node adapter calcDDTable');
  }
  if (!logger || typeof logger.error !== 'function') {
    throw new TypeError('invalid classic Node adapter logger');
  }

  function initializeRoom(room) {
    if (room.mode !== 'classic' || room.teachingMode) return;
    if (Object.hasOwn(room, 'schemaVersion')) return;
    applyClassicState(room, createClassicLobbyState());
    room.classicRevision = 0;
  }

  return { initializeRoom };
}

module.exports = {
  applyClassicState,
  createClassicNodeAdapter,
  mapClassicNodeFailure,
  projectClassicState,
};
