'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { calcDDTable, createDdsClient, solveBoard } = require('../dds-wrapper');
const { validateProvenance } = require('../scripts/generate-dds-parity-fixtures');

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

const DDS_PARITY_FIXTURE_PATH = path.join(__dirname, '..', 'workers', 'test', 'fixtures', 'dds-parity.json');
const DDS_INVALID_FIXTURE_PATH = path.join(__dirname, '..', 'workers', 'test', 'fixtures', 'dds-invalid.json');
const DDS_SOURCE_MANIFEST_PATH = path.join(__dirname, '..', 'workers', 'test', 'fixtures', 'dds-source-manifest.json');
const SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3 };

function cardKey(card) {
  return `${card.suit}:${card.rank}`;
}

function sortCandidates(cards) {
  return [...cards].sort((a, b) => SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit] || a.rank - b.rank);
}

function assertValidHands(hands) {
  assert.deepEqual(Object.keys(hands).sort(), ['E', 'N', 'S', 'W']);
  const seen = new Set();
  for (const seat of ['N', 'E', 'S', 'W']) {
    assert.ok(Array.isArray(hands[seat]));
    for (const card of hands[seat]) {
      assert.ok(Number.isInteger(card.rank) && card.rank >= 2 && card.rank <= 14);
      assert.ok(Object.hasOwn(SUIT_ORDER, card.suit));
      assert.ok(!seen.has(cardKey(card)), `duplicate card ${cardKey(card)}`);
      seen.add(cardKey(card));
    }
  }
}

function assertSortedCandidates(cards) {
  const keys = cards.map(cardKey);
  assert.equal(new Set(keys).size, keys.length, 'candidate cards must be unique');
  assert.deepEqual(cards, sortCandidates(cards));
}

function problemCoverageLabels() {
  const problemsDir = path.join(__dirname, '..', 'public', 'problems');
  return fs.readdirSync(problemsDir).filter((name) => name.endsWith('.json')).sort().flatMap((name) => {
    const problem = JSON.parse(fs.readFileSync(path.join(problemsDir, name), 'utf8'));
    return [
      `problem:${problem.id}:opening`,
      ...(problem.testCases || []).flatMap((testCase, testCaseIndex) => [
        `problem:${problem.id}:testCases[${testCaseIndex}]`,
        ...(testCase.deviationBranches || []).map((_, branchIndex) => `problem:${problem.id}:testCases[${testCaseIndex}].deviationBranches[${branchIndex}]`),
      ]),
    ];
  });
}

function assertFullProvenance(source) {
  validateProvenance(source);
  assertValidHands(source.originalHands);
  assert.equal(Object.values(source.originalHands).flat().length, 52);
  const originals = new Map(Object.entries(source.originalHands).flatMap(([seat, cards]) => cards.map((card) => [cardKey(card), seat])));
  const seen = new Set();
  const consume = (seat, card) => {
    assert.equal(originals.get(cardKey(card)), seat, `${cardKey(card)} must belong to ${seat}`);
    assert.ok(!seen.has(cardKey(card)), `${cardKey(card)} appears more than once`);
    seen.add(cardKey(card));
  };
  for (const trick of source.completedTricks) for (const play of trick.cards) consume(play.seat, play.card);
  for (const play of source.trickPlayed) consume(play.seat, play.card);
  for (const [seat, cards] of Object.entries(source.hands)) for (const card of cards) consume(seat, card);
  assert.equal(seen.size, 52);
}

test('invalid DDS fixture cases are adapter-only INVALID_DEAL inputs', () => {
  const fixtures = JSON.parse(fs.readFileSync(DDS_INVALID_FIXTURE_PATH, 'utf8'));
  const expected = new Set(['invalid-suit', 'invalid-rank', 'duplicate-card', 'missing-seat', 'trick-too-long', 'invalid-trump', 'card-in-hand-and-trick']);
  assert.deepEqual(new Set(fixtures.map((fixture) => fixture.id)), expected);
  for (const fixture of fixtures) {
    assert.equal(fixture.expected.code, 'INVALID_DEAL');
    const deal = fixture.deal;
    if (fixture.id === 'invalid-suit') assert.ok(!Object.hasOwn(SUIT_ORDER, deal.hands.N[0].suit));
    if (fixture.id === 'invalid-rank') assert.ok(deal.hands.N[0].rank < 2 || deal.hands.N[0].rank > 14);
    if (fixture.id === 'duplicate-card') assert.equal(cardKey(deal.hands.N[0]), cardKey(deal.hands.E[0]));
    if (fixture.id === 'missing-seat') assert.notDeepEqual(Object.keys(deal.hands).sort(), ['E', 'N', 'S', 'W']);
    if (fixture.id === 'trick-too-long') assert.ok(deal.trickPlayed.length > 3);
    if (fixture.id === 'invalid-trump') assert.ok(!['S', 'H', 'D', 'C', 'NT'].includes(deal.trump));
    if (fixture.id === 'card-in-hand-and-trick') assert.ok(deal.hands.N.some((card) => cardKey(card) === cardKey(deal.trickPlayed[0])));
  }
});

test('DDS source manifest covers problem positions and retains complete branch provenance', () => {
  const manifest = JSON.parse(fs.readFileSync(DDS_SOURCE_MANIFEST_PATH, 'utf8'));
  assert.deepEqual(new Set(manifest.coverage), new Set(problemCoverageLabels()));
  const branchLabels = manifest.coverage.filter((label) => label.includes('.deviationBranches['));
  const stateLabels = manifest.coverage.filter((label) => !label.includes('.deviationBranches['));
  assert.deepEqual(new Set(Object.keys(manifest.states || {})), new Set(stateLabels));
  for (const label of stateLabels) assertFullProvenance(manifest.states[label]);
  assert.deepEqual(new Set(Object.keys(manifest.branches || {})), new Set(branchLabels));
  for (const label of branchLabels) {
    assert.ok(manifest.branches[label], `missing saved branch provenance for ${label}`);
    assertFullProvenance(manifest.branches[label]);
  }
});

test('generator provenance validator rejects an off-suit play when following suit is possible', () => {
  const manifest = JSON.parse(fs.readFileSync(DDS_SOURCE_MANIFEST_PATH, 'utf8'));
  const source = structuredClone(manifest.branches['problem:A5:testCases[0].deviationBranches[0]']);
  const offSuit = source.originalHands.N.find((card) => card.suit === 'H');
  source.trickPlayed = [
    { seat: 'W', card: { suit: 'S', rank: 10 } },
    { seat: 'N', card: offSuit },
  ];
  source.hands.N = source.originalHands.N.filter((card) => cardKey(card) !== cardKey(offSuit));
  source.hands.W = source.originalHands.W.filter((card) => cardKey(card) !== 'S:10');
  assert.throws(() => validateProvenance(source), /follow suit/i);
});

test('DDS parity fixture schema is stable and executable', () => {
  const fixtures = JSON.parse(fs.readFileSync(DDS_PARITY_FIXTURE_PATH, 'utf8'));
  assert.ok(Array.isArray(fixtures) && fixtures.length > 0);
  const ids = new Set();
  for (const fixture of fixtures) {
    assert.match(fixture.id, /^\S+$/u);
    assert.ok(!ids.has(fixture.id), `duplicate fixture id ${fixture.id}`);
    ids.add(fixture.id);
    assert.ok(fixture.kind === 'table' || fixture.kind === 'solve');
    assertValidHands(fixture.hands);
    if (fixture.kind === 'table') {
      assert.ok(Array.isArray(fixture.expected.table) && fixture.expected.table.length === 5);
      for (const row of fixture.expected.table) {
        assert.ok(Array.isArray(row) && row.length === 4);
        for (const value of row) assert.ok(Number.isInteger(value) && value >= 0 && value <= 13);
      }
    } else {
      assert.ok(Number.isInteger(fixture.expected.score) && fixture.expected.score >= 0 && fixture.expected.score <= 13);
      assert.ok(Array.isArray(fixture.expected.cards) && fixture.expected.cards.length > 0);
      assertSortedCandidates(fixture.expected.cards);
    }
  }
});

test('Node DDS wrapper reproduces every checked-in legal parity fixture', async () => {
  const fixtures = JSON.parse(fs.readFileSync(DDS_PARITY_FIXTURE_PATH, 'utf8'));
  for (const fixture of fixtures) {
    if (fixture.kind === 'table') {
      assert.deepEqual(await calcDDTable(fixture.hands), fixture.expected.table, fixture.id);
      continue;
    }
    const result = await solveBoard({
      trump: fixture.trump,
      trickLeader: fixture.trickLeader,
      trickPlayed: fixture.trickPlayed,
      hands: fixture.hands,
    });
    assert.equal(result.score, fixture.expected.score, fixture.id);
    assert.deepEqual(sortCandidates(result.cards), fixture.expected.cards, fixture.id);
  }
});

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
