'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  CLASSIC_STATE_KEYS,
  ClassicInvariantError,
  createClassicLobbyState,
  createClassicDealState,
} = require('../classic/state.cjs');
const { ClassicInputError } = require('../classic/engine.cjs');
const { boardInfoFor } = require('../classic/rules.cjs');
const { orderedDeal } = require('./helpers/classic-fixtures.js');
const {
  applyClassicState,
  createClassicNodeAdapter,
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
  assert.deepEqual(Object.keys(adapter), ['initializeRoom']);
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
  const script = String.raw`
    const assert = require('node:assert/strict');
    const {
      CLASSIC_STATE_KEYS, createClassicLobbyState,
    } = require('./classic/state.cjs');
    const { configureNewRoom, makeRoom, roomState } = require('./server.js');

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
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 3000,
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
