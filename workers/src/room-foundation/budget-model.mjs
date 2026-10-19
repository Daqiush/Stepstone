import { PUBLIC_ROOM_ROUTER_DO_CALL_GRAPH } from './router-call-graph.mjs';

const GB = 1_000_000_000;

export const HANDLER_CATEGORIES = Object.freeze([
  'allocation',
  'initializeActivate',
  'join',
  'upgrade',
  'initialHello',
  'reconnectHello',
  'ordinaryCommand',
  'alarm',
  'releaseWorkflow',
  'reuseWorkflow',
  'fallbackReconcile',
]);

export const PLAN_B_TARGETS = Object.freeze({
  billedRequestsPerDay: 70_000,
  durationGbSecondsPerDay: 9_100,
  rowsReadPerDay: 250_000,
  rowsWrittenPerDay: 70_000,
  storageBytes: 3.5 * GB,
});

export const PLAN_B_FREE_ALLOWANCES = Object.freeze({
  billedRequestsPerDay: 100_000,
  durationGbSecondsPerDay: 13_000,
  rowsReadPerDay: 5_000_000,
  rowsWrittenPerDay: 100_000,
  storageBytes: 5 * GB,
});

const ZERO_COST = Object.freeze({
  rowsRead: 0,
  tableRowsWritten: 0,
  indexRowsWritten: 0,
  alarmRowsWritten: 0,
  deletedRowsWritten: 0,
});

export const MEASURED_CLASSIC_DDS_SQL_PROFILES = Object.freeze({
  actionCreation: Object.freeze({
    rowsRead: 3,
    tableRowsWritten: 1,
    indexRowsWritten: 2,
    alarmRowsWritten: 1,
    deletedRowsWritten: 0,
  }),
  alarmComputation: Object.freeze({
    rowsRead: 5,
    tableRowsWritten: 0,
    indexRowsWritten: 0,
    alarmRowsWritten: 0,
    deletedRowsWritten: 0,
  }),
  retryUpdate: Object.freeze({
    // Includes the MIN(due_at) scan that proves the persisted retry and alarm agree.
    rowsRead: 4,
    tableRowsWritten: 1,
    indexRowsWritten: 1,
    alarmRowsWritten: 1,
    deletedRowsWritten: 0,
  }),
  staleOverlapGuard: Object.freeze({
    rowsRead: 1,
    tableRowsWritten: 0,
    indexRowsWritten: 0,
    alarmRowsWritten: 0,
    deletedRowsWritten: 0,
  }),
  successfulSettlement: Object.freeze({
    rowsRead: 5,
    tableRowsWritten: 1,
    indexRowsWritten: 0,
    alarmRowsWritten: 1,
    deletedRowsWritten: 1,
  }),
  exhaustedSettlement: Object.freeze({
    rowsRead: 5,
    tableRowsWritten: 1,
    indexRowsWritten: 0,
    alarmRowsWritten: 1,
    deletedRowsWritten: 1,
  }),
});

export const MEASURED_ROOM_SQL_PROFILES = Object.freeze({
  initialization: Object.freeze({ rowsRead: 12, rowsWritten: 23 }),
  // Four scenario joins observe [8, 13, 18, 19] reads as the compact
  // authority cache is refreshed: exactly 58, or 14.5/join.
  join: Object.freeze({ rowsRead: 14.5, rowsWritten: 5 }),
  upgrade: Object.freeze({ rowsRead: 2, rowsWritten: 3 }),
  hello: Object.freeze({ rowsRead: 22, rowsWritten: 5 }),
  reconnectHello: Object.freeze({ rowsRead: 23, rowsWritten: 6 }),
  command: Object.freeze({ rowsRead: 1, rowsWritten: 1 }),
  wakeReconstruction: Object.freeze({ rowsRead: 2, rowsWritten: 0 }),
  finalSocketClose: Object.freeze({ rowsRead: 16, rowsWritten: 6 }),
  expiryAlarmWithReleaseRetry: Object.freeze({ rowsRead: 19, rowsWritten: 8 }),
});

export function measuredRegistrySqlProfiles(cardinality) {
  const roomCodeCount = Number.isSafeInteger(cardinality)
    ? cardinality : cardinality?.roomCodeCount;
  const creationRequestCount = Number.isSafeInteger(cardinality)
    ? cardinality : cardinality?.creationRequestCount;
  if (!Number.isSafeInteger(roomCodeCount) || roomCodeCount < 1
    || !Number.isSafeInteger(creationRequestCount) || creationRequestCount < roomCodeCount) {
    throw new TypeError('registry cardinality must be a positive integer');
  }
  // These consumed-cursor profiles are asserted by the local runtime suite at
  // the day's maximum overlapping cardinality, never an average. The indexed
  // due scans are constant; allocation still counts every retained replay row
  // for the enforced capacity check.
  return Object.freeze({
    cardinality: roomCodeCount,
    roomCodeCount,
    creationRequestCount,
    lookupActive: Object.freeze({ rowsRead: 1, rowsWritten: 0 }),
    allocation: Object.freeze({ rowsRead: creationRequestCount + 29, rowsWritten: 9 }),
    activation: Object.freeze({ rowsRead: 11, rowsWritten: 7 }),
    markReleasePending: Object.freeze({ rowsRead: 9, rowsWritten: 4 }),
    release: Object.freeze({ rowsRead: 9, rowsWritten: 4 }),
    fallbackAlarm: Object.freeze({ rowsRead: 22, rowsWritten: 0 }),
    // Worst-case reuse has every retained room row eligible as a tombstone.
    // SQLite's consumed-cursor profile is 226 reads at the 50/100 gate state.
    reuseAllocation: Object.freeze({
      rowsRead: creationRequestCount + (2 * roomCodeCount) + 26,
      rowsWritten: 8,
    }),
    reuseActivation: Object.freeze({ rowsRead: 11, rowsWritten: 7 }),
  });
}

export function measuredSqlProfiles({
  registryRoomCodeCount = 50,
  registryCreationRequestCount = 100,
} = {}) {
  return Object.freeze({
    registry: measuredRegistrySqlProfiles({
      roomCodeCount: registryRoomCodeCount,
      creationRequestCount: registryCreationRequestCount,
    }),
    room: MEASURED_ROOM_SQL_PROFILES,
  });
}

function cost(overrides = {}) {
  return Object.freeze({ ...ZERO_COST, ...overrides });
}

// Write units are split so index maintenance, alarm mutations, and physical
// deletes remain visible. deletedRowsWritten counts deleted table rows; the
// corresponding index removals are included in indexRowsWritten.
const BASE_OPERATIONS = Object.freeze({
  allocation: { countPerRoom: 1, costEach: cost({ rowsRead: 8, tableRowsWritten: 2, indexRowsWritten: 7, alarmRowsWritten: 1 }) },
  // The first initialization creates the room schema, authority-cache triggers,
  // and authoritative room/session/action/cache rows. The write split below is
  // the consumed runtime profile, including schema and secondary-index writes.
  initialization: { countPerRoom: 1, costEach: cost({ rowsRead: 1, tableRowsWritten: 18, indexRowsWritten: 5, alarmRowsWritten: 1 }) },
  activation: { countPerRoom: 1, costEach: cost({ rowsRead: 2, tableRowsWritten: 2, indexRowsWritten: 5, alarmRowsWritten: 1 }) },
  'join registry lookup': { countPerRoom: 4, costEach: cost({ rowsRead: 1 }) },
  'session join': { countPerRoom: 4, costEach: cost({ rowsRead: 16, tableRowsWritten: 3, indexRowsWritten: 2 }) },
  'WebSocket registry lookup': { countPerRoom: 9, costEach: cost({ rowsRead: 1 }) },
  'WebSocket upgrade': { countPerRoom: 9, costEach: cost({ rowsRead: 2, tableRowsWritten: 1, indexRowsWritten: 2, alarmRowsWritten: 1 }) },
  'initial hello': { countPerRoom: 5, costEach: cost({ rowsRead: 16, tableRowsWritten: 1, indexRowsWritten: 4, alarmRowsWritten: 1, deletedRowsWritten: 1 }) },
  'owner-auth action cancellation': { countPerRoom: 1, costEach: cost({ indexRowsWritten: 2, deletedRowsWritten: 1 }) },
  'reconnect hello': { countPerRoom: 4, costEach: cost({ rowsRead: 16, tableRowsWritten: 1, indexRowsWritten: 4, alarmRowsWritten: 1, deletedRowsWritten: 1 }) },
  'expiry cancellation': { countPerRoom: 1, costEach: cost({ rowsRead: 1, tableRowsWritten: 1, indexRowsWritten: 2, deletedRowsWritten: 1 }) },
  'ordinary command': { countPerRoom: 1_000, costEach: cost({ rowsRead: 1, tableRowsWritten: 1 }) },
  'final-socket expiry schedule': { countPerRoom: 1, costEach: cost({ rowsRead: 8, tableRowsWritten: 4, indexRowsWritten: 2, alarmRowsWritten: 1 }) },
  'begin room closing': { countPerRoom: 1, costEach: cost({ rowsRead: 12, tableRowsWritten: 2, indexRowsWritten: 4, alarmRowsWritten: 1, deletedRowsWritten: 1 }) },
  // markReleasePending reserves the registry's independent stale-release
  // alarm, even though the normal room retry resolves before it fires.
  'registry release fallback reservation': { countPerRoom: 1, costEach: cost({ rowsRead: 1, tableRowsWritten: 1, indexRowsWritten: 3, alarmRowsWritten: 1 }) },
  'release phase checkpoint': { countPerRoom: 1, costEach: cost({ rowsRead: 1, tableRowsWritten: 1, alarmRowsWritten: 1 }) },
  'registry-release retry': { countPerRoom: 1, costEach: cost({ rowsRead: 3, tableRowsWritten: 1, indexRowsWritten: 2, alarmRowsWritten: 1 }) },
  'terminal registry release': { countPerRoom: 1, costEach: cost({ rowsRead: 1, tableRowsWritten: 1, indexRowsWritten: 3, alarmRowsWritten: 1 }) },
  'room deleteAll': { countPerRoom: 1, costEach: cost({ indexRowsWritten: 12, alarmRowsWritten: 1, deletedRowsWritten: 8 }) },
  'reuse allocation': { countPerRoom: 1, costEach: cost({ rowsRead: 10, tableRowsWritten: 2, indexRowsWritten: 6, alarmRowsWritten: 1 }) },
  'reuse initialization': { countPerRoom: 1, costEach: cost({ rowsRead: 1, tableRowsWritten: 18, indexRowsWritten: 5, alarmRowsWritten: 1 }) },
  'reuse activation': { countPerRoom: 1, costEach: cost({ rowsRead: 2, tableRowsWritten: 2, indexRowsWritten: 5, alarmRowsWritten: 1 }) },
  'creation request retention cleanup': { countPerRoom: 1, costEach: cost({ rowsRead: 2, indexRowsWritten: 6, deletedRowsWritten: 2 }) },
});

const CLASSIC_COMMAND_RESERVATION = Object.freeze({
  dealStarts: 1,
  maximumLegalAuctionCalls: 319,
  cardPlays: 52,
  reconnectSnapshots: 4,
  commandsUsed: 372,
  commandsReserved: 1_000,
  commandsRemaining: 628,
});

const CLASSIC_DDS_COMMON_OPERATIONS = Object.freeze({
  'classic DDS action creation': Object.freeze({
    countPerRoom: 1,
    costEach: MEASURED_CLASSIC_DDS_SQL_PROFILES.actionCreation,
  }),
  'classic DDS alarm computation': Object.freeze({
    countPerRoom: 3,
    costEach: MEASURED_CLASSIC_DDS_SQL_PROFILES.alarmComputation,
  }),
  'classic DDS guarded retry update': Object.freeze({
    countPerRoom: 2,
    costEach: MEASURED_CLASSIC_DDS_SQL_PROFILES.retryUpdate,
  }),
  'classic DDS stale overlap guard': Object.freeze({
    countPerRoom: 1,
    costEach: MEASURED_CLASSIC_DDS_SQL_PROFILES.staleOverlapGuard,
  }),
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

function summarizeRows(operations, roomsPerDay) {
  const readPerRoom = sumOperations(operations, 'rowsRead');
  const tableRowsWrittenPerRoom = sumOperations(operations, 'tableRowsWritten');
  const indexRowsWrittenPerRoom = sumOperations(operations, 'indexRowsWritten');
  const alarmRowsWrittenPerRoom = sumOperations(operations, 'alarmRowsWritten');
  const deletedRowsWrittenPerRoom = sumOperations(operations, 'deletedRowsWritten');
  const writtenPerRoom = tableRowsWrittenPerRoom + indexRowsWrittenPerRoom
    + alarmRowsWrittenPerRoom + deletedRowsWrittenPerRoom;
  return {
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
}

function gate(name, actual, target, allowance) {
  return Object.freeze({
    name,
    actual,
    target,
    allowance,
    passed: actual <= target,
    freePassed: actual <= allowance,
  });
}

function rounded(value) {
  return Number(value.toFixed(6));
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

export function simulatePlanBBudget({
  roomsPerDay = 50,
  regression = {},
  sqlProfiles = measuredSqlProfiles({
    registryRoomCodeCount: roomsPerDay,
    registryCreationRequestCount: roomsPerDay * 2,
  }),
} = {}) {
  if (!Number.isSafeInteger(roomsPerDay) || roomsPerDay <= 0) {
    throw new TypeError('roomsPerDay must be a positive integer');
  }
  const extra = validatedRegression(regression);
  const measuredReads = {
    allocation: sqlProfiles.registry.allocation.rowsRead,
    initialization: sqlProfiles.room.initialization.rowsRead,
    activation: sqlProfiles.registry.activation.rowsRead,
    'join registry lookup': sqlProfiles.registry.lookupActive.rowsRead,
    'session join': sqlProfiles.room.join.rowsRead,
    'WebSocket registry lookup': sqlProfiles.registry.lookupActive.rowsRead,
    'WebSocket upgrade': sqlProfiles.room.upgrade.rowsRead,
    'initial hello': sqlProfiles.room.hello.rowsRead,
    'reconnect hello': sqlProfiles.room.reconnectHello.rowsRead,
    'ordinary command': sqlProfiles.room.command.rowsRead,
    'final-socket expiry schedule': sqlProfiles.room.finalSocketClose.rowsRead,
    'begin room closing': sqlProfiles.room.expiryAlarmWithReleaseRetry.rowsRead,
    'registry release fallback reservation': sqlProfiles.registry.markReleasePending.rowsRead,
    'registry-release retry': sqlProfiles.registry.fallbackAlarm.rowsRead,
    'terminal registry release': sqlProfiles.registry.release.rowsRead,
    'reuse allocation': sqlProfiles.registry.reuseAllocation.rowsRead,
    'reuse initialization': sqlProfiles.room.initialization.rowsRead,
    'reuse activation': sqlProfiles.registry.reuseActivation.rowsRead,
  };
  const baseOperations = Object.fromEntries(Object.entries(BASE_OPERATIONS).map(([name, operation]) => {
    const measuredRowsRead = measuredReads[name] ?? operation.costEach.rowsRead;
    return [name, operationWithTotal({
      ...operation,
      costEach: cost({ ...operation.costEach, rowsRead: measuredRowsRead }),
    })];
  }));
  baseOperations['hypothetical per-command regression'] = operationWithTotal({
    countPerRoom: 1_000,
    costEach: cost({
      rowsRead: extra.recipientRowsReadPerCommand,
      tableRowsWritten: extra.commandTableRowsWritten,
      indexRowsWritten: extra.commandIndexRowsWritten,
    }),
  });

  const websocketMessages = 5 + 1_000 + 4;
  const websocketMessageBillingGroups = Math.ceil(websocketMessages / 20);
  const createRpcs = PUBLIC_ROOM_ROUTER_DO_CALL_GRAPH.create.length;
  const joinLookupRpcs = 4;
  const joinRoomRpcs = 4 * (PUBLIC_ROOM_ROUTER_DO_CALL_GRAPH.join.length - 1);
  const websocketLookupRpcs = 9;
  const websocketRoomRequests = 9
    * (PUBLIC_ROOM_ROUTER_DO_CALL_GRAPH.websocket.length - 1);
  const lifecycleAlarmInvocations = 2;
  const ddsAlarmInvocations = 3;
  const ddsComputeExecutionsPerRoom = 4;
  const billedPerRoom = createRpcs + joinLookupRpcs + joinRoomRpcs
    + websocketLookupRpcs + websocketRoomRequests + websocketMessageBillingGroups
    + lifecycleAlarmInvocations + ddsAlarmInvocations + 3 + 3;
  const requestTriggeredHandlerExecutionsPerRoom = createRpcs + joinLookupRpcs + joinRoomRpcs
    + websocketLookupRpcs + websocketRoomRequests
    + websocketMessages + lifecycleAlarmInvocations + ddsAlarmInvocations + 3 + 3;
  const websocketCloseHandlersPerRoom = 9;
  const handlerExecutionsPerRoom = requestTriggeredHandlerExecutionsPerRoom
    + websocketCloseHandlersPerRoom;
  baseOperations['worst-case room wake reconstruction'] = operationWithTotal({
    countPerRoom: handlerExecutionsPerRoom,
    costEach: cost({ rowsRead: sqlProfiles.room.wakeReconstruction.rowsRead }),
  });
  const commonOperations = { ...baseOperations };
  for (const [name, operation] of Object.entries(CLASSIC_DDS_COMMON_OPERATIONS)) {
    commonOperations[name] = operationWithTotal(operation);
  }
  const buildVariantOperations = (name, profile) => ({
    ...commonOperations,
    [name]: operationWithTotal({ countPerRoom: 1, costEach: profile }),
  });
  const successOperations = buildVariantOperations(
    'classic DDS successful trusted settlement',
    MEASURED_CLASSIC_DDS_SQL_PROFILES.successfulSettlement,
  );
  const exhaustionOperations = buildVariantOperations(
    'classic DDS exhausted trusted settlement',
    MEASURED_CLASSIC_DDS_SQL_PROFILES.exhaustedSettlement,
  );
  const durationGbSecondsPerDay = rounded(
    roomsPerDay * (handlerExecutionsPerRoom + ddsComputeExecutionsPerRoom) * 0.5 * 0.128,
  );
  const successRows = summarizeRows(successOperations, roomsPerDay);
  const exhaustionRows = summarizeRows(exhaustionOperations, roomsPerDay);

  // Snapshot size is protocol-capped at 512 KiB. The remaining terms reserve
  // 4 KiB per retained session/action row and a 2x SQLite/index overhead.
  const roomStorageUpperBound = (512 * 1024 + 5 * 4 * 1024 + 2 * 4 * 1024) * 2;
  const registryStorageUpperBound = (1_000 * 512 + 2_000 * 4 * 1024) * 2;
  const storageBytes = roomsPerDay * roomStorageUpperBound + registryStorageUpperBound;

  const requests = {
    perRoomFormula: {
      createRpcs,
      joinLookupRpcs,
      joinRoomRpcs,
      websocketLookupRpcs,
      websocketRoomRequests,
      websocketMessages,
      websocketMessageBillingGroups,
      lifecycleAlarmInvocations,
      ddsAlarmInvocations,
      alarmInvocations: lifecycleAlarmInvocations + ddsAlarmInvocations,
      releaseRpcs: 3,
      reuseRpcs: 3,
    },
    billedPerRoom,
    billedPerDay: billedPerRoom * roomsPerDay,
  };
  const duration = {
    requestTriggeredHandlerExecutionsPerRoom,
    requestTriggeredHandlerExecutionsPerDay: requestTriggeredHandlerExecutionsPerRoom * roomsPerDay,
    requestTriggeredGbSecondsPerDay: rounded(
      roomsPerDay * requestTriggeredHandlerExecutionsPerRoom * 0.5 * 0.128,
    ),
    websocketCloseHandlersPerRoom,
    handlerExecutionsPerRoom,
    handlerExecutionsPerDay: handlerExecutionsPerRoom * roomsPerDay,
    ddsComputeExecutionsPerRoom,
    ddsComputeExecutionsPerDay: ddsComputeExecutionsPerRoom * roomsPerDay,
    durationExecutionUnitsPerRoom: handlerExecutionsPerRoom + ddsComputeExecutionsPerRoom,
    durationExecutionUnitsPerDay:
      (handlerExecutionsPerRoom + ddsComputeExecutionsPerRoom) * roomsPerDay,
    activeSecondsPerHandler: 0.5,
    memoryGb: 0.128,
    gbSecondsPerDay: durationGbSecondsPerDay,
  };
  const storage = { bytes: storageBytes, gigabytes: storageBytes / GB };
  const gatesForRows = variantRows => [
    gate('billedRequests', requests.billedPerDay, PLAN_B_TARGETS.billedRequestsPerDay, PLAN_B_FREE_ALLOWANCES.billedRequestsPerDay),
    gate('duration', duration.gbSecondsPerDay, PLAN_B_TARGETS.durationGbSecondsPerDay, PLAN_B_FREE_ALLOWANCES.durationGbSecondsPerDay),
    gate('rowsRead', variantRows.readPerDay, PLAN_B_TARGETS.rowsReadPerDay, PLAN_B_FREE_ALLOWANCES.rowsReadPerDay),
    gate('rowsWritten', variantRows.writtenPerDay, PLAN_B_TARGETS.rowsWrittenPerDay, PLAN_B_FREE_ALLOWANCES.rowsWrittenPerDay),
    gate('storage', storage.bytes, PLAN_B_TARGETS.storageBytes, PLAN_B_FREE_ALLOWANCES.storageBytes),
  ];
  const successGates = gatesForRows(successRows);
  const exhaustionGates = gatesForRows(exhaustionRows);
  const rows = {
    ...exhaustionRows,
    variants: {
      successAfterEviction: { ...successRows, gates: successGates },
      attempt3Exhaustion: { ...exhaustionRows, gates: exhaustionGates },
    },
  };
  const gates = gatesForRows(rows);

  const dds = {
    logicalAttemptsPerDeal: 3,
    computationsPerDeal: 4,
    immediateComputationsPerDeal: 1,
    alarmComputationsPerDeal: 3,
    alarmHandlerInvocationsPerDeal: 3,
    variants: {
      successAfterEviction: {
        outcome: 'READY', evictions: 1, logicalAttempts: 3, computations: 4,
      },
      attempt3Exhaustion: {
        outcome: 'FAILED', evictions: 0, logicalAttempts: 3, computations: 4,
      },
    },
  };

  return {
    scenario: {
      roomsPerDay,
      commandsPerRoom: 1_000,
      initialSocketsPerRoom: 5,
      reconnectsPerRoom: 4,
      classicDealsPerRoom: 1,
      logicalDdsAttemptsPerDeal: 3,
      maxDdsComputationsPerDeal: 4,
    },
    classicDeal: { commandReservation: { ...CLASSIC_COMMAND_RESERVATION } },
    dds,
    sqlProfiles: { ...sqlProfiles, classicDds: MEASURED_CLASSIC_DDS_SQL_PROFILES },
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
  const expectedNames = ['billedRequests', 'duration', 'rowsRead', 'rowsWritten', 'storage'];
  const expectedActuals = {
    billedRequests: report?.requests?.billedPerDay,
    duration: report?.duration?.gbSecondsPerDay,
    rowsRead: report?.rows?.readPerDay,
    rowsWritten: report?.rows?.writtenPerDay,
    storage: report?.storage?.bytes,
  };
  const expectedTargets = {
    billedRequests: PLAN_B_TARGETS.billedRequestsPerDay,
    duration: PLAN_B_TARGETS.durationGbSecondsPerDay,
    rowsRead: PLAN_B_TARGETS.rowsReadPerDay,
    rowsWritten: PLAN_B_TARGETS.rowsWrittenPerDay,
    storage: PLAN_B_TARGETS.storageBytes,
  };
  const expectedAllowances = {
    billedRequests: PLAN_B_FREE_ALLOWANCES.billedRequestsPerDay,
    duration: PLAN_B_FREE_ALLOWANCES.durationGbSecondsPerDay,
    rowsRead: PLAN_B_FREE_ALLOWANCES.rowsReadPerDay,
    rowsWritten: PLAN_B_FREE_ALLOWANCES.rowsWrittenPerDay,
    storage: PLAN_B_FREE_ALLOWANCES.storageBytes,
  };
  if (report === null || typeof report !== 'object' || !Array.isArray(report.gates)
    || report.gates.length !== expectedNames.length) {
    throw new TypeError('Invalid or missing Plan B budget gates');
  }
  const names = new Set();
  for (const item of report.gates) {
    if (item === null || typeof item !== 'object' || !expectedNames.includes(item.name)
      || names.has(item.name) || !Number.isFinite(item.actual) || item.actual < 0
      || !Number.isFinite(item.target) || item.target < 0
      || !Number.isFinite(item.allowance) || item.allowance < 0
      || item.actual !== expectedActuals[item.name]
      || item.target !== expectedTargets[item.name]
      || item.allowance !== expectedAllowances[item.name]
      || typeof item.passed !== 'boolean' || item.passed !== (item.actual <= item.target)
      || typeof item.freePassed !== 'boolean'
      || item.freePassed !== (item.actual <= item.allowance)) {
      throw new TypeError('Invalid or missing Plan B budget gates');
    }
    names.add(item.name);
  }
  for (const variantName of ['successAfterEviction', 'attempt3Exhaustion']) {
    const variant = report?.rows?.variants?.[variantName];
    if (!variant || !Array.isArray(variant.gates)
      || variant.gates.length !== expectedNames.length) {
      throw new TypeError('Invalid or missing Plan B budget gates');
    }
    const variantActuals = {
      billedRequests: report.requests.billedPerDay,
      duration: report.duration.gbSecondsPerDay,
      rowsRead: variant.readPerDay,
      rowsWritten: variant.writtenPerDay,
      storage: report.storage.bytes,
    };
    const variantNames = new Set();
    for (const item of variant.gates) {
      if (item === null || typeof item !== 'object' || !expectedNames.includes(item.name)
        || variantNames.has(item.name)
        || item.actual !== variantActuals[item.name]
        || item.target !== expectedTargets[item.name]
        || item.allowance !== expectedAllowances[item.name]
        || item.passed !== (item.actual <= item.target)
        || item.freePassed !== (item.actual <= item.allowance)) {
        throw new TypeError('Invalid or missing Plan B budget gates');
      }
      variantNames.add(item.name);
    }
    if (variant.gates.some(item => item.passed !== true || item.freePassed !== true)) {
      throw new Error(`Plan B budget exceeded: ${variantName}`);
    }
  }
  const failed = report.gates.filter((item) => item.passed !== true || item.freePassed !== true);
  if (failed.length > 0) {
    throw new Error(`Plan B budget exceeded: ${failed.map((item) => item.name).join(', ')}`);
  }
  return report;
}

export function createHandlerLatencyRecorder({ now, logicalNow, limitMs = 500 } = {}) {
  if (typeof now !== 'function') throw new TypeError('A controlled clock is required');
  if (logicalNow !== undefined && typeof logicalNow !== 'function') {
    throw new TypeError('logicalNow must be a function');
  }
  if (!Number.isFinite(limitMs) || limitMs <= 0) throw new TypeError('limitMs must be positive');
  const observed = new Map();
  const usesLogicalClock = typeof logicalNow === 'function';

  return Object.freeze({
    async measure(category, handler) {
      if (!HANDLER_CATEGORIES.includes(category)) throw new TypeError(`Unknown handler category: ${category}`);
      if (typeof handler !== 'function') throw new TypeError('handler must be a function');
      const logicalStartedAt = usesLogicalClock ? await logicalNow() : 0;
      const startedAt = now();
      const value = await handler();
      const endedAt = now();
      const logicalEndedAt = usesLogicalClock ? await logicalNow() : 0;
      const wallMilliseconds = endedAt - startedAt;
      const logicalMilliseconds = logicalEndedAt - logicalStartedAt;
      const milliseconds = usesLogicalClock ? logicalMilliseconds : wallMilliseconds;
      if (!Number.isFinite(milliseconds) || milliseconds < 0
        || !Number.isFinite(wallMilliseconds) || wallMilliseconds < 0) {
        throw new TypeError(`Invalid controlled duration for ${category}`);
      }
      const passed = milliseconds < limitMs;
      observed.set(category, Object.freeze({
        milliseconds,
        wallMilliseconds,
        logicalMilliseconds: usesLogicalClock ? logicalMilliseconds : null,
        limitMs,
        passed,
      }));
      if (!passed) throw new Error(`${category} exceeded ${limitMs} ms`);
      return value;
    },
    assertComplete({ requireAll = true } = {}) {
      if (requireAll) {
        const missing = HANDLER_CATEGORIES.filter((category) => !observed.has(category));
        if (missing.length > 0) throw new Error(`Missing handler latency categories: ${missing.join(', ')}`);
      }
      return Object.fromEntries(observed);
    },
  });
}
