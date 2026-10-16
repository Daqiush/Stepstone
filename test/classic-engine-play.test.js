'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ClassicInputError, preflightClassicCommand, applyClassicCommand,
} = require('../classic/engine.cjs');
const {
  ClassicInvariantError, createClassicLobbyState, createClassicDealState,
} = require('../classic/state.cjs');
const { boardInfoFor } = require('../classic/rules.cjs');
const { RANKS } = require('../classic/constants.cjs');
const { orderedDeal } = require('./helpers/classic-fixtures.js');

const FOUR_SEATS = Object.freeze(['N', 'E', 'S', 'W']);

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

function player(seat) {
  return { role: 'PLAYER', seat };
}

function preflightContext(actor) {
  return { actor, occupiedSeats: [...FOUR_SEATS] };
}

function applyContext(actor, deal = null) {
  return { actor, occupiedSeats: [...FOUR_SEATS], deal };
}

function bidCommand(bid) {
  return {
    name: 'classic.bid',
    payload: { expectedRevision: 0, bid, alert: false, explain: null },
  };
}

function playCommand(card, expectedRevision = 0) {
  return { name: 'classic.play', payload: { expectedRevision, card } };
}

function readyCommand(expectedRevision = 0) {
  return { name: 'classic.ready-next', payload: { expectedRevision } };
}

function makePlayingState(contractBid = '1NT', hands = orderedDeal()) {
  let state = createClassicDealState(createClassicLobbyState(), {
    hands, boardInfo: boardInfoFor(1),
  });
  for (const [seat, bid] of [
    ['N', contractBid], ['E', 'Pass'], ['S', 'Pass'], ['W', 'Pass'],
  ]) {
    state = applyClassicCommand(
      state, bidCommand(bid), applyContext(player(seat)),
    ).state;
  }
  return state;
}

function makePassedOutState() {
  let state = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(1),
  });
  for (const seat of FOUR_SEATS) {
    state = applyClassicCommand(
      state, bidCommand('Pass'), applyContext(player(seat)),
    ).state;
  }
  return state;
}

function playOne(state, actorSeat, card, revision = 0) {
  return applyClassicCommand(
    state, playCommand(card, revision), applyContext(player(actorSeat)),
  );
}

function completeOpeningTrick(contractBid) {
  let state = makePlayingState(contractBid);
  for (const [actorSeat, card] of [
    ['E', { suit: 'H', rank: '2' }],
    ['N', { suit: 'D', rank: '2' }],
    ['W', { suit: 'C', rank: '2' }],
  ]) state = playOne(state, actorSeat, card).state;
  return playOne(state, 'N', { suit: 'S', rank: '2' });
}

function playFullOrderedBoard(initial = makePlayingState()) {
  let state = initial;
  const results = [];
  let revision = 1;
  for (const rank of RANKS) {
    for (const [actorSeat, card] of [
      ['E', { suit: 'H', rank }],
      ['N', { suit: 'D', rank }],
      ['W', { suit: 'C', rank }],
      ['N', { suit: 'S', rank }],
    ]) {
      const command = playCommand(card, revision++);
      const context = applyContext(player(actorSeat));
      const result = assertUnchanged(applyClassicCommand, state, command, context);
      results.push(result);
      state = result.state;
    }
  }
  return { state, results };
}

function assertInputError(invoke) {
  assert.throws(invoke, error => {
    assert.ok(error instanceof ClassicInputError);
    assert.equal(error.kind, 'CLIENT_INPUT');
    return true;
  });
}

function assertInvariant(invoke) {
  assert.throws(invoke, error => {
    assert.ok(error instanceof ClassicInvariantError);
    assert.equal(error.kind, 'TRUSTED_STATE');
    return true;
  });
}

function assertUnchanged(fn, ...values) {
  const frozen = values.map(value => deepFreeze(value));
  const before = frozen.map(value => JSON.stringify(value));
  const result = fn(...frozen);
  assert.deepEqual(frozen.map(value => JSON.stringify(value)), before);
  return result;
}

function swapCards(hands, leftSeat, leftIndex, rightSeat, rightIndex) {
  [hands[leftSeat][leftIndex], hands[rightSeat][rightIndex]] = [
    hands[rightSeat][rightIndex], hands[leftSeat][leftIndex],
  ];
  return hands;
}

test('classic.play rejects malformed payloads as client input', () => {
  const state = makePlayingState();
  const malformed = [
    {},
    { expectedRevision: 0 },
    { expectedRevision: 0, card: { suit: 'H', rank: '2' }, extra: true },
    { expectedRevision: -1, card: { suit: 'H', rank: '2' } },
    { expectedRevision: 0, card: null },
    { expectedRevision: 0, card: { suit: 'H' } },
    { expectedRevision: 0, card: { suit: 'H', rank: '2', extra: true } },
    { expectedRevision: 0, card: { suit: 'X', rank: '2' } },
    { expectedRevision: 0, card: { suit: 'H', rank: 2 } },
  ];
  for (const payload of malformed) {
    assertInputError(() => preflightClassicCommand(
      state, { name: 'classic.play', payload }, preflightContext(player('E')),
    ));
    assertInputError(() => applyClassicCommand(
      state, { name: 'classic.play', payload }, applyContext(player('E')),
    ));
  }
});

test('classic.play returns exact phase, authorization, and turn failures without mutation', () => {
  const playing = makePlayingState();
  const command = playCommand({ suit: 'H', rank: '2' });
  const cases = [
    [createClassicLobbyState(), preflightContext(player('N')),
      { ok: false, code: 'CLASSIC_WRONG_PHASE' }],
    [playing, preflightContext({ role: 'SPECTATOR', seat: null }),
      { ok: false, code: 'CLASSIC_FORBIDDEN' }],
    [playing, { actor: player('E'), occupiedSeats: ['N', 'S', 'W'] },
      { ok: false, code: 'CLASSIC_FORBIDDEN' }],
    [playing, preflightContext(player('N')),
      { ok: false, code: 'CLASSIC_NOT_YOUR_TURN' }],
  ];
  for (const [state, context, expected] of cases) {
    assert.deepEqual(assertUnchanged(preflightClassicCommand, state, command, context), expected);
    assert.deepEqual(assertUnchanged(
      applyClassicCommand, state, command, { ...context, deal: null },
    ), expected);
  }
  assertInvariant(() => applyClassicCommand(
    playing,
    command,
    applyContext(player('E'), { hands: orderedDeal(), boardInfo: boardInfoFor(2) }),
  ));
});

test('classic.play removes one card from the played hand and enforces held and follow-suit rules', () => {
  const hands = swapCards(orderedDeal(), 'E', 0, 'S', 0);
  const opening = makePlayingState('1NT', hands);

  assert.deepEqual(preflightClassicCommand(
    opening,
    playCommand({ suit: 'C', rank: '2' }),
    preflightContext(player('E')),
  ), { ok: false, code: 'CLASSIC_CARD_NOT_HELD' });

  const lead = assertUnchanged(
    applyClassicCommand,
    opening,
    playCommand({ suit: 'H', rank: '3' }),
    applyContext(player('E')),
  );
  assert.equal(lead.ok, true);
  assert.equal(lead.state.hands.E.length, 12);
  assert.equal(lead.state.hands.E.some(card => card.suit === 'H' && card.rank === '3'), false);
  assert.deepEqual(lead.state.currentTrick, [{ seat: 'E', card: { suit: 'H', rank: '3' } }]);
  assert.equal(lead.state.currentPlayer, 'S');
  assert.deepEqual(lead.reply, { name: 'classic.play', phase: 'PLAYING' });

  assert.deepEqual(preflightClassicCommand(
    lead.state,
    playCommand({ suit: 'D', rank: '3' }),
    preflightContext(player('N')),
  ), { ok: false, code: 'CLASSIC_MUST_FOLLOW_SUIT' });
  assert.deepEqual(preflightClassicCommand(
    lead.state,
    playCommand({ suit: 'H', rank: '2' }),
    preflightContext(player('S')),
  ), { ok: false, code: 'CLASSIC_NOT_YOUR_TURN' });

  const dummyPlay = assertUnchanged(
    applyClassicCommand,
    lead.state,
    playCommand({ suit: 'H', rank: '2' }),
    applyContext(player('N')),
  );
  assert.equal(dummyPlay.state.hands.S.length, 12);
  assert.equal(dummyPlay.state.hands.S.some(card => card.suit === 'H' && card.rank === '2'), false);
  assert.equal(dummyPlay.state.hands.N.length, 13);
  assert.deepEqual(dummyPlay.events, [{
    name: 'classic.card-played',
    payload: {
      seat: 'S',
      card: { suit: 'H', rank: '2' },
      currentTrick: [
        { seat: 'E', card: { suit: 'H', rank: '3' } },
        { seat: 'S', card: { suit: 'H', rank: '2' } },
      ],
    },
  }]);
});

test('opening lead reveals dummy before the detached card-played event', () => {
  const state = makePlayingState();
  const result = assertUnchanged(
    applyClassicCommand,
    state,
    playCommand({ suit: 'H', rank: '2' }),
    applyContext(player('E')),
  );
  assert.equal(result.state.dummyRevealed, true);
  assert.deepEqual(result.events, [
    { name: 'classic.dummy-revealed', payload: { dummy: 'S' } },
    {
      name: 'classic.card-played',
      payload: {
        seat: 'E',
        card: { suit: 'H', rank: '2' },
        currentTrick: [{ seat: 'E', card: { suit: 'H', rank: '2' } }],
      },
    },
  ]);
  result.events[1].payload.card.rank = 'A';
  result.events[1].payload.currentTrick[0].card.rank = 'K';
  assert.deepEqual(result.state.currentTrick, [
    { seat: 'E', card: { suit: 'H', rank: '2' } },
  ]);
});

test('classic.play copies only changed branches and shares untouched state branches', () => {
  const state = deepFreeze(makePlayingState());
  const result = applyClassicCommand(
    state,
    deepFreeze(playCommand({ suit: 'H', rank: '2' })),
    deepFreeze(applyContext(player('E'))),
  );
  assert.notStrictEqual(result.state, state);
  assert.notStrictEqual(result.state.hands, state.hands);
  assert.notStrictEqual(result.state.hands.E, state.hands.E);
  assert.notStrictEqual(result.state.currentTrick, state.currentTrick);
  for (const seat of ['N', 'S', 'W']) {
    assert.strictEqual(result.state.hands[seat], state.hands[seat], seat);
  }
  for (const key of [
    'boardInfo', 'initialHands', 'readyStatus', 'biddingHistory', 'currentContract',
    'completedTricks', 'boardScores',
  ]) assert.strictEqual(result.state[key], state[key], key);
});

test('fourth card completes a no-trump trick and makes its winner leader', () => {
  const result = completeOpeningTrick('1NT');
  const cards = [
    { seat: 'E', card: { suit: 'H', rank: '2' } },
    { seat: 'S', card: { suit: 'D', rank: '2' } },
    { seat: 'W', card: { suit: 'C', rank: '2' } },
    { seat: 'N', card: { suit: 'S', rank: '2' } },
  ];
  const trick = { cards, winner: 'E' };
  assert.deepEqual(result.state.currentTrick, []);
  assert.deepEqual(result.state.completedTricks, [trick]);
  assert.equal(result.state.nsTricks, 0);
  assert.equal(result.state.ewTricks, 1);
  assert.equal(result.state.currentPlayer, 'E');
  assert.deepEqual(result.events, [
    {
      name: 'classic.card-played',
      payload: { seat: 'N', card: { suit: 'S', rank: '2' }, currentTrick: cards },
    },
    {
      name: 'classic.trick-ended',
      payload: { trick, winner: 'E', nsTricks: 0, ewTricks: 1 },
    },
  ]);
});

test('fourth card applies trump and increments only the winning side', () => {
  const result = completeOpeningTrick('1S');
  const trick = result.state.completedTricks[0];
  assert.equal(trick.winner, 'N');
  assert.equal(result.state.nsTricks, 1);
  assert.equal(result.state.ewTricks, 0);
  assert.equal(result.state.currentPlayer, 'N');
  assert.deepEqual(result.events[1], {
    name: 'classic.trick-ended',
    payload: { trick: clone(trick), winner: 'N', nsTricks: 1, ewTricks: 0 },
  });
  result.events[1].payload.trick.cards[0].card.rank = 'A';
  assert.equal(result.state.completedTricks[0].cards[0].card.rank, '2');
});

test('thirteenth trick finishes once with exact event order, score, and scoring reply', () => {
  const { state, results } = playFullOrderedBoard();
  const result = results.at(-1);
  const finalRank = 'A';
  const finalCards = [
    { seat: 'E', card: { suit: 'H', rank: finalRank } },
    { seat: 'S', card: { suit: 'D', rank: finalRank } },
    { seat: 'W', card: { suit: 'C', rank: finalRank } },
    { seat: 'N', card: { suit: 'S', rank: finalRank } },
  ];
  assert.equal(state.phase, 'SCORING');
  assert.equal(state.completedTricks.length, 13);
  assert.equal(state.currentTrick.length, 0);
  assert.equal(state.nsTricks, 0);
  assert.equal(state.ewTricks, 13);
  assert.equal(state.boardScores.length, 1);
  assert.equal(state.boardScores[0].score, -350);
  assert.deepEqual(result.reply, { name: 'classic.play', phase: 'SCORING' });
  assert.deepEqual(result.events, [
    {
      name: 'classic.card-played',
      payload: { seat: 'N', card: { suit: 'S', rank: finalRank }, currentTrick: finalCards },
    },
    {
      name: 'classic.trick-ended',
      payload: {
        trick: { cards: finalCards, winner: 'E' },
        winner: 'E', nsTricks: 0, ewTricks: 13,
      },
    },
    {
      name: 'classic.finished',
      payload: {
        reason: 'played', dealNumber: 1,
        contract: {
          level: 1, suit: 'NT', seat: 'N', doubled: false,
          redoubled: false, doublerSeat: null,
        },
        declarer: 'N', nsTricks: 0, ewTricks: 13, score: -350,
      },
    },
  ]);

  const retryCommand = playCommand({ suit: 'S', rank: finalRank }, 52);
  const retryContext = applyContext(player('N'));
  const retry = assertUnchanged(applyClassicCommand, state, retryCommand, retryContext);
  assert.deepEqual(retry, { ok: false, code: 'CLASSIC_WRONG_PHASE' });
  assert.equal(state.boardScores.length, 1);
});

test('two byte-equal 52-play transcripts remain byte-equal at every step', () => {
  let left = clone(makePlayingState());
  let right = clone(makePlayingState());
  let revision = 1;
  for (const rank of RANKS) {
    for (const [actorSeat, card] of [
      ['E', { suit: 'H', rank }],
      ['N', { suit: 'D', rank }],
      ['W', { suit: 'C', rank }],
      ['N', { suit: 'S', rank }],
    ]) {
      const leftResult = assertUnchanged(
        applyClassicCommand,
        left,
        playCommand(clone(card), revision),
        applyContext(player(actorSeat)),
      );
      const rightResult = assertUnchanged(
        applyClassicCommand,
        right,
        playCommand(clone(card), revision),
        applyContext(player(actorSeat)),
      );
      assert.equal(JSON.stringify(leftResult), JSON.stringify(rightResult));
      left = leftResult.state;
      right = rightResult.state;
      revision += 1;
    }
  }
  assert.equal(JSON.stringify(left), JSON.stringify(right));
  assert.deepEqual(left.boardScores, right.boardScores);
});

test('classic.ready-next validates exact payload and returns phase and authorization failures', () => {
  const scoring = makePassedOutState();
  for (const payload of [
    {},
    { expectedRevision: 0, extra: true },
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { expectedRevision: '0' },
  ]) {
    assertInputError(() => preflightClassicCommand(
      scoring,
      { name: 'classic.ready-next', payload },
      preflightContext(player('N')),
    ));
  }

  assert.deepEqual(preflightClassicCommand(
    makePlayingState(), readyCommand(), preflightContext(player('E')),
  ), { ok: false, code: 'CLASSIC_WRONG_PHASE' });
  assert.deepEqual(preflightClassicCommand(
    scoring, readyCommand(), preflightContext({ role: 'SPECTATOR', seat: null }),
  ), { ok: false, code: 'CLASSIC_FORBIDDEN' });
  assert.deepEqual(preflightClassicCommand(
    scoring, readyCommand(), { actor: player('N'), occupiedSeats: ['E', 'S', 'W'] },
  ), { ok: false, code: 'CLASSIC_FORBIDDEN' });
});

test('classic.ready-next immutably toggles only one seat while fewer than four are ready', () => {
  const scoring = makePassedOutState();
  const result = assertUnchanged(
    applyClassicCommand,
    scoring,
    readyCommand(10),
    applyContext(player('N')),
  );
  assert.deepEqual(result, {
    ok: true,
    state: { ...clone(scoring), readyStatus: { N: true, E: false, S: false, W: false } },
    events: [{
      name: 'classic.ready-updated',
      payload: { readyStatus: { N: true, E: false, S: false, W: false } },
    }],
    effects: [],
    reply: { name: 'classic.ready-next', phase: 'SCORING' },
  });
  assert.notStrictEqual(result.state, scoring);
  assert.notStrictEqual(result.state.readyStatus, scoring.readyStatus);
  for (const key of [
    'boardInfo', 'hands', 'initialHands', 'biddingHistory', 'currentTrick',
    'completedTricks', 'boardScores',
  ]) assert.strictEqual(result.state[key], scoring[key], key);
  result.events[0].payload.readyStatus.N = false;
  assert.equal(result.state.readyStatus.N, true);

  const toggledBack = assertUnchanged(
    applyClassicCommand,
    result.state,
    readyCommand(11),
    applyContext(player('N')),
  );
  assert.deepEqual(toggledBack.state.readyStatus, {
    N: false, E: false, S: false, W: false,
  });
});

test('fourth ready preflights and starts the exact trusted next deal with ordered events', () => {
  const scoring = makePassedOutState();
  scoring.readyStatus = { N: true, E: true, S: true, W: false };
  const command = readyCommand(20);
  assert.deepEqual(assertUnchanged(
    preflightClassicCommand,
    scoring,
    command,
    preflightContext(player('W')),
  ), { ok: true, needsDeal: true, nextDealNumber: 2 });

  assertInvariant(() => applyClassicCommand(
    scoring, command, applyContext(player('W'), null),
  ));
  assertInvariant(() => applyClassicCommand(
    scoring,
    command,
    applyContext(player('W'), { hands: orderedDeal(), boardInfo: boardInfoFor(1) }),
  ));

  const trustedDeal = { hands: orderedDeal(), boardInfo: boardInfoFor(2) };
  const result = assertUnchanged(
    applyClassicCommand,
    scoring,
    command,
    applyContext(player('W'), trustedDeal),
  );
  assert.equal(result.state.phase, 'BIDDING');
  assert.equal(result.state.dealNumber, 2);
  assert.deepEqual(result.state.readyStatus, { N: false, E: false, S: false, W: false });
  assert.equal(result.state.currentBidder, 'E');
  assert.equal(result.state.boardScores.length, 1);
  assert.deepEqual(result.events, [
    {
      name: 'classic.ready-updated',
      payload: { readyStatus: { N: true, E: true, S: true, W: true } },
    },
    {
      name: 'classic.started',
      payload: { dealNumber: 2, boardInfo: boardInfoFor(2) },
    },
    {
      name: 'classic.bidding-updated',
      payload: {
        biddingHistory: [], currentBidder: 'E', currentContract: null, consecutivePasses: 0,
      },
    },
  ]);
  assert.deepEqual(result.effects, [{ type: 'classic.compute-dd-table', dealNumber: 2 }]);
  assert.deepEqual(result.reply, { name: 'classic.ready-next', phase: 'BIDDING' });
  result.events[0].payload.readyStatus.N = false;
  result.events[1].payload.boardInfo.number = 16;
  assert.deepEqual(result.state.readyStatus, { N: false, E: false, S: false, W: false });
  assert.equal(result.state.boardInfo.number, 2);
});
