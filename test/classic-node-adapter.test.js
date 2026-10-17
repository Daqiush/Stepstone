'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  CLASSIC_STATE_KEYS,
  ClassicInvariantError,
  createClassicLobbyState,
  createClassicDealState,
} = require('../classic/state.cjs');
const {
  ClassicInputError, applyClassicCommand,
} = require('../classic/engine.cjs');
const { boardInfoFor } = require('../classic/rules.cjs');
const { orderedDeal } = require('./helpers/classic-fixtures.js');
const { createClassicSocketFixture } = require('./helpers/classic-socket-fixture.js');
const {
  applyClassicState,
  createClassicNodeAdapter,
  emitClassicEvents,
  mapClassicNodeFailure,
  projectClassicState,
} = require('../classic/node-adapter.js');

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function adapterRoom(overrides = {}) {
  return {
    ...createClassicLobbyState(),
    id: '123',
    sockets: { N: { id: 'n' }, E: null, S: null, W: null },
    playerNames: { N: 'North', E: null, S: null, W: null },
    ownerSocketId: 'owner',
    claimReq: { votes: {} },
    viewReq: { votes: {} },
    lastClaim: { seat: 'N' },
    classicRevision: 7,
    sentinel: { untouched: true },
    ...overrides,
  };
}

test('projectClassicState returns only exact canonical keys without mutating a frozen room', () => {
  const room = deepFreeze(adapterRoom());
  const before = JSON.stringify(room);

  const projected = projectClassicState(room);

  assert.deepEqual(Object.keys(projected), [...CLASSIC_STATE_KEYS]);
  assert.deepEqual(projected, createClassicLobbyState());
  assert.equal(JSON.stringify(room), before);
  for (const key of [
    'id', 'sockets', 'playerNames', 'ownerSocketId', 'claimReq', 'viewReq', 'lastClaim',
    'classicRevision', 'sentinel',
  ]) {
    assert.equal(Object.hasOwn(projected, key), false);
  }
});

test('projectClassicState deeply detaches all canonical arrays and objects', () => {
  const room = adapterRoom();

  const projected = projectClassicState(room);

  assert.notEqual(projected.hands, room.hands);
  assert.notEqual(projected.hands.N, room.hands.N);
  assert.notEqual(projected.readyStatus, room.readyStatus);
  assert.notEqual(projected.biddingHistory, room.biddingHistory);
  assert.notEqual(projected.currentTrick, room.currentTrick);
  assert.notEqual(projected.completedTricks, room.completedTricks);
  assert.notEqual(projected.boardScores, room.boardScores);
  projected.hands.N.push({ suit: 'S', rank: 'A' });
  assert.deepEqual(room.hands.N, []);
});

test('applyClassicState updates every canonical key while preserving every adapter reference', () => {
  const room = adapterRoom();
  const adapterReferences = Object.fromEntries([
    'sockets', 'playerNames', 'claimReq', 'viewReq', 'lastClaim', 'sentinel',
  ].map(key => [key, room[key]]));
  const proposed = deepFreeze(createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(),
    boardInfo: boardInfoFor(1),
  }));

  applyClassicState(room, proposed);

  assert.deepEqual(projectClassicState(room), proposed);
  for (const key of CLASSIC_STATE_KEYS) {
    if (proposed[key] && typeof proposed[key] === 'object') assert.notEqual(room[key], proposed[key]);
  }
  for (const [key, reference] of Object.entries(adapterReferences)) {
    assert.equal(room[key], reference);
  }
  assert.equal(room.ownerSocketId, 'owner');
  assert.equal(room.classicRevision, 7);
});

test('applyClassicState validates and clones fully before assigning any room field', () => {
  const room = adapterRoom();
  const references = Object.fromEntries(Reflect.ownKeys(room).map(key => [key, room[key]]));
  const before = JSON.stringify(room);
  const invalid = { ...createClassicLobbyState(), phase: 'BROKEN' };

  assert.throws(() => applyClassicState(room, invalid));

  assert.equal(JSON.stringify(room), before);
  for (const key of Reflect.ownKeys(room)) assert.equal(room[key], references[key]);
});

function errorHarness() {
  const emissions = [];
  const logs = [];
  return {
    emissions,
    logs,
    io: { to: target => ({ emit: (name, payload) => emissions.push({ target, name, payload }) }) },
    logger: { error: (message, metadata) => logs.push({ message, metadata }) },
  };
}

function mapFailure({ method, failure, bid = null, seat = 'N', roomOverrides = {} }) {
  const harness = errorHarness();
  const room = adapterRoom({ classicRevision: 11, ...roomOverrides });
  const result = mapClassicNodeFailure({
    io: harness.io,
    logger: harness.logger,
    room,
    socketId: 'requester',
    method,
    seat,
    bid,
    failure,
  });
  assert.equal(room.classicRevision, 11);
  return { ...harness, result };
}

test('mapClassicNodeFailure maps every public domain code to the exact legacy message policy', () => {
  const cases = [
    ['start', 'CLASSIC_SEATS_INCOMPLETE', '需要4名玩家全部就座后才能开始'],
    ['start', 'CLASSIC_FORBIDDEN', '只有房主可以开始游戏'],
    ['bid', 'CLASSIC_FORBIDDEN', '还没到你叫牌'],
    ['play', 'CLASSIC_FORBIDDEN', '还没到你出牌'],
    ['settleClaim', 'CLASSIC_FORBIDDEN', '无法确定声称座位'],
    ['bid', 'CLASSIC_NOT_YOUR_TURN', '还没到你叫牌'],
    ['play', 'CLASSIC_NOT_YOUR_TURN', '还没到你出牌'],
    ['play', 'CLASSIC_CARD_NOT_HELD', '该牌不在你手中'],
    ['play', 'CLASSIC_MUST_FOLLOW_SUIT', '必须跟出同花色'],
  ];
  for (const [method, code, msg] of cases) {
    const { result, emissions, logs } = mapFailure({ method, failure: { ok: false, code } });
    assert.deepEqual(result, { ok: false, code });
    assert.deepEqual(emissions, [{
      target: 'requester', name: 'appError', payload: { msg },
    }]);
    assert.deepEqual(logs, []);
  }
});

test('mapClassicNodeFailure keeps wrong-phase and method-specific forbidden rejections silent', () => {
  for (const [method, code] of [
    ['start', 'CLASSIC_WRONG_PHASE'],
    ['readyNext', 'CLASSIC_FORBIDDEN'],
    ['editBidAnnotation', 'CLASSIC_FORBIDDEN'],
    ['appendBidQuestion', 'CLASSIC_FORBIDDEN'],
    ['answerBidQuestion', 'CLASSIC_FORBIDDEN'],
    ['clearReadyForDisconnect', 'CLASSIC_FORBIDDEN'],
  ]) {
    const { result, emissions, logs } = mapFailure({ method, failure: { ok: false, code } });
    assert.deepEqual(result, { ok: false, code });
    assert.deepEqual(emissions, []);
    assert.deepEqual(logs, []);
  }
});

test('mapClassicNodeFailure derives every invalid-bid legacy message from attempted bid and contract', () => {
  const contract = (overrides = {}) => ({
    level: 1, suit: 'H', seat: 'N', doubled: false, redoubled: false, doublerSeat: null,
    ...overrides,
  });
  const cases = [
    ['X', 'E', null, '没有可加倍的定约'],
    ['X', 'S', contract(), '不能加倍己方定约'],
    ['X', 'W', contract({ doubled: true, doublerSeat: 'E' }), '定约已被加倍'],
    ['XX', 'N', contract(), '定约未被加倍'],
    ['XX', 'N', contract({ doubled: true, redoubled: true, doublerSeat: 'N' }), '定约已被再加倍'],
    ['XX', 'E', contract({ doubled: true, doublerSeat: 'E' }), '不能再加倍己方的加倍'],
    ['1C', 'E', contract(), '叫品必须高于当前定约'],
  ];
  for (const [bid, seat, currentContract, msg] of cases) {
    const { result, emissions } = mapFailure({
      method: 'bid', bid, seat,
      roomOverrides: { currentContract },
      failure: { ok: false, code: 'CLASSIC_INVALID_BID' },
    });
    assert.deepEqual(result, { ok: false, code: 'CLASSIC_INVALID_BID' });
    assert.deepEqual(emissions, [{
      target: 'requester', name: 'appError', payload: { msg },
    }]);
  }
});

test('mapClassicNodeFailure hides input, invariant, and unexpected exception details', () => {
  const cases = [
    [new ClassicInputError('secret input detail'), 'CLASSIC_INPUT_INVALID', '请求格式无效', false],
    [new ClassicInvariantError('secret invariant detail'), 'CLASSIC_SERVER_ERROR', '服务器暂时无法处理，请稍后重试', true],
    [new Error('secret unexpected detail'), 'CLASSIC_SERVER_ERROR', '服务器暂时无法处理，请稍后重试', true],
    [{ ok: false, code: 'CLASSIC_INVALID_DEAL_CONTEXT' }, 'CLASSIC_SERVER_ERROR', '服务器暂时无法处理，请稍后重试', true],
  ];
  for (const [failure, code, msg, shouldLog] of cases) {
    const { result, emissions, logs } = mapFailure({ method: 'start', failure });
    assert.deepEqual(result, { ok: false, code });
    assert.deepEqual(emissions, [{
      target: 'requester', name: 'appError', payload: { msg },
    }]);
    assert.equal(logs.length, shouldLog ? 1 : 0);
    assert.equal(JSON.stringify(emissions).includes('secret'), false);
    if (shouldLog) {
      assert.equal(logs[0].message, 'Classic Node adapter command failed');
      assert.equal(logs[0].metadata.method, 'start');
      assert.equal(logs[0].metadata.roomId, '123');
      if (failure instanceof Error) assert.equal(logs[0].metadata.errorMessage, failure.message);
    }
  }
});

test('mapClassicNodeFailure remains stable when logger or transport failure handling throws', () => {
  const cases = [
    {
      io: { to() { throw new Error('io.to failed'); } },
      logger: { error() {} },
      failure: { ok: false, code: 'CLASSIC_CARD_NOT_HELD' },
      expected: { ok: false, code: 'CLASSIC_CARD_NOT_HELD' },
    },
    {
      io: { to: () => ({ emit() { throw new Error('emit failed'); } }) },
      logger: { error() {} },
      failure: new ClassicInputError('invalid request'),
      expected: { ok: false, code: 'CLASSIC_INPUT_INVALID' },
    },
    {
      io: { to: () => ({ emit() {} }) },
      logger: { error() { throw new Error('logger failed'); } },
      failure: new ClassicInvariantError('trusted state failed'),
      expected: { ok: false, code: 'CLASSIC_SERVER_ERROR' },
    },
    {
      io: { to: () => ({ emit() { throw new Error('emit failed'); } }) },
      logger: { error() { throw new Error('logger failed'); } },
      failure: new ClassicInvariantError('trusted state failed'),
      expected: { ok: false, code: 'CLASSIC_SERVER_ERROR' },
    },
  ];
  for (const { io, logger, failure, expected } of cases) {
    const room = adapterRoom({ classicRevision: 23 });
    assert.doesNotThrow(() => {
      assert.deepEqual(mapClassicNodeFailure({
        io,
        logger,
        room,
        socketId: 'requester',
        method: 'play',
        seat: 'N',
        bid: null,
        failure,
      }), expected);
    });
    assert.equal(room.classicRevision, 23);
  }
});

function createAdapter() {
  return createClassicNodeAdapter({
    io: { to: () => ({ emit() {} }) },
    dealFactory: () => { throw new Error('not used by Task 6'); },
    calcDDTable: async () => { throw new Error('not used by Task 6'); },
    logger: { error() {} },
  });
}

function legacyNewRoom(overrides = {}) {
  return {
    id: '456',
    mode: 'classic',
    teachingMode: false,
    dealNumber: 91,
    phase: 'LEGACY_PHASE',
    hands: { legacy: true },
    initialHands: { legacy: true },
    sockets: { N: null, E: null, S: null, W: null },
    playerNames: { N: null, E: null, S: null, W: null },
    ownerSocketId: 'owner',
    claimReq: { retained: true },
    viewReq: { retained: true },
    sentinel: { retained: true },
    classicRevision: 99,
    ...overrides,
  };
}

test('createClassicNodeAdapter rejects missing boundary dependencies', () => {
  const valid = {
    io: { to: () => ({ emit() {} }) },
    dealFactory() {},
    async calcDDTable() {},
    logger: { error() {} },
  };
  const adapter = createClassicNodeAdapter(valid);
  assert.deepEqual(Object.keys(adapter), ['initializeRoom', 'start', 'bid']);
  for (const key of Object.keys(valid)) {
    assert.throws(
      () => createClassicNodeAdapter({ ...valid, [key]: null }),
      error => error instanceof TypeError && error.message === `invalid classic Node adapter ${key}`,
    );
  }
  assert.throws(
    () => createClassicNodeAdapter({ ...valid, io: { to() { return {}; } } }),
    error => error instanceof TypeError
      && error.message === 'invalid classic Node adapter io.to().emit',
  );
});

test('initializeRoom applies a fresh exact lobby plus revision zero only to standard classic rooms', () => {
  const adapter = createAdapter();
  const first = legacyNewRoom();
  const second = legacyNewRoom({ id: '457' });
  const retained = Object.fromEntries([
    'sockets', 'playerNames', 'claimReq', 'viewReq', 'sentinel',
  ].map(key => [key, first[key]]));

  adapter.initializeRoom(first);
  adapter.initializeRoom(second);

  assert.deepEqual(projectClassicState(first), createClassicLobbyState());
  assert.deepEqual(projectClassicState(second), createClassicLobbyState());
  assert.equal(first.classicRevision, 0);
  assert.equal(second.classicRevision, 0);
  for (const [key, reference] of Object.entries(retained)) assert.equal(first[key], reference);
  assert.notEqual(first.hands, second.hands);
  assert.notEqual(first.hands.N, second.hands.N);
  assert.notEqual(first.readyStatus, second.readyStatus);
});

test('initializeRoom leaves teaching, ultimate, problem, and complex rooms byte- and reference-equal', () => {
  const adapter = createAdapter();
  const variants = [
    legacyNewRoom({ teachingMode: true }),
    legacyNewRoom({ mode: 'ult' }),
    legacyNewRoom({ mode: 'problem', phase: 'PROB_SELECT' }),
    legacyNewRoom({ mode: 'complex', complexSides: { NS: null, EW: null } }),
  ];
  for (const room of variants) {
    const before = JSON.stringify(room);
    const references = Object.fromEntries(Reflect.ownKeys(room).map(key => [key, room[key]]));

    adapter.initializeRoom(room);

    assert.equal(JSON.stringify(room), before);
    for (const key of Reflect.ownKeys(room)) assert.equal(room[key], references[key]);
  }
});

test('initializeRoom never resets an already-canonical standard classic room', () => {
  const adapter = createAdapter();
  const active = adapterRoom(createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(),
    boardInfo: boardInfoFor(1),
  }));
  const before = JSON.stringify(active);
  const references = Object.fromEntries(Reflect.ownKeys(active).map(key => [key, active[key]]));

  adapter.initializeRoom(active);

  assert.equal(JSON.stringify(active), before);
  for (const key of Reflect.ownKeys(active)) assert.equal(active[key], references[key]);
});

test('server creation seam initializes only standard classic and is safe to require without listening', () => {
  const serverPath = require.resolve('../server.js');
  delete require.cache[serverPath];
  const originalListen = http.Server.prototype.listen;
  const originalLog = console.log;
  const originalError = console.error;
  let listenCalls = 0;
  let serverApi;
  http.Server.prototype.listen = function interceptedListen() {
    listenCalls += 1;
    return this;
  };
  console.log = () => {};
  console.error = () => {};
  try {
    serverApi = require(serverPath);
  } finally {
    http.Server.prototype.listen = originalListen;
    console.log = originalLog;
    console.error = originalError;
  }

  try {
    assert.equal(listenCalls, 0);
    const { configureNewRoom, makeRoom, roomState } = serverApi;
    const standard = makeRoom('100');
    configureNewRoom(standard, 'classic');
    assert.deepEqual(
      Object.fromEntries(CLASSIC_STATE_KEYS.map(key => [key, standard[key]])),
      createClassicLobbyState(),
    );
    assert.equal(standard.classicRevision, 0);
    assert.equal(Object.hasOwn(roomState(standard), 'classicRevision'), false);
    assert.equal(Object.hasOwn(roomState(standard), 'schemaVersion'), false);

    const variants = [
      ['teaching', { mode: 'classic', teachingMode: true, phase: 'LOBBY' }],
      ['ult', { mode: 'ult', teachingMode: false, phase: 'LOBBY' }],
      ['problem', { mode: 'problem', teachingMode: false, phase: 'PROB_SELECT' }],
      ['complex', { mode: 'complex', teachingMode: false, phase: 'LOBBY' }],
    ];
    for (const [requestedMode, expected] of variants) {
      const room = makeRoom(requestedMode);
      const legacyHands = room.hands;
      const legacyDealNumber = room.dealNumber;
      configureNewRoom(room, requestedMode);
      assert.equal(room.mode, expected.mode);
      assert.equal(room.teachingMode, expected.teachingMode);
      assert.equal(room.phase, expected.phase);
      assert.equal(room.hands, legacyHands);
      assert.equal(room.dealNumber, legacyDealNumber);
      assert.equal(Object.hasOwn(room, 'schemaVersion'), false);
    }
  } finally {
    delete require.cache[serverPath];
  }
});

function canonicalAdapterRoom(overrides = {}) {
  const fixture = createClassicSocketFixture();
  return {
    fixture,
    room: adapterRoom({
      id: 'classic-room',
      sockets: fixture.roomSockets,
      playerNames: { N: 'North', E: 'East', S: 'South', W: 'West' },
      ownerSocketId: fixture.socketIds.N,
      classicRevision: 0,
      ...overrides,
    }),
  };
}

function legacyHistory(history) {
  return history.map(entry => ({
    ...entry,
    bid: entry.bid === 'X' ? 'Double' : entry.bid === 'XX' ? 'Redouble' : entry.bid,
  }));
}

function fullEntry(seat, bid, alert = null, explain = null) {
  return { seat, bid, alert, explain, qa: [] };
}

test('classic event mapping sends private gameStart frames before independently filtered bidding frames', () => {
  const { fixture, room } = canonicalAdapterRoom();
  const dealt = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(1),
  });
  const first = applyClassicCommand(dealt, {
    name: 'classic.bid',
    payload: { expectedRevision: 0, bid: '1H', alert: true, explain: 'five hearts' },
  }, {
    actor: { role: 'OWNER', seat: 'N' }, occupiedSeats: ['N', 'E', 'S', 'W'], deal: null,
  });
  const second = applyClassicCommand(first.state, {
    name: 'classic.bid',
    payload: { expectedRevision: 0, bid: 'X', alert: true, explain: 'takeout' },
  }, {
    actor: { role: 'PLAYER', seat: 'E' }, occupiedSeats: ['N', 'E', 'S', 'W'], deal: null,
  });
  applyClassicState(room, second.state);

  emitClassicEvents(fixture.io, room, [
    { name: 'classic.started', payload: { dealNumber: 1, boardInfo: boardInfoFor(1) } },
    second.events[0],
  ]);

  assert.deepEqual(fixture.emissions.map(({ target, name }) => ({ target, name })), [
    ...['N', 'E', 'S', 'W'].map(seat => ({ target: fixture.socketIds[seat], name: 'gameStart' })),
    ...['N', 'E', 'S', 'W'].map(seat => ({ target: fixture.socketIds[seat], name: 'biddingUpdate' })),
  ]);
  for (const seat of ['N', 'E', 'S', 'W']) {
    const start = fixture.forTarget(fixture.socketIds[seat])[0].payload;
    assert.deepEqual(Object.keys(start), ['hand', 'boardInfo', 'seat', 'playerNames', 'boardScores']);
    assert.deepEqual(start.hand, room.hands[seat]);
    assert.notEqual(start.hand, room.hands[seat]);
    assert.equal(start.seat, seat);
    assert.deepEqual(start.boardInfo, boardInfoFor(1));
    assert.deepEqual(start.playerNames, room.playerNames);
    assert.deepEqual(start.boardScores, []);
    assert.equal(JSON.stringify(start).includes('initialHands'), false);
  }

  const north = fixture.forTarget(fixture.socketIds.N)[1].payload;
  const south = fixture.forTarget(fixture.socketIds.S)[1].payload;
  const west = fixture.forTarget(fixture.socketIds.W)[1].payload;
  for (const payload of [north, south, west]) {
    assert.deepEqual(Object.keys(payload), [
      'history', 'currentBidder', 'currentContract', 'consecutivePasses',
    ]);
    assert.equal(payload.currentBidder, 'S');
    assert.equal(payload.currentContract.doubled, true);
    assert.equal(payload.consecutivePasses, 0);
  }
  assert.deepEqual(north.history, legacyHistory(second.state.biddingHistory));
  assert.deepEqual(south.history, [
    { seat: 'N', bid: '1H' },
    legacyHistory(second.state.biddingHistory)[1],
  ]);
  assert.deepEqual(west.history, [
    legacyHistory(second.state.biddingHistory)[0],
    { seat: 'E', bid: 'Double' },
  ]);
  assert.notEqual(north, south);
  assert.notEqual(north.history, south.history);
  north.history[0].explain = 'mutated';
  assert.equal(south.history[0].explain, undefined);
  assert.equal(room.biddingHistory[0].explain, 'five hearts');
});

function adapterHarness({ dealFactory, calcDDTable } = {}) {
  const base = canonicalAdapterRoom();
  const dealCalls = [];
  const ddsCalls = [];
  const logs = [];
  const adapter = createClassicNodeAdapter({
    io: base.fixture.io,
    dealFactory: dealFactory || (({ dealNumber }) => {
      dealCalls.push({ dealNumber });
      return { hands: orderedDeal(), boardInfo: boardInfoFor(dealNumber) };
    }),
    calcDDTable: calcDDTable || (async hands => {
      ddsCalls.push(hands);
      return Array.from({ length: 5 }, () => [7, 7, 7, 7]);
    }),
    logger: { error: (message, metadata) => logs.push({ message, metadata }) },
  });
  return { ...base, adapter, dealCalls, ddsCalls, logs };
}

async function flushAsyncEffects() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

test('adapter start preflights authorization and occupancy before one deal and launches DDS after apply', async () => {
  let observedPhase = null;
  let observedDeal = null;
  const h = adapterHarness({
    calcDDTable: async hands => {
      observedPhase = h.room.phase;
      observedDeal = h.room.dealNumber;
      assert.notEqual(hands, h.room.initialHands);
      return Array.from({ length: 5 }, () => [6, 7, 8, 9]);
    },
  });

  const result = h.adapter.start(h.room, {
    socketId: h.fixture.socketIds.N, seat: 'N',
  });

  assert.deepEqual(result, { ok: true, phase: 'BIDDING', revision: 1 });
  assert.deepEqual(h.dealCalls, [{ dealNumber: 1 }]);
  assert.equal(h.room.phase, 'BIDDING');
  assert.equal(h.room.dealNumber, 1);
  assert.equal(h.room.classicRevision, 1);
  assert.deepEqual(h.fixture.emissions.map(({ name }) => name), [
    'gameStart', 'gameStart', 'gameStart', 'gameStart',
    'biddingUpdate', 'biddingUpdate', 'biddingUpdate', 'biddingUpdate',
  ]);
  assert.equal(observedPhase, null);
  await flushAsyncEffects();
  assert.equal(observedPhase, 'BIDDING');
  assert.equal(observedDeal, 1);
  assert.equal(h.room.ddsStatus, 'READY');
  assert.deepEqual(h.room.ddTable, Array.from({ length: 5 }, () => [6, 7, 8, 9]));
  assert.equal(h.room.classicRevision, 1);
});

test('adapter start rejects owner, phase, and seat preconditions without consuming randomness', () => {
  const cases = [
    {
      mutate(h) { h.room.ownerSocketId = h.fixture.socketIds.E; },
      request(h) { return { socketId: h.fixture.socketIds.N, seat: 'N' }; },
      expected: { ok: false, code: 'CLASSIC_FORBIDDEN' },
      message: '只有房主可以开始游戏',
    },
    {
      mutate(h) { h.room.sockets.W = null; },
      request(h) { return { socketId: h.fixture.socketIds.N, seat: 'N' }; },
      expected: { ok: false, code: 'CLASSIC_SEATS_INCOMPLETE' },
      message: '需要4名玩家全部就座后才能开始',
    },
    {
      mutate(h) {
        applyClassicState(h.room, createClassicDealState(createClassicLobbyState(), {
          hands: orderedDeal(), boardInfo: boardInfoFor(1),
        }));
      },
      request(h) { return { socketId: h.fixture.socketIds.N, seat: 'N' }; },
      expected: { ok: false, code: 'CLASSIC_WRONG_PHASE' },
      message: null,
    },
  ];
  for (const entry of cases) {
    const h = adapterHarness();
    entry.mutate(h);
    const result = h.adapter.start(h.room, entry.request(h));
    assert.deepEqual(result, entry.expected);
    assert.deepEqual(h.dealCalls, []);
    assert.equal(h.room.classicRevision, 0);
    assert.deepEqual(h.fixture.named('appError').map(event => event.payload.msg),
      entry.message === null ? [] : [entry.message]);
  }
});

test('DDS rejection and late settlement are contained, re-project current room state, and never bump revision', async () => {
  let rejectDds;
  const pending = new Promise((resolve, reject) => { rejectDds = reject; });
  const h = adapterHarness({ calcDDTable: () => pending });
  assert.deepEqual(h.adapter.start(h.room, {
    socketId: h.fixture.socketIds.N, seat: 'N',
  }), { ok: true, phase: 'BIDDING', revision: 1 });
  h.room.biddingHistory = [fullEntry('N', 'Pass')];
  h.room.currentBidder = 'E';
  h.room.consecutivePasses = 1;
  rejectDds(new Error('native DDS failed'));
  await flushAsyncEffects();
  assert.equal(h.room.ddsStatus, 'FAILED');
  assert.equal(h.room.biddingHistory.length, 1);
  assert.equal(h.room.classicRevision, 1);
  assert.equal(h.logs.some(log => JSON.stringify(log).includes('native DDS failed')), true);

  let resolveLate;
  const late = new Promise(resolve => { resolveLate = resolve; });
  const lateHarness = adapterHarness({ calcDDTable: () => late });
  lateHarness.adapter.start(lateHarness.room, {
    socketId: lateHarness.fixture.socketIds.N, seat: 'N',
  });
  lateHarness.room.ddsStatus = 'FAILED';
  resolveLate(Array.from({ length: 5 }, () => [1, 2, 3, 4]));
  await flushAsyncEffects();
  assert.equal(lateHarness.room.ddsStatus, 'FAILED');
  assert.equal(lateHarness.room.ddTable, null);
  assert.equal(lateHarness.room.classicRevision, 1);
});

test('invalid trusted DDS output follows the failure path without a gameplay error', async () => {
  const h = adapterHarness({ calcDDTable: async () => [[7, 7, 7, 7]] });
  assert.deepEqual(h.adapter.start(h.room, {
    socketId: h.fixture.socketIds.N, seat: 'N',
  }), { ok: true, phase: 'BIDDING', revision: 1 });

  await flushAsyncEffects();

  assert.equal(h.room.ddsStatus, 'FAILED');
  assert.equal(h.room.ddTable, null);
  assert.equal(h.room.classicRevision, 1);
  assert.equal(h.fixture.named('appError').length, 0);
  assert.equal(h.logs.some(log => log.metadata.method === 'settleDds'), true);
});

function activeBidHarness(options = {}) {
  const h = adapterHarness(options);
  applyClassicState(h.room, createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(1),
  }));
  return h;
}

function bidAs(h, seat, bid, alert = false, explain = null) {
  h.fixture.clear();
  return h.adapter.bid(h.room, {
    socketId: h.fixture.socketIds[seat], seat, bid, alert, explain,
  });
}

test('adapter bid normalizes legacy X/XX and alert text while retaining core tokens internally', () => {
  const h = activeBidHarness();
  assert.deepEqual(bidAs(h, 'N', '1H', true, '  five hearts  '), {
    ok: true, phase: 'BIDDING', revision: 1,
  });
  assert.deepEqual(h.room.biddingHistory[0], fullEntry('N', '1H', true, 'five hearts'));
  assert.equal(h.fixture.named('biddingUpdate').length, 4);

  assert.deepEqual(bidAs(h, 'E', 'Double', true, `  ${'😀'.repeat(510)}  `), {
    ok: true, phase: 'BIDDING', revision: 2,
  });
  assert.equal(h.room.biddingHistory[1].bid, 'X');
  assert.equal([...h.room.biddingHistory[1].explain].length, 500);
  assert.equal(h.fixture.named('biddingUpdate')[0].payload.history[1].bid, 'Double');

  assert.deepEqual(bidAs(h, 'S', 'Redouble', false, 'ignored'), {
    ok: true, phase: 'BIDDING', revision: 3,
  });
  assert.equal(h.room.biddingHistory[2].bid, 'XX');
  assert.equal(h.room.biddingHistory[2].explain, null);
  assert.equal(h.fixture.named('biddingUpdate')[0].payload.history[2].bid, 'Redouble');
});

test('adapter bid maps turn, invalid-bid, and malformed-boundary failures without mutation or throws', () => {
  const h = activeBidHarness();
  assert.deepEqual(bidAs(h, 'E', 'Pass'), { ok: false, code: 'CLASSIC_NOT_YOUR_TURN' });
  assert.deepEqual(h.fixture.named('appError').map(event => event.payload.msg), ['还没到你叫牌']);
  assert.equal(h.room.classicRevision, 0);

  assert.deepEqual(bidAs(h, 'N', 'Double'), { ok: false, code: 'CLASSIC_INVALID_BID' });
  assert.deepEqual(h.fixture.named('appError').map(event => event.payload.msg), ['没有可加倍的定约']);
  assert.equal(h.room.classicRevision, 0);

  assert.doesNotThrow(() => {
    assert.deepEqual(h.adapter.bid(h.room, {
      socketId: h.fixture.socketIds.N, seat: 'N', bid: 7, alert: false, explain: null,
    }), { ok: false, code: 'CLASSIC_INPUT_INVALID' });
  });
  assert.equal(h.room.classicRevision, 0);
});

test('final contract bid emits only independently filtered legacy biddingEnd frames', () => {
  const h = activeBidHarness();
  bidAs(h, 'N', '1NT', true, 'balanced');
  bidAs(h, 'E', 'Pass');
  bidAs(h, 'S', 'Pass');
  const result = bidAs(h, 'W', 'Pass');

  assert.deepEqual(result, { ok: true, phase: 'PLAYING', revision: 4 });
  assert.deepEqual(h.fixture.emissions.map(({ target, name }) => ({ target, name })),
    ['N', 'E', 'S', 'W'].map(seat => ({
      target: h.fixture.socketIds[seat], name: 'biddingEnd',
    })));
  for (const emission of h.fixture.emissions) {
    assert.deepEqual(Object.keys(emission.payload), [
      'contract', 'declarer', 'dummy', 'leader', 'biddingHistory', 'declarerControlledBy',
    ]);
    assert.equal(emission.payload.biddingHistory.at(-1).bid, 'Pass');
    assert.equal(emission.payload.declarerControlledBy, null);
  }
  const south = h.fixture.forTarget(h.fixture.socketIds.S)[0].payload;
  assert.deepEqual(south.biddingHistory[0], { seat: 'N', bid: '1NT' });
  assert.equal(h.fixture.named('biddingUpdate').length, 0);
});

test('four opening passes emit only private-safe legacy gameEnd frames with no final biddingUpdate', () => {
  const h = activeBidHarness();
  bidAs(h, 'N', 'Pass');
  bidAs(h, 'E', 'Pass');
  bidAs(h, 'S', 'Pass');
  const result = bidAs(h, 'W', 'Pass');

  assert.deepEqual(result, { ok: true, phase: 'SCORING', revision: 4 });
  assert.equal(h.fixture.named('biddingUpdate').length, 0);
  assert.equal(h.fixture.named('gameEnd').length, 4);
  for (const emission of h.fixture.named('gameEnd')) {
    assert.deepEqual(Object.keys(emission.payload), [
      'passedOut', 'score', 'boardScores', 'ddTable',
    ]);
    assert.equal(emission.payload.passedOut, true);
    assert.equal(emission.payload.score, 0);
    assert.equal(emission.payload.ddTable, null);
    assert.equal(JSON.stringify(emission.payload).includes('initialHands'), false);
  }
});

test('server routing seam delegates only standard classic start and bid paths', () => {
  const serverPath = require.resolve('../server.js');
  delete require.cache[serverPath];
  const serverApi = require(serverPath);
  try {
    for (const route of [serverApi.routeClassicStart, serverApi.routeClassicBid]) {
      const variants = [
        [{ mode: 'classic', teachingMode: false }, 'standard'],
        [{ mode: 'classic', teachingMode: true }, 'legacy'],
        [{ mode: 'ult', teachingMode: false }, 'legacy'],
        [{ mode: 'problem', teachingMode: false }, 'legacy'],
        [{ mode: 'complex', teachingMode: false }, 'legacy'],
      ];
      for (const [room, expected] of variants) {
        const calls = [];
        const result = route(room, { socketId: 's', seat: 'N' }, {
          standard: () => { calls.push('standard'); return 'standard-result'; },
          legacy: () => { calls.push('legacy'); return 'legacy-result'; },
        });
        assert.deepEqual(calls, [expected]);
        assert.equal(result, `${expected}-result`);
      }
    }
  } finally {
    delete require.cache[serverPath];
  }
});
