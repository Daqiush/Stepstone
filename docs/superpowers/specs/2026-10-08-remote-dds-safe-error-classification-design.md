# Remote DDS Safe Error Classification Design

## Goal

Make the GitHub Actions preflight failure actionable without exposing Cloudflare credentials, account identifiers, generated Worker identities, request URLs, or response bodies.

## Scope

The change applies to the identity-derivation CLI, the remote DDS deployment CLI, and their Cloudflare read-only preflight calls. It does not change Worker naming, ownership evidence, deployment authorization, cleanup authority, DNS, production resources, or the public Stepstone service.

## Design

Introduce a shared, small typed error contract with a fixed allowlist of public diagnostic codes. Internal code may retain a normal `Error` cause for tests and local control flow, but each CLI boundary prints only a complete constant line selected from a closed lookup.

The initial public codes are:

- `REQUIRED_CONFIG_MISSING`: the required account, token, or deploy-time remote test key is absent.
- `IDENTITY_INVALID`: the supplied identity is malformed or does not match the trusted derived identity.
- `API_AUTH_OR_PERMISSION`: Cloudflare explicitly reports authentication, authorization, or permission failure.
- `TEMPORARY_WORKER_COLLISION`: the exact generated temporary Worker name already exists.
- `API_RESPONSE_INVALID`: Cloudflare returns non-JSON or a response/pagination shape that cannot prove absence safely.
- `API_REQUEST_FAILED`: Cloudflare returns another unsuccessful response or the network request fails.
- `CLI_INPUT_INVALID`: required arguments or local identity JSON are invalid.
- `LOCAL_IO_FAILED`: a validated input cannot be read or a report/environment output cannot be written.
- `UNKNOWN`: an unclassified failure reaches the process boundary.

Each user-facing lookup value has exactly this form:

```text
Remote DDS deployment failed [CODE].
```

The renderer accepts a public code only from the designated error type and only when it is an exact member of the allowlist. It never interpolates an arbitrary `error.code`. Unknown values select the constant `UNKNOWN` line. No error message, stack, cause, HTTP response body, URL, account ID, token, Worker name, ownership tag, or request context is appended.

The identity-derivation CLI uses the same renderer. Consequently, an empty token fails as `REQUIRED_CONFIG_MISSING` before any derived key is printed or written. This closes the earlier workflow gap in which identity derivation ran before the deployment CLI.

## Classification Boundaries

The Cloudflare API wrapper classifies errors where response status and the parsed Cloudflare error list are available. Authentication and permission classification uses only status and known error-message categories for control flow; those source messages are never printed.

Classification precedence is fixed:

1. Missing local account, token, or required deploy-time key is `REQUIRED_CONFIG_MISSING` before a request is attempted.
2. A rejected `fetch` is `API_REQUEST_FAILED`.
3. HTTP 401 or 403 is `API_AUTH_OR_PERMISSION`, even if its body is not JSON.
4. For other statuses, an unparseable body where JSON is required is `API_RESPONSE_INVALID`.
5. A parsed Cloudflare error envelope that contains an authentication, authorization, permission, forbidden, or access-denied error is `API_AUTH_OR_PERMISSION`. This takes precedence over any simultaneous not-found error.
6. The existing explicit-absence predicate remains unchanged: only HTTP 400/404 with a non-empty error list consisting entirely of code `10007`, without conflicting auth, permission, or service-error text, proves absence.
7. Any other non-success HTTP/API envelope is `API_REQUEST_FAILED`. A malformed success or pagination shape is `API_RESPONSE_INVALID`.
8. `TEMPORARY_WORKER_COLLISION` is produced only by positive evidence: a successful exact-object response or an exact match in a fully validated list response.

For HTTP 200 with `success:false`, a valid auth/permission envelope maps to `API_AUTH_OR_PERMISSION`; another valid error envelope maps to `API_REQUEST_FAILED`; malformed `errors` or result metadata maps to `API_RESPONSE_INVALID`. A malformed 5xx body maps to `API_RESPONSE_INVALID`; a valid 5xx error envelope maps to `API_REQUEST_FAILED`.

The deployment preflight translates validation failures into the fixed identity/configuration codes. The CLI entry point maps any remaining error to `UNKNOWN` and renders only allowlisted codes, preventing a newly introduced internal error from leaking arbitrary text.

Actual throw sites map as follows:

| Source | Public code |
|---|---|
| Unknown, duplicate, missing, mixed-mode, or invalid GitHub-context CLI arguments | `CLI_INPUT_INVALID` |
| Missing/unreadable identity input path or invalid JSON | `CLI_INPUT_INVALID` |
| Parsed but malformed identity or trusted-identity mismatch | `IDENTITY_INVALID` |
| Missing account, token, or deploy-time remote test key | `REQUIRED_CONFIG_MISSING` |
| Explicit Cloudflare auth/permission response | `API_AUTH_OR_PERMISSION` |
| Positively proven exact-name collision | `TEMPORARY_WORKER_COLLISION` |
| Non-JSON response or invalid result/pagination schema | `API_RESPONSE_INVALID` |
| Network rejection or other valid unsuccessful API response | `API_REQUEST_FAILED` |
| Environment/report output write failure after valid inputs | `LOCAL_IO_FAILED` |
| Unrelated internal failure, including an unbranded or unknown error code | `UNKNOWN` |

The deployment process boundary also classifies failures from the Wrangler deploy,
secret-upload, and version commands as `API_REQUEST_FAILED`, or as
`API_AUTH_OR_PERMISSION` when the command diagnostics contain an authentication or
permission signal. An API diagnostic wrapped by an ownership refusal retains its
original public category at this boundary; the internal ownership-refusal type and
all fail-closed cleanup behavior remain unchanged. Direct library callers still
receive the original command or ownership error rather than a public renderer type.

Classification changes only the type of a thrown failure. It must not return absence for an error, broaden the explicit `10007` predicate, swallow or retag `OwnershipRefusal`, convert a failure into `null`, or authorize any deployment/deletion. The shared cleanup module retains its existing ownership-refusal flow.

## Testing

Tests must first demonstrate that the current generic output cannot expose the required category. They then cover:

1. missing account/token and missing deploy-time remote test key;
2. trusted identity mismatch;
3. explicit Cloudflare auth/permission failure;
4. exact-name collision;
5. invalid JSON or unsafe response shape;
6. generic API/network failure;
7. CLI argument, file/JSON input, local output, and unknown-error mappings;
8. the identity-derivation CLI with an empty token;
9. spawned CLI boundaries whose stderr equals exactly one allowed constant line and whose stdout is empty on failure;
10. assertions that output contains none of the supplied token, account ID, Worker name, URL, response-body, cause, or stack marker values;
11. mixed `10007` plus permission errors, malformed absence responses, and ownership refusal all retain zero deploy/delete calls and their existing fail-closed control flow.

Run the focused remote DDS deployment tests first, followed by the complete application and Worker test suites.

## Operational Result

The next GitHub Actions run will identify the failing category while retaining the current fail-closed behavior. No deployment occurs unless all existing absence and ownership checks succeed. The workflow needs no separate configuration step because both CLIs use the same safe renderer.
