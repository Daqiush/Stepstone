'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { smokeServer } = require('../scripts/smoke-server');

function fakeChild(killImpl = () => true) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.unrefCalls = 0;
  child.kill = (signal) => {
    child.signals.push(signal);
    return killImpl(signal, child);
  };
  child.unref = () => {
    child.unrefCalls += 1;
  };
  return child;
}

function manualTimers() {
  const timers = [];
  return {
    timers,
    setTimer(callback, milliseconds) {
      const timer = { callback, milliseconds, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      if (timer) timer.cleared = true;
    },
    fireNext(milliseconds) {
      const timer = timers.find((candidate) => (
        !candidate.cleared && !candidate.fired && candidate.milliseconds === milliseconds
      ));
      assert.ok(timer, `expected an active ${milliseconds}ms timer`);
      timer.fired = true;
      timer.callback();
      return timer;
    },
    active() {
      return timers.filter((timer) => !timer.cleared && !timer.fired);
    },
  };
}

function tracked(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  return () => settled;
}

function splitInside(buffer, text) {
  const start = buffer.indexOf(Buffer.from(text));
  assert.notEqual(start, -1);
  return [buffer.subarray(0, start + 1), buffer.subarray(start + 1)];
}

test('server startup detection is UTF-8 safe and cleanup is bounded', async (t) => {
  await t.test('detects listening text split inside a multibyte character and waits for close', async () => {
    const child = fakeChild();
    const clock = manualTimers();
    const rootDir = path.resolve('fixture-stepstone');
    const spawnCalls = [];
    const promise = smokeServer({
      rootDir,
      env: { SMOKE_TEST: 'yes', PORT: '9123' },
      spawnImpl(...args) {
        spawnCalls.push(args);
        return child;
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      killGraceMs: 5,
    });
    const isSettled = tracked(promise);
    const chunks = splitInside(Buffer.from('\n🃏  Stepstone 桥牌服务器已启动\n'), '服务器已启动');

    child.stdout.emit('data', chunks[0]);
    child.stdout.emit('data', chunks[1]);
    await Promise.resolve();

    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.equal(isSettled(), false);
    assert.deepEqual(clock.active().map((timer) => timer.milliseconds), [5]);
    assert.equal(spawnCalls.length, 1);
    const [command, args, options] = spawnCalls[0];
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ['server.js']);
    assert.equal(options.cwd, rootDir);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.SMOKE_TEST, 'yes');
    assert.equal(options.env.PORT, '0');

    child.emit('close', null, 'SIGTERM');
    await promise;
    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.deepEqual(clock.active(), []);
  });

  await t.test('escalates an ignored SIGTERM to SIGKILL and succeeds after close', async () => {
    const child = fakeChild((signal, processChild) => {
      if (signal === 'SIGKILL') processChild.emit('close', null, signal);
      return true;
    });
    const clock = manualTimers();
    const promise = smokeServer({
      spawnImpl: () => child,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      killGraceMs: 5,
    });

    child.stdout.emit('data', Buffer.from('Stepstone 桥牌服务器已启动'));
    assert.deepEqual(child.signals, ['SIGTERM']);
    clock.fireNext(5);

    await promise;
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(clock.active(), []);
  });

  await t.test('rejects within a final grace period when child termination returns false and never closes', async () => {
    const child = fakeChild(() => false);
    const clock = manualTimers();
    const promise = smokeServer({
      spawnImpl: () => child,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      killGraceMs: 5,
    });

    child.stdout.emit('data', Buffer.from('Stepstone 桥牌服务器已启动'));
    clock.fireNext(5);
    clock.fireNext(5);

    await assert.rejects(promise, (error) => {
      assert.match(error.message, /did not close.*SIGTERM.*SIGKILL/i);
      assert.match(error.message, /SIGTERM.*returned false/i);
      assert.match(error.message, /SIGKILL.*returned false/i);
      return true;
    });
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    assert.equal(child.unrefCalls, 1);
    for (const emitter of [child, child.stdout, child.stderr]) {
      for (const event of ['data', 'error', 'close']) {
        assert.equal(emitter.listenerCount(event), 0, `${event} listener remained`);
      }
    }
    assert.equal(child.listenerCount('exit'), 0);
    assert.deepEqual(clock.active(), []);
  });

  await t.test('still escalates and settles when both child kill attempts throw', async () => {
    const child = fakeChild(() => {
      throw new Error('kill unavailable');
    });
    const clock = manualTimers();
    const promise = smokeServer({
      spawnImpl: () => child,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      killGraceMs: 5,
    });

    child.stdout.emit('data', Buffer.from('Stepstone 桥牌服务器已启动'));
    clock.fireNext(5);
    clock.fireNext(5);

    await assert.rejects(promise, /kill unavailable/);
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(clock.active(), []);
  });

  await t.test('does not signal again after SIGTERM has already caused process exit', async () => {
    const child = fakeChild((signal, processChild) => {
      if (signal === 'SIGTERM') processChild.emit('exit', null, signal);
      return true;
    });
    const clock = manualTimers();
    const promise = smokeServer({
      spawnImpl: () => child,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      killGraceMs: 5,
    });

    child.stdout.emit('data', Buffer.from('Stepstone 桥牌服务器已启动'));
    clock.fireNext(5);

    assert.deepEqual(child.signals, ['SIGTERM']);
    await assert.rejects(promise, /did not close after exiting/i);
    assert.deepEqual(clock.active(), []);
  });
});

test('failure paths settle once with bounded UTF-8 diagnostic tails', async (t) => {
  await t.test('timeout escalates without hanging and reports bounded stdout and stderr tails', async () => {
    const child = fakeChild(() => false);
    const clock = manualTimers();
    const promise = smokeServer({
      spawnImpl: () => child,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      killGraceMs: 5,
      outputTailChars: 32,
    });
    const stderr = Buffer.from(`${'discard-stderr-'.repeat(5)}服务器错误-tail`);
    const stderrChunks = splitInside(stderr, '服务器错误');
    child.stdout.emit('data', Buffer.from(`${'discard-stdout-'.repeat(5)}stdout-tail`));
    child.stderr.emit('data', stderrChunks[0]);
    child.stderr.emit('data', stderrChunks[1]);

    clock.fireNext(10000);
    clock.fireNext(5);
    clock.fireNext(5);

    await assert.rejects(promise, (error) => {
      assert.match(error.message, /10000ms/);
      assert.match(error.message, /stdout tail:[\s\S]*stdout-tail/);
      assert.match(error.message, /stderr tail:[\s\S]*服务器错误-tail/);
      assert.doesNotMatch(error.message, /discard-stdout-discard/);
      assert.doesNotMatch(error.message, /discard-stderr-discard/);
      return true;
    });
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  });

  await t.test('early close rejects without trying to kill an exited child', async () => {
    const child = fakeChild();
    const clock = manualTimers();
    const promise = smokeServer({
      spawnImpl: () => child,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      killGraceMs: 5,
    });

    child.stderr.emit('data', Buffer.from('early diagnostics'));
    child.emit('close', 7, null);

    await assert.rejects(promise, /code 7[\s\S]*early diagnostics/);
    assert.deepEqual(child.signals, []);
    assert.deepEqual(clock.active(), []);
  });

  await t.test('child error rejects once after child-only termination and close', async () => {
    const child = fakeChild((signal, processChild) => {
      queueMicrotask(() => processChild.emit('close', null, signal));
      return true;
    });
    const clock = manualTimers();
    const promise = smokeServer({
      spawnImpl: () => child,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      killGraceMs: 5,
    });
    let rejectionCount = 0;
    promise.catch(() => { rejectionCount += 1; });

    child.stderr.emit('data', Buffer.from('spawn diagnostics'));
    child.emit('error', new Error('spawn failed'));
    await assert.rejects(promise, /spawn failed[\s\S]*spawn diagnostics/);
    child.emit('close', null, 'SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(rejectionCount, 1);
    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.deepEqual(clock.active(), []);
  });
});
