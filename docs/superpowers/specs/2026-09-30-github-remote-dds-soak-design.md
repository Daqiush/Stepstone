# GitHub Remote DDS Soak Orchestration Design

## Purpose

Move the already implemented 22,000-operation remote DDS soak controller from a developer workstation to GitHub-hosted runners so that the validation does not depend on a local computer remaining online. This orchestration remains a temporary Plan A feasibility test. It does not deploy Stepstone to `stepstone.hogetsu.uk`, change DNS, or modify any production Worker.

## Chosen approach

Use one manually dispatched GitHub Actions workflow with sequential, resumable segment jobs. Each segment may complete at most 6,000 new seeded operations and has a five-hour soft deadline. At the observed remote-soak rate, the expected execution is four active segments of 6,000, 6,000, 6,000, and 4,000 operations. Six segment slots are available so slower hosted runners can stop safely at the soft deadline and continue in later slots. A slot that receives an already complete run exits successfully without making DDS requests.

The 6,000-operation limit aligns with three complete 2,000-operation Durable Object shards. The limit is a ceiling rather than a requirement: a segment may stop after its current completed operation when its deadline is reached. It must never abandon a request in flight merely to meet the soft deadline. Every durable completion remains the only authority for cursor advancement.

The workflow is `workflow_dispatch` only. Pushes, pull requests, schedules, and ordinary commits cannot create a temporary Worker or consume the Cloudflare deployment credential. A concurrency group permits only one remote DDS soak workflow at a time and does not cancel an in-progress run.

## Workflow lifecycle

### Preparation

The preparation job checks out the exact commit, installs the pinned project dependencies and native DDS baseline, runs the relevant local tests, derives an ephemeral remote test key, deploys a newly named `ss-dds-soak-*` Worker, and verifies the deployed version. It uploads a deployment artifact containing only the checked deployment manifest and non-secret endpoint metadata needed by later jobs.

The deployment script remains responsible for deleting a partially created object when deployment or verification fails. The preparation job cannot publish a successful deployment artifact until deployment verification succeeds.

### Segments

Segment jobs run sequentially. Each downloads the immutable deployment artifact and the latest run-state artifact, verifies that the artifacts and checked-out source refer to the same deployment build, and invokes the existing soak runner in new-or-resume mode.

The runner accepts two additional bounded-execution options:

- `--max-new-operations 6000` limits only newly completed seeded operations in the current process. Fixture and preflight recovery do not consume this count.
- `--deadline-ms 18000000` requests a graceful pause once five hours have elapsed. The deadline is checked before beginning another seeded operation, never between the remote response and its durable local completion.

A bounded segment is successful when it either reaches 22,000 total operations or writes a valid resumable checkpoint and reports a paused disposition. A terminal transport, parity, protocol, accounting, activation, or artifact-integrity failure remains a failed job and is never converted into a pause.

Each segment always uploads its resulting run directory as a uniquely named compressed artifact. The next slot downloads exactly the artifact named by its declared predecessor; it does not search for an arbitrary or newest artifact. The deployment manifest is carried separately and never changes between segments.

### Gate and evidence

After the segment chain, the gate job verifies that the report has no terminal failure and that the completed cursor is exactly 22,000 before invoking the existing remote gate checker. An incomplete run is a workflow failure, not a partial pass. The final deployment manifest, run directory, gate output, and cleanup result are retained as evidence. Secrets are excluded from all artifacts.

## Secret handling

GitHub repository secrets provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The workflow never prints them and does not write them to an artifact. The Cloudflare token is passed only to deployment and teardown processes.

Each job independently derives the same 32-byte base64url `DDS_REMOTE_TEST_KEY` from the Cloudflare token and the domain-separated workflow identity: repository full name, primary workflow run ID, and run attempt. The derivation uses HMAC-SHA-256, and the workflow masks the derived value before exporting it to later steps. The derived key is never a job output, workflow output, file, report, cache, or artifact. A re-run attempt derives a distinct key and therefore performs a new deployment rather than attaching to an older attempt.

The temporary endpoint retains the existing two-factor gate: `DDS_REMOTE_TEST=true` and the derived request key. No Zone, DNS, custom-domain, KV, R2, or production route configuration is part of the workflow.

## Artifact integrity and recovery

The existing journal remains the source of truth for pending intents, completed operations, physical requests, remote accounting, and evidence. Resume revalidates its contiguous cursor, source hashes, deployment build ID, Worker version ID, request hashes, replay state, and accounting projections before issuing another request.

Artifacts are never merged. Every segment consumes one predecessor artifact and emits one successor artifact. Artifact names include the primary workflow run ID, run attempt, and segment number. A segment refuses an artifact whose embedded workflow identity does not match its current run. This prevents a manual upload or an artifact from another run from being resumed accidentally.

The workflow does not use caches for mutable soak state. GitHub artifacts are used because each handoff is immutable and auditable. Compression reduces transfer size but does not alter the checked journal contents.

## Cleanup

Cleanup is identity-scoped and idempotent. It accepts only a verified deployment manifest whose Worker name begins with `ss-dds-soak-` and whose build and version bindings match the checked source. It performs these steps:

1. Disable the exact Worker's `workers.dev` public subdomain or deploy the existing closed test configuration.
2. Verify that an authenticated test-route probe returns the opaque 404 response when an endpoint still resolves.
3. Resolve the exact current Workers object by the manifest's generated name and version identity.
4. Delete only that immutable Worker object.
5. Confirm the exact identity is absent from both the current Workers object API and the legacy scripts listing.

An already absent exact object is cleanup success. A name collision, mismatched version, missing identity binding, or any additional candidate is a hard refusal rather than permission to delete broadly. Cleanup never deletes by prefix alone.

The primary workflow has an `always()` cleanup job that runs after gate success, segment failure, or ordinary job failure. A separate `workflow_run` completion workflow is the backstop for cancellation or runner loss. It downloads the primary run's verified deployment artifact by exact run ID and performs the same idempotent cleanup. If no successful deployment artifact exists, it performs no deletion because the deployment helper is already required to clean partial creation.

The cleanup workflow records whether the exact object was already absent or was disabled and deleted. It does not enumerate or modify unrelated Workers beyond the read-only lists required to prove exact absence.

## Failure behavior

- Missing secrets, dependency installation failure, local test failure, or failed deployment stops before soak execution.
- Missing, ambiguous, corrupt, or cross-run artifacts stop the segment without issuing remote DDS calls.
- A soft deadline or 6,000-operation ceiling creates a resumable pause, not a failure.
- A terminal soak error preserves and uploads the evidence, prevents later segments and gate execution, and proceeds to cleanup.
- If six segment slots do not reach 22,000 operations, the gate fails as incomplete and cleanup still runs.
- Cleanup failure is reported prominently and keeps the workflow red. The operator must retain the Cloudflare token until either primary or backstop cleanup confirms exact absence.
- Token revocation is a human step after cleanup confirmation; the workflow cannot revoke the credential that authorizes itself.

## Testing

Unit tests cover option validation, the 6,000-operation ceiling, deadline pauses, no-op completion, and the rule that terminal failures cannot be converted to pauses. Tests also cover deterministic domain-separated key derivation without exposing the input secret, artifact-identity validation, idempotent exact cleanup, refusal on identity mismatch, and absence confirmation through both Cloudflare listings.

Workflow contract tests parse the checked-in YAML and require manual dispatch only, non-cancelling concurrency, six ordered segment slots, explicit job timeouts greater than the five-hour soft deadline but no greater than GitHub's six-hour limit, immutable predecessor artifact names, gate-before-cleanup ordering, an `always()` primary cleanup, and a `workflow_run` cleanup backstop.

The complete local Node test suite must pass before the workflow files are committed. The remote workflow itself is accepted only after a manually dispatched run reaches exactly 22,000 operations, passes every existing remote gate, uploads complete evidence, exits all runner jobs, and confirms the temporary Worker is absent from both Cloudflare APIs.

## Non-goals

This work does not deploy the Stepstone application, attach `stepstone.hogetsu.uk`, migrate Socket.IO or room state, alter the bridge rules, weaken DDS parity requirements, or treat equally optimal candidate-card enumeration differences as failures. It only makes the existing remote DDS feasibility gate durable across GitHub-hosted runner lifetimes.
