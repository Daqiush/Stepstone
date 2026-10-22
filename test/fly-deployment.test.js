'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('server exposes a lightweight liveness endpoint', async () => {
  const serverApi = require('../server');
  const port = await serverApi.startServer(0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    await new Promise((resolve) => serverApi.io.close(resolve));
  }
});

test('Fly deployment stays within the approved single-CPU 1 GB shape', () => {
  const config = read('fly.toml');

  assert.match(config, /primary_region\s*=\s*"iad"/);
  assert.match(config, /internal_port\s*=\s*3000/);
  assert.match(config, /auto_stop_machines\s*=\s*"off"/);
  assert.match(config, /cpu_kind\s*=\s*"shared"/);
  assert.match(config, /cpus\s*=\s*1/);
  assert.match(config, /memory\s*=\s*"1gb"/i);
  assert.match(config, /DDS_MAX_CONCURRENCY\s*=\s*"1"/);
  assert.match(config, /DDS_TT_DEFAULT_MB\s*=\s*"95"/);
  assert.match(config, /DDS_TT_LIMIT_MB\s*=\s*"95"/);
  assert.match(config, /path\s*=\s*"\/healthz"/);
});

test('production image builds native Linux DDS and excludes local artifacts', () => {
  const dockerfile = read('Dockerfile');
  const dockerignore = read('.dockerignore');
  const buildScript = read('scripts/build-linux-dds.sh');

  assert.match(dockerfile, /FROM node:22-bookworm-slim AS dds-builder/);
  assert.match(dockerfile, /build-linux-dds\.sh/);
  assert.match(buildScript, /native\/dds-cli\/dds_calc\.cpp/);
  assert.match(buildScript, /native\/dds-cli\/dds_solve\.cpp/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /CMD \["node", "server\.js"\]/);
  assert.match(dockerignore, /node_modules\//);
  assert.match(dockerignore, /dds\/Build\//);
  assert.match(dockerignore, /workers\//);
});
