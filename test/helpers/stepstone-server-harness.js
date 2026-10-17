'use strict';

const { io: createClient } = require('socket.io-client');

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function once(socket, eventName, timeoutMs = 3000) {
  return withTimeout(new Promise((resolve, reject) => {
    const onEvent = payload => {
      cleanup();
      resolve(payload);
    };
    const onError = error => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const cleanup = () => {
      socket.off(eventName, onEvent);
      socket.off('connect_error', onError);
    };
    socket.once(eventName, onEvent);
    socket.once('connect_error', onError);
  }), timeoutMs, eventName);
}

async function connectClient(port) {
  const socket = createClient(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  if (!socket.connected) await once(socket, 'connect');
  return socket;
}

async function closeHttpServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

async function createStepstoneServerHarness() {
  const serverApi = require('../../server.js');
  const clients = [];
  const wasListeningBeforeStart = serverApi.server.listening;
  const started = await serverApi.startServer(0);
  const port = typeof started === 'number' ? started : started.port;
  if (!Number.isInteger(port) || port <= 0) throw new Error('startServer did not return an actual port');

  return {
    ...serverApi,
    port,
    clients,
    wasListeningBeforeStart,
    async connect() {
      const socket = await connectClient(port);
      clients.push(socket);
      return socket;
    },
    async close() {
      for (const client of clients.splice(0)) client.disconnect();
      await new Promise(resolve => serverApi.io.close(resolve));
      await closeHttpServer(serverApi.server);
    },
  };
}

module.exports = {
  createStepstoneServerHarness,
  once,
  withTimeout,
};
