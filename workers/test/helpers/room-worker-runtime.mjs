import { createTestHarness, unstable_dev } from 'wrangler';
import { fileURLToPath } from 'node:url';

const REGISTRY_NAME = 'singleton';
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url));
const ENTRY_PATH = fileURLToPath(new URL('../../src/index.mjs', import.meta.url));

export async function createRoomWorkerRuntime({ persistenceDirectory = null, vars = {} } = {}) {
  let server;
  let worker;
  let serverUrl;

  async function start() {
    if (persistenceDirectory !== null) {
      server = await unstable_dev(ENTRY_PATH, {
        config: CONFIG_PATH,
        local: true,
        persist: true,
        persistTo: persistenceDirectory,
        vars: {
          CLASSIC_TEST_DDS_PAUSE: 'idle',
          ...vars,
          ROOM_FOUNDATION_TEST: 'true',
        },
        logLevel: 'none',
        experimental: { disableDevRegistry: true, disableExperimentalWarning: true },
      });
      worker = null;
      serverUrl = new URL(
        /^https?:\/\//u.test(server.address)
          ? server.address
          : `http://${server.address}:${server.port}`,
      );
      return;
    }
    server = createTestHarness({
      root: ROOT,
      workers: [{
        configPath: './workers/wrangler.jsonc',
        vars: {
          CLASSIC_TEST_DDS_PAUSE: 'idle',
          ...vars,
          ROOM_FOUNDATION_TEST: 'true',
        },
      }],
    });
    const listening = await server.listen();
    serverUrl = listening.url;
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

    async openWebSocket(path) {
      const url = new URL(path, serverUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url);
      const messages = [];
      const messageWaiters = [];
      let closeEvent = null;
      const closeWaiters = [];

      socket.addEventListener('message', (event) => {
        const waiter = messageWaiters.shift();
        if (waiter) waiter.resolve(event.data);
        else messages.push(event.data);
      });
      socket.addEventListener('close', (event) => {
        closeEvent = event;
        while (closeWaiters.length > 0) closeWaiters.shift().resolve(event);
      });

      await new Promise((resolve, reject) => {
        const onOpen = () => {
          socket.removeEventListener('error', onError);
          resolve();
        };
        const onError = () => {
          socket.removeEventListener('open', onOpen);
          reject(new Error('WebSocket upgrade failed'));
        };
        socket.addEventListener('open', onOpen, { once: true });
        socket.addEventListener('error', onError, { once: true });
      });

      return {
        raw: socket,
        send(value) {
          socket.send(typeof value === 'string' || value instanceof ArrayBuffer
            ? value : JSON.stringify(value));
        },
        async nextMessage(timeoutMs = 2_000) {
          if (messages.length > 0) return messages.shift();
          return new Promise((resolve, reject) => {
            const waiter = {
              resolve(value) {
                clearTimeout(timer);
                resolve(value);
              },
            };
            const timer = setTimeout(() => {
              const index = messageWaiters.indexOf(waiter);
              if (index >= 0) messageWaiters.splice(index, 1);
              reject(new Error('timed out waiting for WebSocket message'));
            }, timeoutMs);
            messageWaiters.push(waiter);
          });
        },
        async expectNoMessage(milliseconds = 100) {
          if (messages.length > 0) throw new Error(`unexpected WebSocket message: ${messages[0]}`);
          if (closeEvent) throw new Error(`socket closed before quiet period: ${closeEvent.code}`);
          await new Promise((resolve, reject) => {
            let settled = false;
            const removeWaiter = (waiters, waiter) => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
            };
            const finish = (callback) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              removeWaiter(messageWaiters, messageWaiter);
              removeWaiter(closeWaiters, closeWaiter);
              callback();
            };
            const messageWaiter = {
              resolve(value) {
                finish(() => reject(new Error(`unexpected WebSocket message: ${String(value)}`)));
              },
            };
            const closeWaiter = {
              resolve(event) {
                finish(() => reject(new Error(`socket closed before quiet period: ${event.code}`)));
              },
            };
            const timer = setTimeout(() => {
              finish(resolve);
            }, milliseconds);
            messageWaiters.push(messageWaiter);
            closeWaiters.push(closeWaiter);
          });
        },
        async closed(timeoutMs = 2_000) {
          if (closeEvent) return closeEvent;
          return new Promise((resolve, reject) => {
            const waiter = {
              resolve(event) {
                clearTimeout(timer);
                resolve(event);
              },
            };
            const timer = setTimeout(() => {
              const index = closeWaiters.indexOf(waiter);
              if (index >= 0) closeWaiters.splice(index, 1);
              reject(new Error('timed out waiting for WebSocket close'));
            }, timeoutMs);
            closeWaiters.push(waiter);
          });
        },
        close(code = 1000, reason = '') {
          socket.close(code, reason);
        },
      };
    },

    async restartRegistry() {
      if (!worker) throw new Error('Durable Object eviction requires the test harness runtime');
      await worker.evictDurableObject('LOBBY_REGISTRY', { name: REGISTRY_NAME });
    },

    async restartRoom(code, incarnation) {
      if (!worker) throw new Error('Durable Object eviction requires the test harness runtime');
      await worker.evictDurableObject('STEPSTONE_ROOM', {
        name: `${code}:${incarnation}`,
        webSockets: 'hibernate',
      });
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
