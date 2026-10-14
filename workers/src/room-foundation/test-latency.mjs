const STAGE = /^[A-Za-z][A-Za-z0-9]*$/u;

export function createTestLatencyController(env) {
  if (env?.ROOM_FOUNDATION_TEST !== 'true') return null;
  let elapsedMs = 0;
  let delays = Object.freeze({});

  return Object.freeze({
    configure(input = {}) {
      const proposed = input?.delays;
      if (proposed === null || typeof proposed !== 'object' || Array.isArray(proposed)) {
        return false;
      }
      const entries = Object.entries(proposed);
      if (entries.some(([stage, milliseconds]) => !STAGE.test(stage)
        || !Number.isSafeInteger(milliseconds)
        || milliseconds < 0
        || milliseconds > 5_000)) return false;
      delays = Object.freeze(Object.fromEntries(entries));
      elapsedMs = 0;
      return true;
    },
    advance(stage) {
      elapsedMs += delays[stage] ?? 0;
    },
    snapshot() {
      return Object.freeze({ elapsedMs });
    },
  });
}
