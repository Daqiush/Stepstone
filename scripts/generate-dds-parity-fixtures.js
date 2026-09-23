'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { calcDDTable, solveBoard } = require('../dds-wrapper');
const { captureProblemBranch, captureProblemStates } = require('./capture-problem-dds-fixtures');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'workers', 'test', 'fixtures');
const MANIFEST_PATH = path.join(FIXTURES, 'dds-source-manifest.json');
const OUTPUT_PATH = path.join(FIXTURES, 'dds-parity.json');
const SEATS = ['N', 'E', 'S', 'W'];
const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_ORDER = Object.fromEntries(SUITS.map((s, i) => [s, i]));

const clone = (value) => JSON.parse(JSON.stringify(value));
const key = (card) => `${card.suit}:${card.rank}`;
const nextSeat = (seat) => SEATS[(SEATS.indexOf(seat) + 1) % 4];
const sortCards = (cards) => [...cards].sort((a, b) => SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit] || a.rank - b.rank);

function seededRandom(seed) {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledDeal(seed) {
  const deck = SUITS.flatMap((suit) => Array.from({ length: 13 }, (_, i) => ({ suit, rank: i + 2 })));
  const random = seededRandom(seed);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const hands = { N: [], E: [], S: [], W: [] };
  deck.forEach((card, i) => hands[SEATS[i % 4]].push(card));
  return hands;
}

function removeCard(cards, card) {
  const index = cards.findIndex((candidate) => key(candidate) === key(card));
  if (index === -1) throw new Error(`Card ${key(card)} is not in its recorded hand`);
  return [...cards.slice(0, index), ...cards.slice(index + 1)];
}

function validateProvenance({ originalHands, completedTricks = [], trickPlayed = [], hands, trickLeader, currentPlayer }) {
  if (!SEATS.includes(trickLeader) || trickPlayed.length > 3) throw new Error('Invalid current trick provenance');
  const original = new Map();
  for (const seat of SEATS) for (const card of originalHands[seat] || []) {
    if (!SUIT_ORDER.hasOwnProperty(card.suit) || !Number.isInteger(card.rank) || card.rank < 2 || card.rank > 14 || original.has(key(card))) throw new Error(`Invalid original card ${key(card)}`);
    original.set(key(card), seat);
  }
  if (original.size !== 52) throw new Error(`Original deal has ${original.size} physical cards, expected 52`);
  const remaining = Object.fromEntries(SEATS.map((seat) => [seat, clone(originalHands[seat]) ]));
  const consume = (seat, card, ledSuit) => {
    if (original.get(key(card)) !== seat) throw new Error(`Card ${key(card)} does not belong to ${seat}`);
    const cards = remaining[seat];
    if (!cards) throw new Error(`Invalid seat ${seat} in provenance`);
    if (ledSuit && card.suit !== ledSuit && cards.some((candidate) => candidate.suit === ledSuit)) {
      throw new Error(`Illegal play ${key(card)} by ${seat}: must follow suit ${ledSuit}`);
    }
    remaining[seat] = removeCard(cards, card);
  };
  for (const trick of completedTricks) {
    const cards = trick.cards || [];
    if (cards.length !== 4) throw new Error('Completed trick must contain exactly four plays');
    let expectedSeat = cards[0]?.seat;
    let ledSuit;
    for (const play of cards) {
      if (!SEATS.includes(play.seat) || play.seat !== expectedSeat) throw new Error(`Illegal completed trick order at ${play.seat}`);
      consume(play.seat, play.card, ledSuit);
      ledSuit ||= play.card.suit;
      expectedSeat = nextSeat(expectedSeat);
    }
  }
  let expected = trickLeader;
  let ledSuit;
  for (const play of trickPlayed) {
    if (play.seat !== expected) throw new Error(`Illegal current trick order: expected ${expected}, got ${play.seat}`);
    consume(play.seat, play.card, ledSuit);
    ledSuit ||= play.card.suit;
    expected = nextSeat(expected);
  }
  for (const seat of SEATS) {
    if (!Array.isArray(hands[seat])) throw new Error(`Missing remaining hand for ${seat}`);
    const expectedCards = sortCards(remaining[seat]);
    const actualCards = sortCards(hands[seat]);
    if (JSON.stringify(actualCards) !== JSON.stringify(expectedCards)) throw new Error(`Remaining hand for ${seat} does not match provenance`);
  }
  const expectedCurrentPlayer = SEATS[(SEATS.indexOf(trickLeader) + trickPlayed.length) % 4];
  if (currentPlayer && currentPlayer !== expectedCurrentPlayer) {
    throw new Error(`Current player must be ${expectedCurrentPlayer}`);
  }
}

function validateSolve(fixture) {
  const { score, cards } = fixture.expected;
  if (!Number.isInteger(score) || score < 0 || score > 13) throw new Error(`${fixture.id}: invalid DDS score`);
  const sorted = sortCards(cards);
  if (JSON.stringify(cards) !== JSON.stringify(sorted) || new Set(cards.map(key)).size !== cards.length) throw new Error(`${fixture.id}: candidates must be unique and S,H,D,C/rank sorted`);
  const current = SEATS[(SEATS.indexOf(fixture.trickLeader) + fixture.trickPlayed.length) % 4];
  const hand = fixture.hands[current];
  for (const card of cards) if (!hand.some((candidate) => key(candidate) === key(card))) throw new Error(`${fixture.id}: non-legal candidate ${key(card)}`);
}

async function addSolve(fixtures, source) {
  validateProvenance(source);
  const expected = await solveBoard({ trump: source.trump, trickLeader: source.trickLeader, trickPlayed: source.trickPlayed.map((play) => play.card), hands: source.hands });
  const fixture = { id: source.id, kind: 'solve', sourceLabel: source.sourceLabel, trump: source.trump, trickLeader: source.trickLeader, trickPlayed: source.trickPlayed.map((play) => play.card), hands: source.hands, expected: { score: expected.score, cards: sortCards(expected.cards) } };
  validateSolve(fixture);
  fixtures.push(fixture);
}

async function addTable(fixtures, id, sourceLabel, hands) {
  validateProvenance({ originalHands: hands, hands, trickLeader: 'N' });
  fixtures.push({ id, kind: 'table', sourceLabel, hands, expected: { table: await calcDDTable(hands) } });
}

function problemLabels() {
  const labels = [];
  for (const name of fs.readdirSync(path.join(ROOT, 'public', 'problems')).filter((file) => file.endsWith('.json')).sort()) {
    const problem = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'problems', name), 'utf8'));
    labels.push(`problem:${problem.id}:opening`);
    (problem.testCases || []).forEach((testCase, index) => {
      labels.push(`problem:${problem.id}:testCases[${index}]`);
      (testCase.deviationBranches || []).forEach((_, branchIndex) => labels.push(`problem:${problem.id}:testCases[${index}].deviationBranches[${branchIndex}]`));
    });
  }
  return labels;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const writing = process.argv.includes('--write');
  const refreshLiveSources = process.argv.includes('--refresh-live-sources');
  const actualLabels = problemLabels();
  const expectedLabels = manifest.coverage || [];
  const missing = actualLabels.filter((label) => !expectedLabels.includes(label));
  const stale = expectedLabels.filter((label) => !actualLabels.includes(label));
  if (missing.length || stale.length || new Set(expectedLabels).size !== expectedLabels.length) throw new Error(`DDS coverage mismatch: missing=[${missing.join(', ')}] stale-or-duplicate=[${stale.join(', ')}]`);
  const fixtures = [];
  let manifestChanged = false;
  const verifyLiveState = (label, live) => {
    const saved = manifest.states?.[label];
    if (!saved) {
      if (!refreshLiveSources) throw new Error(`Missing checked-in live provenance for ${label}; rerun with --refresh-live-sources to deliberately record it`);
      manifest.states ||= {};
      manifest.states[label] = live;
      manifestChanged = true;
      return live;
    }
    try { validateProvenance(live); } catch (error) { throw new Error(`${label}: ${error.message}`); }
    if (JSON.stringify(live) !== JSON.stringify(saved)) {
      if (!refreshLiveSources) {
        try { validateProvenance(saved); } catch (error) { throw new Error(`${label}: ${error.message}`); }
        throw new Error(`Live problem state differs from checked-in provenance for ${label}`);
      }
      manifest.states[label] = live;
      manifestChanged = true;
      return live;
    }
    try { validateProvenance(saved); } catch (error) { throw new Error(`${label}: ${error.message}`); }
    return saved;
  };
  for (const source of manifest.synthetic) {
    const originalHands = shuffledDeal(source.seed);
    if (source.kind === 'table') await addTable(fixtures, source.id, source.id, originalHands);
    else {
      const trickPlayed = []; let seat = source.trickLeader; const hands = clone(originalHands);
      for (let i = 0; i < source.trickLength; i++) {
        const ledSuit = trickPlayed[0]?.card.suit;
        const card = (ledSuit && hands[seat].find((candidate) => candidate.suit === ledSuit)) || hands[seat][0];
        hands[seat] = removeCard(hands[seat], card);
        trickPlayed.push({ seat, card });
        seat = nextSeat(seat);
      }
      await addSolve(fixtures, { ...source, sourceLabel: source.id, originalHands, hands, trickPlayed });
    }
  }
  for (const name of fs.readdirSync(path.join(ROOT, 'public', 'problems')).filter((file) => file.endsWith('.json')).sort()) {
    const problem = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'problems', name), 'utf8'));
    const liveStates = await captureProblemStates({ problemId: problem.id, testCaseCount: problem.testCases.length });
    const opening = verifyLiveState(`problem:${problem.id}:opening`, liveStates.opening);
    await addTable(fixtures, `problem.${problem.id}.opening`, `problem:${problem.id}:opening`, opening.hands);
    for (let index = 0; index < problem.testCases.length; index++) {
      const testCase = problem.testCases[index];
      const sourceLabel = `problem:${problem.id}:testCases[${index}]`;
      const testState = verifyLiveState(sourceLabel, liveStates.testCases[index]);
      await addTable(fixtures, `problem.${problem.id}.test-${index}`, sourceLabel, testState.hands);
      for (let branchIndex = 0; branchIndex < (testCase.deviationBranches || []).length; branchIndex++) {
        const sourceLabel = `problem:${problem.id}:testCases[${index}].deviationBranches[${branchIndex}]`;
        const saved = manifest.branches?.[sourceLabel];
        if (!saved) throw new Error(`Missing checked-in branch provenance for ${sourceLabel}`);
        validateProvenance(saved);
        const capture = await captureProblemBranch({ problemId: problem.id, testCaseIndex: index, branchIndex });
        validateProvenance(capture);
        if (JSON.stringify(capture) !== JSON.stringify(saved)) throw new Error(`Public branch capture differs from checked-in provenance for ${sourceLabel}`);
        await addSolve(fixtures, { id: `problem.${problem.id}.test-${index}.branch-${branchIndex}`, sourceLabel, ...saved });
      }
    }
  }
  fixtures.sort((a, b) => a.id.localeCompare(b.id));
  if (writing) {
    if (manifestChanged) {
      if (!refreshLiveSources) throw new Error('Refusing to write changed live provenance without --refresh-live-sources');
      fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(fixtures, null, 2)}\n`);
  } else if (process.argv.includes('--verify')) {
    const checked = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    if (JSON.stringify(fixtures) !== JSON.stringify(checked)) throw new Error('Live DDS results differ from checked-in parity fixtures');
  } else {
    process.stdout.write(`${JSON.stringify(fixtures, null, 2)}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(`[DDS fixtures] ${error.message}`); process.exitCode = 1; });
}

module.exports = { main, validateProvenance };
