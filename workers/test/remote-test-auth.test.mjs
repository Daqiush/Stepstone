import assert from 'node:assert/strict';
import { test } from 'node:test';

import { authorizeHarnessRequest } from '../src/remote-test-auth.mjs';

const keyBytes = new Uint8Array(32).fill(7);
const key = Buffer.from(keyBytes).toString('base64url');
const metadata = {
  'x-dds-run-id': 'run_20260927-A',
  'x-dds-operation-id': 'op.000001',
  'x-dds-request-hash': 'a'.repeat(64),
  'x-dds-shard': '10',
};

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
    headers: { ...metadata, 'x-dds-test-key': key }, body: '{"hands":{}}',
  }), remoteEnv());
  assert.equal(result.mode, 'remote');
  assert.deepEqual([...result.body], [...new TextEncoder().encode('{"hands":{}}')]);
  assert.deepEqual(result.identity, {
    runId: 'run_20260927-A', operationId: 'op.000001', requestHash: 'a'.repeat(64), shard: '10',
  });
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
    const result = await authorizeHarnessRequest(request('/__dds/table', { headers: { ...metadata, ...keyHeader } }), env);
    await opaque(result);
  }
});

test('missing or malformed remote metadata is opaque before method and body enforcement', async () => {
  for (const headers of [
    { ...metadata, 'x-dds-test-key': key, 'x-dds-run-id': '' },
    { ...metadata, 'x-dds-test-key': key, 'x-dds-operation-id': 'bad space' },
    { ...metadata, 'x-dds-test-key': key, 'x-dds-request-hash': 'A'.repeat(64) },
    { ...metadata, 'x-dds-test-key': key, 'x-dds-shard': '11' },
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
    method: 'GET', headers: { ...metadata, 'x-dds-test-key': key },
  }), remoteEnv());
  assert.equal(allowedGet.response.status, 405);

  const oversized = 'x'.repeat(32769);
  const deniedLarge = await authorizeHarnessRequest(request('/__dds/table', { method: 'POST', body: oversized }), remoteEnv());
  await opaque(deniedLarge);
  const allowedLarge = await authorizeHarnessRequest(request('/__dds/table', {
    headers: { ...metadata, 'x-dds-test-key': key }, body: oversized,
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
    headers: { ...metadata, 'x-dds-test-key': key }, body: stream, duplex: 'half',
  }), remoteEnv());
  assert.equal(result.mode, 'remote');
  assert.equal(new TextDecoder().decode(result.body), '{"deal":{}}');
});
