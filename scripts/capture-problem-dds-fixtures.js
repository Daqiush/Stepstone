'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { io } = require('socket.io-client');

function once(socket, event, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (value) => { clearTimeout(timer); resolve(value); });
  });
}

function stop(child, { termMs = 2_000, killMs = 2_000 } = {}) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    let termTimer;
    let killTimer;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve();
    };
    child.once('exit', finish);
    try { child.kill('SIGTERM'); } catch (_) { /* bounded fallback below */ }
    termTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* final timeout resolves */ } }, termMs);
    killTimer = setTimeout(finish, termMs + killMs);
  });
}

function resolveScriptCard(spec, hand, trick) {
  const ledSuit = trick[0]?.card?.suit;
  const legal = hand.filter((card) => !ledSuit || card.suit === ledSuit || !hand.some((candidate) => candidate.suit === ledSuit));
  const candidates = spec.suit ? legal.filter((card) => card.suit === spec.suit) : legal;
  if (spec.rank === 'ANY') return candidates[0] || fail(spec);
  if (spec.rank === 'MAX' || spec.rank === 'WIN') return candidates.sort((a, b) => b.rank - a.rank)[0] || fail(spec);
  if (spec.rank === 'MIN') return candidates.sort((a, b) => a.rank - b.rank)[0] || fail(spec);
  const exact = candidates.find((card) => card.suit === spec.suit && card.rank === spec.rank);
  return exact || fail(spec);
}

function fail(spec) { throw new Error(`Cannot represent script card ${spec.suit || 'ANY'}:${spec.rank} through the public protocol`); }

async function captureProblemBranch({ problemId, testCaseIndex, branchIndex }) {
  const port = 35_000 + Math.floor(Math.random() * 10_000);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = `http://127.0.0.1:${port}`;
  let owner;
  let spectator;
  let observer;
  let state;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out starting Stepstone server')), 8_000);
      server.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('Stepstone')) { clearTimeout(timer); resolve(); }
      });
      server.once('exit', (code) => reject(new Error(`Stepstone server exited early (${code})`)));
    });
    owner = io(url, { transports: ['websocket'] });
    await once(owner, 'connect');
    const created = once(owner, 'roomCreated');
    owner.emit('createRoom', { playerName: 'DDS capture', mode: 'problem' });
    const { roomId } = await created;
    spectator = io(url, { transports: ['websocket'] });
    await once(spectator, 'connect');
    const joined = once(spectator, 'probRoomJoined');
    spectator.emit('joinRoom', { roomId, playerName: 'DDS observer' });
    await joined;

    const started = once(owner, 'probStart');
    const initialDefenseHands = once(spectator, 'probSpectatorHands');
    owner.emit('probChooseProblem', { problemId });
    let start = await started;
    let initialDefense = await initialDefenseHands;
    const problem = require(path.join('..', 'public', 'problems', `${problemId}.json`));
    const testCase = problem.testCases[testCaseIndex];
    const branch = testCase.deviationBranches[branchIndex];
    const target = branch.script[branch.at];
    if (!target || (target.seat !== 'N' && target.seat !== 'S') || !Number.isInteger(target.card.rank)) {
      throw new Error(`${problemId} testCases[${testCaseIndex}] deviationBranches[${branchIndex}] cannot be driven through the public protocol`);
    }

    for (let index = 0; index < testCaseIndex; index++) {
      const tcStart = once(owner, 'probTCStart');
      const tcDefense = once(spectator, 'probSpectatorHands');
      owner.emit('probTCAdvance');
      start = await tcStart;
      initialDefense = await tcDefense;
    }
    const originalHands = { N: structuredClone(start.hands.N), S: structuredClone(start.hands.S), E: structuredClone(initialDefense.hands.E), W: structuredClone(initialDefense.hands.W) };
    const nsHands = { N: structuredClone(start.hands.N), S: structuredClone(start.hands.S) };
    let trick = [];
    const replay = async (entry, pointer) => {
      if (entry.seat === 'N' || entry.seat === 'S') {
        const card = resolveScriptCard(entry.card, nsHands[entry.seat], trick);
        const played = once(owner, 'probCardPlayed');
        owner.emit('probPlayCard', { seat: entry.seat, card });
        const event = await played;
        if (event.seat !== entry.seat) throw new Error(`Branch ${problemId} pointer ${pointer} expected ${entry.seat}, got ${event.seat}`);
        nsHands[entry.seat] = nsHands[entry.seat].filter((candidate) => candidate.suit !== card.suit || candidate.rank !== card.rank);
        trick = event.currentTrick;
      } else {
        const event = await once(owner, 'probCardPlayed');
        if (event.seat !== entry.seat) throw new Error(`Branch ${problemId} pointer ${pointer} expected automated ${entry.seat}, got ${event.seat}`);
        trick = event.currentTrick;
      }
      if (trick.length === 4) { owner.emit('probTrickCollect'); trick = []; }
    };
    for (let pointer = 0; pointer < branch.at; pointer++) await replay(testCase.script?.[pointer] || fail({ suit: 'script', rank: pointer }), pointer);
    if (target.seat !== 'N' && target.seat !== 'S') throw new Error(`${problemId} branch ${branchIndex} at=${branch.at} is not an NS-deviable public turn`);
    await replay(target, branch.at);
    ({ socket: observer, state } = await snapshotObserver(url, roomId));
    return {
      originalHands,
      completedTricks: state.completedTricks,
      trickPlayed: state.currentTrick,
      hands: { N: state.hands.N, S: state.hands.S, E: state.spectatorHands.E, W: state.spectatorHands.W },
      trump: state.contract.suit,
      trickLeader: state.leader,
      currentPlayer: state.currentPlayer,
    };
  } finally {
    owner?.disconnect();
    spectator?.disconnect();
    observer?.disconnect();
    await stop(server);
  }
}

async function captureProblemStates({ problemId, testCaseCount }) {
  const port = 35_000 + Math.floor(Math.random() * 10_000);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = `http://127.0.0.1:${port}`;
  let owner;
  let spectator;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out starting Stepstone server')), 8_000);
      server.stdout.on('data', (chunk) => { if (chunk.toString().includes('Stepstone')) { clearTimeout(timer); resolve(); } });
      server.once('exit', (code) => reject(new Error(`Stepstone server exited early (${code})`)));
    });
    owner = io(url, { transports: ['websocket'] });
    await once(owner, 'connect');
    const created = once(owner, 'roomCreated');
    owner.emit('createRoom', { playerName: 'DDS capture', mode: 'problem' });
    const { roomId } = await created;
    spectator = io(url, { transports: ['websocket'] });
    await once(spectator, 'connect');
    const joined = once(spectator, 'probRoomJoined');
    spectator.emit('joinRoom', { roomId, playerName: 'DDS observer' });
    await joined;
    const started = once(owner, 'probStart');
    const defense = once(spectator, 'probSpectatorHands');
    owner.emit('probChooseProblem', { problemId });
    const start = await started;
    const initialDefense = await defense;
    const toState = (event, ewHands) => ({
      originalHands: { N: structuredClone(event.hands.N), S: structuredClone(event.hands.S), E: structuredClone(ewHands.E), W: structuredClone(ewHands.W) },
      completedTricks: [],
      trickPlayed: [],
      hands: { N: structuredClone(event.hands.N), S: structuredClone(event.hands.S), E: structuredClone(ewHands.E), W: structuredClone(ewHands.W) },
      trump: event.contract.suit,
      trickLeader: event.leader,
      currentPlayer: event.currentPlayer,
    });
    const states = { opening: toState(start, initialDefense.hands), testCases: [toState(start, initialDefense.hands)] };
    for (let index = 1; index < testCaseCount; index++) {
      const tcStart = once(owner, 'probTCStart');
      const tcDefense = once(spectator, 'probSpectatorHands');
      owner.emit('probTCAdvance');
      states.testCases.push(toState(await tcStart, (await tcDefense).hands));
    }
    return states;
  } finally {
    owner?.disconnect();
    spectator?.disconnect();
    await stop(server);
  }
}

async function snapshotObserver(url, roomId) {
  const socket = io(url, { transports: ['websocket'] });
  await once(socket, 'connect');
  const snapshot = once(socket, 'probReconnect');
  socket.emit('joinRoom', { roomId, playerName: 'DDS snapshot observer' });
  return { socket, state: await snapshot };
}

module.exports = { captureProblemBranch, captureProblemStates, resolveScriptCard, stop };
