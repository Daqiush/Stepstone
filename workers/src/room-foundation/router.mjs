import { fetchHarness } from '../harness-router.mjs';
import { publicErrorResponse } from './protocol.mjs';

const ROOM_ROOT = '/api/rooms';
const JOIN_ROUTE = /^\/api\/rooms\/[0-9]{3}\/join$/u;
const WEBSOCKET_ROUTE = /^\/api\/rooms\/[0-9]{3}\/[1-9][0-9]*\/ws$/u;

function opaqueNotFound() {
  return new Response(null, { status: 404 });
}

function methodNotAllowed(allow) {
  return new Response(null, { status: 405, headers: { allow } });
}

function isRoomPath(path) {
  return path === ROOM_ROOT || path.startsWith(`${ROOM_ROOT}/`);
}

export function fetchRoomFoundation(request) {
  const path = new URL(request.url).pathname;
  let allowedMethod;

  if (path === ROOM_ROOT || JOIN_ROUTE.test(path)) allowedMethod = 'POST';
  else if (WEBSOCKET_ROUTE.test(path)) allowedMethod = 'GET';
  else return opaqueNotFound();

  if (request.method !== allowedMethod) return methodNotAllowed(allowedMethod);
  return publicErrorResponse('ROOM_NOT_FOUND');
}

export function fetchWorker(request, env) {
  const path = new URL(request.url).pathname;
  if (env?.ROOM_FOUNDATION_TEST === 'true' && isRoomPath(path)) {
    return fetchRoomFoundation(request);
  }
  return fetchHarness(request, env);
}

class FailClosedRoomObject {
  fetch() {
    return opaqueNotFound();
  }
}

export class LobbyRegistry extends FailClosedRoomObject {}
export class StepstoneRoom extends FailClosedRoomObject {}
