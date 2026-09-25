const SUITS = ['S', 'H', 'D', 'C'];
const validTricks = (value) => Number.isInteger(value) && value >= 0 && value <= 13;

// A malformed success response is a protocol failure, never a parity mismatch.
// Candidate order is canonical suit order (S,H,D,C), then numeric rank.
export function normalizeDdsResult(kind, result) {
  if (kind === 'table') {
    if (!Array.isArray(result) || result.length !== 5
        || result.some((row) => !Array.isArray(row) || row.length !== 4 || row.some((value) => !validTricks(value)))) {
      throw new Error('Malformed table result: expected a 5x4 array of integer tricks 0..13');
    }
    return result;
  }
  if (kind === 'solve') {
    if (!result || typeof result !== 'object' || Array.isArray(result)
        || !validTricks(result.score) || !Array.isArray(result.cards)
        || result.cards.length < 1 || result.cards.length > 13) {
      throw new Error('Malformed solve result: expected score 0..13 and candidate cards');
    }
    const cards = [];
    const seen = new Set();
    for (const card of result.cards) {
      if (!card || typeof card !== 'object' || Array.isArray(card)
          || !SUITS.includes(card.suit) || !Number.isInteger(card.rank)
          || card.rank < 2 || card.rank > 14) {
        throw new Error('Malformed solve result: candidate suit/rank must be S,H,D,C and 2..14');
      }
      const key = `${card.suit}${card.rank}`;
      if (seen.has(key)) throw new Error('Malformed solve result: duplicate candidate');
      seen.add(key);
      cards.push(card);
    }
    cards.sort((a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || a.rank - b.rank);
    return { score: result.score, cards: cards.map((card) => `${card.suit}${card.rank}`) };
  }
  throw new Error(`Malformed DDS operation: ${kind}`);
}
