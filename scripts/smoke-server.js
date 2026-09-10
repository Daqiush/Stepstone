'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');

const LISTENING_PATTERN = /Stepstone .*服务器已启动/;

function withStderr(message, stderr) {
  return stderr ? `${message}\nServer stderr:\n${stderr}` : message;
}

async function smokeServer({
  rootDir = path.resolve(__dirname, '..'),
  timeoutMs = 10000,
  spawnImpl = childProcess.spawn,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  env = {},
} = {}) {
  const child = spawnImpl(process.execPath, ['server.js'], {
    cwd: rootDir,
    env: { ...process.env, ...env, PORT: '0' },
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  let closed = false;
  let outcomeChosen = false;
  let resolveClose;
  const closePromise = new Promise((resolve) => {
    resolveClose = resolve;
  });

  return new Promise((resolve, reject) => {
    let timer;

    const finish = async (error) => {
      if (outcomeChosen) return;
      outcomeChosen = true;
      clearTimer(timer);

      if (!closed) child.kill();
      await closePromise;

      if (error) reject(error);
      else resolve();
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (LISTENING_PATTERN.test(stdout)) void finish();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      void finish(new Error(withStderr(`Server process error: ${error.message}`, stderr), { cause: error }));
    });
    child.once('close', (code, signal) => {
      closed = true;
      resolveClose();
      if (!outcomeChosen) {
        const detail = signal ? `signal ${signal}` : `code ${code}`;
        void finish(new Error(withStderr(`Server exited before startup with ${detail}.`, stderr)));
      }
    });

    timer = setTimer(() => {
      void finish(new Error(withStderr(`Server did not start within ${timeoutMs}ms.`, stderr)));
    }, timeoutMs);
  });
}

async function main() {
  await smokeServer();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[server smoke] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { smokeServer };
