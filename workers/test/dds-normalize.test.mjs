import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DdsInputError,
  currentSeat,
  normalizeCards,
  normalizeDeal,
  normalizeHands,
  normalizeSolveResult,
  normalizeTable,
} from '../src/dds-normalize.mjs';

const allHands = {
  N: [{ suit: 'S', rank: 'A' }],
  E: [{ suit: 'H', rank: 13 }],
  S: [{ suit: 'D', rank: 2 }],
  W: [{ suit: 'C', rank: 'T' }],
};

test('normalizes standard card ranks to Stepstone numeric cards', () => {
  assert.deepEqual(normalizeCards([{ suit: 'S', rank: 'A' }]), [{ suit: 'S', rank: 14 }]);
  for (const rank of [2, 3, 4, 5, 6, 7, 8, 9, 10, '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']) {
    assert.equal(normalizeCards([{ suit: 'H', rank }])[0].rank, typeof rank === 'number' ? rank : ({ T: 10, J: 11, Q: 12, K: 13, A: 14 }[rank] ?? Number(rank)));
  }
});

test('normalizes hands in named seat and suit order', () => {
  const hands = normalizeHands({
    W: [{ suit: 'C', rank: 2 }], S: [{ suit: 'D', rank: 2 }],
    E: [{ suit: 'H', rank: 2 }], N: [{ suit: 'S', rank: 2 }],
  });
  assert.deepEqual(Object.keys(hands), ['N', 'E', 'S', 'W']);
  assert.deepEqual(hands.N, [{ suit: 'S', rank: 2 }]);
});

test('rejects malformed deals with a coded input error', () => {
  assert.throws(
    () => normalizeDeal({ hands: allHands, trump: 'X', trickLeader: 'S', trickPlayed: [] }),
    (error) => error instanceof DdsInputError && error.code === 'INVALID_DEAL',
  );
});

test('computes the next seat from leader and partial trick length', () => {
  assert.equal(currentSeat('S', 3), 'E');
});

test('validates every legal trump and rejects duplicate cards across hands and trick', () => {
  for (const trump of ['S', 'H', 'D', 'C', 'NT']) {
    assert.equal(normalizeDeal({ hands: allHands, trump, trickLeader: 'S', trickPlayed: [] }).trump, trump);
  }
  assert.throws(
    () => normalizeDeal({
      hands: { ...allHands, E: [{ suit: 'S', rank: 14 }] }, trump: 'NT', trickLeader: 'S',
      trickPlayed: [{ suit: 'C', rank: 10 }],
    }),
    (error) => error instanceof DdsInputError && error.code === 'INVALID_DEAL',
  );
});

test('normalizes table values into the existing five-strain four-seat array', () => {
  assert.deepEqual(normalizeTable({ N: { C: 1, D: 2, H: 3, S: 4, NT: 5 }, E: { C: 5, D: 6, H: 7, S: 8, NT: 9 }, S: { C: 9, D: 10, H: 11, S: 12, NT: 13 }, W: { C: 12, D: 13, H: 0, S: 1, NT: 2 } }), [
    [4, 8, 12, 1], [3, 7, 11, 0], [2, 6, 10, 13], [1, 5, 9, 12], [5, 9, 13, 2],
  ]);
});

test('normalizes solve candidates in suit then ascending rank order without changing score', () => {
  assert.deepEqual(normalizeSolveResult({ score: 7, cards: [{ suit: 'C', rank: 'A' }, { suit: 'S', rank: 10 }, { suit: 'S', rank: 2 }, { suit: 'H', rank: 'K' }] }), {
    score: 7,
    cards: [{ suit: 'S', rank: 2 }, { suit: 'S', rank: 10 }, { suit: 'H', rank: 13 }, { suit: 'C', rank: 14 }],
  });
});

test('rejects incomplete tables, out-of-range table values and scores, and duplicate candidates', () => {
  const table = { N: { S: 4, H: 3, D: 2, C: 1, NT: 5 }, E: { S: 8, H: 7, D: 6, C: 5, NT: 9 }, S: { S: 12, H: 11, D: 10, C: 9, NT: 13 }, W: { S: 1, H: 0, D: 13, C: 12, NT: 2 } };
  assert.throws(() => normalizeTable({ ...table, W: { ...table.W, NT: undefined } }), DdsInputError);
  assert.throws(() => normalizeTable({ ...table, N: { ...table.N, S: 14 } }), DdsInputError);
  assert.throws(() => normalizeSolveResult({ score: 14, cards: [] }), DdsInputError);
  assert.throws(() => normalizeSolveResult({ score: 4, cards: [{ suit: 'S', rank: 2 }, { suit: 'S', rank: 2 }] }), DdsInputError);
});
