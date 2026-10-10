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

Each external boundary converts internal exceptions into an allow-listed public diagnostic. Public output contains only the diagnostic code and stage; raw command output, URLs containing identity data, account identifiers, tokens, keys, filesystem paths, and response bodies remain private.

If rollback or temporary-directory cleanup also fails, it must not replace the original deployment failure. Cleanup failure is attached as secondary evidence and produces a separate safe suffix/code where needed. A successful deployment followed by local cleanup failure is reported as a local cleanup failure because no earlier primary error exists.

### 2. Bound every external operation

All Wrangler invocations use one shared child-process option set with explicit timeout, kill signal, UTF-8 decoding, and output buffer limit. The deploy and secret operations receive a longer deadline than the version query.

All Cloudflare management API calls and workers.dev probes receive an abort signal with an explicit timeout. Callers may inject a signal/timeout for tests. Timeout failures map to a stable public request-timeout diagnostic instead of `UNKNOWN`.

Timeouts are shorter than the surrounding GitHub job timeout and cleanup receives its own independent budget so a hung deployment cannot consume the cleanup window.

### 3. Make the runner environment deterministic

- Primary and backstop workflows both use `windows-2022`.
- GitHub-maintained actions are updated to pinned Node-24-compatible commit SHAs.
- Node remains explicitly configured as version 22 for project code.
- The workflow concurrency group enables `queue: max` so repeated manual requests wait instead of silently replacing an older pending run.
- A root `.gitattributes` fixes repository text assets used by hashing and baseline comparison to LF while preserving the vendored DDS Worker artifact's intentional treatment.
- Workflow contract tests execute PowerShell snippets with `pwsh`, matching the hosted runner shell.

### 4. Add a lightweight Windows native-DDS gate

A separate workflow runs on pull requests and pushes to `master`. It performs recursive checkout, Node 22 setup, `npm ci`, the Windows DDS build, the native DDS smoke test, command portability tests, and the focused deployment/workflow contract tests. It never receives Cloudflare secrets and never deploys a Worker.

This gate catches runner-image, Visual Studio, PowerShell, submodule, and native-linking regressions before the long manual soak is dispatched.

### 5. Cleanup safety

Cleanup remains identity-bound and fail-closed. No change may broaden deletion authority: only an exact `ss-dds-soak-` object matching the persisted run identity may be mutated. Primary cleanup and backstop cleanup use the same bounded request layer and the same public diagnostics.

The deployment workflow continues to publish the predeployment identity before any mutation. A deployment record is published only after immutable ownership and endpoint evidence are verified.

## Testing

Implementation follows red-green TDD with focused tests for:

- primary error surviving rollback/read/temporary-directory cleanup failures;
- every deployment stage producing an allow-listed safe code;
- Wrangler deploy, secret, and version calls receiving bounded options;
- Cloudflare API and workers.dev requests receiving abort signals;
- timeout classification without secret leakage;
- workflow runner labels, Node-24 action pins, `queue: max`, and the new no-secret Windows gate;
- LF-stable baseline comparison on a simulated CRLF checkout;
- PowerShell contract execution through `pwsh`.

After focused tests pass, run the complete application suite, Worker suite, command-portability suite, workflow contract tests, and native DDS smoke test. A new remote soak is dispatched only after local verification and code review.

## Rollout

1. Land diagnostics and timeout behavior.
2. Land workflow/action/EOL determinism and the Windows native gate.
3. Run the no-secret Windows gate on GitHub.
4. Dispatch one remote soak request and require successful deployment, six 6,000-operation segments, gate, primary cleanup, and cleanup backstop evidence.

No changes are made to `stepstone.hogetsu.uk`, DNS, formal Workers, or other Cloudflare resources.
