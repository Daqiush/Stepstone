'use strict';

const { SEATS, SUITS, RANKS } = require('./constants.cjs');
const {
  boardInfoFor, parseBid, sideOf, nextSeat, partnerOf, validateBid, trickWinner,
  declarerFor,
} = require('./rules.cjs');

const PHASES = Object.freeze(['LOBBY', 'BIDDING', 'PLAYING', 'SCORING']);
const DDS_STATUSES = Object.freeze(['IDLE', 'PENDING', 'READY', 'FAILED']);
const BOARD_INFO_KEYS = Object.freeze(['number', 'dealNumber', 'vul', 'dealer']);
const CONTRACT_KEYS = Object.freeze(['level', 'suit', 'seat', 'doubled', 'redoubled', 'doublerSeat']);
const AUCTION_ENTRY_KEYS = Object.freeze(['seat', 'bid', 'alert', 'explain', 'qa']);
const QA_KEYS = Object.freeze(['asker', 'question', 'answer', 'answerer']);
const TRICK_KEYS = Object.freeze(['cards', 'winner']);
const PLAY_KEYS = Object.freeze(['seat', 'card']);
const CLAIM_SETTLEMENT_KEYS = Object.freeze(['claimer', 'tricksToWin', 'reason', 'completedAtClaim']);
const PASSED_SCORE_KEYS = Object.freeze([
  'dealNumber', 'boardNumber', 'score', 'passedOut', 'ddTable', 'biddingHistory', 'initialHands',
]);
const PLAYED_SCORE_KEYS = Object.freeze([
  'dealNumber', 'boardNumber', 'passedOut', 'contract', 'declarer', 'dummy',
  'declarerTricks', 'needed', 'score', 'made', 'diff', 'vulnerability', 'biddingHistory',
  'completedTricks', 'initialHands', 'ddTable', 'claim',
]);
const CLAIM_KEYS = Object.freeze(['claimer', 'tricksToWin', 'reason']);

const CLASSIC_STATE_KEYS = Object.freeze([
  'schemaVersion', 'mode', 'phase', 'dealNumber', 'boardInfo', 'hands', 'initialHands',
  'readyStatus', 'biddingHistory', 'currentBidder', 'currentContract', 'consecutivePasses',
  'declarer', 'dummy', 'leader', 'currentPlayer', 'currentTrick', 'completedTricks',
  'nsTricks', 'ewTricks', 'dummyRevealed', 'claimSettlement', 'boardScores', 'ddTable',
  'ddsStatus',
]);

function emptyHands() {
  return { N: [], E: [], S: [], W: [] };
}

function hasExactOwnKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

class ClassicInvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClassicInvariantError';
    this.kind = 'TRUSTED_STATE';
  }
}

function invariant(condition, message) {
  if (!condition) throw new ClassicInvariantError(message);
}

function isBoundedText(value) {
  return typeof value === 'string' && [...value].length <= 500;
}

function isCanonicalCard(card) {
  return hasExactOwnKeys(card, ['suit', 'rank'])
    && SUITS.includes(card.suit)
    && RANKS.includes(card.rank);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function cardKey(card) {
  return `${card.suit}${card.rank}`;
}

function validateBoardInfo(boardInfo, dealNumber) {
  invariant(hasExactOwnKeys(boardInfo, BOARD_INFO_KEYS), 'boardInfo has an invalid shape');
  invariant(Number.isSafeInteger(boardInfo.dealNumber) && boardInfo.dealNumber > 0,
    'boardInfo deal number is invalid');
  const expected = boardInfoFor(boardInfo.dealNumber);
  invariant(BOARD_INFO_KEYS.every(key => boardInfo[key] === expected[key]),
    'boardInfo does not match the duplicate board cycle');
  invariant(boardInfo.dealNumber === dealNumber, 'boardInfo deal number does not match state');
}

function validateCardMap(hands, { initial = false } = {}) {
  invariant(hasExactOwnKeys(hands, SEATS), 'hands have an invalid shape');
  const seen = new Set();
  for (const seat of SEATS) {
    invariant(Array.isArray(hands[seat]), 'hand must be an array');
    if (initial) invariant(hands[seat].length === 13, 'initial hand must contain 13 cards');
    for (const card of hands[seat]) {
      invariant(isCanonicalCard(card), 'hand contains a non-canonical card');
      const key = cardKey(card);
      invariant(!seen.has(key), 'hands contain a duplicate card');
      seen.add(key);
    }
  }
  if (initial) invariant(seen.size === 52, 'initial hands must contain all 52 cards');
  return seen;
}

function validateContract(contract) {
  if (contract === null) return;
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

function validateQa(qa) {
  invariant(hasExactOwnKeys(qa, QA_KEYS), 'auction Q&A has an invalid shape');
  invariant(SEATS.includes(qa.asker), 'auction Q&A asker is invalid');
  invariant(isBoundedText(qa.question), 'auction Q&A question is invalid');
  invariant(qa.answer === null || isBoundedText(qa.answer), 'auction Q&A answer is invalid');
  invariant(qa.answerer === null || SEATS.includes(qa.answerer), 'auction Q&A answerer is invalid');
  invariant((qa.answer === null) === (qa.answerer === null), 'auction Q&A answer fields are inconsistent');
}

function validateAuction(history) {
  invariant(Array.isArray(history), 'biddingHistory must be an array');
  for (const entry of history) {
    invariant(hasExactOwnKeys(entry, AUCTION_ENTRY_KEYS), 'auction entry has an invalid shape');
    invariant(SEATS.includes(entry.seat) && parseBid(entry.bid), 'auction call is invalid');
    invariant(entry.alert === true || entry.alert === null, 'auction alert is invalid');
    invariant(entry.explain === null || isBoundedText(entry.explain), 'auction explanation is invalid');
    invariant(entry.alert === true || entry.explain === null, 'unalerted call cannot have an explanation');
    invariant(Array.isArray(entry.qa), 'auction Q&A must be an array');
    entry.qa.forEach(validateQa);
  }
}

function deriveAuction(history, dealer) {
  let contract = null;
  let passes = 0;
  for (let index = 0; index < history.length; index++) {
    const entry = history[index];
    const expectedSeat = SEATS[(SEATS.indexOf(dealer) + index) % SEATS.length];
    invariant(entry.seat === expectedSeat, 'auction seat order is invalid');
    const result = validateBid({ currentContract: contract }, entry.seat, entry.bid);
    invariant(result.ok, 'auction contains an illegal call');
    const parsed = parseBid(entry.bid);
    if (parsed.kind === 'pass') {
      passes += 1;
    } else {
      passes = 0;
      if (parsed.kind === 'contract') {
        contract = {
          level: parsed.level,
          suit: parsed.suit,
          seat: entry.seat,
          doubled: false,
          redoubled: false,
          doublerSeat: null,
        };
      } else if (parsed.kind === 'double') {
        contract = { ...contract, doubled: true, doublerSeat: entry.seat };
      } else {
        contract = { ...contract, redoubled: true, doublerSeat: entry.seat };
      }
    }
  }
  return { contract, passes };
}

function validateDdsTable(table) {
  const exactArray = (value, length) => Array.isArray(value)
    && value.length === length
    && Reflect.ownKeys(value).length === length + 1
    && Array.from({ length }, (_, index) => String(index)).every(key => Object.hasOwn(value, key));
  return exactArray(table, 5)
    && table.every(row => exactArray(row, 4)
      && row.every(value => Number.isInteger(value) && value >= 0 && value <= 13));
}

function validatePlay(play) {
  invariant(hasExactOwnKeys(play, PLAY_KEYS), 'play has an invalid shape');
  invariant(SEATS.includes(play.seat) && isCanonicalCard(play.card), 'play is invalid');
}

function validateTrick(trick, trumpSuit) {
  invariant(hasExactOwnKeys(trick, TRICK_KEYS), 'completed trick has an invalid shape');
  invariant(Array.isArray(trick.cards) && trick.cards.length === 4, 'completed trick must have four cards');
  trick.cards.forEach(validatePlay);
  invariant(new Set(trick.cards.map(play => play.seat)).size === 4,
    'completed trick must contain four seats');
  invariant(SEATS.includes(trick.winner), 'completed trick winner is invalid');
  invariant(trickWinner(trick.cards, trumpSuit) === trick.winner, 'completed trick winner is incorrect');
}

function validateClaim(claim) {
  if (claim === null) return;
  invariant(hasExactOwnKeys(claim, CLAIM_KEYS), 'claim metadata has an invalid shape');
  invariant(SEATS.includes(claim.claimer), 'claim metadata claimer is invalid');
  invariant(Number.isSafeInteger(claim.tricksToWin) && claim.tricksToWin >= 0 && claim.tricksToWin <= 13,
    'claim metadata trick count is invalid');
  invariant(isBoundedText(claim.reason), 'claim metadata reason is invalid');
}

function validateScoreTrickHistory(score) {
  let expectedLeader = nextSeat(score.declarer);
  for (const trick of score.completedTricks) {
    invariant(trick.cards[0].seat === expectedLeader, 'score trick leader is invalid');
    for (let index = 0; index < trick.cards.length; index++) {
      const play = trick.cards[index];
      if (index > 0) {
        invariant(play.seat === nextSeat(trick.cards[index - 1].seat),
          'score trick play order is invalid');
      }
    }
    expectedLeader = trick.winner;
  }
  replayPlayHistory(score.initialHands, score.completedTricks, []);
}

function validateBoardScore(score) {
  invariant(score && typeof score === 'object' && !Array.isArray(score), 'board score is invalid');
  invariant(Number.isSafeInteger(score.dealNumber) && score.dealNumber > 0, 'score deal number is invalid');
  invariant(Number.isInteger(score.boardNumber) && score.boardNumber >= 1 && score.boardNumber <= 16,
    'score board number is invalid');
  invariant(score.boardNumber === ((score.dealNumber - 1) % 16) + 1, 'score board cycle is invalid');
  if (score.passedOut === true) {
    invariant(hasExactOwnKeys(score, PASSED_SCORE_KEYS), 'passed-out score has an invalid shape');
    invariant(score.score === 0, 'passed-out score must be zero');
    validateAuction(score.biddingHistory);
    const auction = deriveAuction(score.biddingHistory, boardInfoFor(score.dealNumber).dealer);
    invariant(score.biddingHistory.length === 4
      && score.biddingHistory.every(entry => entry.bid === 'Pass')
      && auction.contract === null && auction.passes === 4, 'passed-out auction is invalid');
    validateCardMap(score.initialHands, { initial: true });
    invariant(score.ddTable === null || validateDdsTable(score.ddTable), 'score DDS table is invalid');
    return;
  }
  invariant(hasExactOwnKeys(score, PLAYED_SCORE_KEYS) && score.passedOut === false,
    'played score has an invalid shape');
  validateContract(score.contract);
  invariant(score.contract !== null, 'played score requires a contract');
  validateAuction(score.biddingHistory);
  const boardInfo = boardInfoFor(score.dealNumber);
  const auction = deriveAuction(score.biddingHistory, boardInfo.dealer);
  invariant(auction.passes === 3 && sameValue(auction.contract, score.contract),
    'played score auction is inconsistent');
  invariant(SEATS.includes(score.declarer) && SEATS.includes(score.dummy)
    && partnerOf(score.declarer) === score.dummy, 'played score seats are invalid');
  invariant(declarerFor(score.biddingHistory, score.contract) === score.declarer,
    'played score declarer is inconsistent with auction');
  invariant(Number.isSafeInteger(score.declarerTricks) && score.declarerTricks >= 0
    && score.declarerTricks <= 13, 'declarer trick count is invalid');
  invariant(score.needed === score.contract.level + 6, 'needed trick count is invalid');
  invariant(Number.isSafeInteger(score.score), 'score value is invalid');
  invariant(score.made === (score.declarerTricks >= score.needed), 'made flag is invalid');
  invariant(score.diff === score.declarerTricks - score.needed, 'score difference is invalid');
  invariant(score.vulnerability === boardInfo.vul, 'score vulnerability is invalid');
  invariant(Array.isArray(score.completedTricks), 'score tricks are invalid');
  score.completedTricks.forEach(trick => validateTrick(trick, score.contract.suit));
  validateCardMap(score.initialHands, { initial: true });
  validateScoreTrickHistory(score);
  invariant(score.ddTable === null || validateDdsTable(score.ddTable), 'score DDS table is invalid');
  validateClaim(score.claim);
  let nsTricks = 0;
  let ewTricks = 0;
  for (const trick of score.completedTricks) {
    if (sideOf(trick.winner) === 'NS') nsTricks += 1;
    else ewTricks += 1;
  }
  if (score.claim === null) {
    invariant(score.completedTricks.length === 13, 'played score without claim requires 13 tricks');
  } else {
    const remaining = 13 - score.completedTricks.length;
    invariant(remaining > 0 && score.claim.tricksToWin <= remaining,
      'score claim exceeds remaining tricks');
    const nsAward = sideOf(score.claim.claimer) === 'NS'
      ? score.claim.tricksToWin
      : remaining - score.claim.tricksToWin;
    nsTricks += nsAward;
    ewTricks += remaining - nsAward;
  }
  const expectedDeclarerTricks = sideOf(score.declarer) === 'NS' ? nsTricks : ewTricks;
  invariant(score.declarerTricks === expectedDeclarerTricks,
    'score declarer tricks are inconsistent with trick history');
  const { calculateDuplicateScore } = require('./scoring.cjs');
  invariant(score.score === calculateDuplicateScore(
    score.contract, score.declarerTricks, score.vulnerability,
  ), 'duplicate score value is inconsistent');
}

function validateBoardScores(state) {
  let prior = 0;
  const seen = new Set();
  for (let index = 0; index < state.boardScores.length; index++) {
    const score = state.boardScores[index];
    validateBoardScore(score);
    invariant(score.dealNumber === index + 1, 'board scores must form a complete deal prefix');
    invariant(score.dealNumber > prior, 'board scores must be ordered by deal');
    invariant(!seen.has(score.dealNumber), 'board score deal is duplicated');
    invariant(score.dealNumber <= state.dealNumber, 'board score cannot be from a future deal');
    prior = score.dealNumber;
    seen.add(score.dealNumber);
  }
  const expectedCount = state.phase === 'SCORING'
    ? state.dealNumber
    : Math.max(0, state.dealNumber - 1);
  invariant(state.boardScores.length === expectedCount, 'board score history is incomplete');
  return seen;
}

function validateCommonState(state) {
  invariant(hasExactOwnKeys(state, CLASSIC_STATE_KEYS), 'state has an invalid root shape');
  invariant(state.schemaVersion === 1 && state.mode === 'classic', 'state identity is invalid');
  invariant(PHASES.includes(state.phase), 'state phase is invalid');
  invariant(Number.isSafeInteger(state.dealNumber) && state.dealNumber >= 0, 'deal number is invalid');
  invariant(hasExactOwnKeys(state.readyStatus, SEATS)
    && SEATS.every(seat => typeof state.readyStatus[seat] === 'boolean'),
  'ready status is invalid');
  validateAuction(state.biddingHistory);
  invariant(state.currentBidder === null || SEATS.includes(state.currentBidder), 'current bidder is invalid');
  validateContract(state.currentContract);
  invariant(Number.isSafeInteger(state.consecutivePasses) && state.consecutivePasses >= 0,
    'consecutive passes is invalid');
  for (const field of ['declarer', 'dummy', 'leader', 'currentPlayer']) {
    invariant(state[field] === null || SEATS.includes(state[field]), `${field} is invalid`);
  }
  invariant(Array.isArray(state.currentTrick), 'current trick is invalid');
  invariant(Array.isArray(state.completedTricks), 'completed tricks are invalid');
  invariant(Number.isSafeInteger(state.nsTricks) && state.nsTricks >= 0, 'NS trick count is invalid');
  invariant(Number.isSafeInteger(state.ewTricks) && state.ewTricks >= 0, 'EW trick count is invalid');
  invariant(typeof state.dummyRevealed === 'boolean', 'dummy reveal flag is invalid');
  invariant(Array.isArray(state.boardScores), 'board scores are invalid');
  invariant(DDS_STATUSES.includes(state.ddsStatus), 'DDS status is invalid');
  invariant((state.ddsStatus === 'READY') === validateDdsTable(state.ddTable),
    'DDS status and table are inconsistent');
  if (state.ddsStatus !== 'READY') invariant(state.ddTable === null, 'DDS table must be null');
}

function validateNoPlayFields(state) {
  invariant(state.declarer === null && state.dummy === null && state.leader === null
    && state.currentPlayer === null, 'pre-play seats must be null');
  invariant(state.currentTrick.length === 0 && state.completedTricks.length === 0,
    'pre-play trick lists must be empty');
  invariant(state.nsTricks === 0 && state.ewTricks === 0, 'pre-play trick totals must be zero');
  invariant(state.dummyRevealed === false && state.claimSettlement === null,
    'pre-play flags are invalid');
}

function sameHandOwnership(hands, initialHands) {
  return SEATS.every(seat => {
    const held = new Set(hands[seat].map(cardKey));
    const initial = new Set(initialHands[seat].map(cardKey));
    return held.size === initial.size && [...held].every(key => initial.has(key));
  });
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]));
  }
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

function validateFinishedAuction(state, { passedOut = false } = {}) {
  const derived = deriveAuction(state.biddingHistory, state.boardInfo.dealer);
  invariant(state.currentBidder === null, 'finished auction cannot have a current bidder');
  invariant(state.consecutivePasses === derived.passes, 'consecutive pass count is inconsistent');
  invariant(sameValue(state.currentContract, derived.contract), 'current contract is inconsistent with auction');
  if (passedOut) {
    invariant(derived.contract === null && derived.passes === 4 && state.biddingHistory.length === 4,
      'passed-out auction is invalid');
  } else {
    invariant(derived.contract !== null && derived.passes === 3, 'contract auction is not complete');
  }
}

function validateActiveAuction(state) {
  const derived = deriveAuction(state.biddingHistory, state.boardInfo.dealer);
  invariant(sameValue(state.currentContract, derived.contract), 'current contract is inconsistent with auction');
  invariant(state.consecutivePasses === derived.passes, 'consecutive pass count is inconsistent');
  invariant(state.currentBidder === SEATS[(SEATS.indexOf(state.boardInfo.dealer)
    + state.biddingHistory.length) % SEATS.length], 'current bidder is inconsistent with auction');
  invariant(derived.contract === null ? derived.passes <= 3 : derived.passes <= 2,
    'finished auction must transition phase');
}

function validatePlayState(state) {
  invariant(state.currentContract !== null, 'play requires a contract');
  invariant(SEATS.includes(state.declarer) && state.dummy === partnerOf(state.declarer),
    'declarer and dummy are invalid');
  invariant(state.leader === nextSeat(state.declarer), 'opening leader is invalid');
  invariant(state.claimSettlement === null || hasExactOwnKeys(state.claimSettlement, CLAIM_SETTLEMENT_KEYS),
    'claim settlement has an invalid shape');
  invariant(state.currentTrick.length <= 3, 'current trick is too long');

  let expectedLeader = state.leader;
  const played = [];
  let nsCompleted = 0;
  let ewCompleted = 0;
  for (const trick of state.completedTricks) {
    validateTrick(trick, state.currentContract.suit);
    invariant(trick.cards[0].seat === expectedLeader, 'completed trick leader is invalid');
    for (let index = 1; index < trick.cards.length; index++) {
      invariant(trick.cards[index].seat === nextSeat(trick.cards[index - 1].seat),
        'completed trick play order is invalid');
    }
    played.push(...trick.cards);
    if (sideOf(trick.winner) === 'NS') nsCompleted += 1;
    else ewCompleted += 1;
    expectedLeader = trick.winner;
  }
  state.currentTrick.forEach(validatePlay);
  if (state.currentTrick.length > 0) {
    invariant(state.currentTrick[0].seat === expectedLeader, 'current trick leader is invalid');
    for (let index = 1; index < state.currentTrick.length; index++) {
      invariant(state.currentTrick[index].seat === nextSeat(state.currentTrick[index - 1].seat),
        'current trick play order is invalid');
    }
    played.push(...state.currentTrick);
  }
  const expectedPlayer = state.currentTrick.length === 0
    ? expectedLeader
    : nextSeat(state.currentTrick[state.currentTrick.length - 1].seat);
  invariant(state.currentPlayer === expectedPlayer, 'current player is inconsistent with tricks');
  invariant(state.dummyRevealed === (played.length > 0), 'dummy reveal flag is inconsistent with play');

  replayPlayHistory(state.initialHands, state.completedTricks, state.currentTrick, state.hands);
  return { nsCompleted, ewCompleted };
}

function replayPlayHistory(initialHands, completedTricks, currentTrick, remainingHands = null) {
  const holdings = Object.fromEntries(SEATS.map(seat => [seat,
    new Map(initialHands[seat].map(card => [cardKey(card), card]))]));

  const replayTrick = cards => {
    let ledSuit = null;
    for (const play of cards) {
      const hand = holdings[play.seat];
      const key = cardKey(play.card);
      invariant(hand.has(key), 'played card was not held by its seat');
      if (ledSuit === null) {
        ledSuit = play.card.suit;
      } else if (play.card.suit !== ledSuit) {
        invariant(![...hand.values()].some(card => card.suit === ledSuit),
          'play history violates follow-suit');
      }
      hand.delete(key);
    }
  };

  completedTricks.forEach(trick => replayTrick(trick.cards));
  if (currentTrick.length > 0) replayTrick(currentTrick);
  if (remainingHands === null) return;
  for (const seat of SEATS) {
    const actual = new Set(remainingHands[seat].map(cardKey));
    invariant(actual.size === holdings[seat].size
      && [...actual].every(key => holdings[seat].has(key)),
    'remaining hand does not match replayed history');
  }
}

function currentScore(state) {
  return state.boardScores[state.boardScores.length - 1];
}

function validateCurrentScoreMatches(state, score, claim) {
  invariant(score.dealNumber === state.dealNumber && score.boardNumber === state.boardInfo.number,
    'current score board identity is invalid');
  invariant(score.passedOut === false, 'current played score cannot be passed out');
  invariant(sameValue(score.contract, state.currentContract)
    && score.declarer === state.declarer && score.dummy === state.dummy,
  'current score contract seats are inconsistent');
  const declarerTricks = sideOf(state.declarer) === 'NS' ? state.nsTricks : state.ewTricks;
  invariant(score.declarerTricks === declarerTricks, 'current score declarer tricks are inconsistent');
  invariant(score.vulnerability === state.boardInfo.vul, 'current score vulnerability is inconsistent');
  invariant(sameValue(score.biddingHistory, state.biddingHistory)
    && sameValue(score.completedTricks, state.completedTricks)
    && sameValue(score.initialHands, state.initialHands)
    && sameValue(score.claim, claim), 'current score history is inconsistent');
}

function validateClassicStateUnchecked(state) {
  validateCommonState(state);
  const scoredDeals = validateBoardScores(state);
  if (state.phase === 'LOBBY') {
    invariant(state.dealNumber === 0 && state.boardInfo === null, 'lobby board identity is invalid');
    const held = validateCardMap(state.hands);
    const initial = validateCardMap(state.initialHands);
    invariant(held.size === 0 && initial.size === 0, 'lobby hands must be empty');
    invariant(SEATS.every(seat => state.readyStatus[seat] === false), 'lobby readiness must be false');
    invariant(state.biddingHistory.length === 0 && state.currentBidder === null
      && state.currentContract === null && state.consecutivePasses === 0,
    'lobby auction must be empty');
    validateNoPlayFields(state);
    invariant(state.boardScores.length === 0, 'lobby scores must be empty');
    invariant(state.ddsStatus === 'IDLE', 'lobby DDS status must be IDLE');
    return { ok: true };
  }

  invariant(state.dealNumber > 0, 'active deal number must be positive');
  validateBoardInfo(state.boardInfo, state.dealNumber);
  validateCardMap(state.hands);
  validateCardMap(state.initialHands, { initial: true });
  if (state.phase === 'BIDDING') {
    invariant(sameHandOwnership(state.hands, state.initialHands),
      'bidding hands must preserve initial seat ownership');
    invariant(SEATS.every(seat => state.readyStatus[seat] === false), 'deal readiness must be false');
    validateNoPlayFields(state);
    validateActiveAuction(state);
    invariant(!scoredDeals.has(state.dealNumber), 'active deal cannot already be scored');
    invariant(['PENDING', 'READY', 'FAILED'].includes(state.ddsStatus), 'active DDS status is invalid');
    return { ok: true };
  }
  invariant(['PENDING', 'READY', 'FAILED'].includes(state.ddsStatus), 'active DDS status is invalid');
  if (state.phase === 'SCORING' && state.currentContract === null) {
    invariant(scoredDeals.has(state.dealNumber)
      && currentScore(state).dealNumber === state.dealNumber,
    'finished deal must have exactly one latest score');
    validateFinishedAuction(state, { passedOut: true });
    validateNoPlayFields(state);
    invariant(sameHandOwnership(state.hands, state.initialHands),
      'passed-out hands must preserve initial seat ownership');
    const score = currentScore(state);
    invariant(score.passedOut === true
      && score.dealNumber === state.dealNumber
      && score.boardNumber === state.boardInfo.number
      && sameValue(score.biddingHistory, state.biddingHistory)
      && sameValue(score.initialHands, state.initialHands), 'passed-out score is inconsistent');
    return { ok: true };
  }

  validateFinishedAuction(state);
  const completedTotals = validatePlayState(state);
  if (state.phase === 'PLAYING') {
    invariant(state.completedTricks.length < 13, 'thirteenth trick must transition to scoring');
    invariant(state.claimSettlement === null, 'playing state cannot contain a claim settlement');
    invariant(state.nsTricks === completedTotals.nsCompleted
      && state.ewTricks === completedTotals.ewCompleted,
    'playing trick totals are inconsistent');
    invariant(!scoredDeals.has(state.dealNumber), 'playing deal cannot already be scored');
    invariant(SEATS.every(seat => state.readyStatus[seat] === false), 'playing readiness must be false');
    return { ok: true };
  }

  invariant(scoredDeals.has(state.dealNumber)
    && currentScore(state).dealNumber === state.dealNumber,
  'finished deal must have exactly one latest score');
  invariant(state.nsTricks + state.ewTricks === 13, 'scoring trick totals must equal 13');
  if (state.claimSettlement === null) {
    invariant(state.completedTricks.length === 13 && state.currentTrick.length === 0,
      'normal scoring requires 13 completed tricks');
    invariant(state.nsTricks === completedTotals.nsCompleted
      && state.ewTricks === completedTotals.ewCompleted,
    'normal scoring trick totals are inconsistent');
    validateCurrentScoreMatches(state, currentScore(state), null);
    return { ok: true };
  }

  const claim = state.claimSettlement;
  invariant(hasExactOwnKeys(claim, CLAIM_SETTLEMENT_KEYS), 'claim settlement has an invalid shape');
  validateClaim({ claimer: claim.claimer, tricksToWin: claim.tricksToWin, reason: claim.reason });
  invariant(Number.isSafeInteger(claim.completedAtClaim)
    && claim.completedAtClaim === state.completedTricks.length,
  'claim completion marker is invalid');
  const remaining = 13 - claim.completedAtClaim;
  invariant(claim.tricksToWin <= remaining, 'claim trick count exceeds remaining tricks');
  const nsAward = sideOf(claim.claimer) === 'NS' ? claim.tricksToWin : remaining - claim.tricksToWin;
  const ewAward = remaining - nsAward;
  invariant(state.nsTricks === completedTotals.nsCompleted + nsAward
    && state.ewTricks === completedTotals.ewCompleted + ewAward,
  'claimed scoring totals are inconsistent');
  validateCurrentScoreMatches(state, currentScore(state), {
    claimer: claim.claimer, tricksToWin: claim.tricksToWin, reason: claim.reason,
  });
  return { ok: true };
}

function validateClassicState(state) {
  try {
    return validateClassicStateUnchecked(state);
  } catch (error) {
    if (error instanceof ClassicInvariantError) throw error;
    throw new ClassicInvariantError('classic state is malformed');
  }
}

function assertCanonicalDeal(hands, boardInfo) {
  if (!hasExactOwnKeys(boardInfo, ['number', 'dealNumber', 'vul', 'dealer'])) {
    throw new ClassicInvariantError('boardInfo must have the canonical shape');
  }
  if (!Number.isSafeInteger(boardInfo.dealNumber) || boardInfo.dealNumber <= 0) {
    throw new ClassicInvariantError('boardInfo.dealNumber must be a positive safe integer');
  }
  const expectedBoard = boardInfoFor(boardInfo.dealNumber);
  if (Object.keys(expectedBoard).some(key => boardInfo[key] !== expectedBoard[key])) {
    throw new ClassicInvariantError('boardInfo does not match the duplicate board cycle');
  }
  if (!hasExactOwnKeys(hands, SEATS)) {
    throw new ClassicInvariantError('hands must contain the four canonical seats');
  }
  const seen = new Set();
  for (const seat of SEATS) {
    if (!Array.isArray(hands[seat]) || hands[seat].length !== 13) {
      throw new ClassicInvariantError('each deal hand must contain 13 cards');
    }
    for (const card of hands[seat]) {
      if (!isCanonicalCard(card)) throw new ClassicInvariantError('deal contains a non-canonical card');
      const key = `${card.suit}${card.rank}`;
      if (seen.has(key)) throw new ClassicInvariantError('deal contains a duplicate card');
      seen.add(key);
    }
  }
  if (seen.size !== 52) throw new ClassicInvariantError('deal must contain all 52 unique cards');
}

function createClassicLobbyState() {
  return {
    schemaVersion: 1,
    mode: 'classic',
    phase: 'LOBBY',
    dealNumber: 0,
    boardInfo: null,
    hands: emptyHands(),
    initialHands: emptyHands(),
    readyStatus: { N: false, E: false, S: false, W: false },
    biddingHistory: [],
    currentBidder: null,
    currentContract: null,
    consecutivePasses: 0,
    declarer: null,
    dummy: null,
    leader: null,
    currentPlayer: null,
    currentTrick: [],
    completedTricks: [],
    nsTricks: 0,
    ewTricks: 0,
    dummyRevealed: false,
    claimSettlement: null,
    boardScores: [],
    ddTable: null,
    ddsStatus: 'IDLE',
  };
}

function createClassicDealState(previous, deal) {
  validateClassicState(previous);
  invariant(previous.phase === 'LOBBY' || previous.phase === 'SCORING',
    'a deal can start only after lobby or scoring');
  invariant(hasExactOwnKeys(deal, ['hands', 'boardInfo']), 'deal context has an invalid shape');
  const { hands, boardInfo } = deal;
  assertCanonicalDeal(hands, boardInfo);
  invariant(boardInfo.dealNumber === previous.dealNumber + 1,
    'deal context does not contain the next deal number');
  const state = createClassicLobbyState();
  state.phase = 'BIDDING';
  state.dealNumber = boardInfo.dealNumber;
  state.boardInfo = cloneValue(boardInfo);
  state.hands = cloneValue(hands);
  state.initialHands = cloneValue(hands);
  state.currentBidder = boardInfo.dealer;
  state.boardScores = cloneValue(previous.boardScores);
  state.ddsStatus = 'PENDING';
  return state;
}

module.exports = {
  CLASSIC_STATE_KEYS,
  ClassicInvariantError,
  createClassicLobbyState,
  createClassicDealState,
  validateClassicState,
};
