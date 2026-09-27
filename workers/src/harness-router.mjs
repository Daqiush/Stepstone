import { authorizeHarnessRequest } from './remote-test-auth.mjs';

const ROUTES = new Set(['/__dds/table', '/__dds/solve', '/__dds/metrics', '/__dds/ping', '/__dds/ordered-probe']);

export async function fetchHarness(request, env) {
  const path = new URL(request.url).pathname;
  if (!ROUTES.has(path)) return new Response(null, { status: 404 });

  const authorization = await authorizeHarnessRequest(request, env);
  if (authorization.mode === 'deny') return authorization.response;
  if (authorization.mode === 'local') {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    const id = env.DDS_FEASIBILITY_ROOM.idFromName('single-feasibility-room');
    return env.DDS_FEASIBILITY_ROOM.get(id).fetch(request);
  }

  const { identity, body } = authorization;
  const id = env.DDS_FEASIBILITY_ROOM.idFromName(`remote-feasibility:${identity.runId}:${identity.shard}`);
  const headers = new Headers({
    'x-dds-run-id': identity.runId,
    'x-dds-operation-id': identity.operationId,
    'x-dds-request-hash': identity.requestHash,
    'x-dds-shard': identity.shard,
  });
  const forwarded = new Request(request.url, { method: 'POST', headers, body });
  return env.DDS_FEASIBILITY_ROOM.get(id).fetch(forwarded);
}
