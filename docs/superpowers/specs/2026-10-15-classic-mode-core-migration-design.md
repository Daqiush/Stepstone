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
// -> { ok: true, state, events, effects, reply: { name, phase } }
// -> { ok: false, code }
```

Successful results always contain `events` and `effects` arrays, even when empty. Domain failures are data, never exceptions, and do not expose internal details. An unexpected exception is caught by the adapter and mapped to the platform's generic capacity error.

`command` contains only the validated command name and payload. `context` contains trusted adapter data:

```js
{
  actor: { role: 'OWNER' | 'PLAYER' | 'SPECTATOR', seat: 'N' | 'E' | 'S' | 'W' | null },
  occupiedSeats: ['N', 'E', 'S', 'W'],
  deal: { hands, boardInfo } | null
}
```

The adapter, not the client, supplies `deal`. Tests inject fixed deals. Node uses its existing shuffle semantics; the Worker uses `crypto.getRandomValues`. Given the same current state, command, and context, the core returns byte-equivalent JSON.

Validation ownership is closed and explicit:

- The transport parser validates the generic frame, protocol version, command ID, command name, revision type, the 8 KiB frame ceiling, and rejects unknown top-level envelope keys.
- The classic engine validates exact classic payload keys and types, the complete state invariant set, actor/phase/turn permissions, bid and card legality, and the trusted deal shape.
- Adapters construct `actor`, `occupiedSeats`, and `deal` only from server-owned identity and deal sources. No client field can override them.
- The view layer accepts only a validated engine state and a trusted viewer identity.

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
  claimSettlement,
  boardScores,
  ddTable,
  ddsStatus
}
```

The closed field contract is:

| Field group | Type and invariant | Reset/transition rule |
|---|---|---|
| `schemaVersion`, `mode` | Exactly `1` and `'classic'`. | Never changed by a command. |
| `phase` | One of `LOBBY/BIDDING/PLAYING/SCORING`. | Changes only through the transition table below. |
| `dealNumber`, `boardInfo` | In `LOBBY`, exactly `0` and `null`. In other phases, a positive safe integer plus the existing duplicate-board object. | Created by `classic.start` and incremented exactly once when all four seats ready the next board. |
| `hands`, `initialHands` | In `LOBBY`, exact N/E/S/W maps of empty arrays. In other phases, exact maps of unique legal cards that form the trusted 52-card deal when reconstructed with played cards. | `hands` loses one held card per play; `initialHands` is immutable for the deal and never enters a public view. |
| `readyStatus` | Exact N/E/S/W boolean map. | All false on deal start; only the actor's seat toggles in `SCORING`. |
| Auction fields | In `LOBBY`, empty history, null bidder/contract, and zero passes. Otherwise, array plus nullable bidder/contract and safe integer pass count. Each history entry has exact `{seat,bid,alert,explain,qa}` shape, where `alert` is `true` or `null`, `explain` is `null` or bounded text, and `qa` is an array of exact `{asker,question,answer,answerer}` records with nullable answer fields. Names remain adapter identity data and are joined only into targeted Node events/views. | Cleared on deal start; call fields update only by `classic.bid`; annotations update only through the compatibility helpers. |
| Play fields | In `LOBBY/BIDDING`, nullable seats, empty trick lists, zero totals, `dummyRevealed:false`, and `claimSettlement:null`. In `PLAYING`, trick totals equal completed tricks and claim settlement is null. In normal played `SCORING`, totals and completed tricks all equal 13. In claimed `SCORING`, totals sum to 13 while `claimSettlement:{claimer,tricksToWin,reason,completedAtClaim}` exactly accounts for the difference from the shorter completed-trick list. A passed-out board has zero play totals. All held/played cards still reconstruct the deal. | Initialized when bidding ends; updated only by legal play or accepted claim; cleared on the next deal. |
| `boardScores` | Existing serializable score-history shape. | Appended exactly once on passed-out or played-board completion. |
| `ddTable` | `null` or the validated DDS table shape. | Reset to `null` at deal start; filled only by a trusted matching DDS completion. |
| `ddsStatus` | Exactly `IDLE` in `LOBBY`; otherwise `PENDING/READY/FAILED`, with `READY` iff `ddTable` is valid. | `PENDING` at deal start; then exactly one of `READY` or `FAILED`; reset only by the next deal. |

The only public phase transitions are:

| From | Command/condition | To |
|---|---|---|
| `LOBBY` | `classic.start` with four occupied seats and a trusted deal | `BIDDING` |
| `BIDDING` | Three passes after a contract | `PLAYING` |
| `BIDDING` | Four opening passes | `SCORING` with one passed-out score entry |
| `PLAYING` | Thirteenth completed trick | `SCORING` with one played-board score entry |
| `SCORING` | Fourth ready seat, with next trusted deal supplied | `BIDDING` |

No other transition is legal. Scoring is guarded by the phase and history invariant so duplicate delivery cannot append a second result.

Socket IDs, reconnect token hashes, session IDs, player names, pending lifecycle actions, and the Durable Object command cache remain outside the classic engine.

Node keeps the existing top-level room fields as canonical storage. Its adapter projects those fields into the engine and applies the returned fields back with an explicit allowlist. Durable Objects store the same engine state as `room_state.state_json.classic`.

### 4.3 Commands

The public game command allowlist is:

| Command | Exact payload | Actor and phase | Result |
|---|---|---|---|
| `classic.start` | `{expectedRevision}` | Owner in `LOBBY` | Requires all four occupied seats; adapter supplies the trusted deal and starts bidding. |
| `classic.bid` | `{expectedRevision,bid,alert,explain}` | Seated player/owner in `BIDDING` | `bid` is `Pass`, `X`, `XX`, or a legal level/suit token; `alert` is boolean; `explain` is `null` or at most 500 Unicode scalar values and must be `null` when `alert` is false. |
| `classic.play` | `{expectedRevision,card:{suit,rank}}` | Seated player/owner in `PLAYING` | `suit` is exactly `S/H/D/C`; `rank` is an integer 2–14; declarer may act for dummy. |
| `classic.ready-next` | `{expectedRevision}` | Seated player/owner in `SCORING` | Toggles only the actor seat; on the fourth ready seat the adapter supplies the next trusted deal. |
| `room.sync` | `{}` | Any authenticated session in any phase | Read-only per-viewer snapshot; no revision increment. |

Spectators cannot mutate state. Unknown command names fail closed. The old foundation counter mutation remains available only when `ROOM_FOUNDATION_TEST === 'true'` so existing infrastructure tests stay isolated from production behavior.

Every object above rejects unknown or missing keys. `expectedRevision` is a nonnegative safe integer inside the command payload, matching the existing foundation protocol; the envelope continues to carry the command ID. Exact retries return the cached compact reply `{name,phase}` plus a freshly composed current snapshot. Conflicting ID reuse or stale revisions do not write or broadcast. The trusted deal is never accepted from a client payload.

### 4.4 Events

The engine emits stable domain events in transition order with exact payloads:

| Event | Payload |
|---|---|
| `classic.started` | `{dealNumber,boardInfo}` |
| `classic.bidding-updated` | `{biddingHistory,currentBidder,currentContract,consecutivePasses}` |
| `classic.bidding-ended` | `{contract,declarer,dummy,leader,biddingHistory}` |
| `classic.dummy-revealed` | `{dummy}` |
| `classic.card-played` | `{seat,card,currentTrick}` |
| `classic.trick-ended` | `{trick,winner,nsTricks,ewTricks}` |
| `classic.finished` | Passed out: `{reason:'passed-out',dealNumber,score}`; played: `{reason:'played',dealNumber,contract,declarer,nsTricks,ewTricks,score}`; accepted claim: `{reason:'claimed',dealNumber,contract,declarer,nsTricks,ewTricks,score,claim:{claimer,tricksToWin,reason}}`. |
| `classic.ready-updated` | `{readyStatus}` |
| `classic.dd-table-ready` | `{dealNumber,ddTable}`; emitted only by the trusted DDS completion path, not by a client command. |

Event payloads never carry `hands`, `initialHands`, trusted deal material, identity data, or command-cache data. Authorized hand changes are learned from the recipient-specific snapshot accompanying the persisted revision. `classic.bidding-updated` and `classic.bidding-ended` are internal full-state domain events; before delivery, both adapters call the same `classicEventFor(event, viewer)` projection used by `classicViewFor`. Its `biddingHistory` applies the self/opponent/partner/spectator filtering below, including Q&A fields. The Worker sends a separately serialized event frame to each authenticated recipient and never broadcasts one unfiltered auction frame to the room.

The Node adapter maps these events to the existing Socket.IO names and payload ordering (`gameStart`, `biddingUpdate`, `biddingEnd`, `playUpdate`, and so on). After persistence commits, the Worker sends each domain event as `{v:1,type:'event',name,payload:{revision,event}}`, followed by the existing recipient-specific `room.snapshot` frame. Command replies remain `{v:1,type:'reply',id,name,payload:{revision,snapshot}}`.

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

The Worker snapshot is an additive extension of the current foundation snapshot, with this exact outer shape:

```js
{
  schemaVersion, roomCode, incarnation, revision, status,
  foundationCounter, createdAt, expiresAt,
  viewer: { role, seat },
  playerNames: { N, E, S, W },
  classic: classicViewFor(state.classic, viewer)
}
```

Create and join already validate `displayName`; this milestone passes that value through the router, persists it as a non-null session column, and includes it in the reconstructed authority cache. `playerNames` is derived from that cache, so ordinary commands add no session-table read. One composer builds sync replies, stale-revision conflict snapshots, command reply snapshots, reconnect snapshots, post-commit broadcasts, and hibernation-restored snapshots; no parallel snapshot shape is permitted.

## 5. Node Integration

Create `classic/node-adapter.js` with four responsibilities:

1. Project allowed classic fields from the existing room object.
2. Invoke the engine with the socket's authoritative seat and occupied seats.
3. Apply only engine-owned fields back to the room.
4. Translate domain events and effects into existing Socket.IO emissions and local DDS calls.

`server.js` delegates `startGame`, standard `bid`, standard `playCard`, passed-out/normal scoring, and standard `nextDeal` readiness to the adapter only when `mode === 'classic' && !teachingMode`. Ultimate, problem, complex, and teaching branches remain entirely on their existing code paths.

Deferred Node-only classic features must not directly mutate engine-owned fields. Create `classic/node-compat.cjs` with pure, validated helpers over the same canonical state:

- `settleClassicClaim(state, { claimer, tricksToWin, reason })`
- `editClassicBidAnnotation(state, { seat, bidIndex, alert, explain })`
- `appendClassicBidQuestion(state, { bidIndex, asker, question })`
- `answerClassicBidQuestion(state, { bidIndex, qaIdx, answerer, answer })`
- `applyClassicDdsCompletion(state, { dealNumber, ddTable, failed })`

Each helper returns the same success/domain-failure shape as `applyClassicCommand`, including arrays and compact reply, and validates exact argument keys. Text fields use the existing 500-scalar bound; indices must be in range; only the original bidder may edit/answer; an asker cannot be the bidder or bidder's partner. Claim settlement is legal only in `PLAYING` and validates the remaining-trick partition. DDS completion is legal only for the matching pending deal and validates the table before setting `READY`; `{failed:true,ddTable:null}` sets `FAILED`.

Claim request/vote metadata stays adapter-owned; only an accepted claim calls `settleClassicClaim`, which records `claimSettlement` including `completedAtClaim`, awards the remaining tricks so totals reach 13, appends the score once, moves to `SCORING`, and emits `classic.finished` with `{reason:'claimed',dealNumber,contract,declarer,nsTricks,ewTricks,score,claim:{claimer,tricksToWin,reason}}`. Last-trick view/vote metadata stays adapter-owned and never changes canonical play state. Alert edits and bid Q&A call the matching compatibility helper, so `biddingHistory` is never mutated by a second implementation. Canonical Q&A stores seats but not names; the Node adapter joins names from `playerNames` into its current targeted Socket.IO messages. Annotation helpers emit no domain animation event and the shared snapshot reflects the stored result.

The Node DDS promise calls `applyClassicDdsCompletion` against the current projected room state when it settles. A mismatched/stale deal is a no-op. Success updates `ddTable/ddsStatus` and emits the existing compatible DD-table notification; final failure sets `FAILED` without a gameplay error. This is the only Node path permitted to mutate DDS fields.

The required Node traceability is:

| Current behavior | New owner | Compatibility evidence |
|---|---|---|
| `startGame` standard branch | Adapter + `classic.start` | Same deal semantics and `gameStart` payload/order. |
| Standard bid handler and `finishBidding` | Adapter + `classic.bid` | Same auction legality, passed-out result, declarer/dummy/leader, and emits. |
| Standard `playCard`, `processPlay`, `endGame` | Adapter + `classic.play` | Same dummy control, follow suit, trick order, totals, score, and emits. |
| Standard `nextDeal` readiness | Adapter + `classic.ready-next` | Same readiness messages and automatic next board. |
| Accepted claim | `node-compat.cjs` settlement helper | Existing vote UI plus single-source score transition. |
| Last-trick voting | Existing adapter metadata | Characterization proves canonical state is unchanged. |
| Alert edit / bid Q&A | `node-compat.cjs` annotation helpers | Existing filtered payloads preserved. |
| Reconnect | Shared view projection | Existing per-seat hand and alert visibility preserved. |

The refactor is performed behavior-by-behavior with characterization tests before each delegation. The browser-visible event sequence and payloads are treated as compatibility requirements.

## 6. Durable Object Integration

Create `workers/src/room-foundation/classic-command.mjs` as the Worker adapter. `StepstoneRoom.handleCommand` keeps its existing authority, deduplication, revision, transaction, CAS, and post-commit broadcast flow, but delegates allowlisted classic commands to this adapter.

The adapter receives the authenticated session, including persisted display name, from the existing authority cache. It does not query SQL per command. Occupied seats and player names come from the already reconstructed in-memory session authority map, preserving the measured one-row ordinary-command SQL profile.

On successful mutation:

1. Build `proposed.classic` from the engine result.
2. Materialize any recoverable effect as its bounded pending-action row; ordinary effects create no row.
3. Store the existing bounded command-cache entry in the same `room_state` JSON.
4. Enforce the 512 KiB serialized snapshot limit.
5. In one storage transaction, commit the revision/state compare-and-swap together with the pending-action upsert and alarm scheduling. A deal-start commit therefore cannot become visible without its DDS recovery record.
6. Update the in-memory cache.
7. Send the actor's command reply.
8. Broadcast filtered events and snapshots.
9. Start the recoverable action's immediate non-blocking attempt; the already committed alarm remains the crash/eviction backstop.

If any pre-commit step fails, no event is sent. If delivery fails after commit, the client's existing sync/retry path repairs the view without another state mutation.

## 7. DDS Effect

Starting a deal returns a `classic.compute-dd-table` effect and sets `ddsStatus: 'PENDING'`. Node invokes `calcDDTable` as it does today and discards a result whose deal number no longer matches.

For the Worker, DDS is a recoverable at-least-once internal action rather than an in-memory promise:

1. In the same transaction as the deal-start state, upsert one `pending_actions` row whose unique key is `(room incarnation, 'classic-dd-table')`, with a fresh opaque action ID, deal number, attempt `1`, and due time. Starting the next deal atomically replaces any older row. Do not duplicate hands in the row; the matching persisted `initialHands` is the trusted input.
2. Set or advance the Durable Object alarm to the earliest due action. After commit, also start an immediate best-effort attempt.
3. Call the existing embedded DDS Worker binding outside the state transaction.
4. On completion, enter the Durable Object's existing serialized mutation gate, open a new transaction, read the latest state and action, and require the same incarnation, action ID, deal number, and `ddsStatus: 'PENDING'`.
5. On success, apply the table to that latest state—never to the pre-await copy—set `ddsStatus: 'READY'`, delete the action, and atomically persist the trusted update at `revision + 1`. Then update the in-memory cache and broadcast `classic.dd-table-ready` plus recipient snapshots carrying the new revision.
6. A completion for an old action ID/deal/incarnation cannot delete its replacement and is simply discarded. If the matching stale action still exists because the room incarnation is ending, lifecycle cleanup may delete it. Repeated completion is idempotent because the matching action is absent or status is no longer pending.
7. Retry a failed call at 5 seconds and 30 seconds by updating only the still-matching action row. After attempt 3, use the same serialized mutation path to set `ddsStatus: 'FAILED'`, keep `ddTable: null`, delete the action, increment revision, and broadcast the new-revision snapshot. Gameplay never fails or blocks.
8. On eviction/restart the alarm reconstructs the pending action from storage, so no in-memory promise is required.

A player command that commits while DDS is in flight therefore cannot be overwritten: completion always merges into the latest persisted state under the matching action guard. Conversely, a command sent with the pre-DDS revision receives the existing revision-conflict response and authoritative snapshot, making every observable state change monotonic and distinguishable.

## 8. Error Model

The engine returns stable domain codes rather than transport-specific text:

- `CLASSIC_WRONG_PHASE`
- `CLASSIC_FORBIDDEN`
- `CLASSIC_SEATS_INCOMPLETE`
- `CLASSIC_NOT_YOUR_TURN`
- `CLASSIC_INVALID_BID`
- `CLASSIC_CARD_NOT_HELD`
- `CLASSIC_MUST_FOLLOW_SUIT`
- `CLASSIC_INVALID_DEAL_CONTEXT` (internal adapter/test diagnostic only; never returned to a client)

The mapping is closed:

| Failure class | Worker result | Node result |
|---|---|---|
| Malformed generic frame, classic payload, unknown/missing keys, or invalid type | Existing `INVALID_COMMAND` envelope | Existing matching input `appError`; no mutation. |
| Wrong phase, authorization, turn, bid, held card, or follow-suit rule | Matching public `CLASSIC_*` code | Existing Chinese `appError` text. |
| Corrupted persisted state, invalid trusted deal/context, unexpected exception, or serialized state over 512 KiB | Generic `SERVICE_CAPACITY`; no internal detail | Generic server error; diagnostic logged server-side. |
| DDS call/validation failure | No command error; retry/`FAILED` state only | No gameplay error; `ddTable` remains unavailable. |

Invalid state is never repaired by guessing or partially overwriting persisted data. Public clients never receive `CLASSIC_STATE_INVALID`, stack traces, SQL text, DDS bodies, or validation internals.

## 9. Persistence, Size, and Free-Plan Budget

- Every successful ordinary classic command updates exactly the existing single `room_state` row.
- One bounded `pending_actions` row and its due-time index are added for the recoverable DDS action; there is at most one classic DDS action per room.
- The command cache remains bounded at 128 entries per session and 24 hours.
- The engine state is covered by the existing 512 KiB snapshot limit.
- One complete board has at most 52 play commands, a bounded monotonic bidding sequence, four ready commands, and one start command. This stays far below the already gated 1,000 ordinary commands per room.
- DDS adds one action insert, alarm scheduling, up to three binding requests, one action delete, and one trusted state update per deal; these are modeled separately from ordinary client commands.
- Budget tests must include a maximum-length legal auction, all 52 plays, reconnect snapshots, eviction between deal start and DDS completion, three-attempt DDS failure, and successful DDS completion while keeping the existing Free-plan gates green.

## 10. Testing Strategy

All implementation follows red-green-refactor.

### Pure unit tests

- Exact board cycle, scoring matrix, bid ordering, X/XX ownership, declarer selection, legal play, follow suit, trick winner, dummy control, passed-out board, and next-board readiness.
- Valid `LOBBY` empty state and every phase-specific invariant, including card conservation and score-once behavior.
- Immutability and stable JSON output.
- Invalid and corrupted states fail closed.
- Viewer projections prove concealed-hand and partner-alert privacy.
- Compatibility helpers cover accepted claims, alert editing, Q&A authorization/schema, matching/stale DDS success, and DDS terminal failure.

### Node characterization and adapter tests

- Fixed deals exercise the current Socket.IO event order and payloads from start through scoring.
- Existing standard classic behavior remains byte-equivalent for supported payload fields.
- Claims still settle through the shared scorer without moving claim voting into the core command scope.
- DDS completion is applied to the latest room state, while stale completion is ignored and failure remains nonfatal.
- Teaching, ultimate, problem, and complex routing remain on their prior paths.

### Durable Object integration tests

- Owner start authorization and four-seat requirement.
- Bidding/play/scoring through real Miniflare Durable Objects.
- Idempotent retries, stale revisions, CAS races, eviction/hibernation reconstruction, reconnect sync, and actor takeover.
- Recipient-specific snapshots prove no concealed-hand leakage.
- DDS success racing a player command preserves both mutations with monotonically increasing revisions.
- DDS eviction recovery, old-action replacement, late-result rejection, retry exhaustion, and idempotent completion.
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
