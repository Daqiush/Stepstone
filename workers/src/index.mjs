import { DurableObject } from 'cloudflare:workers';
import {
  LobbyRegistry as LobbyRegistryImplementation,
  StepstoneRoom as StepstoneRoomImplementation,
} from './room-foundation/lobby-registry.mjs';

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
  markReleasePending(input) { return this.implementation.markReleasePending(input); }
  release(input) { return this.implementation.release(input); }
  alarm() { return this.implementation.alarm(); }
  testReconcile(input) { return this.implementation.testReconcile(input); }
  testInspect() { return this.implementation.testInspect(); }
  testSeedCapacity(input) { return this.implementation.testSeedCapacity(input); }
}

class StepstoneRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.implementation = new StepstoneRoomImplementation(ctx, env);
  }

  fetch(request) { return this.implementation.fetch(request); }
  inspectInitialization(input) { return this.implementation.inspectInitialization(input); }
  testSetInitialization(input) { return this.implementation.testSetInitialization(input); }
}

export { LobbyRegistry, StepstoneRoom };

export default {
  fetch: fetchWorker,
};
