# Workers Free Remote DDS Soak Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add an authenticated, resumable, quota-bounded remote Durable Object DDS soak harness that validates 22,000 seeded cases without exposing a public compute endpoint or silently replaying an unknown operation.

**Architecture:** Preserve current local-only harness behavior. Add a remote authorization boundary in the entry Worker, a Durable Object SQLite idempotency/result cache, and a separate Node HTTPS runner with an atomic intent/journal. The runner uses eleven named-object shards, records reproducibility hashes and independent Worker/DO/storage accounting, then feeds a strict remote-gate checker.

**Tech Stack:** Cloudflare Workers and SQLite Durable Objects, Web Crypto, Emscripten Wasm metrics, Node.js 22 built-in test runner and filesystem APIs, existing native DDS baseline wrapper.

---

## Chunk 0: Verify the Plan-A harness prerequisite

Implement only in the isolated worktree `C:\\Users\\10149\\.codex\\worktrees\\workers-free-dds\\Stepstone`, whose immutable required baseline is commit `5500bf5dda8dc56c385a202ad541b995f738069d` and its Plan-A ancestors. The main checkout intentionally has no `workers/` tree and must not be used. Before any source modification, copy the approved specification/plan as separately committed documentation only, then verify the target commit is the current HEAD or an ancestor and compare the bytes of every required baseline path against `git show 5500bf5dda8dc56c385a202ad541b995f738069d:<path>`. Required paths are `workers/wrangler.jsonc`, `workers/src/index.mjs`, `workers/src/feasibility-room.mjs`, `workers/test/fixtures/dds-parity.json`, `scripts/benchmark-worker-dds.mjs`, `scripts/worker-dds-random-cases.mjs`, `scripts/worker-dds-checkpoint.mjs`, `scripts/simulate-worker-room-budget.mjs`, and `scripts/check-worker-dds-gates.mjs`. Missing, changed, or hash-divergent artifacts block this plan rather than causing a partial reimplementation.

### Task 0: Freeze the harness baseline

**Files:**
- Create: `scripts/assert-remote-soak-prerequisites.mjs`
- Create: `test/assert-remote-soak-prerequisites.test.js`

- [ ] Write failing tests for a missing required path and an altered baseline manifest.
- [ ] Implement a checker that verifies ancestry and compares every prerequisite file to the immutable `git show` content, emits expected/current SHA-256 values, and modifies no source files.
- [ ] Run `node --test test/assert-remote-soak-prerequisites.test.js` and then `node scripts/assert-remote-soak-prerequisites.mjs`; both must pass before Task 1.
- [ ] Commit only these prerequisite files with message `test: guard remote soak harness baseline`.

## Chunk 1: Remote endpoint authorization and operation identity

### Task 1: Build the pure remote authorization boundary

**Files:**
- Create: workers/src/remote-test-auth.mjs
- Create: workers/test/remote-test-auth.test.mjs
- Modify: workers/src/index.mjs

- [ ] **Step 1: Write failing authorization tests**

Create Request-based tests covering:
- local DDS_LOCAL_TEST=true accepts the existing routes without a key;
- remote mode requires DDS_REMOTE_TEST=true plus a valid 32-byte base64url X-DDS-Test-Key;
- bad, absent, malformed, or unequal-length keys return only an opaque not-found result;
- remote mode requires X-DDS-Run-Id, X-DDS-Operation-Id, X-DDS-Request-Hash, and X-DDS-Shard with documented ASCII grammar;
- unauthorized remote-shaped GET and oversized requests return opaque not-found; only a valid remote key may observe method-not-allowed or payload-too-large;
- when both test flags are set, a remote-shaped request follows remote authentication rather than a local bypass;
- no returned error includes a submitted key.

- [ ] **Step 2: Verify the test fails**

Run: node --test workers/test/remote-test-auth.test.mjs
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement pure authorization**

Implement authorizeHarnessRequest(request, env) in remote-test-auth.mjs. It must:
1. choose local mode only when DDS_LOCAL_TEST=true and DDS_REMOTE_TEST is not true; both flags force remote rules;
2. in remote mode, return the same opaque 404 for disabled flag, absent/bad key, malformed key, or absent metadata before revealing method/body details;
3. after valid key, require POST and buffer no more than 32768 bytes, including stream-counting when Content-Length is absent;
4. decode both keys as base64url, require exactly 32 bytes, and compare bytes with XOR accumulation;
5. validate metadata and return a typed result containing replacement request bytes and identity.

Do not import Node APIs or log a header.

- [ ] **Step 4: Wire the entry Worker**

Modify index.mjs so the existing local route set and fixed local DO name remain unchanged. For a validated remote request, use idFromName with remote-feasibility plus run ID plus shard. Construct a replacement Request from the buffered body, forward only validated metadata, and reject before a DO stub is created.

- [ ] **Step 5: Verify and commit**

Run: node --test workers/test/remote-test-auth.test.mjs workers/test/feasibility-room.test.mjs
Expected: PASS.

Commit:
git add workers/src/remote-test-auth.mjs workers/src/index.mjs workers/test/remote-test-auth.test.mjs workers/test/feasibility-room.test.mjs
git commit -m "feat: protect remote DDS harness routes"

## Chunk 2: Durable Object idempotency and activation evidence

### Task 2: Persist and replay remote operation results

**Files:**
- Modify: workers/src/feasibility-room.mjs
- Modify: workers/test/feasibility-room.test.mjs

- [ ] **Step 1: Write failing Worker integration tests**

Send the same remote table and ordered-solve request twice with equal run ID, operation ID, and request hash. Require byte-equivalent persisted canonical operationResult and exactly one Wasm completion; permit a separate transport envelope to add replayed=true on the second delivery. Send the same operation ID with a different hash and require opaque OPERATION_CONFLICT with no Wasm invocation. Assert different run IDs are isolated.

Require every remote response to include an activation ID, stable during continuous calls to one object. Assert test-operation storage is keyed by run ID and operation ID. Keep existing local failure and queue tests intact.

- [ ] **Step 2: Verify failure**

Run: npm run test:workers -- --test-name-pattern "remote operation"
Expected: FAIL because idempotency is absent.

- [ ] **Step 3: Implement the operation cache**

In blockConcurrencyWhile create SQLite table test_operations with run_id, operation_id, request_hash, response_json, created_at and primary key (run_id, operation_id). Generate one cryptographic activation ID for each object construction.

For remote requests, query the operation first under same-object serialization. Equal request hashes replay the stored canonical operationResult; unequal hashes return OPERATION_CONFLICT. Otherwise execute exactly once, include activation ID and metrics in operationResult, insert it before returning it. Do not cache malformed input or runtime failure. Ordered probes decide cache state outside the inner queue, then synchronously enqueue solve followed by ping; neither inner operation self-fetches or awaits the other, so no nested-queue deadlock occurs.

- [ ] **Step 4: Add explicit accounting**

Return four distinct accounting fields. `workerInbound` counts every physical entry-Worker request. `doFetchArrivals` counts every physical fetch arrival at the Durable Object, including replay cache lookups. `queuedDoCommands` is the approved workload metric: one for a table and two for solve-plus-ping, with an identical replay contributing zero new queued commands. `sqliteRows` reports actual idempotency reads/writes. The runner records all four; the 50,000 circuit-breaker and gate apply specifically to cumulative `queuedDoCommands`, while physical Worker/DO arrivals and SQLite units have their own reported ceilings. Tests must prove a replay increments physical arrival/read totals, preserves queuedDoCommands, and cannot become free accounting.

- [ ] **Step 5: Verify and commit**

Run: npm run test:workers
Expected: PASS.

Commit:
git add workers/src/feasibility-room.mjs workers/test/feasibility-room.test.mjs
git commit -m "feat: make remote DDS operations idempotent"

## Chunk 3: Atomic runner state and remote execution

### Task 3: Implement the local intent and journal state machine

**Files:**
- Create: scripts/remote-dds-soak-state.mjs
- Create: test/remote-dds-soak-state.test.js

- [ ] **Step 1: Write failing state tests**

Use a temporary directory. Require createRunManifest to record seed 20260923, xorshift32, SHA-256 hashes of worker-dds-random-cases.mjs and fixture corpus, exactly eleven 2,000-index shards, and the accounting schema version.

Test the transitions:
- recordIntent then recovery yields replay-pending;
- recordCompletion moves the cursor by one;
- a gap, duplicate, invalid JSON, changed deterministic request, or changed hash fails closed;
- a terminal failed record leaves the completed cursor at the preceding ID.

Require the projection to report 22,000 Worker requests and 43,780 queuedDoCommands before fixtures. Project physical Worker inbound and doFetchArrivals, queuedDoCommands, and SQLite costs for fixtures, eleven cold starts, metric probes, pending replays, and close/smoke probes before each dispatch. Reject any projected or observed queuedDoCommands above 50,000, physical Worker inbound above 25,000, or test SQLite reads/writes above 25,000; report doFetchArrivals independently. Tests must cover replay effects on all four accounting fields.

- [ ] **Step 2: Verify failure**

Run: node --test test/remote-dds-soak-state.test.js
Expected: FAIL because helpers do not exist.

- [ ] **Step 3: Implement durable state**

Use the existing atomic checkpoint primitive for manifest and report, plus an append-only JSONL intent/completion/failed journal. Canonical JSON is stable-key UTF-8 JSON of route plus exact request body; X-DDS-Request-Hash is its SHA-256. Fsync each intent before dispatch and each final response hash before cursor advance. On resume, validate contiguous completed records and regenerate the pending request's canonical bytes from its deterministic index. A pending request can advance only after the same operation ID replays a matching persisted remote response.

Add tests for a failed pending replay, activation ID change after a replay, and every crash window between intent fsync, dispatch, remote commit, completion fsync, and report replacement.

- [ ] **Step 4: Verify and commit**

Run: node --test test/remote-dds-soak-state.test.js
Expected: PASS.

Commit:
git add scripts/remote-dds-soak-state.mjs test/remote-dds-soak-state.test.js
git commit -m "feat: persist remote DDS soak state"

### Task 4: Build the HTTPS-only remote soak runner

**Files:**
- Create: scripts/remote-worker-dds-soak.mjs
- Create: scripts/prepare-remote-dds-deployment.mjs
- Modify: package.json
- Test: test/remote-dds-soak-state.test.js

- [ ] **Step 1: Write failing option tests**

Extract parseRemoteSoakOptions. Reject http, localhost, non-workers.dev HTTPS URLs, absent DDS_REMOTE_TEST_KEY, nonempty run directories without --resume, and a count other than 22000. Assert the returned metadata and every error omit the secret.

- [ ] **Step 2: Generate and bind deployment evidence**

Implement prepare-remote-dds-deployment.mjs to hash and size the exact Wasm file, hash the harness source list, and create a manifest with a deterministic build ID. Test altered Wasm bytes, missing Worker version ID, and mismatched endpoint build ID. The deploy step captures Wrangler's returned version ID, stores it in the manifest, and verifies it through the Workers API before the runner starts.

- [ ] **Step 3: Implement the runner**

Before deployment, generate a deployment manifest from the exact local `dds-worker.wasm` bytes: artifact size, SHA-256, harness source hash, and a derived build ID. Deploy with that build ID as a non-secret environment variable. Capture Wrangler's returned Worker version ID and verify through the Workers API that this version is deployed; require `/__dds/metrics` to echo the build ID. The runner accepts only this generated, version-bound manifest, never an operator-supplied number. For every fixture first and then every seeded case, calculate native DDS expectation, write intent, POST canonical request JSON and stable test/run/operation/hash/shard headers, validate authorization response, physical/logical accounting, activation ID, heap/elapsed metrics, shape and candidate legality, compare with existing tie-aware validator, then write completion or terminal failure. Preserve input, local and remote results, candidate diagnostics, timings, and heap per operation. Record fixture SHA-256, random-generator SHA-256, exact 13-depth counts, named cold-start evidence, and the version-bound Wasm manifest.

Use ordered-probe for solves and table for tables. Derive shard from random index divided by 2000. Require activation ID stability inside a shard, including after a successful pending replay. Resolve exactly one pending intent by stable-ID replay before continuing. Save report after every operation; print progress every 100. Add package command remote:dds-soak that reads the key only from DDS_REMOTE_TEST_KEY.

- [ ] **Step 4: Verify and commit**

Run: node --test test/remote-dds-soak-state.test.js
Expected: PASS without Cloudflare access.

Commit:
git add scripts/remote-worker-dds-soak.mjs scripts/prepare-remote-dds-deployment.mjs scripts/remote-dds-soak-state.mjs test/remote-dds-soak-state.test.js package.json
git commit -m "feat: add resumable remote DDS soak runner"

## Chunk 4: Gates and safe operation

### Task 5: Enforce remote report gates

**Files:**
- Create: scripts/check-remote-worker-dds-gates.mjs
- Create: test/remote-worker-dds-gates.test.js
- Modify: package.json

- [ ] **Step 1: Write failing checker tests**

Create synthetic reports that independently fail wrong hash/algorithm, incomplete shard or non-fixture-first corpus, terminal failed journal record, HTTP/network/protocol failure, parity mismatch, unreconciled candidate diagnostic, missing depth, activation change inside a shard, absent/mismatched/operator-only deployment manifest, bundle at 3 MiB, heap at 100663296 bytes, p99/max elapsed at threshold, queue delay at ten seconds, physical Worker requests above 25,000, queued DO commands above 50,000, test SQLite rows above 25,000, and simulator writes/reads above 70,000/250,000. Include one complete passing report.

- [ ] **Step 2: Implement checker**

Require exactly 22,000 completed cases, all eleven ranges, all depths, exact fixture completion before random work, recorded source hashes, version-bound generated deployment manifest with a matching endpoint build ID and deployed version, Wasm bundle below 3 MiB, and continuous nonfailed journal. Compute nearest-rank p99 from unrounded wasmElapsedMs. Independently validate Worker inbound, doFetchArrivals, queuedDoCommands, temporary idempotency storage, and the existing room-budget simulator's explicit product targets. Exit nonzero for missing or failing evidence, printing each gate name.

- [ ] **Step 3: Verify and commit**

Run: node --test test/remote-worker-dds-gates.test.js test/worker-dds-gates.test.js
Expected: PASS.

Commit:
git add scripts/check-remote-worker-dds-gates.mjs test/remote-worker-dds-gates.test.js package.json
git commit -m "test: enforce remote DDS soak gates"

### Task 6: Document deployment, teardown, and local verification

**Files:**
- Create: docs/workers-remote-dds-soak.md
- Modify: README.md
- Test: test/remote-dds-soak-state.test.js

- [ ] **Step 1: Document the safe operator flow**

Document executable non-secret-bearing commands/checklist: generate an unguessable temporary Worker name; generate the hash-bound deployment manifest/build ID from the Wasm artifact; create a dedicated short-lived account-scoped Workers deployment token; generate a 32-byte base64url test key locally; deploy a generated workers.dev Worker with DDS_REMOTE_TEST=true, the build ID, and key as a secret; capture/verify returned version ID and exact generated URL; run smoke, 22,000-case soak, and checker; deploy DDS_REMOTE_TEST=false; make an authenticated 404 close probe; delete through the Workers API; confirm API absence; revoke the token. Add a test rejecting a temporary configuration that declares stepstone.hogetsu.uk, zones, routes, cfut_, CLOUDFLARE_API_TOKEN assignment, or a literal test key.

- [ ] **Step 2: Add secret-hygiene test**

Add a Node test that rejects cfut_ strings, CLOUDFLARE_API_TOKEN assignments, and literal test keys in the operator document.

- [ ] **Step 3: Run verification**

Run: npm test; npm run test:workers; node --test test/remote-dds-soak-state.test.js test/remote-worker-dds-gates.test.js
Expected: PASS. If sandbox permissions prevent Wrangler integration, record that exact limitation, run pure Node tests, and do not claim remote validation passed.

- [ ] **Step 4: Commit**

Commit:
git add docs/workers-remote-dds-soak.md README.md test package.json
git commit -m "docs: add remote DDS soak procedure"
