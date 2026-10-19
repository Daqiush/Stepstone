'use strict';

const { SEATS, SUITS, RANKS } = require('../../classic/constants.cjs');

function card(suit, rank) {
  return { suit, rank };
}

function orderedDeal() {
  const deck = SUITS.flatMap(suit => RANKS.map(rank => card(suit, rank)));
  return Object.fromEntries(SEATS.map((seat, index) => [seat, deck.slice(index * 13, (index + 1) * 13)]));
}

function cloneDeal(deal) {
  return Object.fromEntries(SEATS.map(seat => [seat, deal[seat].map(({ suit, rank }) => card(suit, rank))]));
}

function auction(bids, dealer = 'N') {
  const dealerIndex = SEATS.indexOf(dealer);
  return bids.map((bid, index) => ({ seat: SEATS[(dealerIndex + index) % SEATS.length], bid }));
}

function assertTranscriptDeals(deals) {
  if (!Array.isArray(deals) || deals.length === 0) {
    throw new TypeError('classic transcript deals must be a non-empty array');
  }
  for (const deal of deals) {
    if (deal === null || typeof deal !== 'object' || Array.isArray(deal)
        || Reflect.ownKeys(deal).length !== SEATS.length
        || !SEATS.every(seat => Object.hasOwn(deal, seat))) {
      throw new TypeError('classic transcript deal must contain the four seats');
    }
    const seen = new Set();
    for (const seat of SEATS) {
      if (!Array.isArray(deal[seat]) || deal[seat].length !== 13) {
        throw new TypeError('classic transcript hand must contain 13 cards');
      }
      for (const held of deal[seat]) {
        if (held === null || typeof held !== 'object' || Array.isArray(held)
            || Reflect.ownKeys(held).length !== 2
            || !Object.hasOwn(held, 'suit') || !Object.hasOwn(held, 'rank')
            || !SUITS.includes(held.suit) || !RANKS.includes(held.rank)) {
          throw new TypeError('classic transcript card must be canonical');
        }
        const key = `${held.suit}${held.rank}`;
        if (seen.has(key)) throw new TypeError('classic transcript deal contains a duplicate card');
        seen.add(key);
      }
    }
    if (seen.size !== 52) throw new TypeError('classic transcript deal must contain 52 unique cards');
  }
  return true;
}

module.exports = { card, orderedDeal, cloneDeal, auction, assertTranscriptDeals };
