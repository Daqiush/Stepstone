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
  assert.equal(checkout.length, 455375);
  assert.equal(sha256(checkout), 'da11523782524ae2b4274e1123794f0a50e47403924dbb90b0ddde9bb723ac1d');
  assert.equal(wasm.length, 323370);
  assert.equal(sha256(wasm), 'ddc660d975c5abd08ec8490a9456dd68d202579c540e9353078b6bdecaddf5f7');
  const source = checkout.toString('utf8');
  const encoded = source.match(/Module\["wasm"\]=Module\["wasm"\]\|\|base64Decode\("([A-Za-z0-9+/=]+)"\)/);
  assert.ok(encoded);
  assert.equal(sha256(Buffer.from(encoded[1], 'base64')), sha256(wasm));
  const original = source
    .replace('Module["wasm"]=Module["wasm"]||base64Decode(', 'Module["wasm"]=base64Decode(')
    .replace('(output.instance??output).exports', 'output.instance.exports');
  assert.equal(sha256(Buffer.from(original)), '875c4ed0ab297192e92dfbb19ee25c889f77eacafa8c490504958f69492519af');
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
  let actualMemory;
  globalThis.fetch = () => { throw new Error('DDS attempted fetch'); };
  globalThis.XMLHttpRequest = class { constructor() { throw new Error('DDS attempted XHR'); } };
  WebAssembly.instantiate = async (...args) => {
    instantiations += 1;
    const result = await originalInstantiate(...args);
    actualMemory = result.instance.exports.memory;
    const exports = { ...result.instance.exports,
      malloc(size) { allocations.push(size); return result.instance.exports.malloc(size); } };
    return { instance: { exports } };
  };
  try {
    const [first, second] = await Promise.all([loadDdsModule(), loadDdsModule()]);
    assert.strictEqual(first, second);
    assert.equal(instantiations, 1);
    assert.deepEqual(Object.keys(first).sort(), ['calcDDTablePbn', 'heapBytes', 'solveBoardPbn']);
    assert.ok(actualMemory instanceof WebAssembly.Memory);
    assert.ok(Number.isSafeInteger(first.heapBytes()) && first.heapBytes() > 0);
    assert.equal(first.heapBytes(), actualMemory.buffer.byteLength);
    const table = first.calcDDTablePbn('N:AKT74.A65.J96.84 E:J53.KQJT7.T75.97 S:.43.KQ32.AKJT653 W:Q9862.982.A84.Q2');
    assert.deepEqual(Object.keys(table).sort(), ['E', 'N', 'S', 'W']);
    for (const seat of ['N', 'E', 'S', 'W']) for (const strain of ['S', 'H', 'D', 'C', 'NT']) {
      assert.ok(Number.isInteger(table[seat][strain]) && table[seat][strain] >= 0 && table[seat][strain] <= 13);
    }
    const solve = first.solveBoardPbn('trump=NT;leader=N;turn=N;trick=;hands=N:A... E:K... S:Q... W:J...');
    assert.deepEqual(solve, { score: 1, cards: [{ suit: 'S', rank: 14 }] });
    const partial = first.solveBoardPbn('trump=NT;leader=N;turn=E;trick=SA;hands=N:... E:K... S:Q... W:J...');
    assert.deepEqual(partial, { score: 0, cards: [{ suit: 'S', rank: 13 }] });
    assert.equal(first.heapBytes(), actualMemory.buffer.byteLength);
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
