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

console.log('complex-bridge tests passed');
