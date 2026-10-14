import { readFileSync, writeFileSync } from 'node:fs';

import {
  assertPlanBBudget,
  simulatePlanBBudget,
} from '../workers/src/room-foundation/budget-model.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name} value`);
  return value;
}

const roomsText = option('--rooms');
const roomsPerDay = roomsText === null ? 50 : Number(roomsText);
const modeled = assertPlanBBudget(simulatePlanBBudget({ roomsPerDay }));

const budget = {
  rooms: modeled.scenario.roomsPerDay,
  actions: modeled.rows.operations,
  requestsPerRoom: modeled.requests.billedPerRoom,
  requestsPerDay: modeled.requests.billedPerDay,
  handlerExecutionsPerRoom: modeled.duration.handlerExecutionsPerRoom,
  durationGbSecondsPerDay: modeled.duration.gbSecondsPerDay,
  readsPerRoom: modeled.rows.readPerRoom,
  writesPerRoom: modeled.rows.writtenPerRoom,
  readsPerDay: modeled.rows.readPerDay,
  writesPerDay: modeled.rows.writtenPerDay,
  indexWritesPerDay: modeled.rows.indexRowsWrittenPerDay,
  alarmWritesPerDay: modeled.rows.alarmRowsWrittenPerDay,
  deleteWritesPerDay: modeled.rows.deletedRowsWrittenPerDay,
  storageBytes: modeled.storage.bytes,
  targets: modeled.targets,
  gates: modeled.gates,
  model: 'Plan B SQLite table/index/alarm/delete accounting with bounded storage and exact Durable Object request billing.',
};

const reportPath = option('--report');
if (reportPath !== null) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (!report || typeof report !== 'object' || !report.benchmark) {
    throw new Error('Missing benchmark report');
  }
  report.budget = budget;
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

const format = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
console.log(
  `Plan B ${format.format(roomsPerDay)} rooms/day: `
  + `${format.format(budget.requestsPerDay)} billed requests, `
  + `${format.format(budget.durationGbSecondsPerDay)} GB-s, `
  + `${format.format(budget.readsPerDay)} rows read, `
  + `${format.format(budget.writesPerDay)} rows written, `
  + `${format.format(budget.storageBytes / (1024 ** 3))} GiB stored`,
);
