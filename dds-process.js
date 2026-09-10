'use strict';

const childProcess = require('node:child_process');

function runDdsProcess(programPath, input, spawnImpl = childProcess.spawn, { timeoutMs } = {}) {
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
    let timeoutHandle = null;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      callback(value);
    };

    child.on('error', (error) => {
      if (timedOut) return;
      settle(
        reject,
        new Error(`DDS process ${programPath} failed: ${error.message}`, { cause: error }),
      );
    });
    child.stdin.on('error', (error) => {
      if (timedOut) return;
      settle(
        reject,
        new Error(
          `DDS process ${programPath} stdin error ${error.code || 'UNKNOWN'}: ${error.message}`,
          { cause: error },
        ),
      );
    });
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('close', (code) => {
      if (timedOut) {
        settle(
          reject,
          new Error(`DDS process ${programPath} timed out after ${timeoutMs}ms; stderr: ${stderr}`),
        );
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
    });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        try {
          child.kill();
        } catch (error) {
          settle(
            reject,
            new Error(
              `DDS process ${programPath} timed out after ${timeoutMs}ms and could not be stopped: ${error.message}; stderr: ${stderr}`,
              { cause: error },
            ),
          );
        }
      }, timeoutMs);
    }
    child.stdin.end(input);
  });
}

module.exports = { runDdsProcess };
