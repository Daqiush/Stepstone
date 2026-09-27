import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execFileAsync = promisify(execFile);
const wrangler = fileURLToPath(new URL('../../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const oneTrickDeal = {
  trump: 'NT', trickLeader: 'N', trickPlayed: [],
  hands: {
    N: [{ suit: 'S', rank: 14 }], E: [{ suit: 'S', rank: 13 }],
    S: [{ suit: 'S', rank: 12 }], W: [{ suit: 'S', rank: 11 }],
  },
};

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function runtime(bindings = {}) {
  const port = await unusedPort();
  const persistence = await mkdtemp(join(tmpdir(), 'stepstone-dds-worker-'));
  const args = ['dev', '--config', config, '--local', '--ip', '127.0.0.1',
    '--port', String(port), '--persist-to', persistence, '--var', 'DDS_LOCAL_TEST:true'];
  for (const [name, value] of Object.entries(bindings)) args.push('--var', `${name}:${value}`);
  const child = spawn(process.execPath, [wrangler, ...args], {
    cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
    output = `${output}${chunk}`.slice(-4000);
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  let readinessResponse;
  const readinessHeaders = { 'content-type': 'application/json' };
  if (bindings.DDS_REMOTE_TEST === 'true') Object.assign(readinessHeaders,
    remoteHeaders('/__dds/ping', {}, 'readiness-run', 'ping.000001'));
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/__dds/ping`, {
        method: 'POST', headers: readinessHeaders, body: '{}',
        signal: AbortSignal.timeout(1000),
      });
      await response.arrayBuffer();
      if (response.status === 200) { readinessResponse = response; ready = true; break; }
    } catch { /* local Worker is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const runner = {
    base,
    get readinessProbeBodyConsumed() { return readinessResponse?.bodyUsed; },
    dispatchFetch: (url, init) => fetch(`${base}${new URL(url).pathname}`, init),
    async dispose() {
      if (child.exitCode === null) {
        if (process.platform === 'win32') {
          await new Promise((resolve) => {
            const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            killer.once('exit', resolve);
            killer.once('error', resolve);
          });
        } else child.kill();
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
      await rm(persistence, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
  if (!ready) {
    await runner.dispose();
    throw new Error(`Wrangler Worker failed to start: ${output}`);
  }
  return runner;
}

async function post(mf, route, body = {}, headers = {}) {
  const response = await mf.dispatchFetch(`http://localhost${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const text = await response.text();
  if (text === '') return { status: response.status, body: null };
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`Unexpected Worker response ${response.status}: ${text.slice(0, 500)}`); }
  return { status: response.status, body: parsed };
}

const remoteKey = Buffer.from(new Uint8Array(32).fill(7)).toString('base64url');

function requestHash(route, body) {
  return createHash('sha256').update(JSON.stringify({ body: JSON.stringify(body), route })).digest('hex');
}

function remoteHeaders(route, body, runId, operationId, shard = '0') {
  return {
    'x-dds-test-key': remoteKey,
    'x-dds-run-id': runId,
    'x-dds-operation-id': operationId,
    'x-dds-request-hash': requestHash(route, body),
    'x-dds-shard': shard,
  };
}

async function remoteRuntime(bindings = {}) {
  return runtime({ DDS_REMOTE_TEST: 'true', DDS_REMOTE_TEST_KEY: remoteKey, ...bindings });
}

let mf;
before(async () => { mf = await runtime(); });
after(async () => { await mf?.dispose(); });

test('startup readiness probe consumes its response body before the first DDS request', () => {
  assert.equal(mf.readinessProbeBodyConsumed, true);
});

test('real Workers runtime solves a deal and reports bounded timings', async () => {
  const { status, body } = await post(mf, '/__dds/solve', { deal: oneTrickDeal });
  assert.equal(status, 200);
  assert.deepEqual(body.result, { score: 1, cards: [{ suit: 'S', rank: 14 }] });
  assert.equal(body.ok, true);
  assert.ok(Number.isFinite(body.metrics.initMs) && body.metrics.initMs >= 0);
  assert.ok(Number.isFinite(body.metrics.solveMs) && body.metrics.solveMs >= 0);
  assert.ok(Number.isSafeInteger(body.metrics.heapBytes) && body.metrics.heapBytes > 0);
  const metric = await post(mf, '/__dds/metrics');
  assert.equal(metric.status, 200);
  assert.equal(metric.body.heapBytes, body.metrics.heapBytes);
});

test('table uses the existing five strains by four seats representation', async () => {
  const { status, body } = await post(mf, '/__dds/table', { hands: oneTrickDeal.hands });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(Number.isSafeInteger(body.metrics.heapBytes) && body.metrics.heapBytes > 0);
  assert.equal((await post(mf, '/__dds/metrics')).body.heapBytes, body.metrics.heapBytes);
  assert.equal(body.result.length, 5);
  for (const row of body.result) {
    assert.equal(row.length, 4);
    for (const tricks of row) assert.ok(Number.isInteger(tricks) && tricks >= 0 && tricks <= 13);
  }
});

test('real Worker benchmark records current heap bytes and maximum observed bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stepstone-dds-memory-report-'));
  const out = join(dir, 'report.json');
  try {
    await execFileAsync(process.execPath, [join(root, 'scripts/benchmark-worker-dds.mjs'),
      '--seed', '20260923', '--iterations', '1', '--url', mf.base, '--out', out],
    { cwd: root, timeout: 120000 });
    const report = JSON.parse(await readFile(out, 'utf8'));
    const observed = report.benchmark.operations.map((operation) => operation.heapBytes);
    assert.ok(observed.length > 1);
    assert.ok(observed.every((bytes) => Number.isSafeInteger(bytes) && bytes > 0));
    assert.equal(report.benchmark.maxMemoryBytes, Math.max(...observed));
    assert.equal(report.benchmark.maxMemoryBytes, (await post(mf, '/__dds/metrics')).body.heapBytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('malformed deal is rejected before Wasm and does not increment completed operations', async () => {
  const beforeMetrics = (await post(mf, '/__dds/metrics')).body;
  const invalid = { ...oneTrickDeal, trump: 'X' };
  const { status, body } = await post(mf, '/__dds/solve', { deal: invalid });
  assert.equal(status, 400);
  assert.deepEqual(body, { ok: false, error: { code: 'INVALID_DEAL' } });
  const afterMetrics = (await post(mf, '/__dds/metrics')).body;
  assert.equal(afterMetrics.completedOperations, beforeMetrics.completedOperations);
});

test('an isolated forced Wasm failure returns DDS_FAILURE and a later request recovers without leaked result', async () => {
  const isolated = await runtime({ DDS_TEST_FAIL_FIRST_SOLVE: 'true' });
  try {
    const first = await post(isolated, '/__dds/solve', { deal: oneTrickDeal });
    assert.equal(first.status, 500);
    assert.deepEqual(first.body, { ok: false, error: { code: 'DDS_FAILURE' } });
    const laterDeal = {
      ...oneTrickDeal,
      hands: { N: [{ suit: 'H', rank: 14 }], E: [{ suit: 'H', rank: 13 }],
        S: [{ suit: 'H', rank: 12 }], W: [{ suit: 'H', rank: 11 }] },
    };
    const second = await post(isolated, '/__dds/solve', { deal: laterDeal });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.result, { score: 1, cards: [{ suit: 'H', rank: 14 }] });
    assert.equal(second.body.ok, true);
  } finally { await isolated.dispose(); }
});

test('an isolated initialization failure reports DDS_FAILURE then retries Wasm on the same object', async () => {
  const isolated = await runtime({ DDS_TEST_FAIL_FIRST_INIT: 'true' });
  try {
    const first = await post(isolated, '/__dds/solve', { deal: oneTrickDeal });
    assert.equal(first.status, 500);
    assert.deepEqual(first.body, { ok: false, error: { code: 'DDS_FAILURE' } });
    const table = await post(isolated, '/__dds/table', { hands: oneTrickDeal.hands });
    assert.equal(table.status, 200);
    assert.equal(table.body.ok, true);
    assert.equal(table.body.result.length, 5);
    const laterDeal = {
      ...oneTrickDeal,
      hands: { N: [{ suit: 'H', rank: 14 }], E: [{ suit: 'H', rank: 13 }],
        S: [{ suit: 'H', rank: 12 }], W: [{ suit: 'H', rank: 11 }] },
    };
    const solved = await post(isolated, '/__dds/solve', { deal: laterDeal });
    assert.equal(solved.status, 200);
    assert.deepEqual(solved.body.result, { score: 1, cards: [{ suit: 'H', rank: 14 }] });
    const metrics = await post(isolated, '/__dds/metrics');
    assert.equal(metrics.body.completedOperations, 2);
  } finally { await isolated.dispose(); }
});

test('ping follows an earlier queued solve', async () => {
  const isolated = await runtime({ DDS_TEST_SOLVE_DELAY_MS: '150' });
  try {
    const solving = post(isolated, '/__dds/solve', { deal: oneTrickDeal });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const [solved, ping] = await Promise.all([solving, post(isolated, '/__dds/ping')]);
    assert.equal(solved.status, 200);
    assert.equal(ping.status, 200);
    assert.equal(ping.body.completedOperations, 1);
  } finally { await isolated.dispose(); }
});

test('local ordered probe measures a distinct ping blocked behind its paired solve', async () => {
  const isolated = await runtime({ DDS_TEST_SOLVE_DELAY_MS: '150' });
  try {
    const before = (await post(isolated, '/__dds/ping')).body.completedOperations;
    const { status, body } = await post(isolated, '/__dds/ordered-probe', { deal: oneTrickDeal });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.solveResponse.result, { score: 1, cards: [{ suit: 'S', rank: 14 }] });
    assert.deepEqual(body.pingResponse, { ok: true, completedOperations: before + 1 });
    assert.ok(body.solveCompletedMs >= 100);
    assert.ok(body.queueDelayMs >= body.solveCompletedMs);
    assert.equal((await post(isolated, '/__dds/ping')).body.completedOperations, before + 1);
  } finally { await isolated.dispose(); }
});

test('remote operation replays a persisted table result without new queued work', async () => {
  const isolated = await remoteRuntime();
  const table = { hands: oneTrickDeal.hands };
  const headers = remoteHeaders('/__dds/table', table, 'run_20260927-A', 'table.000001');
  try {
    const first = await post(isolated, '/__dds/table', table, headers);
    const second = await post(isolated, '/__dds/table', table, headers);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.operationResult, first.body.operationResult);
    assert.equal(first.body.replayed, false);
    assert.equal(second.body.replayed, true);
    assert.match(first.body.operationResult.activationId, /^[0-9a-f-]{36}$/i);
    assert.equal(second.body.operationResult.activationId, first.body.operationResult.activationId);
    assert.deepEqual(first.body.accounting, {
      workerInbound: 1, doFetchArrivals: 1, queuedDoCommands: 1, sqliteReads: 1, sqliteWrites: 1,
    });
    assert.deepEqual(second.body.accounting, {
      workerInbound: 2, doFetchArrivals: 2, queuedDoCommands: 1, sqliteReads: 2, sqliteWrites: 1,
    });
  } finally { await isolated.dispose(); }
});

test('remote operation conflict is opaque and operation ids are isolated by run id', async () => {
  const isolated = await remoteRuntime();
  try {
    const firstHeaders = remoteHeaders('/__dds/solve', { deal: oneTrickDeal }, 'run_20260927-A', 'same.000001');
    const first = await post(isolated, '/__dds/solve', { deal: oneTrickDeal }, firstHeaders);
    assert.equal(first.status, 200);
    const changedDeal = { ...oneTrickDeal, trump: 'S' };
    const conflict = await post(isolated, '/__dds/solve', { deal: changedDeal },
      remoteHeaders('/__dds/solve', { deal: changedDeal }, 'run_20260927-A', 'same.000001'));
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body, { ok: false, error: { code: 'OPERATION_CONFLICT' } });
    const isolatedRun = await post(isolated, '/__dds/solve', { deal: oneTrickDeal },
      remoteHeaders('/__dds/solve', { deal: oneTrickDeal }, 'run_20260927-B', 'same.000001'));
    assert.equal(isolatedRun.status, 200);
    assert.deepEqual(isolatedRun.body.operationResult.result, { score: 1, cards: [{ suit: 'S', rank: 14 }] });
    assert.equal(isolatedRun.body.replayed, false);
  } finally { await isolated.dispose(); }
});

test('remote operation replays an ordered solve without enqueueing its solve and ping again', async () => {
  const isolated = await remoteRuntime();
  const probe = { deal: oneTrickDeal };
  const headers = remoteHeaders('/__dds/ordered-probe', probe, 'run_20260927-A', 'probe.000001');
  try {
    const first = await post(isolated, '/__dds/ordered-probe', probe, headers);
    const second = await post(isolated, '/__dds/ordered-probe', probe, headers);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.operationResult, first.body.operationResult);
    assert.equal(second.body.replayed, true);
    assert.deepEqual(second.body.accounting, {
      workerInbound: 2, doFetchArrivals: 2, queuedDoCommands: 2, sqliteReads: 2, sqliteWrites: 1,
    });
  } finally { await isolated.dispose(); }
});

test('remote ordered probe retries after its inner solve fails instead of caching an outer success', async () => {
  const isolated = await remoteRuntime({ DDS_TEST_FAIL_FIRST_SOLVE: 'true' });
  const probe = { deal: oneTrickDeal };
  const headers = remoteHeaders('/__dds/ordered-probe', probe, 'run_20260927-A', 'probe.failure.000001');
  try {
    const failed = await post(isolated, '/__dds/ordered-probe', probe, headers);
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { ok: false, error: { code: 'DDS_FAILURE' } });
    const retried = await post(isolated, '/__dds/ordered-probe', probe, headers);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.replayed, false);
    assert.deepEqual(retried.body.operationResult.solveResponse.result,
      { score: 1, cards: [{ suit: 'S', rank: 14 }] });
  } finally { await isolated.dispose(); }
});

test('remote duplicate delivery serializes a delayed solve into one persisted execution', async () => {
  const isolated = await remoteRuntime({ DDS_TEST_SOLVE_DELAY_MS: '150' });
  const solve = { deal: oneTrickDeal };
  const headers = remoteHeaders('/__dds/solve', solve, 'run_20260927-A', 'solve.concurrent.000001');
  try {
    const [first, second] = await Promise.all([
      post(isolated, '/__dds/solve', solve, headers),
      post(isolated, '/__dds/solve', solve, headers),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(first.body.operationResult, second.body.operationResult);
    assert.deepEqual([first.body.replayed, second.body.replayed].sort(), [false, true]);
    assert.equal(second.body.accounting.queuedDoCommands, 1);
  } finally { await isolated.dispose(); }
});

test('remote boundary rejects a changed payload reusing the original operation hash', async () => {
  const isolated = await remoteRuntime();
  const firstBody = { deal: oneTrickDeal };
  const headers = remoteHeaders('/__dds/solve', firstBody, 'run_20260927-A', 'solve.hash.000001');
  try {
    assert.equal((await post(isolated, '/__dds/solve', firstBody, headers)).status, 200);
    const changed = { deal: { ...oneTrickDeal, trump: 'S' } };
    const mismatch = await post(isolated, '/__dds/solve', changed, headers);
    assert.equal(mismatch.status, 404);
    assert.equal(mismatch.body, null);
  } finally { await isolated.dispose(); }
});

test('entry point limits methods and paths to local test endpoints', async () => {
  const missing = await mf.dispatchFetch('http://localhost/');
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
  const method = await mf.dispatchFetch('http://localhost/__dds/ping');
  assert.equal(method.status, 405);
  await method.arrayBuffer();
});
