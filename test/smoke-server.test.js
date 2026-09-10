'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');

const { smokeServer } = require('../scripts/smoke-server');

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.killObserved = deferred();
  child.allowClose = deferred();
  child.kill = () => {
    child.killCalls += 1;
    child.killObserved.resolve();
    child.allowClose.promise.then(() => child.emit('close', null, 'SIGTERM'));
    return true;
  };
  return child;
}

test('starts the server on an ephemeral port and waits for the child to close', async () => {
  const child = fakeChild();
  const rootDir = path.resolve('fixture-stepstone');
  const spawnCalls = [];
  const timerToken = {};
  const clearedTimers = [];
  const promise = smokeServer({
    rootDir,
    env: { SMOKE_TEST: 'yes', PORT: '9123' },
    spawnImpl(...args) {
      spawnCalls.push(args);
      return child;
    },
    setTimer(callback, milliseconds) {
      assert.equal(typeof callback, 'function');
      assert.equal(milliseconds, 10000);
      return timerToken;
    },
    clearTimer: (token) => clearedTimers.push(token),
  });
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });

  child.stdout.emit('data', Buffer.from('\n🃏  Stepstone 桥牌服务器已启动\n'));
  await child.killObserved.promise;

  assert.equal(settled, false);
  assert.equal(child.killCalls, 1);
  assert.deepEqual(clearedTimers, [timerToken]);
  assert.equal(spawnCalls.length, 1);
  const [command, args, options] = spawnCalls[0];
  assert.equal(command, process.execPath);
  assert.deepEqual(args, ['server.js']);
  assert.equal(options.cwd, rootDir);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.SMOKE_TEST, 'yes');
  assert.equal(options.env.PORT, '0');

  child.allowClose.resolve();
  await promise;
  assert.equal(child.killCalls, 1);
});

test('times out with captured diagnostics and waits for the child to close', async () => {
  const child = fakeChild();
  const timerToken = {};
  const clearedTimers = [];
  let timerCallback;
  const promise = smokeServer({
    spawnImpl: () => child,
    setTimer(callback, milliseconds) {
      timerCallback = callback;
      assert.equal(milliseconds, 10000);
      return timerToken;
    },
    clearTimer: (token) => clearedTimers.push(token),
  });
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  child.stderr.emit('data', Buffer.from('captured server diagnostics'));

  timerCallback();
  await child.killObserved.promise;

  assert.equal(settled, false);
  assert.equal(child.killCalls, 1);
  assert.deepEqual(clearedTimers, [timerToken]);

  child.allowClose.resolve();
  await assert.rejects(promise, (error) => (
    /10000ms/.test(error.message)
    && /captured server diagnostics/.test(error.message)
  ));
  assert.equal(child.killCalls, 1);
});
