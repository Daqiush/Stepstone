import { fetchHarness } from '../harness-router.mjs';
import { publicErrorResponse } from './protocol.mjs';
import { LobbyRegistry, StepstoneRoom } from './lobby-registry.mjs';

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

async function registryTestBridge(request, env) {
  let input;
  try { input = await request.json(); }
  catch { return Response.json({ ok: false, error: { code: 'INVALID_REQUEST' } }, { status: 400 }); }
  const id = env.LOBBY_REGISTRY.idFromName('singleton');
  const registry = env.LOBBY_REGISTRY.get(id);
  let rpcResult;
  switch (input?.action) {
    case 'allocate': rpcResult = await registry.allocate(input); break;
    case 'activate': rpcResult = await registry.activate(input); break;
    case 'markReleasePending': rpcResult = await registry.markReleasePending(input); break;
    case 'release': rpcResult = await registry.release(input); break;
    case 'reconcile': rpcResult = await registry.testReconcile(input); break;
    case 'inspect': rpcResult = await registry.testInspect(); break;
    case 'seedCapacity': rpcResult = await registry.testSeedCapacity(input); break;
    case 'setRoomInitialization': {
      const roomId = env.STEPSTONE_ROOM.idFromName(`${input.code}:${input.incarnation}`);
      rpcResult = await env.STEPSTONE_ROOM.get(roomId).testSetInitialization(input);
      break;
    }
    default:
      return new Response(null, { status: 404 });
  }
  const status = rpcResult.ok ? 200 : rpcResult.error === 'SERVICE_CAPACITY' ? 503
    : rpcResult.error === 'INVALID_REQUEST' ? 400 : 409;
  return Response.json(rpcResult.ok
    ? rpcResult
    : { ok: false, error: { code: rpcResult.error } }, { status });
}

export function fetchRoomFoundation(request, env) {
  const path = new URL(request.url).pathname;
  let allowedMethod;

  if (path === '/api/rooms/__test/registry') {
    if (env?.ROOM_FOUNDATION_TEST !== 'true') return opaqueNotFound();
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return registryTestBridge(request, env);
  }

  if (path === ROOM_ROOT || JOIN_ROUTE.test(path)) allowedMethod = 'POST';
  else if (WEBSOCKET_ROUTE.test(path)) allowedMethod = 'GET';
  else return opaqueNotFound();

  if (request.method !== allowedMethod) return methodNotAllowed(allowedMethod);
  return publicErrorResponse('ROOM_NOT_FOUND');
}

export function fetchWorker(request, env) {
  const path = new URL(request.url).pathname;
  if (env?.ROOM_FOUNDATION_TEST === 'true' && isRoomPath(path)) {
    return fetchRoomFoundation(request, env);
  }
  return fetchHarness(request, env);
}

export { LobbyRegistry, StepstoneRoom };
