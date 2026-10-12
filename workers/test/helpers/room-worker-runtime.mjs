import { createTestHarness } from 'wrangler';
import { fileURLToPath } from 'node:url';

const REGISTRY_NAME = 'singleton';

export async function createRoomWorkerRuntime() {
  const server = createTestHarness({
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    workers: [{
      configPath: './workers/wrangler.jsonc',
      vars: { ROOM_FOUNDATION_TEST: 'true' },
    }],
  });
  await server.listen();
  const worker = server.getWorker();

  return {
    async registry(action, input = {}) {
      const response = await server.fetch('/api/rooms/__test/registry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...input }),
      });
      const text = await response.text();
      const body = text === '' ? null : JSON.parse(text);
      return { status: response.status, body };
    },

    async restartRegistry() {
      await worker.evictDurableObject('LOBBY_REGISTRY', { name: REGISTRY_NAME });
    },

    async close() {
      await server.close();
    },
  };
}
