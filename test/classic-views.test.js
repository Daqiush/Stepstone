'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { applyClassicCommand } = require('../classic/engine.cjs');
const { createClassicLobbyState, createClassicDealState } = require('../classic/state.cjs');
const { boardInfoFor } = require('../classic/rules.cjs');
const { orderedDeal } = require('./helpers/classic-fixtures.js');
const { classicViewFor, classicEventFor } = require('../classic/views.cjs');
const { ClassicInputError } = require('../classic/engine.cjs');
const { ClassicInvariantError } = require('../classic/state.cjs');
const { settleClassicClaim } = require('../classic/node-compat.cjs');

const ROOT_KEYS = [
  'schemaVersion', 'mode', 'phase', 'dealNumber', 'boardInfo', 'readyStatus',
  'biddingHistory', 'currentBidder', 'currentContract', 'consecutivePasses',
  'declarer', 'dummy', 'leader', 'currentPlayer', 'currentTrick', 'completedCount',
  'nsTricks', 'ewTricks', 'dummyRevealed', 'claimSettlement', 'boardScores',
  'ddTable', 'ddsStatus', 'hands',
];

function clone(value) { return structuredClone(value); }

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function viewer(seat) {
  return seat === null ? { role: 'SPECTATOR', seat: null } : { role: 'PLAYER', seat };
}

function context(seat) {
  return { actor: { role: 'PLAYER', seat }, occupiedSeats: ['N', 'E', 'S', 'W'], deal: null };
}

function bid(state, seat, token, alert = false, explain = null) {
  return applyClassicCommand(state, {
    name: 'classic.bid', payload: { expectedRevision: 0, bid: token, alert, explain },
  }, context(seat));
}

function playingState() {
  let state = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(1),
  });
  state = bid(state, 'N', '1NT', true, '15–17').state;
  state = bid(state, 'E', 'Pass').state;
  state = bid(state, 'S', 'Pass', true, 'forcing').state;
  state = bid(state, 'W', 'Pass').state;
  state.biddingHistory[0].qa = [{ asker: 'E', question: 'Range?', answer: '15–17', answerer: 'N' }];
  return state;
}

function revealDummy(state = playingState()) {
  return applyClassicCommand(state, {
    name: 'classic.play', payload: { expectedRevision: 0, card: { suit: 'H', rank: '2' } },
  }, context('E')).state;
}

function passedOutState() {
  let state = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(1),
  });
  for (const seat of ['N', 'E', 'S', 'W']) state = bid(state, seat, 'Pass').state;
  return state;
}

function assertNoPrivateKeys(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Reflect.ownKeys(value)) {
    assert.ok(!['initialHands', 'credentials', 'commandCache', 'pendingActions'].includes(key), key);
    assertNoPrivateKeys(value[key]);
  }
}

test('classicViewFor builds the exact detached concealed-hand view before and after dummy reveal', () => {
  const before = deepFreeze(playingState());
  const beforeJson = JSON.stringify(before);
  const expectedBefore = {
    N: ['N'], E: ['E'], S: ['S'], W: ['W'], spectator: [],
  };
  for (const [name, visible] of Object.entries(expectedBefore)) {
    const who = name === 'spectator' ? viewer(null) : viewer(name);
    const view = classicViewFor(before, deepFreeze(who));
    assert.deepEqual(Object.keys(view), ROOT_KEYS);
    assert.equal(view.completedCount, before.completedTricks.length);
    assert.deepEqual(Object.keys(view.hands), ['N', 'E', 'S', 'W']);
    for (const seat of ['N', 'E', 'S', 'W']) {
      assert.equal(view.hands[seat] === null, !visible.includes(seat), `${name}:${seat}`);
    }
    assertNoPrivateKeys(view);
    if (visible.length) {
      const seat = visible[0];
      view.hands[seat][0].rank = 'A';
      assert.notEqual(before.hands[seat][0].rank, 'A');
    }
  }
  assert.equal(JSON.stringify(before), beforeJson);

  const after = deepFreeze(revealDummy(clone(before)));
  for (const seat of ['N', 'E', 'S', 'W', null]) {
    const view = classicViewFor(after, viewer(seat));
    const visible = seat === null ? ['S'] : [...new Set([seat, 'S'])];
    for (const handSeat of ['N', 'E', 'S', 'W']) {
      assert.equal(view.hands[handSeat] === null, !visible.includes(handSeat), `${seat}:${handSeat}`);
    }
  }
  const owner = classicViewFor(after, { role: 'OWNER', seat: 'N' });
  assert.ok(owner.hands.N && owner.hands.S);
  const unseatedOwner = classicViewFor(after, { role: 'OWNER', seat: null });
  assert.deepEqual(Object.entries(unseatedOwner.hands).filter(([, hand]) => hand).map(([seat]) => seat), ['S']);
});

test('auction projection gives full entries to self opponents and spectators but only calls to partner', () => {
  const state = deepFreeze(playingState());
  const nView = classicViewFor(state, viewer('N'));
  assert.deepEqual(nView.biddingHistory[0], {
    seat: 'N', bid: '1NT', alert: true, explain: '15–17',
    qa: [{ asker: 'E', question: 'Range?', answer: '15–17', answerer: 'N' }],
  });
  assert.deepEqual(nView.biddingHistory[2], { seat: 'S', bid: 'Pass' });
  assert.deepEqual(classicViewFor(state, viewer('E')).biddingHistory[2], {
    seat: 'S', bid: 'Pass', alert: true, explain: 'forcing', qa: [],
  });
  assert.deepEqual(classicViewFor(state, viewer(null)).biddingHistory[0], nView.biddingHistory[0]);

  for (const name of ['classic.bidding-updated', 'classic.bidding-ended']) {
    const payload = name.endsWith('updated') ? {
      biddingHistory: clone(state.biddingHistory), currentBidder: state.currentBidder,
      currentContract: clone(state.currentContract), consecutivePasses: state.consecutivePasses,
    } : {
      contract: clone(state.currentContract), declarer: state.declarer, dummy: state.dummy,
      leader: state.leader, biddingHistory: clone(state.biddingHistory),
    };
    payload.biddingHistory[0].qa[0].askerName = 'private adapter metadata';
    if (payload.currentContract) payload.currentContract.credentials = 'private';
    if (payload.contract) payload.contract.credentials = 'private';
    const event = deepFreeze({ name, payload });
    const forN = classicEventFor(event, viewer('N'));
    const forS = classicEventFor(event, viewer('S'));
    assert.deepEqual(forN.payload.biddingHistory[2], { seat: 'S', bid: 'Pass' });
    assert.deepEqual(forS.payload.biddingHistory[0], { seat: 'N', bid: '1NT' });
    assert.deepEqual(Object.keys(forN.payload.biddingHistory[0].qa[0]), [
      'asker', 'question', 'answer', 'answerer',
    ]);
    assertNoPrivateKeys(forN);
    forN.payload.biddingHistory[0].qa[0].answer = 'changed';
    assert.equal(event.payload.biddingHistory[0].qa[0].answer, '15–17');
    assert.notEqual(JSON.stringify(forN), JSON.stringify(forS));
  }
});

test('archived scores and finished events use exact public allowlists without private history', () => {
  const state = passedOutState();
  const view = classicViewFor(deepFreeze(state), viewer('S'));
  assert.deepEqual(Object.keys(view.boardScores[0]), [
    'dealNumber', 'boardNumber', 'score', 'passedOut', 'ddTable', 'biddingHistory',
  ]);
  assert.deepEqual(view.boardScores[0].biddingHistory[0], { seat: 'N', bid: 'Pass' });
  assertNoPrivateKeys(view.boardScores);

  const contract = { level: 1, suit: 'NT', seat: 'N', doubled: false, redoubled: false, doublerSeat: null };
  const score = 90;
  const events = [
    { name: 'classic.finished', payload: { reason: 'passed-out', dealNumber: 1, score: 0 } },
    { name: 'classic.finished', payload: { reason: 'played', dealNumber: 1, contract, declarer: 'N', nsTricks: 7, ewTricks: 6, score } },
    { name: 'classic.finished', payload: { reason: 'claimed', dealNumber: 1, contract, declarer: 'N', nsTricks: 7, ewTricks: 6, score, claim: { claimer: 'N', tricksToWin: 7, reason: 'rest' } } },
  ];
  for (const event of events) {
    const projected = classicEventFor(deepFreeze(event), viewer('S'));
    assert.deepEqual(projected, event);
    assertNoPrivateKeys(projected);
    if (projected.payload.contract) projected.payload.contract.level = 7;
    assert.equal(event.payload.contract?.level ?? 1, 1);
  }
});

test('claimed score views use the exact played-score allowlist and detach every nested branch', () => {
  const settled = settleClassicClaim(playingState(), {
    claimer: 'N', tricksToWin: 7, reason: 'rest',
  }).state;
  const view = classicViewFor(deepFreeze(settled), viewer('E'));
  const score = view.boardScores[0];
  assert.deepEqual(Object.keys(score), [
    'dealNumber', 'boardNumber', 'passedOut', 'contract', 'declarer', 'dummy',
    'declarerTricks', 'needed', 'score', 'made', 'diff', 'vulnerability',
    'biddingHistory', 'completedTricks', 'ddTable', 'claim',
  ]);
  assert.deepEqual(score.claim, { claimer: 'N', tricksToWin: 7, reason: 'rest' });
  assertNoPrivateKeys(score);
  score.contract.level = 7;
  score.claim.reason = 'changed';
  score.biddingHistory[0].qa[0].answer = 'changed';
  assert.equal(settled.boardScores[0].contract.level, 1);
  assert.equal(settled.boardScores[0].claim.reason, 'rest');
  assert.equal(settled.boardScores[0].biddingHistory[0].qa[0].answer, '15–17');
});

test('view boundaries classify malformed viewers as input and malformed trusted events as invariants', () => {
  const state = playingState();
  for (const malformed of [
    {},
    { role: 'PLAYER', seat: null },
    { role: 'SPECTATOR', seat: 'N' },
    { role: 'OWNER', seat: 'Q' },
    { role: 'PLAYER', seat: 'N', extra: true },
  ]) assert.throws(() => classicViewFor(state, malformed), error => (
    error instanceof ClassicInputError && error.kind === 'CLIENT_INPUT'
  ));
  assert.throws(() => classicEventFor({ name: 'classic.finished', payload: {} }, viewer('N')), error => (
    error instanceof ClassicInvariantError && error.kind === 'TRUSTED_STATE'
  ));
});

test('finished-event projection positively allowlists nested contract and claim fields', () => {
  const event = deepFreeze({
    name: 'classic.finished',
    payload: {
      reason: 'claimed', dealNumber: 1,
      contract: {
        level: 1, suit: 'NT', seat: 'N', doubled: false, redoubled: false,
        doublerSeat: null, initialHands: { private: true },
      },
      declarer: 'N', nsTricks: 7, ewTricks: 6, score: 90,
      claim: { claimer: 'N', tricksToWin: 7, reason: 'rest', credentials: 'private' },
    },
  });
  const projected = classicEventFor(event, viewer('E'));
  assert.deepEqual(Object.keys(projected.payload.contract), [
    'level', 'suit', 'seat', 'doubled', 'redoubled', 'doublerSeat',
  ]);
  assert.deepEqual(Object.keys(projected.payload.claim), ['claimer', 'tricksToWin', 'reason']);
  assertNoPrivateKeys(projected);
});
