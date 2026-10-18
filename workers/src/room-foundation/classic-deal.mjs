import constantsModule from '../../../classic/constants.cjs';
import rulesModule from '../../../classic/rules.cjs';
import stateModule from '../../../classic/state.cjs';

const { SEATS, SUITS, RANKS } = constantsModule;
const { boardInfoFor } = rulesModule;
const { ClassicInvariantError, createClassicDealState, createClassicLobbyState } = stateModule;
const UINT32_RANGE = 0x1_0000_0000;

function defaultGetRandomValues() {
  const provider = globalThis.crypto?.getRandomValues;
  if (typeof provider !== 'function') {
    throw new ClassicInvariantError('Web Crypto entropy is unavailable');
  }
  return provider.bind(globalThis.crypto);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function trusted(condition, message) {
  if (!condition) throw new ClassicInvariantError(message);
}

function randomIndex(range, getRandomValues) {
  trusted(Number.isSafeInteger(range) && range > 0 && range <= 52,
    'shuffle range is invalid');
  const limit = Math.floor(UINT32_RANGE / range) * range;
  const sample = new Uint32Array(1);
  do {
    getRandomValues(sample);
  } while (sample[0] >= limit);
  return sample[0] % range;
}

function canonicalDeck() {
  return SUITS.flatMap(suit => RANKS.map(rank => ({ suit, rank })));
}

function handsFromDeck(deck) {
  return Object.fromEntries(SEATS.map((seat, index) => [
    seat,
    deck.slice(index * 13, (index + 1) * 13).map(card => ({ ...card })),
  ]));
}

function validateFixtureHands(hands) {
  try {
    createClassicDealState(createClassicLobbyState(), {
      hands,
      boardInfo: boardInfoFor(1),
    });
  } catch (error) {
    if (error instanceof ClassicInvariantError) throw error;
    throw new ClassicInvariantError('classic test deal fixture is malformed');
  }
}

function parseFixtureDeals(value) {
  let parsed;
  try {
    trusted(typeof value === 'string', 'classic test deal fixture must be JSON text');
    parsed = JSON.parse(value);
  } catch (error) {
    if (error instanceof ClassicInvariantError) throw error;
    throw new ClassicInvariantError('classic test deal fixture is malformed');
  }
  trusted(Array.isArray(parsed) && parsed.length > 0,
    'classic test deal fixture must be a nonempty array');
  for (const hands of parsed) validateFixtureHands(hands);
  return parsed.map(cloneValue);
}

export function createWorkerClassicDeal({ getRandomValues = defaultGetRandomValues() } = {}) {
  trusted(typeof getRandomValues === 'function', 'Web Crypto entropy source is invalid');
  const deck = canonicalDeck();
  for (let upper = deck.length - 1; upper > 0; upper -= 1) {
    const selected = randomIndex(upper + 1, getRandomValues);
    [deck[upper], deck[selected]] = [deck[selected], deck[upper]];
  }
  return handsFromDeck(deck);
}

export function createWorkerClassicDealFactory({
  env,
  getRandomValues = defaultGetRandomValues(),
} = {}) {
  trusted(env === undefined || (env !== null && typeof env === 'object' && !Array.isArray(env)),
    'Worker environment is invalid');
  const fixtureValue = env?.ROOM_FOUNDATION_TEST === 'true'
    ? env.CLASSIC_TEST_DEALS_JSON
    : undefined;
  const fixtures = fixtureValue === undefined ? null : parseFixtureDeals(fixtureValue);

  return function dealFactory({ dealNumber } = {}) {
    let boardInfo;
    try {
      boardInfo = boardInfoFor(dealNumber);
    } catch {
      throw new ClassicInvariantError('deal number is invalid');
    }
    let hands;
    if (fixtures !== null) {
      trusted(dealNumber <= fixtures.length, 'classic test deal fixture is exhausted');
      hands = cloneValue(fixtures[dealNumber - 1]);
    } else {
      hands = createWorkerClassicDeal({ getRandomValues });
    }
    return { hands, boardInfo: { ...boardInfo } };
  };
}
