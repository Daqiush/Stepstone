# Stepstone Workers Durable Room Foundation Design

## Goal

Build the Workers-side room, session, persistence, reconnect, and lifecycle foundation required by the approved Workers Free migration design. This milestone proves the infrastructure with one deliberately small state-changing command; it does not migrate classic, ult, or problem gameplay and it does not bind `stepstone.hogetsu.uk`.

## Scope

Plan B adds:

- one singleton lobby-registry Durable Object for allocating three-digit room codes;
- one SQLite-backed room Durable Object per `{ roomCode, incarnation }`;
- versioned HTTP bootstrap and native WebSocket protocol boundaries;
- opaque reconnect tokens, recoverable token rotation, role/seat authority, and single-live-socket enforcement;
- atomic room snapshots, bounded in-row command deduplication, pending actions, alarms, expiry, and safe code reuse;
- local Workers integration tests and a deterministic Free-plan budget simulation.

Plan B deliberately excludes:

- gameplay state machines, bidding, playing, scoring, skills, problem scripts, or DDS decisions;
- changes to the existing browser clients or removal of Socket.IO;
- serving the public application, production secrets, custom routes, DNS, or production deployment;
- owner replacement, seat replacement, explicit owner-close, accounts, matchmaking, permanent history, and cross-room analytics.

The existing DDS feasibility harness and its remote soak workflow remain intact. Plan B extends the same Worker module only behind a dedicated local/integration-test flag, so the already verified DDS boundary remains independently testable.

## Cloudflare constraints

The design is based on the Cloudflare limits and accounting rules checked on 2026-10-12:

- Workers Free includes 100,000 Durable Object requests/day, 13,000 GB-s/day, 5 million SQLite rows read/day, 100,000 SQLite rows written/day, and 5 GB account storage.
- Incoming WebSocket messages are request-billed in groups of 20 after the connection request; outgoing WebSocket messages are not request-billed.
- alarm writes, row deletes, and index maintenance count as row writes.
- `ctx.storage.deleteAll()` removes the SQLite database; with the configured compatibility date after 2026-02-24 it also removes the alarm.

Authoritative references:

- <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- <https://developers.cloudflare.com/durable-objects/platform/limits/>
- <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>
- <https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/>

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
  |- allocation leases      |- sessions and sockets
  |- incarnation counter    |- snapshot/revision
  |- tombstones             |- in-row command cache
  `- release/reconcile      `- pending actions/alarms
```

The entry point is stateless. The registry is authoritative for whether a code is free, provisioning, active, release-pending, or tombstoned. A room object is the sole writer for its incarnation. Its object name contains both code and incarnation, so a late request for an expired incarnation cannot mutate a newer room that reused the same code.

The existing `workers/wrangler.jsonc` keeps `workers_dev: false` and gains two SQLite Durable Object classes and a new migration tag. No production route is added in this milestone.

## Module boundaries and entry routes

`workers/src/index.mjs` remains a narrow dispatcher. Existing `/__dds/*` behavior and remote-test authorization do not change. Room-foundation routes are enabled only when `ROOM_FOUNDATION_TEST` is exactly `true`; otherwise they return the same opaque not-found response used for unavailable test surfaces.

Plan B implements these future public shapes:

- `POST /api/rooms` creates a room and owner session.
- `POST /api/rooms/{code}/join` creates a player or spectator session.
- `GET /api/rooms/{code}/{incarnation}/ws` upgrades to WebSocket but exposes no state before authenticated `hello`.

Reconnect tokens never appear in URLs, cookies, logs, Durable Object attachments, or broadcast payloads.

Internal registry and room methods are invoked only through Durable Object bindings by the entry router or registry. They are never mapped directly to public HTTP routes.

## Protocol limits

The following limits are part of protocol version 1, not implementation defaults:

| Item | Limit |
|---|---:|
| HTTP JSON body | 16 KiB |
| WebSocket frame before parsing | 16 KiB |
| command payload after parsing | 8 KiB |
| `requestId`, command `id`, rotation `id` | 16–64 URL-safe characters |
| display name | 1–32 Unicode scalar values |
| total sessions | 16 |
| player sessions | 4, including owner |
| spectator sessions | 12 |
| unauthenticated sockets per room | 8 |
| `hello` deadline | 10 seconds |
| pending actions | 64 |
| serialized room snapshot | 512 KiB |
| recent command entries | 128 per player session |
| recent command TTL | 24 hours |

Sessions live until room expiry. Plan B does not reclaim seats, replace owners, or delete individual sessions. The owner is always seat `N`; additional players receive `E`, `S`, then `W`; all later sessions are spectators until capacity is reached.

## Lobby registry

### Persisted state

The singleton registry stores one row per three-digit code:

```text
room_codes(
  code TEXT PRIMARY KEY,
  incarnation INTEGER NOT NULL,
  status TEXT NOT NULL,
  lease_id TEXT,
  lease_expires_at INTEGER,
  tombstone_until INTEGER,
  updated_at INTEGER NOT NULL
)

creation_requests(
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  code TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  lease_id TEXT NOT NULL,
  status TEXT NOT NULL,
  response_json TEXT,
  expires_at INTEGER NOT NULL
)
```

Only the primary keys are indexed. With at most 1,000 code rows and a bounded request-replay table, status and expiry scans avoid write-amplifying secondary indexes. Creation request records are retained for 24 hours after activation or terminal failure, then physically deleted during ordinary allocation or registry-alarm work. The registry rejects allocation with `SERVICE_CAPACITY` rather than creating an unrecorded room if the request table reaches 2,000 live records.

### State transitions

```text
FREE/expired TOMBSTONE
  --allocate(requestId)--> PROVISIONING
PROVISIONING
  --activate(exact lease)--> ACTIVE
PROVISIONING
  --lease reconciliation, room absent--> TOMBSTONE
PROVISIONING
  --lease reconciliation, room initialized--> ACTIVE
ACTIVE
  --markReleasePending(exact incarnation)--> RELEASE_PENDING
RELEASE_PENDING
  --release(exact incarnation)--> TOMBSTONE
TOMBSTONE
  --tombstone elapsed + allocate--> PROVISIONING with incarnation + 1
```

Allocation creates a random `lease_id`, persists `PROVISIONING`, and returns the exact code/incarnation/lease to the entry router. It does not advertise the room as active. The router initializes the room and then calls `activate` with the exact lease. The create response is returned only after activation commits.

`creation_requests` makes a create retry deterministic. Allocation inserts the canonical request hash and exact lease in the same registry transaction as `PROVISIONING`. Activation stores the complete non-secret success response. Repeating the same request within the 24-hour replay window returns the same provisioning or active allocation; reusing it with a different canonical request fingerprint fails with `REQUEST_CONFLICT`.

The registry maintains an alarm for the earliest provisioning lease. If the creator disappears between allocation and activation, reconciliation calls the exact room's internal `inspectInitialization` method. An initialized matching room is activated; an absent or mismatched room is tombstoned. This closes the cross-object allocation leak without relying on the original request process.

### Release semantics

`markReleasePending` succeeds only for the exact active incarnation. `release` has terminal, retry-safe semantics:

- exact `RELEASE_PENDING` transitions to a five-minute tombstone and returns `RELEASED`;
- the exact already-tombstoned incarnation returns `RELEASED`;
- a row with a newer incarnation returns `SUPERSEDED` for the old room;
- exact `ACTIVE` or `PROVISIONING` rejects release.

Thus a lost success response can be retried after tombstoning or reuse without releasing the newer room.

## Room object

### State and schema

`StepstoneRoom` restores its database and hibernatable sockets inside `blockConcurrencyWhile()`. Correctness-critical state never exists only in memory. Its lifecycle is:

```text
UNINITIALIZED --initialize(exact lease)--> ACTIVE
ACTIVE --room-expiry--> CLOSING
CLOSING --registry terminal release--> DELETED via deleteAll()
```

Only the registry's exact provisioning lease can initialize an empty room object. Public traffic to an uninitialized, closing, or deleted incarnation returns opaque `ROOM_NOT_FOUND` or `ROOM_EXPIRED` as appropriate.

The Plan B snapshot is intentionally small:

```json
{
  "schemaVersion": 1,
  "roomCode": "123",
  "incarnation": 7,
  "revision": 4,
  "status": "ACTIVE",
  "foundationCounter": 2,
  "createdAt": 0,
  "expiresAt": null,
  "recentCommands": {}
}
```

`foundationCounter` exists only to prove authenticated mutation, revision conflict handling, idempotency, persistence, reconnect, and eviction recovery. Gameplay later replaces the test command.

Storage is bounded:

```text
room_state(
  incarnation INTEGER PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER,
  state_json TEXT NOT NULL
)

sessions(
  session_id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  previous_token_hash TEXT,
  last_rotation_id TEXT,
  last_rotation_next_hash TEXT,
  current_connection_id TEXT,
  bootstrap_request_id TEXT NOT NULL,
  bootstrap_request_hash TEXT NOT NULL,
  bootstrap_response_json TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  role TEXT NOT NULL,
  seat TEXT,
  connection_epoch INTEGER NOT NULL,
  expires_at INTEGER
)

pending_actions(
  action_id TEXT PRIMARY KEY,
  incarnation INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL
)
```

Only `token_hash` is additionally indexed through its unique constraint. The small bounded session table is scanned for role/seat checks. `pending_actions.due_at` is indexed because alarm scheduling depends on it and action writes are infrequent.

There is no `command_ids` table. Each player's bounded command cache is embedded in `room_state.state_json`, so a normal state-changing command performs one row update rather than a snapshot update plus an idempotency-row insert. Each cache entry contains session ID, command ID, canonical request SHA-256, committed revision, compact reply, and expiry. Full snapshots are derived at response time and are never duplicated into cache entries.

SQL-only multi-statement changes use `transactionSync`; SQL `BEGIN` is not issued through `sql.exec()`. A mutation that must atomically change SQL rows and the single Durable Object alarm instead uses `await ctx.storage.transaction(async () => { ... })`, performs SQL through `ctx.storage.sql.exec()`, and awaits `ctx.storage.setAlarm()` or `deleteAlarm()` inside that storage transaction. This distinction applies to provisioning leases, initialization expiry, handshake deadlines, room expiry, and release retries.

## Bootstrap idempotency and session authority

### Create and join

The browser generates both a stable request ID and a 32-byte random base64url reconnect token with Web Crypto before each create or join request. The token is therefore recoverable across an HTTP response loss; the server never needs to return or persist plaintext token material.

Create body:

```json
{
  "v": 1,
  "requestId": "...",
  "displayName": "North",
  "reconnectToken": "..."
}
```

Join body:

```json
{
  "v": 1,
  "requestId": "...",
  "displayName": "East",
  "reconnectToken": "...",
  "requestedRole": "player"
}
```

`requestedRole` is `player` or `spectator`. A player request fails with `ROOM_CAPACITY_EXCEEDED` when all seats are occupied; it is never silently downgraded. The owner session occupies `N`.

Successful create and join responses are:

```json
{
  "v": 1,
  "requestId": "...",
  "roomCode": "123",
  "incarnation": 7,
  "sessionId": "...",
  "role": "OWNER",
  "seat": "N"
}
```

Create and join persist the SHA-256 token digest, bootstrap request ID, canonical request fingerprint, and non-secret response transactionally with the new session. The bounded session table is scanned by bootstrap request ID, avoiding another index. Repeating the same request ID and fingerprint returns the same result; using the ID with different input returns `REQUEST_CONFLICT`. Raw tokens are never persisted.

Room initialization immediately schedules an `owner-auth-expiry` action for ten minutes. Therefore a created room whose owner never opens or authenticates a socket still expires and releases its code.

### WebSocket authentication and recoverable rotation

An upgraded socket receives no state before authentication. At most eight unauthenticated sockets may exist for a room. Every accepted socket receives an attachment with a random connection ID and acceptance time, and a durable `handshake-timeout` pending action. A socket that does not authenticate within ten seconds is closed. Construction, alarm handling, and wake-up enumerate hibernatable sockets, close expired unauthenticated sockets, and schedule the next deadline. Constructor recovery first reads the existing alarm; if it is already due, it preserves or resets it to `Date.now()` rather than replacing it with a later action.

The first frame is:

```json
{
  "v": 1,
  "type": "hello",
  "id": "rotation-id",
  "reconnectToken": "current-token",
  "nextReconnectToken": "client-generated-next-token"
}
```

The room validates both tokens and computes the proposed connection epoch. Before starting the storage transaction it serializes the proposed authenticated attachment onto the socket. It then, in one storage transaction:

1. records the new digest and the old digest;
2. records the rotation ID and proposed next-token digest;
3. stores the socket's `current_connection_id` and increments `connection_epoch`;
4. cancels the socket's handshake timeout and any room expiry action;
5. persists any resulting alarm change.

This ordering closes the commit-to-attachment crash gap. If storage rolls back after the attachment is serialized, the attachment epoch does not match SQLite, the socket has no authority, and its still-persisted handshake timeout closes it. If storage commits and the object resets before replying, the reconstructed socket attachment and SQLite epoch match, so exact rotation replay can recover the response.

An exact replay of the same rotation ID with the same current and next token is accepted. On the same socket it is idempotent and keeps the epoch. On a different socket it is a connection takeover: the credential rotation remains idempotent, but `current_connection_id` changes and `connection_epoch` increments again. A different rotation request using the previous token is rejected. Since the client generated and retained the next token before commit, loss of the `hello-ok` response cannot strand the session or authorize two live sockets.

Success is:

```json
{
  "v": 1,
  "type": "hello-ok",
  "id": "rotation-id",
  "payload": {
    "sessionId": "...",
    "role": "PLAYER",
    "seat": "E",
    "connectionEpoch": 3,
    "revision": 4,
    "snapshot": {}
  }
}
```

The authenticated socket attachment contains only `{ sessionId, incarnation, protocolVersion, connectionId, connectionEpoch, authenticated }`. Every subsequent frame compares its attachment epoch with the persisted session epoch. Once a newer socket authenticates, the old socket loses authority immediately even if its close frame is delayed; it is closed with `SESSION_REPLACED`.

## Command protocol and consistency

Commands use:

```json
{
  "v": 1,
  "type": "command",
  "id": "client-command-id",
  "name": "foundation.increment",
  "payload": { "expectedRevision": 4 }
}
```

Replies, errors, and events use:

```json
{ "v": 1, "type": "reply", "id": "client-command-id", "name": "foundation.increment", "payload": { "revision": 5, "snapshot": {} } }
{ "v": 1, "type": "error", "id": "client-command-id", "payload": { "code": "REVISION_CONFLICT", "revision": 5, "snapshot": {} } }
{ "v": 1, "type": "event", "name": "room.snapshot", "payload": { "revision": 5, "snapshot": {} } }
```

Plan B implements:

- `foundation.increment`: OWNER or PLAYER only; increments the counter and revision once.
- `room.sync`: any authenticated role; read-only and returns the current role-filtered snapshot without changing revision or storage.

Spectators receive `FORBIDDEN` for mutations. `foundation.increment` requires exact `expectedRevision`; a stale value returns `REVISION_CONFLICT` with the current role-filtered snapshot.

The mutation path is:

1. reject an oversized frame before parsing;
2. validate JSON, protocol version, ID, name, payload, room, incarnation, session, connection epoch, and role;
3. compute the canonical request hash;
4. check the bounded in-snapshot command cache;
5. build an immutable proposed snapshot, prune expired cache entries, and add the compact result;
6. transactionally update the single `room_state` row plus any genuinely required session/action rows;
7. assign the committed snapshot to memory;
8. reply and broadcast the role-filtered full committed snapshot.

A repeated ID with the same canonical hash returns the cached compact result combined with the current snapshot and rebroadcasts that current snapshot. The mutation is not repeated. Reusing an ID with different canonical input returns `COMMAND_CONFLICT`.

Every reply and event carries a revision. A client seeing a gap calls `room.sync`. If the object commits and crashes before delivery, the retry is deduplicated and its resynchronizing broadcast repairs peers. This provides retry-safe mutation and eventual snapshot convergence without pretending WebSocket delivery itself is transactional.

No broadcast occurs before commit. On transaction failure, the room discards the proposal, reloads persisted state, and returns `SERVICE_CAPACITY`.

Close codes are stable:

| Code | Meaning |
|---:|---|
| 1002 | malformed frame or protocol mismatch |
| 4401 | authentication invalid |
| 4403 | command forbidden |
| 4408 | authentication deadline exceeded |
| 4409 | session replaced by a newer connection |
| 4410 | room incarnation expired |

## Pending actions, expiry, release, and deletion

Pending actions are idempotent records. The room sets a single Durable Object alarm to the earliest live action. Alarm execution reloads all due actions in order and recomputes the next alarm.

Relevant actions are:

- `owner-auth-expiry`: ten minutes after room initialization until the owner first authenticates;
- `handshake-timeout`: ten seconds after each unauthenticated upgrade;
- `room-expiry`: 24 hours after the final authenticated socket closes;
- `registry-release`: retried with exponential backoff capped at one hour.

Only successful `OWNER` authentication cancels `owner-auth-expiry`. A player or spectator may authenticate first, but does not claim the room; if the owner never authenticates within ten minutes the room closes those sockets and expires. Any valid authentication cancels a pending 24-hour `room-expiry`. When the final authenticated socket closes, the room schedules room expiry. Expiry rechecks status, connection epochs, socket attachments, and action ownership before it can proceed.

Cancellation and completion physically delete action rows in the same mixed SQL/alarm transaction; they are not retained as tombstones. A reconnect replaces the existing deterministic `room-expiry` action rather than appending another, and a release retry updates its existing action row. Consequently the 64-row cap applies only to live actions. If 64 genuinely live actions already exist, a new upgrade or schedule request fails with `SERVICE_CAPACITY` before accepting the socket or committing any partial state.

Expiry then:

1. persists `CLOSING` and revokes all session authority;
2. cancels all non-release actions and persists a `registry-release` action;
3. asks the registry to mark the exact code/incarnation release-pending;
4. calls retry-safe `release` for that exact incarnation;
5. after `RELEASED` or `SUPERSEDED`, executes `ctx.storage.deleteAll()`.

If a cross-object call fails, the room remains `CLOSING` with the retry action. Allocation encountering a stale state asks the exact old room to reconcile; that room releases only if its persisted status is `CLOSING` and its incarnation matches. Public joins, reconnects, and commands cannot reactivate it.

`deleteAll()` intentionally removes obsolete room rows and alarms after terminal registry release, preventing expired room databases from accumulating indefinitely. Registry tombstones remain for five minutes and are reused only with a strictly higher incarnation.

## Errors and privacy

Externally visible error codes are stable:

- `PROTOCOL_MISMATCH`
- `INVALID_REQUEST`
- `INVALID_COMMAND`
- `REQUEST_CONFLICT`
- `AUTH_INVALID`
- `ROOM_NOT_FOUND`
- `ROOM_EXPIRED`
- `SESSION_REPLACED`
- `FORBIDDEN`
- `REVISION_CONFLICT`
- `COMMAND_CONFLICT`
- `ROOM_CAPACITY_EXCEEDED`
- `SERVICE_CAPACITY`

Raw exceptions, SQL text, token digests, hidden room existence, and internal object IDs are never returned. Before authentication, failures deliberately do not distinguish a valid room from an invalid one. Logs may include a generated diagnostic ID and stable code, but never raw tokens, token hashes, request bodies, or complete snapshots.

## Testing strategy

### Pure unit tests

- protocol schemas, bounds, canonical hashing, and stable errors;
- base64url token shape, hashing, exact rotation replay, response-loss recovery, and constant-time digest comparison;
- roles, seat allocation, authorization, and role-filtered snapshots;
- command cache TTL/cap, canonical conflict, revision conflict, and duplicate recovery broadcast;
- pending-action ordering, cancellation, alarm recomputation, and exponential backoff;
- registry transition table, exact lease/incarnation checks, terminal release replay, and newer-incarnation protection;
- schema migration from empty storage and rejection of unknown versions.

### Durable Object integration tests

- create one room, join three additional players, then join a spectator;
- retry create and join after simulated response loss without creating another allocation or session;
- reject state disclosure before `hello`, enforce eight-socket cap, and close authentication timeouts;
- rotate tokens, replay an exact rotation after response loss, and reject an unrelated use of the old token;
- authenticate a non-owner first and prove only later owner authentication cancels owner-auth expiry;
- replace an older socket and prove its persisted connection epoch is no longer authorized before close delivery;
- inject failures before authentication commit and after commit/before reply, then prove attachment/epoch recovery cannot strand or duplicate authority;
- apply `foundation.increment` once, reject stale revision, and replay its result after duplicate delivery;
- simulate commit-before-broadcast failure, retry, rebroadcast, and resynchronize all peers;
- reconstruct the object and recover snapshot, sessions, epochs, and pending actions from storage;
- cancel expiry on reconnect;
- expire a room whose owner never authenticates;
- expire an empty room, retry a failed registry release, tombstone it, delete its storage, and reuse the code at a higher incarnation;
- crash between allocation, initialization, and activation, then reconcile the provisioning lease in both initialized and absent cases;
- lose a release response after tombstoning and after reuse, then prove terminal retry cannot release the newer room;
- prove delayed old-incarnation traffic cannot join, reconnect, mutate, or release the new room;
- retain all existing DDS adapter, harness, and remote-auth tests unchanged.

Tests use fake clocks and injected failure points rather than real delays. Integration tests run in Wrangler's local runtime and require no Cloudflare token.

### Budget gate

The budget simulator uses the actual SQL statement accounting, including primary/unique-index maintenance, due-action index maintenance, alarms, deletes, creation-request retention, and final `deleteAll()` effects. Its daily scenario is 50 rooms, each with allocation, owner creation, three player joins, one spectator, 1,000 state-changing commands, four reconnect rotations, expiry schedule/cancel, final expiry, one registry-release retry, tombstone, deletion, and code reuse.

Normal commands update one unindexed `room_state` row. Therefore 50,000 commands consume approximately 50,000 row writes, not 100,000 writes from a separate idempotency table.

The deterministic gate fails above any internal target:

| Meter | Internal target | Free allowance |
|---|---:|---:|
| billed Durable Object requests/day | 70,000 | 100,000 |
| duration/day | 9,100 GB-s | 13,000 GB-s |
| rows read/day | 250,000 | 5,000,000 |
| rows written/day | 70,000 | 100,000 |
| stored data | 3.5 GB | 5 GB |

This preserves at least 30% headroom on the limiting request, duration, write, and storage meters, while keeping a much stricter read target. A static assertion also forbids adding a per-command idempotency table or a secondary index whose maintenance makes the declared scenario exceed the gate.

The request calculation is explicit and rounds WebSocket-message billing conservatively per room:

```text
per room =
  3 create RPCs                     # allocate + initialize + activate
  + 4 join RPCs
  + 9 WebSocket connection requests # five initial + four reconnects
  + ceil(1009 / 20)                 # five hello + 1000 commands + four reconnect hello
  + 2 alarm invocations             # expiry + one release retry
  + 3 release RPCs                  # mark + failed release + successful retry
  + 3 reuse RPCs                    # allocate + initialize + activate
  = 75 billed Durable Object requests

daily = 50 * 75 = 3,750 billed Durable Object requests
```

The duration gate is a reproducible planning upper bound, not a claim that a local runner can observe Cloudflare billing. The simulator counts actual Durable Object handler executions before the 20:1 request discount and applies a fixed 500 ms active-time envelope at the billed 128 MB allocation:

```text
per room actual handler executions =
  3 + 4 + 9 + 1009 + 2 + 3 + 3 = 1,033

daily duration upper bound =
  50 * 1,033 * 0.5 seconds * 0.128 GB
  = 3,305.6 GB-s
```

The integration suite separately records controlled local wall-clock latency for every handler category counted by the formula: allocation, initialization, activation, join, upgrade, initial hello, reconnect hello, ordinary command, alarm, release calls, and reuse. Cross-object wait time remains inside the initiating handler's measurement. It fails if any measured handler execution exceeds the 500 ms design envelope. Future public rollout must validate real Cloudflare analytics; Plan B does not treat local latency as measured billable duration.

## Acceptance criteria

Plan B is complete only when:

- all existing application, DDS, and Workers tests pass;
- local integration tests prove create, join, authentication, recoverable rotation, socket replacement, persistence recovery, retry-safe command handling, resynchronization, expiry, release retry, storage deletion, and safe code reuse;
- provisioning and release crash windows converge without advertising a missing room or leaking a code;
- old-incarnation requests cannot affect a reused room code;
- the measured budget simulation remains inside every internal target;
- Worker configuration still has no production route and `workers_dev` remains disabled;
- no browser client, gameplay engine, DNS record, `stepstone.hogetsu.uk`, or production Worker changes.

Passing Plan B authorizes a separate Plan C design and implementation cycle for classic-mode migration. It does not authorize public rollout.
