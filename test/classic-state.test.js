'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createClassicLobbyState,
  createClassicDealState,
  validateClassicState,
  ClassicInvariantError,
  CLASSIC_STATE_KEYS,
} = require('../classic/state.cjs');
const { boardInfoFor } = require('../classic/rules.cjs');
const { orderedDeal } = require('./helpers/classic-fixtures.js');

const EXPECTED_KEYS = [
  'schemaVersion', 'mode', 'phase', 'dealNumber', 'boardInfo', 'hands', 'initialHands',
  'readyStatus', 'biddingHistory', 'currentBidder', 'currentContract', 'consecutivePasses',
  'declarer', 'dummy', 'leader', 'currentPlayer', 'currentTrick', 'completedTricks',
  'nsTricks', 'ewTricks', 'dummyRevealed', 'claimSettlement', 'boardScores', 'ddTable',
  'ddsStatus',
];

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function assertInvariant(fn) {
  assert.throws(fn, error => {
    assert.ok(error instanceof ClassicInvariantError);
    assert.equal(error.kind, 'TRUSTED_STATE');
    return true;
  });
}

function normalizedCall(seat, bid) {
  return { seat, bid, alert: null, explain: null, qa: [] };
}

function removeCard(hand, target) {
  const index = hand.findIndex(card => card.suit === target.suit && card.rank === target.rank);
  assert.notEqual(index, -1);
  hand.splice(index, 1);
}

function makePlayingState(completedCount = 0) {
  const state = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(),
    boardInfo: boardInfoFor(1),
  });
  state.phase = 'PLAYING';
  state.biddingHistory = [
    normalizedCall('N', '1NT'), normalizedCall('E', 'Pass'),
    normalizedCall('S', 'Pass'), normalizedCall('W', 'Pass'),
  ];
  state.currentBidder = null;
  state.currentContract = {
    level: 1, suit: 'NT', seat: 'N', doubled: false, redoubled: false, doublerSeat: null,
  };
  state.consecutivePasses = 3;
  state.declarer = 'N';
  state.dummy = 'S';
  state.leader = 'E';
  state.currentPlayer = 'E';
  for (let index = 0; index < completedCount; index++) {
    const cards = ['E', 'S', 'W', 'N'].map(seat => ({
      seat,
      card: clone(state.initialHands[seat][index]),
    }));
    for (const play of cards) removeCard(state.hands[play.seat], play.card);
    state.completedTricks.push({ cards, winner: 'E' });
  }
  state.nsTricks = 0;
  state.ewTricks = completedCount;
  state.dummyRevealed = completedCount > 0;
  return state;
}

function makeMixedPlayingState() {
  const hands = orderedDeal();
  [hands.E[12], hands.S[0]] = [hands.S[0], hands.E[12]];
  const state = createClassicDealState(createClassicLobbyState(), {
    hands, boardInfo: boardInfoFor(1),
  });
  state.phase = 'PLAYING';
  state.biddingHistory = [
    normalizedCall('N', '1NT'), normalizedCall('E', 'Pass'),
    normalizedCall('S', 'Pass'), normalizedCall('W', 'Pass'),
  ];
  state.currentBidder = null;
  state.currentContract = {
    level: 1, suit: 'NT', seat: 'N', doubled: false, redoubled: false, doublerSeat: null,
  };
  state.consecutivePasses = 3;
  state.declarer = 'N';
  state.dummy = 'S';
  state.leader = 'E';
  const cards = [
    { seat: 'E', card: { suit: 'H', rank: '2' } },
    { seat: 'S', card: { suit: 'H', rank: 'A' } },
    { seat: 'W', card: { suit: 'C', rank: '2' } },
    { seat: 'N', card: { suit: 'S', rank: '2' } },
  ];
  cards.forEach(play => removeCard(state.hands[play.seat], play.card));
  state.completedTricks = [{ cards, winner: 'S' }];
  state.nsTricks = 1;
  state.ewTricks = 0;
  state.currentPlayer = 'S';
  state.dummyRevealed = true;
  return state;
}

function makeOneTrickClaimedScoringState() {
  const state = makeMixedPlayingState();
  state.phase = 'SCORING';
  state.nsTricks = 7;
  state.ewTricks = 6;
  state.claimSettlement = {
    claimer: 'N', tricksToWin: 6, reason: 'remaining winners', completedAtClaim: 1,
  };
  state.boardScores = [playedScore(state, {
    claimer: 'N', tricksToWin: 6, reason: 'remaining winners',
  })];
  return state;
}

function passedOutScore(state) {
  return {
    dealNumber: state.dealNumber,
    boardNumber: state.boardInfo.number,
    score: 0,
    passedOut: true,
    ddTable: clone(state.ddTable),
    biddingHistory: clone(state.biddingHistory),
    initialHands: clone(state.initialHands),
  };
}

function playedScore(state, claim = null) {
  const declarerTricks = state.nsTricks;
  const needed = state.currentContract.level + 6;
  return {
    dealNumber: state.dealNumber,
    boardNumber: state.boardInfo.number,
    passedOut: false,
    contract: clone(state.currentContract),
    declarer: state.declarer,
    dummy: state.dummy,
    declarerTricks,
    needed,
    score: declarerTricks >= needed ? 90 : -(needed - declarerTricks) * 50,
    made: declarerTricks >= needed,
    diff: declarerTricks - needed,
    vulnerability: state.boardInfo.vul,
    biddingHistory: clone(state.biddingHistory),
    completedTricks: clone(state.completedTricks),
    initialHands: clone(state.initialHands),
    ddTable: clone(state.ddTable),
    claim: clone(claim),
  };
}

function makePassedOutScoringState() {
  const state = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(1),
  });
  state.phase = 'SCORING';
  state.biddingHistory = ['N', 'E', 'S', 'W'].map(seat => normalizedCall(seat, 'Pass'));
  state.currentBidder = null;
  state.consecutivePasses = 4;
  state.boardScores.push(passedOutScore(state));
  return state;
}

function makeNormalScoringState() {
  const state = makePlayingState(13);
  state.phase = 'SCORING';
  state.boardScores.push(playedScore(state));
  return state;
}

function makeClaimedScoringState() {
  const state = makePlayingState(5);
  state.phase = 'SCORING';
  state.nsTricks = 6;
  state.ewTricks = 7;
  state.claimSettlement = {
    claimer: 'N', tricksToWin: 6, reason: 'remaining winners', completedAtClaim: 5,
  };
  state.boardScores.push(playedScore(state, {
    claimer: 'N', tricksToWin: 6, reason: 'remaining winners',
  }));
  return state;
}

test('createClassicLobbyState returns the exact fresh mutable canonical lobby state', () => {
  const expected = {
    schemaVersion: 1,
    mode: 'classic',
    phase: 'LOBBY',
    dealNumber: 0,
    boardInfo: null,
    hands: { N: [], E: [], S: [], W: [] },
    initialHands: { N: [], E: [], S: [], W: [] },
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

  const first = createClassicLobbyState();
  const second = createClassicLobbyState();
  assert.deepEqual(first, expected);
  assert.deepEqual(CLASSIC_STATE_KEYS, EXPECTED_KEYS);
  assert.ok(Object.isFrozen(CLASSIC_STATE_KEYS));
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.hands, second.hands);
  assert.notStrictEqual(first.hands.N, second.hands.N);
  assert.notStrictEqual(first.initialHands, second.initialHands);
  assert.notStrictEqual(first.readyStatus, second.readyStatus);
  assert.notStrictEqual(first.biddingHistory, second.biddingHistory);
  assert.notStrictEqual(first.currentTrick, second.currentTrick);
  assert.notStrictEqual(first.completedTricks, second.completedTricks);
  assert.notStrictEqual(first.boardScores, second.boardScores);
  assert.equal(Object.isFrozen(first), false);
  first.hands.N.push({ suit: 'S', rank: 'A' });
  first.readyStatus.N = true;
  assert.deepEqual(second.hands.N, []);
  assert.equal(second.readyStatus.N, false);
});

test('createClassicDealState initializes an exact detached BIDDING state without mutating input', () => {
  const previous = deepFreeze(createClassicLobbyState());
  const deal = deepFreeze({ hands: orderedDeal(), boardInfo: boardInfoFor(1) });
  const previousJson = JSON.stringify(previous);
  const dealJson = JSON.stringify(deal);

  const state = createClassicDealState(previous, deal);

  assert.deepEqual(Object.keys(state), EXPECTED_KEYS);
  assert.equal(state.phase, 'BIDDING');
  assert.equal(state.dealNumber, 1);
  assert.deepEqual(state.boardInfo, { number: 1, dealNumber: 1, vul: 'NONE', dealer: 'N' });
  assert.deepEqual(state.hands, deal.hands);
  assert.deepEqual(state.initialHands, deal.hands);
  assert.deepEqual(state.readyStatus, { N: false, E: false, S: false, W: false });
  assert.deepEqual(state.biddingHistory, []);
  assert.equal(state.currentBidder, 'N');
  assert.equal(state.currentContract, null);
  assert.equal(state.consecutivePasses, 0);
  for (const field of ['declarer', 'dummy', 'leader', 'currentPlayer', 'claimSettlement', 'ddTable']) {
    assert.equal(state[field], null, field);
  }
  assert.deepEqual(state.currentTrick, []);
  assert.deepEqual(state.completedTricks, []);
  assert.equal(state.nsTricks, 0);
  assert.equal(state.ewTricks, 0);
  assert.equal(state.dummyRevealed, false);
  assert.deepEqual(state.boardScores, []);
  assert.equal(state.ddsStatus, 'PENDING');
  assert.equal(JSON.stringify(previous), previousJson);
  assert.equal(JSON.stringify(deal), dealJson);
  assert.notStrictEqual(state.hands, deal.hands);
  assert.notStrictEqual(state.hands.N, deal.hands.N);
  assert.notStrictEqual(state.initialHands, deal.hands);
  assert.notStrictEqual(state.initialHands.N, state.hands.N);
  assert.notStrictEqual(state.boardInfo, deal.boardInfo);

  state.hands.N.pop();
  state.boardInfo.number = 2;
  assert.equal(deal.hands.N.length, 13);
  assert.equal(deal.boardInfo.number, 1);
});

test('validateClassicState accepts canonical LOBBY and BIDDING states', () => {
  const lobby = deepFreeze(createClassicLobbyState());
  const bidding = deepFreeze(createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(),
    boardInfo: boardInfoFor(1),
  }));
  const lobbyJson = JSON.stringify(lobby);
  const biddingJson = JSON.stringify(bidding);

  assert.deepEqual(validateClassicState(lobby), { ok: true });
  assert.deepEqual(validateClassicState(bidding), { ok: true });
  assert.equal(JSON.stringify(lobby), lobbyJson);
  assert.equal(JSON.stringify(bidding), biddingJson);
});

test('validateClassicState rejects malformed root, cards, counters, and DDS coupling as trusted corruption', () => {
  const valid = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(),
    boardInfo: boardInfoFor(1),
  });
  const corruptions = [
    state => { state.unknown = true; },
    state => { state.hands.N[0].unknown = true; },
    state => { state.hands.N[0].rank = 14; },
    state => { state.hands.N.pop(); },
    state => { state.hands.N[0] = clone(state.hands.E[0]); },
    state => { state.phase = 'STARTED'; },
    state => { state.consecutivePasses = Number.MAX_SAFE_INTEGER + 1; },
    state => { state.ddsStatus = 'READY'; },
    state => { state.ddsStatus = 'READY'; state.ddTable = [[0, 1, 2, 3]]; },
    state => { state.boardInfo.extra = true; },
  ];
  for (const corrupt of corruptions) {
    const state = clone(valid);
    corrupt(state);
    assertInvariant(() => validateClassicState(state));
  }
});

test('validateClassicState enforces exact contract, auction, Q&A, and DDS table schemas', () => {
  const state = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(),
    boardInfo: boardInfoFor(1),
  });
  state.biddingHistory.push({
    seat: 'N', bid: '1H', alert: true, explain: 'transfer',
    qa: [{ asker: 'E', question: 'meaning?', answer: null, answerer: null }],
  });
  state.currentBidder = 'E';
  state.currentContract = {
    level: 1, suit: 'H', seat: 'N', doubled: false, redoubled: false, doublerSeat: null,
  };
  state.ddsStatus = 'READY';
  state.ddTable = Array.from({ length: 5 }, (_, strain) => (
    Array.from({ length: 4 }, (_, seat) => (strain + seat) % 14)
  ));
  assert.deepEqual(validateClassicState(state), { ok: true });

  const corruptions = [
    value => { value.currentContract.extra = true; },
    value => { value.currentContract.level = 8; },
    value => { value.biddingHistory[0].extra = true; },
    value => { value.biddingHistory[0].bid = '1Z'; },
    value => { value.biddingHistory[0].qa[0].extra = true; },
    value => { value.biddingHistory[0].qa[0].asker = 'Q'; },
    value => { value.biddingHistory[0].explain = 'x'.repeat(501); },
    value => { value.ddTable[0][0] = 14; },
    value => { value.ddTable[0].extra = true; },
  ];
  for (const corrupt of corruptions) {
    const value = clone(state);
    corrupt(value);
    assertInvariant(() => validateClassicState(value));
  }
});

test('validateClassicState accepts canonical PLAYING and all three SCORING variants', () => {
  const states = [
    makePlayingState(0),
    makePlayingState(5),
    makeNormalScoringState(),
    makeClaimedScoringState(),
    makePassedOutScoringState(),
  ];
  for (const state of states) {
    const frozen = deepFreeze(state);
    const before = JSON.stringify(frozen);
    assert.deepEqual(validateClassicState(frozen), { ok: true });
    assert.equal(JSON.stringify(frozen), before);
  }
});

test('validateClassicState closes phase-specific trick, seat, claim, and reconstruction invariants', () => {
  const cases = [
    [createClassicDealState(createClassicLobbyState(), {
      hands: orderedDeal(), boardInfo: boardInfoFor(1),
    }), state => { state.currentTrick.push({ seat: 'N', card: clone(state.hands.N[0]) }); }],
    [makePlayingState(1), state => { state.declarer = null; }],
    [makePlayingState(2), state => { state.ewTricks = 1; }],
    [makePlayingState(1), state => { state.hands.N.pop(); }],
    [makePlayingState(1), state => { state.completedTricks[0].winner = 'N'; }],
    [makePlayingState(1), state => { state.completedTricks[0].extra = true; }],
    [makePlayingState(13), () => {}],
    [makeNormalScoringState(), state => { state.completedTricks.pop(); }],
    [makeClaimedScoringState(), state => { delete state.claimSettlement.completedAtClaim; }],
    [makeClaimedScoringState(), state => { state.claimSettlement.completedAtClaim = 4; }],
    [makeClaimedScoringState(), state => { state.nsTricks = 5; }],
  ];
  for (const [source, corrupt] of cases) {
    const state = clone(source);
    corrupt(state);
    assertInvariant(() => validateClassicState(state));
  }
});

test('validateClassicState requires one current deal score and requires it to be latest', () => {
  const normal = makeNormalScoringState();
  const missing = clone(normal);
  missing.boardScores = [];
  assertInvariant(() => validateClassicState(missing));

  const duplicate = clone(normal);
  duplicate.boardScores.push(clone(duplicate.boardScores[0]));
  assertInvariant(() => validateClassicState(duplicate));

  const notLatest = clone(normal);
  const future = clone(notLatest.boardScores[0]);
  future.dealNumber = 2;
  future.boardNumber = 2;
  notLatest.boardScores.push(future);
  assertInvariant(() => validateClassicState(notLatest));

  const corruptShape = clone(normal);
  corruptShape.boardScores[0].unknown = true;
  assertInvariant(() => validateClassicState(corruptShape));

  const corruptValue = clone(normal);
  corruptValue.boardScores[0].score = 9999;
  assertInvariant(() => validateClassicState(corruptValue));
});

test('createClassicDealState preserves prior scores by deep copy', () => {
  const previous = deepFreeze(makePassedOutScoringState());
  const before = JSON.stringify(previous);
  const next = createClassicDealState(previous, {
    hands: orderedDeal(), boardInfo: boardInfoFor(2),
  });
  assert.deepEqual(next.boardScores, previous.boardScores);
  assert.notStrictEqual(next.boardScores, previous.boardScores);
  assert.notStrictEqual(next.boardScores[0], previous.boardScores[0]);
  next.boardScores[0].biddingHistory[0].bid = '1C';
  assert.equal(previous.boardScores[0].biddingHistory[0].bid, 'Pass');
  assert.equal(JSON.stringify(previous), before);
});

test('createClassicDealState rejects malformed trusted previous state and deal context', () => {
  const lobby = createClassicLobbyState();
  const validDeal = { hands: orderedDeal(), boardInfo: boardInfoFor(1) };
  const cases = [
    [() => ({ ...lobby, extra: true }), () => clone(validDeal)],
    [() => clone(lobby), () => ({ ...clone(validDeal), extra: true })],
    [() => clone(lobby), () => {
      const deal = clone(validDeal);
      deal.hands.N[0] = clone(deal.hands.E[0]);
      return deal;
    }],
    [() => clone(lobby), () => ({ hands: orderedDeal(), boardInfo: boardInfoFor(2) })],
  ];
  for (const [makePrevious, makeDeal] of cases) {
    assertInvariant(() => createClassicDealState(makePrevious(), makeDeal()));
  }
});

test('validateClassicState rejects corrupted prior score auction order and repeated played cards', () => {
  const passedPrevious = makePassedOutScoringState();
  const afterPassed = createClassicDealState(passedPrevious, {
    hands: orderedDeal(), boardInfo: boardInfoFor(2),
  });
  [afterPassed.boardScores[0].biddingHistory[0].seat,
    afterPassed.boardScores[0].biddingHistory[1].seat] = [
    afterPassed.boardScores[0].biddingHistory[1].seat,
    afterPassed.boardScores[0].biddingHistory[0].seat,
  ];
  assertInvariant(() => validateClassicState(afterPassed));

  const playedPrevious = makeNormalScoringState();
  const afterPlayed = createClassicDealState(playedPrevious, {
    hands: orderedDeal(), boardInfo: boardInfoFor(2),
  });
  afterPlayed.boardScores[0].completedTricks[1].cards[0].card = clone(
    afterPlayed.boardScores[0].completedTricks[0].cards[0].card,
  );
  assertInvariant(() => validateClassicState(afterPlayed));
});

test('validateClassicState preserves per-seat ownership before play and on passed-out boards', () => {
  const bidding = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(1),
  });
  [bidding.hands.N[0], bidding.hands.E[0]] = [bidding.hands.E[0], bidding.hands.N[0]];
  assertInvariant(() => validateClassicState(bidding));

  const passedOut = makePassedOutScoringState();
  [passedOut.hands.N[0], passedOut.hands.E[0]] = [passedOut.hands.E[0], passedOut.hands.N[0]];
  assertInvariant(() => validateClassicState(passedOut));
});

test('validateClassicState replays follow-suit legality in completed and current tricks', () => {
  const completed = makeMixedPlayingState();
  completed.completedTricks[0].cards[1].card = { suit: 'D', rank: '3' };
  completed.completedTricks[0].winner = 'E';
  completed.currentPlayer = 'E';
  completed.nsTricks = 0;
  completed.ewTricks = 1;
  removeCard(completed.hands.S, { suit: 'D', rank: '3' });
  completed.hands.S.push({ suit: 'H', rank: 'A' });
  assertInvariant(() => validateClassicState(completed));

  const current = makeMixedPlayingState();
  for (const play of current.completedTricks[0].cards) {
    current.hands[play.seat].push(clone(play.card));
  }
  current.completedTricks = [];
  current.nsTricks = 0;
  current.currentTrick = [
    { seat: 'E', card: { suit: 'H', rank: '2' } },
    { seat: 'S', card: { suit: 'D', rank: '3' } },
  ];
  removeCard(current.hands.E, current.currentTrick[0].card);
  removeCard(current.hands.S, current.currentTrick[1].card);
  current.currentPlayer = 'W';
  assertInvariant(() => validateClassicState(current));
});

test('validateClassicState replays follow-suit legality in persisted claimed board scores', () => {
  const previous = makeOneTrickClaimedScoringState();
  const next = createClassicDealState(previous, {
    hands: orderedDeal(), boardInfo: boardInfoFor(2),
  });
  const score = next.boardScores[0];
  score.completedTricks[0].cards[1].card = { suit: 'D', rank: '3' };
  score.completedTricks[0].winner = 'E';
  score.declarerTricks = 6;
  score.score = -50;
  score.made = false;
  score.diff = -1;
  assertInvariant(() => validateClassicState(next));
});

test('validateClassicState requires a contiguous complete board score prefix', () => {
  const dealTwoWithoutHistory = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(1),
  });
  dealTwoWithoutHistory.dealNumber = 2;
  dealTwoWithoutHistory.boardInfo = boardInfoFor(2);
  dealTwoWithoutHistory.currentBidder = 'E';
  assertInvariant(() => validateClassicState(dealTwoWithoutHistory));

  const dealThreeMissingMiddle = createClassicDealState(makePassedOutScoringState(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(2),
  });
  dealThreeMissingMiddle.dealNumber = 3;
  dealThreeMissingMiddle.boardInfo = boardInfoFor(3);
  dealThreeMissingMiddle.currentBidder = 'S';
  assertInvariant(() => validateClassicState(dealThreeMissingMiddle));

  const scoringTwoMissingFirst = makePassedOutScoringState();
  scoringTwoMissingFirst.dealNumber = 2;
  scoringTwoMissingFirst.boardInfo = boardInfoFor(2);
  scoringTwoMissingFirst.biddingHistory = ['E', 'S', 'W', 'N']
    .map(seat => normalizedCall(seat, 'Pass'));
  scoringTwoMissingFirst.boardScores[0].dealNumber = 2;
  scoringTwoMissingFirst.boardScores[0].boardNumber = 2;
  scoringTwoMissingFirst.boardScores[0].biddingHistory = clone(scoringTwoMissingFirst.biddingHistory);
  assertInvariant(() => validateClassicState(scoringTwoMissingFirst));

  const scoringOne = makePassedOutScoringState();
  const scoringTwo = createClassicDealState(scoringOne, {
    hands: orderedDeal(), boardInfo: boardInfoFor(2),
  });
  scoringTwo.phase = 'SCORING';
  scoringTwo.biddingHistory = ['E', 'S', 'W', 'N'].map(seat => normalizedCall(seat, 'Pass'));
  scoringTwo.currentBidder = null;
  scoringTwo.consecutivePasses = 4;
  scoringTwo.boardScores.push(passedOutScore(scoringTwo));
  assert.deepEqual(validateClassicState(scoringTwo), { ok: true });

  const dealThree = createClassicDealState(scoringTwo, {
    hands: orderedDeal(), boardInfo: boardInfoFor(3),
  });
  [dealThree.boardScores[0], dealThree.boardScores[1]] = [
    dealThree.boardScores[1], dealThree.boardScores[0],
  ];
  assertInvariant(() => validateClassicState(dealThree));
});

test('validateClassicState compares canonical objects independent of key insertion order', () => {
  const state = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(1),
  });
  state.biddingHistory = [normalizedCall('N', '1H')];
  state.currentBidder = 'E';
  state.currentContract = {
    doublerSeat: null,
    redoubled: false,
    doubled: false,
    seat: 'N',
    suit: 'H',
    level: 1,
  };
  assert.deepEqual(validateClassicState(state), { ok: true });
});
