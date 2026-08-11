'use strict';

const assert = require('assert');
const rules = require('../complex-bridge');

const deck = rules.createComplexDeck();
assert.strictEqual(deck.length, 52, 'deck contains 52 cards');
assert.strictEqual(new Set(deck.map(rules.cardId)).size, 52, 'deck cards are unique');

const imagLead = { kind: 'imag', re: 2, im: 3 };
assert(rules.matchesLedSuit({ kind: 'real', re: 5, im: 3 }, imagLead), 'real card follows an imaginary lead by shared imaginary coordinate');
assert(!rules.matchesLedSuit({ kind: 'real', re: 3, im: 2 }, imagLead), 'unrelated card does not follow');

const realTrump = { axis: 'real', value: 2 };
assert.strictEqual(rules.trickWinner([
  { seat: 'N', card: { kind: 'real', re: 2, im: 5 } },
  { seat: 'E', card: { kind: 'ace', order: 'imagFirst' } },
  { seat: 'S', card: { kind: 'ace', order: 'realFirst' } },
], realTrump), 'S', 'A+Ai is the highest real trump');

const imagTrump = { axis: 'imag', value: 3 };
assert.strictEqual(rules.trickWinner([
  { seat: 'N', card: { kind: 'imag', re: 5, im: 3 } },
  { seat: 'E', card: { kind: 'ace', order: 'realFirst' } },
  { seat: 'S', card: { kind: 'ace', order: 'imagFirst' } },
], imagTrump), 'S', 'Ai+A is the highest imaginary trump');

assert.deepStrictEqual(
  rules.resolveComplexBids({ tricks: 8, trump: { axis: 'real', value: 2 } }, { tricks: 8, trump: { axis: 'imag', value: 3 } }, () => 0.1),
  { side: 'EW', tricks: 8, trump: { axis: 'imag', value: 3 }, decidedBy: 'suit' },
  'higher suit number wins a tied trick bid'
);

assert.strictEqual(rules.openingLeader('NS'), 'W', 'west opens against a north-south contract');
assert.strictEqual(rules.openingLeader('EW'), 'S', 'south opens against an east-west contract');
assert.deepStrictEqual(rules.controlledSeats('N'), ['N', 'S'], 'north controls the complete north-south side');
assert.deepStrictEqual(rules.controlledSeats('E'), ['E', 'W'], 'east controls the complete east-west side');
assert.strictEqual(rules.isValidBidTricks(7), true, 'seven tricks is the minimum complex bid');
assert.strictEqual(rules.isValidBidTricks(6), false, 'six tricks is not a legal complex bid');
assert.deepStrictEqual(rules.trumpAcePlacement({ axis: 'real', value: 2 }), { zone: 'top', re: 2 }, 'real trump aces sit above the 5i row');
assert.deepStrictEqual(rules.trumpAcePlacement({ axis: 'imag', value: 4 }), { zone: 'right', im: 4 }, 'imaginary trump aces sit beyond the 5 column');
const trumpImag3 = { axis: 'imag', value: 3 };
const realFourImag3 = { kind: 'real', re: 4, im: 3 };
assert.deepStrictEqual(rules.ledSuit(realFourImag3, trumpImag3), trumpImag3, 'a trump card leads the trump suit instead of its original suit');
assert.strictEqual(rules.matchesLedSuit(realFourImag3, { kind: 'real', re: 4, im: 1 }, trumpImag3), false, 'a trump card cannot follow its original non-trump suit');
assert.strictEqual(rules.isTrumpCard({ kind: 'ace', order: 'realFirst' }, trumpImag3), true, 'both aces are trump-only after a trump is chosen');

console.log('complex-bridge tests passed');
