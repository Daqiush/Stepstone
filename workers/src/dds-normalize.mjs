const SEATS = ['N', 'E', 'S', 'W'];
const SUITS = ['S', 'H', 'D', 'C'];
const STRAINS = [...SUITS, 'NT'];
const RANKS = { T: 10, J: 11, Q: 12, K: 13, A: 14 };

export class DdsInputError extends Error {
  constructor() { super('Invalid DDS deal'); this.name = 'DdsInputError'; this.code = 'INVALID_DEAL'; }
}

function invalid() { throw new DdsInputError(); }
function rankOf(rank) {
  const value = typeof rank === 'string' ? (RANKS[rank.toUpperCase()] ?? Number(rank)) : rank;
  if (!Number.isInteger(value) || value < 2 || value > 14) invalid();
  return value;
}

export function normalizeCards(cards) {
  if (!Array.isArray(cards)) invalid();
  return cards.map((card) => {
    if (!card || !SUITS.includes(card.suit)) invalid();
    return { suit: card.suit, rank: rankOf(card.rank) };
  });
}

export function normalizeHands(hands) {
  if (!hands || typeof hands !== 'object' || Object.keys(hands).length !== SEATS.length || !SEATS.every((seat) => Object.hasOwn(hands, seat))) invalid();
  const normalized = Object.fromEntries(SEATS.map((seat) => [seat, normalizeCards(hands[seat])]));
  const seen = new Set();
  for (const cards of Object.values(normalized)) for (const card of cards) {
    const key = `${card.suit}${card.rank}`;
    if (seen.has(key)) invalid();
    seen.add(key);
  }
  return normalized;
}

export function currentSeat(trickLeader, trickLength) {
  if (!SEATS.includes(trickLeader) || !Number.isInteger(trickLength) || trickLength < 0 || trickLength > 3) invalid();
  return SEATS[(SEATS.indexOf(trickLeader) + trickLength) % SEATS.length];
}

export function normalizeDeal(deal) {
  if (!deal || typeof deal !== 'object' || !['S', 'H', 'D', 'C', 'NT'].includes(deal.trump) || !SEATS.includes(deal.trickLeader)) invalid();
  const hands = normalizeHands(deal.hands);
  const trickPlayed = normalizeCards(deal.trickPlayed);
  currentSeat(deal.trickLeader, trickPlayed.length);
  const seen = new Set(Object.values(hands).flat().map((card) => `${card.suit}${card.rank}`));
  for (const card of trickPlayed) {
    const key = `${card.suit}${card.rank}`;
    if (seen.has(key)) invalid();
    seen.add(key);
  }
  return { hands, trump: deal.trump, trickLeader: deal.trickLeader, trickPlayed };
}

export function normalizeTable(table) {
  if (!table || typeof table !== 'object' || !SEATS.every((seat) => table[seat] && typeof table[seat] === 'object')) invalid();
  return STRAINS.map((strain) => SEATS.map((seat) => {
    const value = table[seat][strain];
    if (!Number.isInteger(value) || value < 0 || value > 13) invalid();
    return value;
  }));
}

export function normalizeSolveResult(result) {
  if (!result || typeof result !== 'object' || !Number.isInteger(result.score) || result.score < 0 || result.score > 13) invalid();
  const cards = normalizeCards(result.cards);
  const seen = new Set();
  for (const card of cards) {
    const key = `${card.suit}${card.rank}`;
    if (seen.has(key)) invalid();
    seen.add(key);
  }
  return { score: result.score, cards: cards.sort((a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || a.rank - b.rank) };
}
