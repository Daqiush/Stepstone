import assert from 'node:assert/strict';
import test from 'node:test';

import { createWasmDdsClient, DdsInputError, DdsRuntimeError } from '../src/dds-wasm-adapter.mjs';

const hands = {
  N: [{ suit: 'S', rank: 'A' }], E: [{ suit: 'H', rank: 'K' }],
  S: [{ suit: 'D', rank: 2 }], W: [{ suit: 'C', rank: 'T' }],
};

test('serializes a normalized table as canonical PBN hands and caches the lazy loader', async () => {
  const calls = [];
  let loads = 0;
  const client = createWasmDdsClient({ loadModule: async () => {
    loads += 1;
    return {
    calcDDTablePbn(pbnHands) { calls.push(pbnHands); return { N: { S: 4, H: 3, D: 2, C: 1, NT: 5 }, E: { S: 8, H: 7, D: 6, C: 5, NT: 9 }, S: { S: 12, H: 11, D: 10, C: 9, NT: 13 }, W: { S: 1, H: 0, D: 13, C: 12, NT: 2 } }; },
    };
  } });
  assert.deepEqual(await client.calcDDTable(hands), [[4, 8, 12, 1], [3, 7, 11, 0], [2, 6, 10, 13], [1, 5, 9, 12], [5, 9, 13, 2]]);
  await client.calcDDTable(hands);
  assert.equal(loads, 1);
  assert.deepEqual(calls, ['N:A... E:.K.. S:..2. W:...T', 'N:A... E:.K.. S:..2. W:...T']);
});

test('serializes a partial solve as PBN and returns canonical candidates', async () => {
  let payload;
  const solveHands = { ...hands, W: [{ suit: 'S', rank: 2 }, { suit: 'D', rank: 14 }] };
  const client = createWasmDdsClient({ loadModule: async () => ({
    solveBoardPbn(value) { payload = value; return { score: 4, cards: [{ suit: 'D', rank: 'A' }, { suit: 'S', rank: 2 }] }; },
  }) });
  const result = await client.solveBoard({ hands: solveHands, trump: 'NT', trickLeader: 'W', trickPlayed: [] });
  assert.equal(payload, 'trump=NT;leader=W;turn=W;trick=;hands=N:A... E:.K.. S:..2. W:2..A.');
  assert.deepEqual(result, { score: 4, cards: [{ suit: 'S', rank: 2 }, { suit: 'D', rank: 14 }] });
});

test('rejects candidate plays outside the current hand or breaking follow suit', async () => {
  const deal = { hands: { N: [], E: [{ suit: 'H', rank: 10 }, { suit: 'S', rank: 14 }], S: [], W: [] },
    trump: 'NT', trickLeader: 'N', trickPlayed: [{ suit: 'H', rank: 2 }] };
  for (const card of [{ suit: 'S', rank: 14 }, { suit: 'H', rank: 11 }]) {
    const client = createWasmDdsClient({ loadModule: async () => ({
      solveBoardPbn: () => ({ score: 1, cards: [card] }),
    }) });
    await assert.rejects(() => client.solveBoard(deal), (error) => error instanceof DdsRuntimeError && error.code === 'DDS_FAILURE');
  }
});

test('rejects malformed input before invoking the loader', async () => {
  let loads = 0;
  const client = createWasmDdsClient({ loadModule: async () => { loads += 1; return {}; } });
  await assert.rejects(() => client.solveBoard({ hands, trump: 'X', trickLeader: 'S', trickPlayed: [] }), (error) => error instanceof DdsInputError && error.code === 'INVALID_DEAL');
  assert.equal(loads, 0);
});

test('hides underlying runtime failures behind a coded error', async () => {
  const client = createWasmDdsClient({ loadModule: async () => ({ calcDDTablePbn() { throw new Error('private wasm failure'); } }) });
  await assert.rejects(() => client.calcDDTable(hands), (error) => error instanceof DdsRuntimeError && error.code === 'DDS_FAILURE' && !error.message.includes('private wasm failure'));
});

test('maps malformed Wasm results to the generic runtime error', async () => {
  const client = createWasmDdsClient({ loadModule: async () => ({
    calcDDTablePbn() { return { N: { S: 4, H: 3, D: 2, C: 1, NT: 5 }, E: { S: 8, H: 7, D: 6, C: 5, NT: 9 }, S: { S: 12, H: 11, D: 10, C: 9, NT: 13 }, W: { S: 1, H: 0, D: 13 } }; },
  }) });
  await assert.rejects(() => client.calcDDTable(hands), (error) => error instanceof DdsRuntimeError && error.code === 'DDS_FAILURE');
});

test('maps out-of-range Wasm table values and solve scores to DDS_FAILURE', async () => {
  const badTable = { N: { S: 14, H: 3, D: 2, C: 1, NT: 5 }, E: { S: 8, H: 7, D: 6, C: 5, NT: 9 }, S: { S: 12, H: 11, D: 10, C: 9, NT: 13 }, W: { S: 1, H: 0, D: 13, C: 12, NT: 2 } };
  const tableClient = createWasmDdsClient({ loadModule: async () => ({ calcDDTablePbn: () => badTable }) });
  await assert.rejects(() => tableClient.calcDDTable(hands), (error) => error instanceof DdsRuntimeError && error.code === 'DDS_FAILURE');
  const solveClient = createWasmDdsClient({ loadModule: async () => ({ solveBoardPbn: () => ({ score: 14, cards: [] }) }) });
  await assert.rejects(() => solveClient.solveBoard({ hands, trump: 'NT', trickLeader: 'S', trickPlayed: [] }), (error) => error instanceof DdsRuntimeError && error.code === 'DDS_FAILURE');
});
