import engineModule from '../../../classic/engine.cjs';
import stateModule from '../../../classic/state.cjs';

const { ClassicInputError, applyClassicCommand, preflightClassicCommand } = engineModule;
const { ClassicInvariantError } = stateModule;
const SEATS = Object.freeze(['N', 'E', 'S', 'W']);
const PUBLIC_DOMAIN_CODES = new Set([
  'CLASSIC_WRONG_PHASE',
  'CLASSIC_FORBIDDEN',
  'CLASSIC_SEATS_INCOMPLETE',
  'CLASSIC_NOT_YOUR_TURN',
  'CLASSIC_INVALID_BID',
  'CLASSIC_CARD_NOT_HELD',
  'CLASSIC_MUST_FOLLOW_SUIT',
]);
const PUBLIC_RANKS = Object.freeze({
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneOwnEntries(value) {
  return Object.fromEntries(Object.entries(value));
}

function normalizedPayload(command) {
  const payload = command?.payload;
  if (!isPlainObject(payload)) return payload;
  const normalized = cloneOwnEntries(payload);
  if (command?.name !== 'classic.play' || !isPlainObject(payload.card)) return normalized;
  normalized.card = cloneOwnEntries(payload.card);
  if (Object.hasOwn(payload.card, 'rank')) {
    if (!Number.isInteger(payload.card.rank)
      || !Object.hasOwn(PUBLIC_RANKS, payload.card.rank)) {
      throw new ClassicInputError('Worker card rank must be an integer from 2 through 14');
    }
    normalized.card.rank = PUBLIC_RANKS[payload.card.rank];
  }
  return normalized;
}

function contextFromAuthority(session, authorities) {
  if (!isPlainObject(session)
    || !Number.isSafeInteger(session.incarnation)
    || session.incarnation < 1
    || !['OWNER', 'PLAYER', 'SPECTATOR'].includes(session.role)
    || (session.role === 'SPECTATOR'
      ? session.seat !== null
      : !SEATS.includes(session.seat))
    || !(authorities instanceof Map)) {
    throw new ClassicInvariantError('authenticated Worker authority is malformed');
  }
  const occupiedSeats = [];
  for (const authority of authorities.values()) {
    if (!isPlainObject(authority)) {
      throw new ClassicInvariantError('Worker authority cache is malformed');
    }
    if (authority.incarnation !== session.incarnation) continue;
    if (!['OWNER', 'PLAYER', 'SPECTATOR'].includes(authority.role)
      || (authority.role === 'SPECTATOR'
        ? authority.seat !== null
        : !SEATS.includes(authority.seat))) {
      throw new ClassicInvariantError('Worker authority cache is malformed');
    }
    if (authority.role !== 'SPECTATOR') occupiedSeats.push(authority.seat);
  }
  occupiedSeats.sort((left, right) => SEATS.indexOf(left) - SEATS.indexOf(right));
  return {
    actor: { role: session.role, seat: session.seat },
    occupiedSeats,
  };
}

function mappedDomain(result) {
  if (result.ok || PUBLIC_DOMAIN_CODES.has(result.code)) return result;
  return { ok: false, code: 'SERVICE_CAPACITY' };
}

export function applyWorkerClassicCommand({
  state,
  command,
  session,
  authorities,
  dealFactory,
} = {}) {
  try {
    const coreCommand = {
      name: command?.name,
      payload: normalizedPayload(command),
    };
    const baseContext = contextFromAuthority(session, authorities);
    const preflight = preflightClassicCommand(state, coreCommand, baseContext);
    if (!preflight.ok) return mappedDomain(preflight);
    const deal = preflight.needsDeal
      ? dealFactory({ dealNumber: preflight.nextDealNumber })
      : null;
    return mappedDomain(applyClassicCommand(state, coreCommand, { ...baseContext, deal }));
  } catch (error) {
    if (error instanceof ClassicInputError) return { ok: false, code: 'INVALID_COMMAND' };
    if (error instanceof ClassicInvariantError) return { ok: false, code: 'SERVICE_CAPACITY' };
    return { ok: false, code: 'SERVICE_CAPACITY' };
  }
}
