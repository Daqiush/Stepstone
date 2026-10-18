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

function owner(seat = 'N') {
  return { role: 'OWNER', seat };
}

function player(seat) {
  return { role: 'PLAYER', seat };
}

function preflightContext(actor = owner()) {
  return { actor, occupiedSeats: [...FOUR_SEATS] };
}

function applyContext(actor = owner(), deal = null) {
  return { actor, occupiedSeats: [...FOUR_SEATS], deal };
}

function deal(number = 1) {
  return { hands: orderedDeal(), boardInfo: boardInfoFor(number) };
}

function startCommand() {
  return { name: 'classic.start', payload: { expectedRevision: 0 } };
}

function bidCommand(bid, options = {}) {
  return {
    name: 'classic.bid',
    payload: {
      expectedRevision: options.expectedRevision ?? 0,
      bid,
      alert: options.alert ?? false,
      explain: options.explain ?? null,
    },
  };
}

function biddingState() {
  return createClassicDealState(createClassicLobbyState(), deal());
}

function applyBid(state, seat, bid, options = {}) {
  return applyClassicCommand(
    state,
    bidCommand(bid, options),
    applyContext(player(seat), null),
  );
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

test('command entry points reject malformed client commands and malformed trusted contexts distinctly', () => {
  const state = createClassicLobbyState();
  const commandCases = [
    null,
    {},
    { name: 'classic.start' },
    { name: 'classic.start', payload: { expectedRevision: 0 }, extra: true },
    { name: 'classic.unknown', payload: {} },
  ];
  for (const command of commandCases) {
    assertInputError(() => preflightClassicCommand(state, command, preflightContext()));
    assertInputError(() => applyClassicCommand(state, command, applyContext(owner(), deal())));
  }

  const contextCases = [
    {},
    { actor: owner(), occupiedSeats: [...FOUR_SEATS], extra: true },
    { actor: { role: 'ADMIN', seat: 'N' }, occupiedSeats: [...FOUR_SEATS] },
    { actor: { role: 'PLAYER', seat: null }, occupiedSeats: [...FOUR_SEATS] },
    { actor: { role: 'SPECTATOR', seat: 'N' }, occupiedSeats: [...FOUR_SEATS] },
    { actor: owner(), occupiedSeats: ['N', 'E', 'S', 'S'] },
  ];
  for (const context of contextCases) {
    assertInvariant(() => preflightClassicCommand(state, startCommand(), context));
  }
  assertInvariant(() => applyClassicCommand(
    state, startCommand(), { ...applyContext(owner(), deal()), extra: true },
  ));

  const corrupt = createClassicLobbyState();
  corrupt.extra = true;
  assertInvariant(() => preflightClassicCommand(corrupt, startCommand(), preflightContext()));
});

test('trusted occupiedSeats rejects sparse, inherited-index, and extra-key arrays', () => {
  const sparseWithCompensatingKey = ['N', 'E', , 'W'];
  sparseWithCompensatingKey.compensatesForHole = true;

  const inheritedIndex = ['N', 'E', , 'W'];
  const inheritedIndexPrototype = Object.create(Array.prototype);
  Object.defineProperty(inheritedIndexPrototype, '2', {
    value: 'S', enumerable: true, configurable: true,
  });
  Object.setPrototypeOf(inheritedIndex, inheritedIndexPrototype);
  inheritedIndex.compensatesForHole = true;

  const extraSymbol = [...FOUR_SEATS];
  extraSymbol[Symbol('extra')] = true;

  for (const occupiedSeats of [sparseWithCompensatingKey, inheritedIndex, extraSymbol]) {
    assertInvariant(() => preflightClassicCommand(
      createClassicLobbyState(), startCommand(), { actor: owner(), occupiedSeats },
    ));
  }
});

test('preflight is immutable, reports exact deal need, and spectators receive a domain failure', () => {
  const lobby = createClassicLobbyState();
  const command = startCommand();
  const context = preflightContext();
  assert.deepEqual(assertUnchanged(preflightClassicCommand, lobby, command, context), {
    ok: true, needsDeal: true, nextDealNumber: 1,
  });

  const spectator = preflightContext({ role: 'SPECTATOR', seat: null });
  assert.deepEqual(assertUnchanged(preflightClassicCommand, lobby, command, spectator), {
    ok: false, code: 'CLASSIC_FORBIDDEN',
  });

  const state = biddingState();
  const bid = bidCommand('Pass');
  const bidContext = preflightContext(player('N'));
  assert.deepEqual(assertUnchanged(preflightClassicCommand, state, bid, bidContext), {
    ok: true, needsDeal: false, nextDealNumber: null,
  });
});

test('preflight marks only the legal fourth ready toggle as needing the next deal', () => {
  const state = biddingState();
  state.phase = 'SCORING';
  state.biddingHistory = ['N', 'E', 'S', 'W'].map(seat => ({
    seat, bid: 'Pass', alert: null, explain: null, qa: [],
  }));
  state.currentBidder = null;
  state.consecutivePasses = 4;
  const score = {
    dealNumber: 1,
    boardNumber: 1,
    score: 0,
    passedOut: true,
    ddTable: null,
    biddingHistory: clone(state.biddingHistory),
    initialHands: clone(state.initialHands),
  };
  state.boardScores = [score];
  state.readyStatus = { N: true, E: true, S: true, W: false };
  const command = { name: 'classic.ready-next', payload: { expectedRevision: 4 } };
  assert.deepEqual(assertUnchanged(
    preflightClassicCommand, state, command, preflightContext(player('W')),
  ), {
    ok: true, needsDeal: true, nextDealNumber: 2,
  });
  assert.deepEqual(assertUnchanged(
    preflightClassicCommand, state, command, preflightContext(player('N')),
  ), {
    ok: true, needsDeal: false, nextDealNumber: null,
  });
});

test('classic.start enforces exact payload, owner, lobby, complete seats, and trusted deal', () => {
  const lobby = createClassicLobbyState();
  const malformedPayloads = [
    {},
    { expectedRevision: 0, extra: true },
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { expectedRevision: '0' },
  ];
  for (const payload of malformedPayloads) {
    assertInputError(() => preflightClassicCommand(
      lobby, { name: 'classic.start', payload }, preflightContext(),
    ));
  }

  assert.deepEqual(preflightClassicCommand(
    lobby, startCommand(), preflightContext(player('N')),
  ), { ok: false, code: 'CLASSIC_FORBIDDEN' });
  assert.deepEqual(preflightClassicCommand(
    lobby, startCommand(), { actor: owner(), occupiedSeats: ['N', 'E', 'S'] },
  ), { ok: false, code: 'CLASSIC_SEATS_INCOMPLETE' });
  assert.deepEqual(preflightClassicCommand(
    biddingState(), startCommand(), preflightContext(),
  ), { ok: false, code: 'CLASSIC_WRONG_PHASE' });

  assertInvariant(() => applyClassicCommand(lobby, startCommand(), applyContext(owner(), null)));
  assertInvariant(() => applyClassicCommand(lobby, startCommand(), applyContext(owner(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(2),
  })));
});

test('classic.start creates the exact bidding state, events, effect, and detached result', () => {
  const lobby = createClassicLobbyState();
  const command = startCommand();
  const trustedDeal = deal();
  const context = applyContext(owner(), trustedDeal);
  const result = assertUnchanged(applyClassicCommand, lobby, command, context);

  const expectedState = createClassicDealState(lobby, trustedDeal);
  const biddingPayload = {
    biddingHistory: [],
    currentBidder: 'N',
    currentContract: null,
    consecutivePasses: 0,
  };
  assert.deepEqual(result, {
    ok: true,
    state: expectedState,
    events: [
      { name: 'classic.started', payload: { dealNumber: 1, boardInfo: boardInfoFor(1) } },
      { name: 'classic.bidding-updated', payload: biddingPayload },
    ],
    effects: [{ type: 'classic.compute-dd-table', dealNumber: 1 }],
    reply: { name: 'classic.start', phase: 'BIDDING' },
  });

  assert.equal(JSON.stringify(result).includes('initialHands'), true);
  assert.equal(JSON.stringify(result.events).includes('hands'), false);
  assert.equal(JSON.stringify(result.effects).includes('hands'), false);
  assert.notStrictEqual(result.state, lobby);
  assert.notStrictEqual(result.state.hands, trustedDeal.hands);
  assert.notStrictEqual(result.events[0].payload.boardInfo, result.state.boardInfo);
  result.events[0].payload.boardInfo.number = 16;
  result.events[1].payload.biddingHistory.push({});
  assert.equal(result.state.boardInfo.number, 1);
  assert.equal(result.state.biddingHistory.length, 0);
});

test('classic.bid enforces exact payload types and bounded alert text', () => {
  const state = biddingState();
  const malformedPayloads = [
    {},
    { expectedRevision: 0, bid: 'Pass', alert: false },
    { expectedRevision: 0, bid: 'Pass', alert: false, explain: null, extra: true },
    { expectedRevision: -1, bid: 'Pass', alert: false, explain: null },
    { expectedRevision: 0, bid: 1, alert: false, explain: null },
    { expectedRevision: 0, bid: 'bogus', alert: false, explain: null },
    { expectedRevision: 0, bid: 'Pass', alert: null, explain: null },
    { expectedRevision: 0, bid: 'Pass', alert: false, explain: 'not alerted' },
    { expectedRevision: 0, bid: '1C', alert: true, explain: '😀'.repeat(501) },
  ];
  for (const payload of malformedPayloads) {
    assertInputError(() => preflightClassicCommand(
      state, { name: 'classic.bid', payload }, preflightContext(player('N')),
    ));
  }
  assert.deepEqual(preflightClassicCommand(
    state,
    bidCommand('1C', { alert: true, explain: '😀'.repeat(500) }),
    preflightContext(player('N')),
  ), { ok: true, needsDeal: false, nextDealNumber: null });
});

test('classic.bid returns exact phase, authorization, turn, and bid domain failures without mutation', () => {
  const state = biddingState();
  const cases = [
    [createClassicLobbyState(), bidCommand('Pass'), preflightContext(player('N')),
      { ok: false, code: 'CLASSIC_WRONG_PHASE' }],
    [state, bidCommand('Pass'), preflightContext({ role: 'SPECTATOR', seat: null }),
      { ok: false, code: 'CLASSIC_FORBIDDEN' }],
    [state, bidCommand('Pass'), { actor: player('N'), occupiedSeats: ['E', 'S', 'W'] },
      { ok: false, code: 'CLASSIC_FORBIDDEN' }],
    [state, bidCommand('Pass'), preflightContext(player('E')),
      { ok: false, code: 'CLASSIC_NOT_YOUR_TURN' }],
    [state, bidCommand('X'), preflightContext(player('N')),
      { ok: false, code: 'CLASSIC_INVALID_BID' }],
  ];
  for (const [inputState, command, context, expected] of cases) {
    assert.deepEqual(assertUnchanged(preflightClassicCommand, inputState, command, context), expected);
    assert.deepEqual(assertUnchanged(
      applyClassicCommand, inputState, command,
      { ...context, deal: null },
    ), expected);
  }
});

test('classic.bid immutably advances Pass, contract, X, and XX with exact events and replies', () => {
  const opening = biddingState();
  const passResult = assertUnchanged(
    applyBid, opening, 'N', 'Pass', { expectedRevision: 1 },
  );
  assert.deepEqual(passResult, {
    ok: true,
    state: {
      ...clone(opening),
      biddingHistory: [{ seat: 'N', bid: 'Pass', alert: null, explain: null, qa: [] }],
      currentBidder: 'E',
      consecutivePasses: 1,
    },
    events: [{
      name: 'classic.bidding-updated',
      payload: {
        biddingHistory: [{ seat: 'N', bid: 'Pass', alert: null, explain: null, qa: [] }],
        currentBidder: 'E', currentContract: null, consecutivePasses: 1,
      },
    }],
    effects: [],
    reply: { name: 'classic.bid', phase: 'BIDDING' },
  });

  let state = biddingState();
  const steps = [
    ['N', '1H', { alert: true, explain: 'five or more hearts' }, {
      level: 1, suit: 'H', seat: 'N', doubled: false, redoubled: false, doublerSeat: null,
    }, 0],
    ['E', 'Pass', {}, {
      level: 1, suit: 'H', seat: 'N', doubled: false, redoubled: false, doublerSeat: null,
    }, 1],
    ['S', 'Pass', {}, {
      level: 1, suit: 'H', seat: 'N', doubled: false, redoubled: false, doublerSeat: null,
    }, 2],
    ['W', 'X', {}, {
      level: 1, suit: 'H', seat: 'N', doubled: true, redoubled: false, doublerSeat: 'W',
    }, 0],
    ['N', 'Pass', {}, {
      level: 1, suit: 'H', seat: 'N', doubled: true, redoubled: false, doublerSeat: 'W',
    }, 1],
    ['E', 'Pass', {}, {
      level: 1, suit: 'H', seat: 'N', doubled: true, redoubled: false, doublerSeat: 'W',
    }, 2],
    ['S', 'XX', {}, {
      level: 1, suit: 'H', seat: 'N', doubled: true, redoubled: true, doublerSeat: 'S',
    }, 0],
  ];
  for (let index = 0; index < steps.length; index++) {
    const [seat, bid, options, expectedContract, passes] = steps[index];
    const before = JSON.stringify(state);
    const result = applyBid(state, seat, bid, { expectedRevision: index, ...options });
    assert.equal(JSON.stringify(state), before);
    assert.equal(result.ok, true);
    assert.deepEqual(result.reply, { name: 'classic.bid', phase: 'BIDDING' });
    assert.deepEqual(result.effects, []);
    assert.deepEqual(result.state.currentContract, expectedContract);
    assert.equal(result.state.consecutivePasses, passes);
    assert.equal(result.state.currentBidder, FOUR_SEATS[(FOUR_SEATS.indexOf(seat) + 1) % 4]);
    assert.deepEqual(result.events, [{
      name: 'classic.bidding-updated',
      payload: {
        biddingHistory: clone(result.state.biddingHistory),
        currentBidder: result.state.currentBidder,
        currentContract: clone(expectedContract),
        consecutivePasses: passes,
      },
    }]);
    assert.deepEqual(result.state.biddingHistory.at(-1), {
      seat,
      bid,
      alert: options.alert === true ? true : null,
      explain: options.explain ?? null,
      qa: [],
    });
    assert.notStrictEqual(result.events[0].payload.biddingHistory, result.state.biddingHistory);
    state = result.state;
  }
});

test('classic.bid copies only changed branches and keeps event payloads detached', () => {
  const opening = deepFreeze(biddingState());
  const contractResult = applyBid(opening, 'N', '1H');
  assert.notStrictEqual(contractResult.state, opening);
  assert.notStrictEqual(contractResult.state.biddingHistory, opening.biddingHistory);
  assert.notStrictEqual(contractResult.state.currentContract, opening.currentContract);
  for (const key of [
    'boardInfo', 'hands', 'initialHands', 'readyStatus', 'currentTrick', 'completedTricks',
    'boardScores',
  ]) assert.strictEqual(contractResult.state[key], opening[key], key);

  const afterContract = deepFreeze(contractResult.state);
  const passResult = applyBid(afterContract, 'E', 'Pass');
  assert.notStrictEqual(passResult.state, afterContract);
  assert.notStrictEqual(passResult.state.biddingHistory, afterContract.biddingHistory);
  assert.strictEqual(passResult.state.currentContract, afterContract.currentContract);
  for (const key of [
    'boardInfo', 'hands', 'initialHands', 'readyStatus', 'currentTrick', 'completedTricks',
    'boardScores',
  ]) assert.strictEqual(passResult.state[key], afterContract[key], key);
  passResult.events[0].payload.biddingHistory[0].bid = '7NT';
  passResult.events[0].payload.currentContract.level = 7;
  assert.equal(passResult.state.biddingHistory[0].bid, '1H');
  assert.equal(passResult.state.currentContract.level, 1);

  const doubled = applyBid(afterContract, 'E', 'X');
  assert.notStrictEqual(doubled.state.currentContract, afterContract.currentContract);
  assert.strictEqual(doubled.state.hands, afterContract.hands);
  assert.strictEqual(doubled.state.boardScores, afterContract.boardScores);
});

test('three passes after a contract enter PLAYING with exact seats and ordered events', () => {
  let state = biddingState();
  state = applyBid(state, 'N', '1H').state;
  state = applyBid(state, 'E', 'Pass').state;
  state = applyBid(state, 'S', '2H').state;
  state = applyBid(state, 'W', 'Pass').state;
  state = applyBid(state, 'N', 'Pass').state;
  const result = assertUnchanged(applyBid, state, 'E', 'Pass', {});

  const contract = {
    level: 2, suit: 'H', seat: 'S', doubled: false, redoubled: false, doublerSeat: null,
  };
  assert.equal(result.ok, true);
  assert.equal(result.state.phase, 'PLAYING');
  assert.equal(result.state.currentBidder, null);
  assert.deepEqual(result.state.currentContract, contract);
  assert.equal(result.state.consecutivePasses, 3);
  assert.equal(result.state.declarer, 'N');
  assert.equal(result.state.dummy, 'S');
  assert.equal(result.state.leader, 'E');
  assert.equal(result.state.currentPlayer, 'E');
  assert.deepEqual(result.effects, []);
  assert.deepEqual(result.reply, { name: 'classic.bid', phase: 'PLAYING' });
  assert.deepEqual(result.events.map(event => event.name), [
    'classic.bidding-updated',
    'classic.bidding-ended',
  ]);
  assert.deepEqual(result.events[0], {
    name: 'classic.bidding-updated',
    payload: {
      biddingHistory: clone(result.state.biddingHistory),
      currentBidder: null,
      currentContract: clone(contract),
      consecutivePasses: 3,
    },
  });
  assert.deepEqual(result.events[1], {
    name: 'classic.bidding-ended',
    payload: {
      contract: clone(contract),
      declarer: 'N',
      dummy: 'S',
      leader: 'E',
      biddingHistory: clone(result.state.biddingHistory),
    },
  });
  result.events[1].payload.contract.level = 7;
  assert.equal(result.state.currentContract.level, 2);
});

test('four opening passes enter SCORING with one passed-out score and no bidding-ended event', () => {
  let state = biddingState();
  state = applyBid(state, 'N', 'Pass').state;
  state = applyBid(state, 'E', 'Pass').state;
  state = applyBid(state, 'S', 'Pass').state;
  const result = assertUnchanged(applyBid, state, 'W', 'Pass', {});

  const expectedHistory = ['N', 'E', 'S', 'W'].map(seat => ({
    seat, bid: 'Pass', alert: null, explain: null, qa: [],
  }));
  const expectedScore = {
    dealNumber: 1,
    boardNumber: 1,
    score: 0,
    passedOut: true,
    ddTable: null,
    biddingHistory: clone(expectedHistory),
    initialHands: orderedDeal(),
  };
  assert.equal(result.ok, true);
  assert.equal(result.state.phase, 'SCORING');
  assert.equal(result.state.currentBidder, null);
  assert.equal(result.state.consecutivePasses, 4);
  assert.deepEqual(result.state.biddingHistory, expectedHistory);
  assert.deepEqual(result.state.boardScores, [expectedScore]);
  assert.deepEqual(result.events, [
    {
      name: 'classic.bidding-updated',
      payload: {
        biddingHistory: clone(expectedHistory),
        currentBidder: null,
        currentContract: null,
        consecutivePasses: 4,
      },
    },
    {
      name: 'classic.finished',
      payload: { reason: 'passed-out', dealNumber: 1, score: 0 },
    },
  ]);
  assert.deepEqual(result.effects, []);
  assert.deepEqual(result.reply, { name: 'classic.bid', phase: 'SCORING' });
  assert.equal(result.events.some(event => event.name === 'classic.bidding-ended'), false);
  assert.equal(JSON.stringify(result.events).includes('initialHands'), false);

  const replay = applyBid(result.state, 'W', 'Pass');
  assert.deepEqual(replay, { ok: false, code: 'CLASSIC_WRONG_PHASE' });
  assert.equal(result.state.boardScores.length, 1);
});

test('passed-out completion allocates only auction and score branches', () => {
  let state = biddingState();
  state = applyBid(state, 'N', 'Pass').state;
  state = applyBid(state, 'E', 'Pass').state;
  state = applyBid(state, 'S', 'Pass').state;
  const frozen = deepFreeze(state);
  const result = applyBid(frozen, 'W', 'Pass');
  assert.notStrictEqual(result.state, frozen);
  assert.notStrictEqual(result.state.biddingHistory, frozen.biddingHistory);
  assert.notStrictEqual(result.state.boardScores, frozen.boardScores);
  for (const key of [
    'boardInfo', 'hands', 'initialHands', 'readyStatus', 'currentTrick', 'completedTricks',
  ]) assert.strictEqual(result.state[key], frozen[key], key);
});

test('apply rejects trusted deal material on a command that does not need a deal', () => {
  assertInvariant(() => applyClassicCommand(
    biddingState(), bidCommand('Pass'), applyContext(player('N'), deal()),
  ));
});

test('byte-equal frozen full auction transcripts produce byte-equal detached results at every step', () => {
  let left = createClassicLobbyState();
  let right = clone(left);
  const transcript = [
    [startCommand(), applyContext(owner(), deal())],
    [bidCommand('1H', { alert: true, explain: 'five hearts' }), applyContext(player('N'), null)],
    [bidCommand('X'), applyContext(player('E'), null)],
    [bidCommand('XX'), applyContext(player('S'), null)],
    [bidCommand('Pass'), applyContext(player('W'), null)],
    [bidCommand('Pass'), applyContext(owner('N'), null)],
    [bidCommand('Pass'), applyContext(player('E'), null)],
  ];

  for (const [commandTemplate, contextTemplate] of transcript) {
    const leftCommand = deepFreeze(clone(commandTemplate));
    const rightCommand = deepFreeze(clone(commandTemplate));
    const leftContext = deepFreeze(clone(contextTemplate));
    const rightContext = deepFreeze(clone(contextTemplate));
    const frozenLeft = deepFreeze(left);
    const frozenRight = deepFreeze(right);
    const beforeLeft = [frozenLeft, leftCommand, leftContext].map(value => JSON.stringify(value));
    const beforeRight = [frozenRight, rightCommand, rightContext].map(value => JSON.stringify(value));

    const resultLeft = applyClassicCommand(frozenLeft, leftCommand, leftContext);
    const resultRight = applyClassicCommand(frozenRight, rightCommand, rightContext);
    assert.equal(JSON.stringify(resultLeft), JSON.stringify(resultRight));
    assert.deepEqual(
      [frozenLeft, leftCommand, leftContext].map(value => JSON.stringify(value)), beforeLeft,
    );
    assert.deepEqual(
      [frozenRight, rightCommand, rightContext].map(value => JSON.stringify(value)), beforeRight,
    );
    assert.notStrictEqual(resultLeft.state, frozenLeft);
    assert.notStrictEqual(resultLeft.state.biddingHistory, frozenLeft.biddingHistory);
    for (const event of resultLeft.events) {
      if (Object.hasOwn(event.payload, 'biddingHistory')) {
        assert.notStrictEqual(event.payload.biddingHistory, resultLeft.state.biddingHistory);
      }
      if (Object.hasOwn(event.payload, 'currentContract') && event.payload.currentContract) {
        assert.notStrictEqual(event.payload.currentContract, resultLeft.state.currentContract);
      }
    }
    left = resultLeft.state;
    right = resultRight.state;
  }
  assert.equal(left.phase, 'PLAYING');
  assert.equal(right.phase, 'PLAYING');
});
