# Classic Browser Worker Transport and Preview Design

**Status:** Approved design; not implemented
**Date:** 2026-10-20
**Baseline:** `master` / `a2c2d5a86949650d09d4341f82c9323c3226b3ad`
**Target branch:** `codex/classic-worker-browser`

## 1. Goal

Connect the existing standard classic browser experience to the already validated Cloudflare Durable Object classic backend, then prove the complete website on a temporary `workers.dev` deployment that does not depend on the local Node server or the user's computer.

This milestone is an opt-in preview. The existing Node/Socket.IO path remains the default and continues to own every nonclassic mode and every deferred classic feature. The preview must not modify `stepstone.hogetsu.uk`, DNS, a custom route, another Worker, or any production resource.

## 2. Scope

### Included

- A browser transport configuration selected by an explicit URL query.
- A narrow classic transport interface with separate Node and Worker adapters.
- Standard classic room creation and joining.
- Worker-assigned N/E/S/W seats and an owner start action.
- Bidding, including Pass, Double, and Redouble.
- Passed-out boards.
- Play, follow-suit enforcement, declarer control of dummy, and trick completion.
- Scoring, DDS table delivery, ready-next voting, and the next deal.
- Session-scoped credentials, reconnect-token rotation, idempotent command retry, revision recovery, refresh recovery, and connection status UI.
- Same-origin static assets and APIs on one temporary `workers.dev` deployment.
- A high-entropy preview admission gate, global preview rate limits, and abandoned-seat cleanup.
- An untrusted-text rendering audit that closes stored-XSS paths before any public preview.
- A public-room feature flag that does not enable internal test hooks.
- GitHub Actions deployment, verification, evidence, manual cleanup, and a bounded cleanup backstop.

### Explicitly deferred

- Claims and claim voting.
- Viewing the previous trick and its voting flow.
- Bid explanation editing, questions, and answers.
- Teaching mode and owner-controlled seats.
- Free seat selection, leaving a seat, changing a seat, and owner kick.
- Spectator UI.
- Ultimate, problem, and complex modes.
- A production domain, DNS route, or permanent Worker deployment.
- A repeat of the completed long-running remote DDS soak.

The deferred features remain available on the default Node/Socket.IO path.

## 3. Approaches Considered

### Selected: explicit classic transport interface

The lobby and game controllers call a fixed classic-domain interface. A Node adapter translates those calls to the existing Socket.IO service, while a Worker adapter uses the room bootstrap HTTP API and native WebSocket protocol. The UI consumes normalized lobby/game state and transient effects rather than an arbitrary event emitter.

This keeps one set of pages, preserves the current production path, and makes the platform boundary visible and testable.

### Rejected: duplicate Worker-only pages

Copying the lobby, game page, and scripts would be initially direct but would create two frontends whose fixes and rule displays could diverge.

### Rejected: emulate Socket.IO over native WebSocket

Providing a fake generic `on`/`emit` object would reduce the first diff but hide meaningful differences in bootstrap, revision checks, token rotation, authoritative snapshots, and idempotent retry. The compatibility layer would become harder to reason about than an explicit interface.

## 4. Configuration and Activation

The initial entry URL is:

```text
https://<temporary-worker>.workers.dev/?transport=worker&endpoint=https://<temporary-worker>.workers.dev
```

The configuration module must:

1. Accept Worker mode only when `transport=worker` is present.
2. Parse `endpoint` as a URL and reject credentials, ports, paths other than `/`, queries, and fragments.
3. Require HTTPS and a `*.workers.dev` hostname for this milestone.
4. Require the endpoint origin to equal `window.location.origin` because the preview serves both assets and APIs.
5. Store only the validated mode and endpoint in `sessionStorage`.
6. Remove `transport` and `endpoint` from the visible URL with `history.replaceState` after successful parsing.
7. Fall back to Node mode when no Worker configuration is present.
8. Fail closed with a clear message when an explicit Worker configuration is invalid; it must not silently contact Node or a different endpoint.

No credential, reconnect token, test key, or Cloudflare token is accepted in the URL.

### 4.1 Preview admission

The temporary site is not an anonymous public game service. Before loading the application, it presents a minimal same-origin admission page. The tester enters a separate 32-byte base64url preview key that is already known to the tester and stored as a masked GitHub Actions secret. The deployment workflow passes that key to the temporary Worker as a secret binding; it is not derived from or equal to the Cloudflare API token.

The admission request sends the key once in an HTTPS POST body. The Worker compares it in constant time and returns a short-lived, `Secure`, `HttpOnly`, `SameSite=Strict` signed preview cookie whose expiry cannot exceed the deployment expiry. JavaScript never stores the preview key or cookie. The cookie is then sent automatically on same-origin asset, API, and WebSocket requests.

All application assets except the minimal admission shell, all room APIs, and every WebSocket upgrade require a valid preview cookie. Missing and invalid admission produce the same opaque response. The key and cookie are never accepted in a URL, printed in a workflow summary, logged, or persisted in an artifact.

The existing singleton lobby registry also enforces conservative deployment-wide fixed-window limits for admission attempts, room creation, and room joining. Limits are sized well above the four-client functional test but low enough to bound accidental loops or a leaked credential. Rate-limit failures use an opaque capacity response and do not reveal whether a room exists.

## 5. Browser Architecture

### 5.1 Modules

The browser receives four focused components:

- `classic-transport-config.js`
  - Validates, persists, and reports Node or Worker transport selection.
- `classic-transport.js`
  - Defines the fixed facade used by lobby and game controllers.
- `classic-node-transport.js`
  - Wraps the existing Socket.IO calls and events without changing the server contract.
- `classic-worker-transport.js`
  - Implements HTTP bootstrap, native WebSocket authentication, commands, snapshots, retry, and reconnect.

The exact filenames may change during implementation if the resulting dependency boundaries remain the same.

### 5.2 Facade

The facade is deliberately smaller than Socket.IO:

```text
createRoom({ displayName })
joinRoom({ roomCode, displayName })
startGame()
submitBid({ bid, alert, explain })
playCard({ card })
readyNextDeal()
disconnect()

onLobbyState(listener)
onGameState(listener)
onConnectionState(listener)
onTransientEffect(listener)
onError(listener)
```

The facade rejects methods that are unavailable for the active transport. It does not accept arbitrary event names.

### 5.3 Socket.IO loading

The HTML must no longer unconditionally request `/socket.io/socket.io.js`. The bootstrap loads Socket.IO only for Node mode. Worker mode uses browser-native `fetch`, `WebSocket`, Web Crypto, and `sessionStorage` and therefore works when no Node server exists.

### 5.4 Existing UI reuse

The current `G` rendering model and rendering functions remain. A focused snapshot applicator updates `G` from normalized Worker state and calls the existing renderers. Transient events produce only short-lived animation, toast, or sound effects.

Nonclassic scripts and pages are not refactored in this milestone.

### 5.5 Untrusted text rendering hard gate

Every server-originated or peer-originated string is untrusted, including display names, alert explanations, questions, answers, and future chat-like fields. Before a public preview is permitted, the shared lobby and classic game UI must be audited so those values reach the DOM only through `textContent`, text nodes, or a tested escaping helper. Untrusted text must never be interpolated into `innerHTML`, event-handler attributes, style attributes, or URLs.

This hardening applies to both Node and Worker transports because they share the same pages. Tests use malicious-but-valid values such as an SVG event-handler payload and verify that it is displayed as literal text, cannot create an element, cannot execute code, and cannot read `sessionStorage`.

## 6. Worker Lobby Semantics

The current Worker foundation binds identity and seat during bootstrap:

- The creator is `OWNER`, seat N.
- Player joins receive the first free seat in E, S, W order.
- A fifth player receives `ROOM_CAPACITY_EXCEEDED`.
- Spectator bootstrap remains a backend capability but is not exposed by this preview UI.

The Worker lobby therefore displays the assigned seat instead of the Node seat picker. In Worker mode it hides leave-seat, change-seat, and owner-kick controls. The owner can start only after all four player seats are occupied.

Creating or joining a session must cause connected clients to receive a refreshed membership snapshot. Membership may change without a classic game revision change, so clients accept a same-revision snapshot when its room identity is unchanged. A lower revision or different incarnation is never applied.

A newly allocated non-owner seat receives a short first-authentication deadline just as the owner already does. If that session does not complete WebSocket hello before the deadline, the seat and bootstrap authority are released and connected clients receive a membership refresh. `classic.start` counts four live authenticated player authorities rather than four merely allocated rows, so an abandoned HTTP join cannot make a room appear ready. Once a player has authenticated successfully, the existing reconnect grace and room lifecycle rules apply.

## 7. Authoritative State and Presentation

`room.snapshot` is the sole authoritative browser state. It supplies room identity, viewer identity, player names, the per-viewer classic state, visible hands, auction, current trick, score history, ready state, and DDS state.

Classic event frames are transient effects only:

- `classic.started`
- `classic.bidding-updated`
- `classic.bidding-ended`
- `classic.dummy-revealed`
- `classic.card-played`
- `classic.trick-ended`
- `classic.finished`
- `classic.ready-updated`
- `classic.dd-table-ready`

The transport orders and deduplicates effects by revision. A command sender may receive a reply snapshot before the broadcast event and final snapshot for the same revision; this must update state once and show an effect at most once. Reconnect applies the latest snapshot without replaying old animations.

A duplicate-command reply contains two intentionally different revision values: `payload.revision` is the revision at which that command originally committed, while `payload.snapshot.revision` is the current authoritative room state. The client matches the reply to the in-flight command by reply ID, uses `payload.revision` only as command-completion metadata, orders state exclusively by `payload.snapshot.revision`, and never creates a transient animation from a reply. This prevents a delayed retry from rolling the UI back or hiding a newer snapshot.

The normalized Worker game state must cover the existing classic core UI:

- board information and phase;
- viewer seat and player names;
- visible hands and dummy visibility;
- bidding history, current bidder, contract, declarer, dummy, and leader;
- current player and current trick;
- completed trick count and NS/EW totals;
- board scores, ready state, DDS state, and DDS table.

## 8. Identity, Token Rotation, and Reconnect

### 8.1 Session record

Worker identity is kept only in `sessionStorage`, scoped by endpoint and room:

```text
endpoint
roomCode
incarnation
sessionId
role
seat
currentReconnectToken
pendingTokenRotation
pendingCommand
latestRevision
```

It is never stored in `localStorage`, a URL, a log, analytics, or a visible error.

### 8.2 Bootstrap

Create and join requests use a cryptographically random 32-byte base64url reconnect token and a UUID request ID. The full bootstrap request is retained until a valid response is recorded. A timeout retry reuses the exact request ID and body so the server's bootstrap replay protection prevents duplicate sessions.

The returned room code, incarnation, session ID, role, and seat are validated before storage or connection.

### 8.3 Hello write-ahead rotation

Before sending a WebSocket hello, the client creates and persists a hello ID and next reconnect token in `pendingTokenRotation`. It promotes the next token only after `hello-ok`.

If the server rotates the token but the reply is lost, reconnect reuses the previous token, the same hello ID, and the same next token. This matches the server's exact replay contract and prevents credential loss.

### 8.4 Commands

Only one mutating command is in flight per tab. Each frame contains a unique command ID and the latest `expectedRevision`. Related controls remain disabled until a reply or a terminal error.

An interrupted command is retained and resent byte-for-byte with the same ID after authentication. A committed command returns its cached result rather than executing twice. A `REVISION_CONFLICT` applies the supplied authoritative snapshot and does not blindly replay an outdated user action.

### 8.5 Reconnect policy

Unexpected disconnects retry after approximately 0.5, 1, 2, 4, and 8 seconds, then at no more than one attempt per 10 seconds. Retries pause while the browser reports offline and resume immediately when it returns online.

Terminal handling is explicit:

- close 4401 `AUTH_INVALID`: clear this room credential and return to the lobby.
- close 4408 `AUTH_TIMEOUT`: preserve the current and pending rotation record, then retry the exact hello through the normal backoff; stop after the bounded consecutive-auth-timeout threshold and offer an explicit retry.
- close 4409 `SESSION_REPLACED`: stop reconnecting, clear the stale local room credential, and report that another page took over the session.
- close 4410 `ROOM_EXPIRED`: clear this room credential and report expiration.
- close 1002 or a protocol mismatch/malformed frame: preserve diagnostic metadata but stop automatic actions and report incompatibility.
- close 1000 after an intentional local disconnect: do not reconnect.
- close 1006 or another abnormal network loss: preserve the pending token rotation and pending command and retry normally.

Manual four-player validation uses independent browser contexts. Duplicating a tab may duplicate `sessionStorage`; the server's single-authority rule makes the latest authenticated copy replace the earlier one.

## 9. Public and Test Route Separation

The current `ROOM_FOUNDATION_TEST` flag must no longer be required for public room traffic.

The routing matrix becomes:

| Configuration | Player room routes | Internal room test bridge |
|---|---:|---:|
| neither flag | closed | closed |
| `ROOM_FOUNDATION_PUBLIC=true` | open | closed |
| `ROOM_FOUNDATION_TEST=true` | open | open |
| both flags | open | open; test environments only |

Player room routes are limited to:

```text
POST /api/rooms
POST /api/rooms/{three-digit-code}/join
GET  /api/rooms/{code}/{positive-incarnation}/ws
```

`/api/rooms/__test/registry` remains guarded only by `ROOM_FOUNDATION_TEST`. Public mode must return the same opaque 404 for every internal test path. Remote DDS harness routes must also remain disabled in the browser preview.

The preview additionally requires a valid admission cookie and same-origin browser requests for room POSTs and WebSocket upgrades. Origin validation is defense in depth and is never treated as authentication because a nonbrowser client can forge it.

## 10. Static Asset Boundary

The temporary Worker uses a Cloudflare static-assets binding backed by the existing `public` source tree, while the Worker fetch handler runs first for APIs and enforces a preview allowlist.

The allowlist contains only the standard classic pages and their required CSS, JavaScript, image, icon, and font dependencies. Direct requests for `ult.html`, `problem.html`, `complex.html`, or their mode-specific scripts return 404. The lobby also hides every unsupported mode entry in Worker mode.

The current pages load Google Fonts and an unpinned Lucide script from third-party CDNs. The preview must not execute third-party JavaScript in an origin that holds room credentials. Lucide is replaced with a pinned, locally served bundle whose license is retained. Fonts are either self-hosted from pinned licensed files or replaced with a system-font stack; the preview must not depend on Google Fonts. The same shared HTML remains valid on the Node path.

Preview HTML and unversioned scripts use conservative cache headers so a newly deployed build does not mix old markup with new transport code. API and WebSocket paths are never handled as assets.

## 11. Temporary Deployment

### 11.1 Dedicated workflow

A manually dispatched GitHub Actions workflow performs:

```text
tests
→ build preview asset inventory
→ derive unique ownership identity
→ confirm exact absence
→ deploy immutable Worker version
→ enable workers.dev only
→ verify ownership and version
→ run remote preview gate
→ publish endpoint and cleanup identity
```

The generated name is in a distinct family such as:

```text
ss-classic-preview-{run_id}-{run_attempt}
```

The generated Wrangler configuration removes custom routes and zone data, sets `workers_dev: true`, binds the approved static assets, and sets `ROOM_FOUNDATION_PUBLIC=true` plus an immutable `PREVIEW_EXPIRES_AT` timestamp no more than 24 hours after deployment. The high-entropy preview key is installed only as a secret binding. The configuration must not set `ROOM_FOUNDATION_TEST` or `DDS_REMOTE_TEST`.

The workflow uses the existing GitHub Cloudflare account/token secrets without printing or persisting them.

### 11.2 Deployment evidence

The trusted deployment record binds:

- repository, workflow, commit, run ID, and run attempt;
- Worker name and immutable object ID;
- deployed version ID and version metadata;
- local and remote configuration digests;
- static asset inventory digest;
- script ETag and `workers.dev` origin.
- the exact preview expiry timestamp.

The workflow summary may expose only the public preview URL and nonsecret build identity.

### 11.3 Remote gate

The remote gate verifies:

- the classic lobby and game documents and required assets are readable;
- access without the preview cookie is opaque and access with a valid admission succeeds;
- unsupported pages and internal test routes return 404;
- remote DDS harness routes remain inaccessible;
- no executable script or font is requested from a third-party origin;
- no custom route or domain exists;
- the served build/version matches the deployment record;
- a room can be created, four players can authenticate, one deterministic classic board can complete, all players can ready, and the next board can begin.

This is a functional gate, not another long DDS soak.

## 12. Cleanup

Deployment failure triggers immediate cleanup. A successful preview remains available for manual browser acceptance and can be removed by a dedicated manual cleanup workflow. A scheduled backstop also requests cleanup.

The 24-hour safety boundary does not rely on GitHub scheduling or continued Cloudflare API credentials. Every request checks the manifest-bound `PREVIEW_EXPIRES_AT`. At or after expiry, the Worker returns the same opaque 404 for the admission page, assets, APIs, and new WebSocket upgrades. Existing WebSockets are denied and closed before processing the next frame, so they cannot mutate or observe live state after expiry. GitHub cleanup remains responsible for deleting the inert Worker object and confirming absence.

Deletion is authorized only when all of these match the trusted deployment record:

- exact `ss-classic-preview-` family name;
- immutable Worker object ID;
- deployed version/ownership evidence;
- repository, workflow, run ID, and run attempt.

Cleanup disables the exact `workers.dev` exposure, deletes only the exact Worker object, and confirms absence through current and legacy Cloudflare APIs. It never scans a broad prefix and deletes matching objects. It must not modify `stepstone.hogetsu.uk`, DNS, routes, other Workers, or production resources.

## 13. Error Presentation

The browser maps stable protocol codes to concise user messages while retaining the code for tests and diagnostics. Expected categories include invalid input, room missing or expired, room full, session replaced, wrong phase, not the player's turn, invalid bid, card not held, must follow suit, revision conflict, and temporary service capacity.

Internal exception text, Cloudflare response bodies, stack traces, tokens, and persistence details are never displayed to users. Transient capacity or network errors offer reconnect/retry; authorization and expiration errors do not loop.

## 14. Verification Strategy

### 14.1 Browser transport tests

- Configuration parsing, validation, persistence, and URL cleanup.
- Node default and explicit Worker fail-closed behavior.
- Preview admission, signed-cookie expiry, rate limits, and secret non-disclosure.
- Random token encoding and bootstrap replay.
- Hello write-ahead rotation and lost-reply recovery.
- In-flight command replay and revision-conflict handling.
- Duplicate replies whose command revision is older than their authoritative snapshot revision.
- Close-code handling for 1000, 1002, 1006, 4401, 4408, 4409, and 4410.
- Snapshot ordering, same-revision membership refresh, and effect deduplication.
- Error-code mapping and terminal reconnect behavior.
- Worker-only UI feature hiding.
- Malicious display names and explanations rendered only as literal text.

### 14.2 Worker integration tests

- The public/test flag matrix and opaque test-path denial.
- Static asset allowlist and API-first routing.
- Deterministic seat allocation and capacity.
- Live lobby membership refresh, first-auth timeout cleanup, and live-seat start enforcement.
- Deployment-wide admission/create/join rate limits.
- Four-player standard-classic lifecycle and next deal.
- Refresh/reconnect, token rotation, idempotent retry, and revision conflict.
- Manifest-bound expiry for assets, HTTP APIs, WebSocket upgrades, and existing socket commands.

### 14.3 Regression gates

- Full Node test suite.
- Node server smoke test.
- Full Worker test suite.
- Wrangler dry-run bundle.
- Existing classic cross-platform parity suite.

The already completed 22,000/36,000-operation remote DDS soak is not repeated unless the Worker DDS implementation itself changes.

### 14.4 Manual browser acceptance

Four independent browser contexts authenticate through the preview admission page and verify that executable code, fonts, and application data load exclusively from the temporary Worker; all players see the lobby, the owner starts, private hands are correct, bidding including X/XX works, declarer controls dummy, a board scores with DDS, ready-next starts another board, and a mid-board refresh restores the correct private view while the local Node service is stopped.

## 15. Definition of Done

This milestone is complete only when:

- Node/Socket.IO remains the default and all Node regressions pass.
- Worker transport and integration tests pass.
- The temporary remote functional gate passes.
- Manual browser acceptance passes without a local Node process.
- Stored-XSS regression tests pass and no third-party executable script is loaded.
- The preview becomes inert at its manifest-bound expiry even if GitHub cleanup is unavailable.
- The exact temporary Worker is closed, deleted, and confirmed absent.
- `stepstone.hogetsu.uk`, DNS, custom routes, unrelated Workers, and nonclassic modes were not changed.
- No token or test secret was logged or committed.
- The worktree is clean and the reviewed changes are committed and pushed.

## 16. Rollout Boundary

This milestone ends after temporary preview validation and cleanup. Moving `stepstone.hogetsu.uk` or making Worker transport the default requires a separate explicit design and authorization after this evidence is complete.
