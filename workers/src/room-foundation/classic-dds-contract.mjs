export const CLASSIC_DDS_ACTION_ID = 'classic-dd-table';
export const CLASSIC_DDS_ACTION_KIND = 'classic-dd-table';
export const CLASSIC_DDS_BACKSTOP_MS = 5_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SEATS = Object.freeze(['N', 'E', 'S', 'W']);
const SUITS = Object.freeze(['S', 'H', 'D', 'C']);
const RANKS = Object.freeze({
  2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
});

function exactObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function denseArray(value, length) {
  if (!Array.isArray(value) || value.length !== length) return false;
  const own = Reflect.ownKeys(value);
  const expected = [...Array.from({ length }, (_, index) => String(index)), 'length'];
  return own.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function validTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function parseClassicDdsActionPayload(value) {
  if (!exactObject(value, ['generationId', 'dealNumber', 'attempt'])
    || typeof value.generationId !== 'string'
    || !UUID.test(value.generationId)
    || !Number.isSafeInteger(value.dealNumber)
    || value.dealNumber < 1
    || !Number.isSafeInteger(value.attempt)
    || value.attempt < 1
    || value.attempt > 3) {
    throw new TypeError('classic DDS action payload is malformed');
  }
  return {
    generationId: value.generationId,
    dealNumber: value.dealNumber,
    attempt: value.attempt,
  };
}

export function buildClassicDdsAction({ dealNumber, now, generationId = crypto.randomUUID() } = {}) {
  if (!validTime(now) || now > Number.MAX_SAFE_INTEGER - CLASSIC_DDS_BACKSTOP_MS) {
    throw new TypeError('classic DDS action time is malformed');
  }
  const payload = parseClassicDdsActionPayload({ generationId, dealNumber, attempt: 1 });
  return {
    actionId: CLASSIC_DDS_ACTION_ID,
    kind: CLASSIC_DDS_ACTION_KIND,
    dueAt: now + CLASSIC_DDS_BACKSTOP_MS,
    payload,
  };
}

export function retryClassicDdsAction(value, now) {
  const payload = parseClassicDdsActionPayload(value);
  if (!validTime(now)) throw new TypeError('classic DDS retry time is malformed');
  if (payload.attempt === 3) return null;
  const delay = payload.attempt === 1 ? 5_000 : 30_000;
  if (now > Number.MAX_SAFE_INTEGER - delay) {
    throw new TypeError('classic DDS retry time is malformed');
  }
  return {
    payload: { ...payload, attempt: payload.attempt + 1 },
    dueAt: now + delay,
  };
}

export function classicHandsToInteger(hands) {
  if (!exactObject(hands, SEATS)) throw new TypeError('classic DDS hands are malformed');
  const seen = new Set();
  const converted = {};
  for (const seat of SEATS) {
    if (!denseArray(hands[seat], 13)) throw new TypeError('classic DDS hand is malformed');
    converted[seat] = hands[seat].map((card) => {
      if (!exactObject(card, ['suit', 'rank'])
        || !SUITS.includes(card.suit)
        || typeof card.rank !== 'string'
        || !Object.hasOwn(RANKS, card.rank)) {
        throw new TypeError('classic DDS card is malformed');
      }
      const key = `${card.suit}${card.rank}`;
      if (seen.has(key)) throw new TypeError('classic DDS hands contain duplicate cards');
      seen.add(key);
      return { suit: card.suit, rank: RANKS[card.rank] };
    });
  }
  if (seen.size !== 52) throw new TypeError('classic DDS hands are incomplete');
  return converted;
}

export function validateClassicDdsTable(table) {
  if (!denseArray(table, 5)
    || !table.every(result => denseArray(result, 4)
      && result.every(value => Number.isInteger(value) && value >= 0 && value <= 13))) {
    throw new TypeError('classic DDS table is malformed');
  }
  return table.map(result => [...result]);
}
