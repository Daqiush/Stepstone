'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');

const helper = import('../scripts/worker-dds-benchmark-validation.mjs');
const table = () => Array.from({ length: 5 }, () => [0, 1, 2, 13]);
const solve = () => ({ score: 2, cards: [{ suit: 'H', rank: 10 }, { suit: 'S', rank: 2 }] });

test('valid Worker table and solve responses normalize canonically', async () => {
  const { normalizeDdsResult } = await helper;
  assert.deepEqual(normalizeDdsResult('table', table()), table());
  assert.deepEqual(normalizeDdsResult('solve', solve()), { score: 2, cards: ['S2', 'H10'] });
});

for (const [name, mutate] of [
  ['wrong result container', () => null],
  ['out-of-range score', (r) => ({ ...r, score: 14 })],
  ['noninteger score', (r) => ({ ...r, score: 1.5 })],
  ['missing candidate suit', (r) => ({ ...r, cards: [{ rank: 2 }] })],
  ['invalid candidate suit', (r) => ({ ...r, cards: [{ suit: 'X', rank: 2 }] })],
  ['missing candidate rank', (r) => ({ ...r, cards: [{ suit: 'S' }] })],
  ['out-of-range candidate rank', (r) => ({ ...r, cards: [{ suit: 'S', rank: 15 }] })],
  ['noninteger candidate rank', (r) => ({ ...r, cards: [{ suit: 'S', rank: 2.5 }] })],
  ['duplicate candidates', (r) => ({ ...r, cards: [r.cards[0], r.cards[0]] })],
]) test(`malformed solve response: ${name}`, async () => {
  const { normalizeDdsResult } = await helper;
  assert.throws(() => normalizeDdsResult('solve', mutate(solve())), /Malformed solve result/);
});

for (const [name, mutate] of [
  ['wrong result container', () => ({})],
  ['wrong row count', (r) => r.slice(0, 4)],
  ['wrong column count', (r) => { r[0].pop(); return r; }],
  ['out-of-range value', (r) => { r[0][0] = 14; return r; }],
  ['noninteger value', (r) => { r[0][0] = 1.5; return r; }],
]) test(`malformed table response: ${name}`, async () => {
  const { normalizeDdsResult } = await helper;
  assert.throws(() => normalizeDdsResult('table', mutate(table())), /Malformed table result/);
});
