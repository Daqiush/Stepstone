'use strict';

const { SEATS } = require('./constants.cjs');
const { sideOf } = require('./rules.cjs');
const { ClassicInvariantError, validateClassicState } = require('./state.cjs');

const CONTRACT_KEYS = Object.freeze(['level', 'suit', 'seat', 'doubled', 'redoubled', 'doublerSeat']);

function invariant(condition, message) {
  if (!condition) throw new ClassicInvariantError(message);
}

function hasExactOwnKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function isBoundedText(value) {
  return typeof value === 'string' && [...value].length <= 500;
}

function validateScoreContract(contract) {
  invariant(hasExactOwnKeys(contract, CONTRACT_KEYS), 'contract has an invalid shape');
  invariant(Number.isInteger(contract.level) && contract.level >= 1 && contract.level <= 7,
    'contract level is invalid');
  invariant(['C', 'D', 'H', 'S', 'NT'].includes(contract.suit), 'contract suit is invalid');
  invariant(SEATS.includes(contract.seat), 'contract seat is invalid');
  invariant(typeof contract.doubled === 'boolean' && typeof contract.redoubled === 'boolean',
    'contract doubling flags are invalid');
  if (!contract.doubled) {
    invariant(!contract.redoubled && contract.doublerSeat === null,
      'contract doubling state is inconsistent');
  } else {
    invariant(SEATS.includes(contract.doublerSeat), 'contract doubler seat is invalid');
    const sameSide = sideOf(contract.doublerSeat) === sideOf(contract.seat);
    invariant(contract.redoubled ? sameSide : !sameSide, 'contract doubler ownership is inconsistent');
  }
}

function isVulnerable(vulnerability, declaringSide) {
  return vulnerability === 'BOTH' || vulnerability === declaringSide;
}

function calculateDuplicateScore(contract, declarerTricks, vulnerability) {
  validateScoreContract(contract);
  invariant(Number.isSafeInteger(declarerTricks) && declarerTricks >= 0 && declarerTricks <= 13,
    'declarer trick count is invalid');
  invariant(['NONE', 'NS', 'EW', 'BOTH'].includes(vulnerability), 'vulnerability is invalid');
  const vulnerable = isVulnerable(vulnerability, sideOf(contract.seat));
  const needed = contract.level + 6;
  if (declarerTricks < needed) {
    const undertricks = needed - declarerTricks;
    if (!contract.doubled && !contract.redoubled) {
      return -undertricks * (vulnerable ? 100 : 50);
    }
    let doubledPenalty;
    if (vulnerable) {
      doubledPenalty = undertricks === 1 ? 200 : 200 + (undertricks - 1) * 300;
    } else if (undertricks === 1) {
      doubledPenalty = 100;
    } else if (undertricks === 2) {
      doubledPenalty = 300;
    } else if (undertricks === 3) {
      doubledPenalty = 500;
    } else {
      doubledPenalty = 500 + (undertricks - 3) * 300;
    }
    return -(contract.redoubled ? doubledPenalty * 2 : doubledPenalty);
  }

  const overtricks = declarerTricks - needed;
  let trickScore;
  if (contract.suit === 'NT') trickScore = 40 + 30 * (contract.level - 1);
  else if (contract.suit === 'H' || contract.suit === 'S') trickScore = 30 * contract.level;
  else trickScore = 20 * contract.level;

  if (contract.doubled) trickScore *= 2;
  if (contract.redoubled) trickScore *= 4;

  let score = trickScore + (trickScore >= 100 ? (vulnerable ? 500 : 300) : 50);
  if (contract.level === 6) score += vulnerable ? 750 : 500;
  if (contract.level === 7) score += vulnerable ? 1500 : 1000;
  if (contract.doubled) score += 50;
  if (contract.redoubled) score += 100;
  if (overtricks > 0) {
    if (!contract.doubled && !contract.redoubled) {
      score += overtricks * (contract.suit === 'C' || contract.suit === 'D' ? 20 : 30);
    } else {
      score += overtricks * (vulnerable ? 200 : 100) * (contract.redoubled ? 2 : 1);
    }
  }
  return score;
}

function validateFinish(finish) {
  invariant(finish && typeof finish === 'object' && !Array.isArray(finish),
    'finish must be an object');
  if (finish.type === 'passed-out' || finish.type === 'played') {
    invariant(hasExactOwnKeys(finish, ['type']), 'finish has an invalid shape');
    return;
  }
  invariant(finish.type === 'claimed' && hasExactOwnKeys(finish, ['type', 'claim']),
    'finish has an invalid shape');
  invariant(hasExactOwnKeys(finish.claim, ['claimer', 'tricksToWin', 'reason']),
    'claim finish has an invalid shape');
  invariant(SEATS.includes(finish.claim.claimer), 'claim finish claimer is invalid');
  invariant(Number.isSafeInteger(finish.claim.tricksToWin)
    && finish.claim.tricksToWin >= 0 && finish.claim.tricksToWin <= 13,
  'claim finish trick count is invalid');
  invariant(isBoundedText(finish.claim.reason), 'claim finish reason is invalid');
}

function passedOutScore(state) {
  return {
    dealNumber: state.dealNumber,
    boardNumber: state.boardInfo.number,
    score: 0,
    passedOut: true,
    ddTable: cloneValue(state.ddTable),
    biddingHistory: cloneValue(state.biddingHistory),
    initialHands: cloneValue(state.initialHands),
  };
}

function playedScore(state, claim) {
  invariant(state.currentContract && typeof state.currentContract === 'object',
    'played finish requires a contract');
  invariant(SEATS.includes(state.declarer) && SEATS.includes(state.dummy),
    'played finish requires declarer and dummy');
  invariant(Number.isSafeInteger(state.nsTricks) && Number.isSafeInteger(state.ewTricks),
    'played finish trick totals are invalid');
  const declarerTricks = sideOf(state.declarer) === 'NS' ? state.nsTricks : state.ewTricks;
  const needed = state.currentContract.level + 6;
  return {
    dealNumber: state.dealNumber,
    boardNumber: state.boardInfo.number,
    passedOut: false,
    contract: cloneValue(state.currentContract),
    declarer: state.declarer,
    dummy: state.dummy,
    declarerTricks,
    needed,
    score: calculateDuplicateScore(state.currentContract, declarerTricks, state.boardInfo.vul),
    made: declarerTricks >= needed,
    diff: declarerTricks - needed,
    vulnerability: state.boardInfo.vul,
    biddingHistory: cloneValue(state.biddingHistory),
    completedTricks: cloneValue(state.completedTricks),
    initialHands: cloneValue(state.initialHands),
    ddTable: cloneValue(state.ddTable),
    claim: cloneValue(claim),
  };
}

function buildBoardScore(state, finish) {
  try {
    validateFinish(finish);
    invariant(state && typeof state === 'object' && !Array.isArray(state), 'state must be an object');
    invariant(finish.type === 'passed-out' ? state.phase === 'BIDDING' : state.phase === 'PLAYING',
      'finish does not match the state phase');
    invariant(state.currentBidder === null, 'finished auction must not have a current bidder');
    invariant(state.claimSettlement === null, 'finish state must not already contain a claim settlement');
    invariant(SEATS.every(seat => state.readyStatus?.[seat] === false),
      'pre-scoring readiness must be false');

    const score = finish.type === 'passed-out'
      ? passedOutScore(state)
      : playedScore(state, finish.type === 'claimed' ? finish.claim : null);
    const completed = cloneValue(state);
    completed.phase = 'SCORING';
    completed.currentBidder = null;
    completed.boardScores = [...completed.boardScores, cloneValue(score)];
    if (finish.type === 'claimed') {
      completed.claimSettlement = {
        ...cloneValue(finish.claim),
        completedAtClaim: completed.completedTricks.length,
      };
    } else {
      completed.claimSettlement = null;
    }
    validateClassicState(completed);
    return score;
  } catch (error) {
    if (error instanceof ClassicInvariantError) throw error;
    throw new ClassicInvariantError('classic finish state is malformed');
  }
}

module.exports = { calculateDuplicateScore, buildBoardScore };
