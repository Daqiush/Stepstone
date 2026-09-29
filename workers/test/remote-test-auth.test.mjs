import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { authorizeHarnessRequest } from '../src/remote-test-auth.mjs';
import { fetchHarness } from '../src/harness-router.mjs';

const keyBytes = new Uint8Array(32).fill(7);
const key = Buffer.from(keyBytes).toString('base64url');
const metadata = {
  'x-dds-run-id': 'run_20260927-A',
  'x-dds-operation-id': 'op.000001',
  'x-dds-shard': '10',
};

function requestHash(path, body = '') {
  return createHash('sha256').update(JSON.stringify({ body, route: path })).digest('hex');
}

function metadataFor(path, body = '') {
  return { ...metadata, 'x-dds-request-hash': requestHash(path, body) };
}

function request(path = '/__dds/ping', init = {}) {
  return new Request(`https://example.test${path}`, { method: 'POST', ...init });
}

function remoteEnv(overrides = {}) {
  return { DDS_REMOTE_TEST: 'true', DDS_REMOTE_TEST_KEY: key, ...overrides };
}

async function opaque(result) {
  assert.equal(result.mode, 'deny');
  assert.equal(result.response.status, 404);
  assert.equal(await result.response.text(), '');
}

test('local mode is enabled only by DDS_LOCAL_TEST when remote mode is not enabled', async () => {
  const local = await authorizeHarnessRequest(request(), { DDS_LOCAL_TEST: 'true' });
  assert.equal(local.mode, 'local');
  const remoteWins = await authorizeHarnessRequest(request(), {
    DDS_LOCAL_TEST: 'true', DDS_REMOTE_TEST: 'true', DDS_REMOTE_TEST_KEY: key,
  });
  await opaque(remoteWins);
});

test('remote mode accepts an exact 32-byte base64url key and returns body bytes plus identity', async () => {
  const result = await authorizeHarnessRequest(request('/__dds/table', {
    headers: { ...metadataFor('/__dds/table', '{"hands":{}}'), 'x-dds-test-key': key }, body: '{"hands":{}}',
  }), remoteEnv());
  assert.equal(result.mode, 'remote');
  assert.deepEqual([...result.body], [...new TextEncoder().encode('{"hands":{}}')]);
  assert.deepEqual(result.identity, {
    runId: 'run_20260927-A', operationId: 'op.000001', requestHash: requestHash('/__dds/table', '{"hands":{}}'), shard: '10',
  });
});

test('remote mode decodes base64url keys containing dash and underscore characters', async () => {
  const urlBytes = Uint8Array.from({ length: 32 }, (_, index) => (index % 2 ? 255 : 251));
  const urlKey = Buffer.from(urlBytes).toString('base64url');
  assert.match(urlKey, /-/);
  assert.match(urlKey, /_/);
  const result = await authorizeHarnessRequest(request('/__dds/metrics', {
    headers: { ...metadataFor('/__dds/metrics', '{}'), 'x-dds-test-key': urlKey }, body: '{}',
  }), remoteEnv({ DDS_REMOTE_TEST_KEY: urlKey }));
  assert.equal(result.mode, 'remote');
});

test('disabled remote mode and absent, malformed, short, or wrong keys have identical opaque results', async () => {
  const cases = [
    [{}, {}],
    [remoteEnv(), {}],
    [remoteEnv(), { 'x-dds-test-key': 'not base64url!' }],
    [remoteEnv(), { 'x-dds-test-key': Buffer.from(new Uint8Array(31)).toString('base64url') }],
    [remoteEnv(), { 'x-dds-test-key': Buffer.from(new Uint8Array(32).fill(8)).toString('base64url') }],
  ];
  for (const [env, keyHeader] of cases) {
    const result = await authorizeHarnessRequest(request('/__dds/table', { headers: { ...metadataFor('/__dds/table'), ...keyHeader } }), env);
    await opaque(result);
  }
});

test('missing or malformed remote metadata is opaque before method and body enforcement', async () => {
  for (const headers of [
    { ...metadataFor('/__dds/table'), 'x-dds-test-key': key, 'x-dds-run-id': '' },
    { ...metadataFor('/__dds/table'), 'x-dds-test-key': key, 'x-dds-operation-id': 'bad space' },
    { ...metadataFor('/__dds/table'), 'x-dds-test-key': key, 'x-dds-request-hash': 'A'.repeat(64) },
    { ...metadataFor('/__dds/table'), 'x-dds-test-key': key, 'x-dds-shard': '11' },
  ]) {
    const result = await authorizeHarnessRequest(request('/__dds/table', {
      method: 'GET', headers, body: undefined,
    }), remoteEnv());
    await opaque(result);
  }
});

test('only a valid remote key and metadata can observe method and payload errors', async () => {
  const deniedGet = await authorizeHarnessRequest(request('/__dds/table', { method: 'GET' }), remoteEnv());
  await opaque(deniedGet);
  const allowedGet = await authorizeHarnessRequest(request('/__dds/table', {
    method: 'GET', headers: { ...metadataFor('/__dds/table'), 'x-dds-test-key': key },
  }), remoteEnv());
  assert.equal(allowedGet.response.status, 405);

  const oversized = 'x'.repeat(32769);
  const deniedLarge = await authorizeHarnessRequest(request('/__dds/table', { method: 'POST', body: oversized }), remoteEnv());
  await opaque(deniedLarge);
  const allowedLarge = await authorizeHarnessRequest(request('/__dds/table', {
    headers: { ...metadataFor('/__dds/table', oversized), 'x-dds-test-key': key }, body: oversized,
  }), remoteEnv());
  assert.equal(allowedLarge.response.status, 413);
});

test('remote authorization stream-buffers an unknown-length body and supplies replacement bytes', async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"deal":'));
      controller.enqueue(encoder.encode('{}'));
      controller.enqueue(encoder.encode('}'));
      controller.close();
    },
  });
  const result = await authorizeHarnessRequest(request('/__dds/solve', {
    headers: { ...metadataFor('/__dds/solve', '{"deal":{}}'), 'x-dds-test-key': key }, body: stream, duplex: 'half',
  }), remoteEnv());
  assert.equal(result.mode, 'remote');
  assert.equal(new TextDecoder().decode(result.body), '{"deal":{}}');
});

test('remote routing rebuilds the request and forwards only validated identity metadata', async () => {
  const received = [];
  const env = {
    ...remoteEnv(),
    DDS_FEASIBILITY_ROOM: {
      idFromName(name) { received.push({ kind: 'id', name }); return { name }; },
      get(id) {
        received.push({ kind: 'get', id });
        return { async fetch(forwarded) {
          received.push({
            kind: 'fetch', method: forwarded.method, body: await forwarded.text(),
            headers: Object.fromEntries(forwarded.headers),
          });
          return new Response('forwarded');
        } };
      },
    },
  };
  const encoder = new TextEncoder();
  const response = await fetchHarness(request('/__dds/solve', {
    headers: { ...metadataFor('/__dds/solve', '{"deal":{}}'), 'x-dds-test-key': key, 'x-untrusted-header': 'discard-me' },
    body: new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode('{"deal":'));
      controller.enqueue(encoder.encode('{}}'));
      controller.close();
    } }),
    duplex: 'half',
  }), env);
  assert.equal(await response.text(), 'forwarded');
  assert.equal(received[0].name, 'remote-feasibility:run_20260927-A:10');
  assert.equal(received[2].method, 'POST');
  assert.equal(received[2].body, '{"deal":{}}');
  assert.deepEqual(received[2].headers, {
    'x-dds-operation-id': 'op.000001',
    'x-dds-request-hash': requestHash('/__dds/solve', '{"deal":{}}'),
    'x-dds-run-id': 'run_20260927-A',
    'x-dds-shard': '10',
  });
});

test('local routing retains the fixed feasibility room', async () => {
  const names = [];
  const env = {
    DDS_LOCAL_TEST: 'true',
    DDS_FEASIBILITY_ROOM: {
      idFromName(name) { names.push(name); return name; },
      get() { return { fetch: async () => new Response('local') }; },
    },
  };
  const response = await fetchHarness(request('/__dds/ping', { body: '{}' }), env);
  assert.equal(await response.text(), 'local');
  assert.deepEqual(names, ['single-feasibility-room']);
});
