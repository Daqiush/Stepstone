'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDdsClient } = require('../dds-wrapper');

const PATHS = {
  calc: '/fixtures/dds_calc',
  solve: '/fixtures/dds_solve',
  overridden: false,
  platform: 'darwin',
  arch: 'arm64',
};

const ONE_CARD_HANDS = {
  N: [{ suit: 'S', rank: 'A' }],
  E: [],
  S: [],
  W: [],
};

test('calc sends 16 hand masks to the resolved calculator and parses a 5x4 table', async () => {
  let invocation;
  const client = createDdsClient({
    paths: PATHS,
    existsSync: () => true,
    runProcess: async (programPath, input) => {
      invocation = { programPath, input };
      return Array.from({ length: 20 }, (_, index) => index).join(' ');
    },
  });

  const table = await client.calcDDTable(ONE_CARD_HANDS);

  assert.equal(invocation.programPath, PATHS.calc);
  const masks = invocation.input.split(' ').map(Number);
  assert.equal(masks.length, 16);
  assert.equal(masks[0], 1 << 14);
  assert.deepEqual(table, [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [8, 9, 10, 11],
    [12, 13, 14, 15],
    [16, 17, 18, 19],
  ]);
});

test('solve encodes NT leader and current trick and parses score and cards', async () => {
  let invocation;
  const client = createDdsClient({
    paths: PATHS,
    existsSync: () => true,
    runProcess: async (programPath, input) => {
      invocation = { programPath, input };
      return '3 2 0 14 2 13';
    },
  });

  const result = await client.solveBoard({
    trump: 'NT',
    trickLeader: 'W',
    trickPlayed: [{ suit: 'H', rank: 10 }],
    hands: ONE_CARD_HANDS,
  });

  assert.equal(invocation.programPath, PATHS.solve);
  assert.ok(invocation.input.startsWith('4 3 1 1 10 '));
  assert.deepEqual(result, {
    score: 3,
    cards: [{ suit: 'S', rank: 14 }, { suit: 'D', rank: 13 }],
  });
});

test('missing calculator reports the resolved Darwin arm64 setup details', async () => {
  const client = createDdsClient({
    paths: PATHS,
    existsSync: () => false,
    runProcess: async () => assert.fail('process should not run'),
  });

  await assert.rejects(client.calcDDTable(ONE_CARD_HANDS), (error) => {
    assert.match(error.message, /darwin/);
    assert.match(error.message, /arm64/);
    assert.match(error.message, /\/fixtures\/dds_calc/);
    assert.match(error.message, /npm install/);
    return true;
  });
});

test('calc rejects output that does not contain exactly 20 numbers', async () => {
  const client = createDdsClient({
    paths: PATHS,
    existsSync: () => true,
    runProcess: async () => '1 2 3',
  });

  await assert.rejects(
    client.calcDDTable(ONE_CARD_HANDS),
    { message: 'Unexpected DDS output length: 3' },
  );
});

test('solve rejects empty output', async () => {
  const client = createDdsClient({
    paths: PATHS,
    existsSync: () => true,
    runProcess: async () => '',
  });

  await assert.rejects(
    client.solveBoard({
      trump: 'NT',
      trickLeader: 'W',
      trickPlayed: [],
      hands: ONE_CARD_HANDS,
    }),
    { message: 'dds_solve: empty output' },
  );
});
