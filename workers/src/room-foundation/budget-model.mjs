const GIB = 1024 ** 3;

export const HANDLER_CATEGORIES = Object.freeze([
  'allocation',
  'initialization',
  'activation',
  'join',
  'upgrade',
  'initialHello',
  'reconnectHello',
  'ordinaryCommand',
  'alarm',
  'releaseCalls',
  'reuse',
]);

export const PLAN_B_TARGETS = Object.freeze({
  billedRequestsPerDay: 70_000,
  durationGbSecondsPerDay: 9_100,
  rowsReadPerDay: 250_000,
  rowsWrittenPerDay: 70_000,
  storageBytes: 3.5 * GIB,
});

export const PLAN_B_FREE_ALLOWANCES = Object.freeze({
  billedRequestsPerDay: 100_000,
  durationGbSecondsPerDay: 13_000,
  rowsReadPerDay: 5_000_000,
  rowsWrittenPerDay: 100_000,
  storageBytes: 5 * GIB,
});

const ZERO_COST = Object.freeze({
  rowsRead: 0,
  tableRowsWritten: 0,
  indexRowsWritten: 0,
  alarmRowsWritten: 0,
  deletedRowsWritten: 0,
});

function cost(overrides = {}) {
  return Object.freeze({ ...ZERO_COST, ...overrides });
}

// Write units are split so index maintenance, alarm mutations, and physical
// deletes remain visible. deletedRowsWritten counts deleted table rows; the
// corresponding index removals are included in indexRowsWritten.
const BASE_OPERATIONS = Object.freeze({
  allocation: { countPerRoom: 1, costEach: cost({ rowsRead: 8, tableRowsWritten: 2, indexRowsWritten: 2, alarmRowsWritten: 1 }) },
  initialization: { countPerRoom: 1, costEach: cost({ rowsRead: 1, tableRowsWritten: 3, indexRowsWritten: 4, alarmRowsWritten: 1 }) },
  activation: { countPerRoom: 1, costEach: cost({ rowsRead: 2, tableRowsWritten: 2, alarmRowsWritten: 1 }) },
  'session join': { countPerRoom: 4, costEach: cost({ rowsRead: 16, tableRowsWritten: 1, indexRowsWritten: 2 }) },
  'WebSocket upgrade': { countPerRoom: 9, costEach: cost({ rowsRead: 2, tableRowsWritten: 1, indexRowsWritten: 2, alarmRowsWritten: 1 }) },
  'initial hello': { countPerRoom: 5, costEach: cost({ rowsRead: 16, tableRowsWritten: 1, indexRowsWritten: 4, alarmRowsWritten: 1, deletedRowsWritten: 1 }) },
  'owner-auth action cancellation': { countPerRoom: 1, costEach: cost({ indexRowsWritten: 2, deletedRowsWritten: 1 }) },
  'reconnect hello': { countPerRoom: 4, costEach: cost({ rowsRead: 16, tableRowsWritten: 1, indexRowsWritten: 4, alarmRowsWritten: 1, deletedRowsWritten: 1 }) },
  'expiry cancellation': { countPerRoom: 1, costEach: cost({ rowsRead: 1, tableRowsWritten: 1, indexRowsWritten: 2, deletedRowsWritten: 1 }) },
  'ordinary command': { countPerRoom: 1_000, costEach: cost({ rowsRead: 1, tableRowsWritten: 1 }) },
  'final-socket expiry schedule': { countPerRoom: 1, costEach: cost({ rowsRead: 8, tableRowsWritten: 3, indexRowsWritten: 2, alarmRowsWritten: 1 }) },
  'begin room closing': { countPerRoom: 1, costEach: cost({ rowsRead: 12, tableRowsWritten: 2, indexRowsWritten: 4, alarmRowsWritten: 1, deletedRowsWritten: 1 }) },
  // markReleasePending reserves the registry's independent stale-release
  // alarm, even though the normal room retry resolves before it fires.
  'registry release fallback reservation': { countPerRoom: 1, costEach: cost({ rowsRead: 1, tableRowsWritten: 1, alarmRowsWritten: 1 }) },
  'release phase checkpoint': { countPerRoom: 1, costEach: cost({ rowsRead: 1, tableRowsWritten: 1, alarmRowsWritten: 1 }) },
  'registry-release retry': { countPerRoom: 1, costEach: cost({ rowsRead: 3, tableRowsWritten: 1, indexRowsWritten: 2, alarmRowsWritten: 1 }) },
  'terminal registry release': { countPerRoom: 1, costEach: cost({ rowsRead: 1, tableRowsWritten: 1, alarmRowsWritten: 1 }) },
  'room deleteAll': { countPerRoom: 1, costEach: cost({ indexRowsWritten: 12, alarmRowsWritten: 1, deletedRowsWritten: 7 }) },
  'reuse allocation': { countPerRoom: 1, costEach: cost({ rowsRead: 10, tableRowsWritten: 2, indexRowsWritten: 1, alarmRowsWritten: 1 }) },
  'reuse initialization': { countPerRoom: 1, costEach: cost({ rowsRead: 1, tableRowsWritten: 3, indexRowsWritten: 4, alarmRowsWritten: 1 }) },
  'reuse activation': { countPerRoom: 1, costEach: cost({ rowsRead: 2, tableRowsWritten: 2, alarmRowsWritten: 1 }) },
  'creation request retention cleanup': { countPerRoom: 1, costEach: cost({ rowsRead: 2, indexRowsWritten: 2, deletedRowsWritten: 2 }) },
});

function operationWithTotal(operation) {
  const total = {};
  for (const key of Object.keys(ZERO_COST)) {
    total[key] = operation.countPerRoom * operation.costEach[key];
  }
  return { countPerRoom: operation.countPerRoom, costEach: { ...operation.costEach }, total };
}

function sumOperations(operations, key) {
  return Object.values(operations).reduce((sum, operation) => sum + operation.total[key], 0);
}

function gate(name, actual, target, allowance) {
  return Object.freeze({ name, actual, target, allowance, passed: actual <= target });
}

function validatedRegression(regression = {}) {
  const normalized = {
    commandTableRowsWritten: regression.commandTableRowsWritten ?? 0,
    commandIndexRowsWritten: regression.commandIndexRowsWritten ?? 0,
    recipientRowsReadPerCommand: regression.recipientRowsReadPerCommand ?? 0,
  };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  }
  return normalized;
}

export function simulatePlanBBudget({ roomsPerDay = 50, regression = {} } = {}) {
  if (!Number.isSafeInteger(roomsPerDay) || roomsPerDay <= 0) {
    throw new TypeError('roomsPerDay must be a positive integer');
  }
  const extra = validatedRegression(regression);
  const operations = Object.fromEntries(
    Object.entries(BASE_OPERATIONS).map(([name, operation]) => [name, operationWithTotal(operation)]),
  );
  operations['hypothetical per-command regression'] = operationWithTotal({
    countPerRoom: 1_000,
    costEach: cost({
      rowsRead: extra.recipientRowsReadPerCommand,
      tableRowsWritten: extra.commandTableRowsWritten,
      indexRowsWritten: extra.commandIndexRowsWritten,
    }),
  });

  const websocketMessages = 5 + 1_000 + 4;
  const websocketMessageBillingGroups = Math.ceil(websocketMessages / 20);
  const billedPerRoom = 3 + 4 + 9 + websocketMessageBillingGroups + 2 + 3 + 3;
  const handlerExecutionsPerRoom = 3 + 4 + 9 + websocketMessages + 2 + 3 + 3;
  const durationGbSecondsPerDay = roomsPerDay * handlerExecutionsPerRoom * 0.5 * 0.128;

  const readPerRoom = sumOperations(operations, 'rowsRead');
  const tableRowsWrittenPerRoom = sumOperations(operations, 'tableRowsWritten');
  const indexRowsWrittenPerRoom = sumOperations(operations, 'indexRowsWritten');
  const alarmRowsWrittenPerRoom = sumOperations(operations, 'alarmRowsWritten');
  const deletedRowsWrittenPerRoom = sumOperations(operations, 'deletedRowsWritten');
  const writtenPerRoom = tableRowsWrittenPerRoom + indexRowsWrittenPerRoom
    + alarmRowsWrittenPerRoom + deletedRowsWrittenPerRoom;

  // Snapshot size is protocol-capped at 512 KiB. The remaining terms reserve
  // 4 KiB per retained session/action row and a 2x SQLite/index overhead.
  const roomStorageUpperBound = (512 * 1024 + 5 * 4 * 1024 + 2 * 4 * 1024) * 2;
  const registryStorageUpperBound = (1_000 * 512 + 2_000 * 4 * 1024) * 2;
  const storageBytes = roomsPerDay * roomStorageUpperBound + registryStorageUpperBound;

  const requests = {
    perRoomFormula: {
      createRpcs: 3,
      joinRpcs: 4,
      websocketConnections: 9,
      websocketMessages,
      websocketMessageBillingGroups,
      alarmInvocations: 2,
      releaseRpcs: 3,
      reuseRpcs: 3,
    },
    billedPerRoom,
    billedPerDay: billedPerRoom * roomsPerDay,
  };
  const duration = {
    handlerExecutionsPerRoom,
    handlerExecutionsPerDay: handlerExecutionsPerRoom * roomsPerDay,
    activeSecondsPerHandler: 0.5,
    memoryGb: 0.128,
    gbSecondsPerDay: durationGbSecondsPerDay,
  };
  const rows = {
    operations,
    readPerRoom,
    readPerDay: readPerRoom * roomsPerDay,
    tableRowsWrittenPerRoom,
    tableRowsWrittenPerDay: tableRowsWrittenPerRoom * roomsPerDay,
    indexRowsWrittenPerRoom,
    indexRowsWrittenPerDay: indexRowsWrittenPerRoom * roomsPerDay,
    alarmRowsWrittenPerRoom,
    alarmRowsWrittenPerDay: alarmRowsWrittenPerRoom * roomsPerDay,
    deletedRowsWrittenPerRoom,
    deletedRowsWrittenPerDay: deletedRowsWrittenPerRoom * roomsPerDay,
    writtenPerRoom,
    writtenPerDay: writtenPerRoom * roomsPerDay,
  };
  const storage = { bytes: storageBytes, gibibytes: storageBytes / GIB };
  const gates = [
    gate('billedRequests', requests.billedPerDay, PLAN_B_TARGETS.billedRequestsPerDay, PLAN_B_FREE_ALLOWANCES.billedRequestsPerDay),
    gate('duration', duration.gbSecondsPerDay, PLAN_B_TARGETS.durationGbSecondsPerDay, PLAN_B_FREE_ALLOWANCES.durationGbSecondsPerDay),
    gate('rowsRead', rows.readPerDay, PLAN_B_TARGETS.rowsReadPerDay, PLAN_B_FREE_ALLOWANCES.rowsReadPerDay),
    gate('rowsWritten', rows.writtenPerDay, PLAN_B_TARGETS.rowsWrittenPerDay, PLAN_B_FREE_ALLOWANCES.rowsWrittenPerDay),
    gate('storage', storage.bytes, PLAN_B_TARGETS.storageBytes, PLAN_B_FREE_ALLOWANCES.storageBytes),
  ];

  return {
    scenario: { roomsPerDay, commandsPerRoom: 1_000, initialSocketsPerRoom: 5, reconnectsPerRoom: 4 },
    requests,
    duration,
    rows,
    storage,
    targets: { ...PLAN_B_TARGETS },
    freeAllowances: { ...PLAN_B_FREE_ALLOWANCES },
    gates,
    gatesByName: Object.fromEntries(gates.map((item) => [item.name, item])),
  };
}

export function assertPlanBBudget(report) {
  const failed = report?.gates?.filter((item) => item.passed !== true) ?? [];
  if (failed.length > 0) {
    throw new Error(`Plan B budget exceeded: ${failed.map((item) => item.name).join(', ')}`);
  }
  return report;
}

export function createHandlerLatencyRecorder({ now, limitMs = 500 } = {}) {
  if (typeof now !== 'function') throw new TypeError('A controlled clock is required');
  if (!Number.isFinite(limitMs) || limitMs <= 0) throw new TypeError('limitMs must be positive');
  const observed = new Map();

  return Object.freeze({
    async measure(category, handler) {
      if (!HANDLER_CATEGORIES.includes(category)) throw new TypeError(`Unknown handler category: ${category}`);
      if (typeof handler !== 'function') throw new TypeError('handler must be a function');
      const startedAt = now();
      const value = await handler();
      const milliseconds = now() - startedAt;
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new TypeError(`Invalid controlled duration for ${category}`);
      }
      const passed = milliseconds < limitMs;
      observed.set(category, Object.freeze({ milliseconds, limitMs, passed }));
      if (!passed) throw new Error(`${category} exceeded ${limitMs} ms`);
      return value;
    },
    assertComplete() {
      const missing = HANDLER_CATEGORIES.filter((category) => !observed.has(category));
      if (missing.length > 0) throw new Error(`Missing handler latency categories: ${missing.join(', ')}`);
      return Object.fromEntries(observed);
    },
  });
}
