# Remote DDS Safe Error Classification Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic Remote DDS preflight failure with a fixed, non-sensitive diagnostic code that identifies the failing category without weakening any deployment or cleanup safety check.

**Architecture:** Add one dependency-free module that owns the branded diagnostic error type, the closed public-code allowlist, safe wrapping helpers, and complete constant output lines. Cloudflare request code assigns API categories at the point where status and validated envelopes are known; the identity and deployment CLIs translate local validation/I/O boundaries and render only the closed constants. Existing absence, ownership, deployment, and deletion decisions remain unchanged.

**Tech Stack:** Node.js 22 ESM, built-in `node:test`, existing PowerShell GitHub Actions workflow.

**Design:** `docs/superpowers/specs/2026-10-08-remote-dds-safe-error-classification-design.md`

---

## Chunk 1: Diagnostic Contract and Cloudflare API Classification

### Task 1: Add the closed public diagnostic contract

**Files:**
- Create: `scripts/remote-dds-public-errors.mjs`
- Create: `test/remote-dds-public-errors.test.js`

- [ ] **Step 1: Write failing contract tests**

Test the wished-for API:

```js
const {
  RemoteDdsDiagnosticError,
  diagnostic,
  publicDiagnosticCode,
  renderRemoteDdsFailure,
} = await import('../scripts/remote-dds-public-errors.mjs');

test('renderer accepts only branded allowlisted codes and emits a constant line', () => {
  const error = diagnostic('API_AUTH_OR_PERMISSION', new Error('token-marker'));
  assert.equal(error instanceof RemoteDdsDiagnosticError, true);
  assert.equal(publicDiagnosticCode(error), 'API_AUTH_OR_PERMISSION');
  assert.equal(renderRemoteDdsFailure(error), 'Remote DDS deployment failed [API_AUTH_OR_PERMISSION].');
  assert.equal(renderRemoteDdsFailure({ code: 'API_AUTH_OR_PERMISSION\nsecret-marker' }), 'Remote DDS deployment failed [UNKNOWN].');
});
```

Cover every approved code and assert that rendered output contains no cause message, stack, token, account, URL, Worker name, or response-body marker.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/remote-dds-public-errors.test.js`

Expected: FAIL because `scripts/remote-dds-public-errors.mjs` does not exist.

- [ ] **Step 3: Implement the minimal closed contract**

Create a frozen constant map containing complete output lines for:

```js
REQUIRED_CONFIG_MISSING
IDENTITY_INVALID
API_AUTH_OR_PERMISSION
TEMPORARY_WORKER_COLLISION
API_RESPONSE_INVALID
API_REQUEST_FAILED
CLI_INPUT_INVALID
LOCAL_IO_FAILED
UNKNOWN
```

Use a private module brand (not arbitrary `error.code`) in `RemoteDdsDiagnosticError`. `diagnostic(code, cause)` must reject non-allowlisted codes. `publicDiagnosticCode(error)` returns `UNKNOWN` unless the error is the designated branded type with exact membership. `renderRemoteDdsFailure(error)` performs only a closed-map lookup.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/remote-dds-public-errors.test.js`

Expected: all tests PASS with zero failures.

- [ ] **Step 5: Commit Task 1**

```bash
git add scripts/remote-dds-public-errors.mjs test/remote-dds-public-errors.test.js
git commit -m "feat: add safe remote DDS diagnostic contract"
```

### Task 2: Classify Cloudflare preflight failures at the response boundary

**Files:**
- Modify: `scripts/cloudflare-temporary-worker-api.mjs:14-57,152-158`
- Modify: `test/remote-dds-deployment-runner.test.js`

- [ ] **Step 1: Write failing API classification tests**

Add real `confirmExactAbsence` tests for:

- missing account/token → `REQUIRED_CONFIG_MISSING` with zero fetches;
- rejected fetch → `API_REQUEST_FAILED`;
- HTTP 401/403, including non-JSON → `API_AUTH_OR_PERMISSION`;
- mixed `10007` plus permission error → `API_AUTH_OR_PERMISSION`, never absence;
- malformed JSON on other statuses → `API_RESPONSE_INVALID`;
- valid non-auth unsuccessful envelope → `API_REQUEST_FAILED`;
- HTTP 200 with `success:false` and a valid auth envelope → `API_AUTH_OR_PERMISSION`;
- HTTP 200 with `success:false` and another valid error envelope → `API_REQUEST_FAILED`;
- HTTP 200 with `success:false` and malformed `errors`/result metadata → `API_RESPONSE_INVALID`;
- malformed successful result/pagination metadata → `API_RESPONSE_INVALID`;
- successful exact-object response → `TEMPORARY_WORKER_COLLISION`;
- exact match in fully validated list → `TEMPORARY_WORKER_COLLISION`.

For every failure, assert zero deploy/delete mutations. Keep the existing 10007-only absence cases passing unchanged.

- [ ] **Step 2: Run the focused API tests and verify RED**

Run: `node --test test/remote-dds-deployment-runner.test.js`

Expected: new assertions FAIL because current errors are untyped/generic.

- [ ] **Step 3: Implement minimal API classification**

Import `diagnostic` and add small helpers that:

1. validate local account/token and classify missing values;
2. wrap rejected fetches as `API_REQUEST_FAILED`;
3. check 401/403 before parsing JSON;
4. parse JSON and classify malformed bodies;
5. identify auth/permission envelopes without printing their content;
6. retain the current `explicitNotFound` predicate byte-for-byte in meaning;
7. classify invalid pagination/result shapes as `API_RESPONSE_INVALID`;
8. classify a positively proven existing exact object/list match as `TEMPORARY_WORKER_COLLISION` only inside `confirmExactAbsence`.

Do not catch or translate `OwnershipRefusal`; do not change any return value that proves absence or ownership. Add regression assertions that `findExactWorker` and `listLegacyExactScript` still return their normalized presence records and that ownership/cleanup reads still consume those records instead of treating ordinary presence as a collision.

- [ ] **Step 4: Run the focused API tests and verify GREEN**

Run: `node --test test/remote-dds-deployment-runner.test.js`

Expected: all deployment-runner tests PASS with zero failures.

- [ ] **Step 5: Run cleanup safety regressions**

Run: `node --test test/remote-dds-cleanup.test.js`

Expected: all cleanup tests PASS; ownership refusal and zero-deletion safeguards remain unchanged.

- [ ] **Step 6: Commit Task 2**

```bash
git add scripts/cloudflare-temporary-worker-api.mjs test/remote-dds-deployment-runner.test.js
git commit -m "feat: classify Cloudflare preflight failures"
```

## Chunk 2: Safe CLI Boundaries and End-to-End Verification

### Task 3: Classify and safely render identity-derivation failures

**Files:**
- Modify: `scripts/remote-dds-ci-identity.mjs:1-7,191-205`
- Modify: `test/remote-dds-ci-identity.test.js`

- [ ] **Step 1: Write failing spawned-CLI tests**

Spawn the actual identity CLI with an empty token and with invalid arguments. Also force `--github-env` append failure and `--identity-out` report-write failure using deterministic unwritable/invalid output targets. Require:

```js
assert.equal(result.status, 1);
assert.equal(result.stdout, '');
assert.equal(result.stderr, 'Remote DDS deployment failed [REQUIRED_CONFIG_MISSING].\n');
```

For invalid CLI/context inputs require `CLI_INPUT_INVALID`; for either output failure require `LOCAL_IO_FAILED`. Add marker values to arguments/environment and assert none appear in stdout/stderr. In particular, failure stdout must be empty: the derived-key mask line may be emitted only after both requested writes have succeeded.

- [ ] **Step 2: Run identity CLI tests and verify RED**

Run: `node --test test/remote-dds-ci-identity.test.js`

Expected: FAIL because the current CLI prints raw `error.message`.

- [ ] **Step 3: Implement minimal identity CLI translation**

Import `diagnostic` and `renderRemoteDdsFailure`. Split the current CLI into an exported async/sync callable boundary if necessary. Translate:

- invalid CLI/context → `CLI_INPUT_INVALID`;
- absent source token → `REQUIRED_CONFIG_MISSING`;
- environment/identity output write failure → `LOCAL_IO_FAILED`;
- unclassified failure → renderer fallback `UNKNOWN`.

On failure, emit exactly one constant stderr line and no stdout. Do not emit the derived-key mask before validation, successful derivation, and completion of both requested writes.

- [ ] **Step 4: Run identity tests and verify GREEN**

Run: `node --test test/remote-dds-ci-identity.test.js`

Expected: all identity tests PASS with zero failures.

- [ ] **Step 5: Commit Task 3**

```bash
git add scripts/remote-dds-ci-identity.mjs test/remote-dds-ci-identity.test.js
git commit -m "feat: safely classify remote DDS identity errors"
```

### Task 4: Classify and safely render deployment CLI failures

**Files:**
- Modify: `scripts/prepare-remote-dds-deployment.mjs:1-12,69-78,188-222`
- Modify: `test/remote-dds-deployment-runner.test.js`

- [ ] **Step 1: Write failing helper and spawned-CLI tests**

Test the real CLI process for exact stderr and empty stdout across deterministic local-boundary cases:

- missing account/token → `REQUIRED_CONFIG_MISSING`;
- invalid arguments, missing/unreadable input, invalid JSON → `CLI_INPUT_INVALID`;
- parsed malformed/mismatched identity → `IDENTITY_INVALID`;
- missing deploy-time remote test key → `REQUIRED_CONFIG_MISSING`.

Add dependency-injected unit tests for the exported process wrapper across non-spawnable boundaries:

- injected unbranded error → `UNKNOWN`;
- each branded Cloudflare diagnostic passes through unchanged;
- injected report-checkpoint write failure → `LOCAL_IO_FAILED`.

Every spawned test supplies unique secret/account/name/URL/body/stack markers and requires exact constant-only stderr.

- [ ] **Step 2: Run deployment CLI tests and verify RED**

Run: `node --test test/remote-dds-deployment-runner.test.js`

Expected: FAIL because the current process boundary always emits one generic sentence.

- [ ] **Step 3: Implement minimal local-boundary translation**

Import the shared contract. Translate only at known local boundaries:

- `parseDeploymentOptions` and GitHub-context validation → `CLI_INPUT_INVALID`;
- input file read/JSON parse → `CLI_INPUT_INVALID`;
- identity assertion/mismatch → `IDENTITY_INVALID`;
- missing account/token/key → `REQUIRED_CONFIG_MISSING`;
- report write → `LOCAL_IO_FAILED`; make `runDeploymentCli` use an optional injected checkpoint writer (defaulting to `writeReportCheckpoint`) so this boundary is tested without contacting Cloudflare.

Preserve branded API diagnostic errors. Export a small `runDeploymentProcess(args, env, dependencies, io)` wrapper whose injected `io.error` and exit-code sink make the actual top-level catch behavior deterministic in unit tests; the executable entry point calls that same wrapper. It writes exactly `renderRemoteDdsFailure(error)`, sets exit code 1, and never interpolates internal text.

- [ ] **Step 4: Run focused deployment tests and verify GREEN**

Run: `node --test test/remote-dds-deployment-runner.test.js`

Expected: all tests PASS with zero failures.

- [ ] **Step 5: Commit Task 4**

```bash
git add scripts/prepare-remote-dds-deployment.mjs test/remote-dds-deployment-runner.test.js
git commit -m "feat: report safe remote DDS deployment diagnostics"
```

### Task 5: Verify workflow contract and the complete project

**Files:**
- Modify only if a failing contract test proves necessary: `test/remote-dds-workflow-contract.test.js`
- Verify: `.github/workflows/remote-dds-soak.yml`
- Verify: `.github/workflows/remote-dds-soak-cleanup.yml`

- [ ] **Step 1: Verify workflow secret scoping and command contract**

Run: `node --test test/remote-dds-workflow-contract.test.js test/package-test-command.test.js`

Expected: all tests PASS; token references remain limited to the existing step-level environment maps.

- [ ] **Step 2: Run all application tests**

Run: `npm test`

Expected: all tests PASS with zero failures.

- [ ] **Step 3: Run all Worker tests**

Run: `npm run test:workers`

Expected: all tests PASS with zero failures.

- [ ] **Step 4: Run cross-platform command preflight**

Run: `npm run test:commands`

Expected: all tests PASS with zero failures.

- [ ] **Step 5: Inspect the final diff and sensitive-output invariant**

Run: `git diff --check HEAD~4..HEAD` and `git status --short`.

Expected: no whitespace errors; only planned files plus the pre-existing unrelated `dds` modification are present.

- [ ] **Step 6: Commit any test-only contract adjustment**

If and only if Step 1 required a test adjustment:

```bash
git add test/remote-dds-workflow-contract.test.js
git commit -m "test: enforce safe remote DDS diagnostics"
```

Do not push or start another remote soak until the user explicitly requests it.
