'use strict';

const SEATS = Object.freeze(['N', 'E', 'S', 'W']);
const SUITS = Object.freeze(['S', 'H', 'D', 'C']);
const RANKS = Object.freeze(['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']);
const RANK_VALUE = Object.freeze({
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
});
const PHASES = Object.freeze(['LOBBY', 'BIDDING', 'PLAYING', 'SCORING']);

module.exports = Object.freeze({ SEATS, SUITS, RANKS, RANK_VALUE, PHASES });
