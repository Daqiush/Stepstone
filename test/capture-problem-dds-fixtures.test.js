'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { resolveScriptCard, stop } = require('../scripts/capture-problem-dds-fixtures');

test('branch replay resolves exact and dynamic NS script cards from the live remaining hand', () => {
  const hand = [{ suit: 'S', rank: 3 }, { suit: 'S', rank: 14 }, { suit: 'H', rank: 2 }];
  assert.deepEqual(resolveScriptCard({ suit: 'S', rank: 3 }, hand, []), { suit: 'S', rank: 3 });
  assert.deepEqual(resolveScriptCard({ suit: 'S', rank: 'MAX' }, hand, []), { suit: 'S', rank: 14 });
  assert.deepEqual(resolveScriptCard({ suit: 'S', rank: 'MIN' }, hand, []), { suit: 'S', rank: 3 });
  assert.throws(() => resolveScriptCard({ suit: 'D', rank: 14 }, hand, []), /cannot represent/i);
});

test('capture cleanup resolves after a bounded SIGTERM/SIGKILL sequence without child exit', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  const signals = [];
  child.kill = (signal) => { signals.push(signal); return true; };
  const started = Date.now();
  await stop(child, { termMs: 5, killMs: 5 });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(Date.now() - started < 100);
});
