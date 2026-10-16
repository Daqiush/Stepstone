'use strict';

const { SEATS } = require('./constants.cjs');
const { ClassicInputError } = require('./engine.cjs');
const { ClassicInvariantError, validateClassicState } = require('./state.cjs');
const { sideOf } = require('./rules.cjs');
const { buildBoardScore } = require('./scoring.cjs');

function hasExactOwnKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function input(condition, message) {
  if (!condition) throw new ClassicInputError(message);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function boundedText(value) {
  return typeof value === 'string' && [...value].length <= 500;
}

function withAuctionHistory(state, biddingHistory) {
  if (state.phase !== 'SCORING') return { ...state, biddingHistory };
  const boardScores = [...state.boardScores];
  const latestIndex = boardScores.length - 1;
  boardScores[latestIndex] = {
    ...boardScores[latestIndex],
    biddingHistory: cloneValue(biddingHistory),
  };
  return { ...state, biddingHistory, boardScores };
}

function settleClassicClaim(state, payload) {
  input(hasExactOwnKeys(payload, ['claimer', 'tricksToWin', 'reason']),
    'claim payload has an invalid shape');
  input(SEATS.includes(payload.claimer), 'claim claimer is invalid');
  input(Number.isSafeInteger(payload.tricksToWin)
    && payload.tricksToWin >= 0 && payload.tricksToWin <= 13,
    'claim trick count is invalid');
  input(boundedText(payload.reason), 'claim reason is invalid');
  validateClassicState(state);
  if (state.phase !== 'PLAYING') return { ok: false, code: 'CLASSIC_WRONG_PHASE' };

  const remaining = 13 - state.completedTricks.length;
  input(payload.tricksToWin <= remaining, 'claim cannot partition the remaining tricks');
  const claimerNs = sideOf(payload.claimer) === 'NS';
  const nsAward = claimerNs ? payload.tricksToWin : remaining - payload.tricksToWin;
  const ewAward = remaining - nsAward;
  const awarded = {
    ...state,
    nsTricks: state.nsTricks + nsAward,
    ewTricks: state.ewTricks + ewAward,
  };
  const claim = cloneValue(payload);
  const score = buildBoardScore(awarded, { type: 'claimed', claim });
  const next = {
    ...awarded,
    phase: 'SCORING',
    claimSettlement: { ...cloneValue(claim), completedAtClaim: state.completedTricks.length },
    boardScores: [...state.boardScores, cloneValue(score)],
  };
  validateClassicState(next);
  return {
    ok: true,
    state: next,
    events: [{
      name: 'classic.finished',
      payload: {
        reason: 'claimed',
        dealNumber: next.dealNumber,
        contract: cloneValue(next.currentContract),
        declarer: next.declarer,
        nsTricks: next.nsTricks,
        ewTricks: next.ewTricks,
        score: score.score,
        claim: cloneValue(claim),
      },
    }],
    effects: [],
    reply: { name: 'classic.claim-settled', phase: 'SCORING' },
  };
}

function editClassicBidAnnotation(state, payload) {
  input(hasExactOwnKeys(payload, ['seat', 'bidIndex', 'alert', 'explain']),
    'annotation payload has an invalid shape');
  input(SEATS.includes(payload.seat), 'annotation seat is invalid');
  input(Number.isSafeInteger(payload.bidIndex) && payload.bidIndex >= 0,
    'annotation bid index is invalid');
  input(typeof payload.alert === 'boolean', 'annotation alert flag is invalid');
  input(payload.explain === null || boundedText(payload.explain),
    'annotation explanation is invalid');
  validateClassicState(state);
  input(payload.bidIndex < state.biddingHistory.length, 'annotation bid index is out of range');
  if (state.phase !== 'BIDDING') return { ok: false, code: 'CLASSIC_WRONG_PHASE' };
  const existing = state.biddingHistory[payload.bidIndex];
  if (existing.seat !== payload.seat) return { ok: false, code: 'CLASSIC_FORBIDDEN' };

  const entry = {
    ...existing,
    alert: payload.alert ? true : null,
    explain: payload.alert ? payload.explain : null,
  };
  const history = [...state.biddingHistory];
  history[payload.bidIndex] = entry;
  const next = withAuctionHistory(state, history);
  validateClassicState(next);
  return {
    ok: true,
    state: next,
    events: [],
    effects: [],
    reply: { name: 'classic.bid-annotation-edited', phase: 'BIDDING' },
  };
}

function appendClassicBidQuestion(state, payload) {
  input(hasExactOwnKeys(payload, ['bidIndex', 'asker', 'question']),
    'question payload has an invalid shape');
  input(Number.isSafeInteger(payload.bidIndex) && payload.bidIndex >= 0,
    'question bid index is invalid');
  input(SEATS.includes(payload.asker), 'question asker is invalid');
  input(boundedText(payload.question), 'question text is invalid');
  validateClassicState(state);
  input(payload.bidIndex < state.biddingHistory.length, 'question bid index is out of range');
  const existing = state.biddingHistory[payload.bidIndex];
  if (sideOf(payload.asker) === sideOf(existing.seat)) {
    return { ok: false, code: 'CLASSIC_FORBIDDEN' };
  }
  const qa = [...existing.qa, {
    asker: payload.asker,
    question: payload.question,
    answer: null,
    answerer: null,
  }];
  const history = [...state.biddingHistory];
  history[payload.bidIndex] = { ...existing, qa };
  const next = withAuctionHistory(state, history);
  validateClassicState(next);
  return {
    ok: true,
    state: next,
    events: [],
    effects: [],
    reply: { name: 'classic.bid-question-added', phase: state.phase },
  };
}

function answerClassicBidQuestion(state, payload) {
  input(hasExactOwnKeys(payload, ['bidIndex', 'qaIdx', 'answerer', 'answer']),
    'answer payload has an invalid shape');
  input(Number.isSafeInteger(payload.bidIndex) && payload.bidIndex >= 0,
    'answer bid index is invalid');
  input(Number.isSafeInteger(payload.qaIdx) && payload.qaIdx >= 0,
    'answer Q&A index is invalid');
  input(SEATS.includes(payload.answerer), 'answerer is invalid');
  input(boundedText(payload.answer), 'answer text is invalid');
  validateClassicState(state);
  input(payload.bidIndex < state.biddingHistory.length, 'answer bid index is out of range');
  const existing = state.biddingHistory[payload.bidIndex];
  input(payload.qaIdx < existing.qa.length, 'answer Q&A index is out of range');
  const existingQa = existing.qa[payload.qaIdx];
  input(existingQa.answer === null && existingQa.answerer === null,
    'question has already been answered');
  if (payload.answerer !== existing.seat) return { ok: false, code: 'CLASSIC_FORBIDDEN' };

  const qa = [...existing.qa];
  qa[payload.qaIdx] = {
    ...existingQa,
    answer: payload.answer,
    answerer: payload.answerer,
  };
  const history = [...state.biddingHistory];
  history[payload.bidIndex] = { ...existing, qa };
  const next = withAuctionHistory(state, history);
  validateClassicState(next);
  return {
    ok: true,
    state: next,
    events: [],
    effects: [],
    reply: { name: 'classic.bid-question-answered', phase: state.phase },
  };
}

function isDenseExactArray(value, length) {
  if (!Array.isArray(value) || value.length !== length) return false;
  const expected = [...Array.from({ length }, (_, index) => String(index)), 'length'];
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && expected.every(key => Object.hasOwn(value, key))
    && keys.every(key => typeof key === 'string' && expected.includes(key));
}

function isDdsTable(table) {
  return isDenseExactArray(table, 5)
    && table.every(row => isDenseExactArray(row, 4)
      && row.every(value => Number.isInteger(value) && value >= 0 && value <= 13));
}

function applyClassicDdsCompletion(state, payload) {
  input(hasExactOwnKeys(payload, ['dealNumber', 'ddTable', 'failed']),
    'DDS completion payload has an invalid shape');
  input(Number.isSafeInteger(payload.dealNumber) && payload.dealNumber > 0,
    'DDS completion deal number is invalid');
  input(typeof payload.failed === 'boolean', 'DDS completion failure flag is invalid');
  validateClassicState(state);
  if (payload.failed) {
    if (payload.ddTable !== null) {
      throw new ClassicInvariantError('failed DDS completion must not contain a table');
    }
  } else if (!isDdsTable(payload.ddTable)) {
    throw new ClassicInvariantError('DDS completion table is invalid');
  }

  if (payload.dealNumber !== state.dealNumber || state.ddsStatus !== 'PENDING') {
    return {
      ok: true,
      state: cloneValue(state),
      events: [],
      effects: [],
      reply: { name: 'classic.dd-ignored', phase: state.phase },
    };
  }

  const next = cloneValue(state);
  if (payload.failed) {
    next.ddTable = null;
    next.ddsStatus = 'FAILED';
    validateClassicState(next);
    return {
      ok: true,
      state: next,
      events: [],
      effects: [],
      reply: { name: 'classic.dd-failed', phase: state.phase },
    };
  }

  next.ddTable = cloneValue(payload.ddTable);
  next.ddsStatus = 'READY';
  validateClassicState(next);
  return {
    ok: true,
    state: next,
    events: [{
      name: 'classic.dd-table-ready',
      payload: { dealNumber: payload.dealNumber, ddTable: cloneValue(payload.ddTable) },
    }],
    effects: [],
    reply: { name: 'classic.dd-completed', phase: state.phase },
  };
}

module.exports = {
  settleClassicClaim,
  editClassicBidAnnotation,
  appendClassicBidQuestion,
  answerClassicBidQuestion,
  applyClassicDdsCompletion,
};
