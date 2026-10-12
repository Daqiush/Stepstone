# Workers Durable Room Foundation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans to implement this plan. Follow the RED/GREEN sequence and commit after every task.

**Goal:** Add the local/test-gated Durable Object room foundation approved in the Plan B design without changing gameplay, public routes, DNS, or production Workers.

**Architecture:** Keep the existing DDS feasibility surface intact. Add a stateless room router, a singleton `LobbyRegistry` SQLite Durable Object, and one `StepstoneRoom` SQLite Durable Object per code/incarnation. Persist bootstrap replay records, session authority, a single room snapshot with bounded in-row command replay, and a compact live-action queue driving one alarm.

**Tech stack:** Cloudflare Workers/Wrangler 4, SQLite Durable Objects, hibernatable WebSockets, JavaScript ESM, Node.js 22 `node:test`.

---

## Chunk 1: Pure contracts and Worker wiring

### Task 1: Add protocol, validation, hashing, and transition primitives

**Files:**
- Create: `workers/src/room-foundation/constants.mjs`
- Create: `workers/src/room-foundation/protocol.mjs`
- Create: `workers/src/room-foundation/registry-state.mjs`
- Test: `workers/test/room-foundation-protocol.test.mjs`
- Test: `workers/test/room-registry-state.test.mjs`

- [ ] **Step 1: Write failing table-driven tests**

Cover exact size/count limits, strict version-1 request/command envelopes, URL-safe IDs, display-name scalar length, base64url 32-byte tokens, canonical SHA-256 fingerprints, constant-time digest comparison, stable public errors, registry transitions, exact lease/incarnation checks, and terminal `RELEASED`/`SUPERSEDED` replay.

- [ ] **Step 2: Verify RED**

Run: `node --test workers/test/room-foundation-protocol.test.mjs workers/test/room-registry-state.test.mjs`

Expected: module-not-found failures.

- [ ] **Step 3: Implement minimal pure helpers**

Keep Web APIs only (`crypto.subtle`, `TextEncoder`, `Response`). Do not import Node modules into Worker source. Canonicalization rejects unknown fields and recursively sorts accepted object keys before hashing.

- [ ] **Step 4: Verify GREEN**

Run the focused tests again; expect zero failures.

- [ ] **Step 5: Commit**

```powershell
git add workers/src/room-foundation workers/test/room-foundation-protocol.test.mjs workers/test/room-registry-state.test.mjs
git commit -m "feat: define durable room protocol contracts"
```

### Task 2: Wire gated routes and Durable Object migrations

**Files:**
- Create: `workers/src/room-foundation/router.mjs`
- Modify: `workers/src/index.mjs`
- Modify: `workers/wrangler.jsonc`
- Test: `workers/test/room-foundation-routing.test.mjs`
- Modify: `workers/test/remote-test-auth.test.mjs`

- [ ] **Step 1: Write failing routing/config tests**

Assert room routes are opaque 404 unless `ROOM_FOUNDATION_TEST === 'true'`; DDS local/remote behavior remains byte-for-byte compatible; unsupported room methods are stable; config keeps `workers_dev: false`, has no routes, and adds `LOBBY_REGISTRY`/`STEPSTONE_ROOM` SQLite classes in a new migration tag without changing `FeasibilityRoom`.

- [ ] **Step 2: Verify RED**

Run: `node --test workers/test/room-foundation-routing.test.mjs workers/test/remote-test-auth.test.mjs`

- [ ] **Step 3: Implement narrow dispatch and config**

Export all three Durable Object classes from `index.mjs`. Route `/api/rooms*` only to the new router when explicitly enabled; otherwise delegate to the unchanged DDS harness.

- [ ] **Step 4: Verify GREEN and run the full current Worker suite**

Run: `npm run test:workers`

- [ ] **Step 5: Commit**

```powershell
git add workers/src/index.mjs workers/src/room-foundation/router.mjs workers/wrangler.jsonc workers/test/room-foundation-routing.test.mjs workers/test/remote-test-auth.test.mjs
git commit -m "feat: gate durable room Worker routes"
```

## Chunk 2: Allocation and bootstrap persistence

### Task 3: Implement registry allocation leases and creation replay

**Files:**
- Create: `workers/src/room-foundation/lobby-registry.mjs`
- Modify: `workers/src/room-foundation/router.mjs`
- Modify: `workers/src/index.mjs`
- Test: `workers/test/lobby-registry.integration.test.mjs`
- Create: `workers/test/helpers/room-worker-runtime.mjs`

- [ ] **Step 1: Write failing Wrangler integration tests**

Cover allocation to `PROVISIONING`, exact activation, 24-hour create replay, request-hash conflict, expired lease reconciliation for initialized and absent rooms, 2,000 live-request capacity, five-minute tombstones, monotonically increasing incarnation, and retry-safe release after tombstone/reuse.

- [ ] **Step 2: Verify RED**

Run: `node --test workers/test/lobby-registry.integration.test.mjs`

- [ ] **Step 3: Implement registry SQL and alarm paths**

Use primary-key-only registry tables. Use `transactionSync` for SQL-only changes and asynchronous storage transactions for SQL plus alarm changes. Preserve an already-due alarm during constructor recovery. Replace the Task 2 placeholder export with the real registry class. Expose only internal RPC methods; a minimal router test bridge and failure injection may exist only behind `ROOM_FOUNDATION_TEST` and must never log request bodies or tokens.

- [ ] **Step 4: Verify GREEN**

Run the focused integration test twice to catch persistence/restart assumptions.

- [ ] **Step 5: Commit**

```powershell
git add workers/src/room-foundation/lobby-registry.mjs workers/src/room-foundation/router.mjs workers/src/index.mjs workers/test/lobby-registry.integration.test.mjs workers/test/helpers/room-worker-runtime.mjs
git commit -m "feat: add durable room allocation registry"
```

### Task 4: Implement room initialization and idempotent create/join

**Files:**
- Create: `workers/src/room-foundation/stepstone-room.mjs`
- Modify: `workers/src/room-foundation/lobby-registry.mjs`
- Modify: `workers/src/room-foundation/router.mjs`
- Modify: `workers/src/index.mjs`
- Test: `workers/test/room-bootstrap.integration.test.mjs`

- [ ] **Step 1: Write failing integration tests**

Create an owner at `N`, join players at `E/S/W`, join a spectator, reject a fifth player, cap total sessions, reject malformed/oversized bodies, replay create/join after simulated response loss, reject request-ID conflicts, reject raw-token leakage, and verify owner-auth expiry exists immediately after initialization.

- [ ] **Step 2: Verify RED**

Run: `node --test workers/test/room-bootstrap.integration.test.mjs`

- [ ] **Step 3: Implement room schema and router orchestration**

Persist owner/join bootstrap request IDs, fingerprints, non-secret responses, and only token hashes. Move the temporary StepstoneRoom inspection stub into the real room class and update Worker exports. Create becomes allocate → initialize → activate and returns only after activation. Compensate by lease reconciliation, never by freeing a code directly.

- [ ] **Step 4: Verify GREEN and inspect persisted behavior across runtime restart**

Run the focused test with a fresh and then reused persistence directory.

- [ ] **Step 5: Commit**

```powershell
git add workers/src/room-foundation/stepstone-room.mjs workers/src/room-foundation/lobby-registry.mjs workers/src/room-foundation/router.mjs workers/src/index.mjs workers/test/room-bootstrap.integration.test.mjs
git commit -m "feat: persist room bootstrap sessions"
```

## Chunk 3: WebSocket authority and commands

### Task 5: Add hibernatable authentication, rotation, and connection epochs

**Files:**
- Modify: `workers/src/room-foundation/constants.mjs`
- Modify: `workers/src/room-foundation/protocol.mjs`
- Modify: `workers/src/room-foundation/stepstone-room.mjs`
- Modify: `workers/src/room-foundation/router.mjs`
- Test: `workers/test/room-websocket.integration.test.mjs`
- Modify: `workers/test/helpers/room-worker-runtime.mjs`

- [ ] **Step 1: Write failing WebSocket tests**

Cover opaque pre-auth behavior, 16 KiB frame bound, eight unauthenticated sockets, ten-second timeout, initial rotation, same-socket replay, response-loss replay on a new socket, immediate old-socket revocation by connection epoch, old-token rejection, role-filtered hello snapshot, and stable close codes.

Add failpoints immediately before the auth storage commit and after commit/before reply. Prove rollback leaves an epoch mismatch plus live handshake timeout, while post-commit replay restores one authoritative connection.

- [ ] **Step 2: Verify RED**

Run: `node --test workers/test/room-websocket.integration.test.mjs`

- [ ] **Step 3: Implement hibernatable socket handling**

Serialize the proposed attachment before commit, validate persisted epoch on every later frame, enumerate attachments after wake-up, and physically delete completed/cancelled handshake actions. Only owner authentication cancels owner-auth expiry.

- [ ] **Step 4: Verify GREEN**

Run the focused test twice, including persistence reconstruction.

- [ ] **Step 5: Commit**

```powershell
git add workers/src/room-foundation/constants.mjs workers/src/room-foundation/protocol.mjs workers/src/room-foundation/stepstone-room.mjs workers/src/room-foundation/router.mjs workers/test/room-websocket.integration.test.mjs workers/test/helpers/room-worker-runtime.mjs
git commit -m "feat: enforce durable socket authority"
```

### Task 6: Add revisioned mutation, replay, and resynchronization

**Files:**
- Create: `workers/src/room-foundation/command-cache.mjs`
- Modify: `workers/src/room-foundation/stepstone-room.mjs`
- Test: `workers/test/room-commands.integration.test.mjs`
- Test: `workers/test/room-command-cache.test.mjs`

- [ ] **Step 1: Write failing unit/integration tests**

Cover `foundation.increment`, exact expected revision, spectator prohibition, `room.sync`, 128-entry/player and 15-minute cache pruning, one-state-row persistence, duplicate replay without mutation, canonical ID conflict, commit-before-broadcast failure, recovery rebroadcast, revision-gap sync, and full role-filtered snapshots in every reply/event.

- [ ] **Step 2: Verify RED**

Run: `node --test workers/test/room-command-cache.test.mjs workers/test/room-commands.integration.test.mjs`

- [ ] **Step 3: Implement the minimal command engine**

Keep compact results inside `room_state.state_json`; do not add a command table or per-command index. Commit before reply/broadcast. A duplicate returns the cached compact result combined with current state and rebroadcasts current state.

- [ ] **Step 4: Verify GREEN and inspect SQL accounting assertions**

Each ordinary successful mutation must assert one `room_state` row update and no idempotency-row insert.

- [ ] **Step 5: Commit**

```powershell
git add workers/src/room-foundation/command-cache.mjs workers/src/room-foundation/stepstone-room.mjs workers/test/room-command-cache.test.mjs workers/test/room-commands.integration.test.mjs
git commit -m "feat: add revisioned durable room commands"
```

## Chunk 4: Lifecycle, budget, and completion gates

### Task 7: Complete expiry, release retry, and storage deletion

**Files:**
- Modify: `workers/src/room-foundation/lobby-registry.mjs`
- Modify: `workers/src/room-foundation/stepstone-room.mjs`
- Test: `workers/test/room-lifecycle.integration.test.mjs`

- [ ] **Step 1: Write failing fake-clock/failpoint tests**

Cover non-owner-first auth, owner-auth timeout, final-socket 24-hour expiry, reconnect cancellation, 64 live-action capacity, physical action deletion, closing/revocation, failed registry release with exponential retry, terminal release response loss, `deleteAll()`, tombstone reuse, and delayed old-incarnation join/auth/command/release rejection.

- [ ] **Step 2: Verify RED**

Run: `node --test workers/test/room-lifecycle.integration.test.mjs`

- [ ] **Step 3: Implement one-alarm live-action scheduling**

Use deterministic action IDs for singleton actions, update retries in place, preserve due alarms on reconstruction, and call `deleteAll()` only after registry returns `RELEASED` or `SUPERSEDED` for the exact old incarnation.

- [ ] **Step 4: Verify GREEN**

Run focused lifecycle plus registry tests.

- [ ] **Step 5: Commit**

```powershell
git add workers/src/room-foundation/lobby-registry.mjs workers/src/room-foundation/stepstone-room.mjs workers/test/room-lifecycle.integration.test.mjs
git commit -m "feat: close durable room lifecycle"
```

### Task 8: Replace the budget model with measured Plan B accounting

**Files:**
- Create: `workers/src/room-foundation/budget-model.mjs`
- Modify: `scripts/simulate-worker-room-budget.mjs`
- Create: `workers/test/room-budget-model.test.mjs`
- Modify: `workers/test/room-commands.integration.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing budget tests**

Assert the exact per-room request formula equals 75, the 50-room request total equals 3,750, handler executions equal 1,033/room, duration upper bound equals 3,305.6 GB-s/day, and all reads/writes/index/alarm/delete/storage totals use recorded operation costs and remain within the design targets. Assert a hypothetical command table or added indexed command row breaks the write gate.

- [ ] **Step 2: Verify RED**

Run: `node --test workers/test/room-budget-model.test.mjs`

- [ ] **Step 3: Implement deterministic accounting and latency coverage**

Make the simulator independent of the DDS benchmark report. Add `simulate:workers-room-budget`. Instrument controlled integration handlers and assert every counted category, including cross-object waits, stays below 500 ms.

- [ ] **Step 4: Verify GREEN**

Run: `npm run simulate:workers-room-budget`

Run: `node --test workers/test/room-budget-model.test.mjs workers/test/room-commands.integration.test.mjs`

- [ ] **Step 5: Commit**

```powershell
git add workers/src/room-foundation/budget-model.mjs scripts/simulate-worker-room-budget.mjs workers/test/room-budget-model.test.mjs workers/test/room-commands.integration.test.mjs package.json
git commit -m "test: gate durable room free-plan budget"
```

### Task 9: Full verification and review

**Files:**
- Review all changes since `e757b13`.

- [ ] **Step 1: Run every focused room test**

Run: `node scripts/run-node-tests.js workers/test`

Expected: all existing DDS and new room tests pass.

- [ ] **Step 2: Run the complete application suite**

Run: `npm test`

Expected: zero failures.

- [ ] **Step 3: Run the explicit Worker suite and budget gate**

Run: `npm run test:workers`

Run: `npm run simulate:workers-room-budget`

Expected: zero failures and every internal budget target passes.

- [ ] **Step 4: Inspect safety boundaries**

Run: `git diff --check`

Run: `git status --short`

Run: `git diff e757b13...HEAD --stat`

Confirm `workers_dev: false`, no `routes`, no changed browser/gameplay/server files, no secret/token output, and no production deployment workflow.

- [ ] **Step 5: Request code review and fix all blockers**

Use `superpowers:requesting-code-review`. Re-run every affected focused test after fixes.

- [ ] **Step 6: Final regression and commit hygiene check**

Run the full application, Worker, and budget suites again. Verify the branch is clean and no production resource has been touched.

This plan ends with a locally verified branch only. Pushing, merging, production deployment, DNS changes, and `stepstone.hogetsu.uk` remain separate user-authorized actions.
