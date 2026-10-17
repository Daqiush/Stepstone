import assert from 'node:assert/strict';
import test from 'node:test';

import engineModule from '../../classic/engine.cjs';
import fixturesModule from '../../test/helpers/classic-fixtures.js';
import nodeCompatModule from '../../classic/node-compat.cjs';
import rulesModule from '../../classic/rules.cjs';
import stateModule from '../../classic/state.cjs';
import {
  composeClassicEventFrame,
  composeRoomSnapshot,
} from '../src/room-foundation/room-view.mjs';

const { applyClassicCommand } = engineModule;
const { orderedDeal } = fixturesModule;
const { settleClassicClaim } = nodeCompatModule;
const { boardInfoFor } = rulesModule;
const { createClassicDealState, createClassicLobbyState } = stateModule;

const SNAPSHOT_KEYS = [
  'schemaVersion', 'roomCode', 'incarnation', 'revision', 'status',
  'foundationCounter', 'createdAt', 'expiresAt', 'viewer', 'playerNames', 'classic',
];

function clone(value) { return structuredClone(value); }

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function authority(sessionId, role, seat, displayName) {
  return {
    sessionId,
    incarnation: 7,
    role,
    seat,
    displayName,
    connectionId: null,
    connectionEpoch: 0,
    expiresAt: null,
  };
}

function authorities({ includeW = true } = {}) {
  const entries = [
    ['owner_session_0001', authority('owner_session_0001', 'OWNER', 'N', 'North')],
    ['east_session_00001', authority('east_session_00001', 'PLAYER', 'E', 'East')],
    ['south_session_0001', authority('south_session_0001', 'PLAYER', 'S', 'South')],
    ['watch_session_0001', authority('watch_session_0001', 'SPECTATOR', null, 'Watcher')],
  ];
  if (includeW) {
    entries.splice(3, 0,
      ['west_session_00001', authority('west_session_00001', 'PLAYER', 'W', '')]);
  }
  return new Map(entries);
}

function context(seat) {
  return { actor: { role: 'PLAYER', seat }, occupiedSeats: ['N', 'E', 'S', 'W'], deal: null };
}

function bid(state, seat, token, alert = false, explain = null) {
  return applyClassicCommand(state, {
    name: 'classic.bid', payload: { expectedRevision: 0, bid: token, alert, explain },
  }, context(seat)).state;
}

function playingState({ revealed = false } = {}) {
  let state = createClassicDealState(createClassicLobbyState(), {
    hands: orderedDeal(), boardInfo: boardInfoFor(1),
  });
  state = bid(state, 'N', '1NT', true, '15-17');
  state = bid(state, 'E', 'Pass');
  state = bid(state, 'S', 'Pass', true, 'forcing');
  state = bid(state, 'W', 'Pass');
  state.biddingHistory[0].qa = [
    { asker: 'E', question: 'Range?', answer: '15-17', answerer: 'N' },
  ];
  if (revealed) {
    state = applyClassicCommand(state, {
      name: 'classic.play',
      payload: { expectedRevision: 0, card: { suit: 'H', rank: '2' } },
    }, context('E')).state;
  }
  return state;
}

function stored(classic = createClassicLobbyState()) {
  return {
    schemaVersion: 1,
    roomCode: '321',
    incarnation: 7,
    revision: 4,
    status: 'ACTIVE',
    foundationCounter: 3,
    createdAt: 1_000,
    expiresAt: null,
    recentCommands: {},
    initialization: {
      leaseId: 'lease_identifier_01', leaseExpiresAt: 50_000,
      requestId: 'request_identifier1', requestHash: '0'.repeat(64),
    },
    classic,
  };
}

function assertNoPrivateKeys(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Reflect.ownKeys(value)) {
    assert.equal([
      'token', 'tokenHash', 'reconnectToken', 'sessionId', 'connectionId',
      'connectionEpoch', 'recentCommands', 'pendingActions', 'initialHands',
    ].includes(key), false, `private key leaked: ${String(key)}`);
    assertNoPrivateKeys(value[key]);
  }
}

test('composeRoomSnapshot returns the exact detached lobby shape and persisted seat names', () => {
  const input = deepFreeze(stored());
  const auth = authorities();
  const before = JSON.stringify(input);
  const snapshot = composeRoomSnapshot(input, auth, { role: 'OWNER', seat: 'N' });

  assert.deepEqual(Object.keys(snapshot), SNAPSHOT_KEYS);
  assert.deepEqual(snapshot.viewer, { role: 'OWNER', seat: 'N' });
  assert.deepEqual(snapshot.playerNames, { N: 'North', E: 'East', S: 'South', W: null });
  assert.equal(snapshot.classic.phase, 'LOBBY');
  assertNoPrivateKeys(snapshot);
  assert.equal(JSON.stringify(input), before);

  snapshot.playerNames.N = 'changed';
  snapshot.classic.readyStatus.N = true;
  const fresh = composeRoomSnapshot(input, auth, { role: 'OWNER', seat: 'N' });
  assert.deepEqual(fresh.playerNames, { N: 'North', E: 'East', S: 'South', W: null });
  assert.equal(fresh.classic.readyStatus.N, false);
  assert.notEqual(snapshot, fresh);
  assert.notEqual(snapshot.classic, fresh.classic);

  const vacant = composeRoomSnapshot(input, authorities({ includeW: false }), {
    role: 'SPECTATOR', seat: null,
  });
  assert.equal(vacant.playerNames.W, null);
});

test('composeRoomSnapshot applies one classic privacy contract to every recipient and phase', () => {
  const beforeLead = deepFreeze(stored(playingState()));
  const auth = authorities();
  const viewers = {
    owner: { role: 'OWNER', seat: 'N' },
    partner: { role: 'PLAYER', seat: 'S' },
    opponent: { role: 'PLAYER', seat: 'E' },
    dummy: { role: 'PLAYER', seat: 'S' },
    spectator: { role: 'SPECTATOR', seat: null },
  };
  for (const [label, viewer] of Object.entries(viewers)) {
    const snapshot = composeRoomSnapshot(beforeLead, auth, viewer);
    const visible = Object.entries(snapshot.classic.hands)
      .filter(([, hand]) => hand !== null).map(([seat]) => seat);
    assert.deepEqual(visible, viewer.seat === null ? [] : [viewer.seat], label);
    assertNoPrivateKeys(snapshot);
  }
  const ownerAuction = composeRoomSnapshot(beforeLead, auth, viewers.owner).classic.biddingHistory;
  assert.deepEqual(ownerAuction[2], { seat: 'S', bid: 'Pass' });
  const opponentAuction = composeRoomSnapshot(beforeLead, auth, viewers.opponent)
    .classic.biddingHistory;
  assert.deepEqual(opponentAuction[2], {
    seat: 'S', bid: 'Pass', alert: true, explain: 'forcing', qa: [],
  });

  const afterLead = deepFreeze(stored(playingState({ revealed: true })));
  for (const viewer of Object.values(viewers)) {
    const hands = composeRoomSnapshot(afterLead, auth, viewer).classic.hands;
    assert.ok(hands.S, JSON.stringify(viewer));
    for (const seat of ['N', 'E', 'W']) {
      assert.equal(hands[seat] !== null, viewer.seat === seat, `${viewer.role}:${viewer.seat}:${seat}`);
    }
  }

  const scoring = deepFreeze(stored(settleClassicClaim(clone(afterLead.classic), {
    claimer: 'N', tricksToWin: 7, reason: 'rest',
  }).state));
  const scoringView = composeRoomSnapshot(scoring, auth, viewers.opponent);
  assert.equal(scoringView.classic.phase, 'SCORING');
  assert.ok(scoringView.classic.hands.E);
  assert.ok(scoringView.classic.hands.S);
  assert.equal(scoringView.classic.hands.N, null);
  assert.equal(scoringView.classic.hands.W, null);
  assertNoPrivateKeys(scoringView);
});

test('composeClassicEventFrame filters and detaches recipient-specific classic events', () => {
  const classic = playingState();
  const event = deepFreeze({
    name: 'classic.bidding-updated',
    payload: {
      biddingHistory: clone(classic.biddingHistory),
      currentBidder: classic.currentBidder,
      currentContract: clone(classic.currentContract),
      consecutivePasses: classic.consecutivePasses,
    },
  });
  const forNorth = composeClassicEventFrame(event, 9, { role: 'PLAYER', seat: 'N' });
  const forSouth = composeClassicEventFrame(event, 9, { role: 'PLAYER', seat: 'S' });
  assert.deepEqual(Object.keys(forNorth), ['v', 'type', 'name', 'payload']);
  assert.deepEqual(forNorth, {
    v: 1,
    type: 'event',
    name: 'classic.bidding-updated',
    payload: {
      revision: 9,
      event: {
        biddingHistory: forNorth.payload.event.biddingHistory,
        currentBidder: null,
        currentContract: clone(classic.currentContract),
        consecutivePasses: 3,
      },
    },
  });
  assert.deepEqual(forNorth.payload.event.biddingHistory[2], { seat: 'S', bid: 'Pass' });
  assert.deepEqual(forSouth.payload.event.biddingHistory[0], { seat: 'N', bid: '1NT' });
  assertNoPrivateKeys(forNorth);
  forNorth.payload.event.biddingHistory[0].bid = '7NT';
  assert.equal(event.payload.biddingHistory[0].bid, '1NT');
  assert.equal(
    composeClassicEventFrame(event, 9, { role: 'PLAYER', seat: 'N' })
      .payload.event.biddingHistory[0].bid,
    '1NT',
  );
});

test('room and event composers fail closed on malformed authority, viewer, revision, or state', () => {
  const base = stored();
  const cases = [
    [new Map([['bad_session_00001', { ...authority('bad_session_00001', 'PLAYER', 'E', 'East'), displayName: undefined }]]), { role: 'PLAYER', seat: 'E' }],
    [new Map([
      ['east_session_00001', authority('east_session_00001', 'PLAYER', 'E', 'East')],
      ['east_session_00002', authority('east_session_00002', 'PLAYER', 'E', 'Other East')],
    ]), { role: 'PLAYER', seat: 'E' }],
    [authorities(), { role: 'PLAYER', seat: 'Q' }],
  ];
  for (const [auth, viewer] of cases) {
    assert.throws(() => composeRoomSnapshot(base, auth, viewer));
  }
  assert.throws(() => composeRoomSnapshot({ ...base, classic: null }, authorities(), {
    role: 'SPECTATOR', seat: null,
  }));
  assert.throws(() => composeClassicEventFrame(
    { name: 'classic.finished', payload: {} }, 1, { role: 'SPECTATOR', seat: null },
  ));
  assert.throws(() => composeClassicEventFrame(
    { name: 'classic.started', payload: { dealNumber: 1, boardInfo: boardInfoFor(1) } },
    -1,
    { role: 'SPECTATOR', seat: null },
  ));
});
