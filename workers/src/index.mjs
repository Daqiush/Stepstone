export { FeasibilityRoom } from './feasibility-room.mjs';

const ROUTES = new Set(['/__dds/table', '/__dds/solve', '/__dds/metrics', '/__dds/ping']);

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (env.DDS_LOCAL_TEST !== 'true' || !ROUTES.has(path)) {
      return new Response(null, { status: 404 });
    }
    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    }
    const id = env.DDS_FEASIBILITY_ROOM.idFromName('single-feasibility-room');
    return env.DDS_FEASIBILITY_ROOM.get(id).fetch(request);
  },
};
