// This is intentionally dependency-free so the Node soak runner and Worker
// authorize exactly the same bytes without normalizing request JSON.
export function canonicalHarnessRequest(route, bodyText) {
  if (typeof route !== 'string' || typeof bodyText !== 'string') throw new TypeError('route and bodyText must be strings');
  return JSON.stringify({ body: bodyText, route });
}
