import { createTestHarness, unstable_dev } from 'wrangler';
import { fileURLToPath } from 'node:url';

const REGISTRY_NAME = 'singleton';
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url));
const ENTRY_PATH = fileURLToPath(new URL('../../src/index.mjs', import.meta.url));

export async function createRoomWorkerRuntime({ persistenceDirectory = null } = {}) {
  let server;
  let worker;

  async function start() {
    if (persistenceDirectory !== null) {
      server = await unstable_dev(ENTRY_PATH, {
        config: CONFIG_PATH,
        local: true,
        persist: true,
        persistTo: persistenceDirectory,
        vars: { ROOM_FOUNDATION_TEST: 'true' },
        logLevel: 'none',
        experimental: { disableDevRegistry: true, disableExperimentalWarning: true },
      });
      worker = null;
      return;
    }
    server = createTestHarness({
      root: ROOT,
      workers: [{
        configPath: './workers/wrangler.jsonc',
        vars: { ROOM_FOUNDATION_TEST: 'true' },
      }],
    });
    await server.listen();
    worker = server.getWorker();
  }

  await start();

  return {
    async request(path, init = {}) {
      const response = await server.fetch(path, init);
      const text = await response.text();
      let body = null;
      if (text !== '') {
        try { body = JSON.parse(text); }
        catch { body = text; }
      }
      return { status: response.status, headers: response.headers, body, text };
    },

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

    async room(action, input = {}) {
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
      if (!worker) throw new Error('Durable Object eviction requires the test harness runtime');
      await worker.evictDurableObject('LOBBY_REGISTRY', { name: REGISTRY_NAME });
    },

    async restartRoom(code, incarnation) {
      if (!worker) throw new Error('Durable Object eviction requires the test harness runtime');
      await worker.evictDurableObject('STEPSTONE_ROOM', { name: `${code}:${incarnation}` });
    },

    async restartProcess() {
      if (persistenceDirectory === null) {
        throw new Error('Process restart requires a persistence directory');
      }
      await server.stop();
      await start();
    },

    async wait(milliseconds) {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    },

    async close() {
      if (persistenceDirectory === null) await server.close();
      else await server.stop();
    },
  };
}
