'use strict';

const { SEATS, SUITS, RANKS } = require('./constants.cjs');
const { ClassicInputError } = require('./engine.cjs');
const { ClassicInvariantError, validateClassicState } = require('./state.cjs');
const {
  boardInfoFor, nextSeat, parseBid, partnerOf, sideOf,
} = require('./rules.cjs');

const VIEW_KEYS = Object.freeze([
  'schemaVersion', 'mode', 'phase', 'dealNumber', 'boardInfo', 'readyStatus',
  'biddingHistory', 'currentBidder', 'currentContract', 'consecutivePasses',
  'declarer', 'dummy', 'leader', 'currentPlayer', 'currentTrick', 'completedCount',
  'nsTricks', 'ewTricks', 'dummyRevealed', 'claimSettlement', 'boardScores',
  'ddTable', 'ddsStatus', 'hands',
]);

function hasExactOwnKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function input(condition, message) {
  if (!condition) throw new ClassicInputError(message);
}

function invariant(condition, message) {
  if (!condition) throw new ClassicInvariantError(message);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function isExactArray(value, length = null) {
  if (!Array.isArray(value) || (length !== null && value.length !== length)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => String(index))
      .every(key => Object.hasOwn(value, key));
}

function isBoundedText(value) {
  return typeof value === 'string' && [...value].length <= 500;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]));
  }
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

function validateViewer(viewer) {
  input(hasExactOwnKeys(viewer, ['role', 'seat']), 'viewer has an invalid shape');
  input(['OWNER', 'PLAYER', 'SPECTATOR'].includes(viewer.role), 'viewer role is invalid');
  if (viewer.role === 'PLAYER') input(SEATS.includes(viewer.seat), 'player viewer must have a seat');
  else if (viewer.role === 'SPECTATOR') input(viewer.seat === null, 'spectator viewer cannot have a seat');
  else input(viewer.seat === null || SEATS.includes(viewer.seat), 'owner viewer seat is invalid');
}

function seesFullAuctionEntry(viewer, bidder) {
  return viewer.seat === null || viewer.seat === bidder || sideOf(viewer.seat) !== sideOf(bidder);
}

function projectQa(qa) {
  invariant(isExactArray(qa), 'auction Q&A is invalid');
  return qa.map(entry => {
    invariant(hasExactOwnKeys(entry, ['asker', 'question', 'answer', 'answerer']),
      'auction Q&A entry has an invalid shape');
    invariant(SEATS.includes(entry.asker) && isBoundedText(entry.question),
      'auction Q&A question is invalid');
    invariant(entry.answer === null || isBoundedText(entry.answer),
      'auction Q&A answer is invalid');
    invariant(entry.answerer === null || SEATS.includes(entry.answerer),
      'auction Q&A answerer is invalid');
    invariant((entry.answer === null) === (entry.answerer === null),
      'auction Q&A answer fields are inconsistent');
    return {
      asker: entry.asker,
      question: entry.question,
      answer: entry.answer,
      answerer: entry.answerer,
    };
  });
}

function projectAuctionEntry(entry, viewer) {
  invariant(hasExactOwnKeys(entry, ['seat', 'bid', 'alert', 'explain', 'qa']),
    'auction entry has an invalid shape');
  invariant(SEATS.includes(entry.seat) && parseBid(entry.bid), 'auction call is invalid');
  invariant(entry.alert === true || entry.alert === null, 'auction alert is invalid');
  invariant(entry.explain === null || isBoundedText(entry.explain),
    'auction explanation is invalid');
  invariant(entry.alert === true || entry.explain === null,
    'unalerted call cannot have an explanation');
  const qa = projectQa(entry.qa);
  if (!seesFullAuctionEntry(viewer, entry.seat)) return { seat: entry.seat, bid: entry.bid };
  return {
    seat: entry.seat,
    bid: entry.bid,
    alert: entry.alert,
    explain: entry.explain,
    qa,
  };
}

function projectAuction(history, viewer) {
  invariant(isExactArray(history), 'auction history is invalid');
  return history.map(entry => projectAuctionEntry(entry, viewer));
}

function projectContract(contract) {
  if (contract === null) return null;
  invariant(hasExactOwnKeys(contract, [
    'level', 'suit', 'seat', 'doubled', 'redoubled', 'doublerSeat',
  ]), 'contract has an invalid shape');
  invariant(Number.isInteger(contract.level) && contract.level >= 1 && contract.level <= 7,
    'contract level is invalid');
  invariant(['C', 'D', 'H', 'S', 'NT'].includes(contract.suit), 'contract suit is invalid');
  invariant(SEATS.includes(contract.seat), 'contract seat is invalid');
  invariant(typeof contract.doubled === 'boolean' && typeof contract.redoubled === 'boolean',
    'contract doubling flags are invalid');
  if (!contract.doubled) {
    invariant(contract.redoubled === false && contract.doublerSeat === null,
      'contract doubling state is inconsistent');
  } else {
    invariant(SEATS.includes(contract.doublerSeat), 'contract doubler seat is invalid');
    const sameSide = sideOf(contract.doublerSeat) === sideOf(contract.seat);
    invariant(contract.redoubled ? sameSide : !sameSide,
      'contract doubler ownership is inconsistent');
  }
  return {
    level: contract.level,
    suit: contract.suit,
    seat: contract.seat,
    doubled: contract.doubled,
    redoubled: contract.redoubled,
    doublerSeat: contract.doublerSeat,
  };
}

function projectClaim(claim) {
  if (claim === null) return null;
  invariant(hasExactOwnKeys(claim, ['claimer', 'tricksToWin', 'reason']),
    'claim has an invalid shape');
  invariant(SEATS.includes(claim.claimer), 'claim claimer is invalid');
  invariant(Number.isSafeInteger(claim.tricksToWin)
    && claim.tricksToWin >= 0 && claim.tricksToWin <= 13, 'claim trick count is invalid');
  invariant(isBoundedText(claim.reason), 'claim reason is invalid');
  return {
    claimer: claim.claimer,
    tricksToWin: claim.tricksToWin,
    reason: claim.reason,
  };
}

function projectScore(score, viewer) {
  invariant(score && typeof score === 'object' && !Array.isArray(score), 'score is invalid');
  if (score.passedOut === true) {
    return {
      dealNumber: score.dealNumber,
      boardNumber: score.boardNumber,
      score: score.score,
      passedOut: true,
      ddTable: cloneValue(score.ddTable),
      biddingHistory: projectAuction(score.biddingHistory, viewer),
    };
  }
  return {
    dealNumber: score.dealNumber,
    boardNumber: score.boardNumber,
    passedOut: false,
    contract: projectContract(score.contract),
    declarer: score.declarer,
    dummy: score.dummy,
    declarerTricks: score.declarerTricks,
    needed: score.needed,
    score: score.score,
    made: score.made,
    diff: score.diff,
    vulnerability: score.vulnerability,
    biddingHistory: projectAuction(score.biddingHistory, viewer),
    completedTricks: cloneValue(score.completedTricks),
    ddTable: cloneValue(score.ddTable),
    claim: projectClaim(score.claim),
  };
}

function visibleHand(state, viewer, seat) {
  if (viewer.seat === seat) return cloneValue(state.hands[seat]);
  if (state.dummyRevealed && state.dummy === seat) return cloneValue(state.hands[seat]);
  return null;
}

function classicViewFor(state, viewer) {
  validateViewer(viewer);
  validateClassicState(state);
  const result = {
    schemaVersion: state.schemaVersion,
    mode: state.mode,
    phase: state.phase,
    dealNumber: state.dealNumber,
    boardInfo: cloneValue(state.boardInfo),
    readyStatus: cloneValue(state.readyStatus),
    biddingHistory: projectAuction(state.biddingHistory, viewer),
    currentBidder: state.currentBidder,
    currentContract: projectContract(state.currentContract),
    consecutivePasses: state.consecutivePasses,
    declarer: state.declarer,
    dummy: state.dummy,
    leader: state.leader,
    currentPlayer: state.currentPlayer,
    currentTrick: cloneValue(state.currentTrick),
    completedCount: state.completedTricks.length,
    nsTricks: state.nsTricks,
    ewTricks: state.ewTricks,
    dummyRevealed: state.dummyRevealed,
    claimSettlement: cloneValue(state.claimSettlement),
    boardScores: state.boardScores.map(score => projectScore(score, viewer)),
    ddTable: cloneValue(state.ddTable),
    ddsStatus: state.ddsStatus,
    hands: Object.fromEntries(SEATS.map(seat => [seat, visibleHand(state, viewer, seat)])),
  };
  invariant(Object.keys(result).length === VIEW_KEYS.length, 'view construction failed');
  return result;
}

function exactEvent(event, name, payloadKeys) {
  invariant(hasExactOwnKeys(event, ['name', 'payload']), 'event has an invalid shape');
  invariant(event.name === name, 'event name is invalid');
  invariant(hasExactOwnKeys(event.payload, payloadKeys), 'event payload has an invalid shape');
}

function projectBoardInfo(boardInfo, dealNumber) {
  invariant(hasExactOwnKeys(boardInfo, ['number', 'dealNumber', 'vul', 'dealer']),
    'event boardInfo has an invalid shape');
  invariant(isPositiveSafeInteger(dealNumber), 'event deal number is invalid');
  const expected = boardInfoFor(dealNumber);
  invariant(['number', 'dealNumber', 'vul', 'dealer']
    .every(key => boardInfo[key] === expected[key]), 'event boardInfo is invalid');
  return {
    number: boardInfo.number,
    dealNumber: boardInfo.dealNumber,
    vul: boardInfo.vul,
    dealer: boardInfo.dealer,
  };
}

function projectCard(card) {
  invariant(hasExactOwnKeys(card, ['suit', 'rank']), 'event card has an invalid shape');
  invariant(SUITS.includes(card.suit) && RANKS.includes(card.rank), 'event card is invalid');
  return { suit: card.suit, rank: card.rank };
}

function projectPlay(play) {
  invariant(hasExactOwnKeys(play, ['seat', 'card']), 'event play has an invalid shape');
  invariant(SEATS.includes(play.seat), 'event play seat is invalid');
  return { seat: play.seat, card: projectCard(play.card) };
}

function projectPlays(plays, minimum, maximum) {
  invariant(isExactArray(plays) && plays.length >= minimum && plays.length <= maximum,
    'event play list is invalid');
  const projected = plays.map(projectPlay);
  const seenSeats = new Set();
  const seenCards = new Set();
  for (let index = 0; index < projected.length; index++) {
    const play = projected[index];
    invariant(!seenSeats.has(play.seat), 'event play list repeats a seat');
    seenSeats.add(play.seat);
    const cardKey = `${play.card.suit}${play.card.rank}`;
    invariant(!seenCards.has(cardKey), 'event play list repeats a card');
    seenCards.add(cardKey);
    if (index > 0) {
      invariant(play.seat === nextSeat(projected[index - 1].seat),
        'event play order is invalid');
    }
  }
  return projected;
}

function projectTrick(trick) {
  invariant(hasExactOwnKeys(trick, ['cards', 'winner']), 'event trick has an invalid shape');
  const cards = projectPlays(trick.cards, 4, 4);
  invariant(SEATS.includes(trick.winner) && cards.some(play => play.seat === trick.winner),
    'event trick winner is invalid');
  return { cards, winner: trick.winner };
}

function projectReadyStatus(readyStatus) {
  invariant(hasExactOwnKeys(readyStatus, SEATS)
    && SEATS.every(seat => typeof readyStatus[seat] === 'boolean'),
  'event ready status is invalid');
  return Object.fromEntries(SEATS.map(seat => [seat, readyStatus[seat]]));
}

function projectDdsTable(ddTable) {
  invariant(isExactArray(ddTable, 5), 'event DDS table is invalid');
  return ddTable.map(row => {
    invariant(isExactArray(row, 4)
      && row.every(value => Number.isInteger(value) && value >= 0 && value <= 13),
    'event DDS table row is invalid');
    return row.map(value => value);
  });
}

function validateFinishedCounts(payload) {
  invariant(SEATS.includes(payload.declarer), 'finished event declarer is invalid');
  invariant(Number.isSafeInteger(payload.nsTricks) && payload.nsTricks >= 0
    && Number.isSafeInteger(payload.ewTricks) && payload.ewTricks >= 0
    && payload.nsTricks + payload.ewTricks === 13, 'finished event trick counts are invalid');
  invariant(Number.isSafeInteger(payload.score), 'finished event score is invalid');
}

function projectFinished(event) {
  const { payload } = event;
  if (payload?.reason === 'passed-out') {
    exactEvent(event, 'classic.finished', ['reason', 'dealNumber', 'score']);
    invariant(isPositiveSafeInteger(payload.dealNumber), 'finished event deal number is invalid');
    invariant(Number.isSafeInteger(payload.score) && payload.score === 0,
      'passed-out event score is invalid');
    return { name: 'classic.finished', payload: {
      reason: 'passed-out', dealNumber: payload.dealNumber, score: payload.score,
    } };
  }
  const baseKeys = ['reason', 'dealNumber', 'contract', 'declarer', 'nsTricks', 'ewTricks', 'score'];
  if (payload?.reason === 'played') exactEvent(event, 'classic.finished', baseKeys);
  else if (payload?.reason === 'claimed') {
    exactEvent(event, 'classic.finished', [...baseKeys, 'claim']);
  } else {
    throw new ClassicInvariantError('finished event reason is invalid');
  }
  invariant(isPositiveSafeInteger(payload.dealNumber), 'finished event deal number is invalid');
  const contract = projectContract(payload.contract);
  invariant(contract !== null, 'finished event requires a contract');
  validateFinishedCounts(payload);
  invariant(sideOf(payload.declarer) === sideOf(contract.seat),
    'finished event declarer is inconsistent with contract');
  const projected = {
    reason: payload.reason,
    dealNumber: payload.dealNumber,
    contract,
    declarer: payload.declarer,
    nsTricks: payload.nsTricks,
    ewTricks: payload.ewTricks,
    score: payload.score,
  };
  if (payload.reason === 'claimed') projected.claim = projectClaim(payload.claim);
  return { name: 'classic.finished', payload: projected };
}

function classicEventFor(event, viewer) {
  validateViewer(viewer);
  invariant(hasExactOwnKeys(event, ['name', 'payload']), 'event has an invalid shape');
  if (event.name === 'classic.started') {
    exactEvent(event, 'classic.started', ['dealNumber', 'boardInfo']);
    invariant(isPositiveSafeInteger(event.payload.dealNumber), 'started event deal number is invalid');
    return { name: 'classic.started', payload: {
      dealNumber: event.payload.dealNumber,
      boardInfo: projectBoardInfo(event.payload.boardInfo, event.payload.dealNumber),
    } };
  }
  if (event.name === 'classic.bidding-updated') {
    exactEvent(event, 'classic.bidding-updated', [
      'biddingHistory', 'currentBidder', 'currentContract', 'consecutivePasses',
    ]);
    invariant(event.payload.currentBidder === null || SEATS.includes(event.payload.currentBidder),
      'bidding event current bidder is invalid');
    invariant(Number.isSafeInteger(event.payload.consecutivePasses)
      && event.payload.consecutivePasses >= 0, 'bidding event pass count is invalid');
    return { name: 'classic.bidding-updated', payload: {
      biddingHistory: projectAuction(event.payload.biddingHistory, viewer),
      currentBidder: event.payload.currentBidder,
      currentContract: projectContract(event.payload.currentContract),
      consecutivePasses: event.payload.consecutivePasses,
    } };
  }
  if (event.name === 'classic.bidding-ended') {
    exactEvent(event, 'classic.bidding-ended', [
      'contract', 'declarer', 'dummy', 'leader', 'biddingHistory',
    ]);
    const contract = projectContract(event.payload.contract);
    invariant(contract !== null && SEATS.includes(event.payload.declarer),
      'bidding-ended contract seats are invalid');
    invariant(sideOf(event.payload.declarer) === sideOf(contract.seat)
      && event.payload.dummy === partnerOf(event.payload.declarer)
      && event.payload.leader === nextSeat(event.payload.declarer),
    'bidding-ended seats are inconsistent');
    return { name: 'classic.bidding-ended', payload: {
      contract,
      declarer: event.payload.declarer,
      dummy: event.payload.dummy,
      leader: event.payload.leader,
      biddingHistory: projectAuction(event.payload.biddingHistory, viewer),
    } };
  }
  if (event.name === 'classic.dummy-revealed') {
    exactEvent(event, 'classic.dummy-revealed', ['dummy']);
    invariant(SEATS.includes(event.payload.dummy), 'dummy-revealed seat is invalid');
    return { name: 'classic.dummy-revealed', payload: { dummy: event.payload.dummy } };
  }
  if (event.name === 'classic.card-played') {
    exactEvent(event, 'classic.card-played', ['seat', 'card', 'currentTrick']);
    invariant(SEATS.includes(event.payload.seat), 'card-played seat is invalid');
    const card = projectCard(event.payload.card);
    const currentTrick = projectPlays(event.payload.currentTrick, 1, 4);
    const latest = currentTrick[currentTrick.length - 1];
    invariant(latest.seat === event.payload.seat && sameValue(latest.card, card),
      'card-played payload is inconsistent with current trick');
    return { name: 'classic.card-played', payload: {
      seat: event.payload.seat, card, currentTrick,
    } };
  }
  if (event.name === 'classic.trick-ended') {
    exactEvent(event, 'classic.trick-ended', ['trick', 'winner', 'nsTricks', 'ewTricks']);
    const trick = projectTrick(event.payload.trick);
    invariant(event.payload.winner === trick.winner, 'trick-ended winner is inconsistent');
    invariant(Number.isSafeInteger(event.payload.nsTricks) && event.payload.nsTricks >= 0
      && Number.isSafeInteger(event.payload.ewTricks) && event.payload.ewTricks >= 0
      && event.payload.nsTricks + event.payload.ewTricks >= 1
      && event.payload.nsTricks + event.payload.ewTricks <= 13,
    'trick-ended totals are invalid');
    return { name: 'classic.trick-ended', payload: {
      trick,
      winner: event.payload.winner,
      nsTricks: event.payload.nsTricks,
      ewTricks: event.payload.ewTricks,
    } };
  }
  if (event.name === 'classic.ready-updated') {
    exactEvent(event, 'classic.ready-updated', ['readyStatus']);
    return { name: 'classic.ready-updated', payload: {
      readyStatus: projectReadyStatus(event.payload.readyStatus),
    } };
  }
  if (event.name === 'classic.dd-table-ready') {
    exactEvent(event, 'classic.dd-table-ready', ['dealNumber', 'ddTable']);
    invariant(isPositiveSafeInteger(event.payload.dealNumber), 'DDS event deal number is invalid');
    return { name: 'classic.dd-table-ready', payload: {
      dealNumber: event.payload.dealNumber,
      ddTable: projectDdsTable(event.payload.ddTable),
    } };
  }
  if (event.name === 'classic.finished') return projectFinished(event);
  throw new ClassicInvariantError('event name is invalid');
}

module.exports = { classicViewFor, classicEventFor };
