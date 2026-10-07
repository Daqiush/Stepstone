import { readFileSync, writeFileSync } from 'node:fs';

const at = process.argv.indexOf('--report');
const file = at < 0 ? 'workers/test/results/dds-feasibility.json' : process.argv[at + 1];
if (!file) throw new Error('Missing --report path');
const report = JSON.parse(readFileSync(file, 'utf8')); // Missing report must fail.
if (!report || typeof report !== 'object' || !report.benchmark) throw new Error('Missing benchmark report');

const rooms = 50;
// Each unit denotes one SQL row read or written. An update reads its current
// row then writes it. The retry reads twice before its successful release.
const actions = {
  allocation: { countPerRoom: 1, readsEach: 1, writesEach: 1 },
  'owner-session insert': { countPerRoom: 1, readsEach: 1, writesEach: 1 },
  'join-session insert': { countPerRoom: 4, readsEach: 1, writesEach: 1 },
  'state-row update': { countPerRoom: 1000, readsEach: 1, writesEach: 1 },
  'token rotation': { countPerRoom: 4, readsEach: 1, writesEach: 1 },
  'scheduled-action insert/delete pair': { countPerRoom: 1, readsEach: 1, writesEach: 2 },
  expiry: { countPerRoom: 1, readsEach: 1, writesEach: 1 },
  'registry-release retry': { countPerRoom: 1, readsEach: 2, writesEach: 1 },
  'reuse/tombstone cycle': { countPerRoom: 1, readsEach: 2, writesEach: 2 },
};
const perRoom = Object.values(actions).reduce((total, action) => ({
  reads: total.reads + action.countPerRoom * action.readsEach,
  writes: total.writes + action.countPerRoom * action.writesEach,
}), { reads: 0, writes: 0 });
report.budget = {
  rooms, actions, readsPerRoom: perRoom.reads, writesPerRoom: perRoom.writes,
  readsPerDay: perRoom.reads * rooms, writesPerDay: perRoom.writes * rooms,
  model: 'SQL row counts: updates read then write one row; registry release retries one read before success.',
};
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Simulated ${rooms} rooms/day: ${report.budget.readsPerDay} SQL row reads, ${report.budget.writesPerDay} SQL row writes`);
