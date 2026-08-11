'use strict';

function createComplexDeck() {
  const deck = [];
  for (let re = 1; re <= 5; re++) {
    for (let im = 1; im <= 5; im++) {
      deck.push({ kind: 'real', re, im });
      deck.push({ kind: 'imag', re, im });
    }
  }
  deck.push({ kind: 'ace', order: 'realFirst' });   // A+Ai
  deck.push({ kind: 'ace', order: 'imagFirst' });   // Ai+A
  return deck;
}

function cardId(card) {
  if (card.kind === 'ace') return `ace:${card.order}`;
  return `${card.kind}:${card.re}:${card.im}`;
}

function ledSuit(card, trump) {
  if (isTrumpCard(card, trump)) return trump;
  return { axis: card.kind, value: card.kind === 'real' ? card.re : card.im };
}

function sameSuit(a, b) {
  return a && b && a.axis === b.axis && a.value === b.value;
}

function matchesLedSuit(card, leadCard, trump) {
  const suit = leadCard?.axis ? leadCard : ledSuit(leadCard, trump);
  if (!suit) return false;
  if (sameSuit(suit, trump)) return isTrumpCard(card, trump);
  if (isTrumpCard(card, trump)) return false;
  return suit.axis === 'real' ? card.re === suit.value : card.im === suit.value;
}

function isTrumpCard(card, trump) {
  if (!trump) return false;
  if (card.kind === 'ace') return true;
  return trump.axis === 'real' ? card.re === trump.value : card.im === trump.value;
}

function cardStrength(card, suit) {
  if (card.kind === 'ace') {
    if (!suit) return -1;
    const highOrder = suit.axis === 'real' ? 'realFirst' : 'imagFirst';
    return card.order === highOrder ? 102 : 101;
  }
  const other = suit.axis === 'real' ? card.im : card.re;
  return other * 2 + (card.kind === suit.axis ? 1 : 0);
}

function trickWinner(trick, trump) {
  if (!Array.isArray(trick) || trick.length === 0) return null;
  const led = ledSuit(trick[0].card, trump);
  let winner = trick[0];
  for (const entry of trick.slice(1)) {
    const candidateTrump = matchesLedSuit(entry.card, trump, trump);
    const winnerTrump = matchesLedSuit(winner.card, trump, trump);
    if (candidateTrump && !winnerTrump) { winner = entry; continue; }
    if (candidateTrump && winnerTrump && cardStrength(entry.card, trump) > cardStrength(winner.card, trump)) { winner = entry; continue; }
    if (!candidateTrump && !winnerTrump && matchesLedSuit(entry.card, led, trump) && cardStrength(entry.card, led) > cardStrength(winner.card, led)) winner = entry;
  }
  return winner.seat;
}

function hasFollowingCard(hand, leadCard, trump) {
  return hand.some(card => matchesLedSuit(card, leadCard, trump));
}

function isLegalPlay(hand, card, leadCard, trump) {
  if (!hand.some(c => cardId(c) === cardId(card))) return false;
  return !leadCard || !hasFollowingCard(hand, leadCard, trump) || matchesLedSuit(card, leadCard, trump);
}

function resolveComplexBids(nsBid, ewBid, random = Math.random) {
  const ns = { side: 'NS', ...nsBid };
  const ew = { side: 'EW', ...ewBid };
  if (ns.tricks !== ew.tricks) return { ...(ns.tricks > ew.tricks ? ns : ew), decidedBy: 'tricks' };
  if (ns.trump.value !== ew.trump.value) return { ...(ns.trump.value > ew.trump.value ? ns : ew), decidedBy: 'suit' };
  return { ...(random() < 0.5 ? ns : ew), decidedBy: 'draw' };
}

function openingLeader(declarerSide) {
  return declarerSide === 'NS' ? 'W' : 'S';
}

function controlledSeats(seat) {
  if (seat === 'N' || seat === 'S') return ['N', 'S'];
  if (seat === 'E' || seat === 'W') return ['E', 'W'];
  return [];
}

function isValidBidTricks(tricks) {
  return Number.isInteger(tricks) && tricks >= 7 && tricks <= 13;
}

function trumpAcePlacement(trump) {
  return trump.axis === 'real' ? { zone: 'top', re: trump.value } : { zone: 'right', im: trump.value };
}

module.exports = {
  createComplexDeck,
  cardId,
  ledSuit,
  matchesLedSuit,
  isTrumpCard,
  trickWinner,
  hasFollowingCard,
  isLegalPlay,
  resolveComplexBids,
  openingLeader,
  controlledSeats,
  isValidBidTricks,
  trumpAcePlacement,
};
