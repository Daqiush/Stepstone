'use strict';

const childProcess = require('node:child_process');

function runDdsProcessUnqueued(programPath, input, spawnImpl = childProcess.spawn, {
  timeoutMs,
  killGraceMs = 1_000,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(programPath, [], { windowsHide: true });
    } catch (error) {
      reject(new Error(`Failed to start DDS process ${programPath}: ${error.message}`, { cause: error }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let closed = false;
    let timeoutHandle = null;
    let forceKillHandle = null;
    let finalRejectHandle = null;

    const timeoutError = () => new Error(
      `DDS process ${programPath} timed out after ${timeoutMs}ms; stderr: ${stderr}`,
    );

    const clearProcessListeners = () => {
      child.removeListener('error', onChildError);
      child.stdin.removeListener('error', onStdinError);
      child.stdout.removeListener('data', onStdoutData);
      child.stderr.removeListener('data', onStderrData);
      child.removeListener('close', onClose);
      if (!closed) {
        // A child that ignores termination may still emit an error later.
        const ignoreLateError = () => {};
        child.on('error', ignoreLateError);
        child.once('close', () => child.removeListener('error', ignoreLateError));
      }
    };

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      if (forceKillHandle !== null) clearTimeout(forceKillHandle);
      if (finalRejectHandle !== null) clearTimeout(finalRejectHandle);
      clearProcessListeners();
      callback(value);
    };

    function onChildError(error) {
      if (timedOut) return;
      settle(
        reject,
        new Error(`DDS process ${programPath} failed: ${error.message}`, { cause: error }),
      );
    }
    function onStdinError(error) {
      if (timedOut) return;
      settle(
        reject,
        new Error(
          `DDS process ${programPath} stdin error ${error.code || 'UNKNOWN'}: ${error.message}`,
          { cause: error },
        ),
      );
    }
    function onStdoutData(data) {
      stdout += data.toString();
    }
    function onStderrData(data) {
      stderr += data.toString();
    }
    function onClose(code) {
      closed = true;
      if (timedOut) {
        settle(reject, timeoutError());
        return;
      }
      if (code === 0) {
        settle(resolve, stdout);
        return;
      }
      settle(
        reject,
        new Error(`DDS process ${programPath} exited with code ${code}; stderr: ${stderr}`),
      );
    }

    child.on('error', onChildError);
    child.stdin.on('error', onStdinError);
    child.stdout.on('data', onStdoutData);
    child.stderr.on('data', onStderrData);
    child.on('close', onClose);

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {}
        if (settled) return;
        forceKillHandle = setTimeout(() => {
          if (settled) return;
          try {
            child.kill('SIGKILL');
          } catch {}
          if (settled) return;
          finalRejectHandle = setTimeout(() => {
            settle(reject, timeoutError());
          }, killGraceMs);
        }, killGraceMs);
      }, timeoutMs);
    }
    try {
      child.stdin.end(input);
    } catch (error) {
      settle(
        reject,
        new Error(`DDS process ${programPath} stdin error: ${error.message}`, { cause: error }),
      );
    }
  });
}

function createDdsProcessRunner({
  maxConcurrency = 1,
  processRunner = runDdsProcessUnqueued,
} = {}) {
  const parsedConcurrency = typeof maxConcurrency === 'string'
    ? Number(maxConcurrency.trim())
    : maxConcurrency;
  if (!Number.isInteger(parsedConcurrency) || parsedConcurrency < 1) {
    throw new Error('maxConcurrency must be a positive integer');
  }

  let active = 0;
  const queue = [];

  function start(task) {
    active += 1;
    let result;
    try {
      result = processRunner(...task.args);
    } catch (error) {
      active -= 1;
      task.reject(error);
      drain();
      return;
    }

    Promise.resolve(result).then(task.resolve, task.reject).finally(() => {
      active -= 1;
      drain();
    });
  }

  function drain() {
    while (active < parsedConcurrency && queue.length > 0) start(queue.shift());
  }

  return (...args) => new Promise((resolve, reject) => {
    const task = { args, resolve, reject };
    if (active < parsedConcurrency) start(task);
    else queue.push(task);
  });
}

const runDdsProcess = createDdsProcessRunner({
  maxConcurrency: process.env.DDS_MAX_CONCURRENCY ?? 1,
});

module.exports = {
  createDdsProcessRunner,
  runDdsProcess,
};
