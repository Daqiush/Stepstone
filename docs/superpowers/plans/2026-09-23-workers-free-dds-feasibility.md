# Workers Free DDS Feasibility Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that a WebAssembly DDS adapter can reproduce Stepstone's two current solver operations and meet the Workers Free Durable Object resource gates before any multiplayer engine is migrated.

**Architecture:** Add a self-contained Workers proof harness under `workers/`. The harness loads a pinned DDS-to-Wasm adapter in a SQLite-backed Durable Object, exposes test-only solve endpoints, and reports timing/memory metrics. Node scripts generate canonical golden fixtures using the current executable wrapper and compare the Worker result set with that baseline; no production route or existing game file changes in this plan.

**Tech Stack:** Node.js 22, Node built-in test runner, Cloudflare Wrangler/Miniflare test runtime, SQLite-backed Durable Objects, WebAssembly, pinned DDS Wasm package or vendored source.

---

## File structure

| Path | Responsibility |
|---|---|
| `package.json` | Add isolated Worker/benchmark/test commands and pinned development dependencies. |
| `workers/wrangler.jsonc` | Test-only Worker configuration, asset rules, Durable Object binding, and SQLite migration. |
| `workers/src/index.mjs` | Minimal fetch router for the test-only harness; no game logic. |
| `workers/src/feasibility-room.mjs` | One Durable Object that lazily initializes the Wasm adapter, validates harness requests, times calls, and returns normalized results. |
| `workers/src/dds-wasm-adapter.mjs` | Platform-neutral adapter exposing `calcDDTable(hands)` and `solveBoard(deal)` in Stepstone's card format. |
| `workers/src/dds-wasm-loader.mjs` | The only file coupled to the selected pinned Wasm DDS package and its initialization API. |
| `workers/src/dds-normalize.mjs` | Pure validation and conversion utilities shared by the adapter and parity tests. |
| `workers/test/fixtures/dds-parity.json` | Checked-in golden full-table and current-position fixtures, including normalized expected candidate-card sets. |
| `workers/test/fixtures/dds-source-manifest.json` | Legal source positions and explicit coverage labels for every bundled problem opening/test-case/branch state. |
| `workers/test/fixtures/dds-invalid.json` | Invalid/malformed cases expected to fail before Wasm invocation. |
| `workers/test/dds-normalize.test.mjs` | Unit tests for card/mask/seat/trump conversion and result normalization. |
| `workers/test/dds-adapter.test.mjs` | Adapter tests against the pinned Wasm module and parity fixture file. |
| `workers/test/feasibility-room.test.mjs` | Miniflare integration tests for Durable Object responses, initialization, errors, and non-mutation behavior. |
| `scripts/generate-dds-parity-fixtures.js` | Explicitly regenerates golden fixtures from the existing executable DDS wrapper. |
| `scripts/benchmark-worker-dds.mjs` | Runs named fixtures plus seeded legal random positions against the deployed test Worker and emits a machine-readable metrics report. |
| `scripts/simulate-worker-room-budget.mjs` | Simulates the approved daily room lifecycle and reports SQLite row read/write units without invoking gameplay code. |
| `scripts/check-worker-dds-gates.mjs` | Reads the report and returns non-zero on a failed parity, bundle, memory, CPU, queue-delay, or SQLite-operation gate. |
| `test/worker-dds-gates.test.js` | Tests the benchmark-report gate checker as a Node CLI unit. |

## Chunk 1: Golden baseline and adapter contract

### Task 1: Freeze the Node DDS baseline into reviewed fixtures

**Files:**
- Create: `workers/test/fixtures/dds-parity.json`
- Create: `workers/test/fixtures/dds-invalid.json`
- Create: `workers/test/fixtures/dds-source-manifest.json`
- Create: `scripts/generate-dds-parity-fixtures.js`
- Modify: `package.json`
- Test: `test/dds-wrapper.test.js`

- [ ] **Step 1: Add the failing fixture-schema test**

Add a Node test that loads `workers/test/fixtures/dds-parity.json` and asserts each fixture has a stable `id`, one of `kind: 'table' | 'solve'`, valid `hands`, and either a 5×4 table or `{ score, cards }`. Assert cards are unique and candidates are sorted by suit order `S,H,D,C`, then rank ascending.

- [ ] **Step 2: Run the schema test to verify it fails**

Run: `node --test test/dds-wrapper.test.js`

Expected: FAIL because the fixture files and loader do not yet exist.

- [ ] **Step 3: Implement a deterministic fixture generator**

Create `scripts/generate-dds-parity-fixtures.js` that imports `calcDDTable` and `solveBoard` from `../dds-wrapper`, reads `dds-source-manifest.json`, calls the current executable wrapper only for legal positions, and writes formatted JSON only when invoked with `--write`. Build synthetic positions with a seeded Fisher–Yates shuffle of the complete 52-card deck, assign the cards round-robin to N/E/S/W, and remove each `trickPlayed` card from its recorded original hand before calling `solveBoard`. This guarantees every remaining-hand and partial-trick position is physically legal. The manifest must include:

```js
const FIXTURE_CASES = [
  { id: 'seed-20260923-table', kind: 'table', source: 'seeded-full-deal', seed: 20260923 },
  { id: 'seed-20260923-partial', kind: 'solve', source: 'seeded-partial-deal', seed: 20260923, trickLeader: 'W', playedCount: 2 },
  // Add every problem opening/test-case/branch label with a complete hand/trick state.
];
```

For every `public/problems/*.json`, the generator must require a manifest entry for its opening position, each `testCases[n]`, and each `testCases[n].deviationBranches[m]`. A branch entry contains `originalHands` (all 52 cards), ordered `completedTricks`, the current `trickPlayed`, and the remaining four hands captured from the current Node engine at that branch pointer; the manifest does not attempt to reinterpret `ANY`, `MAX`, `WIN`, or other dynamic selectors. Validate full provenance by requiring exactly one occurrence of every physical card across `completedTricks`, `trickPlayed`, and remaining hands; validate that every removed card belonged to its recorded original seat, then validate played-card order and current seat before querying DDS. Fail with the missing problem/test-case/branch labels if coverage is incomplete. Normalize generated candidate cards before writing them. Refuse to write when any fixture result contains a duplicate card, an out-of-range score, or a non-legal candidate. Add `npm run fixtures:dds` as `node scripts/generate-dds-parity-fixtures.js --write`.

- [ ] **Step 4: Add invalid-input fixtures**

Create malformed inputs for an invalid suit, rank outside 2–14, duplicate physical card, missing seat, trick longer than three cards, invalid trump, and a player with a card already present in `trickPlayed`. Each entry must state its expected adapter error code: `INVALID_DEAL`. These are adapter validation fixtures, not executable-DDS parity fixtures.

- [ ] **Step 5: Generate and inspect the golden fixture file**

Run: `npm run fixtures:dds`

Expected: a formatted `workers/test/fixtures/dds-parity.json` containing current executable results; the generator exits 0.

- [ ] **Step 6: Extend wrapper tests to consume the fixture schema**

Make `test/dds-wrapper.test.js` read the generated legal parity file and verify the current executable wrapper reproduces every checked-in result. Do not feed `dds-invalid.json` to the current wrapper or require it to expose adapter error codes. Do not overwrite fixtures in test execution.

- [ ] **Step 7: Run baseline tests**

Run: `node --test test/dds-wrapper.test.js`

Expected: PASS, including original parser tests and every golden case.

- [ ] **Step 8: Commit the baseline**

```powershell
git add package.json package-lock.json scripts/generate-dds-parity-fixtures.js workers/test/fixtures test/dds-wrapper.test.js
git commit -m "test: add DDS parity fixtures"
```

### Task 2: Define a runtime-neutral DDS Wasm contract

**Files:**
- Create: `workers/src/dds-normalize.mjs`
- Create: `workers/src/dds-wasm-adapter.mjs`
- Create: `workers/test/dds-normalize.test.mjs`
- Test: `workers/test/dds-adapter.test.mjs`

- [ ] **Step 1: Write failing normalization tests**

Cover the exact existing semantics:

```js
assert.deepEqual(normalizeCards([{ suit: 'S', rank: 'A' }]), [{ suit: 'S', rank: 14 }]);
assert.throws(() => normalizeDeal({ trump: 'X', trickLeader: 'N', trickPlayed: [], hands: {} }), { code: 'INVALID_DEAL' });
assert.equal(currentSeat('S', 3), 'E');
```

Include duplicate-card detection across all remaining hands and current trick, and assert that `normalizeResult` sorts candidates but preserves the DDS score unchanged.

- [ ] **Step 2: Run the normalization test to verify it fails**

Run: `node --test workers/test/dds-normalize.test.mjs`

Expected: FAIL because `dds-normalize.mjs` does not exist.

- [ ] **Step 3: Implement pure conversion and validation functions**

In `dds-normalize.mjs`, export `normalizeHands`, `normalizeDeal`, `currentSeat`, `normalizeTable`, `normalizeSolveResult`, and `DdsInputError`. Use the repository's existing mappings: suits `S,H,D,C`, seats `N,E,S,W`, trumps `S,H,D,C,NT`, and ranks 2–14. Do not import Node modules, access filesystem state, or instantiate Wasm here.

- [ ] **Step 4: Write the failing adapter contract tests**

Inject a fake loader that records calls. Assert the adapter translates a full table request and a partial-trick solve request into the selected library's PBN/mask contract through the loader boundary, returns Stepstone shapes on success, throws `DdsInputError` with `code === 'INVALID_DEAL'` before loader invocation for malformed input, and throws `DdsRuntimeError` with `code === 'DDS_FAILURE'` for a library failure without exposing its raw message.

- [ ] **Step 5: Implement the adapter dependency boundary**

Implement `createWasmDdsClient({ loadModule })` in `dds-wasm-adapter.mjs`:

```js
export function createWasmDdsClient({ loadModule }) {
  let modulePromise;
  const getModule = () => (modulePromise ??= loadModule());
  return {
    async calcDDTable(hands) { /* normalize, call module, normalize result */ },
    async solveBoard(deal) { /* normalize, call module, normalize result */ },
  };
}
```

The adapter must call Wasm only after complete input validation. It returns only Stepstone result shapes on success and throws only the two coded error classes above on failure. It must not retain request-specific state between calls. `feasibility-room.mjs` is solely responsible for catching those errors and serializing the `{ ok:false, error:{ code } }` HTTP response.

- [ ] **Step 6: Run unit tests**

Run: `node --test workers/test/dds-normalize.test.mjs workers/test/dds-adapter.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit the contract**

```powershell
git add workers/src/dds-normalize.mjs workers/src/dds-wasm-adapter.mjs workers/test/dds-normalize.test.mjs workers/test/dds-adapter.test.mjs
git commit -m "feat: define Workers DDS adapter contract"
```

## Chunk 2: Cloudflare runtime proof and gates

### Task 3: Pin and audit the Wasm DDS implementation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `workers/src/dds-wasm-loader.mjs`
- Create: `workers/test/dds-loader.test.mjs`
- Create: `docs/workers-dds-dependency.md`

- [ ] **Step 1: Record the failing loader test**

Add tests that import only `dds-wasm-loader.mjs`, call `loadDdsModule()` twice, assert initialization occurs once, and verify the returned surface has callable full-table and solve operations. The test must fail if the module imports `node:fs`, `node:child_process`, or any Node-only package.

- [ ] **Step 2: Select and pin a single candidate**

Evaluate `bridge-dds-js`/`@bridge-dds` against the contract, exact package version, license, published Wasm assets, worker-safe initialization, and the two required APIs. Add it as an exact version (no caret or tilde) only if it passes the loader test. If it fails any item, vendor the source at an exact commit under `workers/vendor/bridge-dds/` and document its build command, license, and generated `.wasm` checksum; do not substitute a different solver algorithm.

- [ ] **Step 3: Implement the narrow loader**

`dds-wasm-loader.mjs` must contain the selected package import and no business logic. It must expose:

```js
export async function loadDdsModule() {
  // Instantiate the precompiled Wasm module exactly once per DO isolate.
  // Return { calcDDTablePbn, solveBoardPbn } with adapter-owned wrappers.
}
```

Map the candidate's API into exactly these two camel-case functions. Ensure the Wasm binary is packaged as a Worker module/static import rather than fetched at runtime.

- [ ] **Step 4: Document the audit**

In `docs/workers-dds-dependency.md`, record package name/version or vendor commit, license, source URL, asset checksum, supported calls, initialization procedure, and why it is safe in Workers. State any unsupported DDS APIs explicitly.

- [ ] **Step 5: Run loader and adapter tests**

Run: `node --test workers/test/dds-loader.test.mjs workers/test/dds-adapter.test.mjs`

Expected: PASS without any executable DDS process being launched.

- [ ] **Step 6: Commit the dependency boundary**

```powershell
git add package.json package-lock.json workers/src/dds-wasm-loader.mjs workers/test/dds-loader.test.mjs docs/workers-dds-dependency.md workers/vendor
git commit -m "feat: add pinned Workers DDS wasm loader"
```

### Task 4: Run the adapter inside a SQLite Durable Object

**Files:**
- Create: `workers/wrangler.jsonc`
- Create: `workers/src/index.mjs`
- Create: `workers/src/feasibility-room.mjs`
- Create: `workers/test/feasibility-room.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing Durable Object integration tests**

Using Wrangler's Workers test runtime, create a test DO namespace and call these internal harness endpoints:

```text
POST /__dds/table       { "hands": ... }
POST /__dds/solve       { "deal": ... }
POST /__dds/metrics     {}
POST /__dds/ping        {}
```

Assert a valid solve response is `{ ok: true, result: { score, cards }, metrics: { initMs, solveMs, heapBytes? } }`; malformed input is `{ ok:false, error:{ code:'INVALID_DEAL' } }`; a Wasm failure is `{ ok:false, error:{ code:'DDS_FAILURE' } }`. After a forced failure, issue a valid request and assert it still succeeds with no prior result leaked.

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `npm run test:workers`

Expected: FAIL because no Wrangler configuration or Worker module exists.

- [ ] **Step 3: Configure a test-only Worker and SQLite DO**

Create `workers/wrangler.jsonc` with an ES-module entry point, a `DDS_FEASIBILITY_ROOM` durable-object binding, and a `new_sqlite_classes` migration. Add `npm run test:workers` and `npm run dev:workers` commands. Do not configure `stepstone.hogetsu.uk`, a public route, or production secrets in this plan.

- [ ] **Step 4: Implement the fetch router and room object**

`index.mjs` must accept only the four `/__dds/*` routes in local test mode, obtain one fixed feasibility DO ID, and forward the request. `feasibility-room.mjs` must initialize the adapter in `blockConcurrencyWhile`, measure with `performance.now()`, return `ping` only after queued work ahead of it completes, retain counters only for the active test process, and compute/validate results before it writes any metric record. It must never import `server.js`, Socket.IO, Express, or Node built-ins.

- [ ] **Step 5: Run Worker integration tests**

Run: `npm run test:workers`

Expected: PASS; both APIs run in the Durable Object and malformed requests never reach Wasm.

- [ ] **Step 6: Commit the runtime harness**

```powershell
git add workers/wrangler.jsonc workers/src/index.mjs workers/src/feasibility-room.mjs workers/test/feasibility-room.test.mjs package.json package-lock.json
git commit -m "test: run DDS wasm in a Durable Object"
```

### Task 5: Compare, benchmark, and enforce release gates

**Files:**
- Create: `scripts/benchmark-worker-dds.mjs`
- Create: `scripts/simulate-worker-room-budget.mjs`
- Create: `scripts/check-worker-dds-gates.mjs`
- Create: `workers/test/results/.gitkeep`
- Create: `test/worker-dds-gates.test.js`
- Modify: `package.json`
- Test: `workers/test/feasibility-room.test.mjs`

- [ ] **Step 1: Write failing gate tests**

Create `test/worker-dds-gates.test.js` with a tiny synthetic metrics JSON fixture that exceeds each boundary one at a time. Assert the checker exits non-zero and names the failed gate. Test a passing report with: zero parity mismatches, Wasm bundle below the configured Worker limit, maximum memory below 96 MB, p99 solve CPU below 1,000 ms, maximum solve CPU below 10,000 ms, maximum queued-command delay below 10,000 ms, row writes at or below 70,000/day, and row reads at or below 250,000/day.

- [ ] **Step 2: Run the gate test to verify it fails**

Run: `node --test test/worker-dds-gates.test.js`

Expected: FAIL because the benchmark and gate checker do not exist.

- [ ] **Step 3: Implement the deterministic benchmark**

Create `scripts/benchmark-worker-dds.mjs` with `--seed`, `--iterations`, `--url`, and `--out` arguments. It must run all checked-in golden fixtures plus 100,000 seeded legal random full/partial positions. For every case it calls the current executable `calcDDTable` or `solveBoard` locally and the Worker harness remotely, then compares tables exactly and compares solve scores plus the complete normalized candidate-card set exactly. It writes JSON including the Node baseline result, Worker result, bundle bytes, initialization ms, per-operation durations, max memory when supplied by runtime, queue-delay samples, and mismatch details. A benchmark run must fail on the first malformed response but continue collecting parity mismatches for a final report.

Add `/__dds/ping` to the Task 4 router and room tests. For every timed solve, the benchmark sends `POST /__dds/solve` and immediately sends `POST /__dds/ping` to the same fixed DO ID. Record the ping's completion time minus its send time as queue delay. This directly measures how long the single-threaded solver blocks unrelated room work.

- [ ] **Step 4: Implement the gate checker**

`scripts/simulate-worker-room-budget.mjs` must model 50 rooms/day with one allocation, one owner-session creation plus four join-session inserts, 1,000 state-row updates, four token rotations, one scheduled-action insert/delete pair, one expiry, one registry-release retry, and one reuse/tombstone cycle per room. It must read `--report workers/test/results/dds-feasibility.json`, append counted SQL row reads/writes to that same JSON report, and fail when the report is missing. `scripts/check-worker-dds-gates.mjs` must read that complete report, compute p99 from sorted samples, print each named gate, and exit 1 if any required metric is absent or violates the exact thresholds from the approved design. It must exit 0 only when every gate passes.

- [ ] **Step 5: Add reproducible commands**

Add:

```json
{
  "benchmark:workers-dds": "node scripts/benchmark-worker-dds.mjs --seed 20260923 --iterations 100000 --url http://127.0.0.1:8787 --out workers/test/results/dds-feasibility.json",
  "simulate:workers-budget": "node scripts/simulate-worker-room-budget.mjs --rooms 50 --report workers/test/results/dds-feasibility.json",
  "check:workers-dds": "node scripts/check-worker-dds-gates.mjs workers/test/results/dds-feasibility.json"
}
```

- [ ] **Step 6: Execute the local proof**

Run in separate terminals:

```powershell
npm run dev:workers
npm run benchmark:workers-dds
npm run simulate:workers-budget
npm run check:workers-dds
```

Expected: a saved report and exit 0 only if all approved parity, CPU, memory, queue-delay, and free-tier budget gates pass. If any gate fails, do not begin Plan B; commit the report and document the failed gate.

- [ ] **Step 7: Run the full regression suite**

Run: `npm test; npm run test:server:smoke; npm run test:workers`

Expected: PASS. Existing Node behavior remains unchanged because this plan adds an isolated proof harness.

- [ ] **Step 8: Commit the feasibility result**

```powershell
git add scripts/benchmark-worker-dds.mjs scripts/simulate-worker-room-budget.mjs scripts/check-worker-dds-gates.mjs test/worker-dds-gates.test.js workers/test package.json package-lock.json docs/workers-dds-dependency.md
git commit -m "test: enforce Workers DDS feasibility gates"
```

## Execution stop condition

Do not start the room/lifecycle migration (Plan B) unless `npm run check:workers-dds` passes with a saved report. A failed gate is a valid result: preserve the harness and report, then return to architecture selection instead of weakening game authority or silently falling back to heuristic defense.
