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
  testReconcile(input) { return this.implementation.testReconcile(input); }
  testScheduleRetryWithoutAlarm(input) {
    return this.implementation.testScheduleRetryWithoutAlarm(input);
  }
  testRecoverAlarmAt(input) { return this.implementation.testRecoverAlarmAt(input); }
  testInspect() { return this.implementation.testInspect(); }
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
  testSetCommandFault(input) { return this.implementation.testSetCommandFault(input); }
  testInspectCommandAccounting(input) {
    return this.implementation.testInspectCommandAccounting(input);
  }
  testInspectCommandHook(input) { return this.implementation.testInspectCommandHook(input); }
  testCorruptCommandCache(input) { return this.implementation.testCorruptCommandCache(input); }
  testSetStatus(input) { return this.implementation.testSetStatus(input); }
  testRecoverAlarmAt(input) { return this.implementation.testRecoverAlarmAt(input); }
  testInspect(input) { return this.implementation.testInspect(input); }
  testInitializeAt(input) { return this.implementation.testInitializeAt(input); }
  testAlarmAt(input) { return this.implementation.testAlarmAt(input); }
  testProbeTokenStorage(input) { return this.implementation.testProbeTokenStorage(input); }
}

export { LobbyRegistry, StepstoneRoom };

export default {
  fetch: fetchWorker,
};
