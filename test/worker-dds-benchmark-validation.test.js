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

test('equal solve scores with different optimal candidates are informational', async () => {
  const { compareDdsResults } = await helper;
  const baseline = { score: 2, cards: [{ suit: 'S', rank: 2 }] };
  const worker = { score: 2, cards: [{ suit: 'S', rank: 2 }, { suit: 'S', rank: 3 }] };
  const comparison = compareDdsResults('solve', baseline, worker);
  assert.equal(comparison.parityMismatch, false);
  assert.deepEqual(comparison.candidateDifference, { baseline: ['S2'], worker: ['S2', 'S3'] });
  assert.equal(compareDdsResults('solve', baseline, { ...worker, score: 1 }).parityMismatch, true);
  assert.equal(compareDdsResults('table', table(), table()).parityMismatch, false);
  const changedTable = table(); changedTable[0][0] = 1;
  assert.equal(compareDdsResults('table', table(), changedTable).parityMismatch, true);
});

test('different solve scores remain parity errors without an informational tie', async () => {
  const { compareDdsResults, validateCandidateDiagnostics } = await helper;
  const operation = { id: 'score-mismatch', kind: 'solve',
    baseline: { score: 2, cards: [{ suit: 'S', rank: 2 }] },
    worker: { score: 1, cards: [{ suit: 'H', rank: 3 }] } };
  assert.deepEqual(compareDdsResults(operation.kind, operation.baseline, operation.worker),
    { parityMismatch: true, candidateDifference: null });
  assert.equal(validateCandidateDiagnostics([operation], []), true);
  assert.equal(validateCandidateDiagnostics([operation], [{ id: operation.id, kind: 'solve', score: 1,
    baseline: ['S2'], worker: ['H3'] }]), false);
});

test('Worker candidates must be canonical legal plays in the current hand', async () => {
  const { validateWorkerSolveCandidates } = await helper;
  const deal = { trickLeader: 'N', trickPlayed: [{ suit: 'H', rank: 2 }],
    hands: { N: [], E: [{ suit: 'H', rank: 10 }, { suit: 'H', rank: 11 }, { suit: 'S', rank: 14 }], S: [], W: [] } };
  assert.deepEqual(validateWorkerSolveCandidates({ score: 1, cards: [{ suit: 'H', rank: 10 }, { suit: 'H', rank: 11 }] }, deal),
    { score: 1, cards: ['H10', 'H11'] });
  for (const cards of [
    [{ suit: 'S', rank: 14 }],
    [{ suit: 'H', rank: 12 }],
    [{ suit: 'H', rank: 11 }, { suit: 'H', rank: 10 }],
    [{ suit: 'H', rank: 10 }, { suit: 'H', rank: 10 }],
  ]) assert.throws(() => validateWorkerSolveCandidates({ score: 1, cards }, deal), /Malformed Worker response/);
});

test('candidate diagnostics exactly reconcile to unique operation IDs and canonical sets', async () => {
  const { validateCandidateDiagnostics } = await helper;
  const operation = { id: 'tie-1', kind: 'solve', baseline: { score: 2, cards: [{ suit: 'S', rank: 2 }] },
    worker: { score: 2, cards: [{ suit: 'S', rank: 2 }, { suit: 'S', rank: 3 }] } };
  const diagnostic = { id: 'tie-1', kind: 'solve', score: 2, baseline: ['S2'], worker: ['S2', 'S3'] };
  assert.equal(validateCandidateDiagnostics([operation], [diagnostic]), true);
  for (const changed of [
    { ...diagnostic, id: 'forged' }, { ...diagnostic, kind: 'table' },
    { ...diagnostic, score: 1 }, { ...diagnostic, baseline: ['S3'] },
    { ...diagnostic, worker: ['S3', 'S2'] }, { ...diagnostic, worker: ['S2', 'S4'] },
    { ...diagnostic, worker: undefined },
  ]) assert.equal(validateCandidateDiagnostics([operation], [changed]), false);
  assert.equal(validateCandidateDiagnostics([operation], []), false);
  assert.equal(validateCandidateDiagnostics([operation], [diagnostic, diagnostic]), false);
  assert.equal(validateCandidateDiagnostics([operation, operation], [diagnostic]), false);
  assert.equal(validateCandidateDiagnostics([], [diagnostic]), false);
  assert.equal(validateCandidateDiagnostics([], []), true);
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
