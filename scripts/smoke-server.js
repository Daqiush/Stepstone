'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const LISTENING_PATTERN = /Stepstone .*服务器已启动/;

function appendTail(tail, text, limit) {
  const combined = tail + text;
  return combined.length > limit ? combined.slice(-limit) : combined;
}

async function smokeServer({
  rootDir = path.resolve(__dirname, '..'),
  timeoutMs = 10000,
  spawnImpl = childProcess.spawn,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  env = {},
  killGraceMs = 1000,
  outputTailChars = 8192,
} = {}) {
  const child = spawnImpl(process.execPath, ['server.js'], {
    cwd: rootDir,
    env: { ...process.env, ...env, PORT: '0' },
    windowsHide: true,
  });
  const tailLimit = Number.isFinite(outputTailChars) && outputTailChars > 0
    ? Math.floor(outputTailChars)
    : 8192;
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');

  return new Promise((resolve, reject) => {
    let stdoutTail = '';
    let stderrTail = '';
    let decodersEnded = false;
    let exited = false;
    let closed = false;
    let settled = false;
    let outcome = null;
    let startupTimer = null;
    let forceKillTimer = null;
    let finalTimer = null;
    const killErrors = [];

    const clearHandle = (name) => {
      const handle = name === 'startup'
        ? startupTimer
        : name === 'force' ? forceKillTimer : finalTimer;
      if (handle !== null) clearTimer(handle);
      if (name === 'startup') startupTimer = null;
      else if (name === 'force') forceKillTimer = null;
      else finalTimer = null;
    };

    const endDecoders = () => {
      if (decodersEnded) return;
      decodersEnded = true;
      stdoutTail = appendTail(stdoutTail, stdoutDecoder.end(), tailLimit);
      stderrTail = appendTail(stderrTail, stderrDecoder.end(), tailLimit);
    };

    const diagnostics = () => (
      `stdout tail:\n${stdoutTail || '(empty)'}\nstderr tail:\n${stderrTail || '(empty)'}`
    );

    const removeProcessListeners = () => {
      child.stdout.removeListener('data', onStdoutData);
      child.stderr.removeListener('data', onStderrData);
      child.removeListener('error', onChildError);
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      if (!closed) {
        const ignoreLateError = () => {};
        child.on('error', ignoreLateError);
        child.once('close', () => child.removeListener('error', ignoreLateError));
      }
    };

    const settle = (overrideMessage) => {
      if (settled) return;
      settled = true;
      clearHandle('startup');
      clearHandle('force');
      clearHandle('final');
      endDecoders();
      removeProcessListeners();

      const message = overrideMessage === undefined ? outcome.message : overrideMessage;
      if (message === null) {
        resolve();
        return;
      }
      const error = new Error(`${message}\n${diagnostics()}`, { cause: outcome.cause });
      reject(error);
    };

    const attemptKill = (signal) => {
      try {
        child.kill(signal);
      } catch (error) {
        killErrors.push(`${signal}: ${error.message}`);
      }
    };

    const noCloseMessage = (terminationDescription) => {
      const parts = [];
      if (outcome.message !== null) parts.push(outcome.message);
      parts.push(`Server child did not close ${terminationDescription}.`);
      if (killErrors.length > 0) parts.push(`Termination errors: ${killErrors.join('; ')}`);
      return parts.join('\n');
    };

    const waitForCloseAfterExit = () => {
      if (closed) {
        settle();
        return;
      }
      clearHandle('force');
      if (finalTimer === null) {
        finalTimer = setTimer(() => {
          settle(noCloseMessage('after exiting'));
        }, killGraceMs);
      }
    };

    const startCleanup = () => {
      if (closed) {
        settle();
        return;
      }
      if (exited) {
        waitForCloseAfterExit();
        return;
      }

      attemptKill('SIGTERM');
      if (closed || settled) return;
      if (exited) {
        waitForCloseAfterExit();
        return;
      }
      forceKillTimer = setTimer(() => {
        if (exited) {
          waitForCloseAfterExit();
          return;
        }
        attemptKill('SIGKILL');
        if (closed || settled) return;
        if (exited) {
          waitForCloseAfterExit();
          return;
        }
        finalTimer = setTimer(() => {
          settle(noCloseMessage('after SIGTERM and SIGKILL'));
        }, killGraceMs);
      }, killGraceMs);
    };

    const chooseOutcome = (message, cause = undefined) => {
      if (outcome !== null) return;
      outcome = { message, cause };
      clearHandle('startup');
      startCleanup();
    };

    function onStdoutData(chunk) {
      const decoded = stdoutDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      stdoutTail = appendTail(stdoutTail, decoded, tailLimit);
      if (LISTENING_PATTERN.test(stdoutTail)) chooseOutcome(null);
    }
    function onStderrData(chunk) {
      const decoded = stderrDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      stderrTail = appendTail(stderrTail, decoded, tailLimit);
    }
    function onChildError(error) {
      chooseOutcome(`Server process error: ${error.message}`, error);
    }
    function onExit(code, signal) {
      exited = true;
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      if (outcome === null) chooseOutcome(`Server exited before startup with ${detail}.`);
      else waitForCloseAfterExit();
    }
    function onClose(code, signal) {
      exited = true;
      closed = true;
      if (outcome === null) {
        const detail = signal ? `signal ${signal}` : `code ${code}`;
        chooseOutcome(`Server exited before startup with ${detail}.`);
        return;
      }
      settle();
    }

    child.stdout.on('data', onStdoutData);
    child.stderr.on('data', onStderrData);
    child.once('error', onChildError);
    child.once('exit', onExit);
    child.once('close', onClose);
    startupTimer = setTimer(() => {
      chooseOutcome(`Server did not start within ${timeoutMs}ms.`);
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
