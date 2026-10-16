'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { calculateDuplicateScore, buildBoardScore } = require('../classic/scoring.cjs');
const {
  createClassicLobbyState, createClassicDealState, ClassicInvariantError,
} = require('../classic/state.cjs');
const { boardInfoFor } = require('../classic/rules.cjs');
const { orderedDeal } = require('./helpers/classic-fixtures.js');

function contract(level, suit, seat = 'N', flags = {}) {
  return {
    level,
    suit,
    seat,
    doubled: flags.doubled ?? false,
    redoubled: flags.redoubled ?? false,
    doublerSeat: flags.doublerSeat ?? null,
  };
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function call(seat, bid) {
  return { seat, bid, alert: null, explain: null, qa: [] };
}

function removeCard(hand, target) {
  const index = hand.findIndex(card => card.suit === target.suit && card.rank === target.rank);
  assert.notEqual(index, -1);
  hand.splice(index, 1);
}

function terminalAuctionState() {
  const state = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(1),
  });
  state.biddingHistory = [call('N', '1NT'), call('E', 'Pass'), call('S', 'Pass'), call('W', 'Pass')];
  state.currentBidder = null;
  state.currentContract = contract(1, 'NT');
  state.consecutivePasses = 3;
  state.declarer = 'N';
  state.dummy = 'S';
  state.leader = 'E';
  state.currentPlayer = 'E';
  return state;
}

function terminalPlayedState(completedCount = 13) {
  const state = terminalAuctionState();
  state.phase = 'PLAYING';
  for (let index = 0; index < completedCount; index++) {
    const cards = ['E', 'S', 'W', 'N'].map(seat => ({
      seat, card: clone(state.initialHands[seat][index]),
    }));
    cards.forEach(play => removeCard(state.hands[play.seat], play.card));
    state.completedTricks.push({ cards, winner: 'E' });
  }
  state.nsTricks = 0;
  state.ewTricks = completedCount;
  state.dummyRevealed = completedCount > 0;
  state.ddTable = Array.from({ length: 5 }, (_, strain) => (
    Array.from({ length: 4 }, (_, seat) => (strain + seat) % 14)
  ));
  state.ddsStatus = 'READY';
  return state;
}

function terminalPassedOutState() {
  const state = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(1),
  });
  state.biddingHistory = ['N', 'E', 'S', 'W'].map(seat => call(seat, 'Pass'));
  state.currentBidder = null;
  state.consecutivePasses = 4;
  return state;
}

function assertInvariant(fn) {
  assert.throws(fn, error => {
    assert.ok(error instanceof ClassicInvariantError);
    assert.equal(error.kind, 'TRUSTED_STATE');
    return true;
  });
}

test('calculateDuplicateScore reproduces undoubled partscore, game, slam, overtrick, and undertrick scores', () => {
  const rows = [
    [contract(1, 'C'), 7, 'NONE', 70],
    [contract(2, 'H'), 8, 'NONE', 110],
    [contract(3, 'NT'), 9, 'NONE', 400],
    [contract(3, 'NT'), 9, 'NS', 600],
    [contract(4, 'S'), 10, 'NONE', 420],
    [contract(4, 'S'), 10, 'NS', 620],
    [contract(5, 'C'), 11, 'NONE', 400],
    [contract(6, 'NT'), 12, 'NONE', 990],
    [contract(6, 'NT'), 12, 'NS', 1440],
    [contract(7, 'S'), 13, 'NONE', 1510],
    [contract(7, 'S'), 13, 'NS', 2210],
    [contract(2, 'D'), 10, 'NONE', 130],
    [contract(4, 'S'), 9, 'NONE', -50],
    [contract(4, 'S'), 8, 'NS', -200],
    [contract(4, 'S', 'E'), 8, 'NS', -100],
    [contract(4, 'S', 'E'), 8, 'EW', -200],
  ];
  for (const [inputContract, tricks, vulnerability, expected] of rows) {
    Object.freeze(inputContract);
    const before = JSON.stringify(inputContract);
    assert.equal(calculateDuplicateScore(inputContract, tricks, vulnerability), expected,
      `${inputContract.level}${inputContract.suit} tricks=${tricks} vul=${vulnerability}`);
    assert.equal(JSON.stringify(inputContract), before);
  }
});

test('calculateDuplicateScore reproduces doubled and redoubled insults, overtricks, and penalty ladders', () => {
  const doubled = contract(2, 'H', 'N', { doubled: true, doublerSeat: 'E' });
  const redoubled = contract(1, 'S', 'N', {
    doubled: true, redoubled: true, doublerSeat: 'S',
  });
  const rows = [
    [doubled, 8, 'NONE', 470],
    [doubled, 9, 'NONE', 570],
    [doubled, 9, 'NS', 870],
    [doubled, 7, 'NONE', -100],
    [doubled, 6, 'NONE', -300],
    [doubled, 5, 'NONE', -500],
    [doubled, 4, 'NONE', -800],
    [doubled, 3, 'NONE', -1100],
    [doubled, 7, 'NS', -200],
    [doubled, 6, 'NS', -500],
    [doubled, 5, 'NS', -800],
    [doubled, 4, 'NS', -1100],
    [redoubled, 7, 'NONE', 690],
    [redoubled, 8, 'NONE', 890],
    [redoubled, 8, 'NS', 1290],
    [redoubled, 6, 'NONE', -200],
    [redoubled, 5, 'NONE', -600],
    [redoubled, 4, 'NONE', -1000],
    [redoubled, 3, 'NONE', -1600],
    [redoubled, 6, 'NS', -400],
    [redoubled, 5, 'NS', -1000],
    [redoubled, 4, 'NS', -1600],
  ];
  for (const [inputContract, tricks, vulnerability, expected] of rows) {
    const frozen = Object.freeze({ ...inputContract });
    const before = JSON.stringify(frozen);
    assert.equal(calculateDuplicateScore(frozen, tricks, vulnerability), expected,
      `${frozen.level}${frozen.suit} tricks=${tricks} vul=${vulnerability}`);
    assert.equal(JSON.stringify(frozen), before);
  }
});

test('buildBoardScore returns an exact detached passed-out score without mutating input', () => {
  const state = deepFreeze(terminalPassedOutState());
  const finish = deepFreeze({ type: 'passed-out' });
  const beforeState = JSON.stringify(state);
  const beforeFinish = JSON.stringify(finish);

  const score = buildBoardScore(state, finish);
  assert.deepEqual(score, {
    dealNumber: 1,
    boardNumber: 1,
    score: 0,
    passedOut: true,
    ddTable: null,
    biddingHistory: clone(state.biddingHistory),
    initialHands: clone(state.initialHands),
  });
  assert.equal(JSON.stringify(state), beforeState);
  assert.equal(JSON.stringify(finish), beforeFinish);
  assert.notStrictEqual(score.biddingHistory, state.biddingHistory);
  assert.notStrictEqual(score.initialHands, state.initialHands);
  score.biddingHistory[0].bid = '1C';
  assert.equal(state.biddingHistory[0].bid, 'Pass');
  assert.equal(buildBoardScore(state, finish).biddingHistory[0].bid, 'Pass');
});

test('buildBoardScore returns exact played and claimed score shapes with detached histories', () => {
  const playedState = deepFreeze(terminalPlayedState());
  const playedFinish = deepFreeze({ type: 'played' });
  const playedBefore = JSON.stringify(playedState);
  const played = buildBoardScore(playedState, playedFinish);
  assert.deepEqual(played, {
    dealNumber: 1,
    boardNumber: 1,
    passedOut: false,
    contract: clone(playedState.currentContract),
    declarer: 'N',
    dummy: 'S',
    declarerTricks: 0,
    needed: 7,
    score: -350,
    made: false,
    diff: -7,
    vulnerability: 'NONE',
    biddingHistory: clone(playedState.biddingHistory),
    completedTricks: clone(playedState.completedTricks),
    initialHands: clone(playedState.initialHands),
    ddTable: clone(playedState.ddTable),
    claim: null,
  });
  assert.equal(JSON.stringify(playedState), playedBefore);
  assert.notStrictEqual(played.contract, playedState.currentContract);
  assert.notStrictEqual(played.completedTricks, playedState.completedTricks);
  assert.notStrictEqual(played.initialHands, playedState.initialHands);
  assert.notStrictEqual(played.ddTable, playedState.ddTable);

  const claimedState = terminalPlayedState(5);
  claimedState.nsTricks = 6;
  claimedState.ewTricks = 7;
  const claim = { claimer: 'N', tricksToWin: 6, reason: 'remaining winners' };
  const frozenClaimed = deepFreeze(claimedState);
  const finish = deepFreeze({ type: 'claimed', claim });
  const beforeClaimed = JSON.stringify(frozenClaimed);
  const claimed = buildBoardScore(frozenClaimed, finish);
  assert.deepEqual(claimed, {
    dealNumber: 1,
    boardNumber: 1,
    passedOut: false,
    contract: clone(frozenClaimed.currentContract),
    declarer: 'N',
    dummy: 'S',
    declarerTricks: 6,
    needed: 7,
    score: -50,
    made: false,
    diff: -1,
    vulnerability: 'NONE',
    biddingHistory: clone(frozenClaimed.biddingHistory),
    completedTricks: clone(frozenClaimed.completedTricks),
    initialHands: clone(frozenClaimed.initialHands),
    ddTable: clone(frozenClaimed.ddTable),
    claim: clone(claim),
  });
  assert.equal(JSON.stringify(frozenClaimed), beforeClaimed);
  assert.notStrictEqual(claimed.claim, finish.claim);
  claimed.claim.reason = 'changed';
  assert.equal(finish.claim.reason, 'remaining winners');
  assert.equal(buildBoardScore(frozenClaimed, finish).claim.reason, 'remaining winners');
});

test('buildBoardScore rejects unknown finish keys/types and corrupted trusted state', () => {
  const played = terminalPlayedState();
  const cases = [
    () => buildBoardScore(played, { type: 'played', extra: true }),
    () => buildBoardScore(played, { type: 'unknown' }),
    () => buildBoardScore(played, { type: 'claimed' }),
    () => buildBoardScore(played, {
      type: 'claimed', claim: { claimer: 'N', tricksToWin: 1, reason: '', extra: true },
    }),
    () => {
      const corrupt = clone(played);
      corrupt.currentContract.level = 8;
      return buildBoardScore(corrupt, { type: 'played' });
    },
    () => {
      const corrupt = clone(played);
      corrupt.initialHands.N[0].rank = 14;
      return buildBoardScore(corrupt, { type: 'played' });
    },
    () => {
      const corrupt = clone(played);
      corrupt.boardInfo = null;
      return buildBoardScore(corrupt, { type: 'played' });
    },
    () => {
      const corrupt = clone(played);
      corrupt.currentBidder = 'N';
      return buildBoardScore(corrupt, { type: 'played' });
    },
    () => {
      const corrupt = clone(played);
      corrupt.claimSettlement = {
        claimer: 'N', tricksToWin: 0, reason: '', completedAtClaim: 13,
      };
      return buildBoardScore(corrupt, { type: 'played' });
    },
  ];
  for (const invoke of cases) assertInvariant(invoke);
});

test('buildBoardScore rejects ready seats in every pre-scoring finish state', () => {
  const passedOut = terminalPassedOutState();
  passedOut.readyStatus.N = true;

  const played = terminalPlayedState();
  played.readyStatus.E = true;

  const claimed = terminalPlayedState(5);
  claimed.nsTricks = 6;
  claimed.ewTricks = 7;
  claimed.readyStatus.S = true;

  const cases = [
    () => buildBoardScore(passedOut, { type: 'passed-out' }),
    () => buildBoardScore(played, { type: 'played' }),
    () => buildBoardScore(claimed, {
      type: 'claimed',
      claim: { claimer: 'N', tricksToWin: 6, reason: 'remaining winners' },
    }),
  ];
  for (const invoke of cases) assertInvariant(invoke);
});

test('calculateDuplicateScore rejects every malformed trusted input as ClassicInvariantError', () => {
  const valid = contract(1, 'C');
  const cases = [
    () => calculateDuplicateScore({ ...valid, extra: true }, 7, 'NONE'),
    () => calculateDuplicateScore({ ...valid, level: 0 }, 7, 'NONE'),
    () => calculateDuplicateScore({ ...valid, rank: 1 }, 7, 'NONE'),
    () => calculateDuplicateScore(valid, 7.5, 'NONE'),
    () => calculateDuplicateScore(valid, 14, 'NONE'),
    () => calculateDuplicateScore(valid, 7, 'ALL'),
    () => calculateDuplicateScore(contract(1, 'C', 'N', {
      doubled: true, doublerSeat: 'S',
    }), 7, 'NONE'),
  ];
  for (const invoke of cases) assertInvariant(invoke);
});
