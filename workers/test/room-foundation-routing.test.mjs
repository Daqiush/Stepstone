import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  LobbyRegistry,
  StepstoneRoom,
  fetchWorker,
} from '../src/room-foundation/router.mjs';

function request(path, method = 'POST') {
  return new Request(`https://example.test${path}`, { method });
}

async function assertOpaqueNotFound(response) {
  assert.equal(response.status, 404);
  assert.equal(await response.text(), '');
}

async function assertRoomNotFound(response) {
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await response.json(), { v: 1, error: { code: 'ROOM_NOT_FOUND' } });
}

test('room routes stay opaque unless ROOM_FOUNDATION_TEST is exactly the string true', async () => {
  for (const value of [undefined, 'false', 'TRUE', true, 1]) {
    const env = value === undefined ? {} : { ROOM_FOUNDATION_TEST: value };
    await assertOpaqueNotFound(await fetchWorker(request('/api/rooms'), env));
    await assertOpaqueNotFound(await fetchWorker(request('/api/rooms/123/join'), env));
    await assertOpaqueNotFound(await fetchWorker(request('/api/rooms/123/7/ws', 'GET'), env));
  }
});

test('enabled room routes expose only the three future public route shapes', async () => {
  const env = { ROOM_FOUNDATION_TEST: 'true' };
  await assertRoomNotFound(await fetchWorker(request('/api/rooms'), env));
  await assertRoomNotFound(await fetchWorker(request('/api/rooms/123/join'), env));
  await assertRoomNotFound(await fetchWorker(request('/api/rooms/123/7/ws', 'GET'), env));

  for (const path of [
    '/api/rooms/',
    '/api/rooms/12/join',
    '/api/rooms/123/0/ws',
    '/api/rooms/123/7/ws/extra',
    '/api/rooms/internal/release',
  ]) {
    await assertOpaqueNotFound(await fetchWorker(request(path), env));
  }
});

test('enabled public room endpoints reject unsupported methods consistently', async () => {
  const env = { ROOM_FOUNDATION_TEST: 'true' };
  for (const [path, method, allow] of [
    ['/api/rooms', 'GET', 'POST'],
    ['/api/rooms/123/join', 'DELETE', 'POST'],
    ['/api/rooms/123/7/ws', 'POST', 'GET'],
  ]) {
    const response = await fetchWorker(request(path, method), env);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), allow);
    assert.equal(await response.text(), '');
  }
});

test('non-room paths retain the existing DDS harness dispatch', async () => {
  const calls = [];
  const env = {
    ROOM_FOUNDATION_TEST: 'true',
    DDS_LOCAL_TEST: 'true',
    DDS_FEASIBILITY_ROOM: {
      idFromName(name) {
        calls.push(['idFromName', name]);
        return name;
      },
      get(id) {
        calls.push(['get', id]);
        return {
          fetch(forwarded) {
            calls.push(['fetch', forwarded.url]);
            return new Response('dds-byte-compatible', {
              status: 207,
              headers: { 'x-dds-test': 'unchanged' },
            });
          },
        };
      },
    },
  };

  const response = await fetchWorker(request('/__dds/ping'), env);
  assert.equal(response.status, 207);
  assert.equal(response.headers.get('x-dds-test'), 'unchanged');
  assert.equal(await response.text(), 'dds-byte-compatible');
  assert.deepEqual(calls, [
    ['idFromName', 'single-feasibility-room'],
    ['get', 'single-feasibility-room'],
    ['fetch', 'https://example.test/__dds/ping'],
  ]);
  await assertOpaqueNotFound(await fetchWorker(request('/api/roomsets'), env));
});

test('Worker exports all configured Durable Object classes and placeholders fail closed', async () => {
  assert.equal(typeof LobbyRegistry, 'function');
  assert.equal(typeof StepstoneRoom, 'function');
  await assertOpaqueNotFound(await new LobbyRegistry().fetch(request('/internal/allocate')));
  await assertOpaqueNotFound(await new StepstoneRoom().fetch(request('/internal/initialize')));

  const index = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  assert.match(index, /export\s*\{\s*FeasibilityRoom\s*\}/u);
  assert.match(index, /export\s*\{\s*LobbyRegistry\s*,\s*StepstoneRoom\s*\}/u);
});

test('Wrangler keeps the DDS class and adds gated room classes without public routes', async () => {
  const configPath = new URL('../wrangler.jsonc', import.meta.url);
  const config = JSON.parse(await readFile(configPath, 'utf8'));

  assert.equal(config.workers_dev, false);
  for (const key of ['route', 'routes', 'zone_id', 'zone_name']) {
    assert.equal(Object.hasOwn(config, key), false, `${key} must remain absent`);
  }
  assert.deepEqual(config.durable_objects.bindings, [
    { name: 'DDS_FEASIBILITY_ROOM', class_name: 'FeasibilityRoom' },
    { name: 'LOBBY_REGISTRY', class_name: 'LobbyRegistry' },
    { name: 'STEPSTONE_ROOM', class_name: 'StepstoneRoom' },
  ]);
  assert.deepEqual(config.migrations, [
    { tag: 'v1', new_sqlite_classes: ['FeasibilityRoom'] },
    { tag: 'v2', new_sqlite_classes: ['LobbyRegistry', 'StepstoneRoom'] },
  ]);
});
