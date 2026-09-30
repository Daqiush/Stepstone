# GitHub Remote DDS Soak Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing 22,000-operation remote DDS feasibility soak on GitHub-hosted runners in resumable segments of at most 6,000 operations, with cancellation-safe exact cleanup of the temporary Cloudflare Worker.

**Architecture:** Extend the soak runner with explicit bounded-segment dispositions, then add small CI identity/state and Cloudflare cleanup modules around the existing deployment manifest. A manual-only primary workflow passes immutable state artifacts through six ordered jobs; an independent `workflow_run` workflow uses trusted default-branch cleanup code and a pre-deployment ownership record as the cancellation backstop.

**Tech Stack:** Node.js 20, Node test runner, GitHub Actions, Wrangler 4.137.0, Cloudflare Workers API, Windows GitHub-hosted runners.

---

## File map

| File | Responsibility |
| --- | --- |
| `scripts/remote-worker-dds-soak.mjs` | Execute one new or resumed soak segment and emit `PAUSED`, `COMPLETE`, or `FAILED`. |
| `scripts/remote-dds-ci-identity.mjs` | Derive and validate workflow identity, Worker name, ownership tag, deployment record, and state-envelope hashes. |
| `scripts/remote-dds-ci-state.mjs` | CLI for creating `state-0`, validating predecessor state, and finalizing successor state. |
| `scripts/cloudflare-temporary-worker-api.mjs` | Strict paginated read, ownership inspection, subdomain disable, exact deletion, and absence verification APIs. |
| `scripts/prepare-remote-dds-deployment.mjs` | Collision-check, deploy, tag, verify, and describe one exact temporary Worker. |
| `scripts/cleanup-remote-dds-deployment.mjs` | Validate ownership before mutation, disable workers.dev, delete the exact service, and prove absence. |
| `.github/workflows/remote-dds-soak.yml` | Manual preparation, six ordered segments, gate, evidence, and primary cleanup. |
| `.github/workflows/remote-dds-soak-cleanup.yml` | Default-branch `workflow_run` cleanup backstop. |
| `test/remote-worker-dds-soak.test.js` | Runner bounds and disposition tests. |
| `test/remote-dds-ci-identity.test.js` | CI identity and artifact-schema tests. |
| `test/remote-dds-ci-state.test.js` | `state-0` and state-lineage tests. |
| `test/remote-dds-deployment-runner.test.js` | Collision, ownership tag, and deployment-manifest tests. |
| `test/remote-dds-cleanup.test.js` | Mutation ordering, idempotency, and refusal tests. |
| `test/remote-dds-workflow-contract.test.js` | Static workflow security and orchestration contract tests. |

## Chunk 1: Bounded, resumable runner

### Task 1: Define bounded segment options and dispositions

**Files:**
- Modify: `scripts/remote-worker-dds-soak.mjs:106-112`
- Modify: `test/remote-dds-deployment-runner.test.js:272-281`
- Modify: `test/remote-worker-dds-soak.test.js`

- [ ] **Step 1: Write failing option-validation tests**

Add cases requiring positive safe integers for `--max-new-operations` and `--deadline-ms`, rejecting zero, negative, fractional, missing, duplicate, and greater-than-22,000 operation limits. Assert the default remains the existing unbounded 22,000-operation behavior when both options are omitted.

```js
const bounded = mod.parseOptions([
  '--url', 'https://a.workers.dev',
  '--max-new-operations', '6000',
  '--deadline-ms', '17100000',
], { DDS_REMOTE_TEST_KEY: 'secret-value' });
assert.equal(bounded.maxNewOperations, 6000);
assert.equal(bounded.deadlineMs, 17_100_000);
```

- [ ] **Step 2: Run the focused tests and observe the expected failure**

Run: `node --test test/remote-dds-deployment-runner.test.js test/remote-worker-dds-soak.test.js`

Expected: FAIL because `parseOptions` does not expose or validate the two bounded-segment options.

- [ ] **Step 3: Add minimal parsing and a pure stop-decision helper**

Export `segmentStopReason({ completedAtStart, completedNow, maxNewOperations, startedAtMs, nowMs, deadlineMs, totalOperations })`. It returns `COMPLETE`, `MAX_NEW_OPERATIONS`, `DEADLINE`, or `null`. Completion takes precedence over both pause reasons.

- [ ] **Step 4: Add pure helper tests for exact boundaries**

Cover exactly 6,000 new operations, one below the limit, exactly 17,100,000 elapsed milliseconds, already-complete input, and completion reached on the same operation as a deadline.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/remote-dds-deployment-runner.test.js test/remote-worker-dds-soak.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/remote-worker-dds-soak.mjs test/remote-dds-deployment-runner.test.js test/remote-worker-dds-soak.test.js
git commit -m "feat: define bounded remote soak segments"
```

### Task 2: Bound native DDS subprocesses for CI

**Files:**
- Modify: `scripts/remote-worker-dds-soak.mjs:13-15,181-192`
- Modify: `test/remote-worker-dds-soak.test.js`

- [ ] **Step 1: Write a failing native-timeout injection test**

Export `createNativeBaseline({ timeoutMs = 180000, runProcess, paths, existsSync })`. Use a fake `runProcess` that records the timeout option, return legal table/solve output, and assert both baseline operations pass `{ timeoutMs: 180000 }` to `runDdsProcess` through a dedicated `createDdsClient`.

- [ ] **Step 2: Run the focused test and observe failure**

Run: `node --test test/remote-worker-dds-soak.test.js`

Expected: FAIL because the remote runner currently imports the unbounded default DDS client.

- [ ] **Step 3: Build the dedicated bounded native client**

Use existing `createDdsClient`, `resolveDdsPaths`, and `runDdsProcess`; do not change the server's default DDS client. Route fixture checks, replay recovery, and seeded baselines through this one bounded client.

- [ ] **Step 4: Run runner and DDS process tests**

Run: `node --test test/remote-worker-dds-soak.test.js test/dds-process.test.js test/dds-wrapper.test.js`

Expected: PASS with the application server behavior unchanged.

- [ ] **Step 5: Commit**

```bash
git add scripts/remote-worker-dds-soak.mjs test/remote-worker-dds-soak.test.js
git commit -m "feat: bound CI native DDS operations"
```

### Task 3: Implement safe segment pause and completion output

**Files:**
- Modify: `scripts/remote-worker-dds-soak.mjs:205-305`
- Modify: `test/remote-worker-dds-soak.test.js`

- [ ] **Step 1: Write failing segment-loop tests using injected operations**

Refactor the CLI body into exported `runRemoteSoak(options, dependencies)` so tests can supply a short operation list, clock, remote dispatch, baseline, and state factory. Assert:

- a segment stops before starting operation 6,001 and returns `{ disposition: 'PAUSED', reason: 'MAX_NEW_OPERATIONS' }`;
- deadline pause is checked before the next intent is recorded;
- a response already received is durably completed even when the deadline expires during that operation;
- a recovered pending intent is replayed and durably completed before an already-expired deadline is allowed to pause the segment;
- the recovered pending completion does not consume one of the 6,000 newly completed operation slots;
- cursor 22,000 returns `COMPLETE` and performs final ledger reconciliation;
- failures during preflight, fixtures, pending replay, seeded parity/transport/protocol/activation checks, and final accounting reconciliation all reject instead of returning `PAUSED`;
- resume of an already complete run makes no remote call and returns `COMPLETE`.

- [ ] **Step 2: Run the focused test and observe failure**

Run: `node --test test/remote-worker-dds-soak.test.js`

Expected: FAIL because the runner has no injectable bounded loop or disposition output.

- [ ] **Step 3: Write failing disposition-persistence tests**

In a temporary run directory, assert atomic `segment-result.json` contents and invariants for `PAUSED`, `COMPLETE`, and `FAILED`. The only failure reasons are `INITIALIZATION_FAILED`, `PREFLIGHT_FAILED`, `FIXTURE_FAILED`, `PENDING_REPLAY_FAILED`, `SEEDED_OPERATION_FAILED`, and `FINAL_ACCOUNTING_FAILED`; pause reasons remain `MAX_NEW_OPERATIONS` and `DEADLINE`, while successful completion uses `reason: null`. Require the exact stage-to-reason mapping, completed cursor/count, timestamps, and nonzero rejection. Assert the file never contains endpoint keys, request keys, token fragments, raw exception stacks, or response bodies.

- [ ] **Step 4: Implement the bounded loop and atomic disposition output**

Replay and durably finish any recovered pending intent before starting deadline or new-operation accounting. Then initialize a dedicated `completedThisSegment = 0`; increment it only after a new seeded operation reaches `recordCompletion`. Use an injected monotonic clock for deadline decisions and wall-clock timestamps only for `startedAt`/`finishedAt`. Before each new seeded intent, call `segmentStopReason`; never check it between dispatch and `recordCompletion`.

Use `writeReportCheckpoint` to persist the versioned disposition object before every normal return and in a top-level caught failure path. When a pending replay or seeded operation already has a journaled intent, call `state.recordFailure` for that exact operation before writing `PENDING_REPLAY_FAILED` or `SEEDED_OPERATION_FAILED`, and assert recovery exposes the matching journal-backed `terminalFailure`. A failure without an operation intent writes its enumerated stage code and exits nonzero without inventing a journal record. Failure to write the best-effort result must not hide the original error.

- [ ] **Step 5: Run focused and existing recovery tests**

Run: `node --test test/remote-worker-dds-soak.test.js test/remote-dds-soak-state.test.js test/remote-dds-deployment-runner.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/remote-worker-dds-soak.mjs test/remote-worker-dds-soak.test.js
git commit -m "feat: pause and resume remote soak segments"
```

## Chunk 2: CI identity, deployment ownership, and cleanup

### Task 4: Add deterministic CI identity and state envelopes

**Files:**
- Create: `scripts/remote-dds-ci-identity.mjs`
- Create: `scripts/remote-dds-ci-state.mjs`
- Create: `test/remote-dds-ci-identity.test.js`
- Create: `test/remote-dds-ci-state.test.js`

- [ ] **Step 1: Write failing identity tests**

Define the public API through tests:

```js
const identity = deriveCiIdentity({
  repository: 'Daqiush/Stepstone', workflow: 'Remote DDS Soak',
  runId: '123456789', runAttempt: '2', commitSha: 'a'.repeat(40),
  secret: 'not-persisted',
});
assert.match(identity.workerName, /^ss-dds-soak-gh-123456789-2-[a-z0-9_-]{12}$/);
assert.match(identity.ownershipTag, /^[A-Za-z0-9_-]{43}$/);
assert.equal(JSON.stringify(identity).includes('not-persisted'), false);
```

Assert deterministic output, domain separation, strict repository/workflow/SHA/run validation, and rejection of artifact-supplied names that differ from recomputation. The remote test key is intentionally stable across the primary run's jobs and depends only on repository/run/attempt; define it over the UTF-8 encoding of this exact JSON array:

```js
[domain, repository, runId, runAttempt]
```

The ownership attestation additionally binds the trusted workflow name and commit, using `[domain, repository, workflow, runId, runAttempt, commitSha]`. Use domains `stepstone:remote-dds:test-key:v1` and `stepstone:remote-dds:ownership:v1`. With the example inputs above and secret `not-persisted`, fixed vectors are respectively `EpcIq_vg1echjFz_T43uSTY6xxYXivOmobzaTD8CVVk` and `buVvZra9TTq74waSHSSg5gmurFfEANzVDcSnZvPZeMU`. Test that the test key changes with repository/run/attempt but not workflow/SHA, while the ownership attestation changes with every bound field. Export separate `deriveRemoteTestKey` and `deriveOwnershipAttestation` functions; neither returned persisted identity may contain the input secret or the remote test key.

- [ ] **Step 2: Run identity tests and observe module-not-found failure**

Run: `node --test test/remote-dds-ci-identity.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement identity and artifact schemas**

Use HMAC-SHA-256 base64url. Export versioned creators/assertions for pre-deployment identity, deployment record, and state manifest. Persist the ownership tag but never the derivation secret or remote test key. The pre-deployment assertion requires a valid ISO no-collision timestamp and exact repository/workflow/run/attempt/commit/name/ownership fields. Bind the deployment record field by field to the exact workers.dev root endpoint, deployment-manifest version, build ID, Worker version ID, Wrangler version, Wasm hash, every harness hash, local temporary-configuration hash, Cloudflare-observed script ETag, and canonical Cloudflare version-configuration hash.

Add CLI form `node scripts/remote-dds-ci-identity.mjs --derive --repository <owner/repo> --workflow "Remote DDS Soak" --run-id <digits> --run-attempt <digits> --commit-sha <40-hex> --github-env <path> [--identity-out <json>]`. It reads the derivation secret only from `CLOUDFLARE_API_TOKEN`, emits GitHub's `::add-mask::<remote-key>` command before appending `DDS_REMOTE_TEST_KEY=<remote-key>` to the explicit environment file, optionally writes only the non-secret identity, and never prints or persists the source token.

- [ ] **Step 4: Write failing `state-0` and lineage tests**

Require `createReadyState` to emit disposition `READY` with no run directory, and `finalizeState` to hash `manifest.json`, `journal.jsonl`, `report.json`, `evidence.json`, and `segment-result.json`. Assert segment `n` accepts only `state-(n-1)` from the same repository/workflow/run/attempt/commit, exact endpoint, Worker name/version, build ID, local configuration hash, Cloudflare script ETag, canonical Cloudflare version-configuration hash, Wasm hash, and complete harness-hash map, and that a changed field or journal byte is rejected.

- [ ] **Step 5: Implement the state CLI**

Support only three explicit modes: `--create-ready --trusted-identity <current-job.json> --identity <json> --deployment <json> --repository <owner/repo> --workflow "Remote DDS Soak" --run-id <digits> --run-attempt <digits> --commit-sha <40-hex> --out <dir>`, `--validate-input --state <dir> --trusted-identity <current-job.json> --identity <json> --deployment <json> --repository <owner/repo> --workflow "Remote DDS Soak" --run-id <digits> --run-attempt <digits> --commit-sha <40-hex> --segment <1..6>`, and `--finalize --state-in <dir> --run-dir <dir> --trusted-identity <current-job.json> --identity <json> --deployment <json> --repository <owner/repo> --workflow "Remote DDS Soak" --run-id <digits> --run-attempt <digits> --commit-sha <40-hex> --segment <1..6> --out <dir>`. The trusted identity is freshly written in the current job by the secret-bearing identity step; later state steps receive no token. Every mode must bind it to the explicit current GitHub context, require the downloaded identity and deployment records to equal it field-by-field, and only then create, validate, or finalize state. Use `writeReportCheckpoint` for JSON outputs. The CLI must never extract archives or execute artifact content; GitHub's artifact action provides the directory tree.

- [ ] **Step 6: Run the new tests**

Run: `node --test test/remote-dds-ci-identity.test.js test/remote-dds-ci-state.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/remote-dds-ci-identity.mjs scripts/remote-dds-ci-state.mjs test/remote-dds-ci-identity.test.js test/remote-dds-ci-state.test.js
git commit -m "feat: bind remote soak CI artifacts"
```

### Task 5: Add collision checks and deployed-version ownership

**Files:**
- Create: `scripts/cloudflare-temporary-worker-api.mjs`
- Modify: `scripts/prepare-remote-dds-deployment.mjs:10-220`
- Modify: `test/remote-dds-deployment-runner.test.js`
- Modify: `test/remote-worker-dds-gates.test.js`

- [ ] **Step 1: Write failing deployment ownership tests**

Define two separate public phases: `preflightTemporaryWorkerIdentity` is read-only and creates the no-collision record; `deployAndVerifyWorkers` requires that previously persisted record plus the explicit validated Worker name and 43-character ownership tag. Assert they:

- query the exact-name endpoint plus every page of the current Workers object API and legacy scripts API before any mutation;
- refuses an exact collision without any deploy/delete call;
- find a match on a later page, reject duplicates across pages, and reject missing, malformed, non-advancing, or cyclic pagination cursors;
- passes `--tag <ownershipTag>` to both deploy attempts;
- verifies the returned immutable version has `annotations['workers/tag'] === ownershipTag`;
- preserves the same name/tag across the current code-10007 retry;
- cleans only an exact partial object with no deployed version or a matching ownership tag on failed deployment;
- performs zero mutation when verification sees an existing version with a missing or mismatched ownership tag.

- [ ] **Step 2: Run the deployment test and observe failure**

Run: `node --test test/remote-dds-deployment-runner.test.js`

Expected: FAIL because there is no separated preflight record, the current deployment creates a UUID name internally, and it does not verify ownership annotations.

- [ ] **Step 3: Extend temporary-name validation without weakening UUID runs**

Accept either the existing UUID form or `ss-dds-soak-gh-<digits>-<digits>-<12 base64url characters>`. Keep production names and prefix-only names invalid.

- [ ] **Step 4: Implement the shared Cloudflare API and separated preflight**

Create `cloudflare-temporary-worker-api.mjs` with exact APIs `findExactWorker`, `listLegacyExactScript`, `readWorkerVersions`, `disableWorkersDevSubdomain`, `deleteExactWorker`, and `confirmExactAbsence`. Every list reader follows validated pagination, detects repeated cursors, and rejects duplicates. `readWorkerVersions` fetches each exact version detail and returns its immutable version ID, `annotations['workers/tag']`, `resources.script.etag` as the Cloudflare-observed script-content hash, and a SHA-256 fingerprint of canonicalized `resources.bindings` plus `resources.script_runtime` as the Cloudflare-observed configuration hash.

`prepare-remote-dds-deployment.mjs --preflight --identity <json> --repository <owner/repo> --workflow "Remote DDS Soak" --run-id <digits> --run-attempt <digits> --commit-sha <40-hex> --out <pre-deployment.json>` first re-derives ownership from `CLOUDFLARE_API_TOKEN`, requires every artifact field to match the trusted arguments, performs only read calls, and writes the timestamped no-collision record. The workflow uploads that record before it may invoke `--deploy-from-identity <pre-deployment.json> --repository <owner/repo> --workflow "Remote DDS Soak" --run-id <digits> --run-attempt <digits> --commit-sha <40-hex> --out <deployment.json>`; deploy repeats the same recomputation before mutation rather than trusting the preflight JSON to select a name.

The deployment phase revalidates the pre-deployment record and repeats the collision check immediately before Wrangler. Add `--tag` to both deploy attempts and require the API version annotation before returning a verified deployment record. On failure, inspect version ownership before partial cleanup; a mismatched or unowned deployed version is a hard refusal with zero mutation.

- [ ] **Step 5: Extend the deployment manifest**

Increment its schema version and bind ownership tag, local temporary-configuration hash, endpoint host, immutable version metadata, the Cloudflare-observed script ETag, and the canonical Cloudflare version-configuration hash while keeping `DDS_REMOTE_TEST_KEY` absent. The record is written only after the exact version detail is re-read and all observed fields are verified. Update gate tests and manifest consumers for the new schema.

- [ ] **Step 6: Run deployment and gate tests**

Run: `node --test test/remote-dds-deployment-runner.test.js test/remote-worker-dds-gates.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/cloudflare-temporary-worker-api.mjs scripts/prepare-remote-dds-deployment.mjs test/remote-dds-deployment-runner.test.js test/remote-worker-dds-gates.test.js
git commit -m "feat: attest temporary Worker ownership"
```

### Task 6: Implement idempotent validate-before-mutate cleanup

**Files:**
- Create: `scripts/cleanup-remote-dds-deployment.mjs`
- Create: `test/remote-dds-cleanup.test.js`
- Modify: `scripts/cloudflare-temporary-worker-api.mjs`
- Modify: `scripts/prepare-remote-dds-deployment.mjs`
- Modify: `test/remote-dds-deployment-runner.test.js`

- [ ] **Step 1: Write failing cleanup tests**

Use a recording `fetchImpl` and assert no `DELETE` occurs before all available metadata is read and verified. Cover:

- fully verified deployment record: matching name, immutable ID, version, hashes, and ownership tag;
- pre-deployment-only recovery: matching recomputed unguessable name, ownership attestation, no-collision record, and either no deployed version or a matching version tag;
- already absent exact name returns `{ absent: true }`;
- mismatched name/tag/version, duplicate exact candidates, malformed API pages, or missing attestation reject with zero mutations;
- current/legacy matches found on later pages are detected, duplicates across pages are rejected, and malformed or repeating pagination cursors cannot prove absence;
- successful cleanup deletes the exact subdomain mapping, accepts HTTP 404 or DNS absence, deletes the exact immutable Worker ID, and confirms absence from current and legacy APIs;
- after subdomain deletion, cleanup re-resolves the exact object and deployed version and refuses object deletion if ID, version, or ownership changed between the two mutation boundaries;
- retry after interruption accepts an already-absent subdomain mapping, revalidates the still-present owned object, and completes exact deletion;
- a second cleanup call is successful and performs no object deletion.

- [ ] **Step 2: Run the cleanup test and observe module-not-found failure**

Run: `node --test test/remote-dds-cleanup.test.js`

Expected: FAIL because the cleanup module does not exist.

- [ ] **Step 3: Complete the shared Cloudflare API implementation**

Implement the exact APIs declared in Task 5 in `scripts/cloudflare-temporary-worker-api.mjs`. Read helpers return normalized immutable IDs/version annotations, script ETags, and canonical configuration hashes; mutation helpers accept only those normalized records. Both deployment failure cleanup and the cleanup CLI import this module. Never delete by prefix.

- [ ] **Step 4: Implement cleanup and its CLI**

CLI form is `node scripts/cleanup-remote-dds-deployment.mjs --identity <pre-deployment.json> [--deployment-record <deployment.json>] --repository <owner/repo> --workflow "Remote DDS Soak" --run-id <digits> --run-attempt <digits> --commit-sha <40-hex> --out <cleanup-result.json>`. Recompute identity from `CLOUDFLARE_API_TOKEN`; validate all metadata before mutation; when a deployment record exists, require the API-observed exact version ID, ownership tag, script ETag, and canonical configuration hash to match it; delete `workers/scripts/{name}/subdomain`; probe the former endpoint; re-resolve and revalidate the same object/version/ownership/content/configuration evidence; delete `workers/workers/{immutableId}`; and confirm exact absence in both APIs. Treat an already absent mapping as an idempotent intermediate state. Write schema-version-1 non-secret output `{ status, repository, workflow, runId, runAttempt, commitSha, workerName, subdomainDisabled, objectDeleted, currentAbsent, legacyAbsent }` atomically.

- [ ] **Step 5: Replace the deploy-to-close teardown path**

Keep the exported `teardownTemporaryWorkers` name as a compatibility wrapper, but make it construct/validate the same attested cleanup input and call the new cleanup implementation; remove its Wrangler deploy and test-key probe path. Update all current callers and prior tests so no cleanup call creates a new Worker version.

- [ ] **Step 6: Run deployment and cleanup tests**

Run: `node --test test/remote-dds-cleanup.test.js test/remote-dds-deployment-runner.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/cleanup-remote-dds-deployment.mjs scripts/cloudflare-temporary-worker-api.mjs scripts/prepare-remote-dds-deployment.mjs test/remote-dds-cleanup.test.js test/remote-dds-deployment-runner.test.js
git commit -m "feat: clean temporary Workers by attested identity"
```

## Chunk 3: GitHub orchestration and acceptance

### Task 7: Add primary manual workflow contract tests

**Files:**
- Create: `test/remote-dds-workflow-contract.test.js`
- Create: `.github/workflows/remote-dds-soak.yml`
- Modify: `scripts/check-remote-worker-dds-gates.mjs`
- Modify: `test/remote-worker-dds-gates.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write the failing workflow contract test**

Install `yaml@2.9.1` as an exact dev dependency, parse the workflow structurally, and assert all security-critical fields and ordering relationships:

- `workflow_dispatch` exists; `push`, `pull_request`, and `schedule` do not;
- `workflow_dispatch.inputs.request_id` is a required non-secret string and `run-name` is exactly `Remote DDS Soak ${{ inputs.request_id }}`, allowing one dispatch to be found without a latest-run race;
- concurrency is exactly repository-wide `group: stepstone-remote-dds-soak` with `cancel-in-progress: false`, with no ref, SHA, run, or input interpolation;
- the workflow permission map is exactly `{ contents: read, actions: read }`, and no job broadens it;
- every `uses:` reference is one of the four approved official actions at its approved full SHA; reject any additional or symbolic action reference;
- preparation runs `npm test`, `npm run test:workers`, and `npm run test:dds:smoke` successfully before any Cloudflare preflight or deploy call, uploads identity before the deploy step, and creates `state-0`;
- six segment jobs form `needs` order and each has `timeout-minutes: 355`;
- every runner call uses `--max-new-operations 6000 --deadline-ms 17100000`;
- segment `n` consumes only state `n-1`, validates it against the freshly recomputed identity, downloaded deployment record, and current repository/workflow/run/attempt/SHA context, and publishes only state `n`;
- gate consumes only `state-6` and runs the existing checker;
- primary cleanup has `if: always()` and depends on prepare, all segments, and gate;
- intermediate artifacts use seven-day retention and final evidence uses 30 days;
- Cloudflare secrets appear only in identity derivation, deploy, and cleanup step environments; runner, state finalization, compression, gate, and artifact steps cannot receive `CLOUDFLARE_API_TOKEN`;
- exact artifact names are `remote-dds-identity-${{ github.run_id }}-${{ github.run_attempt }}`, `remote-dds-deployment-${{ github.run_id }}-${{ github.run_attempt }}`, `remote-dds-state-${{ github.run_id }}-${{ github.run_attempt }}-0` through `-6`, `remote-dds-final-evidence-${{ github.run_id }}-${{ github.run_attempt }}`, and `remote-dds-primary-cleanup-${{ github.run_id }}-${{ github.run_attempt }}`;
- every mandatory upload sets `if-no-files-found: error`, and every download names exactly one attempt-qualified artifact.

- [ ] **Step 2: Run the test and observe missing-workflow failure**

Run: `node --test test/remote-dds-workflow-contract.test.js`

Expected: FAIL because the workflow does not exist.

- [ ] **Step 3: Create the manual primary workflow**

Use these pinned official actions:

```yaml
actions/checkout@11d5960a326750d5838078e36cf38b85af677262
actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
```

Use `windows-latest`, Node 20, `npm ci`, and the exact scripts from Chunks 1–2. At the start of prepare and every segment, invoke the tested identity CLI with repository, workflow, primary run ID, run attempt, commit SHA, and `--identity-out` pointing to a current-job-only trusted identity path; expose `CLOUDFLARE_API_TOKEN` only to that step, print GitHub's mask command before appending only `DDS_REMOTE_TEST_KEY` to `GITHUB_ENV`, and keep the token absent from all later runner/state/artifact steps. Deploy receives the token separately only in its own step-scoped environment. The cleanup job is the deliberate exception: it must list identity artifacts first without Cloudflare secrets, and only when exactly one identity artifact exists may a later step derive the trusted identity and expose the token to the cleanup CLI.

Set the concurrency group to the literal repository-wide value `stepstone-remote-dds-soak` and `cancel-in-progress: false`. In prepare, after checkout/setup/`npm ci`, run `npm test`, `npm run test:workers`, and `npm run test:dds:smoke` in that order before preflight or deployment. Each segment downloads the exact published identity, deployment, and predecessor-state artifacts, then calls `--validate-input` with those paths, the freshly generated current-job trusted identity path, `${{ github.repository }}`, the literal workflow name, `${{ github.run_id }}`, `${{ github.run_attempt }}`, and `${{ github.sha }}` before starting the soak runner. The same trusted inputs are mandatory for finalization.

For each segment, run the soak step with `continue-on-error: true` and capture its outcome. Under `if: always()`, finalize `state-n`, upload it with `if-no-files-found: error`, then use a final step to re-propagate the original runner failure after evidence publication. Later segments require the predecessor job to have succeeded and validate exactly one predecessor artifact.

- [ ] **Step 4: Add a machine-readable gate result with failure-safe evidence upload**

First extend `check-remote-worker-dds-gates.mjs` by TDD with optional `--out <gate-result.json>`. The versioned JSON contains the resolved primary run ID/attempt and the complete gate list with each `{ name, passed }`; it is atomically written on both pass and ordinary gate failure, without changing the checker's exit status. Add tests for pass output, failed-gate output plus non-zero exit, and write failure.

Run the checker step with `continue-on-error: true`, redirect its stdout and stderr to the fixed `gate/stdout.log` and `gate/stderr.log` paths, and pass `--out gate/gate-result.json`. Under `if: always()`, construct and upload the final evidence; after upload, a final step re-propagates the captured checker failure. If gate-result construction itself fails, evidence upload remains attempted and the job remains red.

- [ ] **Step 5: Add deterministic primary cleanup and evidence upload**

The gate job builds `remote-dds-final-evidence-${{ github.run_id }}-${{ github.run_attempt }}` with fixed paths `deployment/deployment.json`, `state-6/state-manifest.json`, `state-6/run/{manifest.json,journal.jsonl,report.json,evidence.json,segment-result.json}`, and `gate/{gate-result.json,simulator-report.json,stdout.log,stderr.log}`. It uploads the artifact for 30 days with `if-no-files-found: error`. Evidence-upload failure keeps the job red.

The cleanup job has job-level `if: ${{ always() }}` and the complete `needs` set. Its token-free first step lists exact current-run artifact names. Zero identity artifacts produces and uploads a 30-day `{ version: 1, status: 'no-deployment-authorized', repository, workflow, runId, runAttempt, commitSha, workerName: null, subdomainDisabled: false, objectDeleted: false, currentAbsent: true, legacyAbsent: true }` result without reading or exposing Cloudflare secrets; more than one is failure. Exactly one identity is downloaded, while zero or one deployment record is accepted. Only this branch runs identity derivation and cleanup with step-scoped `CLOUDFLARE_API_TOKEN`. Cleanup's normal schema is the versioned record defined in Task 6 and therefore also contains repository/workflow/run/attempt/commit fields. Cleanup runs with `continue-on-error: true`; an `always()` result step writes and uploads `remote-dds-primary-cleanup-${{ github.run_id }}-${{ github.run_attempt }}` even when cleanup fails, then a final step re-propagates that failure. Contract tests enforce listing-before-secret-use and both result schemas.

- [ ] **Step 6: Run the workflow contract and gate tests**

Run: `node --test test/remote-dds-workflow-contract.test.js test/remote-worker-dds-gates.test.js`

Expected: PASS.

- [ ] **Step 7: Run the complete suites before committing workflow files**

Run: `npm test && npm run test:workers && npm run test:dds:smoke`

Expected: all commands exit 0. This satisfies the design rule that the complete local suites pass before a workflow file is committed.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/remote-dds-soak.yml scripts/check-remote-worker-dds-gates.mjs test/remote-worker-dds-gates.test.js test/remote-dds-workflow-contract.test.js package.json package-lock.json
git commit -m "ci: orchestrate segmented remote DDS soak"
```

### Task 8: Add the trusted `workflow_run` cleanup backstop

**Files:**
- Create: `.github/workflows/remote-dds-soak-cleanup.yml`
- Modify: `test/remote-dds-workflow-contract.test.js`

- [ ] **Step 1: Extend the failing contract test**

Require the backstop to:

- trigger only on `workflow_run` for `Remote DDS Soak` and `types: [completed]`;
- set `run-name` exactly to `Cleanup primary ${{ github.event.workflow_run.id }} attempt ${{ github.event.workflow_run.run_attempt }}` so one primary attempt maps to one discoverable backstop run;
- grant only `actions: read` and `contents: read`;
- check out `github.event.repository.default_branch`, never `head_sha`;
- derive exact artifact names from `github.event.workflow_run.id` and `github.event.workflow_run.run_attempt`, then download only those names with `run-id: github.event.workflow_run.id` and the triggering run's GitHub token;
- check out trusted code under `${{ runner.temp }}/remote-dds-trusted` and download data-only artifacts under `${{ runner.temp }}/remote-dds-untrusted/<run-id>/<attempt>`, never into or above the checkout;
- recompute run attempt, commit, Worker name, and ownership from trusted event fields;
- treat downloaded JSON only as CLI input and never execute downloaded files;
- accept only `remote-dds-identity-<run-id>-<attempt>` and optional `remote-dds-deployment-<run-id>-<attempt>`, use the same cleanup CLI, and upload `remote-dds-backstop-cleanup-<run-id>-<attempt>` for 30 days;
- pin every third-party action to the same approved full SHA.

- [ ] **Step 2: Run and observe failure**

Run: `node --test test/remote-dds-workflow-contract.test.js`

Expected: FAIL because the backstop workflow does not exist.

- [ ] **Step 3: Implement the backstop workflow**

Use a single `windows-latest` job. Query the triggering run's artifacts and require at most one exact attempt-qualified match for each accepted name. If the exact pre-deployment identity artifact is absent, record the same versioned `no-deployment-authorized` schema (including repository/workflow/run ID/run attempt/commit and absence fields) and perform no Cloudflare mutation or secret-bearing derivation. Otherwise invoke trusted default-branch cleanup code from the separate trusted directory with event-derived context and the optional verified deployment record from the untrusted data directory. Cleanup uses `continue-on-error: true`; the result artifact uploads under `if: always()` with `if-no-files-found: error`, followed by failure re-propagation.

- [ ] **Step 4: Run the contract test**

Run: `node --test test/remote-dds-workflow-contract.test.js`

Expected: PASS.

- [ ] **Step 5: Run the complete suites before committing the backstop**

Run: `npm test && npm run test:workers && npm run test:dds:smoke`

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/remote-dds-soak-cleanup.yml test/remote-dds-workflow-contract.test.js
git commit -m "ci: backstop temporary Worker cleanup"
```

### Task 9: Local verification and documentation

**Files:**
- Modify: `docs/workers-dds-dependency.md`
- Modify: `package.json` only if concise CI helper scripts materially reduce workflow duplication

- [ ] **Step 1: Document operator behavior**

Explain that the operator starts `Remote DDS Soak` manually, does not cancel it during normal operation, keeps the temporary Cloudflare token valid until cleanup confirms absence, downloads the 30-day final evidence, and revokes the token immediately afterwards. State explicitly that this workflow does not deploy `stepstone.hogetsu.uk`.

- [ ] **Step 2: Run formatting and secret-leak checks**

Run:

```powershell
git diff --check
rg -n "cfut_|DDS_REMOTE_TEST_KEY=" .github scripts test docs
```

Expected: `git diff --check` exits 0; the secret scan finds no literal token or assigned test-key value.

- [ ] **Step 3: Run the complete local test suites**

Run:

```powershell
npm test
npm run test:workers
npm run test:dds:smoke
```

Expected: every command exits 0 with zero failed tests and a successful native DDS smoke test.

- [ ] **Step 4: Review the complete branch diff against the design**

Run: `git diff 5e72f83...HEAD --stat` and `git diff 5e72f83...HEAD -- . ':(exclude)workers/test/results'`.

Expected: only design/plan documentation, focused runner/deployment/cleanup modules, their tests, workflow files, and operator documentation are changed; no game engine, DNS, domain, or production deployment configuration is modified.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/workers-dds-dependency.md package.json package-lock.json
git commit -m "docs: explain GitHub remote DDS soak"
```

Skip unchanged package files rather than creating an empty commit.

### Task 10: Integrate and perform the remote acceptance run

**Files:**
- No source edits unless the remote run exposes a reproducible defect; fix defects through a new failing test first.

- [ ] **Step 1: Use `superpowers:requesting-code-review`**

Request a focused review of security boundaries, artifact lineage, segment semantics, and cleanup ordering. Resolve all blocking findings with TDD and rerun Task 9 verification.

- [ ] **Step 2: Use `superpowers:finishing-a-development-branch`**

Integrate `codex/github-dds-soak` into the repository's default branch without including the untracked historical evidence directories. Push the default branch so GitHub recognizes both workflow files.

- [ ] **Step 3: Manually dispatch `Remote DDS Soak` once**

Use the repository's Actions page or authenticated GitHub CLI. Do not pass the Cloudflare token on the command line; the workflow reads the already configured repository secrets. Generate a unique, non-secret request ID and bind discovery to the exact workflow run title instead of selecting the latest run.

```powershell
$requestId = "accept-$([guid]::NewGuid().ToString('N'))"
$dispatchAfter = [DateTimeOffset]::UtcNow.AddSeconds(-5)
$priorIds = @(gh api 'repos/Daqiush/Stepstone/actions/workflows/remote-dds-soak.yml/runs?event=workflow_dispatch&branch=master&per_page=100' --jq '.workflow_runs[].id')
gh workflow run remote-dds-soak.yml --ref master -f "request_id=$requestId"
$primaryRunId = $null
$deadline = [DateTimeOffset]::UtcNow.AddMinutes(5)
do {
  Start-Sleep -Seconds 5
  $runs = gh api 'repos/Daqiush/Stepstone/actions/workflows/remote-dds-soak.yml/runs?event=workflow_dispatch&branch=master&per_page=100' | ConvertFrom-Json
  $match = @($runs.workflow_runs | Where-Object {
    $_.display_title -eq "Remote DDS Soak $requestId" -and
    [DateTimeOffset]$_.created_at -ge $dispatchAfter -and
    $priorIds -notcontains [string]$_.id
  })
  if ($match.Count -gt 1) { throw 'Ambiguous primary workflow dispatch' }
  if ($match.Count -eq 1) { $primaryRunId = [string]$match[0].id }
} until ($primaryRunId -or [DateTimeOffset]::UtcNow -ge $deadline)
if (-not $primaryRunId) { throw 'Primary workflow run was not discovered' }
gh run watch $primaryRunId --exit-status
$runAttempt = gh api "repos/Daqiush/Stepstone/actions/runs/$primaryRunId" --jq '.run_attempt'
```

Expected: dispatch succeeds, exactly one new run has the request-specific title and `workflow_dispatch` event, and `gh run watch` exits 0.

- [ ] **Step 4: Monitor without local-process dependence**

Confirm preparation, `state-0`, all six state artifacts, gate, primary cleanup, and backstop completion. A local machine may disconnect after dispatch without affecting the hosted jobs.

```powershell
$backstopTitle = "Cleanup primary $primaryRunId attempt $runAttempt"
$backstopRunId = $null
$deadline = [DateTimeOffset]::UtcNow.AddMinutes(10)
do {
  Start-Sleep -Seconds 10
  $runs = gh api 'repos/Daqiush/Stepstone/actions/workflows/remote-dds-soak-cleanup.yml/runs?event=workflow_run&branch=master&per_page=100' | ConvertFrom-Json
  $match = @($runs.workflow_runs | Where-Object { $_.display_title -eq $backstopTitle })
  if ($match.Count -gt 1) { throw 'Ambiguous cleanup backstop run' }
  if ($match.Count -eq 1) { $backstopRunId = [string]$match[0].id }
} until ($backstopRunId -or [DateTimeOffset]::UtcNow -ge $deadline)
if (-not $backstopRunId) { throw 'Cleanup backstop run was not discovered' }
gh run watch $backstopRunId --exit-status
```

Expected: the exact primary run/attempt backstop is found by its unique title and exits 0.

- [ ] **Step 5: Verify acceptance evidence**

Download only the exact attempt-qualified evidence:

```powershell
$acceptDir = Join-Path $env:TEMP "stepstone-dds-accept-$primaryRunId-$runAttempt"
New-Item -ItemType Directory -Path $acceptDir | Out-Null
gh run download $primaryRunId -n "remote-dds-final-evidence-$primaryRunId-$runAttempt" -D (Join-Path $acceptDir 'evidence')
gh run download $primaryRunId -n "remote-dds-primary-cleanup-$primaryRunId-$runAttempt" -D (Join-Path $acceptDir 'primary-cleanup')
gh run download $backstopRunId -n "remote-dds-backstop-cleanup-$primaryRunId-$runAttempt" -D (Join-Path $acceptDir 'backstop-cleanup')
node scripts/check-remote-worker-dds-gates.mjs --run-dir (Join-Path $acceptDir 'evidence/state-6/run') --deployment-manifest (Join-Path $acceptDir 'evidence/deployment/deployment.json') --simulator-report (Join-Path $acceptDir 'evidence/gate/simulator-report.json')
node -e "const fs=require('fs'); const [reportPath,gatePath,primaryPath,backstopPath,runId,attempt]=process.argv.slice(1); const report=JSON.parse(fs.readFileSync(reportPath)); const gate=JSON.parse(fs.readFileSync(gatePath)); const cleanups=[primaryPath,backstopPath].map(p=>JSON.parse(fs.readFileSync(p))); if(report.completedCursor!==22000||report.terminalFailure!==null) process.exit(1); if(String(gate.runId)!==runId||String(gate.runAttempt)!==attempt||!Array.isArray(gate.gates)||gate.gates.length===0||gate.gates.some(x=>x.passed!==true)) process.exit(1); if(cleanups.some(x=>String(x.runId)!==runId||String(x.runAttempt)!==attempt||x.currentAbsent!==true||x.legacyAbsent!==true)) process.exit(1)" (Join-Path $acceptDir 'evidence/state-6/run/report.json') (Join-Path $acceptDir 'evidence/gate/gate-result.json') (Join-Path $acceptDir 'primary-cleanup/cleanup-result.json') (Join-Path $acceptDir 'backstop-cleanup/cleanup-result.json') $primaryRunId $runAttempt
```

Expected: both commands exit 0; the report contains all 22,000 completed operations with no terminal failure; every machine-readable gate passes; the gate and both cleanup records are bound to the exact requested run/attempt; and both cleanup results confirm absence from current and legacy Cloudflare APIs. Do not claim production deployment.

- [ ] **Step 6: Revoke the temporary Cloudflare token**

Only after cleanup confirmation, instruct the operator to revoke the temporary token. If cleanup failed, preserve evidence and repair only the exact attested temporary object before revocation.
