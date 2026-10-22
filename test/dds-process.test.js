'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createDdsProcessRunner, runDdsProcess } = require('../dds-process');

function controlledChild() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin.end = (input, callback) => {
    child.stdin.input = input;
    if (callback) callback();
  };
  return child;
}

test('real Node process resolves its exact stdout', async () => {
  const output = await runDdsProcess(
    process.execPath,
    "process.stdout.write('DDS OK')",
  );

  assert.equal(output, 'DDS OK');
});

test('real Node process rejection includes path, exit code, and stderr', async () => {
  await assert.rejects(
    runDdsProcess(
      process.execPath,
      "process.stderr.write('broken'); process.exitCode = 7",
    ),
    (error) => {
      assert.match(error.message, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(error.message, /7/);
      assert.match(error.message, /broken/);
      return true;
    },
  );
});

test('child error settles once even when close follows', async () => {
  const child = controlledChild();
  let callbackCount = 0;
  const result = runDdsProcess('C:\\missing\\dds.exe', '', () => child).then(
    () => { callbackCount += 1; },
    (error) => {
      callbackCount += 1;
      assert.match(error.message, /C:\\missing\\dds\.exe/);
    },
  );

  child.emit('error', new Error('ENOENT'));
  child.emit('close', -1);
  await result;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(callbackCount, 1);
});

test('stdin EPIPE settles once even when close follows', async () => {
  const child = controlledChild();
  const programPath = 'C:\\tools\\dds.exe';
  let callbackCount = 0;
  const result = runDdsProcess(programPath, 'input', () => child).then(
    () => { callbackCount += 1; },
    (error) => {
      callbackCount += 1;
      assert.match(error.message, /C:\\tools\\dds\.exe/);
      assert.match(error.message, /stdin/i);
      assert.match(error.message, /EPIPE/);
    },
  );

  const stdinError = new Error('pipe closed');
  stdinError.code = 'EPIPE';
  child.stdin.emit('error', stdinError);
  child.emit('close', 1);
  await result;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(callbackCount, 1);
});

test('empty stderr reports the path and code, and synchronous spawn throws have context', async () => {
  const child = controlledChild();
  const programPath = 'C:\\tools\\dds.exe';
  const result = runDdsProcess(programPath, '', () => child);

  child.emit('close', 9);

  await assert.rejects(result, (error) => {
    assert.match(error.message, /C:\\tools\\dds\.exe/);
    assert.match(error.message, /9/);
    return true;
  });

  await assert.rejects(
    runDdsProcess(programPath, '', () => {
      throw new Error('launch exploded');
    }),
    (error) => {
      assert.match(error.message, /C:\\tools\\dds\.exe/);
      assert.match(error.message, /launch exploded/);
      return true;
    },
  );

  const timedChild = controlledChild();
  let killCount = 0;
  timedChild.kill = () => {
    killCount += 1;
    setImmediate(() => {
      timedChild.emit('error', new Error('terminated'));
      timedChild.emit('close', null);
    });
    return true;
  };
  const timedResult = runDdsProcess(programPath, '', () => timedChild, { timeoutMs: 5 });
  timedChild.stderr.emit('data', 'still working');
  await assert.rejects(timedResult, (error) => {
    assert.match(error.message, /timed out/i);
    assert.match(error.message, /C:\\tools\\dds\.exe/);
    assert.match(error.message, /still working/);
    return true;
  });
  assert.equal(killCount, 1);

  const ignoringChild = controlledChild();
  const signals = [];
  ignoringChild.kill = (signal) => {
    signals.push(signal);
    return false;
  };
  await assert.rejects(
    runDdsProcess(programPath, '', () => ignoringChild, { timeoutMs: 5, killGraceMs: 5 }),
    (error) => {
      assert.match(error.message, /timed out/i);
      assert.match(error.message, /C:\\tools\\dds\.exe/);
      return true;
    },
  );
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('DDS process runner enforces a shared FIFO concurrency limit', async () => {
  const children = [];
  const runner = createDdsProcessRunner({ maxConcurrency: 1 });
  const spawnImpl = () => {
    const child = controlledChild();
    children.push(child);
    return child;
  };

  const first = runner('dds_calc', 'first', spawnImpl);
  const second = runner('dds_solve', 'second', spawnImpl);

  assert.equal(children.length, 1);
  assert.equal(children[0].stdin.input, 'first');

  children[0].stdout.emit('data', 'first-result');
  children[0].emit('close', 0);
  assert.equal(await first, 'first-result');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(children.length, 2);
  assert.equal(children[1].stdin.input, 'second');
  children[1].stdout.emit('data', 'second-result');
  children[1].emit('close', 0);
  assert.equal(await second, 'second-result');
});

test('DDS process runner rejects invalid concurrency limits', () => {
  for (const value of [0, -1, 1.5, 'two']) {
    assert.throws(
      () => createDdsProcessRunner({ maxConcurrency: value }),
      /maxConcurrency.*positive integer/i,
    );
  }
});
