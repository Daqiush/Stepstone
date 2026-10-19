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
const { classicViewFor } = require('../classic/views.cjs');
const { assertTranscriptDeals } = require('./helpers/classic-fixtures.js');

const TRANSCRIPT_PATH = path.join(__dirname, 'fixtures', 'classic-transcripts.json');
const DOCUMENT = JSON.parse(readFileSync(TRANSCRIPT_PATH, 'utf8'));
const PUBLIC_RANKS = Object.freeze({
  2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
});

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
});

test('maximum auction contains exactly 319 legal calls and terminates only on the last call', () => {
  const fixture = DOCUMENT.transcripts.find(item => item.id === 'maximum-legal-auction');
  const calls = fixture.commands.slice(1);
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

function dealFor(fixture, dealNumber) {
  const hands = fixture.deals[dealNumber - 1];
  assert.ok(hands, `${fixture.id}: missing deal ${dealNumber}`);
  return { hands: clone(hands), boardInfo: boardInfoFor(dealNumber) };
}

function actorFor(seat) {
  return { role: seat === 'N' ? 'OWNER' : 'PLAYER', seat };
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

function expectedNodeEventNames(events, phase) {
  const auctionFinished = events.some(event => (
    event.name === 'classic.bidding-ended'
      || (event.name === 'classic.finished' && event.payload.reason === 'passed-out')
  ));
  const hasPlayedCard = events.some(event => event.name === 'classic.card-played');
  const playFinished = events.some(event => (
    event.name === 'classic.finished' && event.payload.reason !== 'passed-out'
  ));
  const names = [];
  for (const event of events) {
    let name = null;
    if (event.name === 'classic.started') name = 'gameStart';
    else if (event.name === 'classic.bidding-updated' && !auctionFinished) name = 'biddingUpdate';
    else if (event.name === 'classic.bidding-ended') {
      names.push(...Array(4).fill('biddingEnd'), ...Array(4).fill('playUpdate'));
      continue;
    } else if (event.name === 'classic.finished') name = 'gameEnd';
    else if (event.name === 'classic.dummy-revealed') name = 'dummyRevealed';
    else if (event.name === 'classic.card-played') name = 'cardPlayed';
    else if (event.name === 'classic.trick-ended') name = 'trickEnd';
    else if (event.name === 'classic.ready-updated') name = 'nextDealUpdate';
    else if (event.name === 'classic.dd-table-ready' && phase === 'SCORING') {
      names.push('ddTableReady');
      continue;
    }
    if (name) names.push(...Array(4).fill(name));
  }
  if (hasPlayedCard && !playFinished) names.push(...Array(4).fill('playUpdate'));
  return names;
}

function assertNodeTransport(node, state, coreEvents, emissions) {
  assert.deepEqual(emissions.map(emission => emission.name),
    expectedNodeEventNames(coreEvents, state.phase));
  for (const emission of emissions) {
    if (emission.name === 'gameStart') {
      const seat = SEATS.find(candidate => node.sockets[candidate] === emission.target);
      assert.ok(seat);
      assert.deepEqual(emission.payload.hand, state.hands[seat]);
      assert.equal(Object.hasOwn(emission.payload, 'hands'), false);
      assert.equal(Object.hasOwn(emission.payload, 'initialHands'), false);
    }
    if (state.phase !== 'SCORING') {
      assert.equal(Object.hasOwn(emission.payload, 'initialHands'), false);
      if (emission.name !== 'dummyRevealed') {
        assert.equal(Object.hasOwn(emission.payload, 'hands'), false);
      }
    }
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
  const ownerToken = token();
  const created = await post(runtime, '/api/rooms', {
    v: 1, requestId: nextId(`${label}-create`), displayName: `${label}-N`,
    reconnectToken: ownerToken,
  });
  assert.equal(created.status, 200, created.text);
  const room = { ...created.body, reconnectToken: ownerToken };
  const sessions = [room];
  for (const seat of ['E', 'S', 'W']) {
    const reconnectToken = token();
    const joined = await post(runtime, `/api/rooms/${room.roomCode}/join`, {
      v: 1, requestId: nextId(`${label}-join-${seat}`), displayName: `${label}-${seat}`,
      reconnectToken, requestedRole: 'player',
    });
    assert.equal(joined.status, 200, joined.text);
    sessions.push({ ...joined.body, reconnectToken });
  }
  const bySeat = new Map();
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
    bySeat.set(session.seat, { socket, session });
  }
  return { bySeat, room };
}

async function inspectWorker(runtime, worker) {
  const response = await runtime.room('inspectRoom', {
    code: worker.room.roomCode, incarnation: worker.room.incarnation,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.value;
}

async function sendWorker(runtime, worker, item, nextId, coreResult, composeClassicEventFrame) {
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
  assert.equal(reply.payload.snapshot.classic.phase, item.expected.phase);

  const framesBySeat = new Map();
  for (const [seat, authenticated] of worker.bySeat) {
    const frames = [];
    let observed;
    try {
      do {
        observed = JSON.parse(await authenticated.socket.nextMessage());
        frames.push(observed);
      } while (observed.name !== 'room.snapshot');
    } catch (error) {
      error.message = `seat ${seat} after ${JSON.stringify(frames.map(value => value.name))}: ${error.message}`;
      throw error;
    }
    framesBySeat.set(seat, frames);
    const viewer = actorFor(seat);
    const expectedEvents = coreResult.events.map(event => (
      composeClassicEventFrame(event, revision, viewer)
    ));
    assert.deepEqual(frames.slice(0, -1), expectedEvents);
    assert.deepEqual(frames.at(-1).payload.snapshot.classic,
      classicViewFor(coreResult.state, viewer));
    assert.equal(JSON.stringify(frames).includes('initialHands'), false);
  }
  return { framesBySeat, reply };
}

async function waitForNodeDds(node) {
  return waitFor(() => node.dds.length > 0 && node.dds[0], { wait: ms => new Promise(resolve => setTimeout(resolve, ms)) },
    'timed out waiting for paused Node DDS');
}

async function settleCheckpoint({ checkpoint, document, node, pureState, runtime, worker,
  composeClassicEventFrame }) {
  const table = document.tables[checkpoint.table];
  assert.ok(table, checkpoint.name);
  assert.equal(pureState.ddsStatus, 'PENDING', checkpoint.name);
  const pureResult = applyClassicDdsCompletion(pureState, {
    dealNumber: pureState.dealNumber, ddTable: table, failed: false,
  });
  assert.equal(pureResult.ok, true);

  const pausedNode = await waitForNodeDds(node);
  pausedNode.resolve(clone(table));
  node.dds.shift();
  await waitFor(() => node.room.ddsStatus === 'READY' && node.room,
    { wait: ms => new Promise(resolve => setTimeout(resolve, ms)) },
    'timed out waiting for Node DDS settlement');

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
  for (const [seat, authenticated] of worker.bySeat) {
    const event = JSON.parse(await authenticated.socket.nextMessage());
    const snapshot = JSON.parse(await authenticated.socket.nextMessage());
    const viewer = actorFor(seat);
    assert.deepEqual(event,
      composeClassicEventFrame(pureResult.events[0], workerRevision, viewer));
    assert.equal(snapshot.name, 'room.snapshot');
    assert.deepEqual(snapshot.payload.snapshot.classic,
      classicViewFor(pureResult.state, viewer));
    assert.equal(JSON.stringify(snapshot).includes('initialHands'), false);
  }
  assertCanonicalParity(`${checkpoint.name} DDS`, pureResult.state,
    projectClassicState(node.room), settledWorker.classicState);
  return pureResult.state;
}

test('fixed transcripts stay byte-identical across pure core, Node adapter, and real Durable Object',
  { timeout: 180_000 }, async () => {
    const [{ createRoomWorkerRuntime }, { composeClassicEventFrame }] = await Promise.all([
      import('../workers/test/helpers/room-worker-runtime.mjs'),
      import('../workers/src/room-foundation/room-view.mjs'),
    ]);
    const runtime = await createRoomWorkerRuntime({
      vars: {
        CLASSIC_TEST_DEALS_JSON: JSON.stringify(DOCUMENT.transcripts[0].deals.concat(
          DOCUMENT.transcripts.find(item => item.id === 'next-deal').deals.slice(1),
        )),
        CLASSIC_TEST_DDS_PAUSE: 'true',
      },
    });
    let sequence = 0;
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
          assertNodeTransport(node, pureState, pureResult.events,
            node.emissions.slice(emissionStart));

          try {
            await sendWorker(runtime, worker, item, nextId, pureResult,
              composeClassicEventFrame);
          } catch (error) {
            error.message = `${fixture.id} item ${consumed + 1} ${item.command.name}: ${error.message}`;
            throw error;
          }
          const workerObserved = await inspectWorker(runtime, worker);
          assertCanonicalParity(`${fixture.id} item ${consumed + 1}`, pureState,
            projectClassicState(node.room), workerObserved.classicState);
          if (pureState.dealNumber > 0 && item.ddsCheckpoint === undefined
              && !fixture.commands.some(candidate => candidate.ddsCheckpoint)) {
            assert.equal(pureState.ddsStatus, 'PENDING');
          }
          consumed += 1;

          if (item.ddsCheckpoint) {
            pureState = await settleCheckpoint({
              checkpoint: item.ddsCheckpoint, document: DOCUMENT, node, pureState,
              runtime, worker, composeClassicEventFrame,
            });
          }
        }
        assert.equal(consumed, fixture.commands.length, fixture.id);
        assertCoverageOutcome(fixture, pureState);
      }
    } finally {
      await runtime.close();
    }
  });
