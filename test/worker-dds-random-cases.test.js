'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');

const generator = import('../scripts/worker-dds-random-cases.mjs');
const SEATS = ['N', 'E', 'S', 'W'];
const key = (card) => `${card.suit}${card.rank}`;

function assertLegalReachable(item) {
  const { deal, history } = item;
  assert.equal(history.length, item.depth);
  const holdings = Object.fromEntries(SEATS.map((seat) => [seat, [...deal.hands[seat]]]));
  for (const round of history) for (const play of round.plays) holdings[play.seat].push(play.card);
  for (let i = 0; i < deal.trickPlayed.length; i++) {
    holdings[SEATS[(SEATS.indexOf(deal.trickLeader) + i) % 4]].push(deal.trickPlayed[i]);
  }
  assert.deepEqual(SEATS.map((seat) => holdings[seat].length), [13, 13, 13, 13]);
  assert.equal(new Set(Object.values(holdings).flat().map(key)).size, 52);
  let leader = history[0]?.leader ?? deal.trickLeader;
  for (const round of history) {
    assert.equal(round.leader, leader);
    assert.equal(round.plays.length, 4);
    for (let i = 0; i < 4; i++) {
      const { seat, card } = round.plays[i];
      assert.equal(seat, SEATS[(SEATS.indexOf(leader) + i) % 4]);
      const hand = holdings[seat];
      const led = round.plays[0].card.suit;
      if (i > 0 && card.suit !== led) assert.equal(hand.some((held) => held.suit === led), false);
      const at = hand.findIndex((held) => key(held) === key(card));
      assert.notEqual(at, -1, 'played card belongs to acting hand');
      hand.splice(at, 1);
    }
    leader = round.winner;
  }
  assert.equal(leader, deal.trickLeader);
  for (let i = 0; i < deal.trickPlayed.length; i++) {
    const seat = SEATS[(SEATS.indexOf(leader) + i) % 4];
    const card = deal.trickPlayed[i];
    const hand = holdings[seat];
    const led = deal.trickPlayed[0].suit;
    if (i > 0 && card.suit !== led) assert.equal(hand.some((held) => held.suit === led), false);
    const at = hand.findIndex((held) => key(held) === key(card));
    assert.notEqual(at, -1);
    hand.splice(at, 1);
  }
  assert.deepEqual(holdings, deal.hands);
}

test('seeded random solves cover every completed-trick depth 0 through 12', async () => {
  const { createRandomCaseGenerator } = await generator;
  const next = createRandomCaseGenerator(20260923);
  const depths = Array(13).fill(0);
  for (let i = 0; i < 130; i++) {
    const item = next(i);
    if (item.kind !== 'solve') continue;
    depths[item.depth] += 1;
    assertLegalReachable(item);
  }
  assert.ok(depths.every((count) => count >= 9), JSON.stringify(depths));
});

test('random full-table cases and seeded sequences are deterministic and legal', async () => {
  const { createRandomCaseGenerator } = await generator;
  const first = createRandomCaseGenerator(20260923);
  const second = createRandomCaseGenerator(20260923);
  for (let i = 0; i < 15; i++) {
    const item = first(i);
    assert.deepEqual(item, second(i));
    if (item.kind === 'table') {
      assert.equal(Object.values(item.hands).flat().length, 52);
      assert.equal(new Set(Object.values(item.hands).flat().map(key)).size, 52);
    }
  }
});

test('one in each hundred random positions exercises a full double-dummy table', async () => {
  const { createRandomCaseGenerator } = await generator;
  const next = createRandomCaseGenerator(20260923);
  const kinds = Array.from({ length: 201 }, (_, i) => next(i).kind);
  assert.deepEqual(kinds.flatMap((kind, i) => kind === 'table' ? [i] : []), [0, 100, 200]);
});

test('seed accepts exactly nonzero unsigned 32-bit integers', async () => {
  const { createRandomCaseGenerator } = await generator;
  for (const bad of [0, -1, 1.5, 4294967296, Number.NaN]) {
    assert.throws(() => createRandomCaseGenerator(bad), /seed/i);
  }
  assert.equal(createRandomCaseGenerator(4294967295)(0).kind, 'table');
});
