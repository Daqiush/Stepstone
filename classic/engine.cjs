'use strict';

const { SEATS, SUITS, RANKS } = require('./constants.cjs');
const {
  ClassicInvariantError, createClassicDealState, validateClassicState,
} = require('./state.cjs');

const COMMAND_NAMES = Object.freeze([
  'classic.start', 'classic.bid', 'classic.play', 'classic.ready-next',
]);

class ClassicInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClassicInputError';
    this.kind = 'CLIENT_INPUT';
  }
}

function hasExactOwnKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function input(condition, message) {
  if (!condition) throw new ClassicInputError(message);
}

function invariant(condition, message) {
  if (!condition) throw new ClassicInvariantError(message);
}

function validateActor(actor) {
  invariant(hasExactOwnKeys(actor, ['role', 'seat']), 'actor has an invalid shape');
  invariant(['OWNER', 'PLAYER', 'SPECTATOR'].includes(actor.role), 'actor role is invalid');
  if (actor.role === 'PLAYER') {
    invariant(SEATS.includes(actor.seat), 'player actor must have a seat');
  } else if (actor.role === 'SPECTATOR') {
    invariant(actor.seat === null, 'spectator actor cannot have a seat');
  } else {
    invariant(actor.seat === null || SEATS.includes(actor.seat), 'owner actor seat is invalid');
  }
}

function validateOccupiedSeats(occupiedSeats) {
  invariant(Array.isArray(occupiedSeats), 'occupiedSeats must be an array');
  invariant(Object.getPrototypeOf(occupiedSeats) === Array.prototype,
    'occupiedSeats must use the canonical array prototype');
  const expectedKeys = [
    ...Array.from({ length: occupiedSeats.length }, (_, index) => String(index)),
    'length',
  ];
  const ownKeys = Reflect.ownKeys(occupiedSeats);
  invariant(ownKeys.length === expectedKeys.length
    && expectedKeys.every(key => Object.hasOwn(occupiedSeats, key))
    && ownKeys.every(key => typeof key === 'string' && expectedKeys.includes(key)),
  'occupiedSeats must be a dense exact array');
  invariant(occupiedSeats.every(seat => SEATS.includes(seat)), 'occupiedSeats contains an invalid seat');
  invariant(new Set(occupiedSeats).size === occupiedSeats.length,
    'occupiedSeats contains a duplicate seat');
}

function validateContext(context, apply) {
  invariant(hasExactOwnKeys(context, apply
    ? ['actor', 'occupiedSeats', 'deal']
    : ['actor', 'occupiedSeats']), 'command context has an invalid shape');
  validateActor(context.actor);
  validateOccupiedSeats(context.occupiedSeats);
}

function validateCommand(command) {
  input(hasExactOwnKeys(command, ['name', 'payload']), 'command has an invalid shape');
  input(typeof command.name === 'string' && COMMAND_NAMES.includes(command.name),
    'command name is invalid');
  input(command.payload !== null && typeof command.payload === 'object'
    && !Array.isArray(command.payload), 'command payload must be an object');
}

function validateRevisionPayload(payload) {
  input(hasExactOwnKeys(payload, ['expectedRevision']), 'command payload has an invalid shape');
  input(Number.isSafeInteger(payload.expectedRevision) && payload.expectedRevision >= 0,
    'expectedRevision must be a nonnegative safe integer');
}

function actorCanMutate(actor, occupiedSeats) {
  if (actor.role === 'SPECTATOR' || actor.seat === null) return false;
  return occupiedSeats.includes(actor.seat);
}

function domain(code) {
  return { ok: false, code };
}

function dealNeed(needsDeal, nextDealNumber = null) {
  return { ok: true, needsDeal, nextDealNumber };
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function biddingUpdatedEvent(state) {
  return {
    name: 'classic.bidding-updated',
    payload: {
      biddingHistory: cloneValue(state.biddingHistory),
      currentBidder: state.currentBidder,
      currentContract: cloneValue(state.currentContract),
      consecutivePasses: state.consecutivePasses,
    },
  };
}

function preflightStart(state, payload, context) {
  validateRevisionPayload(payload);
  if (context.actor.role === 'SPECTATOR') return domain('CLASSIC_FORBIDDEN');
  if (context.actor.role !== 'OWNER') return domain('CLASSIC_FORBIDDEN');
  if (state.phase !== 'LOBBY') return domain('CLASSIC_WRONG_PHASE');
  if (context.occupiedSeats.length !== 4 || !SEATS.every(seat => context.occupiedSeats.includes(seat))) {
    return domain('CLASSIC_SEATS_INCOMPLETE');
  }
  return dealNeed(true, state.dealNumber + 1);
}

function validateBidPayload(payload) {
  input(hasExactOwnKeys(payload, ['expectedRevision', 'bid', 'alert', 'explain']),
    'bid payload has an invalid shape');
  input(Number.isSafeInteger(payload.expectedRevision) && payload.expectedRevision >= 0,
    'expectedRevision must be a nonnegative safe integer');
  input(typeof payload.bid === 'string', 'bid must be a string');
  input(typeof payload.alert === 'boolean', 'alert must be boolean');
  input(payload.explain === null || (typeof payload.explain === 'string'
    && [...payload.explain].length <= 500), 'explain must be bounded text or null');
  input(payload.alert || payload.explain === null, 'unalerted bid cannot have an explanation');
}

function preflightBid(state, payload, context) {
  validateBidPayload(payload);
  if (!actorCanMutate(context.actor, context.occupiedSeats)) return domain('CLASSIC_FORBIDDEN');
  if (state.phase !== 'BIDDING') return domain('CLASSIC_WRONG_PHASE');
  if (context.actor.seat !== state.currentBidder) return domain('CLASSIC_NOT_YOUR_TURN');
  const { validateBid } = require('./rules.cjs');
  return validateBid(state, context.actor.seat, payload.bid).ok
    ? dealNeed(false)
    : domain('CLASSIC_INVALID_BID');
}

function preflightReady(state, payload, context) {
  validateRevisionPayload(payload);
  if (!actorCanMutate(context.actor, context.occupiedSeats)) return domain('CLASSIC_FORBIDDEN');
  if (state.phase !== 'SCORING') return domain('CLASSIC_WRONG_PHASE');
  const readyStatus = { ...state.readyStatus, [context.actor.seat]: !state.readyStatus[context.actor.seat] };
  const needsDeal = SEATS.every(seat => readyStatus[seat]);
  return dealNeed(needsDeal, needsDeal ? state.dealNumber + 1 : null);
}

function validatePlayPayload(payload) {
  input(hasExactOwnKeys(payload, ['expectedRevision', 'card']),
    'play payload has an invalid shape');
  input(Number.isSafeInteger(payload.expectedRevision) && payload.expectedRevision >= 0,
    'expectedRevision must be a nonnegative safe integer');
  input(hasExactOwnKeys(payload.card, ['suit', 'rank']), 'play card has an invalid shape');
  input(SUITS.includes(payload.card.suit) && RANKS.includes(payload.card.rank),
    'play card must be canonical');
}

function preflightPlay(state, payload, context) {
  validatePlayPayload(payload);
  if (!actorCanMutate(context.actor, context.occupiedSeats)) return domain('CLASSIC_FORBIDDEN');
  if (state.phase !== 'PLAYING') return domain('CLASSIC_WRONG_PHASE');
  const { validatePlay } = require('./rules.cjs');
  const result = validatePlay(state, context.actor.seat, payload.card);
  return result.ok ? dealNeed(false) : domain(result.code);
}

function applyStart(state, context) {
  const next = createClassicDealState(state, context.deal);
  return {
    ok: true,
    state: next,
    events: [
      {
        name: 'classic.started',
        payload: { dealNumber: next.dealNumber, boardInfo: cloneValue(next.boardInfo) },
      },
      biddingUpdatedEvent(next),
    ],
    effects: [{ type: 'classic.compute-dd-table', dealNumber: next.dealNumber }],
    reply: { name: 'classic.start', phase: 'BIDDING' },
  };
}

function applyBid(state, payload, context) {
  invariant(context.deal === null, 'bid command cannot carry a trusted deal');
  const { nextSeat, parseBid } = require('./rules.cjs');
  const next = {
    ...state,
    biddingHistory: [...state.biddingHistory, {
      seat: context.actor.seat,
      bid: payload.bid,
      alert: payload.alert ? true : null,
      explain: payload.explain,
      qa: [],
    }],
  };

  const parsed = parseBid(payload.bid);
  if (parsed.kind === 'pass') {
    next.consecutivePasses += 1;
  } else {
    next.consecutivePasses = 0;
    if (parsed.kind === 'contract') {
      next.currentContract = {
        level: parsed.level,
        suit: parsed.suit,
        seat: context.actor.seat,
        doubled: false,
        redoubled: false,
        doublerSeat: null,
      };
    } else if (parsed.kind === 'double') {
      next.currentContract = {
        ...next.currentContract,
        doubled: true,
        doublerSeat: context.actor.seat,
      };
    } else {
      next.currentContract = {
        ...next.currentContract,
        redoubled: true,
        doublerSeat: context.actor.seat,
      };
    }
  }

  const passedOut = next.currentContract === null && next.consecutivePasses === 4;
  const contracted = next.currentContract !== null && next.consecutivePasses === 3;
  if (passedOut) {
    const { buildBoardScore } = require('./scoring.cjs');
    next.currentBidder = null;
    const score = buildBoardScore(next, { type: 'passed-out' });
    next.phase = 'SCORING';
    next.boardScores = [...state.boardScores, score];
    validateClassicState(next);
    return {
      ok: true,
      state: next,
      events: [
        biddingUpdatedEvent(next),
        {
          name: 'classic.finished',
          payload: { reason: 'passed-out', dealNumber: next.dealNumber, score: score.score },
        },
      ],
      effects: [],
      reply: { name: 'classic.bid', phase: 'SCORING' },
    };
  }
  if (contracted) {
    const { declarerFor, partnerOf } = require('./rules.cjs');
    next.phase = 'PLAYING';
    next.currentBidder = null;
    next.declarer = declarerFor(next.biddingHistory, next.currentContract);
    next.dummy = partnerOf(next.declarer);
    next.leader = nextSeat(next.declarer);
    next.currentPlayer = next.leader;
    validateClassicState(next);
    return {
      ok: true,
      state: next,
      events: [
        biddingUpdatedEvent(next),
        {
          name: 'classic.bidding-ended',
          payload: {
            contract: cloneValue(next.currentContract),
            declarer: next.declarer,
            dummy: next.dummy,
            leader: next.leader,
            biddingHistory: cloneValue(next.biddingHistory),
          },
        },
      ],
      effects: [],
      reply: { name: 'classic.bid', phase: 'PLAYING' },
    };
  }
  next.currentBidder = nextSeat(context.actor.seat);
  validateClassicState(next);
  return {
    ok: true,
    state: next,
    events: [biddingUpdatedEvent(next)],
    effects: [],
    reply: { name: 'classic.bid', phase: 'BIDDING' },
  };
}

function applyPlay(state, payload, context) {
  invariant(context.deal === null, 'play command cannot carry a trusted deal');
  const {
    nextSeat, sideOf, trickWinner, validatePlay,
  } = require('./rules.cjs');
  const validation = validatePlay(state, context.actor.seat, payload.card);
  invariant(validation.ok, 'preflight-approved play became invalid');
  const { effectiveSeat } = validation;
  const hand = state.hands[effectiveSeat];
  const cardIndex = hand.findIndex(card => (
    card.suit === payload.card.suit && card.rank === payload.card.rank
  ));
  invariant(cardIndex !== -1, 'preflight-approved card is no longer held');

  const playedCard = cloneValue(payload.card);
  const currentTrick = [
    ...state.currentTrick,
    { seat: effectiveSeat, card: cloneValue(playedCard) },
  ];
  const next = {
    ...state,
    hands: {
      ...state.hands,
      [effectiveSeat]: [...hand.slice(0, cardIndex), ...hand.slice(cardIndex + 1)],
    },
    currentTrick,
    currentPlayer: nextSeat(effectiveSeat),
  };
  const revealDummy = !state.dummyRevealed
    && state.completedTricks.length === 0
    && currentTrick.length === 1;
  if (revealDummy) next.dummyRevealed = true;

  const events = [];
  if (revealDummy) {
    events.push({ name: 'classic.dummy-revealed', payload: { dummy: next.dummy } });
  }
  events.push({
    name: 'classic.card-played',
    payload: {
      seat: effectiveSeat,
      card: cloneValue(playedCard),
      currentTrick: cloneValue(currentTrick),
    },
  });
  if (currentTrick.length === 4) {
    const winner = trickWinner(currentTrick, state.currentContract.suit);
    const trick = { cards: cloneValue(currentTrick), winner };
    next.currentTrick = [];
    next.completedTricks = [...state.completedTricks, trick];
    next.currentPlayer = winner;
    if (sideOf(winner) === 'NS') next.nsTricks = state.nsTricks + 1;
    else next.ewTricks = state.ewTricks + 1;
    events.push({
      name: 'classic.trick-ended',
      payload: {
        trick: cloneValue(trick),
        winner,
        nsTricks: next.nsTricks,
        ewTricks: next.ewTricks,
      },
    });
    if (next.completedTricks.length === 13) {
      const { buildBoardScore } = require('./scoring.cjs');
      const score = buildBoardScore(next, { type: 'played' });
      next.phase = 'SCORING';
      next.boardScores = [...state.boardScores, score];
      events.push({
        name: 'classic.finished',
        payload: {
          reason: 'played',
          dealNumber: next.dealNumber,
          contract: cloneValue(next.currentContract),
          declarer: next.declarer,
          nsTricks: next.nsTricks,
          ewTricks: next.ewTricks,
          score: score.score,
        },
      });
    }
  }
  validateClassicState(next);
  return {
    ok: true,
    state: next,
    events,
    effects: [],
    reply: { name: 'classic.play', phase: next.phase },
  };
}

function applyReady(state, context) {
  const readyStatus = {
    ...state.readyStatus,
    [context.actor.seat]: !state.readyStatus[context.actor.seat],
  };
  const allReady = SEATS.every(seat => readyStatus[seat]);
  const readyEvent = {
    name: 'classic.ready-updated',
    payload: { readyStatus: cloneValue(readyStatus) },
  };
  if (!allReady) {
    invariant(context.deal === null, 'ready command cannot carry an unused trusted deal');
    const next = { ...state, readyStatus };
    validateClassicState(next);
    return {
      ok: true,
      state: next,
      events: [readyEvent],
      effects: [],
      reply: { name: 'classic.ready-next', phase: 'SCORING' },
    };
  }

  const readyState = { ...state, readyStatus };
  const next = createClassicDealState(readyState, context.deal);
  return {
    ok: true,
    state: next,
    events: [
      readyEvent,
      {
        name: 'classic.started',
        payload: { dealNumber: next.dealNumber, boardInfo: cloneValue(next.boardInfo) },
      },
      biddingUpdatedEvent(next),
    ],
    effects: [{ type: 'classic.compute-dd-table', dealNumber: next.dealNumber }],
    reply: { name: 'classic.ready-next', phase: 'BIDDING' },
  };
}

function dispatch(state, command, context, { apply }) {
  validateClassicState(state);
  validateCommand(command);
  validateContext(context, apply);
  let result;
  if (command.name === 'classic.start') result = preflightStart(state, command.payload, context);
  else if (command.name === 'classic.bid') result = preflightBid(state, command.payload, context);
  else if (command.name === 'classic.ready-next') result = preflightReady(state, command.payload, context);
  else result = preflightPlay(state, command.payload, context);

  if (!apply || !result.ok) return result;
  if (command.name === 'classic.start') return applyStart(state, context);
  if (command.name === 'classic.bid') return applyBid(state, command.payload, context);
  if (command.name === 'classic.play') return applyPlay(state, command.payload, context);
  if (command.name === 'classic.ready-next') return applyReady(state, context);
  throw new ClassicInvariantError(`${command.name} apply transition is not implemented yet`);
}

function preflightClassicCommand(state, command, context) {
  return dispatch(state, command, context, { apply: false });
}

function applyClassicCommand(state, command, context) {
  return dispatch(state, command, context, { apply: true });
}

module.exports = { ClassicInputError, preflightClassicCommand, applyClassicCommand };
