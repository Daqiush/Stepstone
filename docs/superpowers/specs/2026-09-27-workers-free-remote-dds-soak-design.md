# Workers Free Remote DDS Soak Design

## Purpose

Replace the infeasible one-shot 100,000-position remote benchmark with a reproducible, quota-bounded remote Durable Object soak test. This remains a Plan A feasibility gate. It does not migrate any Stepstone game engine, public UI, WebSocket transport, DNS route, or domain.

## Background

The local Miniflare/ProxyWorker harness completed all checked correctness checks, but under sustained load it lost the network connection after 4,380 direct solves and, in an ordered-pair workload, after 19,163 and 21,301 positions. Retrying the exact position succeeded. A real deployed Worker passed the initial 28 fixed fixtures plus 10 seeded positions with zero score/table mismatches. The next test must distinguish local harness lifecycle failure from a real Cloudflare Durable Object failure without consuming the daily Free allocation.

## Chosen design

Run 22,000 seeded random positions in eleven resumable shards of 2,000 positions, after the checked-in fixture corpus. This count deliberately exceeds every observed local failure point, including 21,301, while bounding the test to a planned request budget below the Workers Free daily allocation.

The runner calculates the Node executable DDS result locally for every position and compares it to a temporary remote Worker result. It uses the existing tie-aware comparison: exact tables and solve scores are hard requirements; an equally scored but differently enumerated candidate set is diagnostic only, provided every returned card is canonical, unique, owned by the current seat, and follows suit.

## Temporary test endpoint

The remote harness must never rely on an obscure `workers.dev` name as authorization. Its test routes require both of the following:

1. A temporary `DDS_REMOTE_TEST` environment flag set to the literal string `true`.
2. An `X-DDS-Test-Key` request header that matches a Worker secret using constant-time comparison.

Routes remain unavailable when either condition is absent and return a non-informative 404. The entry Worker permits only `POST` and rejects a body larger than 32 KiB before Durable Object dispatch. The key is a fresh 32-byte CSPRNG value encoded as base64url; comparison uses equal-length bytewise XOR rather than a normal string equality operation. The header is not written to reports, logs, source files, configuration files, or commits.

Every run uses a dedicated expiry-bounded Cloudflare API token scoped to only the selected account and Workers deployment capability required to create the temporary Worker; it receives no zone, DNS, route, KV, R2, Tunnel, or account-administration access. The Worker is deployed only to its generated `workers.dev` address, never to `stepstone.hogetsu.uk`. Teardown is a required sequence: deploy a version with the test flag disabled, send a test request bearing the still-valid test key and verify it receives a non-informative 404, delete the Worker through the Workers API, confirm the script is absent through the API, then revoke the deployment token.

## Workload

### Correctness corpus

- Run every checked-in source-provenance fixture first.
- Generate 22,000 legal seeded random positions from the fixed seed stream.
- Run a full-hand table calculation once per 100 random positions; remaining positions are solves.
- Balance solve positions over all 13 completed-trick depths, with the report recording each count.
- Preserve the original input, local result, remote result, candidate diagnostic, timing, and heap metric per completed operation.

### Stateful and cold-start coverage

Each shard runs its operations against one named Durable Object so the normal path is a long, serialized same-object soak. The runner also selects a fresh object identity at each shard boundary and records the cold-start initialization metric. The object includes a randomly generated, response-visible activation ID; the runner records it on every operation. A changed activation ID inside a shard is an unexpected reset and fails the run. A new activation ID at a documented shard boundary is expected cold-start coverage. This tests both long-lived state and object activation without requiring undocumented eviction control.

### Queue coverage

For every solve, use the existing ordered probe: the entry Worker enqueues a solve and then a distinct ping on the same Durable Object queue. The report records the ping completion delay, so a solve that blocks unrelated room work is measurable. The route must not create a nested Durable Object deadlock.

## Quota circuit breaker

Worker inbound requests and Durable Object requests are tracked separately; they are not added into one fictional shared counter. For the planned mix, 22,000 random cases produce 220 tables and 21,780 solves. Every table uses one Worker request and one Durable Object command. Every solve uses one Worker request and two queued Durable Object commands via the ordered probe. Before fixtures, cold-start probes, or other bounded overhead, that is 22,000 inbound Worker requests and 43,780 Durable Object commands.

The runner has separate hard ceilings of 25,000 inbound Worker requests and 50,000 Durable Object commands. It calculates the exact projected amount before each shard from the persisted cursor and refuses to start if either ceiling would be exceeded. Fixture, metric, cold-start, and idempotency probes have explicit declared costs in that projection. A failed request ends the run; it does not consume a new-case retry allowance or silently advance the cursor. These ceilings leave margin below each documented 100,000-per-day Free allocation.

The report states the exact operation-to-request accounting model, planned counts, observed counts, and the dashboard-observed account usage when the operator supplies it. The dashboard remains authoritative for billing and platform accounting.

## Gates

The remote soak passes only if all are true:

- all fixtures and exactly 22,000 random positions complete, using `xorshift32` with seed `20260923`, the checked-in `worker-dds-random-cases.mjs` algorithm hash, and the checked-in fixture-corpus SHA-256 recorded in the report;
- no HTTP/network/protocol error or unexpected Durable Object reset occurs;
- table and solve-score parity mismatches are zero;
- every candidate diagnostic reconciles to a valid operation record;
- all thirteen solve depths have recorded coverage;
- the Wasm bundle remains below 3 MiB;
- maximum measured Wasm heap is below 96 MiB; heap is sampled after every operation as the `HEAPU8.buffer.byteLength` exposed by the pinned Emscripten module;
- p99 Wasm-call elapsed time is below one second and maximum Wasm-call elapsed time is below ten seconds; each is `performance.now()` immediately after the adapter returns minus immediately before it is called, in milliseconds without integer rounding, with p99 defined as the nearest-rank sample at `ceil(n * 0.99)` after ascending sort; this is an application wall-time proxy, not a claim of Cloudflare per-invocation CPU telemetry;
- maximum ordered-ping queue delay is below ten seconds;
- simulated 50-room/day SQLite read/write budget, produced by the pinned simulator source hash, is at most 70,000 writes and 250,000 reads; and
- observed inbound Worker requests are at most 25,000 and observed Durable Object commands are at most 50,000.

Candidate card order or an equally optimal candidate-set difference alone is not a failure.

## Execution and recovery

Before every dispatch, the runner atomically writes a local `pending` intent record containing a run ID, monotonic operation ID, random-case index, request hash, object identity, and all reproducibility hashes. It sends that same operation ID to the Durable Object. The object uses a SQLite `test_operations(run_id, operation_id PRIMARY KEY, request_hash, status, response_json)` record: it returns a stored successful response for an identical replay, rejects a mismatched request hash, and commits the final response before returning it. Thus, if the network fails after the object completes but before the client writes its result, resume replays the same operation ID and receives the identical persisted response rather than executing an unknown prefix again.

Every successful response atomically transitions its local intent to a completed append-only journal record. On startup, the runner validates contiguous completed IDs and resolves a final pending intent only by replaying its same ID; it may advance only after the replayed response hash matches the persisted remote result. A remote or protocol failure that cannot be resolved becomes one terminal `failed` record attached to the pending operation and ends the run; the completed cursor remains at the previous successful ID. A human may explicitly start a new run, but an interrupted run never skips, substitutes, or silently re-executes an unknown operation.

The idempotency table contributes at most one row read and one row write per external operation. Its 22,000-read/22,000-write maximum is included separately in the report's test-storage budget, with hard ceilings of 25,000 row reads and 25,000 row writes. The existing 50-room simulator remains an independent product-load gate; its explicit 70,000-write and 250,000-read targets are reported alongside, rather than being conflated with this temporary benchmark's storage use.

The expected remote wall-clock time is approximately five to seven hours based on the initial smoke run. The developer computer is required only while generating native executable DDS comparison values; no deployed player service depends on it.

## Interpretation

Passing the remote soak establishes a strong Plan A DDS-runtime feasibility result and permits planning the transport and room-lifecycle foundation. It does not claim that the later game migration is complete. A parity, legality, resource, queue, budget, or remote-runtime failure rejects Workers Free for the authoritative DDS game backend; the project must then choose a conventional server or change deployment architecture rather than weaken bridge logic.
