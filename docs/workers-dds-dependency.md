# Workers DDS dependency

The Worker bundle uses a vendored ESM build of double-dummy solver (DDS).
`workers/vendor/bridge-dds/dds-worker.mjs` retains the original embedded Wasm
bytes for the plain Node test path. Workers cannot compile those bytes at
runtime, so `workers/vendor/bridge-dds/dds-worker.wasm` is also imported as a
static, precompiled module by the feasibility Durable Object. The loader passes
that module to the generated Emscripten glue. There is no runtime network fetch
or Node API in the Worker path.

## Exact source and license

- [bridge-dds-js](https://github.com/bookchris/bridge-dds-js/tree/23c72429f5cb382d0f8805ea1ac44658c1116006),
  commit `23c72429f5cb382d0f8805ea1ac44658c1116006`, Apache-2.0.
  The vendored [license](../workers/vendor/bridge-dds/LICENSE.bridge-dds)
  corresponds to the upstream [LICENSE](https://github.com/bookchris/bridge-dds-js/blob/23c72429f5cb382d0f8805ea1ac44658c1116006/LICENSE).
- [DDS](https://github.com/ed2k/dds/tree/8fdbe384fb4ee3eb837aa726578e1730494251fe),
  submodule commit `8fdbe384fb4ee3eb837aa726578e1730494251fe`,
  Apache-2.0. The vendored [license](../workers/vendor/bridge-dds/LICENSE.dds)
  corresponds to the submodule [LICENSE](https://github.com/ed2k/dds/blob/8fdbe384fb4ee3eb837aa726578e1730494251fe/LICENSE).
- [emsdk](https://github.com/emscripten-core/emsdk/tree/3d6d8ee910466516a53e665b86458faa81dae9ba)
  commit `3d6d8ee910466516a53e665b86458faa81dae9ba` installs Emscripten
  `3.1.74`, release commit `c2655005234810c7c42e02a18e4696554abe0352`.

The pinned single-file ESM output before Worker adaptation is 455,349 bytes
with SHA-256
`875c4ed0ab297192e92dfbb19ee25c889f77eacafa8c490504958f69492519af`.
The Worker-adapted vendored ESM file is 455,375 bytes with SHA-256
`da11523782524ae2b4274e1123794f0a50e47403924dbb90b0ddde9bb723ac1d`.
The loader test reverses only the two Worker adaptations and checks the
original pinned hash. The separate Wasm module exactly matches the decoded
embedded bytes: 323,370 bytes with SHA-256
`ddc660d975c5abd08ec8490a9456dd68d202579c540e9353078b6bdecaddf5f7`.
`workers/vendor/bridge-dds/.gitattributes` sets `-text` for the generated
artifacts so Git does not convert them on any platform.

## Rebuild

From the repository root in PowerShell, choose a new, empty work directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File workers/vendor/bridge-dds/build.ps1 -WorkDirectory D:\dds-worker-rebuild
```

The [build script](../workers/vendor/bridge-dds/build.ps1) clones and checks out
both pinned sources, installs the pinned toolchain into that work directory,
compiles the upstream `dds/src/Makefiles/sources.txt` source set, patches one
Emscripten-generated error handler, extracts the exact Wasm bytes, makes two
small Worker glue adaptations, and checks all resulting SHA-256 values. The
unpatched output has SHA-256
`ec0a2b8bc5713996907d9afd8e8863b26ecee677f18b482ecd723922084db27c`.
The only change replaces `error=>{console.error(error)}` with
`error=>{readyPromiseReject(error)}`. Emscripten 3.1.74's generated minimal
runtime otherwise leaves the module's ready promise pending when
`WebAssembly.instantiate` rejects. The embedded Wasm bytes are unchanged. The
two Worker adaptations let a supplied `WebAssembly.Module` take precedence over
decoded bytes and accept either the `WebAssembly.Instance` result of
`instantiate(module, imports)` or the `{ instance }` result of
`instantiate(bytes, imports)`. The script does not activate a global toolchain.
Its full compiler flags are:

```text
-D__WASM__ -O3 -std=c++11
-sEXPORTED_FUNCTIONS=["_malloc","_free","_SetMaxThreads","_AnalysePlayPBN","_CalcDDtablePBN","_SolveBoardPBN","_DealerPar"]
-sEXPORTED_RUNTIME_METHODS=["cwrap","ccall","getValue","setValue","stringToUTF8","UTF8ToString","HEAPU8"]
-sMODULARIZE=1 -sSINGLE_FILE=1 -sEXPORT_ES6=1 -sNO_EXIT_RUNTIME=1
-sALLOW_MEMORY_GROWTH=1 -sASSERTIONS=1 -sSTACK_OVERFLOW_CHECK=1
-sENVIRONMENT=worker -sMINIMAL_RUNTIME=1 -sEXPORT_KEEPALIVE=1 -sFILESYSTEM=0
```

The Worker path imports the `.wasm` file statically and passes the precompiled
module to `loadDdsModule()`. Its sole Wasm instantiation uses that module.
The loader test also runs the no-argument `loadDdsModule()` path in plain Node
ESM with network APIs set to throw. Node is only the test host and contributes
no runtime dependency to the generated file.

## Adapter mapping

`loadDdsModule()` memoizes one successful initialization per module instance,
clears a rejected initialization so a later call can retry, and returns exactly
`calcDDTablePbn` and `solveBoardPbn`. The adapter's PBN hand
format has a label for each seat; DDS PBN expects one leading seat label and
four clockwise hands. The loader converts this syntax at the ABI boundary.

`calcDDTablePbn` writes the 80-byte `ddTableDealPBN`, invokes
`CalcDDtablePBN`, and maps `resTable[strain][seat]` to the adapter's
`{ N/E/S/W: { S/H/D/C/NT: tricks } }` object. `solveBoardPbn` writes the
112-byte `dealPBN` with `trump`, first seat, up to three current-trick cards,
and remaining PBN hands. It calls `SolveBoardPBN` with target `-1`, solutions
`2`, and mode `1` for all optimal cards and a computed score, even when only
one card is legal. The returned `futureTricks.score` is for the current
player's partnership and includes the current trick. `equals` rank bits are
expanded into explicit equivalent cards before returning `{ score, cards }`.
The loader rejects any DDS candidate whose reported score differs from the
root score. The adapter checks every expanded card against the current
player's remaining hand and follow-suit obligation, rejects duplicates, and
sorts the result into canonical suit/rank order.
Both calls free their Wasm buffers, and non-success DDS codes throw.

Only these two DDS methods are exposed. Dealer par, play analysis, alternate
target/solution modes, multithreaded DDS, and non-PBN APIs are unsupported.
The caller must provide legal, complete bridge positions; the outer adapter
normalizes input card shapes but does not prove all game-state invariants.

## Feasibility comparison and memory

The benchmark requires exact equality for every full double-dummy table and
for each solve's optimal trick score. Different sets of equally optimal cards
are recorded as `candidateDifferences` with both sorted sets, separate from
`parityMismatches`. Worker candidates are still checked for canonical order,
uniqueness, ownership, and follow-suit legality before comparison. The loader
checks each DDS candidate's score against the root solve score. A malformed
response stops the benchmark immediately; a score or table mismatch remains a
parity failure. The gate reconstructs every candidate difference from its
recorded operation and requires the diagnostic's ID, kind, score, and both
canonical card sets to match exactly; missing, extra, or duplicate diagnostics
fail the evidence gate. The feasibility gate additionally requires 100,000 completed
random cases, all fixtures, and resource metrics, so a short run can show
observed parity without passing the overall gate.

The queue-delay sample comes from the local-only `/__dds/ordered-probe` route.
It parses one solve deal, then synchronously enqueues two distinct commands on
the same Durable Object queue: the solve followed by an unrelated ping. The
outer probe request stays off that queue to avoid deadlock. The Worker records
elapsed time at solve completion and again when the ping completes; queue delay
is the latter elapsed time. The benchmark checks that ping observed exactly one
new completed DDS operation and that its timestamp is no earlier than solve
completion. A malformed pair, timeout, or counter overtake fails the run. This
protocol is only enabled in `DDS_LOCAL_TEST` and is scoped to the local Worker
URL accepted by the benchmark CLI. The solve's `workerMs` in new reports is
the Worker's elapsed time to complete the queued solve, whereas older reports
measured the separate HTTP solve response. The previous full report remains
an unaltered historical failure from independent-request ordering.

Emscripten 3.1.74's `runtime_shared.js` supports exporting `HEAPU8` through
`EXPORTED_RUNTIME_METHODS`. Its `updateMemoryViews()` replaces the exported
typed array whenever Wasm linear memory grows. The loader reads
`module.HEAPU8.buffer.byteLength` for each metric sample after initialization
and each solve/table operation. This is the current Wasm linear-memory byte
length, not JavaScript process memory or a configured estimate. The build uses
`ALLOW_MEMORY_GROWTH=1`, so this value can increase. The benchmark records
each operation's `heapBytes`; `maxMemoryBytes` is the maximum observed sample,
not a continuously monitored peak. Historical reports captured before this
export retain missing memory metrics and must not be backfilled.
When operation records are present, the memory gate requires a positive integer
`heapBytes` on every record and exact agreement between their observed maximum
and `maxMemoryBytes`. A missing or understated sample fails the memory gate.

`workers/test/results/dds-feasibility-memory-small.json` is a new local Worker
run over all 28 fixtures and 26 seeded random cases. Every solve depth 0–12
is represented. All 54 operations recorded `heapBytes: 18939904`, yielding
`maxMemoryBytes: 18939904` (about 18.1 MiB). Its memory gate passes; the
benchmark-completeness gate remains failed because the required 100,000 random
cases have not been rerun. The older `dds-feasibility.json` remains an
unaltered historical partial report with `maxMemoryBytes: null`.

## Running the hosted remote soak

`Remote DDS Soak` is a manually dispatched GitHub Actions workflow. Before
dispatching it, configure these repository GitHub Secrets (names only):

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Use a temporary, appropriately scoped Cloudflare token. Never paste either
value into this document, a workflow input, an issue, an artifact, or a log.
In the Actions page, select **Remote DDS Soak**, choose **Run workflow**, and
enter a unique, recognizable `request_id` so the run can be found later. The
hosted runners own the run after dispatch, so the operator's computer may
disconnect without interrupting it.

Do not cancel a normally progressing run. It has one preparation job followed
by six serial segment job slots. Each segment accepts at most 6,000 new
operations, uses a 17,100,000 ms soft deadline, and has a 355-minute job
timeout. Together the segments target 22,000 completed operations; later
segments resume the state published by the preceding segment. The six slots
provide deadline headroom; they do not raise the 22,000-operation target.

This workflow is only a temporary DDS feasibility test. It does not deploy or
modify `stepstone.hogetsu.uk`, DNS, any production Worker, or any other
production resource. It creates only the uniquely generated, deterministically
run-attested temporary Worker whose name begins `ss-dds-soak-`.

### Evidence and cleanup

Keep the temporary Cloudflare credentials valid until every relevant primary
attempt has final machine-readable proof that its exact temporary resource is
absent. A relevant attempt is any primary attempt that produced identity or
deployment evidence. The primary workflow is configured to attempt its
`cleanup` job even after an earlier job fails, and the separate **Remote DDS
Soak Cleanup Backstop** workflow is triggered by `workflow_run`. Do not revoke
the token merely because the soak or primary cleanup job is red. An unproved
attempt must retain its evidence and be investigated while the credentials are
still usable.

Download the following artifacts before their 30-day retention expires and
retain them together as the acceptance record:

- `remote-dds-final-evidence-<primary-run-id>-<primary-attempt>`
- `remote-dds-primary-cleanup-<primary-run-id>-<primary-attempt>`
- `remote-dds-backstop-cleanup-<primary-run-id>-<primary-attempt>-<backstop-run-attempt>`

The last suffix is the attempt number of the backstop workflow itself. It makes
each backstop rerun publish a distinct artifact. Find it from the backstop run
whose title is `Cleanup primary <primary-run-id> attempt <primary-attempt>`,
then select the artifact with that backstop run's current attempt suffix. The
`remote-dds-identity-*`, `remote-dds-deployment-*`, and `remote-dds-state-*`
intermediate artifacts are retained for 7 days, so preserve them too when
diagnosing a failed or interrupted run.

### Soak acceptance

Accept the test workload only when both of the following are true for the same
primary run ID and attempt:

- `final-evidence/state-6/run/report.json` has `completedCursor` equal to
  `22000` and `terminalFailure` equal to `null`.
- `final-evidence/gate/gate-result.json` contains a non-empty `gates` array and
  every gate has `passed` equal to `true`.

These checks accept the soak evidence; they do not prove resource cleanup. A
primary cleanup failure can leave the GitHub workflow run red, in which case
the workflow run itself is not accepted even when its report and gates pass.
Later backstop cleanup can prove that the resource is absent, but it does not
rewrite the immutable primary cleanup artifact or turn the primary run green.

### Cleanup proof and token revocation

For each relevant primary attempt, require at least one trustworthy
`cleanup-result.json` whose repository, workflow, `runId`, `runAttempt`, and
`commitSha` match that exact attempt and whose `currentAbsent` and
`legacyAbsent` fields are both `true`. That final absence proof may come from
either the primary cleanup artifact or the `workflow_run` backstop artifact; it
does not require both to report success. If primary cleanup fails but the
matching backstop later supplies this proof, the attempt's temporary resource
is clean even though the primary result remains unchanged.

A primary cleanup can deliberately remain red when deployment evidence from a
prior attempt exists. A green cleanup result for the current attempt does not
prove that an older attempt was cleaned. Evaluate the final primary or backstop
absence proof separately for every relevant attempt, matching its full context
rather than inferring cleanup from any run's overall color.

If any relevant attempt lacks final absence proof, retain all evidence and
recover only the exact temporary Worker authorized by that attempt's attested
identity/deployment records. Never delete Workers by the `ss-dds-soak-` prefix
or by any other bulk-name match. This document does not prescribe a manual
deletion command; use the attested cleanup workflow and its machine-readable
result. Once every relevant attempt has final proof of `currentAbsent: true`
and `legacyAbsent: true`, revoke the temporary Cloudflare token immediately.
