import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
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
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/__dds/ping`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
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

async function post(mf, route, body = {}) {
  const response = await mf.dispatchFetch(`http://localhost${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`Unexpected Worker response ${response.status}: ${text.slice(0, 500)}`); }
  return { status: response.status, body: parsed };
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

test('entry point limits methods and paths to local test endpoints', async () => {
  const missing = await mf.dispatchFetch('http://localhost/');
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
  const method = await mf.dispatchFetch('http://localhost/__dds/ping');
  assert.equal(method.status, 405);
  await method.arrayBuffer();
});
