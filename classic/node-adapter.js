'use strict';

const {
  CLASSIC_STATE_KEYS,
  ClassicInvariantError,
  createClassicLobbyState,
  validateClassicState,
} = require('./state.cjs');
const {
  ClassicInputError, applyClassicCommand, preflightClassicCommand,
} = require('./engine.cjs');
const {
  settleClassicClaim,
  editClassicBidAnnotation,
  appendClassicBidQuestion,
  answerClassicBidQuestion,
  applyClassicDdsCompletion,
} = require('./node-compat.cjs');
const { SEATS } = require('./constants.cjs');
const { sideOf } = require('./rules.cjs');
const { classicEventFor, classicViewFor } = require('./views.cjs');

const SILENT_FORBIDDEN_METHODS = new Set([
  'readyNext', 'clearReadyForDisconnect', 'editBidAnnotation', 'appendBidQuestion',
  'answerBidQuestion', 'settleAcceptedClaim',
]);

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function legacyBidToken(bid) {
  if (bid === 'X') return 'Double';
  if (bid === 'XX') return 'Redouble';
  return bid;
}

function legacyAuction(history) {
  return history.map(entry => ({ ...cloneValue(entry), bid: legacyBidToken(entry.bid) }));
}

function playerViewer(seat) {
  return { role: 'PLAYER', seat };
}

function legacyReplayBoardScores(room, state, viewer) {
  const publicScores = classicViewFor(state, viewer).boardScores;
  return publicScores.map((score, index) => {
    const replay = {
      ...cloneValue(score),
      initialHands: cloneValue(state.boardScores[index]?.initialHands),
    };
    const partial = room.classicClaimedPartialTricks?.[score.dealNumber];
    if (partial && Array.isArray(replay.completedTricks)
        && !replay.completedTricks.some(trick => trick?.claimed === true)) {
      replay.completedTricks = [...replay.completedTricks, cloneValue(partial)];
    }
    return replay;
  });
}

function safeEmit(io, target, name, payload, logger = null) {
  try {
    io.to(target).emit(name, payload);
  } catch (failure) {
    if (logger) logServerFailure(logger, {
      method: 'emitClassicEvents', roomId: null, eventName: name,
      failureName: failure instanceof Error ? failure.name : null,
      failureKind: failure instanceof Error ? failure.kind || null : null,
      errorMessage: failure instanceof Error ? failure.message : null,
      failureCode: null,
    });
  }
}

function forEachPlayer(room, callback) {
  for (const seat of SEATS) {
    const socketId = room.sockets?.[seat];
    if (socketId) callback(seat, socketId);
  }
}

function emitStarted(io, room, event, logger) {
  const state = projectClassicState(room);
  forEachPlayer(room, (seat, socketId) => {
    const viewer = playerViewer(seat);
    const projected = classicEventFor(event, viewer);
    const view = classicViewFor(state, viewer);
    const payload = {
      hand: cloneValue(view.hands[seat]),
      boardInfo: cloneValue(projected.payload.boardInfo),
      seat,
      playerNames: cloneValue(room.playerNames),
      boardScores: legacyReplayBoardScores(room, state, viewer),
    };
    safeEmit(io, socketId, 'gameStart', payload, logger);
  });
}

function emitBiddingUpdated(io, room, event, logger) {
  forEachPlayer(room, (seat, socketId) => {
    const projected = classicEventFor(event, playerViewer(seat));
    safeEmit(io, socketId, 'biddingUpdate', {
      history: legacyAuction(projected.payload.biddingHistory),
      currentBidder: projected.payload.currentBidder,
      currentContract: cloneValue(projected.payload.currentContract),
      consecutivePasses: projected.payload.consecutivePasses,
    }, logger);
  });
}

function emitBiddingEnded(io, room, event, logger) {
  forEachPlayer(room, (seat, socketId) => {
    const projected = classicEventFor(event, playerViewer(seat));
    safeEmit(io, socketId, 'biddingEnd', {
      contract: cloneValue(projected.payload.contract),
      declarer: projected.payload.declarer,
      dummy: projected.payload.dummy,
      leader: projected.payload.leader,
      biddingHistory: legacyAuction(projected.payload.biddingHistory),
      declarerControlledBy: null,
    }, logger);
  });
  const state = projectClassicState(room);
  forEachPlayer(room, (seat, socketId) => {
    const view = classicViewFor(state, playerViewer(seat));
    safeEmit(io, socketId, 'playUpdate', {
      currentPlayer: view.currentPlayer,
      currentTrick: cloneValue(view.currentTrick),
      completedCount: view.completedCount,
      nsTricks: view.nsTricks,
      ewTricks: view.ewTricks,
      dummyRevealed: view.dummyRevealed,
      dummy: view.dummy,
      declarer: view.declarer,
      declarerControlledBy: null,
      teachingCurrentSeat: null,
      teachingCurrentHand: null,
    }, logger);
  });
}

function emitPassedOut(io, room, event, logger) {
  const state = projectClassicState(room);
  const latestScore = state.boardScores.at(-1);
  forEachPlayer(room, (seat, socketId) => {
    const viewer = playerViewer(seat);
    const projected = classicEventFor(event, viewer);
    const view = classicViewFor(state, viewer);
    safeEmit(io, socketId, 'gameEnd', {
      passedOut: true,
      score: projected.payload.score,
      boardScores: legacyReplayBoardScores(room, state, viewer),
      ddTable: cloneValue(view.ddTable),
      hands: cloneValue(latestScore.initialHands),
    }, logger);
  });
}

function emitPerPlayer(io, room, name, payloadFactory, logger) {
  forEachPlayer(room, (seat, socketId) => {
    safeEmit(io, socketId, name, cloneValue(payloadFactory(seat)), logger);
  });
}

function playUpdatePayload(state, viewer) {
  const view = classicViewFor(state, viewer);
  return {
    currentPlayer: view.currentPlayer,
    currentTrick: cloneValue(view.currentTrick),
    completedCount: view.completedCount,
    nsTricks: view.nsTricks,
    ewTricks: view.ewTricks,
    dummyRevealed: view.dummyRevealed,
    dummy: view.dummy,
    declarer: view.declarer,
    declarerControlledBy: null,
    teachingCurrentSeat: null,
    teachingCurrentHand: null,
  };
}

function emitPlayUpdate(io, room, logger) {
  const state = projectClassicState(room);
  emitPerPlayer(io, room, 'playUpdate', seat => (
    playUpdatePayload(state, playerViewer(seat))
  ), logger);
}

function emitDummyRevealed(io, room, event, logger) {
  const state = projectClassicState(room);
  emitPerPlayer(io, room, 'dummyRevealed', seat => {
    const projected = classicEventFor(event, playerViewer(seat));
    const view = classicViewFor(state, playerViewer(seat));
    return {
      dummy: projected.payload.dummy,
      dummyHand: cloneValue(view.hands[projected.payload.dummy]),
    };
  }, logger);
}

function emitCardPlayed(io, room, event, logger) {
  emitPerPlayer(io, room, 'cardPlayed', seat => {
    const projected = classicEventFor(event, playerViewer(seat));
    return cloneValue(projected.payload);
  }, logger);
}

function emitTrickEnded(io, room, event, logger) {
  emitPerPlayer(io, room, 'trickEnd', seat => {
    const projected = classicEventFor(event, playerViewer(seat));
    return cloneValue(projected.payload);
  }, logger);
}

function emitPlayedGameEnd(io, room, event, logger) {
  const state = projectClassicState(room);
  const latestScore = state.boardScores.at(-1);
  emitPerPlayer(io, room, 'gameEnd', seat => {
    const viewer = playerViewer(seat);
    const projected = classicEventFor(event, viewer);
    return {
      passedOut: false,
      contract: cloneValue(projected.payload.contract),
      declarer: projected.payload.declarer,
      dummy: latestScore.dummy,
      declarerTricks: latestScore.declarerTricks,
      needed: latestScore.needed,
      score: projected.payload.score,
      made: latestScore.made,
      diff: latestScore.diff,
      vulnerability: latestScore.vulnerability,
      boardScores: legacyReplayBoardScores(room, state, viewer),
      ddTable: cloneValue(latestScore.ddTable),
      hands: cloneValue(latestScore.initialHands),
    };
  }, logger);
}

function emitReadyUpdated(io, room, event, logger) {
  emitPerPlayer(io, room, 'nextDealUpdate', seat => {
    const projected = classicEventFor(event, playerViewer(seat));
    return {
      readyStatus: cloneValue(projected.payload.readyStatus),
      playerNames: cloneValue(room.playerNames),
    };
  }, logger);
}

function sendClassicReconnectState(room, seat, socket) {
  if (!socket || typeof socket.emit !== 'function') {
    throw new TypeError('invalid classic reconnect socket');
  }
  const state = projectClassicState(room);
  const viewer = playerViewer(seat);
  const view = classicViewFor(state, viewer);

  socket.emit('gameStart', {
    hand: cloneValue(view.hands[seat]),
    boardInfo: cloneValue(view.boardInfo),
    seat,
    playerNames: cloneValue(room.playerNames),
    boardScores: cloneValue(view.boardScores),
  });

  if (view.phase === 'BIDDING') {
    socket.emit('biddingUpdate', {
      history: legacyAuction(view.biddingHistory),
      currentBidder: view.currentBidder,
      currentContract: cloneValue(view.currentContract),
      consecutivePasses: view.consecutivePasses,
    });
    return;
  }

  socket.emit('biddingEnd', {
    contract: cloneValue(view.currentContract),
    declarer: view.declarer,
    dummy: view.dummy,
    leader: view.leader,
    biddingHistory: legacyAuction(view.biddingHistory),
  });

  if (view.dummyRevealed) {
    socket.emit('dummyRevealed', {
      dummy: view.dummy,
      dummyHand: cloneValue(view.hands[view.dummy]),
    });
  }

  if (view.phase === 'PLAYING') {
    socket.emit('playUpdate', playUpdatePayload(state, viewer));

    if (room.claimReq) {
      const req = room.claimReq;
      const claimerSide = sideOf(req.claimer);
      const adjudicatesForOpponent = Array.isArray(req.voters)
        && req.voters.includes(seat)
        && sideOf(seat) !== claimerSide;
      socket.emit('claimRequest', {
        claimer: req.claimer,
        claimerName: room.playerNames[req.claimer],
        tricksToWin: req.tricksToWin,
        reason: req.reason,
        allHands: adjudicatesForOpponent ? cloneValue(state.hands) : {},
        remaining: 13 - view.completedCount,
        claimerSide,
      });
      if (req.votes && Object.keys(req.votes).length > 0) {
        socket.emit('claimVoteUpdate', {
          votes: cloneValue(req.votes),
          voters: cloneValue(req.voters),
        });
      }
    }

    if (room.viewReq && SEATS.includes(room.viewReq.requester)) {
      const req = room.viewReq;
      socket.emit('viewLastTrickRequest', {
        requester: req.requester,
        requesterName: room.playerNames[req.requester],
      });
      if (req.votes && Object.keys(req.votes).length > 0) {
        socket.emit('viewLastTrickVoteUpdate', { votes: cloneValue(req.votes) });
      }
    }
    return;
  }

  if (view.phase !== 'SCORING') return;
  const latestScore = view.boardScores.at(-1);
  if (!latestScore) return;
  const payload = latestScore.passedOut
    ? {
        passedOut: true,
        score: 0,
        boardScores: cloneValue(view.boardScores),
        ddTable: cloneValue(latestScore.ddTable),
      }
    : {
        passedOut: false,
        contract: cloneValue(latestScore.contract),
        declarer: latestScore.declarer,
        dummy: latestScore.dummy,
        declarerTricks: latestScore.declarerTricks,
        needed: latestScore.needed,
        score: latestScore.score,
        made: latestScore.made,
        diff: latestScore.diff,
        vulnerability: latestScore.vulnerability,
        boardScores: cloneValue(view.boardScores),
        ddTable: cloneValue(latestScore.ddTable),
      };
  socket.emit('gameEnd', payload);
}

function emitClassicEvents(io, room, events, logger = null) {
  const auctionFinished = events.some(event => (
    event?.name === 'classic.bidding-ended'
    || (event?.name === 'classic.finished' && event?.payload?.reason === 'passed-out')
  ));
  const hasPlayedCard = events.some(event => event?.name === 'classic.card-played');
  const playFinished = events.some(event => (
    event?.name === 'classic.finished' && event?.payload?.reason !== 'passed-out'
  ));
  for (const event of events) {
    if (event.name === 'classic.started') emitStarted(io, room, event, logger);
    else if (event.name === 'classic.bidding-updated') {
      if (!auctionFinished) emitBiddingUpdated(io, room, event, logger);
    } else if (event.name === 'classic.bidding-ended') {
      emitBiddingEnded(io, room, event, logger);
    } else if (event.name === 'classic.finished' && event.payload.reason === 'passed-out') {
      emitPassedOut(io, room, event, logger);
    } else if (event.name === 'classic.dummy-revealed') {
      emitDummyRevealed(io, room, event, logger);
    } else if (event.name === 'classic.card-played') {
      emitCardPlayed(io, room, event, logger);
    } else if (event.name === 'classic.trick-ended') {
      emitTrickEnded(io, room, event, logger);
    } else if (event.name === 'classic.finished') {
      emitPlayedGameEnd(io, room, event, logger);
    } else if (event.name === 'classic.ready-updated') {
      emitReadyUpdated(io, room, event, logger);
    } else if (event.name === 'classic.dd-table-ready' && room.phase === 'SCORING') {
      const projected = classicEventFor(event, { role: 'SPECTATOR', seat: null });
      safeEmit(io, room.id, 'ddTableReady', {
        ddTable: cloneValue(projected.payload.ddTable),
      }, logger);
    }
  }
  if (hasPlayedCard && !playFinished) emitPlayUpdate(io, room, logger);
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
  const currentContract = room?.currentContract;
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
    roomId: room?.id || null,
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
    if (!room || typeof room !== 'object' || Array.isArray(room)) return;
    if (room.mode !== 'classic' || room.teachingMode) return;
    if (Object.hasOwn(room, 'schemaVersion')) return;
    applyClassicState(room, createClassicLobbyState());
    room.classicRevision = 0;
  }

  function authoritativeSeat(room, socketId, requestedSeat) {
    if (SEATS.includes(requestedSeat) && room?.sockets?.[requestedSeat] === socketId) {
      return requestedSeat;
    }
    return SEATS.find(seat => room?.sockets?.[seat] === socketId) || null;
  }

  function actorFor(room, socketId, requestedSeat) {
    const seat = authoritativeSeat(room, socketId, requestedSeat);
    if (room?.ownerSocketId === socketId) return { role: 'OWNER', seat };
    if (seat !== null) return { role: 'PLAYER', seat };
    return { role: 'SPECTATOR', seat: null };
  }

  function occupiedSeats(room) {
    return SEATS.filter(seat => Boolean(room?.sockets?.[seat]));
  }

  function compactSuccess(room, result) {
    return { ok: true, phase: result.reply.phase, revision: room.classicRevision };
  }

  function settleDds(room, dealNumber, ddTable, failed) {
    try {
      const state = projectClassicState(room);
      const result = applyClassicDdsCompletion(state, { dealNumber, ddTable, failed });
      if (!result.ok) return false;
      if (result.reply.name === 'classic.dd-ignored') return true;
      applyClassicState(room, result.state);
      emitClassicEvents(io, room, result.events, logger);
      return true;
    } catch (failure) {
      logServerFailure(logger, {
        method: 'settleDds', roomId: room.id,
        failureName: failure instanceof Error ? failure.name : null,
        failureKind: failure instanceof Error ? failure.kind || null : null,
        errorMessage: failure instanceof Error ? failure.message : null,
        failureCode: failure && typeof failure === 'object' ? failure.code || null : null,
      });
      return false;
    }
  }

  function launchEffects(room, effects) {
    for (const effect of effects) {
      if (effect.type !== 'classic.compute-dd-table') continue;
      const dealNumber = effect.dealNumber;
      const hands = cloneValue(room.initialHands);
      Promise.resolve()
        .then(() => calcDDTable(hands))
        .then(
          table => {
            if (!settleDds(room, dealNumber, table, false)) {
              settleDds(room, dealNumber, null, true);
            }
          },
          failure => {
            logServerFailure(logger, {
              method: 'computeDds', roomId: room.id,
              failureName: failure instanceof Error ? failure.name : null,
              failureKind: failure instanceof Error ? failure.kind || null : null,
              errorMessage: failure instanceof Error ? failure.message : null,
              failureCode: failure && typeof failure === 'object' ? failure.code || null : null,
            });
            settleDds(room, dealNumber, null, true);
          },
        )
        .catch(failure => {
          logServerFailure(logger, {
            method: 'settleDdsPromise', roomId: room.id,
            failureName: failure instanceof Error ? failure.name : null,
            failureKind: failure instanceof Error ? failure.kind || null : null,
            errorMessage: failure instanceof Error ? failure.message : null,
            failureCode: failure && typeof failure === 'object' ? failure.code || null : null,
          });
        });
    }
  }

  function start(room, request = {}) {
    const socketId = request?.socketId;
    const seat = authoritativeSeat(room, socketId, request?.seat);
    try {
      const state = projectClassicState(room);
      const command = {
        name: 'classic.start', payload: { expectedRevision: room.classicRevision },
      };
      const baseContext = {
        actor: actorFor(room, socketId, seat), occupiedSeats: occupiedSeats(room),
      };
      const preflight = preflightClassicCommand(state, command, baseContext);
      if (!preflight.ok) {
        return mapClassicNodeFailure({
          io, logger, room, socketId, method: 'start', seat, bid: null, failure: preflight,
        });
      }
      const deal = preflight.needsDeal
        ? dealFactory({ dealNumber: preflight.nextDealNumber })
        : null;
      const result = applyClassicCommand(state, command, { ...baseContext, deal });
      if (!result.ok) {
        return mapClassicNodeFailure({
          io, logger, room, socketId, method: 'start', seat, bid: null, failure: result,
        });
      }
      applyClassicState(room, result.state);
      room.classicRevision += 1;
      if (preflight.needsDeal) {
        room.claimReq = null;
        room.viewReq = null;
      }
      emitClassicEvents(io, room, result.events, logger);
      launchEffects(room, result.effects);
      return compactSuccess(room, result);
    } catch (failure) {
      return mapClassicNodeFailure({
        io, logger, room, socketId, method: 'start', seat, bid: null, failure,
      });
    }
  }

  function scalarText(value) {
    if (!['string', 'number', 'boolean', 'bigint'].includes(typeof value)) {
      throw new ClassicInputError('explain must be a scalar');
    }
    return [...String(value).trim()].slice(0, 500).join('');
  }

  function legacyText(value) {
    if (typeof value !== 'string') throw new ClassicInputError('text must be a string');
    return [...value].slice(0, 500).join('');
  }

  function bid(room, request = {}) {
    const socketId = request?.socketId;
    const seat = authoritativeSeat(room, socketId, request?.seat);
    let normalizedBid = request?.bid;
    try {
      if (normalizedBid === 'Double') normalizedBid = 'X';
      else if (normalizedBid === 'Redouble') normalizedBid = 'XX';
      const alert = Boolean(request?.alert);
      const explain = alert && request?.explain
        ? scalarText(request.explain)
        : null;
      const state = projectClassicState(room);
      const command = {
        name: 'classic.bid',
        payload: {
          expectedRevision: room.classicRevision,
          bid: normalizedBid,
          alert,
          explain,
        },
      };
      const baseContext = {
        actor: actorFor(room, socketId, seat), occupiedSeats: occupiedSeats(room),
      };
      const preflight = preflightClassicCommand(state, command, baseContext);
      if (!preflight.ok) {
        return mapClassicNodeFailure({
          io, logger, room, socketId, method: 'bid', seat, bid: normalizedBid, failure: preflight,
        });
      }
      const result = applyClassicCommand(state, command, { ...baseContext, deal: null });
      if (!result.ok) {
        return mapClassicNodeFailure({
          io, logger, room, socketId, method: 'bid', seat, bid: normalizedBid, failure: result,
        });
      }
      applyClassicState(room, result.state);
      room.classicRevision += 1;
      emitClassicEvents(io, room, result.events, logger);
      return compactSuccess(room, result);
    } catch (failure) {
      return mapClassicNodeFailure({
        io, logger, room, socketId, method: 'bid', seat, bid: normalizedBid, failure,
      });
    }
  }

  function play(room, request = {}) {
    const socketId = request?.socketId;
    const seat = authoritativeSeat(room, socketId, request?.seat);
    try {
      if (room.claimReq) return { ok: false, code: 'CLASSIC_WRONG_PHASE' };
      const legacyCard = request?.card;
      const card = { suit: legacyCard?.suit, rank: legacyCard?.rank };
      const state = projectClassicState(room);
      const command = {
        name: 'classic.play',
        payload: { expectedRevision: room.classicRevision, card },
      };
      const baseContext = {
        actor: actorFor(room, socketId, seat), occupiedSeats: occupiedSeats(room),
      };
      const preflight = preflightClassicCommand(state, command, baseContext);
      if (!preflight.ok) {
        return mapClassicNodeFailure({
          io, logger, room, socketId, method: 'play', seat, bid: null, failure: preflight,
        });
      }
      const result = applyClassicCommand(state, command, { ...baseContext, deal: null });
      if (!result.ok) {
        return mapClassicNodeFailure({
          io, logger, room, socketId, method: 'play', seat, bid: null, failure: result,
        });
      }
      applyClassicState(room, result.state);
      room.classicRevision += 1;
      emitClassicEvents(io, room, result.events, logger);
      return compactSuccess(room, result);
    } catch (failure) {
      return mapClassicNodeFailure({
        io, logger, room, socketId, method: 'play', seat, bid: null, failure,
      });
    }
  }

  function runReadyCommand(room, request, method, disconnectOnly) {
    const socketId = request?.socketId;
    const seat = authoritativeSeat(room, socketId, request?.seat);
    try {
      const state = projectClassicState(room);
      const command = {
        name: 'classic.ready-next',
        payload: { expectedRevision: room.classicRevision },
      };
      const baseContext = {
        actor: actorFor(room, socketId, seat), occupiedSeats: occupiedSeats(room),
      };
      if (disconnectOnly && state.phase === 'SCORING'
          && seat !== null && state.readyStatus[seat] === false) {
        return { ok: true, phase: state.phase, revision: room.classicRevision };
      }
      const preflight = preflightClassicCommand(state, command, baseContext);
      if (!preflight.ok) {
        return mapClassicNodeFailure({
          io, logger, room, socketId, method, seat, bid: null,
          failure: preflight,
        });
      }
      if (disconnectOnly && preflight.needsDeal) {
        throw new ClassicInvariantError('disconnect readiness clear cannot start a deal');
      }
      const deal = !disconnectOnly && preflight.needsDeal
        ? dealFactory({ dealNumber: preflight.nextDealNumber })
        : null;
      const result = applyClassicCommand(state, command, { ...baseContext, deal });
      if (!result.ok) {
        return mapClassicNodeFailure({
          io, logger, room, socketId, method, seat, bid: null,
          failure: result,
        });
      }
      applyClassicState(room, result.state);
      room.classicRevision += 1;
      if (preflight.needsDeal) {
        room.claimReq = null;
        room.viewReq = null;
      }
      emitClassicEvents(io, room, result.events, logger);
      launchEffects(room, result.effects);
      return compactSuccess(room, result);
    } catch (failure) {
      return mapClassicNodeFailure({
        io, logger, room, socketId, method, seat, bid: null, failure,
      });
    }
  }

  function readyNext(room, request = {}) {
    return runReadyCommand(room, request, 'readyNext', false);
  }

  function clearReadyForDisconnect(room, request = {}) {
    return runReadyCommand(room, request, 'clearReadyForDisconnect', true);
  }

  function compatFailure(room, request, method, seat, failure) {
    return mapClassicNodeFailure({
      io, logger, room, socketId: request?.socketId, method, seat, bid: null, failure,
    });
  }

  function annotationEvent(state) {
    return {
      name: 'classic.bidding-updated',
      payload: {
        biddingHistory: cloneValue(state.biddingHistory),
        currentBidder: state.currentBidder,
        currentContract: cloneValue(state.currentContract),
        consecutivePasses: state.consecutivePasses,
      },
    };
  }

  function commitAcceptedClaim(room, payload, failureRequest, method) {
    try {
      const state = projectClassicState(room);
      const result = settleClassicClaim(state, {
        claimer: payload.claimer,
        tricksToWin: payload.tricksToWin,
        reason: payload.reason,
      });
      if (!result.ok) {
        return compatFailure(room, failureRequest, method, payload.claimer, result);
      }

      const partial = state.currentTrick.length === 0 ? null : {
        cards: cloneValue(state.currentTrick), winner: payload.claimer, claimed: true,
      };
      const replayPartials = cloneValue(room.classicClaimedPartialTricks || {});
      if (partial && !Object.hasOwn(replayPartials, state.dealNumber)) {
        replayPartials[state.dealNumber] = partial;
      }
      applyClassicState(room, result.state);
      room.classicRevision += 1;
      room.claimReq = null;
      room.lastClaim = {
        claimer: payload.claimer,
        tricksToWin: payload.tricksToWin,
        reason: payload.reason,
      };
      room.classicClaimedPartialTricks = replayPartials;
      safeEmit(io, room.id, 'claimResult', {
        accepted: true,
        tricksToWin: payload.tricksToWin,
        claimer: payload.claimer,
      }, logger);
      emitClassicEvents(io, room, result.events, logger);
      return compactSuccess(room, result);
    } catch (failure) {
      return compatFailure(room, failureRequest, method, payload?.claimer || null, failure);
    }
  }

  function settleClaim(room, request = {}) {
    const seat = authoritativeSeat(room, request?.socketId, request?.claimer);
    try {
      if (seat === null || seat !== request?.claimer || seat === room.dummy) {
        return compatFailure(room, request, 'settleClaim', seat, {
          ok: false, code: 'CLASSIC_FORBIDDEN',
        });
      }
      return commitAcceptedClaim(room, {
        claimer: seat,
        tricksToWin: request?.tricksToWin,
        reason: request?.reason,
      }, request, 'settleClaim');
    } catch (failure) {
      return compatFailure(room, request, 'settleClaim', seat, failure);
    }
  }

  function settleAcceptedClaim(room, claimRequest) {
    try {
      const isOwnedRequest = room?.claimReq === claimRequest;
      const voters = claimRequest?.voters;
      const votes = claimRequest?.votes;
      const unanimouslyAccepted = Array.isArray(voters)
        && voters.every(seat => SEATS.includes(seat) && votes?.[seat] === true);
      if (!isOwnedRequest || !unanimouslyAccepted) {
        return { ok: false, code: 'CLASSIC_FORBIDDEN' };
      }
      return commitAcceptedClaim(room, {
        claimer: claimRequest.claimer,
        tricksToWin: claimRequest.tricksToWin,
        reason: claimRequest.reason,
      }, {}, 'settleAcceptedClaim');
    } catch (failure) {
      return compatFailure(room, {}, 'settleAcceptedClaim', claimRequest?.claimer || null, failure);
    }
  }

  function editBidAnnotation(room, request = {}) {
    const seat = authoritativeSeat(room, request?.socketId, request?.seat);
    try {
      if (seat === null) return compatFailure(room, request, 'editBidAnnotation', seat, {
        ok: false, code: 'CLASSIC_FORBIDDEN',
      });
      const state = projectClassicState(room);
      const alerted = Boolean(request?.alert);
      const result = editClassicBidAnnotation(state, {
        seat,
        bidIndex: request?.bidIndex,
        alert: alerted,
        explain: alerted && request?.explain ? scalarText(request.explain) : null,
      });
      if (!result.ok) return compatFailure(room, request, 'editBidAnnotation', seat, result);
      applyClassicState(room, result.state);
      room.classicRevision += 1;
      emitClassicEvents(io, room, [annotationEvent(result.state)], logger);
      return compactSuccess(room, result);
    } catch (failure) {
      return compatFailure(room, request, 'editBidAnnotation', seat, failure);
    }
  }

  function appendBidQuestion(room, request = {}) {
    const seat = authoritativeSeat(room, request?.socketId, request?.seat);
    try {
      if (seat === null) return compatFailure(room, request, 'appendBidQuestion', seat, {
        ok: false, code: 'CLASSIC_FORBIDDEN',
      });
      const state = projectClassicState(room);
      const question = legacyText(request?.question);
      const result = appendClassicBidQuestion(state, {
        bidIndex: request?.bidIndex, asker: seat, question,
      });
      if (!result.ok) return compatFailure(room, request, 'appendBidQuestion', seat, result);
      const entry = result.state.biddingHistory[request.bidIndex];
      const qaIdx = entry.qa.length - 1;
      applyClassicState(room, result.state);
      room.classicRevision += 1;
      const bidderSock = room.sockets?.[entry.seat];
      if (bidderSock) safeEmit(io, bidderSock, 'bidQuestionRecv', {
        bidIndex: request.bidIndex,
        qaIdx,
        question,
        asker: seat,
        askerName: room.playerNames?.[seat],
      }, logger);
      return compactSuccess(room, result);
    } catch (failure) {
      return compatFailure(room, request, 'appendBidQuestion', seat, failure);
    }
  }

  function answerBidQuestion(room, request = {}) {
    const seat = authoritativeSeat(room, request?.socketId, request?.seat);
    try {
      if (seat === null) return compatFailure(room, request, 'answerBidQuestion', seat, {
        ok: false, code: 'CLASSIC_FORBIDDEN',
      });
      const state = projectClassicState(room);
      const existing = state.biddingHistory?.[request?.bidIndex];
      const existingQa = existing?.qa?.[request?.qaIdx];
      const answer = legacyText(request?.answer);
      const result = answerClassicBidQuestion(state, {
        bidIndex: request?.bidIndex, qaIdx: request?.qaIdx, answerer: seat, answer,
      });
      if (!result.ok) return compatFailure(room, request, 'answerBidQuestion', seat, result);
      applyClassicState(room, result.state);
      room.classicRevision += 1;
      const askerSock = room.sockets?.[existingQa.asker];
      if (askerSock) safeEmit(io, askerSock, 'bidAnswerRecv', {
        bidIndex: request.bidIndex,
        qaIdx: request.qaIdx,
        answer,
        answererName: room.playerNames?.[seat],
        bid: legacyBidToken(existing.bid),
      }, logger);
      return compactSuccess(room, result);
    } catch (failure) {
      return compatFailure(room, request, 'answerBidQuestion', seat, failure);
    }
  }

  return {
    initializeRoom, start, bid, play, readyNext, clearReadyForDisconnect,
    settleClaim, settleAcceptedClaim,
    editBidAnnotation, appendBidQuestion, answerBidQuestion,
  };
}

module.exports = {
  applyClassicState,
  createClassicNodeAdapter,
  emitClassicEvents,
  mapClassicNodeFailure,
  projectClassicState,
  sendClassicReconnectState,
};
