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
const successVariant = modeled.rows.variants.successAfterEviction;
const exhaustionVariant = modeled.rows.variants.attempt3Exhaustion;
const ordinaryOnlyRowsRead = modeled.rows.operations['ordinary command'].total.rowsRead;
const ordinaryOnlyRowsWritten = Object.entries(modeled.rows.operations['ordinary command'].total)
  .filter(([name]) => name !== 'rowsRead')
  .reduce((sum, [, value]) => sum + value, 0);
const ddsOperationNames = [
  'classic DDS action creation',
  'classic DDS alarm computation',
  'classic DDS guarded retry update',
  'classic DDS stale overlap guard',
  'classic DDS exhausted trusted settlement',
];
const ddsRows = ddsOperationNames.reduce((totals, name) => {
  const operation = modeled.rows.operations[name];
  totals.read += operation.total.rowsRead;
  totals.written += Object.entries(operation.total)
    .filter(([key]) => key !== 'rowsRead')
    .reduce((sum, [, value]) => sum + value, 0);
  return totals;
}, { read: 0, written: 0 });

const budget = {
  rooms: modeled.scenario.roomsPerDay,
  classicDealsPerRoom: modeled.scenario.classicDealsPerRoom,
  logicalDdsAttemptsPerDeal: modeled.scenario.logicalDdsAttemptsPerDeal,
  maxDdsComputationsPerDeal: modeled.scenario.maxDdsComputationsPerDeal,
  commandReservation: modeled.classicDeal.commandReservation,
  dds: modeled.dds,
  ddsRowsPerRoom: ddsRows,
  actions: modeled.rows.operations,
  variants: {
    successAfterEviction: {
      outcome: modeled.dds.variants.successAfterEviction.outcome,
      rowsReadPerRoom: successVariant.readPerRoom,
      rowsWrittenPerRoom: successVariant.writtenPerRoom,
      gates: successVariant.gates,
    },
    attempt3Exhaustion: {
      outcome: modeled.dds.variants.attempt3Exhaustion.outcome,
      rowsReadPerRoom: exhaustionVariant.readPerRoom,
      rowsWrittenPerRoom: exhaustionVariant.writtenPerRoom,
      gates: exhaustionVariant.gates,
    },
  },
  requestsPerRoom: modeled.requests.billedPerRoom,
  requestsPerDay: modeled.requests.billedPerDay,
  requestTriggeredHandlerExecutionsPerRoom:
    modeled.duration.requestTriggeredHandlerExecutionsPerRoom,
  handlerExecutionsPerRoom: modeled.duration.handlerExecutionsPerRoom,
  ddsComputeExecutionsPerRoom: modeled.duration.ddsComputeExecutionsPerRoom,
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
  model: 'Plan B consumed-cursor SQL profiles at 50 room rows and 100 retained replay rows with all tombstones eligible for worst-case reuse, one complete classic deal inside the existing 1,000-command reservation, mutually exclusive DDS success/exhaustion settlements, explicit table/index/alarm/delete accounting, one two-row room reconstruction per handler, decimal-GB storage, and exact Durable Object request billing.',
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
  + `${format.format(budget.storageBytes / 1_000_000_000)} GB stored`,
);
console.log(
  `Assumption: one complete classic deal per room uses `
  + `${format.format(budget.commandReservation.commandsUsed)} of `
  + `${format.format(budget.commandReservation.commandsReserved)} commands `
  + `(${budget.commandReservation.maximumLegalAuctionCalls} auction calls, `
  + `${budget.commandReservation.cardPlays} plays, `
  + `${budget.commandReservation.readyCommands} ready commands, `
  + `${budget.commandReservation.reconnectSnapshots} reconnect snapshots).`,
);
console.log(
  `DDS: ${budget.logicalDdsAttemptsPerDeal} logical attempts, `
  + `${budget.maxDdsComputationsPerDeal} computations, `
  + `${modeled.requests.perRoomFormula.ddsAlarmInvocations} alarm requests per room.`,
);
console.log(
  `DDS rows: ${format.format(ddsRows.read)} read, `
  + `${format.format(ddsRows.written)} written per room `
  + `(ordinary reservation remains ${format.format(ordinaryOnlyRowsRead)} read/`
  + `${format.format(ordinaryOnlyRowsWritten)} written).`,
);
console.log(
  `Variant success after eviction: ${budget.variants.successAfterEviction.outcome}, `
  + `${format.format(successVariant.readPerRoom)} rows read, `
  + `${format.format(successVariant.writtenPerRoom)} rows written per room.`,
);
console.log(
  `Variant attempt-3 exhaustion: ${budget.variants.attempt3Exhaustion.outcome}, `
  + `${format.format(exhaustionVariant.readPerRoom)} rows read, `
  + `${format.format(exhaustionVariant.writtenPerRoom)} rows written per room.`,
);
console.log(
  `Gates (Plan B target/Free allowance): `
  + modeled.gates.map(gate => `${gate.name}=${gate.passed}/${gate.freePassed}`).join(', '),
);
