'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const { SEATS } = require('../classic/constants.cjs');
const { applyClassicCommand, preflightClassicCommand } = require('../classic/engine.cjs');
const { boardInfoFor } = require('../classic/rules.cjs');
const {
  CLASSIC_STATE_KEYS, createClassicLobbyState, validateClassicState,
} = require('../classic/state.cjs');
const { applyClassicDdsCompletion } = require('../classic/node-compat.cjs');
const {
  createClassicNodeAdapter, projectClassicState,
} = require('../classic/node-adapter.js');
const { assertTranscriptDeals } = require('./helpers/classic-fixtures.js');

const TRANSCRIPT_PATH = path.join(__dirname, 'fixtures', 'classic-transcripts.json');
const DOCUMENT = JSON.parse(readFileSync(TRANSCRIPT_PATH, 'utf8'));
const PUBLIC_RANKS = Object.freeze({
  2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
});
const TEST_SEATS = Object.freeze(['N', 'E', 'S', 'W']);
const TEST_DENOMINATIONS = Object.freeze(['C', 'D', 'H', 'S', 'NT']);
const MAXIMUM_AUCTION_EXPECTED_CALLS = Object.freeze(buildMaximumAuctionExpectedCalls());
const PARTNER = Object.freeze({ N: 'S', E: 'W', S: 'N', W: 'E' });
const CLASSIC_VIEW_KEYS = Object.freeze([
  'schemaVersion', 'mode', 'phase', 'dealNumber', 'boardInfo', 'readyStatus',
  'biddingHistory', 'currentBidder', 'currentContract', 'consecutivePasses',
  'declarer', 'dummy', 'leader', 'currentPlayer', 'currentTrick', 'completedCount',
  'nsTricks', 'ewTricks', 'dummyRevealed', 'claimSettlement', 'boardScores',
  'ddTable', 'ddsStatus', 'hands',
]);
const ROOM_SNAPSHOT_KEYS = Object.freeze([
  'schemaVersion', 'roomCode', 'incarnation', 'revision', 'status', 'foundationCounter',
  'createdAt', 'expiresAt', 'viewer', 'playerNames', 'classic',
]);
const WORKER_EVENT_KEYS = Object.freeze({
  'classic.started': ['dealNumber', 'boardInfo'],
  'classic.bidding-updated': [
    'biddingHistory', 'currentBidder', 'currentContract', 'consecutivePasses',
  ],
  'classic.bidding-ended': ['contract', 'declarer', 'dummy', 'leader', 'biddingHistory'],
  'classic.dummy-revealed': ['dummy'],
  'classic.card-played': ['seat', 'card', 'currentTrick'],
  'classic.trick-ended': ['trick', 'winner', 'nsTricks', 'ewTricks'],
  'classic.ready-updated': ['readyStatus'],
  'classic.dd-table-ready': ['dealNumber', 'ddTable'],
});
const NODE_PAYLOAD_KEYS = Object.freeze({
  gameStart: ['hand', 'boardInfo', 'seat', 'playerNames', 'boardScores'],
  biddingUpdate: ['history', 'currentBidder', 'currentContract', 'consecutivePasses'],
  biddingEnd: [
    'contract', 'declarer', 'dummy', 'leader', 'biddingHistory', 'declarerControlledBy',
  ],
  playUpdate: [
    'currentPlayer', 'currentTrick', 'completedCount', 'nsTricks', 'ewTricks',
    'dummyRevealed', 'dummy', 'declarer', 'declarerControlledBy',
    'teachingCurrentSeat', 'teachingCurrentHand',
  ],
  dummyRevealed: ['dummy', 'dummyHand'],
  cardPlayed: ['seat', 'card', 'currentTrick'],
  trickEnd: ['trick', 'winner', 'nsTricks', 'ewTricks'],
  nextDealUpdate: ['readyStatus', 'playerNames'],
  ddTableReady: ['ddTable'],
});
const LEGACY_PASSED_SCORE_KEYS = Object.freeze([
  'dealNumber', 'boardNumber', 'score', 'passedOut', 'ddTable', 'biddingHistory',
  'initialHands',
]);
const LEGACY_PLAYED_SCORE_KEYS = Object.freeze([
  'dealNumber', 'boardNumber', 'passedOut', 'contract', 'declarer', 'dummy',
  'declarerTricks', 'needed', 'score', 'made', 'diff', 'vulnerability',
  'biddingHistory', 'completedTricks', 'ddTable', 'claim', 'initialHands',
]);
const FORBIDDEN_TRANSPORT_KEYS = new Set([
  'initialHands', 'reconnectToken', 'nextReconnectToken', 'commandCache',
  'pendingActions', 'actionId', 'generationId', 'token', 'cache',
]);

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label);
}

function assertNoForbiddenTransportKeys(value, label) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoForbiddenTransportKeys(child, `${label}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(FORBIDDEN_TRANSPORT_KEYS.has(key), false, `${label}.${key}`);
    assertNoForbiddenTransportKeys(child, `${label}.${key}`);
  }
}

function sameSide(left, right) {
  return left !== null && right !== null && (left === right || PARTNER[left] === right);
}

function expectedAuction(history, viewerSeat, { legacy = false } = {}) {
  return history.map(entry => {
    const bid = legacy && entry.bid === 'X' ? 'Double'
      : legacy && entry.bid === 'XX' ? 'Redouble' : entry.bid;
    if (viewerSeat !== null && viewerSeat !== entry.seat && sameSide(viewerSeat, entry.seat)) {
      return { seat: entry.seat, bid };
    }
    return {
      seat: entry.seat, bid, alert: entry.alert, explain: entry.explain,
      qa: clone(entry.qa),
    };
  });
}

function buildMaximumAuctionExpectedCalls() {
  const bids = ['Pass', 'Pass', 'Pass'];
  for (let level = 1; level <= 7; level += 1) {
    for (const denomination of TEST_DENOMINATIONS) {
      bids.push(`${level}${denomination}`, 'Pass', 'Pass', 'X', 'Pass', 'Pass', 'XX',
        'Pass', 'Pass');
    }
  }
  bids.push('Pass');
  return bids.map((bid, index) => Object.freeze({
    actor: TEST_SEATS[index % TEST_SEATS.length], bid,
  }));
}

function testAuctionSide(seat) {
  return seat === 'N' || seat === 'S' ? 'NS' : 'EW';
}

function independentContractIndex(bid) {
  const match = /^([1-7])(C|D|H|S|NT)$/.exec(bid);
  if (!match) return null;
  return (Number(match[1]) - 1) * TEST_DENOMINATIONS.length
    + TEST_DENOMINATIONS.indexOf(match[2]);
}

function assertIndependentlyLegalAuction(calls) {
  let contract = null;
  let contractIndex = -1;
  let doubled = false;
  let redoubled = false;
  let consecutivePasses = 0;
  let terminationIndex = null;

  calls.forEach((call, index) => {
    assert.equal(terminationIndex, null, `call ${index + 1} occurs after termination`);
    assert.equal(call.actor, TEST_SEATS[index % TEST_SEATS.length],
      `call ${index + 1} actor rotation`);

    const nextContractIndex = independentContractIndex(call.bid);
    if (call.bid === 'Pass') {
      consecutivePasses += 1;
    } else if (nextContractIndex !== null) {
      assert.ok(nextContractIndex > contractIndex, `call ${index + 1} contract order`);
      contract = { bidder: call.actor, bid: call.bid };
      contractIndex = nextContractIndex;
      doubled = false;
      redoubled = false;
      consecutivePasses = 0;
    } else if (call.bid === 'X') {
      assert.ok(contract, `call ${index + 1} X requires a contract`);
      assert.equal(doubled, false, `call ${index + 1} X requires an undoubled contract`);
      assert.notEqual(testAuctionSide(call.actor), testAuctionSide(contract.bidder),
        `call ${index + 1} X must be by opponents`);
      doubled = true;
      redoubled = false;
      consecutivePasses = 0;
    } else if (call.bid === 'XX') {
      assert.ok(contract, `call ${index + 1} XX requires a contract`);
      assert.equal(doubled, true, `call ${index + 1} XX requires X`);
      assert.equal(redoubled, false, `call ${index + 1} duplicate XX`);
      assert.equal(testAuctionSide(call.actor), testAuctionSide(contract.bidder),
        `call ${index + 1} XX must be by declaring side`);
      redoubled = true;
      consecutivePasses = 0;
    } else {
      assert.fail(`call ${index + 1} has unknown bid ${call.bid}`);
    }

    const terminated = contract === null ? consecutivePasses === 4 : consecutivePasses === 3;
    if (terminated) terminationIndex = index;
    assert.equal(terminated, index === calls.length - 1,
      `call ${index + 1} termination`);
  });

  assert.equal(terminationIndex, calls.length - 1);
  assert.equal(contractIndex, 34);
  assert.equal(contract.bid, '7NT');
  assert.equal(doubled, true);
  assert.equal(redoubled, true);
}

function expectedNodeBoardScores(state, viewerSeat, room) {
  return state.boardScores.map(score => {
    const biddingHistory = expectedAuction(score.biddingHistory, viewerSeat);
    if (score.passedOut) {
      return {
        dealNumber: score.dealNumber,
        boardNumber: score.boardNumber,
        score: score.score,
        passedOut: true,
        ddTable: clone(score.ddTable),
        biddingHistory,
        initialHands: clone(score.initialHands),
      };
    }
    let completedTricks = clone(score.completedTricks);
    const partial = room.classicClaimedPartialTricks?.[score.dealNumber];
    if (partial && !completedTricks.some(trick => trick.claimed === true)) {
      completedTricks = [...completedTricks, clone(partial)];
    }
    return {
      dealNumber: score.dealNumber,
      boardNumber: score.boardNumber,
      passedOut: false,
      contract: clone(score.contract),
      declarer: score.declarer,
      dummy: score.dummy,
      declarerTricks: score.declarerTricks,
      needed: score.needed,
      score: score.score,
      made: score.made,
      diff: score.diff,
      vulnerability: score.vulnerability,
      biddingHistory,
      completedTricks,
      ddTable: clone(score.ddTable),
      claim: clone(score.claim),
      initialHands: clone(score.initialHands),
    };
  });
}

function assertCardShape(card, label) {
  exactKeys(card, ['suit', 'rank'], label);
}

function assertHandsShape(hands, label) {
  exactKeys(hands, SEATS, label);
  for (const seat of SEATS) {
    assert.ok(Array.isArray(hands[seat]), `${label}.${seat}`);
    hands[seat].forEach((card, index) => assertCardShape(card, `${label}.${seat}[${index}]`));
  }
}

function assertDdTableShape(table, label) {
  if (table === null) return;
  assert.equal(table.length, 5, `${label} denominations`);
  table.forEach((row, rowIndex) => {
    assert.equal(row.length, 4, `${label}[${rowIndex}] seats`);
    row.forEach((value, columnIndex) => {
      assert.equal(Number.isInteger(value), true, `${label}[${rowIndex}][${columnIndex}]`);
    });
  });
}

function assertLegacyAuctionShape(history, viewerSeat, label) {
  assert.ok(Array.isArray(history), label);
  history.forEach((entry, index) => {
    const hiddenPartner = viewerSeat !== null && viewerSeat !== entry.seat
      && sameSide(viewerSeat, entry.seat);
    exactKeys(entry, hiddenPartner ? ['seat', 'bid'] : ['seat', 'bid', 'alert', 'explain', 'qa'],
      `${label}[${index}]`);
    if (!hiddenPartner) {
      assert.ok(Array.isArray(entry.qa), `${label}[${index}].qa`);
      entry.qa.forEach((qa, qaIndex) => {
        exactKeys(qa, ['asker', 'question', 'answer', 'answerer'],
          `${label}[${index}].qa[${qaIndex}]`);
      });
    }
  });
}

function assertLegacyReplayScores(actual, state, viewerSeat, room, label) {
  const expected = expectedNodeBoardScores(state, viewerSeat, room);
  assert.deepEqual(actual, expected, label);
  assert.equal(actual.length, state.boardScores.length, `${label} length`);
  actual.forEach((score, index) => {
    const canonical = state.boardScores[index];
    exactKeys(score, canonical.passedOut ? LEGACY_PASSED_SCORE_KEYS : LEGACY_PLAYED_SCORE_KEYS,
      `${label}[${index}]`);
    assertLegacyAuctionShape(score.biddingHistory, viewerSeat,
      `${label}[${index}].biddingHistory`);
    assertHandsShape(score.initialHands, `${label}[${index}].initialHands`);
    assertDdTableShape(score.ddTable, `${label}[${index}].ddTable`);
    if (!canonical.passedOut) {
      exactKeys(score.contract,
        ['level', 'suit', 'seat', 'doubled', 'redoubled', 'doublerSeat'],
        `${label}[${index}].contract`);
      assert.ok(Array.isArray(score.completedTricks), `${label}[${index}].completedTricks`);
      score.completedTricks.forEach((trick, trickIndex) => {
        exactKeys(trick, ['cards', 'winner'], `${label}[${index}].completedTricks[${trickIndex}]`);
        assert.equal(trick.cards.length, 4,
          `${label}[${index}].completedTricks[${trickIndex}].cards`);
        trick.cards.forEach((play, playIndex) => {
          exactKeys(play, ['seat', 'card'],
            `${label}[${index}].completedTricks[${trickIndex}].cards[${playIndex}]`);
          assertCardShape(play.card,
            `${label}[${index}].completedTricks[${trickIndex}].cards[${playIndex}].card`);
        });
      });
      if (score.claim !== null) {
        exactKeys(score.claim, ['claimer', 'tricksToWin', 'reason'], `${label}[${index}].claim`);
      }
    }
  });
}

function objectGraph(value, result = new Set()) {
  if (value === null || typeof value !== 'object' || result.has(value)) return result;
  result.add(value);
  for (const child of Object.values(value)) objectGraph(child, result);
  return result;
}

function assertNodePayloadsDetached(node, emissions) {
  const roomObjects = objectGraph(node.room);
  const priorPayloadObjects = new Set();
  emissions.forEach((emission, index) => {
    for (const object of objectGraph(emission.payload)) {
      assert.equal(roomObjects.has(object), false, `Node emission ${index} aliases room state`);
      assert.equal(priorPayloadObjects.has(object), false,
        `Node emission ${index} aliases another recipient payload`);
      priorPayloadObjects.add(object);
    }
  });
}

function expectedNodeGameEnd(state, viewerSeat, room) {
  const score = state.boardScores.at(-1);
  const boardScores = expectedNodeBoardScores(state, viewerSeat, room);
  if (score.passedOut) {
    return {
      passedOut: true,
      score: score.score,
      boardScores,
      ddTable: clone(state.ddTable),
      hands: clone(score.initialHands),
    };
  }
  return {
    passedOut: false,
    contract: clone(score.contract),
    declarer: score.declarer,
    dummy: score.dummy,
    declarerTricks: score.declarerTricks,
    needed: score.needed,
    score: score.score,
    made: score.made,
    diff: score.diff,
    vulnerability: score.vulnerability,
    boardScores,
    ddTable: clone(score.ddTable),
    hands: clone(score.initialHands),
  };
}

test('classic parity transcripts are fixed transport-neutral fixtures', () => {
  const fixtures = DOCUMENT;
  assert.equal(fixtures.schemaVersion, 1);
  assert.ok(Array.isArray(fixtures.transcripts));
  assert.ok(fixtures.transcripts.length >= 7);
  const coverage = new Set(fixtures.transcripts.flatMap(fixture => fixture.covers));
  for (const required of [
    'passed-out', 'doubled', 'redoubled', 'made', 'defeated', 'dummy-control',
    'maximum-legal-auction', '52-plays', 'next-deal',
  ]) assert.equal(coverage.has(required), true, required);
  for (const fixture of fixtures.transcripts) {
    assertTranscriptDeals(fixture.deals);
    assert.ok(fixture.commands.length > 0, fixture.id);
    for (const item of fixture.commands) {
      assert.equal(SEATS.includes(item.actor), true, fixture.id);
      assert.deepEqual(Object.keys(item.command).sort(), ['name', 'payload']);
      assert.deepEqual(Object.keys(item.expected).sort(), ['name', 'phase']);
    }
  }
  const nextDeal = fixtures.transcripts.find(fixture => fixture.id === 'next-deal');
  assert.notEqual(JSON.stringify(nextDeal.deals[0]), JSON.stringify(nextDeal.deals[1]));
});

test('transport expectations do not call production event or view composers', () => {
  const source = readFileSync(__filename, 'utf8');
  assert.equal(source.includes(['composeClassic', 'EventFrame'].join('')), false);
  assert.equal(source.includes(['classic', 'ViewFor'].join('')), false);
});

test('maximum auction independently contains 319 legal calls and terminates only last', () => {
  const fixture = DOCUMENT.transcripts.find(item => item.id === 'maximum-legal-auction');
  const calls = fixture.commands.slice(1);
  const actualCalls = calls.map(item => ({
    actor: item.actor, bid: item.command.payload.bid,
  }));
  assert.deepEqual(actualCalls, MAXIMUM_AUCTION_EXPECTED_CALLS);
  assertIndependentlyLegalAuction(actualCalls);
  assert.equal(calls.length, 319);
  assert.deepEqual(calls.slice(0, 3).map(item => item.command.payload.bid),
    ['Pass', 'Pass', 'Pass']);
  const contracts = [];
  for (let level = 1; level <= 7; level += 1) {
    for (const strain of ['C', 'D', 'H', 'S', 'NT']) contracts.push(`${level}${strain}`);
  }
  const expectedOpportunities = contracts.flatMap(contract => [contract, 'X', 'XX']);
  assert.deepEqual(
    calls.map(item => item.command.payload.bid).filter(call => call !== 'Pass'),
    expectedOpportunities,
  );
  const callTokens = calls.map(item => item.command.payload.bid);
  let previousOpportunity = 3;
  for (let index = 1; index < expectedOpportunities.length; index += 1) {
    const nextOpportunity = callTokens.indexOf(expectedOpportunities[index], previousOpportunity + 1);
    assert.equal(nextOpportunity - previousOpportunity - 1, 2);
    previousOpportunity = nextOpportunity;
  }
  assert.deepEqual(callTokens.slice(-3), ['Pass', 'Pass', 'Pass']);
});

test('maximum auction additionally executes every call through the shared core', () => {
  const fixture = DOCUMENT.transcripts.find(item => item.id === 'maximum-legal-auction');
  const calls = fixture.commands.slice(1);
  let state = createClassicLobbyState();
  const startCommand = { name: 'classic.start', payload: { expectedRevision: 0 } };
  const startContext = {
    actor: { role: 'OWNER', seat: 'N' }, occupiedSeats: [...SEATS],
    deal: { hands: fixture.deals[0], boardInfo: boardInfoFor(1) },
  };
  const started = applyClassicCommand(state, startCommand, startContext);
  assert.equal(started.ok, true);
  state = started.state;

  calls.forEach((item, index) => {
    const command = {
      name: item.command.name,
      payload: { expectedRevision: index + 1, ...item.command.payload },
    };
    const context = {
      actor: { role: item.actor === 'N' ? 'OWNER' : 'PLAYER', seat: item.actor },
      occupiedSeats: [...SEATS],
    };
    assert.equal(preflightClassicCommand(state, command, context).ok, true,
      `call ${index + 1}: ${item.actor} ${item.command.payload.bid}`);
    const result = applyClassicCommand(state, command, { ...context, deal: null });
    assert.equal(result.ok, true);
    assert.equal(result.state.phase, index === calls.length - 1 ? 'PLAYING' : 'BIDDING');
    state = result.state;
  });
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function selectCanonical(state) {
  const selected = {};
  for (const key of CLASSIC_STATE_KEYS) {
    assert.equal(Object.hasOwn(state, key), true, `missing canonical key ${key}`);
    selected[key] = clone(state[key]);
  }
  assert.deepEqual(Object.keys(selected), [...CLASSIC_STATE_KEYS]);
  validateClassicState(selected);
  return selected;
}

function assertCanonicalParity(label, pure, node, worker) {
  const selected = [pure, node, worker].map(selectCanonical);
  const bytes = selected.map(JSON.stringify);
  assert.equal(bytes[1], bytes[0], `${label}: Node canonical bytes diverged`);
  assert.equal(bytes[2], bytes[0], `${label}: Worker canonical bytes diverged`);
}

function assertCoverageOutcome(fixture, state) {
  const covers = new Set(fixture.covers);
  const score = state.boardScores.at(-1);
  if (covers.has('passed-out')) assert.equal(score.passedOut, true);
  if (covers.has('doubled')) assert.equal(score.contract.doubled, true);
  if (covers.has('redoubled')) assert.equal(score.contract.redoubled, true);
  if (covers.has('made')) assert.equal(score.made, true);
  if (covers.has('defeated')) assert.equal(score.made, false);
  if (covers.has('dummy-control')) {
    assert.equal(state.declarer, 'N');
    assert.equal(state.dummy, 'S');
    assert.deepEqual(state.currentTrick[1], { seat: 'S', card: { suit: 'D', rank: '2' } });
  }
  if (covers.has('52-plays')) {
    assert.equal(state.phase, 'SCORING');
    assert.equal(score.completedTricks.length, 13);
    assert.equal(SEATS.every(seat => state.hands[seat].length === 0), true);
  }
  if (covers.has('next-deal')) {
    assert.equal(fixture.deals.length, 2);
    assert.equal(state.dealNumber, 2);
    assert.equal(state.phase, 'BIDDING');
  }
}

function assertSecondDealIndexing(fixture, pure, node, worker) {
  if (fixture.id !== 'next-deal' || pure.dealNumber !== 2) return;
  for (const [label, state] of [
    ['pure', pure], ['Node', node], ['Worker', worker],
  ]) {
    assert.deepEqual(state.hands, fixture.deals[1], `${label} deal 2 hands`);
    assert.deepEqual(state.initialHands, fixture.deals[1], `${label} deal 2 initialHands`);
    assert.notEqual(JSON.stringify(state.hands), JSON.stringify(fixture.deals[0]),
      `${label} must index deals by dealNumber - 1`);
  }
}

function dealFor(fixture, dealNumber) {
  const hands = fixture.deals[dealNumber - 1];
  assert.ok(hands, `${fixture.id}: missing deal ${dealNumber}`);
  return { hands: clone(hands), boardInfo: boardInfoFor(dealNumber) };
}

function actorFor(seat) {
  return { role: seat === 'N' ? 'OWNER' : 'PLAYER', seat };
}

function expectedWorkerEvent(event, viewerSeat) {
  const payload = clone(event.payload);
  if (Object.hasOwn(payload, 'biddingHistory')) {
    payload.biddingHistory = expectedAuction(event.payload.biddingHistory, viewerSeat);
  }
  return payload;
}

function assertWorkerEventFrame(frame, event, revision, viewer, label) {
  exactKeys(frame, ['v', 'type', 'name', 'payload'], `${label} outer`);
  assert.equal(frame.v, 1);
  assert.equal(frame.type, 'event');
  assert.equal(frame.name, event.name);
  exactKeys(frame.payload, ['revision', 'event'], `${label} payload`);
  assert.equal(frame.payload.revision, revision);
  const eventKeys = event.name === 'classic.finished'
    ? (event.payload.reason === 'passed-out'
      ? ['reason', 'dealNumber', 'score']
      : ['reason', 'dealNumber', 'contract', 'declarer', 'nsTricks', 'ewTricks', 'score'])
    : WORKER_EVENT_KEYS[event.name];
  assert.ok(eventKeys, `${label} unknown event ${event.name}`);
  exactKeys(frame.payload.event, eventKeys, `${label} event`);
  assert.deepEqual(frame.payload.event, expectedWorkerEvent(event, viewer.seat));
  assertNoForbiddenTransportKeys(frame, label);
}

function expectedVisibleHands(state, viewer) {
  return Object.fromEntries(SEATS.map(seat => [seat,
    viewer.seat === seat || (state.dummyRevealed && state.dummy === seat)
      ? clone(state.hands[seat]) : null]));
}

function assertProjectedScores(scores, state, viewerSeat, label) {
  assert.equal(scores.length, state.boardScores.length, `${label} score count`);
  scores.forEach((score, index) => {
    const canonical = state.boardScores[index];
    const keys = canonical.passedOut
      ? ['dealNumber', 'boardNumber', 'score', 'passedOut', 'ddTable', 'biddingHistory']
      : [
        'dealNumber', 'boardNumber', 'passedOut', 'contract', 'declarer', 'dummy',
        'declarerTricks', 'needed', 'score', 'made', 'diff', 'vulnerability',
        'biddingHistory', 'completedTricks', 'ddTable', 'claim',
      ];
    exactKeys(score, keys, `${label} score ${index}`);
    assert.deepEqual(score.biddingHistory, expectedAuction(canonical.biddingHistory, viewerSeat));
    for (const key of keys.filter(key => key !== 'biddingHistory')) {
      assert.deepEqual(score[key], canonical[key], `${label} score ${index} ${key}`);
    }
  });
}

function assertWorkerSnapshot(snapshot, state, viewer, revision, playerNames, label) {
  exactKeys(snapshot, ROOM_SNAPSHOT_KEYS, `${label} room snapshot`);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.revision, revision);
  assert.equal(snapshot.status, 'ACTIVE');
  assert.deepEqual(snapshot.viewer, viewer);
  assert.deepEqual(snapshot.playerNames, playerNames);
  exactKeys(snapshot.classic, CLASSIC_VIEW_KEYS, `${label} classic view`);
  for (const key of [
    'schemaVersion', 'mode', 'phase', 'dealNumber', 'boardInfo', 'readyStatus',
    'currentBidder', 'currentContract', 'consecutivePasses', 'declarer', 'dummy',
    'leader', 'currentPlayer', 'currentTrick', 'nsTricks', 'ewTricks',
    'dummyRevealed', 'claimSettlement', 'ddTable', 'ddsStatus',
  ]) assert.deepEqual(snapshot.classic[key], state[key], `${label} ${key}`);
  assert.equal(snapshot.classic.completedCount, state.completedTricks.length);
  assert.deepEqual(snapshot.classic.biddingHistory,
    expectedAuction(state.biddingHistory, viewer.seat));
  assert.deepEqual(snapshot.classic.hands, expectedVisibleHands(state, viewer));
  assertProjectedScores(snapshot.classic.boardScores, state, viewer.seat, label);
  assertNoForbiddenTransportKeys(snapshot, label);
}

function createNodePath(fixture) {
  const emissions = [];
  const dds = [];
  const sockets = Object.fromEntries(SEATS.map(seat => [seat, `node-${fixture.id}-${seat}`]));
  const room = {
    id: `node-${fixture.id}`,
    ...createClassicLobbyState(),
    teachingMode: false,
    sockets,
    playerNames: { N: 'North', E: 'East', S: 'South', W: 'West' },
    ownerSocketId: sockets.N,
    classicRevision: 0,
    claimReq: null,
    viewReq: null,
  };
  const adapter = createClassicNodeAdapter({
    io: { to: target => ({ emit: (name, payload) => emissions.push({ target, name, payload }) }) },
    dealFactory: ({ dealNumber }) => dealFor(fixture, dealNumber),
    calcDDTable: hands => new Promise((resolve, reject) => {
      dds.push({ hands: clone(hands), resolve, reject });
    }),
    logger: { error() {} },
  });
  return { adapter, dds, emissions, room, sockets };
}

function invokeNode(node, item) {
  const request = {
    socketId: node.sockets[item.actor], seat: item.actor, ...clone(item.command.payload),
  };
  if (item.command.name === 'classic.start') return node.adapter.start(node.room, request);
  if (item.command.name === 'classic.bid') return node.adapter.bid(node.room, request);
  if (item.command.name === 'classic.play') return node.adapter.play(node.room, request);
  if (item.command.name === 'classic.ready-next') return node.adapter.readyNext(node.room, request);
  assert.fail(`unsupported Node transcript command ${item.command.name}`);
}

function expectedNodeDeliveryPlan(node, events, phase) {
  const auctionFinished = events.some(event => (
    event.name === 'classic.bidding-ended'
      || (event.name === 'classic.finished' && event.payload.reason === 'passed-out')
  ));
  const hasPlayedCard = events.some(event => event.name === 'classic.card-played');
  const playFinished = events.some(event => (
    event.name === 'classic.finished' && event.payload.reason !== 'passed-out'
  ));
  const plan = [];
  const players = name => SEATS.forEach(seat => plan.push({ name, target: node.sockets[seat] }));
  for (const event of events) {
    let name = null;
    if (event.name === 'classic.started') name = 'gameStart';
    else if (event.name === 'classic.bidding-updated' && !auctionFinished) name = 'biddingUpdate';
    else if (event.name === 'classic.bidding-ended') {
      players('biddingEnd');
      players('playUpdate');
      continue;
    } else if (event.name === 'classic.finished') name = 'gameEnd';
    else if (event.name === 'classic.dummy-revealed') name = 'dummyRevealed';
    else if (event.name === 'classic.card-played') name = 'cardPlayed';
    else if (event.name === 'classic.trick-ended') name = 'trickEnd';
    else if (event.name === 'classic.ready-updated') name = 'nextDealUpdate';
    else if (event.name === 'classic.dd-table-ready' && phase === 'SCORING') {
      plan.push({ name: 'ddTableReady', target: node.room.id });
      continue;
    }
    if (name) players(name);
  }
  if (hasPlayedCard && !playFinished) players('playUpdate');
  return plan;
}

function assertNodeTransport(node, state, coreEvents, emissions) {
  assert.deepEqual(emissions.map(({ name, target }) => ({ name, target })),
    expectedNodeDeliveryPlan(node, coreEvents, state.phase));
  assertNodePayloadsDetached(node, emissions);
  for (const emission of emissions) {
    const keys = emission.name === 'gameEnd'
      ? (emission.payload.passedOut
        ? ['passedOut', 'score', 'boardScores', 'ddTable', 'hands']
        : [
          'passedOut', 'contract', 'declarer', 'dummy', 'declarerTricks', 'needed',
          'score', 'made', 'diff', 'vulnerability', 'boardScores', 'ddTable', 'hands',
        ])
      : NODE_PAYLOAD_KEYS[emission.name];
    assert.ok(keys, `unknown Node event ${emission.name}`);
    exactKeys(emission.payload, keys, `Node ${emission.name}`);
    const seat = SEATS.find(candidate => node.sockets[candidate] === emission.target) || null;
    if (emission.name === 'gameStart') {
      assert.ok(seat);
      const expected = {
        hand: clone(state.hands[seat]),
        boardInfo: clone(state.boardInfo),
        seat,
        playerNames: clone(node.room.playerNames),
        boardScores: expectedNodeBoardScores(state, seat, node.room),
      };
      assert.deepEqual(emission.payload, expected);
      exactKeys(emission.payload.boardInfo, ['number', 'dealNumber', 'vul', 'dealer'],
        `Node gameStart ${seat} boardInfo`);
      exactKeys(emission.payload.playerNames, SEATS, `Node gameStart ${seat} playerNames`);
      assertHandsShape({ N: emission.payload.hand, E: [], S: [], W: [] },
        `Node gameStart ${seat} own hand`);
      assertLegacyReplayScores(emission.payload.boardScores, state, seat, node.room,
        `Node gameStart ${seat} boardScores`);
    } else if (emission.name === 'biddingUpdate') {
      assert.deepEqual(emission.payload.history,
        expectedAuction(state.biddingHistory, seat, { legacy: true }));
      assert.equal(emission.payload.currentBidder, state.currentBidder);
      assert.deepEqual(emission.payload.currentContract, state.currentContract);
      assert.equal(emission.payload.consecutivePasses, state.consecutivePasses);
    } else if (emission.name === 'biddingEnd') {
      assert.deepEqual(emission.payload.biddingHistory,
        expectedAuction(state.biddingHistory, seat, { legacy: true }));
      assert.deepEqual(emission.payload.contract, state.currentContract);
      for (const key of ['declarer', 'dummy', 'leader']) {
        assert.equal(emission.payload[key], state[key]);
      }
      assert.equal(emission.payload.declarerControlledBy, null);
    } else if (emission.name === 'playUpdate') {
      assert.equal(emission.payload.currentPlayer, state.currentPlayer);
      assert.deepEqual(emission.payload.currentTrick, state.currentTrick);
      assert.equal(emission.payload.completedCount, state.completedTricks.length);
      for (const key of ['nsTricks', 'ewTricks', 'dummyRevealed', 'dummy', 'declarer']) {
        assert.equal(emission.payload[key], state[key]);
      }
      assert.equal(emission.payload.declarerControlledBy, null);
      assert.equal(emission.payload.teachingCurrentSeat, null);
      assert.equal(emission.payload.teachingCurrentHand, null);
    } else if (emission.name === 'dummyRevealed') {
      assert.equal(emission.payload.dummy, state.dummy);
      assert.deepEqual(emission.payload.dummyHand, state.hands[state.dummy]);
    } else if (emission.name === 'cardPlayed') {
      const event = coreEvents.find(candidate => candidate.name === 'classic.card-played');
      assert.deepEqual(emission.payload, event.payload);
    } else if (emission.name === 'trickEnd') {
      const event = coreEvents.find(candidate => candidate.name === 'classic.trick-ended');
      assert.deepEqual(emission.payload, event.payload);
    } else if (emission.name === 'nextDealUpdate') {
      const event = coreEvents.find(candidate => candidate.name === 'classic.ready-updated');
      assert.deepEqual(emission.payload.readyStatus, event.payload.readyStatus);
      assert.deepEqual(emission.payload.playerNames, node.room.playerNames);
    } else if (emission.name === 'ddTableReady') {
      assert.equal(emission.target, node.room.id);
      assert.deepEqual(emission.payload.ddTable, state.ddTable);
    } else if (emission.name === 'gameEnd') {
      const score = state.boardScores.at(-1);
      assert.ok(seat);
      assert.deepEqual(emission.payload, expectedNodeGameEnd(state, seat, node.room));
      assertLegacyReplayScores(emission.payload.boardScores, state, seat, node.room,
        `Node gameEnd ${seat} boardScores`);
      assert.deepEqual(emission.payload.ddTable, score.ddTable);
      assertDdTableShape(emission.payload.ddTable, `Node gameEnd ${seat} ddTable`);
      assertHandsShape(emission.payload.hands, `Node gameEnd ${seat} hands`);
    }
    assert.equal(Object.hasOwn(emission.payload, 'initialHands'), false);
  }
}

function token() {
  return randomBytes(32).toString('base64url');
}

function workerCardPayload(payload) {
  const translated = clone(payload);
  if (translated.card) translated.card.rank = PUBLIC_RANKS[translated.card.rank];
  return translated;
}

async function waitFor(predicate, runtime, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await runtime.wait(10);
  }
  assert.fail(message);
}

async function post(runtime, route, body) {
  return runtime.request(route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function setupWorkerRoom(runtime, label, nextId) {
  const playerNames = Object.fromEntries(SEATS.map(seat => [seat, `${label}-${seat}`]));
  const ownerToken = token();
  const created = await post(runtime, '/api/rooms', {
    v: 1, requestId: nextId(`${label}-create`), displayName: playerNames.N,
    reconnectToken: ownerToken,
  });
  assert.equal(created.status, 200, created.text);
  const room = { ...created.body, reconnectToken: ownerToken };
  const sessions = [room];
  for (const seat of ['E', 'S', 'W']) {
    const reconnectToken = token();
    const joined = await post(runtime, `/api/rooms/${room.roomCode}/join`, {
      v: 1, requestId: nextId(`${label}-join-${seat}`), displayName: playerNames[seat],
      reconnectToken, requestedRole: 'player',
    });
    assert.equal(joined.status, 200, joined.text);
    sessions.push({ ...joined.body, reconnectToken });
  }
  const spectatorToken = token();
  const spectatorResponse = await post(runtime, `/api/rooms/${room.roomCode}/join`, {
    v: 1, requestId: nextId(`${label}-join-spectator`),
    displayName: `${label.slice(0, 24)}-watch`,
    reconnectToken: spectatorToken, requestedRole: 'spectator',
  });
  assert.equal(spectatorResponse.status, 200, spectatorResponse.text);
  sessions.push({ ...spectatorResponse.body, reconnectToken: spectatorToken });
  const bySeat = new Map();
  const recipients = [];
  for (const session of sessions) {
    const socket = await runtime.openWebSocket(
      `/api/rooms/${room.roomCode}/${room.incarnation}/ws`,
    );
    socket.send({
      v: 1, type: 'hello', id: nextId(`${label}-hello`),
      reconnectToken: session.reconnectToken, nextReconnectToken: token(),
    });
    const hello = JSON.parse(await socket.nextMessage());
    assert.equal(hello.type, 'hello-ok');
    const viewer = { role: session.role, seat: session.seat };
    const authenticated = { socket, session, viewer };
    recipients.push(authenticated);
    if (session.seat !== null) bySeat.set(session.seat, authenticated);
  }
  return { bySeat, playerNames, recipients, room };
}

async function inspectWorker(runtime, worker) {
  const response = await runtime.room('inspectRoom', {
    code: worker.room.roomCode, incarnation: worker.room.incarnation,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.value;
}

async function sendWorker(runtime, worker, item, nextId, coreResult) {
  const before = await inspectWorker(runtime, worker);
  const expectedRevision = before.roomState.revision;
  const frame = {
    v: 1, type: 'command', id: nextId(`${worker.room.roomCode}-command`),
    name: item.command.name,
    payload: { expectedRevision, ...workerCardPayload(item.command.payload) },
  };
  worker.bySeat.get(item.actor).socket.send(frame);
  let reply;
  try {
    reply = JSON.parse(await worker.bySeat.get(item.actor).socket.nextMessage());
  } catch (error) {
    const observed = await inspectWorker(runtime, worker);
    error.message = `reply missing; revision=${observed.roomState.revision} phase=${observed.classicState.phase}: ${error.message}`;
    throw error;
  }
  assert.equal(reply.type, 'reply', JSON.stringify(reply));
  assert.equal(reply.id, frame.id);
  assert.equal(reply.name, item.expected.name);
  const revision = reply.payload.revision;
  assert.equal(revision, expectedRevision + 1);
  exactKeys(reply, ['v', 'type', 'id', 'name', 'payload'], 'Worker reply outer');
  exactKeys(reply.payload, ['revision', 'snapshot'], 'Worker reply payload');
  assertWorkerSnapshot(reply.payload.snapshot, coreResult.state, actorFor(item.actor), revision,
    worker.playerNames, 'Worker command reply');
  assert.equal(reply.payload.snapshot.classic.phase, item.expected.phase);
  assertNoForbiddenTransportKeys(reply, 'Worker command reply');

  const framesByRecipient = [];
  for (const authenticated of worker.recipients) {
    const { viewer } = authenticated;
    const recipient = viewer.seat === null ? 'spectator' : viewer.seat;
    const frames = [];
    let observed;
    try {
      do {
        observed = JSON.parse(await authenticated.socket.nextMessage());
        frames.push(observed);
      } while (observed.name !== 'room.snapshot');
    } catch (error) {
      error.message = `recipient ${recipient} after ${JSON.stringify(frames.map(value => value.name))}: ${error.message}`;
      throw error;
    }
    framesByRecipient.push({ viewer, frames });
    assert.equal(frames.length, coreResult.events.length + 1);
    coreResult.events.forEach((event, index) => {
      assertWorkerEventFrame(frames[index], event, revision, viewer,
        `Worker ${recipient} event ${index}`);
    });
    const snapshotFrame = frames.at(-1);
    exactKeys(snapshotFrame, ['v', 'type', 'name', 'payload'], `Worker ${recipient} snapshot frame`);
    assert.equal(snapshotFrame.v, 1);
    assert.equal(snapshotFrame.type, 'event');
    assert.equal(snapshotFrame.name, 'room.snapshot');
    exactKeys(snapshotFrame.payload, ['revision', 'snapshot'], `Worker ${recipient} snapshot payload`);
    assert.equal(snapshotFrame.payload.revision, revision);
    assertWorkerSnapshot(snapshotFrame.payload.snapshot, coreResult.state, viewer, revision,
      worker.playerNames, `Worker ${recipient}`);
  }
  return { framesByRecipient, reply };
}

async function waitForNodeDds(node) {
  return waitFor(() => node.dds.length > 0 && node.dds[0], { wait: ms => new Promise(resolve => setTimeout(resolve, ms)) },
    'timed out waiting for paused Node DDS');
}

async function settleCheckpoint({ checkpoint, document, node, pureState, runtime, worker }) {
  const table = document.tables[checkpoint.table];
  assert.ok(table, checkpoint.name);
  assert.equal(pureState.ddsStatus, 'PENDING', checkpoint.name);
  const pureResult = applyClassicDdsCompletion(pureState, {
    dealNumber: pureState.dealNumber, ddTable: table, failed: false,
  });
  assert.equal(pureResult.ok, true);

  const nodeEmissionStart = node.emissions.length;
  const pausedNode = await waitForNodeDds(node);
  pausedNode.resolve(clone(table));
  node.dds.shift();
  await waitFor(() => node.room.ddsStatus === 'READY' && node.room,
    { wait: ms => new Promise(resolve => setTimeout(resolve, ms)) },
    'timed out waiting for Node DDS settlement');
  const nodeDdsEmissions = node.emissions.slice(nodeEmissionStart);
  assertNodeTransport(node, projectClassicState(node.room), pureResult.events, nodeDdsEmissions);

  const workerBefore = await inspectWorker(runtime, worker);
  await waitFor(async () => {
    const response = await runtime.room('inspectRoomClassicDds', {
      code: worker.room.roomCode, incarnation: worker.room.incarnation,
    });
    return response.status === 200 && response.body.value.paused.length > 0;
  }, runtime, 'timed out waiting for paused Worker DDS');
  const resolved = await runtime.room('resolveRoomClassicDds', {
    code: worker.room.roomCode, incarnation: worker.room.incarnation,
    result: 'success', table,
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  const settledWorker = await waitFor(async () => {
    const observed = await inspectWorker(runtime, worker);
    return observed.classicState.ddsStatus === 'READY' && observed;
  }, runtime, 'timed out waiting for Worker DDS settlement');

  const workerRevision = settledWorker.roomState.revision;
  assert.equal(workerRevision, workerBefore.roomState.revision + 1);
  for (const authenticated of worker.recipients) {
    const { viewer } = authenticated;
    const recipient = viewer.seat === null ? 'spectator' : viewer.seat;
    const event = JSON.parse(await authenticated.socket.nextMessage());
    const snapshot = JSON.parse(await authenticated.socket.nextMessage());
    assertWorkerEventFrame(event, pureResult.events[0], workerRevision, viewer,
      `Worker ${recipient} DDS`);
    exactKeys(snapshot, ['v', 'type', 'name', 'payload'], `Worker ${recipient} DDS snapshot frame`);
    assert.equal(snapshot.v, 1);
    assert.equal(snapshot.type, 'event');
    assert.equal(snapshot.name, 'room.snapshot');
    exactKeys(snapshot.payload, ['revision', 'snapshot'], `Worker ${recipient} DDS snapshot payload`);
    assert.equal(snapshot.payload.revision, workerRevision);
    assertWorkerSnapshot(snapshot.payload.snapshot, pureResult.state, viewer, workerRevision,
      worker.playerNames, `Worker ${recipient} DDS snapshot`);
  }
  assertCanonicalParity(`${checkpoint.name} DDS`, pureResult.state,
    projectClassicState(node.room), settledWorker.classicState);
  return pureResult.state;
}

test('fixed transcripts stay byte-identical across pure core, Node adapter, and real Durable Object',
  { timeout: 180_000 }, async () => {
    const { createRoomWorkerRuntime } = await import(
      '../workers/test/helpers/room-worker-runtime.mjs'
    );
    const runtime = await createRoomWorkerRuntime({
      vars: {
        CLASSIC_TEST_DEALS_JSON: JSON.stringify(DOCUMENT.transcripts[0].deals.concat(
          DOCUMENT.transcripts.find(item => item.id === 'next-deal').deals.slice(1),
        )),
        CLASSIC_TEST_DDS_PAUSE: 'true',
      },
    });
    let sequence = 0;
    const nodeGameEndKinds = new Set();
    const nextId = label => `parity_${label.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 40)}_${String(++sequence).padStart(8, '0')}`;
    try {
      for (const fixture of DOCUMENT.transcripts) {
        let pureState = createClassicLobbyState();
        let pureRevision = 0;
        const node = createNodePath(fixture);
        const worker = await setupWorkerRoom(runtime, `parity-${fixture.id}`, nextId);
        let consumed = 0;

        for (const item of fixture.commands) {
          const command = {
            name: item.command.name,
            payload: { expectedRevision: pureRevision, ...clone(item.command.payload) },
          };
          const context = { actor: actorFor(item.actor), occupiedSeats: [...SEATS] };
          const preflight = preflightClassicCommand(pureState, command, context);
          assert.equal(preflight.ok, true, `${fixture.id} item ${consumed + 1}`);
          const pureResult = applyClassicCommand(pureState, command, {
            ...context,
            deal: preflight.needsDeal ? dealFor(fixture, preflight.nextDealNumber) : null,
          });
          assert.equal(pureResult.ok, true);
          assert.deepEqual(pureResult.reply, item.expected);
          pureState = pureResult.state;
          pureRevision += 1;

          const emissionStart = node.emissions.length;
          const nodeResult = invokeNode(node, item);
          assert.deepEqual({ ok: nodeResult.ok, name: item.command.name, phase: nodeResult.phase },
            { ok: true, ...item.expected });
          assert.equal(nodeResult.revision, pureRevision);
          const commandEmissions = node.emissions.slice(emissionStart);
          assertNodeTransport(node, pureState, pureResult.events, commandEmissions);
          if (commandEmissions.some(emission => emission.name === 'gameEnd')) {
            const score = pureState.boardScores.at(-1);
            nodeGameEndKinds.add(score.passedOut ? 'passed-out' : score.made ? 'made' : 'defeated');
          }

          try {
            await sendWorker(runtime, worker, item, nextId, pureResult);
          } catch (error) {
            error.message = `${fixture.id} item ${consumed + 1} ${item.command.name}: ${error.message}`;
            throw error;
          }
          const workerObserved = await inspectWorker(runtime, worker);
          assertCanonicalParity(`${fixture.id} item ${consumed + 1}`, pureState,
            projectClassicState(node.room), workerObserved.classicState);
          assertSecondDealIndexing(fixture, pureState, projectClassicState(node.room),
            workerObserved.classicState);
          if (pureState.dealNumber > 0 && item.ddsCheckpoint === undefined
              && !fixture.commands.some(candidate => candidate.ddsCheckpoint)) {
            assert.equal(pureState.ddsStatus, 'PENDING');
          }
          consumed += 1;

          if (item.ddsCheckpoint) {
            pureState = await settleCheckpoint({
              checkpoint: item.ddsCheckpoint, document: DOCUMENT, node, pureState,
              runtime, worker,
            });
          }
        }
        assert.equal(consumed, fixture.commands.length, fixture.id);
        assertCoverageOutcome(fixture, pureState);
      }
      assert.deepEqual([...nodeGameEndKinds].sort(), ['defeated', 'made', 'passed-out']);
    } finally {
      await runtime.close();
    }
  });
