import { DurableObject } from 'cloudflare:workers';
import {
  LobbyRegistry as LobbyRegistryImplementation,
} from './room-foundation/lobby-registry.mjs';
import { StepstoneRoom as StepstoneRoomImplementation } from './room-foundation/stepstone-room.mjs';

export { FeasibilityRoom } from './feasibility-room.mjs';
import { fetchWorker } from './room-foundation/router.mjs';

class LobbyRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.implementation = new LobbyRegistryImplementation(ctx, env);
  }

  fetch(request) { return this.implementation.fetch(request); }
  allocate(input) { return this.implementation.allocate(input); }
  activate(input) { return this.implementation.activate(input); }
  lookupActive(input) { return this.implementation.lookupActive(input); }
  markReleasePending(input) { return this.implementation.markReleasePending(input); }
  release(input) { return this.implementation.release(input); }
  alarm() { return this.implementation.alarm(); }
  testAllocateAt(input) { return this.implementation.testAllocateAt(input); }
  testActivateAt(input) { return this.implementation.testActivateAt(input); }
  testMarkReleasePendingAt(input) { return this.implementation.testMarkReleasePendingAt(input); }
  testReleaseAt(input) { return this.implementation.testReleaseAt(input); }
  testSetReleaseFault(input) { return this.implementation.testSetReleaseFault(input); }
  testReconcile(input) { return this.implementation.testReconcile(input); }
  testAlarmAt(input) { return this.implementation.testAlarmAt(input); }
  testScheduleRetryWithoutAlarm(input) {
    return this.implementation.testScheduleRetryWithoutAlarm(input);
  }
  testRecoverAlarmAt(input) { return this.implementation.testRecoverAlarmAt(input); }
  testInspect() { return this.implementation.testInspect(); }
  testResetSqlAccounting() { return this.implementation.testResetSqlAccounting(); }
  testInspectSqlAccounting() { return this.implementation.testInspectSqlAccounting(); }
  testConfigureLatency(input) { return this.implementation.testConfigureLatency(input); }
  testInspectLatency() { return this.implementation.testInspectLatency(); }
  testSeedBudgetCardinality(input) {
    return this.implementation.testSeedBudgetCardinality(input);
  }
  testSeedCapacity(input) { return this.implementation.testSeedCapacity(input); }
}

class StepstoneRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.implementation = new StepstoneRoomImplementation(ctx, env);
  }

  fetch(request) { return this.implementation.fetch(request); }
  initialize(input) { return this.implementation.initialize(input); }
  join(input) { return this.implementation.join(input); }
  inspectInitialization(input) { return this.implementation.inspectInitialization(input); }
  reconcileClosingRelease(input) {
    return this.implementation.reconcileClosingRelease(input);
  }
  alarm() { return this.implementation.alarm(); }
  webSocketMessage(socket, message) {
    return this.implementation.webSocketMessage(socket, message);
  }
  webSocketClose(socket, code, reason, wasClean) {
    return this.implementation.webSocketClose(socket, code, reason, wasClean);
  }
  webSocketError(socket, error) {
    return this.implementation.webSocketError(socket, error);
  }
  testSetInitialization(input) { return this.implementation.testSetInitialization(input); }
  testSetInspectionFault(input) { return this.implementation.testSetInspectionFault(input); }
  testSetInitializationFault(input) { return this.implementation.testSetInitializationFault(input); }
  testSetAuthFault(input) { return this.implementation.testSetAuthFault(input); }
  testInspectAuthHook(input) { return this.implementation.testInspectAuthHook(input); }
  testSetCommandFault(input) { return this.implementation.testSetCommandFault(input); }
  testResetSqlAccounting(input) { return this.implementation.testResetSqlAccounting(input); }
  testInspectSqlAccounting(input) { return this.implementation.testInspectSqlAccounting(input); }
  testConfigureLatency(input) { return this.implementation.testConfigureLatency(input); }
  testInspectLatency(input) { return this.implementation.testInspectLatency(input); }
  testInspectCommandAccounting(input) {
    return this.implementation.testInspectCommandAccounting(input);
  }
  testInspectCommandHook(input) { return this.implementation.testInspectCommandHook(input); }
  testCorruptCommandCache(input) { return this.implementation.testCorruptCommandCache(input); }
  testSetStatus(input) { return this.implementation.testSetStatus(input); }
  testRecoverAlarmAt(input) { return this.implementation.testRecoverAlarmAt(input); }
  testInspect(input) { return this.implementation.testInspect(input); }
  testInitializeAt(input) { return this.implementation.testInitializeAt(input); }
  testJoinAt(input) { return this.implementation.testJoinAt(input); }
  testOrphanSessionAuthority(input) {
    return this.implementation.testOrphanSessionAuthority(input);
  }
  testSeedMalformedHandshakeAction(input) {
    return this.implementation.testSeedMalformedHandshakeAction(input);
  }
  testDropAlarm(input) { return this.implementation.testDropAlarm(input); }
  testSeedPendingActions(input) { return this.implementation.testSeedPendingActions(input); }
  testSetReleaseRetryAttempt(input) {
    return this.implementation.testSetReleaseRetryAttempt(input);
  }
  testAlarmAt(input) { return this.implementation.testAlarmAt(input); }
  testProbeTokenStorage(input) { return this.implementation.testProbeTokenStorage(input); }
}

export { LobbyRegistry, StepstoneRoom };

export default {
  fetch: fetchWorker,
};
