# GitHub Remote DDS Soak Orchestration Design

## Purpose

Move the already implemented 22,000-operation remote DDS soak controller from a developer workstation to GitHub-hosted runners so that the validation does not depend on a local computer remaining online. This orchestration remains a temporary Plan A feasibility test. It does not deploy Stepstone to `stepstone.hogetsu.uk`, change DNS, or modify any production Worker.

## Chosen approach

Use one manually dispatched GitHub Actions workflow with sequential, resumable segment jobs. Each segment may complete at most 6,000 new seeded operations and has a four-hour, forty-five-minute soft deadline. At the observed remote-soak rate, the expected execution is four active segments of 6,000, 6,000, 6,000, and 4,000 operations. Six segment slots are available so slower hosted runners can stop safely at the soft deadline and continue in later slots. A slot that receives an already complete run validates and republishes its predecessor state without making DDS requests, so the gate always consumes the deterministic sixth state artifact.

The 6,000-operation limit aligns with three complete 2,000-operation Durable Object shards. The limit is a ceiling rather than a requirement: a segment may stop after its current completed operation when its deadline is reached. It must never abandon a request in flight merely to meet the soft deadline. Every durable completion remains the only authority for cursor advancement.

The workflow is `workflow_dispatch` only. Pushes, pull requests, schedules, and ordinary commits cannot create a temporary Worker or consume the Cloudflare deployment credential. A concurrency group permits only one remote DDS soak workflow at a time and does not cancel an in-progress run.

## Workflow lifecycle

### Preparation

The preparation job checks out the exact commit, installs the pinned project dependencies and native DDS baseline, runs the relevant local tests, derives an ephemeral remote test key, deploys a newly named `ss-dds-soak-*` Worker, and verifies the deployed version.

Before any deployment command can run, preparation derives an ownership attestation as HMAC-SHA-256 of the domain-separated repository, workflow name, run ID, run attempt, and commit SHA. The deterministic Worker name is `ss-dds-soak-gh-<run-id>-<attempt>-<attestation-prefix>`, where the twelve-character suffix makes the name unguessable without the Cloudflare token. Preparation first queries both Cloudflare Worker listings and refuses to continue if that exact name already exists.

After the collision check, preparation creates and successfully uploads a pre-deployment identity artifact. Its versioned schema contains the repository full name, trusted workflow name, run ID, run attempt, commit SHA, deterministic Worker name, full ownership attestation, and successful collision-check timestamp. The name and attestation are recomputed from GitHub event data and the repository secret; artifact content can never select an arbitrary deletion target. If cancellation occurs before this artifact finishes uploading, no deployment step has started. If it occurs afterwards, the cleanup backstop can derive and validate the one exact possible object even when the post-deployment artifact was never written.

Wrangler deploys the Worker with the full ownership attestation in the version's `workers/tag` annotation. The post-deployment verifier reads the deployed immutable version through the Cloudflare API and requires the same annotation. A current version with a missing or mismatched tag is never modified or deleted. A partially created exact-name service with no version may be deleted only when the trusted backstop recomputes the unguessable name and attestation and the pre-deployment artifact records the successful no-collision check.

After verification, preparation uploads a versioned deployment record containing the complete pre-deployment identity plus the exact workers.dev endpoint, deployment-manifest schema version, build ID, deployed version ID, generated Worker name, Wrangler version, Wasm and harness content hashes, and temporary configuration hash. The segment verifier requires equality for repository, workflow, run ID, attempt, commit, generated name, endpoint host, build, version, and all hashes before remote execution.

The deployment script remains responsible for deleting a partially created object when deployment or verification fails. The preparation job cannot publish a successful deployment record until deployment verification succeeds. It then creates `state-0`, a seven-day bootstrap artifact containing the verified deployment record and an orchestration-state manifest with disposition `READY`, workflow identity, deployment bindings, and no run directory. This is the only valid predecessor for segment 1.

### Segments

Segment jobs run sequentially. Each downloads the immutable deployment artifact and the latest run-state artifact, verifies that the artifacts and checked-out source refer to the same deployment build, and invokes the existing soak runner in new-or-resume mode.

The runner accepts two additional bounded-execution options:

- `--max-new-operations 6000` limits only newly completed seeded operations in the current process. Fixture and preflight recovery do not consume this count.
- `--deadline-ms 17100000` requests a graceful pause after four hours and forty-five minutes. The deadline is checked before beginning another seeded operation, never between the remote response and its durable local completion.

Every remote attempt retains the existing 60-second timeout and at most one same-identity retry, including its bounded retry delay. Native DDS subprocesses receive an explicit three-minute operation timeout. A segment job has a 355-minute GitHub timeout, leaving more than one hour after the soft deadline for the bounded in-flight operation, final checkpoint, compression, artifact upload, and failure cleanup.

A bounded segment is successful when it either reaches 22,000 total operations or writes a valid resumable checkpoint and reports a paused disposition. A terminal transport, parity, protocol, accounting, activation, or artifact-integrity failure remains a failed job and is never converted into a pause.

After every normal, paused, complete, or caught terminal-runner exit, the segment attempts to upload its resulting run directory as a uniquely named compressed artifact. Forced runner termination or infrastructure loss may prevent that upload; in that case the last successfully published predecessor remains the only recoverable state. The next slot downloads exactly the artifact named by its declared predecessor; it does not search for an arbitrary or newest artifact. A missing successor artifact fails the chain rather than falling back silently. The deployment manifest is carried separately and never changes between segments.

All six slots execute in order. Segment 1 accepts only the preparation job's `READY` `state-0` and creates the run directory in new mode. A slot receiving `COMPLETE` state performs integrity validation and republishes an unchanged successor artifact. Therefore slot `n` always consumes `state-<n-1>`, always attempts to publish `state-<n>`, and the gate always consumes `state-6`. Segment outputs have exactly three dispositions: `PAUSED` exits zero with a valid checkpoint and incomplete cursor, `COMPLETE` exits zero only at cursor 22,000, and `FAILED` exits nonzero with a terminal failure record when one can be written. Infrastructure loss without a final record is distinguished by the absent successor artifact.

### Gate and evidence

After the segment chain, the gate job verifies that the report has no terminal failure and that the completed cursor is exactly 22,000 before invoking the existing remote gate checker. An incomplete run is a workflow failure, not a partial pass.

The final deployment manifest, run directory, gate output, and cleanup result are retained for 30 days as evidence. Intermediate state artifacts are retained for seven days. Secrets are excluded from all artifacts. Failure to upload the final evidence or cleanup result keeps the workflow failed even if the computational gates passed; failure to upload an intermediate state prevents successor execution.

## Secret handling

GitHub repository secrets provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The workflow never prints them and does not write them to an artifact. The Cloudflare token is exposed only as step-scoped input to deployment, teardown, and the small inline key-derivation step; soak runner, test, compression, and artifact-action steps do not receive it.

Each job independently derives the same 32-byte base64url `DDS_REMOTE_TEST_KEY` from the Cloudflare token and the domain-separated workflow identity: repository full name, primary workflow run ID, and run attempt. The derivation uses HMAC-SHA-256 in an inline trusted workflow step, masks the derived value before exporting it to later steps, and removes the Cloudflare token from subsequent step environments. The derived key is never a job output, workflow output, file, report, cache, or artifact. A re-run attempt derives a distinct key and therefore performs a new deployment rather than attaching to an older attempt.

The temporary endpoint retains the existing two-factor gate: `DDS_REMOTE_TEST=true` and the derived request key. No Zone, DNS, custom-domain, KV, R2, or production route configuration is part of the workflow.

## Artifact integrity and recovery

The existing journal remains the source of truth for pending intents, completed operations, physical requests, remote accounting, and evidence. Resume revalidates its contiguous cursor, source hashes, deployment build ID, Worker version ID, request hashes, replay state, and accounting projections before issuing another request.

Artifacts are never merged. Every segment consumes one predecessor artifact and emits one successor artifact. Artifact names include the primary workflow run ID, run attempt, and segment number. The state manifest repeats the orchestration identity schema and binds the journal hash. A segment refuses an artifact whose repository, workflow, run ID, run attempt, commit SHA, Worker name, endpoint, deployment version, build ID, configuration hash, or journal hash does not match the verified deployment record and current GitHub context. This prevents a manual upload or an artifact from another run from being resumed accidentally.

The workflow does not use caches for mutable soak state. GitHub artifacts are used because each handoff is immutable and auditable. Compression reduces transfer size but does not alter the checked journal contents.

## Cleanup

Cleanup is identity-scoped and idempotent. It accepts only a versioned orchestration identity whose recomputed Worker name begins with `ss-dds-soak-`. Before any mutation, it resolves the exact-name object, recomputes the ownership attestation, reads all available immutable-version metadata, and validates the version ID, content/configuration hashes, and `workers/tag` when a verified deployment record or deployed version exists. A mismatch is a hard refusal. Only after those checks does it perform these steps:

1. Delete the exact Worker's `workers.dev` subdomain mapping through the Cloudflare API. Cleanup never deploys another version and therefore never changes the version identity it is checking.
2. Verify that the former endpoint returns 404 when it still resolves; DNS-level absence is also accepted after the mapping deletion.
3. Resolve the exact current Workers object by the recomputed generated name and, when available, the verified deployment version identity.
4. Delete only that immutable Worker object.
5. Confirm the exact identity is absent from both the current Workers object API and the legacy scripts listing.

An already absent exact object is cleanup success. With a verified post-deployment record, cleanup requires its exact version and content bindings before deletion. When cancellation happened before that record could be uploaded, cleanup accepts only the previously published pre-deployment identity, recomputes the unguessable name and attestation from the trusted triggering event and repository secret, requires the recorded pre-deployment no-collision check, and requires any deployed version to carry the matching ownership tag before it deletes at most the single exact-name object. A name mismatch, malformed identity, missing ownership tag on an existing version, or more than one exact candidate is a hard refusal before the subdomain or object is modified. Cleanup never deletes by prefix alone.

The primary workflow has an `always()` cleanup job that runs after gate success, segment failure, or ordinary job failure. A separate `workflow_run` completion workflow is the backstop for cancellation or runner loss. It triggers only for the exact primary workflow name and the `completed` event, uses `actions: read` and `contents: read` with no write permission, and downloads artifacts only from the triggering run ID and run attempt. Third-party actions are pinned by full commit SHA.

The backstop checks out cleanup code only from the repository default branch, never the triggering commit. It treats downloaded JSON and archives as untrusted data, never executes artifact content, recomputes the expected Worker name from trusted event fields, and permits deletion only after the pre-deployment identity matches those fields. It prefers the fully verified deployment record when present, but the pre-deployment record is sufficient for cancellation-safe exact-name cleanup. If neither identity artifact exists, no deployment step could have begun and cleanup performs no deletion.

The cleanup workflow records whether the exact object was already absent or was disabled and deleted. It does not enumerate or modify unrelated Workers beyond the read-only lists required to prove exact absence.

## Failure behavior

- Missing secrets, dependency installation failure, local test failure, or failed deployment stops before soak execution.
- Missing, ambiguous, corrupt, or cross-run artifacts stop the segment without issuing remote DDS calls.
- A soft deadline or 6,000-operation ceiling creates `PAUSED`, not a failure.
- A terminal soak error preserves and uploads the evidence, prevents later segments and gate execution, and proceeds to cleanup.
- If six segment slots do not reach 22,000 operations, the gate fails as incomplete and cleanup still runs.
- Forced termination may prevent a segment's `always()` upload; recovery then stops at the last successfully published predecessor instead of claiming a newer cursor.
- Cleanup failure is reported prominently and keeps the workflow red. The operator must retain the Cloudflare token until either primary or backstop cleanup confirms exact absence.
- Token revocation is a human step after cleanup confirmation; the workflow cannot revoke the credential that authorizes itself.

## Testing

Unit tests cover option validation, the 6,000-operation ceiling, deadline pauses, bounded native operations, no-op completion, and the rule that terminal failures cannot be converted to pauses. Tests also cover deterministic domain-separated key and ownership derivation without exposing the input secret, pre-deployment collision refusal, ownership-tag verification, the `READY` `state-0` producer, the pre-deployment and deployment artifact schemas, artifact-identity validation, cancellation between identity publication and deployment-record publication, idempotent exact cleanup, refusal without any Cloudflare mutation on identity or ownership mismatch, and absence confirmation through both Cloudflare listings.

Workflow contract tests parse the checked-in YAML and require manual dispatch only, non-cancelling concurrency, six ordered segment slots, explicit 355-minute job timeouts with a 285-minute soft deadline, immutable predecessor artifact names, deterministic sixth-artifact gate input, fixed retention periods, gate-before-cleanup ordering, an `always()` primary cleanup, a restricted `workflow_run` cleanup backstop, default-branch trusted cleanup code, and full-SHA third-party action pins.

The complete local Node test suite must pass before the workflow files are committed. The remote workflow itself is accepted only after a manually dispatched run reaches exactly 22,000 operations, passes every existing remote gate, uploads complete evidence, exits all runner jobs, and confirms the temporary Worker is absent from both Cloudflare APIs.

## Non-goals

This work does not deploy the Stepstone application, attach `stepstone.hogetsu.uk`, migrate Socket.IO or room state, alter the bridge rules, weaken DDS parity requirements, or treat equally optimal candidate-card enumeration differences as failures. It only makes the existing remote DDS feasibility gate durable across GitHub-hosted runner lifetimes.
