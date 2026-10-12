export { FeasibilityRoom } from './feasibility-room.mjs';
export { LobbyRegistry, StepstoneRoom } from './room-foundation/router.mjs';
import { fetchWorker } from './room-foundation/router.mjs';

export default {
  fetch: fetchWorker,
};
