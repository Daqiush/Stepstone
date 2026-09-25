const SEATS = ['N', 'E', 'S', 'W'];
const SUITS = ['S', 'H', 'D', 'C'];

export function createRandomCaseGenerator(seed) {
  if (!Number.isInteger(seed) || seed < 1 || seed > 0xffffffff) {
    throw new Error('DDS benchmark seed must be a nonzero unsigned 32-bit integer (1..4294967295)');
  }
  let state = seed;
  function random() {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  }
  const choose = (list) => list[Math.floor(random() * list.length)];
  function shuffledDeck() {
    const deck = SUITS.flatMap((suit) => Array.from({ length: 13 }, (_, i) => ({ suit, rank: i + 2 })));
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }
  function winner(trick, leader, trump) {
    let best = 0;
    for (let i = 1; i < trick.length; i++) {
      const card = trick[i], prior = trick[best];
      if ((card.suit === prior.suit && card.rank > prior.rank)
          || (card.suit === trump && prior.suit !== trump)) best = i;
    }
    return SEATS[(SEATS.indexOf(leader) + best) % 4];
  }
  function playLegal(hands, seat, ledSuit) {
    const cards = hands[seat];
    const following = ledSuit ? cards.filter((card) => card.suit === ledSuit) : [];
    const picked = choose(following.length ? following : cards);
    cards.splice(cards.indexOf(picked), 1);
    return picked;
  }
  return function randomCase(index) {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid DDS benchmark case index');
    const deck = shuffledDeck();
    const hands = Object.fromEntries(SEATS.map((seat, i) => [seat, deck.slice(i * 13, i * 13 + 13)]));
    if (index % 100 === 0) return { id: `random-${index}`, kind: 'table', hands };
    const trump = choose([...SUITS, 'NT']);
    let leader = choose(SEATS);
    // Index cycling guarantees equitable full, middle, and endgame coverage.
    const depth = (index - 1) % 13;
    const history = [];
    for (let round = 0; round < depth; round++) {
      const trick = [], plays = [];
      for (let i = 0; i < 4; i++) {
        const seat = SEATS[(SEATS.indexOf(leader) + i) % 4];
        const card = playLegal(hands, seat, trick[0]?.suit);
        trick.push(card);
        plays.push({ seat, card });
      }
      const next = winner(trick, leader, trump);
      history.push({ leader, plays, winner: next });
      leader = next;
    }
    const trickPlayed = [];
    const alreadyPlayed = Math.floor(random() * 4);
    for (let i = 0; i < alreadyPlayed; i++) {
      const seat = SEATS[(SEATS.indexOf(leader) + i) % 4];
      trickPlayed.push(playLegal(hands, seat, trickPlayed[0]?.suit));
    }
    return { id: `random-${index}`, kind: 'solve', depth, history,
      deal: { trump, trickLeader: leader, trickPlayed, hands } };
  };
}
