'use strict';

const { SEATS } = require('./constants.cjs');
const { ClassicInputError } = require('./engine.cjs');
const { ClassicInvariantError, validateClassicState } = require('./state.cjs');
const { sideOf } = require('./rules.cjs');

const VIEW_KEYS = Object.freeze([
  'schemaVersion', 'mode', 'phase', 'dealNumber', 'boardInfo', 'readyStatus',
  'biddingHistory', 'currentBidder', 'currentContract', 'consecutivePasses',
  'declarer', 'dummy', 'leader', 'currentPlayer', 'currentTrick', 'completedCount',
  'nsTricks', 'ewTricks', 'dummyRevealed', 'claimSettlement', 'boardScores',
  'ddTable', 'ddsStatus', 'hands',
]);

function hasExactOwnKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function input(condition, message) {
  if (!condition) throw new ClassicInputError(message);
}

function invariant(condition, message) {
  if (!condition) throw new ClassicInvariantError(message);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function validateViewer(viewer) {
  input(hasExactOwnKeys(viewer, ['role', 'seat']), 'viewer has an invalid shape');
  input(['OWNER', 'PLAYER', 'SPECTATOR'].includes(viewer.role), 'viewer role is invalid');
  if (viewer.role === 'PLAYER') input(SEATS.includes(viewer.seat), 'player viewer must have a seat');
  else if (viewer.role === 'SPECTATOR') input(viewer.seat === null, 'spectator viewer cannot have a seat');
  else input(viewer.seat === null || SEATS.includes(viewer.seat), 'owner viewer seat is invalid');
}

function seesFullAuctionEntry(viewer, bidder) {
  return viewer.seat === null || viewer.seat === bidder || sideOf(viewer.seat) !== sideOf(bidder);
}

function projectQa(qa) {
  invariant(Array.isArray(qa), 'auction Q&A is invalid');
  return qa.map(entry => ({
    asker: entry.asker,
    question: entry.question,
    answer: entry.answer,
    answerer: entry.answerer,
  }));
}

function projectAuctionEntry(entry, viewer) {
  if (!seesFullAuctionEntry(viewer, entry.seat)) return { seat: entry.seat, bid: entry.bid };
  return {
    seat: entry.seat,
    bid: entry.bid,
    alert: entry.alert,
    explain: entry.explain,
    qa: projectQa(entry.qa),
  };
}

function projectAuction(history, viewer) {
  invariant(Array.isArray(history), 'auction history is invalid');
  return history.map(entry => projectAuctionEntry(entry, viewer));
}

function projectContract(contract) {
  if (contract === null) return null;
  return {
    level: contract.level,
    suit: contract.suit,
    seat: contract.seat,
    doubled: contract.doubled,
    redoubled: contract.redoubled,
    doublerSeat: contract.doublerSeat,
  };
}

function projectClaim(claim) {
  if (claim === null) return null;
  return {
    claimer: claim.claimer,
    tricksToWin: claim.tricksToWin,
    reason: claim.reason,
  };
}

function projectScore(score, viewer) {
  invariant(score && typeof score === 'object' && !Array.isArray(score), 'score is invalid');
  if (score.passedOut === true) {
    return {
      dealNumber: score.dealNumber,
      boardNumber: score.boardNumber,
      score: score.score,
      passedOut: true,
      ddTable: cloneValue(score.ddTable),
      biddingHistory: projectAuction(score.biddingHistory, viewer),
    };
  }
  return {
    dealNumber: score.dealNumber,
    boardNumber: score.boardNumber,
    passedOut: false,
    contract: projectContract(score.contract),
    declarer: score.declarer,
    dummy: score.dummy,
    declarerTricks: score.declarerTricks,
    needed: score.needed,
    score: score.score,
    made: score.made,
    diff: score.diff,
    vulnerability: score.vulnerability,
    biddingHistory: projectAuction(score.biddingHistory, viewer),
    completedTricks: cloneValue(score.completedTricks),
    ddTable: cloneValue(score.ddTable),
    claim: projectClaim(score.claim),
  };
}

function visibleHand(state, viewer, seat) {
  if (viewer.seat === seat) return cloneValue(state.hands[seat]);
  if (state.dummyRevealed && state.dummy === seat) return cloneValue(state.hands[seat]);
  return null;
}

function classicViewFor(state, viewer) {
  validateViewer(viewer);
  validateClassicState(state);
  const result = {
    schemaVersion: state.schemaVersion,
    mode: state.mode,
    phase: state.phase,
    dealNumber: state.dealNumber,
    boardInfo: cloneValue(state.boardInfo),
    readyStatus: cloneValue(state.readyStatus),
    biddingHistory: projectAuction(state.biddingHistory, viewer),
    currentBidder: state.currentBidder,
    currentContract: projectContract(state.currentContract),
    consecutivePasses: state.consecutivePasses,
    declarer: state.declarer,
    dummy: state.dummy,
    leader: state.leader,
    currentPlayer: state.currentPlayer,
    currentTrick: cloneValue(state.currentTrick),
    completedCount: state.completedTricks.length,
    nsTricks: state.nsTricks,
    ewTricks: state.ewTricks,
    dummyRevealed: state.dummyRevealed,
    claimSettlement: cloneValue(state.claimSettlement),
    boardScores: state.boardScores.map(score => projectScore(score, viewer)),
    ddTable: cloneValue(state.ddTable),
    ddsStatus: state.ddsStatus,
    hands: Object.fromEntries(SEATS.map(seat => [seat, visibleHand(state, viewer, seat)])),
  };
  invariant(Object.keys(result).length === VIEW_KEYS.length, 'view construction failed');
  return result;
}

function exactEvent(event, payloadKeys) {
  invariant(hasExactOwnKeys(event, ['name', 'payload']), 'event has an invalid shape');
  invariant(hasExactOwnKeys(event.payload, payloadKeys), 'event payload has an invalid shape');
}

function projectFinished(event) {
  const { payload } = event;
  if (payload?.reason === 'passed-out') {
    exactEvent(event, ['reason', 'dealNumber', 'score']);
    return { name: event.name, payload: {
      reason: 'passed-out', dealNumber: payload.dealNumber, score: payload.score,
    } };
  }
  const baseKeys = ['reason', 'dealNumber', 'contract', 'declarer', 'nsTricks', 'ewTricks', 'score'];
  if (payload?.reason === 'played') exactEvent(event, baseKeys);
  else if (payload?.reason === 'claimed') exactEvent(event, [...baseKeys, 'claim']);
  else throw new ClassicInvariantError('finished event reason is invalid');
  const projected = {
    reason: payload.reason,
    dealNumber: payload.dealNumber,
    contract: projectContract(payload.contract),
    declarer: payload.declarer,
    nsTricks: payload.nsTricks,
    ewTricks: payload.ewTricks,
    score: payload.score,
  };
  if (payload.reason === 'claimed') projected.claim = projectClaim(payload.claim);
  return { name: event.name, payload: projected };
}

function classicEventFor(event, viewer) {
  validateViewer(viewer);
  invariant(event && typeof event === 'object' && !Array.isArray(event), 'event is invalid');
  if (event.name === 'classic.bidding-updated') {
    exactEvent(event, ['biddingHistory', 'currentBidder', 'currentContract', 'consecutivePasses']);
    return { name: event.name, payload: {
      biddingHistory: projectAuction(event.payload.biddingHistory, viewer),
      currentBidder: event.payload.currentBidder,
      currentContract: projectContract(event.payload.currentContract),
      consecutivePasses: event.payload.consecutivePasses,
    } };
  }
  if (event.name === 'classic.bidding-ended') {
    exactEvent(event, ['contract', 'declarer', 'dummy', 'leader', 'biddingHistory']);
    return { name: event.name, payload: {
      contract: projectContract(event.payload.contract),
      declarer: event.payload.declarer,
      dummy: event.payload.dummy,
      leader: event.payload.leader,
      biddingHistory: projectAuction(event.payload.biddingHistory, viewer),
    } };
  }
  if (event.name === 'classic.finished') return projectFinished(event);

  const schemas = {
    'classic.started': ['dealNumber', 'boardInfo'],
    'classic.dummy-revealed': ['dummy'],
    'classic.card-played': ['seat', 'card', 'currentTrick'],
    'classic.trick-ended': ['trick', 'winner', 'nsTricks', 'ewTricks'],
    'classic.ready-updated': ['readyStatus'],
    'classic.dd-table-ready': ['dealNumber', 'ddTable'],
  };
  invariant(Object.hasOwn(schemas, event.name), 'event name is invalid');
  exactEvent(event, schemas[event.name]);
  return cloneValue(event);
}

module.exports = { classicViewFor, classicEventFor };
