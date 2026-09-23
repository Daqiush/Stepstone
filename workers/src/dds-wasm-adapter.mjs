import { DdsInputError, currentSeat, normalizeDeal, normalizeHands, normalizeSolveResult, normalizeTable } from './dds-normalize.mjs';

export { DdsInputError };
export class DdsRuntimeError extends Error {
  constructor() { super('DDS runtime failed'); this.name = 'DdsRuntimeError'; this.code = 'DDS_FAILURE'; }
}

const SUITS = ['S', 'H', 'D', 'C'];
const SEATS = ['N', 'E', 'S', 'W'];
const PBN_RANKS = { 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const rankToPbn = (rank) => PBN_RANKS[rank] ?? String(rank);

function handsToPbn(hands) {
  return SEATS.map((seat) => `${seat}:${SUITS.map((suit) => hands[seat]
    .filter((card) => card.suit === suit).sort((a, b) => b.rank - a.rank)
    .map((card) => rankToPbn(card.rank)).join('')).join('.')}`).join(' ');
}

function dealToPbn(deal) {
  const trick = deal.trickPlayed.map((card) => `${card.suit}${rankToPbn(card.rank)}`).join(',');
  return `trump=${deal.trump};leader=${deal.trickLeader};turn=${currentSeat(deal.trickLeader, deal.trickPlayed.length)};trick=${trick};hands=${handsToPbn(deal.hands)}`;
}

export function createWasmDdsClient({ loadModule }) {
  if (typeof loadModule !== 'function') throw new TypeError('loadModule must be a function');
  let modulePromise;
  const load = () => (modulePromise ??= Promise.resolve().then(loadModule));
  const call = async (method, payload) => {
    try {
      const wasm = await load();
      if (!wasm || typeof wasm[method] !== 'function') throw new Error('missing DDS method');
      return await wasm[method](payload);
    } catch { throw new DdsRuntimeError(); }
  };
  return {
    async calcDDTable(hands) {
      const normalized = normalizeHands(hands);
      try { return normalizeTable(await call('calcDDTablePbn', handsToPbn(normalized))); }
      catch { throw new DdsRuntimeError(); }
    },
    async solveBoard(deal) {
      const normalized = normalizeDeal(deal);
      try { return normalizeSolveResult(await call('solveBoardPbn', dealToPbn(normalized))); }
      catch { throw new DdsRuntimeError(); }
    },
  };
}
