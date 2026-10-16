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

module.exports = { card, orderedDeal, cloneDeal, auction };
