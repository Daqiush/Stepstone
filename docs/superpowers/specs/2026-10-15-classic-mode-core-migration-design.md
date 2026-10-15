# Classic Mode Core Migration Design

**Status:** Approved direction, implementation not started  
**Date:** 2026-10-15  
**Baseline:** `workers-room-foundation-v1` / `502d43d`  
**Branch:** `codex/migrate-classic-mode`

## 1. Goal

Move the standard four-player classic bridge game from process-local `server.js` mutations into one platform-neutral, deterministic state machine shared by the existing Node server and the Cloudflare `StepstoneRoom` Durable Object.

This milestone proves backend parity without changing the production website or opening a public Worker route. The existing Socket.IO browser remains on the Node adapter. A later milestone will switch the browser transport after the shared engine and Durable Object integration are stable.

## 2. Scope

### Included

- Standard four-player classic rooms with seats N/E/S/W.
- Starting a board after all four seats are occupied.
- Standard bidding, including Pass, Double, and Redouble.
- Passed-out boards.
- Declarer, dummy, opening leader, follow-suit, trick winner, and declarer-playing-dummy rules.
- Thirteen-trick completion and duplicate-style board scoring already used by Stepstone.
- Four-player ready voting and automatic start of the next board.
- Reconnect snapshots with per-seat hand privacy.
- Existing Node Socket.IO event compatibility for the included flow.
- Durable Object persistence, command idempotency, revision checks, hibernation recovery, and role authorization.
- Non-blocking DDS table calculation using each platform's existing DDS adapter.

### Explicitly deferred

- Teaching mode and owner-controlled seats.
- Claims and claim voting.
- Viewing the previous trick and its voting flow.
- Editing alerts, bid questions, and bid answers.
- Ultimate, problem, and complex modes.
- Browser transport changes.
- Public Worker routes, `workers.dev`, `stepstone.hogetsu.uk`, DNS, or production deployment.

Deferred Node features must continue to work as they do today. The Node adapter keeps their existing handlers outside the new core and projects the current classic state before every core command, so those handlers cannot create a second competing copy of game state.

## 3. Approaches Considered

### Selected: shared pure engine plus platform adapters

One pure engine owns rules and state transitions. Node and Durable Objects provide identity, persistence, randomness, DDS, and event delivery. This has the lowest divergence risk and lets the current Node website remain the compatibility oracle.

### Rejected: Worker-only rewrite

A separate Worker engine would produce two rule implementations. Fixes to bidding, scoring, or play legality would need to be synchronized manually and could silently diverge.

### Rejected: keep Node as the game authority

Proxying Worker requests to the current Node service would keep the local computer or another server in the runtime dependency chain, contradicting the goal of an independent Workers deployment.

## 4. Architecture

### 4.1 Pure classic engine

Create focused CommonJS modules under `classic/`. CommonJS matches the existing Node server and `complex-bridge.js`; Wrangler's bundler will consume the same modules from ESM Worker code, with a dry-run bundle test proving compatibility.

- `classic/rules.cjs`
  - Seats, suits, ranks, board cycle, bid ordering, partner/side helpers.
  - Bid validation, declarer selection, legal-card validation, trick winner, and score calculation.
  - No Node, Cloudflare, socket, clock, filesystem, process, or DDS imports.
- `classic/engine.cjs`
  - Creates and validates the serializable classic state.
  - Applies commands without mutating the input.
  - Returns the next state, stable domain events, and optional post-commit effects.
- `classic/views.cjs`
  - Produces immutable per-viewer snapshots.
  - Prevents disclosure of concealed hands, credentials, command cache data, or persistence metadata.

The core API is:

```js
applyClassicCommand(currentState, command, context)
// -> { ok: true, state, events, effects, reply }
// -> { ok: false, code, details? }
```

`command` contains only the validated command name and payload. `context` contains trusted adapter data:

```js
{
  actor: { role: 'OWNER' | 'PLAYER' | 'SPECTATOR', seat: 'N' | 'E' | 'S' | 'W' | null },
  occupiedSeats: ['N', 'E', 'S', 'W'],
  deal: { hands, boardInfo } | null
}
```

The adapter, not the client, supplies `deal`. Tests inject fixed deals. Node uses its existing shuffle semantics; the Worker uses `crypto.getRandomValues`. Given the same current state, command, and context, the core returns byte-equivalent JSON.

### 4.2 Canonical classic state

The engine state is JSON-serializable and contains only game data:

```js
{
  schemaVersion: 1,
  mode: 'classic',
  phase: 'LOBBY' | 'BIDDING' | 'PLAYING' | 'SCORING',
  dealNumber,
  boardInfo,
  hands,
  initialHands,
  readyStatus,
  biddingHistory,
  currentBidder,
  currentContract,
  consecutivePasses,
  declarer,
  dummy,
  leader,
  currentPlayer,
  currentTrick,
  completedTricks,
  nsTricks,
  ewTricks,
  dummyRevealed,
  boardScores,
  ddTable
}
```

Socket IDs, reconnect token hashes, session IDs, player names, pending lifecycle actions, and the Durable Object command cache remain outside the classic engine.

Node keeps the existing top-level room fields as canonical storage. Its adapter projects those fields into the engine and applies the returned fields back with an explicit allowlist. Durable Objects store the same engine state as `room_state.state_json.classic`.

### 4.3 Commands

The public game command allowlist is:

| Command | Actor | Valid phase | Result |
|---|---|---|---|
| `classic.start` | Owner | `LOBBY` | Requires all four occupied seats; starts bidding with a trusted deal. |
| `classic.bid` | Player/owner seat | `BIDDING` | Applies one legal bid and may finish bidding or pass out the board. |
| `classic.play` | Player/owner seat | `PLAYING` | Plays one legal card; declarer may act for dummy. |
| `classic.ready-next` | Player/owner seat | `SCORING` | Toggles that seat's readiness; four ready seats start the next deal. |
| `room.sync` | Any authenticated session | Any | Read-only per-viewer snapshot; no revision increment. |

Spectators cannot mutate state. Unknown command names fail closed. The old foundation counter mutation remains available only when `ROOM_FOUNDATION_TEST === 'true'` so existing infrastructure tests stay isolated from production behavior.

Commands continue to use the foundation envelope's command ID and `expectedRevision`. Exact retries return the cached compact reply. Conflicting reuse or stale revisions do not write or broadcast.

### 4.4 Events

The engine emits stable domain events in transition order:

- `classic.started`
- `classic.bidding-updated`
- `classic.bidding-ended`
- `classic.dummy-revealed`
- `classic.card-played`
- `classic.trick-ended`
- `classic.finished`
- `classic.ready-updated`
- `classic.dd-table-ready`

The Node adapter maps these events to the existing Socket.IO names and payload ordering (`gameStart`, `biddingUpdate`, `biddingEnd`, `playUpdate`, and so on). The Worker broadcasts protocol-versioned event frames plus a recipient-specific `room.snapshot` only after persistence commits.

Duplicate command delivery sends the cached reply and current snapshot but does not replay animation events such as `classic.card-played` or `classic.trick-ended`.

### 4.5 Viewer snapshots and privacy

`classicViewFor(state, viewer)` follows these rules:

- A seated player sees their own remaining hand.
- Declarer also sees dummy after dummy is revealed.
- All authenticated viewers see public bidding, current trick, completed trick count, trick totals, contract, board information, readiness, phase, and scoring history.
- Dummy's hand becomes public only after the opening lead.
- Spectators see public information but no concealed hands.
- No viewer sees another concealed hand, `initialHands`, DDS input data, session authority, token data, or command-cache data.

Node retains its current seat-specific bidding alert filtering. Worker snapshots apply the same rule: a player sees full alert details only for their own calls and opponents' calls; partner calls expose only seat and bid. Spectators receive bid, seat, alert flag, and explanation because they have no partnership role and are read-only.

## 5. Node Integration

Create `classic/node-adapter.js` with four responsibilities:

1. Project allowed classic fields from the existing room object.
2. Invoke the engine with the socket's authoritative seat and occupied seats.
3. Apply only engine-owned fields back to the room.
4. Translate domain events and effects into existing Socket.IO emissions and local DDS calls.

`server.js` delegates `startGame`, standard `bid`, standard `playCard`, passed-out/normal scoring, and standard `nextDeal` readiness to the adapter. Ultimate and teaching branches remain on their existing code paths. Existing claim and auxiliary classic handlers continue using the top-level room fields; an accepted claim invokes the engine's trusted settlement helper so scoring remains single-sourced.

The refactor is performed behavior-by-behavior with characterization tests before each delegation. The browser-visible event sequence and payloads are treated as compatibility requirements.

## 6. Durable Object Integration

Create `workers/src/room-foundation/classic-command.mjs` as the Worker adapter. `StepstoneRoom.handleCommand` keeps its existing authority, deduplication, revision, transaction, CAS, and post-commit broadcast flow, but delegates allowlisted classic commands to this adapter.

The adapter receives the authenticated session from the existing authority cache. It does not query SQL per command. Occupied seats come from the already reconstructed in-memory session authority map, preserving the measured one-row command SQL profile.

On successful mutation:

1. Build `proposed.classic` from the engine result.
2. Store the existing bounded command-cache entry in the same `room_state` JSON.
3. Enforce the 512 KiB serialized snapshot limit.
4. Commit with the existing revision/state JSON compare-and-swap.
5. Update the in-memory cache.
6. Send the actor's command reply.
7. Broadcast filtered events and snapshots.
8. Run non-blocking post-commit effects.

If any pre-commit step fails, no event is sent. If delivery fails after commit, the client's existing sync/retry path repairs the view without another state mutation.

## 7. DDS Effect

Starting a deal emits a `classic.compute-dd-table` post-commit effect containing the committed incarnation, deal number, and a copy of the initial hands. Node invokes `calcDDTable` as it does today.

The Worker invokes the existing embedded DDS Worker binding after commit. A successful response is applied only if the room incarnation and deal number still match, then persisted as a trusted internal update and broadcast as `classic.dd-table-ready`. A late response for an older board is discarded. DDS failure leaves `ddTable: null`, records no game failure, and does not block bidding, play, scoring, or the next board.

## 8. Error Model

The engine returns stable codes rather than transport-specific text:

- `CLASSIC_WRONG_PHASE`
- `CLASSIC_FORBIDDEN`
- `CLASSIC_SEATS_INCOMPLETE`
- `CLASSIC_NOT_YOUR_TURN`
- `CLASSIC_INVALID_BID`
- `CLASSIC_CARD_NOT_HELD`
- `CLASSIC_MUST_FOLLOW_SUIT`
- `CLASSIC_STATE_INVALID`

Node maps codes to its existing Chinese `appError` messages. Worker returns the code through the existing opaque command-error envelope. Malformed engine state fails closed as `SERVICE_CAPACITY`; it is never repaired by guessing or partially overwriting persisted state.

## 9. Persistence, Size, and Free-Plan Budget

- Every successful classic mutation updates exactly the existing single `room_state` row.
- No command-specific SQL table or index is added.
- The command cache remains bounded at 128 entries per session and 24 hours.
- The engine state is covered by the existing 512 KiB snapshot limit.
- One complete board has at most 52 play commands, a bounded monotonic bidding sequence, four ready commands, and one start command. This stays far below the already gated 1,000 ordinary commands per room.
- DDS completion adds at most one trusted state update and one DDS binding request per deal.
- Budget tests must include a maximum-length legal auction, all 52 plays, reconnect snapshots, and the DDS update while keeping the existing Free-plan gates green.

## 10. Testing Strategy

All implementation follows red-green-refactor.

### Pure unit tests

- Exact board cycle, scoring matrix, bid ordering, X/XX ownership, declarer selection, legal play, follow suit, trick winner, dummy control, passed-out board, and next-board readiness.
- Immutability and stable JSON output.
- Invalid and corrupted states fail closed.
- Viewer projections prove concealed-hand and partner-alert privacy.

### Node characterization and adapter tests

- Fixed deals exercise the current Socket.IO event order and payloads from start through scoring.
- Existing standard classic behavior remains byte-equivalent for supported payload fields.
- Claims still settle through the shared scorer without moving claim voting into the core command scope.
- Teaching, ultimate, problem, and complex routing remain on their prior paths.

### Durable Object integration tests

- Owner start authorization and four-seat requirement.
- Bidding/play/scoring through real Miniflare Durable Objects.
- Idempotent retries, stale revisions, CAS races, eviction/hibernation reconstruction, reconnect sync, and actor takeover.
- Recipient-specific snapshots prove no concealed-hand leakage.
- DDS late-result rejection and nonfatal failure.
- SQL accounting remains one state-row read/write per ordinary command.

### Build and regression gates

- `npm test`
- `npm run test:workers`
- `npm run simulate:workers-room-budget`
- `npx wrangler deploy --dry-run --config workers/wrangler.jsonc`

## 11. Acceptance Criteria

The milestone is complete only when:

1. Node standard four-player classic flow uses the shared engine and its existing browser tests pass without frontend changes.
2. The Durable Object executes the same fixed-deal command transcripts to byte-equivalent canonical classic states.
3. All illegal action and privacy tests pass.
4. Reconnect and hibernation restore the exact revision and seat-specific view.
5. DDS failure cannot prevent a board from completing.
6. Existing non-classic modes and deferred Node classic features remain passing.
7. Free-plan budget and Wrangler dry-run gates pass.
8. Worker room routes remain inaccessible unless the exact test gate is enabled.

## 12. Rollout Boundary

This branch stops after backend parity and test-gated Durable Object integration. It does not deploy a Worker or change the website. The next branch will implement the browser WebSocket adapter against this stable protocol, first under a temporary test endpoint and only later under the production domain.
