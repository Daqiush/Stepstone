import { fetchHarness } from '../harness-router.mjs';
import { LIMITS } from './constants.mjs';
import {
  ProtocolError,
  assertHttpJsonSize,
  fingerprintCreateRequest,
  fingerprintJoinRequest,
  hashReconnectToken,
  parseCreateRequest,
  parseJoinRequest,
  publicErrorResponse,
} from './protocol.mjs';
import { LobbyRegistry } from './lobby-registry.mjs';
import { StepstoneRoom } from './stepstone-room.mjs';

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

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function safeRpcError(code, allowed) {
  return publicErrorResponse(allowed.includes(code) ? code : 'SERVICE_CAPACITY');
}

async function parseHttpJson(request, parser) {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0) throw new ProtocolError('INVALID_REQUEST');
    if (length > LIMITS.httpJsonBytes) throw new ProtocolError('INVALID_REQUEST');
  }
  const bytes = await request.arrayBuffer();
  assertHttpJsonSize(bytes);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ProtocolError('INVALID_REQUEST'); }
  let value;
  try { value = JSON.parse(text); }
  catch { throw new ProtocolError('INVALID_REQUEST'); }
  return parser(value);
}

function registryStub(env) {
  const id = env.LOBBY_REGISTRY.idFromName('singleton');
  return env.LOBBY_REGISTRY.get(id);
}

function roomStub(env, code, incarnation) {
  const id = env.STEPSTONE_ROOM.idFromName(`${code}:${incarnation}`);
  return env.STEPSTONE_ROOM.get(id);
}

async function createRoom(request, env) {
  try {
    const parsed = await parseHttpJson(request, parseCreateRequest);
    const [requestHash, tokenHash] = await Promise.all([
      fingerprintCreateRequest(parsed),
      hashReconnectToken(parsed.reconnectToken),
    ]);
    const registry = registryStub(env);
    const allocation = await registry.allocate({ requestId: parsed.requestId, requestHash });
    if (!allocation?.ok) {
      return safeRpcError(allocation?.error, ['REQUEST_CONFLICT', 'SERVICE_CAPACITY']);
    }
    if (allocation.value.status === 'ACTIVE') return jsonResponse(allocation.value.response);
    if (allocation.value.status !== 'PROVISIONING') return publicErrorResponse('SERVICE_CAPACITY');

    const {
      code, incarnation, leaseId, leaseExpiresAt,
    } = allocation.value;
    const initialized = await roomStub(env, code, incarnation).initialize({
      code,
      incarnation,
      leaseId,
      leaseExpiresAt,
      requestId: parsed.requestId,
      requestHash,
      tokenHash,
    });
    if (!initialized?.ok) {
      return safeRpcError(initialized?.error, ['REQUEST_CONFLICT']);
    }
    const activated = await registry.activate({
      requestId: parsed.requestId,
      code,
      incarnation,
      leaseId,
      response: initialized.value.response,
    });
    if (!activated?.ok) return publicErrorResponse('SERVICE_CAPACITY');
    return jsonResponse(activated.value.response);
  } catch (error) {
    if (error instanceof ProtocolError) return publicErrorResponse(error.code);
    return publicErrorResponse('SERVICE_CAPACITY');
  }
}

async function joinRoom(request, env, code) {
  try {
    const parsed = await parseHttpJson(request, parseJoinRequest);
    const [requestHash, tokenHash] = await Promise.all([
      fingerprintJoinRequest(parsed),
      hashReconnectToken(parsed.reconnectToken),
    ]);
    const active = await registryStub(env).lookupActive({ code });
    if (!active?.ok) return publicErrorResponse('ROOM_NOT_FOUND');
    const joined = await roomStub(env, code, active.value.incarnation).join({
      code,
      incarnation: active.value.incarnation,
      requestId: parsed.requestId,
      requestHash,
      tokenHash,
      requestedRole: parsed.requestedRole,
    });
    if (!joined?.ok) {
      return safeRpcError(joined?.error, [
        'REQUEST_CONFLICT', 'ROOM_CAPACITY_EXCEEDED', 'ROOM_NOT_FOUND', 'ROOM_EXPIRED',
      ]);
    }
    return jsonResponse(joined.value.response);
  } catch (error) {
    if (error instanceof ProtocolError) return publicErrorResponse(error.code);
    return publicErrorResponse('SERVICE_CAPACITY');
  }
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
    case 'lookupActive': rpcResult = await registry.lookupActive(input); break;
    case 'markReleasePending': rpcResult = await registry.markReleasePending(input); break;
    case 'release': rpcResult = await registry.release(input); break;
    case 'allocateAt': rpcResult = await registry.testAllocateAt(input); break;
    case 'activateAt': rpcResult = await registry.testActivateAt(input); break;
    case 'markReleasePendingAt': rpcResult = await registry.testMarkReleasePendingAt(input); break;
    case 'releaseAt': rpcResult = await registry.testReleaseAt(input); break;
    case 'reconcile': rpcResult = await registry.testReconcile(input); break;
    case 'recoverAlarmAt': rpcResult = await registry.testRecoverAlarmAt(input); break;
    case 'inspect': rpcResult = await registry.testInspect(); break;
    case 'seedCapacity': rpcResult = await registry.testSeedCapacity(input); break;
    case 'setRoomInitialization': {
      const roomId = env.STEPSTONE_ROOM.idFromName(`${input.code}:${input.incarnation}`);
      rpcResult = await env.STEPSTONE_ROOM.get(roomId).testSetInitialization(input);
      break;
    }
    case 'setRoomInspectionFault': {
      const roomId = env.STEPSTONE_ROOM.idFromName(`${input.code}:${input.incarnation}`);
      rpcResult = await env.STEPSTONE_ROOM.get(roomId).testSetInspectionFault(input);
      break;
    }
    case 'setRoomInitializationFault': {
      const roomId = env.STEPSTONE_ROOM.idFromName(`${input.code}:${input.incarnation}`);
      rpcResult = await env.STEPSTONE_ROOM.get(roomId).testSetInitializationFault(input);
      break;
    }
    case 'inspectRoom': {
      const roomId = env.STEPSTONE_ROOM.idFromName(`${input.code}:${input.incarnation}`);
      rpcResult = await env.STEPSTONE_ROOM.get(roomId).testInspect(input);
      break;
    }
    case 'initializeRoomAt': {
      const roomId = env.STEPSTONE_ROOM.idFromName(`${input.code}:${input.incarnation}`);
      rpcResult = await env.STEPSTONE_ROOM.get(roomId).testInitializeAt(input);
      break;
    }
    case 'probeRoomTokenStorage': {
      const roomId = env.STEPSTONE_ROOM.idFromName(`${input.code}:${input.incarnation}`);
      rpcResult = await env.STEPSTONE_ROOM.get(roomId).testProbeTokenStorage(input);
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
  if (!env?.LOBBY_REGISTRY || !env?.STEPSTONE_ROOM) return publicErrorResponse('ROOM_NOT_FOUND');
  if (path === ROOM_ROOT) return createRoom(request, env);
  const join = path.match(/^\/api\/rooms\/(\d{3})\/join$/u);
  if (join) return joinRoom(request, env, join[1]);
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
