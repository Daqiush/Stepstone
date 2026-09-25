import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { decodeFutureTricks, loadDdsModule } from '../src/dds-wasm-loader.mjs';

test('DDS futureTricks expands equals only when every candidate has the root score', () => {
  const values = new Map([[4, 1], [8, 0], [60, 14], [112, 1 << 13], [164, 2]]);
  const module = { getValue(offset) { return values.get(offset) ?? 0; } };
  assert.deepEqual(decodeFutureTricks(module, 0), { score: 2,
    cards: [{ suit: 'S', rank: 14 }, { suit: 'S', rank: 13 }] });
  values.set(164, 1);
  values.set(168, 2);
  values.set(4, 2);
  values.set(12, 1);
  values.set(64, 10);
  assert.throws(() => decodeFutureTricks(module, 0), /Invalid DDS candidate/);
});

test('vendored runtime and precompiled Wasm derive exactly from the pinned single-file artifact', async () => {
  const checkout = await readFile(new URL('../vendor/bridge-dds/dds-worker.mjs', import.meta.url));
  const wasm = await readFile(new URL('../vendor/bridge-dds/dds-worker.wasm', import.meta.url));
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(checkout.length, 455367);
  assert.equal(sha256(checkout), '932d339ba405f3abf67b2f925fca7bd00967caa6952093dc37ea35e3a7a0f949');
  assert.equal(wasm.length, 323370);
  assert.equal(sha256(wasm), 'ddc660d975c5abd08ec8490a9456dd68d202579c540e9353078b6bdecaddf5f7');
  const source = checkout.toString('utf8');
  const encoded = source.match(/Module\["wasm"\]=Module\["wasm"\]\|\|base64Decode\("([A-Za-z0-9+/=]+)"\)/);
  assert.ok(encoded);
  assert.equal(sha256(Buffer.from(encoded[1], 'base64')), sha256(wasm));
  const original = source
    .replace('Module["wasm"]=Module["wasm"]||base64Decode(', 'Module["wasm"]=base64Decode(')
    .replace('(output.instance??output).exports', 'output.instance.exports');
  assert.equal(sha256(Buffer.from(original)), 'b436073a6941a8eee13f093b2435906d905d9c8a69080b3e6a8f66d07b252442');
});

test('failed Wasm instantiation rejects promptly and permits a later retry', async () => {
  const originalInstantiate = WebAssembly.instantiate;
  let attempts = 0;
  WebAssembly.instantiate = () => { attempts += 1; return Promise.reject(new Error('forced Wasm failure')); };
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        Promise.race([
          loadDdsModule(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('loader hung')), 100)),
        ]),
        (error) => error.code === 'DDS_FAILURE' && !error.message.includes('loader hung'),
      );
    }
    assert.equal(attempts, 2);
  } finally {
    WebAssembly.instantiate = originalInstantiate;
  }
});

test('initializes embedded DDS once without network APIs and solves real PBN positions', async () => {
  const originalFetch = globalThis.fetch;
  const originalXhr = globalThis.XMLHttpRequest;
  const originalInstantiate = WebAssembly.instantiate;
  let instantiations = 0;
  const allocations = [];
  globalThis.fetch = () => { throw new Error('DDS attempted fetch'); };
  globalThis.XMLHttpRequest = class { constructor() { throw new Error('DDS attempted XHR'); } };
  WebAssembly.instantiate = async (...args) => {
    instantiations += 1;
    const result = await originalInstantiate(...args);
    const exports = { ...result.instance.exports,
      malloc(size) { allocations.push(size); return result.instance.exports.malloc(size); } };
    return { instance: { exports } };
  };
  try {
    const [first, second] = await Promise.all([loadDdsModule(), loadDdsModule()]);
    assert.strictEqual(first, second);
    assert.equal(instantiations, 1);
    assert.deepEqual(Object.keys(first).sort(), ['calcDDTablePbn', 'solveBoardPbn']);
    const table = first.calcDDTablePbn('N:AKT74.A65.J96.84 E:J53.KQJT7.T75.97 S:.43.KQ32.AKJT653 W:Q9862.982.A84.Q2');
    assert.deepEqual(Object.keys(table).sort(), ['E', 'N', 'S', 'W']);
    for (const seat of ['N', 'E', 'S', 'W']) for (const strain of ['S', 'H', 'D', 'C', 'NT']) {
      assert.ok(Number.isInteger(table[seat][strain]) && table[seat][strain] >= 0 && table[seat][strain] <= 13);
    }
    const solve = first.solveBoardPbn('trump=NT;leader=N;turn=N;trick=;hands=N:A... E:K... S:Q... W:J...');
    assert.deepEqual(solve, { score: 1, cards: [{ suit: 'S', rank: 14 }] });
    const partial = first.solveBoardPbn('trump=NT;leader=N;turn=E;trick=SA;hands=N:... E:K... S:Q... W:J...');
    assert.deepEqual(partial, { score: 0, cards: [{ suit: 'S', rank: 13 }] });
    assert.deepEqual(allocations.slice(-4), [112, 216, 112, 216]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.XMLHttpRequest = originalXhr;
    WebAssembly.instantiate = originalInstantiate;
  }
});

test('loader and vendored runtime have no Node imports or runtime asset fetch path', async () => {
  for (const path of ['../src/dds-wasm-loader.mjs', '../vendor/bridge-dds/dds-worker.mjs']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(?:from|import)\s*\(?\s*['"](?:node:|fs|path|module|url)/);
    assert.doesNotMatch(source, /\bimport\s*\(/);
    assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|instantiateStreaming|import\.meta)\b/);
  }
});
