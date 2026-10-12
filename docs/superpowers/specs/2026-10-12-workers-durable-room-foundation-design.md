# Stepstone Workers Durable Room Foundation Design

## Goal

Build the Workers-side room, session, persistence, reconnect, and lifecycle foundation required by the previously approved Workers Free migration design. This milestone proves the infrastructure with a deliberately small test command; it does not migrate classic, ult, or problem gameplay and it does not bind `stepstone.hogetsu.uk`.

## Scope

Plan B adds:

- a singleton lobby-registry Durable Object for allocating three-digit room codes;
- one SQLite-backed room Durable Object per `{ roomCode, incarnation }`;
- versioned HTTP bootstrap and native WebSocket protocol boundaries;
- opaque reconnect tokens, token rotation, role/seat authority, and single-live-socket enforcement;
- atomic room snapshots, command idempotency, pending actions, alarms, expiry, and safe code reuse;
- local Workers integration tests and a deterministic storage-budget simulation.

Plan B deliberately excludes:

- gameplay state machines, bidding, playing, scoring, skills, problem scripts, or DDS decisions;
- changes to the existing browser clients or removal of Socket.IO;
- serving the public application, production secrets, custom routes, DNS, or production deployment;
- accounts, matchmaking, permanent history, and cross-room analytics.

The existing DDS feasibility harness and its remote soak workflow remain intact. Plan B extends the same Worker module only behind a dedicated local/integration-test flag, so the already verified DDS boundary continues to be independently testable.

## Architecture

```text
HTTP bootstrap / WebSocket upgrade
              |
              v
Worker entry point
  |- existing authenticated DDS feasibility routes
  `- room-foundation routes (test-gated in Plan B)
              |
        +-----+----------------+
        |                      |
        v                      v
LobbyRegistry DO          StepstoneRoom DO
(one fixed object)        (one per code+incarnation)
  |- code allocation        |- sessions and sockets
  |- incarnation counter    |- room snapshot/revision
  |- tombstones             |- command idempotency
  `- release/reconcile      `- pending actions/alarms
```

The entry point is stateless. The registry is authoritative for whether a code is free, active, release-pending, or tombstoned. The room object is the sole writer for its incarnation. A room object name is derived from both code and incarnation, so a late request for an expired incarnation cannot mutate a newer room that reused the same code.

The existing `workers/wrangler.jsonc` keeps `workers_dev: false` and gains two SQLite Durable Object classes and a second migration tag. Its current Worker name is not treated as a production identity and is not bound to a public route in this milestone.

## Module boundaries

### Entry router

`workers/src/index.mjs` remains a narrow dispatcher. Existing `/__dds/*` behavior and remote-test authorization must not change. Room-foundation routes are enabled only when `ROOM_FOUNDATION_TEST` is exactly `true`; otherwise they return the same opaque not-found response used for unavailable test surfaces.

The future public shapes are implemented now:

- `POST /api/rooms` creates a room and owner session.
- `POST /api/rooms/{code}/join` creates a player or spectator session.
- `GET /api/rooms/{code}/{incarnation}/ws` accepts a WebSocket upgrade but exposes no state before the first authenticated `hello` frame.

No reconnect token appears in a URL, cookie, log, Durable Object attachment, or broadcast payload.

### Lobby registry

`LobbyRegistry` owns exactly one SQLite database. Its public operations are `allocate`, `markReleasePending`, `release`, and `lookup`. Callers cannot choose an incarnation.

Its table stores one row per three-digit code:

```text
room_codes(
  code TEXT PRIMARY KEY,
  incarnation INTEGER NOT NULL,
  status TEXT NOT NULL,
  tombstone_until INTEGER,
  updated_at INTEGER NOT NULL
)
```

Allocation chooses a free code or an expired tombstone, increments its incarnation, and atomically marks it active. The object ID for the room is derived as `room:{code}:{incarnation}`. If owner-session initialization fails after allocation, the registry moves the exact incarnation to `RELEASE_PENDING` and uses the normal reconciliation path; it never silently returns the code to the free pool.

Release is idempotent and succeeds only for an exact code/incarnation pair already marked `RELEASE_PENDING`. It creates a five-minute tombstone before reuse. A request concerning an older incarnation can never release the current one.

### Room object

`StepstoneRoom` restores its database and hibernatable sockets inside `blockConcurrencyWhile()`. Correctness-critical state never exists only in memory. The Plan B snapshot is intentionally small:

```json
{
  "schemaVersion": 1,
  "roomCode": "123",
  "incarnation": 7,
  "revision": 4,
  "status": "ACTIVE",
  "foundationCounter": 2,
  "createdAt": 0,
  "expiresAt": null
}
```

`foundationCounter` exists only to prove authenticated mutation, revision checks, idempotency, persistence, reconnect, and eviction recovery. Gameplay state replaces this test command in later plans; no game rule is duplicated here.

Room storage uses the approved bounded schema:

```text
room_state(incarnation PRIMARY KEY, schema_version, revision, status, expires_at, state_json)
sessions(session_id PRIMARY KEY, token_hash UNIQUE, incarnation, role, seat, expires_at, replaced_at)
pending_actions(action_id PRIMARY KEY, incarnation, due_at, kind, payload_json, cancelled_at)
command_ids(session_id, command_id, revision, reply_json, expires_at,
            PRIMARY KEY(session_id, command_id))
```

Indexes cover token lookup, active seat ownership, due actions, and idempotency expiry. There is one current snapshot, no unbounded event log, and no persisted raw reconnect token.

## Bootstrap and session authority

Room creation allocates the code, initializes the room, and returns `{ roomCode, incarnation, reconnectToken }` for the owner. A join asks the exact active room to allocate the next vacant player seat; after four player seats, new sessions are spectators. Display names remain labels and never grant authority.

Reconnect tokens are 32 random bytes encoded as base64url. Only a SHA-256 digest is persisted. The WebSocket URL includes code and incarnation but not the token. The first frame must be:

```json
{ "v": 1, "type": "hello", "reconnectToken": "..." }
```

Before successful authentication the socket receives no room snapshot, seat, player list, or error detail that distinguishes valid rooms. On success the room atomically rotates the reconnect token, attaches only `{ sessionId, incarnation, protocolVersion }` to the hibernatable socket, closes any prior socket for that session with `SESSION_REPLACED`, and replies with the new token plus a role-filtered full snapshot. The old token becomes invalid immediately after the successful rotation transaction.

Every later command revalidates the attached session against SQLite. Owner replacement, seat replacement, room closing, and expiry revoke the affected sessions immediately.

## Protocol and command processing

Client frames use the existing approved envelope:

```json
{ "v": 1, "type": "command", "id": "client-id", "name": "foundation.increment", "payload": {} }
```

Replies and events use:

```json
{ "v": 1, "type": "reply", "id": "client-id", "name": "foundation.increment", "payload": {} }
{ "v": 1, "type": "error", "id": "client-id", "payload": { "code": "..." } }
{ "v": 1, "type": "event", "name": "room.snapshot", "payload": {} }
```

Only `foundation.increment` is implemented in Plan B. It is accepted from an authenticated player session, increments the counter and revision once, persists the new snapshot and reply in one transaction, then broadcasts the committed snapshot. Repeating the same command ID for the same session returns the stored reply without another mutation or broadcast. Reusing an ID with a different canonical command fails closed.

The command path is:

1. validate frame size, JSON, protocol version, command name, ID, and payload;
2. verify room status, incarnation, session, socket attachment, and role;
3. check the bounded idempotency table;
4. build a proposed immutable next snapshot;
5. transactionally persist the snapshot, session/action changes, cached reply, and expired-cache cleanup;
6. assign the committed snapshot to memory;
7. send the reply and broadcast the role-filtered event.

No broadcast occurs before commit. On any storage or transaction error the room discards the proposal, reloads the persisted snapshot, and returns `SERVICE_CAPACITY`.

## Pending actions, expiry, and reuse

When the final authenticated socket closes, the room transactionally schedules a `room-expiry` action for 24 hours later and sets the Durable Object alarm to the earliest pending action. A valid reconnect cancels that action. Alarms reload the due queue and execute actions idempotently.

Expiry checks that the room is still `ACTIVE`, has no authenticated sockets, and still owns the scheduled action. It then:

1. persists `CLOSING`;
2. revokes sessions and cancels other pending actions;
3. persists a `registry-release` retry action;
4. asks the registry to mark and release the exact code/incarnation;
5. removes the retry action only after the registry confirms the tombstone.

Cross-object failure leaves the room `CLOSING` and the registry `RELEASE_PENDING`. Retry uses exponential backoff capped at one hour. Allocation that encounters `RELEASE_PENDING` asks the old room to reconcile; the old room releases only when its persisted status is `CLOSING` and its incarnation matches. Join, reconnect, and commands return `ROOM_EXPIRED` throughout closing, release-pending, and tombstone states.

## Error handling and privacy

Externally visible errors are stable codes only:

- `PROTOCOL_MISMATCH`
- `INVALID_COMMAND`
- `AUTH_INVALID`
- `ROOM_NOT_FOUND`
- `ROOM_EXPIRED`
- `SESSION_REPLACED`
- `COMMAND_CONFLICT`
- `ROOM_CAPACITY_EXCEEDED`
- `SERVICE_CAPACITY`

Raw exception messages, SQL text, token digests, hidden room existence, and internal object IDs are never sent to clients. Pre-authentication failures are deliberately indistinguishable. Logs may include a generated diagnostic ID and stable code, but never tokens or complete state snapshots.

Frame and payload sizes are bounded before JSON parsing or persistence. Session count, spectators, pending actions, and idempotency rows have explicit limits. Cache rows older than 15 minutes are deleted during normal writes and alarms.

## Testing strategy

### Pure unit tests

- protocol envelope and canonical command validation;
- base64url token shape, hashing, rotation, and constant-time digest comparison;
- role/seat authorization and role-filtered snapshots;
- pending-action ordering, cancellation, and exponential backoff;
- registry state transitions and exact-incarnation checks;
- schema migration from an empty database and rejection of unknown versions.

### Durable Object integration tests

- create one room, join four players, then join a spectator;
- reject all information before `hello` authentication;
- rotate tokens and reject the old token;
- replace one session's older live socket;
- apply `foundation.increment` once and replay its reply after duplicate delivery;
- recover the committed revision, sessions, and pending actions from storage after object reconstruction;
- cancel expiry on reconnect;
- expire an empty room, retry a failed registry release, tombstone it, and later reuse the code with a higher incarnation;
- prove a delayed request from the old incarnation cannot join, reconnect, mutate, or release the new room;
- compensate for owner-session initialization failure without advertising a room;
- retain all existing DDS adapter, harness, and remote-auth tests unchanged.

Tests use fake clocks and injected failure points rather than real 24-hour waits. The integration suite runs in Wrangler's local runtime and requires no Cloudflare token.

### Budget gate

Extend the existing room-budget simulator with the actual Plan B write/read model: allocation, owner creation, three player joins plus spectator creation, 1,000 state-changing commands, four reconnect rotations, command-id cleanup, expiry scheduling/cancellation, final expiry, one registry-release retry, tombstone, and reuse. The gate remains at most 70,000 SQLite row writes/day and 250,000 reads/day for 50 rooms, preserving the 30% write headroom from the approved migration design.

## Acceptance criteria

Plan B is complete only when:

- all existing application, DDS, and Workers tests pass;
- local integration tests prove create, join, authentication, reconnect, token rotation, socket replacement, persistence recovery, idempotency, expiry, release retry, and safe code reuse;
- old-incarnation requests cannot affect a reused room code;
- the storage-budget simulator stays within the approved daily limits;
- the Worker config still has no production route and `workers_dev` remains disabled;
- no browser client, gameplay engine, DNS record, `stepstone.hogetsu.uk`, or production Worker has changed.

Passing Plan B authorizes a separate Plan C design/implementation cycle for classic-mode migration. It does not authorize public rollout.
