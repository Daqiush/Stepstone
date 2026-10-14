export const PUBLIC_ROOM_ROUTER_DO_CALL_GRAPH = Object.freeze({
  create: Object.freeze(['registry.allocate', 'room.initialize', 'registry.activate']),
  join: Object.freeze(['registry.lookupActive', 'room.join']),
  websocket: Object.freeze(['registry.lookupActive', 'room.fetch']),
});
