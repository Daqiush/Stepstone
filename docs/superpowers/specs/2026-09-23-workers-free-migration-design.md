# Stepstone Workers Free Migration Design

## Goal

Run Stepstone entirely on Cloudflare Workers Free without any dependency on the developer's computer or a conventional Node server. The public entry point will be `https://stepstone.hogetsu.uk`.

This design defines the target architecture and divides delivery into independently releasable plans. The first plan is only a compatibility and platform-feasibility harness; no game engine is migrated until its explicit gates pass.

## Chosen approach

Retain the existing browser UI and bridge rules while replacing the Node runtime infrastructure:

1. Serve the existing `public/` assets from a Cloudflare Worker.
2. Replace the Socket.IO transport with native WebSockets.
3. Put exactly one room incarnation's authoritative game engine and live connections in one SQLite-backed Durable Object, using hibernatable WebSockets.
4. Persist recoverable room state in Durable Object SQLite storage.
5. Replace the executable DDS bridge with a WebAssembly adapter based on a DDS-compatible Wasm package. The adapter exposes the existing conceptual operations: full-hand table calculation and current-position solve.

This keeps all three game modes and server authority. It does not reveal defense hands or move authoritative problem-mode logic into the browser.

## Why this approach

Cloudflare Workers cannot start the current Express/Socket.IO listener or execute `dds_calc.exe` and `dds_solve.exe`. WebAssembly runs in Workers, while Durable Objects provide per-room single-threaded coordination, persistent state, and WebSocket support. The selected design replaces platform-specific mechanisms rather than weakening game rules.

The Free plan's ordinary Worker CPU limit is unsuitable for double-dummy calculation. DDS calls therefore execute inside the room Durable Object and must be benchmarked there before full migration. If the chosen Wasm implementation cannot reproduce the current solver API or meet the Durable Object resource limits, the migration stops before game-engine conversion and the project remains on the existing Node architecture.

## Architecture

```text
Browser
  | HTTPS / static assets
  v
Worker entry point
  | WebSocket upgrade, room-code routing
  v
Room Durable Object (one object per room code)
  |- native WebSocket sessions and event validation
  |- authoritative classic / ult / problem state machine
  |- SQLite snapshots for reconnect and eviction recovery
  `- DDS Wasm adapter
       |- calcDDTable(hands)
       `- solveBoard({ trump, trickLeader, trickPlayed, hands })
```

The Worker entry point contains no game state. A small lobby Durable Object owns room-code allocation. It assigns an unused three-digit code and a monotonically changing room incarnation. The entry point resolves `{ roomCode, incarnation }` through that registry and forwards the HTTP or WebSocket request to the matching room object. Expired rooms are explicitly released through the registry before their three-digit codes are reused. The room object is the sole writer for that incarnation, preserving the ordering guarantees that the current in-memory `rooms` map provides.

The room object initializes persisted state with `blockConcurrencyWhile()`. It uses the Hibernatable WebSocket API, stores a compact session attachment on every accepted socket, and rebuilds its connection index from `getWebSockets()` after activation. No correctness-critical connection or timer data exists only in process memory.

## Compatibility boundaries

### Preserved

- Classic, ult, and problem-mode game rules and room flows.
- Three-digit room codes, reconnect, spectators, and server-side authority.
- Existing visible card UI, CSS, and static problem assets.
- Current DDS wrapper semantics, including current-player score interpretation and the dummy claim restriction.

### Replaced

- `Express` static serving and `Socket.IO` with Worker static assets and native WebSocket protocol.
- Process-global `rooms`, socket-to-room maps, and timers with a per-room Durable Object plus persisted state and alarms where needed.
- Node `child_process` DDS invocation with a Wasm adapter.
- Node filesystem problem discovery with a build-time manifest of problem files.

### Out of scope for the first migration

- User accounts, matchmaking, permanent game history, or cross-room analytics.
- Changing bridge scoring, skills, or problem content.
- A general-purpose Socket.IO compatibility layer.

## WebSocket protocol

The browser protocol is JSON and versioned from the first release. A client-to-server frame is `{ v, type: 'command', id, name, payload }`; `id` is a client-generated command identifier retained in the authenticated session's bounded idempotency cache. A server-to-client frame is `{ v, type: 'event' | 'reply' | 'error', id?, name?, payload? }`.

`v` is checked on connection and every command. A mismatched protocol version receives `error` with code `PROTOCOL_MISMATCH` and is closed. Every accepted command writes exactly one reply or error for its `id`, enabling safe retry after a network interruption. Event payloads are named after the existing Socket.IO events during migration, but each client module gets an explicit command/event mapping test before its Socket.IO calls are removed.

On successful connection the room emits a complete role-filtered snapshot before live events. Broadcast events are ordered by the room object's serialized command processing. There is no replay stream: after a reconnect the client discards pending view state and applies the new snapshot.

Bootstrap is HTTP-only. `POST /api/rooms` calls the lobby registry to allocate a code and creates the owner session in the matching room object; `POST /api/rooms/{code}/join` asks the active room object to allocate a vacant player seat or spectator session. Both replies contain `{ roomCode, incarnation, reconnectToken }`; display names are labels only and grant no authority. The Worker does not accept room WebSocket upgrades until the caller has received one of these opaque tokens.

The WebSocket connection URL includes the room code and incarnation only. Its first client frame must be `{ v, type: 'hello', reconnectToken }`; until it succeeds, the socket receives no room snapshot or events. The room stores a hash of that token with a stable `sessionId`, room incarnation, role, seat/owner authority, and expiry. A reconnect must present the token; a supplied seat name never grants authority. A successful reconnect rotates the token and invalidates the old hash. The hibernatable socket attachment stores only `{ sessionId, incarnation, protocolVersion }`, never the raw token. The room verifies the attached session's current, non-revoked status before every command. One role/seat token has at most one live socket: a new successful connection closes the previous socket with `SESSION_REPLACED`. Owner removal/replacement immediately revokes the affected token. Tokens are invalidated on room expiry.

## Data flow and resilience

1. A client creates or joins a room through the Worker and lobby registry.
2. The Worker routes the connection to the room object's code-and-incarnation identity.
3. The room object restores its latest snapshot and hibernatable WebSockets before accepting commands when it has been evicted.
4. It validates every command against an immutable in-memory state, computes a proposed next state, and atomically persists that proposal, session changes, and pending action queue before assigning it as the live state or broadcasting a compact event to connected peers.
5. Solver calls are local Wasm function calls inside that same room object. Failures return an explicit game-safe error; they never silently pick a different card.

The SQLite interface is deliberately small:

- `room_state(incarnation PRIMARY KEY, schema_version, revision, status, expires_at, state_json)` holds exactly one full authoritative JSON snapshot for the active room.
- `sessions(session_id PRIMARY KEY, token_hash UNIQUE, incarnation, role, seat, expires_at, replaced_at)` holds reconnect authority only; indexes on `(incarnation, seat)` and `token_hash` support authority validation and seat replacement.
- `pending_actions(action_id PRIMARY KEY, incarnation, due_at, kind, payload_json, cancelled_at)` holds durable delayed work.
- `command_ids(session_id, id, revision, reply_json, expires_at, PRIMARY KEY(session_id, id))` is a bounded idempotency cache; rows older than 15 minutes are deleted during normal writes.

There are no persisted patches or unbounded revision history. Each state-changing command uses one SQLite transaction: verify the expected room revision, update the single `room_state` row, insert/update affected sessions/actions and idempotency reply, delete expired cache rows, then commit. The object assigns the proposed state to memory only after commit. On a solver error, transaction error, quota error, or exception, it discards the proposal, reloads `room_state` before accepting another command, and returns an error without broadcasting. A migration function upgrades known older schema versions before commands are accepted. An unknown or corrupt record fails closed, records an operator-visible diagnostic, and never exposes hidden hands in a partial snapshot.

Delayed actions are persisted as an ordered queue containing an action ID, due time, payload, and cancellation state. The room uses its one Durable Object alarm for the earliest due action; after an alarm, it reloads the queue, executes all due actions idempotently, persists the new state and next deadline, then broadcasts. This replaces all correctness-relevant `setTimeout` calls, including problem auto-defense and ult phase delays.

### Room expiry and safe code reuse

A room remains active while it has at least one authenticated socket. When its last socket closes, it persists a `room-expiry` pending action for 24 hours later. A new valid reconnect cancels that action. The owner may issue a close command, which first changes local room status to `CLOSING`, cancels sessions/actions, and persists the same `registry-release` retry action used by expiry; it never directly releases the code outside that recovery path.

When the expiry action fires, the room first verifies that it remains `ACTIVE`, has no authenticated sockets, and that the due time is still current. It persists `CLOSING`, cancels all pending actions and sessions, and persists a `registry-release` retry action before calling the registry's idempotent `release(code, incarnation)` operation. The registry atomically changes only that exact active incarnation to a five-minute tombstone before allowing the code to be allocated to a new incarnation.

If that cross-object release call fails, the `registry-release` action retries with exponential backoff capped at one hour. The lobby keeps the code in `RELEASE_PENDING`, so it is never mistakenly reused. On a later allocation attempt that finds `RELEASE_PENDING`, the registry calls the original room object's reconciliation endpoint. That endpoint releases only a persisted `CLOSING` room with matching incarnation, then retries the same idempotent registry operation; no active room can be released by reconciliation. During `CLOSING`, `RELEASE_PENDING`, or tombstone status, all join and reconnect attempts receive `ROOM_EXPIRED`; delayed actions also verify `ACTIVE` and matching incarnation before they can mutate state. This ordering makes a late reconnect harmless even if a prior room object is still resident.

Room creation is also compensating: if `POST /api/rooms` allocates a code but the owner-session initialization fails, the lobby records `RELEASE_PENDING` and invokes the same idempotent release/retry flow. A partially initialized room is never advertised to a client.

### Free-tier budget and failure behavior

The target initial load is at most 50 active rooms per day, four sockets per room, and 1,000 accepted room commands per room. State is persisted after each accepted state-changing command, not after view-only events. The target budget is at most 70,000 SQLite row writes/day and 250,000 row reads/day, reserving 30% of the Free allocation of 100,000 writes and 5,000,000 reads/day for retries, lobby allocation, reconnects, actions, compaction, and operational variation. The Plan A simulator must include creation, four joins, 1,000 commands, four reconnects, one expiry, one room-code reuse, and all scheduled action writes for every room; it must report rows and fail above either target budget.

If storage, compute, or quota operations fail, the command is not broadcast. The sender receives a `SERVICE_CAPACITY` error, the current snapshot remains valid, and clients may retry later. The room creation path returns `ROOM_CAPACITY_EXCEEDED` instead of creating an untracked room when the lobby registry cannot allocate or persist a code.

## DDS feasibility gate

Before moving gameplay code, create a minimal Worker + Durable Object test harness that:

- loads the Wasm DDS adapter without Node APIs;
- runs `calcDDTable` and `solveBoard` against every current DDS wrapper fixture plus the opening and branch positions of every bundled problem board;
- compares trick scores and complete legal candidate-card sets against the executable wrapper, treating card order only as non-semantic;
- records Wasm load size, initialization duration, maximum resident memory, and per-call active CPU duration in a Durable Object;
- tests malformed and unsupported input to confirm that validation fails before Wasm starts and no game state changes;
- executes all solver calls before constructing the proposed game mutation, so a Wasm trap or platform-terminated invocation cannot commit partial state;
- runs 100,000 seeded, legal randomized full and partial positions in addition to the named fixtures to establish a measured maximum runtime.

Synchronous Wasm cannot be reliably preempted by a JavaScript timeout inside one Durable Object. Therefore the free-tier design does not claim a runtime kill switch: the adapter must prove bounded behavior before adoption. The migration proceeds only if the adapter supports both required calls, every parity fixture matches, the Wasm module and static assets stay below Worker bundle limits, the seeded corpus has a maximum active CPU duration below 10 seconds with no trap, the 99th percentile is below 1 second, and maximum memory is below 96 MB. The harness must also show that no solve blocks an unrelated queued command for more than 10 seconds. If any gate fails, Workers Free is rejected before engine migration rather than shipping an interruptible-but-unsafe solver. A community Wasm wrapper is an integration candidate, not a correctness guarantee; its API and license must be reviewed and it must be vendored or pinned by exact version.

## Rollout

### Plan A: feasibility harness

Build only the Wasm DDS adapter, worker entry point, one test Durable Object, and benchmark/parity suite. This plan also records the Free-tier storage operation budget for the intended load. It is accepted only when every DDS gate above passes.

### Plan B: transport and durable room foundation

Add the lobby registry, room lifecycle/expiry, SQLite schema migrations, hibernatable WebSocket sessions, reconnect tokens, protocol envelope, idempotency, and persisted deadline queue. It exposes a test-only room command and is accepted only when eviction, reconnect, expiry/code reuse, and delayed-action tests pass.

### Plan C: gameplay migration

Migrate classic mode first, then ult and problem mode as separate implementation chunks. Each chunk requires command/event mapping tests and engine parity tests before the next mode starts.

### Plan D: public rollout

Deploy to a temporary Worker URL, run browser integration tests, then bind `stepstone.hogetsu.uk`. Keep the Node deployment available until all three modes pass parity tests; remove it only after the public Worker deployment is verified.

## Acceptance criteria

- Plan A passes every stated Wasm DDS parity and performance gate.
- Plan B lets four clients create, join, reconnect, survive Durable Object eviction, and safely reuse an expired room code without a role/seat takeover.
- A user can access `https://stepstone.hogetsu.uk` while the developer computer is off after Plan D.
- Classic, then ult, then every problem-mode test case retain server-side validation and deterministic outcomes before public rollout.
- The Worker does not use `child_process`, a native executable, Node network listeners, or a process-global room map.
