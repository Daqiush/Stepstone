# GitHub Runner Hardening Design

## Goal

Make the Remote DDS Soak workflow deterministic on GitHub-hosted Windows runners and ensure every deployment or cleanup failure reports a safe, actionable stage without leaking Cloudflare credentials or test keys.

## Scope

This change covers the remote DDS deployment and cleanup scripts, their GitHub Actions workflows, byte-stable checkout policy, bounded external operations, and a lightweight Windows native-DDS CI gate.

The following audited issues are deliberately separate follow-ups because they do not participate in the remote soak control path:

- `spdsl-gen.js` temporary-file and shell invocation safety.
- The misleading custom `-BuildRoot` behavior in `scripts/build-windows-dds.ps1`.
- Windows ARM64 support and CRT linkage policy.

## Design

### 1. Preserve the primary deployment failure

Deployment is divided into named public stages: collision preflight, Wrangler deploy, deployed-ownership verification, secret upload, post-secret ownership verification, workers.dev subdomain lookup, immutable-version verification, endpoint verification, rollback discovery, rollback cleanup, and temporary-directory cleanup.

Each external boundary converts internal exceptions into an allow-listed public diagnostic. Deployment adds the stage-specific codes `WRANGLER_DEPLOY_FAILED`, `DEPLOYED_OWNERSHIP_UNVERIFIED`, `SECRET_UPLOAD_FAILED`, `POST_SECRET_OWNERSHIP_UNVERIFIED`, `SUBDOMAIN_LOOKUP_FAILED`, `IMMUTABLE_VERSION_UNVERIFIED`, `ENDPOINT_VERIFICATION_FAILED`, `ROLLBACK_DISCOVERY_FAILED`, `ROLLBACK_CLEANUP_FAILED`, and `TEMP_DIRECTORY_CLEANUP_FAILED`, while preserving the existing configuration, identity, collision, API-envelope, authorization, request, and local-I/O codes. Cleanup adds `CLEANUP_IDENTITY_INVALID`, `CLEANUP_OWNERSHIP_UNVERIFIED`, `CLEANUP_ENDPOINT_UNVERIFIED`, `CLEANUP_SUBDOMAIN_DISABLE_FAILED`, `CLEANUP_DELETE_FAILED`, `CLEANUP_ABSENCE_UNVERIFIED`, and `CLEANUP_RESULT_WRITE_FAILED`.

Timeouts use stage-specific codes rather than one generic timeout. Deployment uses `PREFLIGHT_TIMEOUT`, `WRANGLER_DEPLOY_TIMEOUT`, `DEPLOYED_OWNERSHIP_TIMEOUT`, `SECRET_UPLOAD_TIMEOUT`, `POST_SECRET_OWNERSHIP_TIMEOUT`, `SUBDOMAIN_LOOKUP_TIMEOUT`, `IMMUTABLE_VERSION_TIMEOUT`, `ENDPOINT_VERIFICATION_TIMEOUT`, `ROLLBACK_DISCOVERY_TIMEOUT`, or `ROLLBACK_CLEANUP_TIMEOUT`. Cleanup uses `CLEANUP_OWNERSHIP_READ_TIMEOUT`, `CLEANUP_SUBDOMAIN_LOOKUP_TIMEOUT`, `CLEANUP_SUBDOMAIN_DISABLE_TIMEOUT`, `CLEANUP_ENDPOINT_PROBE_TIMEOUT`, `CLEANUP_REVERIFY_TIMEOUT`, `CLEANUP_DELETE_TIMEOUT`, or `CLEANUP_FINAL_ABSENCE_TIMEOUT`.

Deployment public output is exactly `Remote DDS deployment failed [CODE].` followed, only when rollback also fails, by `Remote DDS rollback also failed [CODE].`. Cleanup public output is exactly `Remote DDS cleanup failed [CODE].`. Raw command output, URLs containing identity data, account identifiers, tokens, keys, filesystem paths, and response bodies remain private.

Error precedence is deterministic: the first deployment-stage failure is always primary; rollback discovery or rollback cleanup is secondary; temporary-directory cleanup is tertiary. Secondary and tertiary errors never replace an existing primary error. If deployment otherwise succeeds, temporary-directory cleanup becomes the primary `TEMP_DIRECTORY_CLEANUP_FAILED` error. If deployment fails and both rollback and directory cleanup fail, the deployment line is emitted first and only the rollback line is additionally emitted; directory cleanup remains an internal cause so public output stays bounded.

### 2. Bound every external operation

All Wrangler invocations use one shared child-process option set with UTF-8 decoding, `windowsHide: true`, `SIGTERM`, and a 4 MiB output buffer. Deploy and secret upload each have a 120-second timeout; the version query has a 15-second timeout. A timed-out synchronous child call must return control before classification; tests use a real bounded child to prove the Windows parent does not remain blocked.

Every Cloudflare management API request has a 30-second timeout. The workers.dev deployment probe and former-endpoint absence probe each have a 15-second timeout. An injected caller signal is composed with, rather than replaced by, the internal deadline, so either cancellation source stops the request. The boundary currently executing maps the timeout to its stage-specific code listed above.

The prepare job has an explicit 30-minute timeout, primary cleanup 20 minutes, backstop cleanup 20 minutes, and the no-secret native gate 30 minutes. Segment jobs retain the existing 355-minute job timeout and 285-minute internal operation deadline, leaving about 70 minutes for state publication and runner cleanup. Cleanup executes in a separate job and therefore receives an independent timeout budget even when prepare is exhausted.

### 3. Make the runner environment deterministic

- Primary and backstop workflows both use `windows-2022`.
- GitHub-maintained actions are updated to pinned Node-24-compatible commit SHAs.
- Node remains explicitly configured as version 22 for project code.
- The workflow concurrency group enables `queue: max` so repeated manual requests wait instead of silently replacing an older pending run.
- A root `.gitattributes` sets `* text=auto`, fixes `*.js`, `*.cjs`, `*.mjs`, `*.json`, `*.jsonc`, `*.yml`, `*.yaml`, `*.ps1`, `*.md`, `*.cpp`, and `*.h` to `text eol=lf`, and sets `*.wasm -text`. The existing `workers/vendor/bridge-dds/.gitattributes` remains authoritative for generated runtime artifacts and is strengthened so `dds-worker.mjs`, `dds-worker.wasm`, `LICENSE.bridge-dds`, and `LICENSE.dds` all explicitly use `-text -whitespace` and remain byte-for-byte unchanged.
- Workflow contract tests execute PowerShell snippets with `pwsh`, matching the hosted runner shell.

### 4. Add a lightweight Windows native-DDS gate

A separate workflow runs on pull requests and pushes to `master`. It performs recursive checkout, Node 22 setup, `npm ci`, the Windows DDS build, the native DDS smoke test, command portability tests, and the focused deployment/workflow contract tests. It never receives Cloudflare secrets and never deploys a Worker.

This gate catches runner-image, Visual Studio, PowerShell, submodule, and native-linking regressions before the long manual soak is dispatched.

### 5. Cleanup safety

Cleanup remains identity-bound and fail-closed. No change may broaden deletion authority. Authority is evaluated in three ordered gates:

1. Disabling workers.dev requires the exact generated `ss-dds-soak-` name derived from run context and token, a complete exact-object read, immutable Worker ID, complete version enumeration/detail reads, matching ownership tags, stable script ETag and version-configuration fingerprint, optional deployment-record equality, and a verified account subdomain that derives the exact expected endpoint.
2. Deleting the Worker additionally requires confirmed workers.dev disablement, HTTP 404 proof for that exact former endpoint, a fresh ownership snapshot identical to the pre-disable snapshot, re-verification of optional deployment evidence, and confirmation that the account endpoint derivation has not changed.
3. Declaring final absence additionally requires successful deletion response and exact absence from the exact-name, current Workers, and legacy scripts APIs.

At any gate, a timeout, malformed/partial response, identity mismatch, ownership drift, endpoint ambiguity, or snapshot change prevents every later mutation and prevents final absence from being asserted.

Cleanup artifacts move to schema version 2 and always contain the existing context/boolean fields plus `failureCode`. Successful `deleted`, `already-absent`, and `no-deployment-authorized` results have `failureCode: null`. Failed results have an allow-listed cleanup code and must keep `currentAbsent`, `legacyAbsent`, and any unconfirmed mutation boolean false. Primary and backstop workflows write and upload this safe failed result even when cleanup returns nonzero. If writing the detailed result fails, the workflow writes a fixed `CLEANUP_RESULT_WRITE_FAILED` fallback without reusing untrusted error text; the original cleanup diagnostic remains the first public log line.

The deployment workflow continues to publish the predeployment identity before any mutation. A deployment record is published only after immutable ownership and endpoint evidence are verified.

## Testing

Implementation follows red-green TDD with focused tests for:

- primary error surviving rollback/read/temporary-directory cleanup failures;
- every deployment stage producing an allow-listed safe code;
- Wrangler deploy, secret, and version calls receiving bounded options;
- Cloudflare API and workers.dev requests receiving abort signals;
- timeout classification without secret leakage;
- every cleanup stage producing an allow-listed code and schema-v2 failed evidence;
- zero later mutations after timeout, malformed evidence, ownership drift, or snapshot change;
- primary cleanup failure surviving result-writing failure and backstop fallback publication;
- workflow runner labels, Node-24 action pins, `queue: max`, and the new no-secret Windows gate;
- LF-stable baseline comparison on a simulated CRLF checkout;
- PowerShell contract execution through `pwsh`.

Workflow contract tests additionally assert explicit least-privilege permissions, the absence of all Cloudflare secret references in the native gate, and the stated job timeout margins.

After focused tests pass, run the complete application suite, Worker suite, command-portability suite, workflow contract tests, and native DDS smoke test. A new remote soak is dispatched only after local verification and code review.

## Rollout

1. Land diagnostics and timeout behavior.
2. Land workflow/action/EOL determinism and the Windows native gate.
3. Run the no-secret Windows gate on GitHub.
4. Dispatch one remote soak request and require successful deployment, six 6,000-operation segments, gate, primary cleanup, and cleanup backstop evidence.

No changes are made to `stepstone.hogetsu.uk`, DNS, formal Workers, or other Cloudflare resources.
