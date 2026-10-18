import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import engineModule from '../../classic/engine.cjs';
import fixturesModule from '../../test/helpers/classic-fixtures.js';
import rulesModule from '../../classic/rules.cjs';
import stateModule from '../../classic/state.cjs';
import {
  createWorkerClassicDeal,
  createWorkerClassicDealFactory,
} from '../src/room-foundation/classic-deal.mjs';
import { applyWorkerClassicCommand } from '../src/room-foundation/classic-command.mjs';

const { applyClassicCommand } = engineModule;
const { orderedDeal } = fixturesModule;
const { boardInfoFor } = rulesModule;
const { ClassicInvariantError, createClassicLobbyState } = stateModule;
const SEATS = ['N', 'E', 'S', 'W'];
const INCARNATION = 7;

function zeroEntropy(counter = null) {
  return (values) => {
    if (counter) counter.calls += 1;
    values.fill(0);
    return values;
  };
}

function canonicalDeal(dealNumber = 1) {
  return { hands: orderedDeal(), boardInfo: boardInfoFor(dealNumber) };
}

function session(role, seat, suffix = seat ?? 'watch') {
  return {
    sessionId: `session_classic_${suffix}`,
    incarnation: INCARNATION,
    role,
    seat,
  };
}

function authorityMap(seats = SEATS, { spectator = false } = {}) {
  const map = new Map();
  for (const seat of seats) {
    const role = seat === 'N' ? 'OWNER' : 'PLAYER';
    const value = session(role, seat);
    map.set(value.sessionId, value);
  }
  if (spectator) {
    const value = session('SPECTATOR', null);
    map.set(value.sessionId, value);
  }
  return map;
}

function frame(name, payload) {
  return { v: 1, type: 'command', id: 'command_classic_1', name, payload };
}

function coreCommand(state, name, payload, actorSeat) {
  const role = actorSeat === 'N' ? 'OWNER' : 'PLAYER';
  const result = applyClassicCommand(state, { name, payload }, {
    actor: { role, seat: actorSeat },
    occupiedSeats: [...SEATS],
    deal: null,
  });
  assert.equal(result.ok, true);
  return result.state;
}

function passedOutState() {
  let state = applyClassicCommand(createClassicLobbyState(), {
    name: 'classic.start', payload: { expectedRevision: 0 },
  }, {
    actor: { role: 'OWNER', seat: 'N' }, occupiedSeats: [...SEATS], deal: canonicalDeal(),
  }).state;
  for (const seat of SEATS) {
    state = coreCommand(state, 'classic.bid', {
      expectedRevision: 0, bid: 'Pass', alert: false, explain: null,
    }, seat);
  }
  return state;
}

function playingState() {
  let state = applyClassicCommand(createClassicLobbyState(), {
    name: 'classic.start', payload: { expectedRevision: 0 },
  }, {
    actor: { role: 'OWNER', seat: 'N' }, occupiedSeats: [...SEATS], deal: canonicalDeal(),
  }).state;
  for (const [seat, bid] of [['N', '1NT'], ['E', 'Pass'], ['S', 'Pass'], ['W', 'Pass']]) {
    state = coreCommand(state, 'classic.bid', {
      expectedRevision: 0, bid, alert: false, explain: null,
    }, seat);
  }
  return state;
}

test('Web Crypto Fisher-Yates yields detached canonical 52-card deals', () => {
  const hands = createWorkerClassicDeal({ getRandomValues: zeroEntropy() });
  assert.deepEqual(Object.keys(hands), SEATS);
  assert.equal(new Set(SEATS.flatMap(seat => hands[seat].map(card => `${card.suit}${card.rank}`))).size, 52);
  for (const seat of SEATS) {
    assert.equal(hands[seat].length, 13);
    for (const card of hands[seat]) assert.deepEqual(Object.keys(card).sort(), ['rank', 'suit']);
  }
  const second = createWorkerClassicDeal({ getRandomValues: zeroEntropy() });
  hands.N[0].rank = 'A';
  assert.notDeepEqual(hands, second);
});

test('shuffle rejects uint32 values outside the largest unbiased range', () => {
  const values = [0xffff_ffff, ...Array(51).fill(0)];
  let calls = 0;
  const hands = createWorkerClassicDeal({
    getRandomValues(target) {
      calls += 1;
      target[0] = values.shift();
      return target;
    },
  });
  assert.equal(calls, 52);
  assert.equal(new Set(SEATS.flatMap(seat => hands[seat].map(card => `${card.suit}${card.rank}`))).size, 52);
});

test('deal factory derives boards, gates fixtures exactly, and parses them once', () => {
  let reads = 0;
  const fixtureText = JSON.stringify([orderedDeal(), orderedDeal()]);
  const env = { ROOM_FOUNDATION_TEST: 'true' };
  Object.defineProperty(env, 'CLASSIC_TEST_DEALS_JSON', {
    enumerable: true,
    get() { reads += 1; return fixtureText; },
  });
  const fixtureFactory = createWorkerClassicDealFactory({
    env,
    getRandomValues() { assert.fail('test fixtures must not use entropy'); },
  });
  assert.equal(reads, 1);
  const first = fixtureFactory({ dealNumber: 1 });
  const second = fixtureFactory({ dealNumber: 2 });
  assert.deepEqual(first.boardInfo, boardInfoFor(1));
  assert.deepEqual(second.boardInfo, boardInfoFor(2));
  first.hands.N[0].rank = 'A';
  assert.notDeepEqual(first.hands, fixtureFactory({ dealNumber: 1 }).hands);
  assert.throws(() => fixtureFactory({ dealNumber: 3 }), ClassicInvariantError);

  const production = createWorkerClassicDealFactory({
    env: { ROOM_FOUNDATION_TEST: 'TRUE', CLASSIC_TEST_DEALS_JSON: 'malformed' },
    getRandomValues: zeroEntropy(),
  });
  assert.deepEqual(production({ dealNumber: 1 }).boardInfo, boardInfoFor(1));
});

test('malformed trusted fixtures fail at construction and never fall back to entropy', () => {
  for (const CLASSIC_TEST_DEALS_JSON of [
    'not json',
    '{}',
    JSON.stringify([]),
    JSON.stringify([{ ...orderedDeal(), N: [] }]),
  ]) {
    let calls = 0;
    assert.throws(() => createWorkerClassicDealFactory({
      env: { ROOM_FOUNDATION_TEST: 'true', CLASSIC_TEST_DEALS_JSON },
      getRandomValues(values) { calls += 1; values.fill(0); return values; },
    }), ClassicInvariantError);
    assert.equal(calls, 0);
  }
});

test('trusted deal module imports no Node, process, or filesystem API', async () => {
  const source = await readFile(new URL('../src/room-foundation/classic-deal.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:node:|\bprocess\b|from\s+['"](?:fs|path|crypto)['"])/u);
});

test('adapter authorizes start and invokes entropy exactly once after preflight', () => {
  const authorities = authorityMap();
  let calls = 0;
  const result = applyWorkerClassicCommand({
    state: createClassicLobbyState(),
    command: frame('classic.start', { expectedRevision: 0 }),
    session: session('OWNER', 'N'),
    authorities,
    dealFactory({ dealNumber }) { calls += 1; return canonicalDeal(dealNumber); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.reply.name, 'classic.start');
  assert.equal(result.reply.phase, 'BIDDING');
  assert.equal(result.effects[0].type, 'classic.compute-dd-table');
  assert.equal(calls, 1);

  for (const [actor, seats, code] of [
    [session('PLAYER', 'E'), SEATS, 'CLASSIC_FORBIDDEN'],
    [session('SPECTATOR', null), SEATS, 'CLASSIC_FORBIDDEN'],
    [session('OWNER', 'N'), ['N', 'E', 'S'], 'CLASSIC_SEATS_INCOMPLETE'],
  ]) {
    calls = 0;
    const denied = applyWorkerClassicCommand({
      state: createClassicLobbyState(),
      command: frame('classic.start', { expectedRevision: 0 }),
      session: actor,
      authorities: authorityMap(seats, { spectator: actor.role === 'SPECTATOR' }),
      dealFactory() { calls += 1; return canonicalDeal(); },
    });
    assert.deepEqual(denied, { ok: false, code });
    assert.equal(calls, 0);
  }
});

test('adapter normalizes public integer ranks and preserves exact payload validation', () => {
  const state = playingState();
  const authorities = authorityMap();
  let calls = 0;
  for (const [rank, canonical] of [[10, 'T'], [11, 'J'], [12, 'Q'], [13, 'K'], [14, 'A']]) {
    const result = applyWorkerClassicCommand({
      state,
      command: frame('classic.play', { expectedRevision: 0, card: { suit: 'H', rank } }),
      session: session('PLAYER', 'E'),
      authorities,
      dealFactory() { calls += 1; return canonicalDeal(2); },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.events.find(event => event.name === 'classic.card-played').payload.card,
      { suit: 'H', rank: canonical });
  }
  assert.equal(calls, 0);

  for (const payload of [
    { expectedRevision: 0, card: { suit: 'H', rank: 15 } },
    { expectedRevision: 0, card: { suit: 'H', rank: 10, extra: true } },
    { expectedRevision: 0, card: { suit: 'H' } },
  ]) {
    assert.deepEqual(applyWorkerClassicCommand({
      state,
      command: frame('classic.play', payload),
      session: session('PLAYER', 'E'),
      authorities,
      dealFactory() { assert.fail('malformed play cannot request a deal'); },
    }), { ok: false, code: 'INVALID_COMMAND' });
  }
});

test('adapter preserves public domain codes and declarer dummy control', () => {
  const state = playingState();
  const authorities = authorityMap();
  assert.deepEqual(applyWorkerClassicCommand({
    state,
    command: frame('classic.play', { expectedRevision: 0, card: { suit: 'S', rank: 2 } }),
    session: session('PLAYER', 'S'),
    authorities,
    dealFactory() { assert.fail('illegal play cannot request a deal'); },
  }), { ok: false, code: 'CLASSIC_NOT_YOUR_TURN' });

  const afterLead = applyWorkerClassicCommand({
    state,
    command: frame('classic.play', { expectedRevision: 0, card: { suit: 'H', rank: 2 } }),
    session: session('PLAYER', 'E'),
    authorities,
    dealFactory() { assert.fail('play cannot request a deal'); },
  }).state;
  const dummyPlay = applyWorkerClassicCommand({
    state: afterLead,
    command: frame('classic.play', { expectedRevision: 0, card: { suit: 'D', rank: 2 } }),
    session: session('OWNER', 'N'),
    authorities,
    dealFactory() { assert.fail('play cannot request a deal'); },
  });
  assert.equal(dummyPlay.ok, true);
  assert.equal(dummyPlay.events[0].payload.seat, 'S');
});

test('ready-next requests a deal only after the fourth legal ready toggle', () => {
  let state = passedOutState();
  const authorities = authorityMap();
  let calls = 0;
  for (const seat of SEATS) {
    const result = applyWorkerClassicCommand({
      state,
      command: frame('classic.ready-next', { expectedRevision: 0 }),
      session: session(seat === 'N' ? 'OWNER' : 'PLAYER', seat),
      authorities,
      dealFactory({ dealNumber }) { calls += 1; return canonicalDeal(dealNumber); },
    });
    assert.equal(result.ok, true);
    state = result.state;
  }
  assert.equal(calls, 1);
  assert.equal(state.dealNumber, 2);
  assert.equal(state.phase, 'BIDDING');
});

test('adapter maps input, trusted, and unexpected failures without internal detail', () => {
  const authorities = authorityMap();
  for (const payload of [
    { expectedRevision: 0, bid: 1, alert: false, explain: null },
    { expectedRevision: 0, bid: 'garbage', alert: false, explain: null },
    { expectedRevision: 0, bid: 'Pass', alert: false, explain: null, extra: true },
    { expectedRevision: 0, bid: 'Pass', alert: false, explain: 'mismatch' },
  ]) {
    assert.deepEqual(applyWorkerClassicCommand({
      state: createClassicLobbyState(),
      command: frame('classic.bid', payload),
      session: session('OWNER', 'N'),
      authorities,
      dealFactory() { assert.fail('malformed command cannot request a deal'); },
    }), { ok: false, code: 'INVALID_COMMAND' });
  }

  const corrupted = { ...createClassicLobbyState(), phase: 'CORRUPTED' };
  assert.deepEqual(applyWorkerClassicCommand({
    state: corrupted,
    command: frame('classic.start', { expectedRevision: 0 }),
    session: session('OWNER', 'N'),
    authorities,
    dealFactory() { assert.fail('corrupted state cannot request a deal'); },
  }), { ok: false, code: 'SERVICE_CAPACITY' });

  assert.deepEqual(applyWorkerClassicCommand({
    state: createClassicLobbyState(),
    command: frame('classic.start', { expectedRevision: 0 }),
    session: session('OWNER', 'N'),
    authorities,
    dealFactory() { throw new Error('secret entropy detail'); },
  }), { ok: false, code: 'SERVICE_CAPACITY' });
});

test('wrong-phase commands never consume a trusted deal', () => {
  let calls = 0;
  assert.deepEqual(applyWorkerClassicCommand({
    state: playingState(),
    command: frame('classic.start', { expectedRevision: 0 }),
    session: session('OWNER', 'N'),
    authorities: authorityMap(),
    dealFactory() { calls += 1; return canonicalDeal(2); },
  }), { ok: false, code: 'CLASSIC_WRONG_PHASE' });
  assert.equal(calls, 0);
});
