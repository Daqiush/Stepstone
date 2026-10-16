'use strict';

const { SEATS, SUITS, RANKS, RANK_VALUE } = require('./constants.cjs');

const SUIT_ORDER = Object.freeze({ C: 0, D: 1, H: 2, S: 3, NT: 4 });
const CONTRACT_KEYS = Object.freeze(['doubled', 'doublerSeat', 'level', 'redoubled', 'seat', 'suit']);

const BOARD_INFO = Object.freeze([
  Object.freeze({ vul: 'NONE', dealer: 'N' }),
  Object.freeze({ vul: 'NS', dealer: 'E' }),
  Object.freeze({ vul: 'EW', dealer: 'S' }),
  Object.freeze({ vul: 'BOTH', dealer: 'W' }),
  Object.freeze({ vul: 'NS', dealer: 'N' }),
  Object.freeze({ vul: 'EW', dealer: 'E' }),
  Object.freeze({ vul: 'BOTH', dealer: 'S' }),
  Object.freeze({ vul: 'NONE', dealer: 'W' }),
  Object.freeze({ vul: 'EW', dealer: 'N' }),
  Object.freeze({ vul: 'BOTH', dealer: 'E' }),
  Object.freeze({ vul: 'NONE', dealer: 'S' }),
  Object.freeze({ vul: 'NS', dealer: 'W' }),
  Object.freeze({ vul: 'BOTH', dealer: 'N' }),
  Object.freeze({ vul: 'NONE', dealer: 'E' }),
  Object.freeze({ vul: 'NS', dealer: 'S' }),
  Object.freeze({ vul: 'EW', dealer: 'W' }),
]);

function nextSeat(seat) {
  return SEATS[(SEATS.indexOf(seat) + 1) % SEATS.length];
}

function partnerOf(seat) {
  return SEATS[(SEATS.indexOf(seat) + 2) % SEATS.length];
}

function sideOf(seat) {
  return seat === 'N' || seat === 'S' ? 'NS' : 'EW';
}

function boardInfoFor(dealNumber) {
  if (!Number.isSafeInteger(dealNumber) || dealNumber <= 0) {
    throw new RangeError('dealNumber must be a positive safe integer');
  }
  const number = (dealNumber - 1) % BOARD_INFO.length + 1;
  return { number, dealNumber, ...BOARD_INFO[number - 1] };
}

function parseBid(bid) {
  if (bid === 'Pass') return { kind: 'pass' };
  if (bid === 'X') return { kind: 'double' };
  if (bid === 'XX') return { kind: 'redouble' };
  if (typeof bid !== 'string' || !/^[1-7](C|D|H|S|NT)$/.test(bid)) return null;
  return { kind: 'contract', level: Number(bid[0]), suit: bid.slice(1) };
}

function bidValue(bid) {
  const parsed = parseBid(bid);
  if (!parsed) throw new TypeError('bid must be a canonical bid');
  if (parsed.kind !== 'contract') return -1;
  return parsed.level * 5 + SUIT_ORDER[parsed.suit];
}

function assertSeat(seat, label) {
  if (!SEATS.includes(seat)) throw new TypeError(`${label} must be a canonical seat`);
}

function assertCurrentContract(currentContract) {
  if (currentContract === null) return;
  if (!currentContract || typeof currentContract !== 'object' || Array.isArray(currentContract)) {
    throw new TypeError('currentContract must be null or a canonical contract');
  }
  const keys = Object.keys(currentContract).sort();
  if (keys.length !== CONTRACT_KEYS.length || keys.some((key, index) => key !== CONTRACT_KEYS[index])) {
    throw new TypeError('currentContract must have the canonical contract shape');
  }
  if (!Number.isInteger(currentContract.level) || currentContract.level < 1 || currentContract.level > 7
      || !Object.hasOwn(SUIT_ORDER, currentContract.suit)
      || !SEATS.includes(currentContract.seat)
      || typeof currentContract.doubled !== 'boolean'
      || typeof currentContract.redoubled !== 'boolean') {
    throw new TypeError('currentContract contains invalid contract values');
  }
  if (!currentContract.doubled) {
    if (currentContract.redoubled || currentContract.doublerSeat !== null) {
      throw new TypeError('currentContract has inconsistent doubling state');
    }
    return;
  }
  if (!SEATS.includes(currentContract.doublerSeat)
      || sideOf(currentContract.doublerSeat) === sideOf(currentContract.seat)) {
    throw new TypeError('currentContract has inconsistent doubling state');
  }
}

function invalidBid() {
  return { ok: false, code: 'CLASSIC_INVALID_BID' };
}

function validateBid(state, seat, bid) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
      || !Object.hasOwn(state, 'currentContract')) {
    throw new TypeError('state must contain currentContract');
  }
  assertCurrentContract(state.currentContract);
  assertSeat(seat, 'seat');

  const parsed = parseBid(bid);
  if (!parsed) return invalidBid();
  if (parsed.kind === 'pass') return { ok: true };

  const currentContract = state.currentContract;
  if (parsed.kind === 'double') {
    if (!currentContract || currentContract.doubled
        || sideOf(currentContract.seat) === sideOf(seat)) return invalidBid();
    return { ok: true };
  }
  if (parsed.kind === 'redouble') {
    if (!currentContract || !currentContract.doubled || currentContract.redoubled
        || sideOf(currentContract.doublerSeat) === sideOf(seat)) return invalidBid();
    return { ok: true };
  }

  if (currentContract && bidValue(bid) <= currentContract.level * 5 + SUIT_ORDER[currentContract.suit]) {
    return invalidBid();
  }
  return { ok: true };
}

function declarerFor(history, finalContract) {
  if (!Array.isArray(history)) throw new TypeError('history must be an auction array');
  assertCurrentContract(finalContract);
  if (finalContract === null) throw new TypeError('history cannot produce a null final contract');

  const parsedHistory = history.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !SEATS.includes(entry.seat)) {
      throw new TypeError('history contains a malformed call');
    }
    const parsed = parseBid(entry.bid);
    if (!parsed) throw new TypeError('history contains a malformed call');
    return { entry, parsed };
  });

  for (const { entry, parsed } of parsedHistory) {
    if (parsed.kind === 'contract'
        && parsed.suit === finalContract.suit
        && sideOf(entry.seat) === sideOf(finalContract.seat)) {
      return entry.seat;
    }
  }
  throw new TypeError('history does not contain the final contract denomination for its winning side');
}

function assertPlaySeats(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('state must be a play state');
  }
  assertSeat(state.currentPlayer, 'state.currentPlayer');
  assertSeat(state.declarer, 'state.declarer');
  assertSeat(state.dummy, 'state.dummy');
  if (partnerOf(state.declarer) !== state.dummy) {
    throw new TypeError('state dummy must be declarer partner');
  }
}

function effectivePlaySeat(state, actorSeat) {
  assertPlaySeats(state);
  assertSeat(actorSeat, 'actorSeat');
  if (state.currentPlayer === state.dummy && actorSeat === state.declarer) return state.dummy;
  return actorSeat;
}

function isCanonicalCard(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 2
    && SUITS.includes(value.suit)
    && RANKS.includes(value.rank);
}

function playFailure(code) {
  return { ok: false, code };
}

function validatePlay(state, actorSeat, playedCard) {
  const effectiveSeat = effectivePlaySeat(state, actorSeat);
  if (effectiveSeat !== state.currentPlayer) return playFailure('CLASSIC_NOT_YOUR_TURN');
  if (!state.hands || typeof state.hands !== 'object' || !Array.isArray(state.hands[effectiveSeat])) {
    throw new TypeError('state hands must contain the effective player hand');
  }
  if (!Array.isArray(state.currentTrick)) throw new TypeError('state.currentTrick must be an array');
  if (!isCanonicalCard(playedCard)) return playFailure('CLASSIC_CARD_NOT_HELD');

  const hand = state.hands[effectiveSeat];
  const held = hand.some(card => card.suit === playedCard.suit && card.rank === playedCard.rank);
  if (!held) return playFailure('CLASSIC_CARD_NOT_HELD');

  if (state.currentTrick.length > 0) {
    const ledSuit = state.currentTrick[0]?.card?.suit;
    if (!SUITS.includes(ledSuit)) throw new TypeError('state.currentTrick has an invalid lead card');
    if (playedCard.suit !== ledSuit && hand.some(card => card.suit === ledSuit)) {
      return playFailure('CLASSIC_MUST_FOLLOW_SUIT');
    }
  }
  return { ok: true, effectiveSeat };
}

function trickWinner(trick, trumpSuit) {
  if (!Array.isArray(trick) || trick.length !== 4) {
    throw new TypeError('trick must contain exactly four plays');
  }
  if (trumpSuit !== 'NT' && !SUITS.includes(trumpSuit)) {
    throw new TypeError('trumpSuit must be a canonical denomination');
  }

  const seenSeats = new Set();
  const seenCards = new Set();
  for (const play of trick) {
    if (!play || typeof play !== 'object' || Array.isArray(play) || !SEATS.includes(play.seat)
        || !isCanonicalCard(play.card)) {
      throw new TypeError('trick contains an invalid play');
    }
    if (seenSeats.has(play.seat)) throw new TypeError('trick contains a duplicate seat');
    seenSeats.add(play.seat);
    const cardKey = `${play.card.suit}${play.card.rank}`;
    if (seenCards.has(cardKey)) throw new TypeError('trick contains a duplicate card tie');
    seenCards.add(cardKey);
  }

  const ledSuit = trick[0].card.suit;
  const hasTrump = trumpSuit !== 'NT';
  let best = trick[0];
  for (let index = 1; index < trick.length; index++) {
    const current = trick[index];
    const bestIsTrump = hasTrump && best.card.suit === trumpSuit;
    const currentIsTrump = hasTrump && current.card.suit === trumpSuit;
    if (currentIsTrump && !bestIsTrump) {
      best = current;
    } else if (currentIsTrump === bestIsTrump
        && current.card.suit === best.card.suit
        && RANK_VALUE[current.card.rank] > RANK_VALUE[best.card.rank]) {
      best = current;
    } else if (!bestIsTrump && !currentIsTrump
        && best.card.suit !== ledSuit && current.card.suit === ledSuit) {
      best = current;
    }
  }
  return best.seat;
}

module.exports = {
  nextSeat,
  partnerOf,
  sideOf,
  boardInfoFor,
  parseBid,
  bidValue,
  validateBid,
  declarerFor,
  effectivePlaySeat,
  validatePlay,
  trickWinner,
};
