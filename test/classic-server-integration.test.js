'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createStepstoneServerHarness,
  once,
} = require('./helpers/stepstone-server-harness.js');

const SEATS = ['N', 'E', 'S', 'W'];
let harness;

test.before(async () => {
  harness = await createStepstoneServerHarness();
});

test.after(async () => {
  await harness?.close();
  assert.equal(harness?.server.listening, false);
  assert.equal(harness?.io.engine?.clientsCount || 0, 0);
});

async function emitAndWait(socket, responseEvent, requestEvent, payload) {
  const response = once(socket, responseEvent);
  socket.emit(requestEvent, payload);
  return response;
}

async function createFourPlayerRoom(prefix) {
  const sockets = {};
  for (const seat of SEATS) sockets[seat] = await harness.connect();

  const createdPromise = once(sockets.N, 'roomCreated');
  sockets.N.emit('createRoom', { playerName: `${prefix}-N`, mode: 'classic' });
  const { roomId } = await createdPromise;

  const northUpdate = once(sockets.N, 'roomUpdate');
  sockets.N.emit('chooseSeat', { seat: 'N', playerName: `${prefix}-N` });
  await northUpdate;

  for (const seat of ['E', 'S', 'W']) {
    await emitAndWait(sockets[seat], 'roomJoined', 'joinRoom', {
      roomId, playerName: `${prefix}-${seat}`,
    });
    const update = once(sockets.N, 'roomUpdate');
    sockets[seat].emit('chooseSeat', { seat, playerName: `${prefix}-${seat}` });
    await update;
  }
  return { roomId, sockets };
}

test('server module starts on an ephemeral port without listening on require', { timeout: 10000 }, async () => {
  const client = await harness.connect();
  assert.equal(harness.wasListeningBeforeStart, false);
  assert.equal(client.connected, true);
  assert.equal(harness.server.listening, true);
  assert.equal(harness.server.address().port, harness.port);
});

test('four real clients complete a private 1NT deal and ready into the next board', { timeout: 30000 }, async () => {
  const { sockets } = await createFourPlayerRoom('auction');
  const starts = Object.fromEntries(SEATS.map(seat => [seat, once(sockets[seat], 'gameStart')]));
  const openingUpdates = Object.fromEntries(SEATS.map(seat => [seat, once(sockets[seat], 'biddingUpdate')]));
  sockets.N.emit('ownerStartGame');
  const deals = Object.fromEntries(await Promise.all(SEATS.map(async seat => [seat, await starts[seat]])));
  const initialUpdates = Object.fromEntries(await Promise.all(SEATS.map(async seat => [seat, await openingUpdates[seat]])));

  const allCards = new Set();
  for (const seat of SEATS) {
    assert.equal(deals[seat].seat, seat);
    assert.equal(deals[seat].hand.length, 13);
    assert.equal(Object.hasOwn(deals[seat], 'hands'), false);
    assert.equal(Object.hasOwn(deals[seat], 'initialHands'), false);
    for (const card of deals[seat].hand) allCards.add(`${card.suit}${card.rank}`);
    assert.equal(initialUpdates[seat].currentBidder, 'N');
    assert.deepEqual(initialUpdates[seat].history, []);
  }
  assert.equal(allCards.size, 52);

  for (const [seat, bid] of [['N', '1NT'], ['E', 'Pass'], ['S', 'Pass']]) {
    const update = once(sockets.N, 'biddingUpdate');
    sockets[seat].emit('bid', { bid });
    await update;
  }
  const endings = Object.fromEntries(SEATS.map(seat => [seat, once(sockets[seat], 'biddingEnd')]));
  const playUpdates = Object.fromEntries(SEATS.map(seat => [seat, once(sockets[seat], 'playUpdate')]));
  sockets.W.emit('bid', { bid: 'Pass' });

  let currentPlay;
  for (const seat of SEATS) {
    const ending = await endings[seat];
    const play = await playUpdates[seat];
    assert.equal(ending.contract.level, 1);
    assert.equal(ending.contract.suit, 'NT');
    assert.equal(ending.declarer, 'N');
    assert.equal(ending.dummy, 'S');
    assert.equal(ending.leader, 'E');
    assert.equal(play.currentPlayer, 'E');
    assert.equal(play.completedCount, 0);
    if (seat === 'N') currentPlay = play;
  }

  const hands = Object.fromEntries(SEATS.map(seat => [
    seat, deals[seat].hand.map(card => ({ ...card })),
  ]));
  let trickCount = 0;
  sockets.N.on('trickEnd', () => { trickCount += 1; });
  const dummyReveal = once(sockets.N, 'dummyRevealed');
  let revealedDummy = null;

  const chooseLegalCard = (hand, currentTrick) => {
    const ledSuit = currentTrick[0]?.card.suit;
    const legal = ledSuit ? hand.filter(card => card.suit === ledSuit) : hand;
    return { ...(legal[0] || hand[0]) };
  };

  let gameEnds = null;
  for (let played = 0; played < 52; played++) {
    const playingSeat = currentPlay.currentPlayer;
    const card = chooseLegalCard(hands[playingSeat], currentPlay.currentTrick);
    assert.ok(card, `missing legal card for ${playingSeat} at play ${played + 1}`);
    const index = hands[playingSeat].findIndex(candidate => (
      candidate.suit === card.suit && candidate.rank === card.rank
    ));
    hands[playingSeat].splice(index, 1);
    const actorSeat = playingSeat === 'S' ? 'N' : playingSeat;

    if (played === 51) {
      gameEnds = Object.fromEntries(SEATS.map(seat => [seat, once(sockets[seat], 'gameEnd')]));
      sockets[actorSeat].emit('playCard', { card });
    } else {
      const update = once(sockets.N, 'playUpdate');
      sockets[actorSeat].emit('playCard', { card });
      currentPlay = await update;
      if (played === 0) revealedDummy = await dummyReveal;
    }
  }

  assert.equal(revealedDummy.dummy, 'S');
  assert.deepEqual(revealedDummy.dummyHand, deals.S.hand);
  const scoring = Object.fromEntries(await Promise.all(SEATS.map(async seat => [seat, await gameEnds[seat]])));
  assert.equal(trickCount, 13);
  for (const seat of SEATS) {
    assert.equal(scoring[seat].passedOut, false);
    assert.equal(scoring[seat].contract.suit, 'NT');
    assert.equal(scoring[seat].declarer, 'N');
    assert.equal(scoring[seat].boardScores.length, 1);
  }
  assert.equal(SEATS.every(seat => hands[seat].length === 0), true);

  for (const seat of ['N', 'E', 'S']) {
    const readyUpdate = once(sockets.N, 'nextDealUpdate');
    sockets[seat].emit('nextDeal');
    await readyUpdate;
  }
  const secondStarts = Object.fromEntries(SEATS.map(seat => [seat, once(sockets[seat], 'gameStart')]));
  const finalReady = once(sockets.N, 'nextDealUpdate');
  sockets.W.emit('nextDeal');
  await finalReady;
  const secondDeals = Object.fromEntries(await Promise.all(SEATS.map(async seat => [seat, await secondStarts[seat]])));
  const secondCards = new Set();
  for (const seat of SEATS) {
    assert.equal(secondDeals[seat].seat, seat);
    assert.equal(secondDeals[seat].hand.length, 13);
    assert.equal(secondDeals[seat].boardInfo.dealNumber, 2);
    assert.equal(Object.hasOwn(secondDeals[seat], 'hands'), false);
    for (const card of secondDeals[seat].hand) secondCards.add(`${card.suit}${card.rank}`);
  }
  assert.equal(secondCards.size, 52);
});

test('a genuinely vacated classic seat reconnects through the filtered live projection', { timeout: 20000 }, async () => {
  const { roomId, sockets } = await createFourPlayerRoom('reconnect');
  const starts = Object.fromEntries(SEATS.map(seat => [seat, once(sockets[seat], 'gameStart')]));
  const openingUpdates = Object.fromEntries(SEATS.map(seat => [seat, once(sockets[seat], 'biddingUpdate')]));
  sockets.N.emit('ownerStartGame');
  const deals = Object.fromEntries(await Promise.all(SEATS.map(async seat => [seat, await starts[seat]])));
  await Promise.all(SEATS.map(seat => openingUpdates[seat]));

  let update = once(sockets.N, 'biddingUpdate');
  sockets.N.emit('bid', { bid: '1NT', alert: true, explain: 'balanced partner annotation' });
  await update;

  const question = once(sockets.N, 'bidQuestionRecv');
  sockets.E.emit('bidQuestion', { bidIndex: 0, question: 'forcing?' });
  const questionFrame = await question;
  const answer = once(sockets.E, 'bidAnswerRecv');
  sockets.N.emit('bidAnswer', {
    bidIndex: 0, qaIdx: questionFrame.qaIdx, asker: 'E', answer: 'no',
  });
  await answer;

  for (const seat of ['E', 'S']) {
    update = once(sockets.N, 'biddingUpdate');
    sockets[seat].emit('bid', { bid: 'Pass' });
    await update;
  }
  const biddingEnd = once(sockets.N, 'biddingEnd');
  const initialPlay = once(sockets.N, 'playUpdate');
  sockets.W.emit('bid', { bid: 'Pass' });
  await biddingEnd;
  await initialPlay;

  const reveal = once(sockets.N, 'dummyRevealed');
  const afterOpeningLead = once(sockets.N, 'playUpdate');
  sockets.E.emit('playCard', { card: deals.E.hand[0] });
  await reveal;
  const livePlay = await afterOpeningLead;
  assert.equal(livePlay.currentPlayer, 'S');

  const released = once(sockets.N, 'playerDisconnected');
  sockets.S.disconnect();
  assert.deepEqual(await released, { seat: 'S' });

  const replacement = await harness.connect();
  const streamNames = [];
  replacement.onAny(name => streamNames.push(name));
  const reconnectedStart = once(replacement, 'gameStart');
  const reconnectedAuction = once(replacement, 'biddingEnd');
  const reconnectedDummy = once(replacement, 'dummyRevealed');
  const reconnectedPlay = once(replacement, 'playUpdate');
  replacement.emit('joinRoom', { roomId, playerName: 'reconnect-S' });
  replacement.emit('chooseSeat', { seat: 'S', playerName: 'reconnect-S' });

  const [start, auction, dummy, play] = await Promise.all([
    reconnectedStart, reconnectedAuction, reconnectedDummy, reconnectedPlay,
  ]);
  assert.deepEqual(streamNames, ['gameStart', 'biddingEnd', 'dummyRevealed', 'playUpdate']);
  assert.deepEqual(start.hand, deals.S.hand);
  assert.equal(Object.hasOwn(start, 'hands'), false);
  assert.equal(JSON.stringify(start).includes('initialHands'), false);
  assert.deepEqual(dummy.dummyHand, deals.S.hand);
  assert.deepEqual(auction.biddingHistory[0], { seat: 'N', bid: '1NT' });
  assert.equal(JSON.stringify(auction).includes('balanced partner annotation'), false);
  assert.equal(JSON.stringify(auction).includes('forcing?'), false);
  assert.equal(JSON.stringify(auction).includes('"answer":"no"'), false);
  assert.deepEqual(play.currentTrick, livePlay.currentTrick);
  assert.equal(Object.hasOwn(play, 'hands'), false);
  assert.equal(Object.hasOwn(play, 'allHands'), false);
});
