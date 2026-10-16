'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const classicConstants = require('../classic/constants.cjs');
const { SEATS, SUITS, RANKS, RANK_VALUE, PHASES } = classicConstants;
const { card, orderedDeal, cloneDeal, auction } = require('./helpers/classic-fixtures.js');
const {
  nextSeat,
  partnerOf,
  sideOf,
  boardInfoFor,
  parseBid,
  bidValue,
  validateBid,
  declarerFor,
  effectivePlaySeat,
  validatePlay,
  trickWinner,
} = require('../classic/rules.cjs');

function contract(overrides = {}) {
  return {
    level: 1,
    suit: 'H',
    seat: 'N',
    doubled: false,
    redoubled: false,
    doublerSeat: null,
    ...overrides,
  };
}

function playState(overrides = {}) {
  return {
    currentPlayer: 'N',
    declarer: 'N',
    dummy: 'S',
    hands: cloneDeal(orderedDeal()),
    currentTrick: [],
    ...overrides,
  };
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

test('classic constants and their exported collections are frozen', () => {
  assert.equal(Object.isFrozen(classicConstants), true);
  for (const value of Object.values(classicConstants)) assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(RANK_VALUE), true);
  assert.equal(Object.isFrozen(PHASES), true);
});

test('orderedDeal returns the canonical 52-card deal', () => {
  const deal = orderedDeal();
  const expected = {
    N: RANKS.map(rank => card('S', rank)),
    E: RANKS.map(rank => card('H', rank)),
    S: RANKS.map(rank => card('D', rank)),
    W: RANKS.map(rank => card('C', rank)),
  };

  assert.deepEqual(deal, expected);
  assert.deepEqual(Object.keys(deal), SEATS);
  for (const seat of SEATS) assert.equal(deal[seat].length, 13);

  const keys = SEATS.flatMap(seat => deal[seat].map(({ suit, rank }) => `${suit}${rank}`));
  assert.equal(new Set(keys).size, 52);
  for (const dealtCard of deal.N.concat(deal.E, deal.S, deal.W)) {
    assert.deepEqual(Object.keys(dealtCard).sort(), ['rank', 'suit']);
    assert.equal(Object.hasOwn(dealtCard, 'suit'), true);
    assert.equal(Object.hasOwn(dealtCard, 'rank'), true);
    assert.ok(SUITS.includes(dealtCard.suit) && RANKS.includes(dealtCard.rank));
  }
});

test('seat helpers follow clockwise order, partnerships, and sides', () => {
  const expected = {
    N: { next: 'E', partner: 'S', side: 'NS' },
    E: { next: 'S', partner: 'W', side: 'EW' },
    S: { next: 'W', partner: 'N', side: 'NS' },
    W: { next: 'N', partner: 'E', side: 'EW' },
  };

  for (const seat of SEATS) {
    assert.equal(nextSeat(seat), expected[seat].next);
    assert.equal(partnerOf(seat), expected[seat].partner);
    assert.equal(sideOf(seat), expected[seat].side);
  }
});

test('seat helpers reject every non-canonical seat', () => {
  for (const invalidSeat of [undefined, null, '', 'n', 'X', 1]) {
    assert.throws(() => nextSeat(invalidSeat), TypeError);
    assert.throws(() => partnerOf(invalidSeat), TypeError);
    assert.throws(() => sideOf(invalidSeat), TypeError);
  }
});

test('boardInfoFor reproduces the standard 16-board dealer and vulnerability cycle', () => {
  const expected = [
    { number: 1, dealNumber: 1, vul: 'NONE', dealer: 'N' },
    { number: 2, dealNumber: 2, vul: 'NS', dealer: 'E' },
    { number: 3, dealNumber: 3, vul: 'EW', dealer: 'S' },
    { number: 4, dealNumber: 4, vul: 'BOTH', dealer: 'W' },
    { number: 5, dealNumber: 5, vul: 'NS', dealer: 'N' },
    { number: 6, dealNumber: 6, vul: 'EW', dealer: 'E' },
    { number: 7, dealNumber: 7, vul: 'BOTH', dealer: 'S' },
    { number: 8, dealNumber: 8, vul: 'NONE', dealer: 'W' },
    { number: 9, dealNumber: 9, vul: 'EW', dealer: 'N' },
    { number: 10, dealNumber: 10, vul: 'BOTH', dealer: 'E' },
    { number: 11, dealNumber: 11, vul: 'NONE', dealer: 'S' },
    { number: 12, dealNumber: 12, vul: 'NS', dealer: 'W' },
    { number: 13, dealNumber: 13, vul: 'BOTH', dealer: 'N' },
    { number: 14, dealNumber: 14, vul: 'NONE', dealer: 'E' },
    { number: 15, dealNumber: 15, vul: 'NS', dealer: 'S' },
    { number: 16, dealNumber: 16, vul: 'EW', dealer: 'W' },
  ];

  assert.deepEqual(expected.map(({ dealNumber }) => boardInfoFor(dealNumber)), expected);
  assert.deepEqual(boardInfoFor(17), { number: 1, dealNumber: 17, vul: 'NONE', dealer: 'N' });
});

test('boardInfoFor rejects values outside the positive safe-integer domain', () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    assert.throws(() => boardInfoFor(value), /positive safe integer/);
  }
});

test('boardInfoFor and parseBid return independent values', () => {
  const firstBoard = boardInfoFor(1);
  const firstParsedBid = parseBid('1H');
  firstBoard.vul = 'BOTH';
  firstParsedBid.level = 7;

  const secondBoard = boardInfoFor(1);
  const secondParsedBid = parseBid('1H');
  assert.notStrictEqual(firstBoard, secondBoard);
  assert.notStrictEqual(firstParsedBid, secondParsedBid);
  assert.deepEqual(secondBoard, { number: 1, dealNumber: 1, vul: 'NONE', dealer: 'N' });
  assert.deepEqual(secondParsedBid, { kind: 'contract', level: 1, suit: 'H' });
});

test('parseBid accepts only canonical calls and bidValue follows bridge denomination order', () => {
  assert.deepEqual(parseBid('Pass'), { kind: 'pass' });
  assert.deepEqual(parseBid('X'), { kind: 'double' });
  assert.deepEqual(parseBid('XX'), { kind: 'redouble' });
  assert.deepEqual(parseBid('7NT'), { kind: 'contract', level: 7, suit: 'NT' });

  for (const bid of ['Double', 'Redouble', '1N', '0C', '8S', '1c', '', null]) {
    assert.equal(parseBid(bid), null);
  }

  const orderedBids = [];
  for (let level = 1; level <= 7; level++) {
    for (const suit of ['C', 'D', 'H', 'S', 'NT']) orderedBids.push(`${level}${suit}`);
  }
  assert.deepEqual(orderedBids.map(bidValue), Array.from({ length: 35 }, (_, index) => index + 5));
  assert.equal(bidValue('Pass'), -1);
  assert.equal(bidValue('X'), -1);
  assert.equal(bidValue('XX'), -1);
  assert.throws(() => bidValue('1N'), /canonical bid/);
});

test('validateBid accepts Pass and only contract bids higher than the current contract', () => {
  const state = { currentContract: contract({ level: 2, suit: 'D', seat: 'E' }) };

  assert.deepEqual(validateBid(state, 'S', 'Pass'), { ok: true });
  assert.deepEqual(validateBid(state, 'S', '2H'), { ok: true });
  for (const bid of ['2D', '2C', '1NT', 'Double', '3N']) {
    assert.equal(validateBid(state, 'S', bid).code, 'CLASSIC_INVALID_BID');
  }
});

test('validateBid permits X only by opponents and XX only by the declaring side', () => {
  const undoubled = { currentContract: contract() };
  assert.deepEqual(validateBid(undoubled, 'E', 'X'), { ok: true });
  assert.equal(validateBid(undoubled, 'S', 'X').code, 'CLASSIC_INVALID_BID');

  const doubled = {
    currentContract: contract({ doubled: true, doublerSeat: 'E' }),
  };
  assert.deepEqual(validateBid(doubled, 'S', 'XX'), { ok: true });
  assert.equal(validateBid(doubled, 'W', 'XX').code, 'CLASSIC_INVALID_BID');
  assert.equal(validateBid(doubled, 'W', 'X').code, 'CLASSIC_INVALID_BID');

  const redoubled = {
    currentContract: contract({ doubled: true, redoubled: true, doublerSeat: 'S' }),
  };
  assert.equal(validateBid(redoubled, 'S', 'X').code, 'CLASSIC_INVALID_BID');
  assert.equal(validateBid(redoubled, 'S', 'XX').code, 'CLASSIC_INVALID_BID');
});

test('server-shaped redoubled contracts remain valid and closed to further X or XX', () => {
  const serverRedoubledContract = {
    level: 1,
    suit: 'H',
    seat: 'N',
    doubled: true,
    redoubled: true,
    doublerSeat: 'S',
  };
  const state = { currentContract: serverRedoubledContract };

  for (const seat of SEATS) {
    assert.equal(validateBid(state, seat, 'X').code, 'CLASSIC_INVALID_BID');
    assert.equal(validateBid(state, seat, 'XX').code, 'CLASSIC_INVALID_BID');
  }
  assert.equal(
    declarerFor(auction(['1H', 'X', 'XX', 'Pass', 'Pass', 'Pass']), serverRedoubledContract),
    'N',
  );
});

test('intervening passes do not cancel X or XX rights', () => {
  const xAuction = auction(['1H', 'Pass', 'Pass', 'X']);
  const xCall = xAuction.at(-1);
  assert.deepEqual(validateBid({ currentContract: contract() }, xCall.seat, xCall.bid), { ok: true });

  const xxAuction = auction(['1H', 'X', 'Pass', 'Pass', 'XX']);
  const xxCall = xxAuction.at(-1);
  assert.deepEqual(validateBid({
    currentContract: contract({ doubled: true, doublerSeat: 'E' }),
  }, xxCall.seat, xxCall.bid), { ok: true });
});

test('validateBid rejects X and XX without the required contract state', () => {
  assert.equal(validateBid({ currentContract: null }, 'E', 'X').code, 'CLASSIC_INVALID_BID');
  assert.equal(validateBid({ currentContract: null }, 'N', 'XX').code, 'CLASSIC_INVALID_BID');
  assert.equal(validateBid({ currentContract: contract() }, 'N', 'XX').code, 'CLASSIC_INVALID_BID');
});

test('validateBid throws for malformed trusted contract state', () => {
  assert.throws(() => validateBid(null, 'N', 'Pass'), /state/);
  assert.throws(() => validateBid({ currentContract: { level: 1, suit: 'H' } }, 'N', 'Pass'), /currentContract/);
  assert.throws(() => validateBid({
    currentContract: contract({ doubled: false, redoubled: true }),
  }, 'N', 'Pass'), /currentContract/);
  assert.throws(() => validateBid({
    currentContract: contract({ doubled: true, doublerSeat: 'S' }),
  }, 'N', 'Pass'), /currentContract/);
  assert.throws(() => validateBid({
    currentContract: contract({ doubled: true, redoubled: true, doublerSeat: 'E' }),
  }, 'N', 'Pass'), /currentContract/);
});

test('declarerFor chooses the first final-contract-side bidder of the final denomination', () => {
  const history = auction(['1H', 'Pass', '3H', 'Pass', '4H', 'Pass', 'Pass', 'Pass']);
  const finalContract = contract({ level: 4, suit: 'H', seat: 'N' });

  assert.equal(declarerFor(history, finalContract), 'N');
});

test('declarerFor keeps the opening bidder as declarer after a partner raise', () => {
  const history = auction(['1S', 'Pass', '4S', 'Pass', 'Pass', 'Pass']);
  const finalContract = contract({ level: 4, suit: 'S', seat: 'S' });

  assert.equal(declarerFor(history, finalContract), 'N');
});

test('declarerFor ignores opponent calls and doubles when finding declarer', () => {
  const history = auction(['1H', '1S', '2H', '2S', 'Pass', 'Pass', 'X', 'Pass', 'Pass', 'Pass']);
  const finalContract = contract({
    level: 2,
    suit: 'S',
    seat: 'W',
    doubled: true,
    doublerSeat: 'S',
  });

  assert.equal(declarerFor(history, finalContract), 'E');
});

test('declarerFor throws when trusted auction state cannot produce the final contract', () => {
  assert.throws(() => declarerFor([{ seat: 'N', bid: 'Pass' }], contract()), /history/);
  assert.throws(() => declarerFor([{ seat: 'N', bid: '1N' }], contract()), /history/);
  assert.throws(() => declarerFor([
    { seat: 'N', bid: '1H' },
    { seat: 'E', bid: '1N' },
  ], contract()), /history/);
});

test('effectivePlaySeat lets declarer act for dummy only on dummy turn', () => {
  assert.equal(effectivePlaySeat(playState({ currentPlayer: 'S' }), 'N'), 'S');
  assert.equal(effectivePlaySeat(playState({ currentPlayer: 'N' }), 'N'), 'N');
  assert.equal(effectivePlaySeat(playState({ currentPlayer: 'E' }), 'N'), 'N');

  assert.equal(
    validatePlay(playState({ currentPlayer: 'E' }), 'N', card('S', '2')).code,
    'CLASSIC_NOT_YOUR_TURN',
  );
});

test('validatePlay requires the effective player to hold the canonical card', () => {
  const state = playState({
    hands: { N: [card('H', '2')], E: [], S: [], W: [] },
  });

  assert.deepEqual(validatePlay(state, 'N', card('H', '2')), { ok: true, effectiveSeat: 'N' });
  assert.equal(validatePlay(state, 'N', card('S', '2')).code, 'CLASSIC_CARD_NOT_HELD');
});

test('validatePlay enforces follow suit while allowing a discard when void', () => {
  const ledTrick = [{ seat: 'W', card: card('S', '9') }];
  const mustFollow = playState({
    hands: { N: [card('S', '2'), card('H', '2')], E: [], S: [], W: [] },
    currentTrick: ledTrick,
  });
  assert.equal(validatePlay(mustFollow, 'N', card('H', '2')).code, 'CLASSIC_MUST_FOLLOW_SUIT');
  assert.deepEqual(validatePlay(mustFollow, 'N', card('S', '2')), { ok: true, effectiveSeat: 'N' });

  const voidInSpades = playState({
    hands: { N: [card('H', '2')], E: [], S: [], W: [] },
    currentTrick: ledTrick,
  });
  assert.deepEqual(validatePlay(voidInSpades, 'N', card('H', '2')), { ok: true, effectiveSeat: 'N' });
});

test('validatePlay checks dummy hand when declarer acts on dummy turn', () => {
  const state = playState({
    currentPlayer: 'S',
    hands: { N: [card('S', 'A')], E: [], S: [card('C', '2')], W: [] },
  });

  assert.deepEqual(validatePlay(state, 'N', card('C', '2')), { ok: true, effectiveSeat: 'S' });
  assert.equal(validatePlay(state, 'N', card('S', 'A')).code, 'CLASSIC_CARD_NOT_HELD');
});

test('validatePlay rejects dummy acting for itself on dummy turn', () => {
  const state = playState({
    currentPlayer: 'S',
    hands: { N: [], E: [], S: [card('C', '2')], W: [] },
  });

  assert.equal(validatePlay(state, 'S', card('C', '2')).code, 'CLASSIC_NOT_YOUR_TURN');
  assert.deepEqual(validatePlay(state, 'N', card('C', '2')), { ok: true, effectiveSeat: 'S' });
});

test('validatePlay rejects cards that inherit suit and rank instead of owning them', () => {
  const inheritedCard = Object.assign(
    Object.create({ suit: 'H', rank: '2' }),
    { unrelated: true, extra: true },
  );
  const state = playState({
    hands: { N: [{ suit: 'H', rank: '2' }], E: [], S: [], W: [] },
  });

  assert.equal(validatePlay(state, 'N', inheritedCard).code, 'CLASSIC_CARD_NOT_HELD');
});

test('validatePlay throws when the effective hand contains a non-canonical trusted card', () => {
  const malformedCards = [
    { suit: 'H', rank: '3', extra: true },
    Object.assign(Object.create({ suit: 'H', rank: '3' }), { unrelated: true, extra: true }),
    { suit: 'X', rank: '3' },
    { suit: 'H', rank: 3 },
  ];

  for (const malformedCard of malformedCards) {
    const state = playState({
      hands: { N: [{ suit: 'H', rank: '2' }, malformedCard], E: [], S: [], W: [] },
    });
    assert.throws(() => validatePlay(state, 'N', { suit: 'H', rank: '2' }), /hand/);
  }
});

test('validatePlay throws when any trusted current-trick play is not exact and canonical', () => {
  const validLead = { seat: 'W', card: { suit: 'H', rank: 'A' } };
  const malformedPlays = [
    { seat: 'E', card: { suit: 'H', rank: 'K' }, extra: true },
    { seat: 'X', card: { suit: 'H', rank: 'K' } },
    { seat: 'E', card: { suit: 'H', rank: 'K', extra: true } },
    Object.assign(
      Object.create({ seat: 'E', card: { suit: 'H', rank: 'K' } }),
      { unrelated: true, extra: true },
    ),
  ];

  for (const malformedPlay of malformedPlays) {
    const state = playState({
      hands: { N: [{ suit: 'H', rank: '2' }], E: [], S: [], W: [] },
      currentTrick: [validLead, malformedPlay],
    });
    assert.throws(() => validatePlay(state, 'N', { suit: 'H', rank: '2' }), /currentTrick/);
  }
});

test('trickWinner chooses the highest card in the led suit without trump', () => {
  const trick = [
    { seat: 'N', card: card('H', 'J') },
    { seat: 'E', card: card('H', 'T') },
    { seat: 'S', card: card('C', 'A') },
    { seat: 'W', card: card('H', 'A') },
  ];

  assert.equal(trickWinner(trick, 'NT'), 'W');
});

test('trickWinner prefers trump and then the highest trump rank', () => {
  const trick = [
    { seat: 'E', card: card('S', 'A') },
    { seat: 'S', card: card('H', '2') },
    { seat: 'W', card: card('H', 'K') },
    { seat: 'N', card: card('S', 'K') },
  ];

  assert.equal(trickWinner(trick, 'H'), 'W');
});

test('trickWinner rejects impossible tied duplicate cards', () => {
  const trick = [
    { seat: 'N', card: card('D', 'A') },
    { seat: 'E', card: card('D', 'A') },
    { seat: 'S', card: card('D', 'K') },
    { seat: 'W', card: card('C', '2') },
  ];

  assert.throws(() => trickWinner(trick, 'NT'), /duplicate|tie/);
});

test('trickWinner rejects cards that inherit suit and rank instead of owning them', () => {
  const inheritedCard = Object.assign(
    Object.create({ suit: 'H', rank: '2' }),
    { unrelated: true, extra: true },
  );
  const trick = [
    { seat: 'N', card: inheritedCard },
    { seat: 'E', card: { suit: 'H', rank: '3' } },
    { seat: 'S', card: { suit: 'C', rank: 'A' } },
    { seat: 'W', card: { suit: 'H', rank: '4' } },
  ];

  assert.throws(() => trickWinner(trick, 'NT'), /invalid play/);
});

test('rule helpers preserve representative deeply frozen state and history inputs', () => {
  const bidState = deepFreeze({
    currentContract: contract({ level: 2, suit: 'S', seat: 'N' }),
  });
  const history = deepFreeze(auction(['1H', 'Pass', '2H', 'Pass', 'Pass', 'Pass']));
  const finalContract = deepFreeze(contract({ level: 2, suit: 'H', seat: 'S' }));
  const state = deepFreeze(playState({
    hands: {
      N: [{ suit: 'H', rank: '2' }],
      E: [],
      S: [],
      W: [],
    },
    currentTrick: [{ seat: 'W', card: { suit: 'H', rank: 'A' } }],
  }));
  const trick = deepFreeze([
    { seat: 'N', card: { suit: 'D', rank: 'A' } },
    { seat: 'E', card: { suit: 'D', rank: 'K' } },
    { seat: 'S', card: { suit: 'C', rank: 'A' } },
    { seat: 'W', card: { suit: 'D', rank: 'Q' } },
  ]);
  const inputs = [bidState, history, finalContract, state, trick];
  const before = inputs.map(value => JSON.stringify(value));

  assert.deepEqual(validateBid(bidState, 'E', '3C'), { ok: true });
  assert.equal(declarerFor(history, finalContract), 'N');
  assert.deepEqual(validatePlay(state, 'N', { suit: 'H', rank: '2' }), {
    ok: true,
    effectiveSeat: 'N',
  });
  assert.equal(trickWinner(trick, 'NT'), 'N');

  assert.deepEqual(inputs.map(value => JSON.stringify(value)), before);
});
