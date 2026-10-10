# GitHub Runner Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Remote DDS Soak deterministic on GitHub Windows runners and make deployment/cleanup failures stage-specific, bounded, secret-safe, and non-masking.

**Architecture:** Add one focused timeout/signal helper, extend the existing branded public-diagnostic boundary, and keep Cloudflare mutation authority inside the current identity-bound API and cleanup modules. Lock workflow runtime inputs through pinned Node-24 actions, fixed runner labels, LF attributes, and a separate no-secret Windows DDS CI workflow.

**Tech Stack:** Node.js 22 ESM/CommonJS, `node:test`, PowerShell 7, GitHub Actions, Wrangler 4, Cloudflare Workers API, MSBuild/Visual Studio 2022.

---

## Chunk 1: Stage-safe diagnostics and bounded operations

### Task 1: Define the public diagnostic contract

**Files:**
- Modify: `scripts/remote-dds-public-errors.mjs`
- Test: `test/remote-dds-deployment-runner.test.js`
- Test: `test/remote-dds-cleanup.test.js`

- [ ] **Step 1: Write failing tests for all new allow-listed codes and exact renderers**

Add table-driven tests that construct branded diagnostics for every deployment, timeout, rollback, and cleanup code from the design. Assert these exact public forms:

```js
assert.equal(renderRemoteDdsFailure(diagnostic('WRANGLER_DEPLOY_FAILED', cause)),
  'Remote DDS deployment failed [WRANGLER_DEPLOY_FAILED].');
assert.equal(renderRemoteDdsRollbackFailure(diagnostic('ROLLBACK_CLEANUP_FAILED', cause)),
  'Remote DDS rollback also failed [ROLLBACK_CLEANUP_FAILED].');
assert.equal(renderRemoteDdsCleanupFailure(diagnostic('CLEANUP_DELETE_FAILED', cause)),
  'Remote DDS cleanup failed [CLEANUP_DELETE_FAILED].');
```

For every renderer, assert that token, account, test-key, path, URL, and stack markers do not appear.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/remote-dds-deployment-runner.test.js test/remote-dds-cleanup.test.js`

Expected: failure because the new diagnostic codes/renderers do not exist.

- [ ] **Step 3: Implement the minimal branded renderer changes**

Keep `RemoteDdsDiagnosticError` and its private `WeakSet` brand. Extend only the allow-list and add label-specific render functions. Never render `cause`, `message`, `stack`, arbitrary code strings, or raw stage names.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/remote-dds-deployment-runner.test.js test/remote-dds-cleanup.test.js`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```powershell
git add scripts/remote-dds-public-errors.mjs test/remote-dds-deployment-runner.test.js test/remote-dds-cleanup.test.js
git commit -m "feat: add staged remote DDS diagnostics"
```

### Task 2: Add shared timeout and signal composition

**Files:**
- Create: `scripts/remote-dds-timeouts.mjs`
- Modify: `scripts/cloudflare-temporary-worker-api.mjs`
- Test: `test/remote-dds-deployment-runner.test.js`

- [ ] **Step 1: Write failing unit tests for composed cancellation**

Specify this public helper API:

```js
const signal = deadlineSignal({ signal: caller.signal, timeoutMs: 30_000 });
assert.equal(signal.aborted, false);
caller.abort();
assert.equal(signal.aborted, true);
assert.equal(isTimeoutError(timeoutErrorFixture), true);
```

Also inject a `fetchImpl` that records `options.signal`; assert every request performed by `confirmExactAbsence`, `readOwnershipSnapshot`, `disableWorkersDevSubdomain`, and `deleteExactWorker` receives a signal.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/remote-dds-deployment-runner.test.js`

Expected: failure because the helper and request signals are absent.

- [ ] **Step 3: Implement the timeout helper and API integration**

`remote-dds-timeouts.mjs` exports immutable timeout constants, `deadlineSignal({signal, timeoutMs})` using `AbortSignal.timeout` and `AbortSignal.any`, and `isTimeoutError(error)` recognizing Node abort/timeout shapes without inspecting sensitive response text.

`cloudflare-temporary-worker-api.mjs` accepts `signal` and `requestTimeoutMs = 30_000` through `inputs()`. `fetchResponse()` composes the caller signal with the internal deadline and preserves existing branded API diagnostics. Direct prepare and cleanup fetches are integrated with this helper in Tasks 3 and 4, where their stage-specific classifications exist.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/remote-dds-deployment-runner.test.js`

Expected: all deployment/API tests pass.

- [ ] **Step 5: Commit**

```powershell
git add scripts/remote-dds-timeouts.mjs scripts/cloudflare-temporary-worker-api.mjs test/remote-dds-deployment-runner.test.js
git commit -m "feat: bound Cloudflare management requests"
```

### Task 3: Preserve deployment failure precedence and bound Wrangler

**Files:**
- Modify: `scripts/prepare-remote-dds-deployment.mjs`
- Test: `test/remote-dds-deployment-runner.test.js`

- [ ] **Step 1: Write failing tests for child options and stage precedence**

Assert deploy and secret calls receive `timeout: 120000`, version receives `timeout: 15000`, and all inherit one shared child-process option set containing `encoding: 'utf8'`, `killSignal: 'SIGTERM'`, `maxBuffer: 4 * 1024 * 1024`, and `windowsHide: true`; only timeout and secret stdin input may differ per invocation.

Add separate injected failures for collision preflight, deploy, first ownership read, secret upload, second ownership read, subdomain lookup, immutable version read, endpoint verification, rollback discovery, rollback cleanup, and temporary-directory removal. Assert:

```js
stderr === 'Remote DDS deployment failed [WRANGLER_DEPLOY_FAILED].\n' +
          'Remote DDS rollback also failed [ROLLBACK_CLEANUP_FAILED].\n'
```

when both fail, while the original deployment code stays first. Add timeout fixtures for each stage-specific timeout code.

Run a real synchronous child fixture that sleeps beyond its deadline. Assert the Windows parent regains control within a bounded elapsed time, returns a stage-specific timeout code, and does not expose the child's stdout/stderr.

Cover all precedence combinations explicitly: deployment failure plus directory cleanup failure; deployment failure plus rollback failure plus directory cleanup failure; and otherwise-successful deployment plus directory cleanup failure. Directory cleanup is publicly suppressed whenever a deployment error exists, remains suppressed behind a rollback line, and becomes the primary `TEMP_DIRECTORY_CLEANUP_FAILED` only after an otherwise successful deployment.

For prepare's direct fetches, test that account-subdomain lookup composes the caller signal with a 30-second management deadline and the deployment workers.dev probe composes it with a 15-second deadline. Cover caller abort and internal timeout separately and assert stage-specific timeout classification.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/remote-dds-deployment-runner.test.js`

Expected: new option, stage, and precedence assertions fail.

- [ ] **Step 3: Implement stage wrappers and non-masking cleanup**

Use small boundary helpers that preserve an existing branded API diagnostic, map timeout to the current stage timeout code, and otherwise wrap with the current stage failure code. Build all Wrangler calls from one shared UTF-8 child-option set, layering only their timeout and secret input. Compose direct-fetch caller signals with the 30-second management or 15-second probe deadline. Restructure the `catch/finally` path so rollback errors are recorded separately and `rmSync` uses `maxRetries`/`retryDelay` without replacing a prior error.

Keep all deletion authority delegated to `cleanupRemoteDdsDeployment`; do not add a direct delete fallback.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test test/remote-dds-deployment-runner.test.js`

Expected: all deployment tests pass with no secret markers.

- [ ] **Step 5: Commit**

```powershell
git add scripts/prepare-remote-dds-deployment.mjs test/remote-dds-deployment-runner.test.js
git commit -m "fix: preserve remote deployment failures"
```

## Chunk 2: Cleanup evidence and fail-closed stage reporting

### Task 4: Add stage-specific cleanup failure evidence

**Files:**
- Modify: `scripts/cleanup-remote-dds-deployment.mjs`
- Modify: `scripts/remote-dds-public-errors.mjs`
- Test: `test/remote-dds-cleanup.test.js`

- [ ] **Step 1: Write failing tests for the three cleanup gates**

Use a table that maps every boundary to its code and retained evidence: pre-gate identity validation → `CLEANUP_IDENTITY_INVALID`; first ownership read → `CLEANUP_OWNERSHIP_READ_TIMEOUT` / `CLEANUP_OWNERSHIP_UNVERIFIED`; first subdomain lookup → `CLEANUP_SUBDOMAIN_LOOKUP_TIMEOUT` / `CLEANUP_ENDPOINT_UNVERIFIED`; disable → `CLEANUP_SUBDOMAIN_DISABLE_TIMEOUT` / `CLEANUP_SUBDOMAIN_DISABLE_FAILED`; former-endpoint probe → `CLEANUP_ENDPOINT_PROBE_TIMEOUT` / `CLEANUP_ENDPOINT_UNVERIFIED`; stable reread and deployment-record recheck → `CLEANUP_REVERIFY_TIMEOUT` / `CLEANUP_OWNERSHIP_UNVERIFIED`; second endpoint derivation → `CLEANUP_SUBDOMAIN_LOOKUP_TIMEOUT` / `CLEANUP_ENDPOINT_UNVERIFIED`; delete → `CLEANUP_DELETE_TIMEOUT` / `CLEANUP_DELETE_FAILED`; exact final absence → `CLEANUP_FINAL_ABSENCE_TIMEOUT` / `CLEANUP_ABSENCE_UNVERIFIED`; result persistence → `CLEANUP_RESULT_WRITE_FAILED`. For every row, inject timeout and representative malformed/ambiguous/mutation failure as applicable, assert zero later mutations, and retain only already-confirmed booleans.

Also test caller abort and internal timeout for the direct account-subdomain lookup (30 seconds) and former-endpoint probe (15 seconds). Add explicit cases for changed ownership snapshots, optional deployment-record mismatch on both reads, and changed endpoint derivation; each must stop later mutation and prevent final absence. In particular:

```js
assert.deepEqual(failedResult, {
  version: 2,
  status: 'failed',
  repository: CONTEXT.repository,
  workflow: CONTEXT.workflow,
  runId: CONTEXT.runId,
  runAttempt: CONTEXT.runAttempt,
  commitSha: CONTEXT.commitSha,
  workerName: expectedWorker,
  subdomainDisabled: true,
  objectDeleted: false,
  currentAbsent: false,
  legacyAbsent: false,
  failureCode: 'CLEANUP_ENDPOINT_PROBE_TIMEOUT',
});
```

Add tests proving final absence is never true unless all three APIs confirm absence.

- [ ] **Step 2: Run cleanup tests and verify RED**

Run: `node --test test/remote-dds-cleanup.test.js`

Expected: schema, deadline, gate-order, drift, and persistence assertions fail.

- [ ] **Step 3: Implement schema v2 and ordered boundary classification**

Make `resultFor()` return schema v2 with `failureCode`. Track the current cleanup stage before each awaited boundary. Preserve the exact existing order: ownership snapshot → endpoint derivation → disable → former endpoint 404 → stable reread → endpoint stability → delete → exact final absence.

On failure, attach only the safe schema-v2 result to the branded cleanup diagnostic. `runCleanupCli()` attempts to write that result atomically, renders only the allow-listed original code first, and never copies raw error text into output. If detailed persistence fails, it additionally reports only `CLEANUP_RESULT_WRITE_FAILED`; Task 5's workflow fallback writer persists the fixed fallback artifact.

- [ ] **Step 4: Run cleanup tests and verify GREEN**

Run: `node --test test/remote-dds-cleanup.test.js`

Expected: all cleanup tests pass.

- [ ] **Step 5: Commit**

```powershell
git add scripts/cleanup-remote-dds-deployment.mjs scripts/remote-dds-public-errors.mjs test/remote-dds-cleanup.test.js
git commit -m "feat: persist safe cleanup failure stages"
```

### Task 5: Update workflow cleanup fallback contracts

**Files:**
- Modify: `.github/workflows/remote-dds-soak.yml`
- Modify: `.github/workflows/remote-dds-soak-cleanup.yml`
- Modify: `test/remote-dds-workflow-contract.test.js`

- [ ] **Step 1: Write failing workflow contract tests**

Require schema version 2, exact `failureCode` field, and `failureCode: null` specifically for `deleted`, `already-absent`, and `no-deployment-authorized`. Require fixed `CLEANUP_RESULT_WRITE_FAILED` on fallback, false absence fields on failure, the original cleanup diagnostic as the first public log line, and successful artifact upload even when cleanup returns nonzero in both primary and backstop workflows.

- [ ] **Step 2: Run contract tests and verify RED**

Run: `node --test test/remote-dds-workflow-contract.test.js`

Expected: old schema/fallback assertions fail.

- [ ] **Step 3: Update both workflow fallback writers and validators**

Do not interpolate caught error text. Validate exact field sets, allow-listed failure codes, context equality, boolean types, and status/code consistency before upload.

- [ ] **Step 4: Run contract tests and verify GREEN**

Run: `node --test test/remote-dds-workflow-contract.test.js`

Expected: all workflow contract tests pass.

- [ ] **Step 5: Commit**

```powershell
git add .github/workflows/remote-dds-soak.yml .github/workflows/remote-dds-soak-cleanup.yml test/remote-dds-workflow-contract.test.js
git commit -m "fix: publish cleanup failure evidence"
```

## Chunk 3: Deterministic Windows runner inputs

### Task 6: Pin action runtimes, runner labels, queueing, and timeouts

**Files:**
- Modify: `.github/workflows/remote-dds-soak.yml`
- Modify: `.github/workflows/remote-dds-soak-cleanup.yml`
- Modify: `test/remote-dds-workflow-contract.test.js`

Use these verified Node-24 action pins:

```text
actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1        # v7.0.1
actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1      # v7.1.0
actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
```

- [ ] **Step 1: Write failing contract assertions**

Require every applicable action occurrence to use only these pins, `queue: max`, `windows-2022` for primary and backstop, prepare timeout 30, cleanup timeout 20, backstop timeout 20, and existing segment timeout 355. Assert the segment runner still passes the 285-minute internal operation deadline, preserving about 70 minutes for state publication and runner cleanup, and assert cleanup remains a separate job with its own independent 20-minute budget.

- [ ] **Step 2: Run workflow tests and verify RED**

Run: `node --test test/remote-dds-workflow-contract.test.js`

Expected: current pins, queue, backstop label, and timeout assertions fail.

- [ ] **Step 3: Update workflows and test constants**

Keep `node-version: 22`, least-privilege permissions, exact artifact names, and all existing identity constraints unchanged.

- [ ] **Step 4: Execute every embedded PowerShell run block with `pwsh` and verify GREEN**

Change the workflow-contract launcher itself to invoke the `pwsh` executable for every embedded block in both workflows, and assert the captured executable is exactly `pwsh` rather than `powershell.exe`.

Run: `node --test test/remote-dds-workflow-contract.test.js`

Expected: all contracts pass under PowerShell 7.

- [ ] **Step 5: Commit**

```powershell
git add .github/workflows/remote-dds-soak.yml .github/workflows/remote-dds-soak-cleanup.yml test/remote-dds-workflow-contract.test.js
git commit -m "ci: pin remote DDS runner inputs"
```

### Task 7: Lock byte-sensitive files to LF

**Files:**
- Create: `.gitattributes`
- Modify: `workers/vendor/bridge-dds/.gitattributes`
- Create: `test/gitattributes-contract.test.js`
- Modify: `test/assert-remote-soak-prerequisites.test.js`

- [ ] **Step 1: Write a failing attribute contract test**

Use `git check-attr` to assert the root catch-all `* text=auto`, enumerate every designed root extension and require `text: set` plus `eol: lf`, require Wasm `text: unset`, and require all four vendored generated/license files to report `text: unset` and `whitespace: unset`. Add a temporary-repository fixture that checks out or materializes the relevant baseline inputs as CRLF and proves Git normalization restores the exact LF blob bytes before the byte-sensitive prerequisite comparison.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/gitattributes-contract.test.js`

Expected: root catch-all/LF assertions, vendored license `text: unset` assertions, and simulated-CRLF stability assertion fail.

- [ ] **Step 3: Add the exact root and nested attributes from the design**

Do not modify the generated Worker JavaScript, Wasm, or license file contents. Run `git diff --check` and inspect `git status` before staging.

- [ ] **Step 4: Run the contract and prerequisite tests**

Run: `node --test test/gitattributes-contract.test.js test/assert-remote-soak-prerequisites.test.js`

Expected: all tests pass and no unrelated file appears modified.

- [ ] **Step 5: Commit**

```powershell
git add .gitattributes workers/vendor/bridge-dds/.gitattributes test/gitattributes-contract.test.js test/assert-remote-soak-prerequisites.test.js
git commit -m "build: lock byte-sensitive checkout attributes"
```

## Chunk 4: No-secret Windows native gate and final verification

### Task 8: Add the Windows DDS CI workflow

**Files:**
- Create: `.github/workflows/windows-dds-ci.yml`
- Modify: `test/remote-dds-workflow-contract.test.js`

- [ ] **Step 1: Write failing workflow tests**

Require triggers for `pull_request` and pushes to `master`, `permissions: { contents: read }`, `windows-2022`, timeout 30, recursive submodules, the approved checkout/setup-node pins, Node 22, and these commands in order:

```text
npm ci
./scripts/build-windows-dds.ps1
npm run test:dds:smoke
npm run test:commands
node --test test/remote-dds-deployment-runner.test.js test/remote-dds-cleanup.test.js test/remote-dds-workflow-contract.test.js test/assert-remote-soak-prerequisites.test.js test/gitattributes-contract.test.js
```

Assert the YAML contains no `secrets.`, `CLOUDFLARE_`, `DDS_REMOTE_TEST_KEY`, deploy command, or cleanup mutation command.

- [ ] **Step 2: Run workflow tests and verify RED**

Run: `node --test test/remote-dds-workflow-contract.test.js`

Expected: missing workflow assertions fail.

- [ ] **Step 3: Create the minimal no-secret workflow**

Do not add artifact upload, cache write permissions, workflow dispatch, or Cloudflare environment variables.

- [ ] **Step 4: Run workflow tests and verify GREEN**

Run: `node --test test/remote-dds-workflow-contract.test.js`

Expected: all workflow tests pass.

- [ ] **Step 5: Commit**

```powershell
git add .github/workflows/windows-dds-ci.yml test/remote-dds-workflow-contract.test.js
git commit -m "ci: add Windows DDS verification gate"
```

### Task 9: Verify the complete change set

**Files:**
- Review: all files changed since `f21def6`

- [ ] **Step 1: Run focused remote deployment and cleanup tests**

Run: `node --test test/remote-dds-deployment-runner.test.js test/remote-dds-cleanup.test.js test/remote-dds-workflow-contract.test.js test/assert-remote-soak-prerequisites.test.js test/gitattributes-contract.test.js`

Expected: zero failures and no secret markers.

- [ ] **Step 2: Run command portability tests**

Run: `npm run test:commands`

Expected: command exits successfully with zero failed tests.

- [ ] **Step 3: Run the complete application suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 4: Run the Worker suite**

Run: `npm run test:workers`

Expected: all tests pass and Wrangler exits cleanly.

- [ ] **Step 5: Build and smoke native DDS**

Run: `./scripts/build-windows-dds.ps1`

Run: `npm run test:dds:smoke`

Expected: both native executables build and both smoke tests pass.

- [ ] **Step 6: Inspect repository integrity**

Run: `git diff --check`

Run: `git status --short`

Run: `git diff f21def6...HEAD --stat`

Expected: no whitespace errors, only intended files changed, and no uncommitted changes.

- [ ] **Step 7: Request code review and address findings**

Use `superpowers:requesting-code-review`. Re-run all affected focused tests after any review fix.

- [ ] **Step 8: Push and observe the no-secret Windows gate**

Push only after local verification. Record `git rev-parse HEAD`, push that exact commit, and inspect the triggered run with GitHub Actions/CLI. Confirm the checked-out SHA equals the recorded HEAD, the job uses Windows 2022, project Node 22, Node-24 actions, and passes without any Cloudflare secret access.

- [ ] **Step 9: Dispatch exactly one new remote soak**

Only after the Windows gate passes, dispatch one request with a new unique request ID and record the run URL, commit SHA, and request ID. Verify prepare succeeds; all six segment artifacts each report exactly 6,000 operations; the aggregate gate reports 36,000 operations with no `terminalFailure`; the primary cleanup artifact uses schema v2 and proves the exact temporary Worker disabled/deleted/absent; and the backstop completes with matching identity evidence. Never modify `stepstone.hogetsu.uk`, DNS, other Workers, or formal resources.
