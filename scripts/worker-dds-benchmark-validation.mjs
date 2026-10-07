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

export function validateWorkerSolveCandidates(result, deal) {
  let normalized;
  try { normalized = normalizeDdsResult('solve', result); }
  catch (error) { throw new Error(`Malformed Worker response: ${error.message}`); }
  const raw = result.cards.map((card) => `${card.suit}${card.rank}`);
  if (JSON.stringify(raw) !== JSON.stringify(normalized.cards)) {
    throw new Error('Malformed Worker response: candidates are not canonical');
  }
  const seats = ['N', 'E', 'S', 'W'];
  const leader = seats.indexOf(deal?.trickLeader);
  const trick = deal?.trickPlayed;
  const hands = deal?.hands;
  if (leader < 0 || !Array.isArray(trick) || trick.length > 3 || !hands) {
    throw new Error('Malformed Worker response: missing deal for candidate validation');
  }
  const seat = seats[(leader + trick.length) % 4];
  const hand = hands[seat];
  if (!Array.isArray(hand)) throw new Error('Malformed Worker response: missing current hand');
  const available = new Set(hand.map((card) => `${card.suit}${card.rank}`));
  const ledSuit = trick[0]?.suit;
  const mustFollow = ledSuit && hand.some((card) => card.suit === ledSuit);
  if (normalized.cards.some((card, index) => !available.has(card)
      || (mustFollow && result.cards[index].suit !== ledSuit))) {
    throw new Error('Malformed Worker response: illegal candidate');
  }
  return normalized;
}

export function compareDdsResults(kind, baseline, worker) {
  const a = normalizeDdsResult(kind, baseline);
  const b = normalizeDdsResult(kind, worker);
  if (kind === 'table') return { parityMismatch: JSON.stringify(a) !== JSON.stringify(b), candidateDifference: null };
  const parityMismatch = a.score !== b.score;
  return {
    parityMismatch,
    candidateDifference: parityMismatch || JSON.stringify(a.cards) === JSON.stringify(b.cards)
      ? null : { baseline: a.cards, worker: b.cards },
  };
}

export function validateCandidateDiagnostics(operations, diagnostics) {
  if (!Array.isArray(operations) || !Array.isArray(diagnostics)) return false;
  const expected = new Map();
  const operationIds = new Set();
  for (const operation of operations) {
    if (typeof operation?.id !== 'string' || !operation.id || operationIds.has(operation.id)) return false;
    operationIds.add(operation.id);
    let comparison;
    try { comparison = compareDdsResults(operation.kind, operation.baseline, operation.worker); }
    catch { return false; }
    if (comparison.candidateDifference) expected.set(operation.id, {
      id: operation.id, kind: operation.kind, score: operation.worker.score,
      ...comparison.candidateDifference,
    });
  }
  if (diagnostics.length !== expected.size) return false;
  const seen = new Set();
  for (const diagnostic of diagnostics) {
    if (!diagnostic || typeof diagnostic !== 'object' || seen.has(diagnostic.id)) return false;
    seen.add(diagnostic.id);
    const match = expected.get(diagnostic.id);
    if (!match || Object.keys(diagnostic).sort().join(',') !== 'baseline,id,kind,score,worker'
        || diagnostic.kind !== match.kind || diagnostic.score !== match.score
        || JSON.stringify(diagnostic.baseline) !== JSON.stringify(match.baseline)
        || JSON.stringify(diagnostic.worker) !== JSON.stringify(match.worker)) return false;
  }
  return true;
}
