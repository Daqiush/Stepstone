'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ClassicInputError, applyClassicCommand } = require('../classic/engine.cjs');
const {
  ClassicInvariantError, createClassicLobbyState, createClassicDealState, validateClassicState,
} = require('../classic/state.cjs');
const { boardInfoFor } = require('../classic/rules.cjs');
const { orderedDeal } = require('./helpers/classic-fixtures.js');
const {
  settleClassicClaim, editClassicBidAnnotation, appendClassicBidQuestion,
  answerClassicBidQuestion, applyClassicDdsCompletion,
} = require('../classic/node-compat.cjs');

function clone(value) { return structuredClone(value); }

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function context(seat) {
  return { actor: { role: 'PLAYER', seat }, occupiedSeats: ['N', 'E', 'S', 'W'], deal: null };
}

function bid(state, seat, token, alert = false, explain = null) {
  return applyClassicCommand(state, {
    name: 'classic.bid', payload: { expectedRevision: 0, bid: token, alert, explain },
  }, context(seat)).state;
}

function playingState() {
  let state = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(1),
  });
  for (const [seat, token] of [['N', '1NT'], ['E', 'Pass'], ['S', 'Pass'], ['W', 'Pass']]) {
    state = bid(state, seat, token);
  }
  return state;
}

function biddingState() {
  let state = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(1),
  });
  state = bid(state, 'N', '1NT', true, '15–17');
  state = bid(state, 'E', 'Pass');
  return state;
}

function assertInputError(invoke) {
  assert.throws(invoke, error => error instanceof ClassicInputError && error.kind === 'CLIENT_INPUT');
}

function assertInvariant(invoke) {
  assert.throws(invoke, error => error instanceof ClassicInvariantError && error.kind === 'TRUSTED_STATE');
}

function assertUnchanged(fn, state, payload) {
  deepFreeze(state);
  deepFreeze(payload);
  const before = [JSON.stringify(state), JSON.stringify(payload)];
  const result = fn(state, payload);
  assert.deepEqual([JSON.stringify(state), JSON.stringify(payload)], before);
  return result;
}

test('settleClassicClaim validates payload phase partition and corrupted state with exact failures', () => {
  const state = playingState();
  for (const payload of [
    {},
    { claimer: 'N', tricksToWin: 7 },
    { claimer: 'N', tricksToWin: 7, reason: 'rest', extra: true },
    { claimer: 'Q', tricksToWin: 7, reason: 'rest' },
    { claimer: 'N', tricksToWin: 1.5, reason: 'rest' },
    { claimer: 'N', tricksToWin: 14, reason: 'rest' },
    { claimer: 'N', tricksToWin: 7, reason: 'x'.repeat(501) },
  ]) assertInputError(() => settleClassicClaim(state, payload));

  assertInputError(() => settleClassicClaim(biddingState(), {
    claimer: 'N', tricksToWin: 14, reason: 'rest',
  }));

  assert.deepEqual(settleClassicClaim(biddingState(), {
    claimer: 'N', tricksToWin: 7, reason: 'rest',
  }), { ok: false, code: 'CLASSIC_WRONG_PHASE' });

  const corrupted = clone(state);
  corrupted.nsTricks = 1;
  assertInvariant(() => settleClassicClaim(corrupted, {
    claimer: 'N', tricksToWin: 7, reason: 'rest',
  }));
});

test('settleClassicClaim awards all remaining tricks once and returns exact finish result', () => {
  const state = playingState();
  const payload = { claimer: 'N', tricksToWin: 7, reason: 'remaining tricks' };
  const result = assertUnchanged(settleClassicClaim, state, payload);
  assert.equal(result.ok, true);
  assert.equal(result.state.phase, 'SCORING');
  assert.equal(result.state.nsTricks, 7);
  assert.equal(result.state.ewTricks, 6);
  assert.equal(result.state.nsTricks + result.state.ewTricks, 13);
  assert.deepEqual(result.state.claimSettlement, {
    ...payload, completedAtClaim: 0,
  });
  assert.equal(result.state.boardScores.length, 1);
  assert.deepEqual(result.state.boardScores[0].claim, payload);
  assert.deepEqual(result, {
    ok: true,
    state: result.state,
    events: [{
      name: 'classic.finished',
      payload: {
        reason: 'claimed', dealNumber: 1,
        contract: clone(state.currentContract), declarer: 'N',
        nsTricks: 7, ewTricks: 6, score: 90, claim: clone(payload),
      },
    }],
    effects: [],
    reply: { name: 'classic.claim-settled', phase: 'SCORING' },
  });
  assert.deepEqual(settleClassicClaim(result.state, payload), {
    ok: false, code: 'CLASSIC_WRONG_PHASE',
  });
  result.events[0].payload.claim.reason = 'changed';
  assert.equal(result.state.claimSettlement.reason, 'remaining tricks');
  result.state.claimSettlement.reason = 'output only';
  assert.equal(state.claimSettlement, null);
});

test('editClassicBidAnnotation maps exact input phase ownership and bounds failures', () => {
  const state = biddingState();
  for (const payload of [
    {},
    { seat: 'N', bidIndex: 0, alert: true },
    { seat: 'N', bidIndex: 0, alert: true, explain: null, extra: true },
    { seat: 'Q', bidIndex: 0, alert: true, explain: null },
    { seat: 'N', bidIndex: -1, alert: true, explain: null },
    { seat: 'N', bidIndex: 0.5, alert: true, explain: null },
    { seat: 'N', bidIndex: 0, alert: 'yes', explain: null },
    { seat: 'N', bidIndex: 0, alert: true, explain: '😀'.repeat(501) },
    { seat: 'N', bidIndex: 9, alert: true, explain: null },
  ]) assertInputError(() => editClassicBidAnnotation(state, payload));
  assert.deepEqual(editClassicBidAnnotation(playingState(), {
    seat: 'N', bidIndex: 0, alert: true, explain: null,
  }), { ok: false, code: 'CLASSIC_WRONG_PHASE' });
  assert.deepEqual(editClassicBidAnnotation(state, {
    seat: 'E', bidIndex: 0, alert: true, explain: null,
  }), { ok: false, code: 'CLASSIC_FORBIDDEN' });
});

test('editClassicBidAnnotation copies only the selected entry and normalizes unalerted explanation', () => {
  const state = biddingState();
  const first = assertUnchanged(editClassicBidAnnotation, state, {
    seat: 'N', bidIndex: 0, alert: true, explain: '😀'.repeat(500),
  });
  assert.equal(first.ok, true);
  assert.equal(first.state.biddingHistory[0].alert, true);
  assert.equal(first.state.biddingHistory[0].explain, '😀'.repeat(500));
  assert.notStrictEqual(first.state, state);
  assert.notStrictEqual(first.state.biddingHistory, state.biddingHistory);
  assert.notStrictEqual(first.state.biddingHistory[0], state.biddingHistory[0]);
  assert.strictEqual(first.state.biddingHistory[1], state.biddingHistory[1]);
  assert.deepEqual(first.events, []);
  assert.deepEqual(first.effects, []);
  assert.deepEqual(first.reply, { name: 'classic.bid-annotation-edited', phase: 'BIDDING' });

  const cleared = editClassicBidAnnotation(first.state, {
    seat: 'N', bidIndex: 0, alert: false, explain: 'discard me',
  });
  assert.equal(cleared.state.biddingHistory[0].alert, null);
  assert.equal(cleared.state.biddingHistory[0].explain, null);
});

test('appendClassicBidQuestion rejects malformed missing and same-side questions exactly', () => {
  const state = biddingState();
  for (const payload of [
    {},
    { bidIndex: 0, asker: 'E' },
    { bidIndex: 0, asker: 'E', question: '?', extra: true },
    { bidIndex: -1, asker: 'E', question: '?' },
    { bidIndex: 8, asker: 'E', question: '?' },
    { bidIndex: 0, asker: 'Q', question: '?' },
    { bidIndex: 0, asker: 'E', question: '😀'.repeat(501) },
  ]) assertInputError(() => appendClassicBidQuestion(state, payload));
  for (const asker of ['N', 'S']) {
    assert.deepEqual(appendClassicBidQuestion(state, {
      bidIndex: 0, asker, question: 'Explain?',
    }), { ok: false, code: 'CLASSIC_FORBIDDEN' });
  }
});

test('appendClassicBidQuestion adds the canonical seat-only QA record without events', () => {
  const state = biddingState();
  const result = assertUnchanged(appendClassicBidQuestion, state, {
    bidIndex: 0, asker: 'E', question: '😀'.repeat(500),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.biddingHistory[0].qa, [{
    asker: 'E', question: '😀'.repeat(500), answer: null, answerer: null,
  }]);
  assert.notStrictEqual(result.state.biddingHistory, state.biddingHistory);
  assert.notStrictEqual(result.state.biddingHistory[0], state.biddingHistory[0]);
  assert.notStrictEqual(result.state.biddingHistory[0].qa, state.biddingHistory[0].qa);
  assert.strictEqual(result.state.biddingHistory[1], state.biddingHistory[1]);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.effects, []);
  assert.deepEqual(result.reply, { name: 'classic.bid-question-added', phase: 'BIDDING' });
  result.state.biddingHistory[0].qa[0].question = 'output only';
  assert.equal(state.biddingHistory[0].qa.length, 0);
});

test('question and answer remain canonical after scoring by updating only the current archived history', () => {
  const scoring = passedOutForCompat();
  const asked = appendClassicBidQuestion(scoring, {
    bidIndex: 0, asker: 'E', question: 'Natural?',
  });
  assert.equal(asked.reply.phase, 'SCORING');
  assert.deepEqual(asked.state.boardScores[0].biddingHistory[0].qa, [{
    asker: 'E', question: 'Natural?', answer: null, answerer: null,
  }]);
  assert.notStrictEqual(asked.state.boardScores, scoring.boardScores);
  assert.notStrictEqual(asked.state.boardScores[0], scoring.boardScores[0]);
  const answered = answerClassicBidQuestion(asked.state, {
    bidIndex: 0, qaIdx: 0, answerer: 'N', answer: 'Yes',
  });
  assert.equal(answered.reply.phase, 'SCORING');
  assert.deepEqual(answered.state.boardScores[0].biddingHistory[0].qa[0], {
    asker: 'E', question: 'Natural?', answer: 'Yes', answerer: 'N',
  });
  assert.deepEqual(validateClassicState(answered.state), { ok: true });
});

function questionedState() {
  return appendClassicBidQuestion(biddingState(), {
    bidIndex: 0, asker: 'E', question: 'Range?',
  }).state;
}

function ddTable(seed = 0) {
  return Array.from({ length: 5 }, (_, row) => (
    Array.from({ length: 4 }, (_, column) => (seed + row + column) % 14)
  ));
}

test('answerClassicBidQuestion rejects malformed missing answered and non-bidder answers', () => {
  const state = questionedState();
  for (const payload of [
    {},
    { bidIndex: 0, qaIdx: 0, answerer: 'N' },
    { bidIndex: 0, qaIdx: 0, answerer: 'N', answer: '15–17', extra: true },
    { bidIndex: -1, qaIdx: 0, answerer: 'N', answer: '15–17' },
    { bidIndex: 8, qaIdx: 0, answerer: 'N', answer: '15–17' },
    { bidIndex: 0, qaIdx: -1, answerer: 'N', answer: '15–17' },
    { bidIndex: 0, qaIdx: 2, answerer: 'N', answer: '15–17' },
    { bidIndex: 0, qaIdx: 0, answerer: 'Q', answer: '15–17' },
    { bidIndex: 0, qaIdx: 0, answerer: 'N', answer: '😀'.repeat(501) },
  ]) assertInputError(() => answerClassicBidQuestion(state, payload));
  assert.deepEqual(answerClassicBidQuestion(state, {
    bidIndex: 0, qaIdx: 0, answerer: 'E', answer: '15–17',
  }), { ok: false, code: 'CLASSIC_FORBIDDEN' });

  const answered = answerClassicBidQuestion(state, {
    bidIndex: 0, qaIdx: 0, answerer: 'N', answer: '15–17',
  }).state;
  assertInputError(() => answerClassicBidQuestion(answered, {
    bidIndex: 0, qaIdx: 0, answerer: 'N', answer: 'again',
  }));
});

test('answerClassicBidQuestion copies the entry and QA branches with the exact compact reply', () => {
  const state = questionedState();
  const result = assertUnchanged(answerClassicBidQuestion, state, {
    bidIndex: 0, qaIdx: 0, answerer: 'N', answer: '😀'.repeat(500),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.biddingHistory[0].qa[0], {
    asker: 'E', question: 'Range?', answer: '😀'.repeat(500), answerer: 'N',
  });
  assert.notStrictEqual(result.state.biddingHistory, state.biddingHistory);
  assert.notStrictEqual(result.state.biddingHistory[0], state.biddingHistory[0]);
  assert.notStrictEqual(result.state.biddingHistory[0].qa, state.biddingHistory[0].qa);
  assert.notStrictEqual(result.state.biddingHistory[0].qa[0], state.biddingHistory[0].qa[0]);
  assert.strictEqual(result.state.biddingHistory[1], state.biddingHistory[1]);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.effects, []);
  assert.deepEqual(result.reply, { name: 'classic.bid-question-answered', phase: 'BIDDING' });
  result.state.biddingHistory[0].qa[0].answer = 'output only';
  assert.equal(state.biddingHistory[0].qa[0].answer, null);
});

test('applyClassicDdsCompletion strictly classifies client envelope and trusted DDS failures', () => {
  const state = biddingState();
  for (const payload of [
    {},
    { dealNumber: 1, ddTable: ddTable() },
    { dealNumber: 1, ddTable: ddTable(), failed: false, extra: true },
    { dealNumber: 0, ddTable: ddTable(), failed: false },
    { dealNumber: 1.5, ddTable: ddTable(), failed: false },
    { dealNumber: 1, ddTable: ddTable(), failed: 'no' },
  ]) assertInputError(() => applyClassicDdsCompletion(state, payload));

  const invalidTables = [
    null,
    [],
    Array.from({ length: 4 }, () => [0, 0, 0, 0]),
    Array.from({ length: 5 }, () => [0, 0, 0]),
    Array.from({ length: 5 }, () => [0, 0, 0, 14]),
    Array.from({ length: 5 }, () => [0, 0, 0, 1.5]),
  ];
  for (const table of invalidTables) assertInvariant(() => applyClassicDdsCompletion(state, {
    dealNumber: 1, ddTable: table, failed: false,
  }));
  assertInvariant(() => applyClassicDdsCompletion(state, {
    dealNumber: 1, ddTable: ddTable(), failed: true,
  }));
  assertInvariant(() => applyClassicDdsCompletion(state, {
    dealNumber: 1, ddTable: null, failed: false,
  }));
});

test('applyClassicDdsCompletion makes matching pending success READY without rewriting score history', () => {
  const prior = passedOutForCompat();
  const state = createClassicDealState(prior, {
    hands: orderedDeal(), boardInfo: boardInfoFor(2),
  });
  const priorScores = JSON.stringify(state.boardScores);
  const table = ddTable(1);
  const result = assertUnchanged(applyClassicDdsCompletion, state, {
    dealNumber: 2, ddTable: table, failed: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.ddsStatus, 'READY');
  assert.deepEqual(result.state.ddTable, table);
  assert.equal(JSON.stringify(result.state.boardScores), priorScores);
  assert.deepEqual(result.events, [{
    name: 'classic.dd-table-ready', payload: { dealNumber: 2, ddTable: table },
  }]);
  assert.deepEqual(result.effects, []);
  assert.deepEqual(result.reply, { name: 'classic.dd-completed', phase: 'BIDDING' });
  result.state.ddTable[0][0] = 13;
  assert.notEqual(result.events[0].payload.ddTable[0][0], 13);
  assert.notEqual(table[0][0], 13);
});

function passedOutForCompat() {
  let state = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(1),
  });
  for (const seat of ['N', 'E', 'S', 'W']) state = bid(state, seat, 'Pass');
  return state;
}

test('applyClassicDdsCompletion ignores stale/nonpending work with detached byte-equal state', () => {
  const pending = biddingState();
  const stale = assertUnchanged(applyClassicDdsCompletion, pending, {
    dealNumber: 2, ddTable: ddTable(), failed: false,
  });
  assert.equal(JSON.stringify(stale.state), JSON.stringify(pending));
  assert.notStrictEqual(stale.state, pending);
  stale.state.hands.N[0].rank = 'A';
  assert.notEqual(pending.hands.N[0].rank, 'A');
  assert.deepEqual(stale.events, []);
  assert.deepEqual(stale.effects, []);
  assert.deepEqual(stale.reply, { name: 'classic.dd-ignored', phase: 'BIDDING' });

  const failedState = clone(pending);
  failedState.ddsStatus = 'FAILED';
  const ignored = applyClassicDdsCompletion(failedState, {
    dealNumber: 1, ddTable: ddTable(), failed: false,
  });
  assert.equal(JSON.stringify(ignored.state), JSON.stringify(failedState));
  assert.notStrictEqual(ignored.state, failedState);
  assert.deepEqual(ignored.reply, { name: 'classic.dd-ignored', phase: 'BIDDING' });
});

test('applyClassicDdsCompletion accepts only exact matching terminal failure and marks FAILED', () => {
  const state = biddingState();
  const result = assertUnchanged(applyClassicDdsCompletion, state, {
    dealNumber: 1, ddTable: null, failed: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.ddsStatus, 'FAILED');
  assert.equal(result.state.ddTable, null);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.effects, []);
  assert.deepEqual(result.reply, { name: 'classic.dd-failed', phase: 'BIDDING' });
  result.state.hands.N[0].rank = 'A';
  assert.notEqual(state.hands.N[0].rank, 'A');
});

test('late matching DDS completion updates live scoring state but leaves archived table snapshot null', () => {
  const state = passedOutForCompat();
  assert.equal(state.phase, 'SCORING');
  assert.equal(state.ddsStatus, 'PENDING');
  assert.equal(state.boardScores[0].ddTable, null);
  assert.deepEqual(validateClassicState(state), { ok: true });
  const result = applyClassicDdsCompletion(state, {
    dealNumber: 1, ddTable: ddTable(3), failed: false,
  });
  assert.equal(result.state.ddsStatus, 'READY');
  assert.deepEqual(result.state.ddTable, ddTable(3));
  assert.equal(result.state.boardScores[0].ddTable, null);
  assert.deepEqual(validateClassicState(result.state), { ok: true });
});
