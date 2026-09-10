'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDdsClient } = require('../dds-wrapper');

const PATHS = {
  calc: '/fixtures/dds_calc',
  solve: '/fixtures/dds_solve',
  overridden: { calc: false, solve: false },
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
      return [...Array.from({ length: 14 }, (_, index) => index), 0, 1, 2, 3, 4, 5].join(' ');
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
    [12, 13, 0, 1],
    [2, 3, 4, 5],
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

test('calc rejects malformed table output', async () => {
  const calcWithOutput = (output) => createDdsClient({
    paths: PATHS,
    existsSync: () => true,
    runProcess: async () => output,
  }).calcDDTable(ONE_CARD_HANDS);
  const validValues = Array(20).fill('0');

  await assert.rejects(
    calcWithOutput('1 2 3'),
    { message: 'Unexpected DDS output length: 3' },
  );
  await assert.rejects(calcWithOutput([...validValues.slice(0, 19), 'junk'].join(' ')));
  await assert.rejects(calcWithOutput([...validValues.slice(0, 19), '1.5'].join(' ')));
  await assert.rejects(calcWithOutput([...validValues.slice(0, 19), '-1'].join(' ')));
  await assert.rejects(calcWithOutput([...validValues.slice(0, 19), '14'].join(' ')));
  await assert.rejects(calcWithOutput([...validValues, '0'].join(' ')));
});

test('solve rejects empty and malformed output', async () => {
  const solveWithOutput = (output) => createDdsClient({
    paths: PATHS,
    existsSync: () => true,
    runProcess: async () => output,
  }).solveBoard({
    trump: 'NT',
    trickLeader: 'W',
    trickPlayed: [],
    hands: ONE_CARD_HANDS,
  });

  await assert.rejects(solveWithOutput(''), { message: 'dds_solve: empty output' });
  await assert.rejects(solveWithOutput('3 2 0 14'));
  await assert.rejects(solveWithOutput('NaN 0'));
  await assert.rejects(solveWithOutput('3.5 0'));
  await assert.rejects(solveWithOutput('-1 0'));
  await assert.rejects(solveWithOutput('14 0'));
  await assert.rejects(solveWithOutput('3 NaN'));
  await assert.rejects(solveWithOutput('3 Infinity'));
  await assert.rejects(solveWithOutput('3 1.5'));
  await assert.rejects(solveWithOutput('3 -1'));
  await assert.rejects(solveWithOutput('3 14'));
  await assert.rejects(solveWithOutput('3 1 4 14'));
  await assert.rejects(solveWithOutput('3 1 0 1'));
  await assert.rejects(solveWithOutput('3 1 0 15'));
  await assert.rejects(solveWithOutput('3 1 0 10.5'));
  await assert.rejects(
    solveWithOutput('3 0 99'),
  );
});
