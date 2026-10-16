# Classic Mode Core Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move standard four-player classic bridge into one deterministic core used by the current Node/Socket.IO server and the Cloudflare Durable Object, without changing the browser transport or exposing a public Worker route.

**Architecture:** Pure CommonJS modules under `classic/` own validation, auction, play, scoring, compatibility mutations, and recipient views. Thin Node and Worker adapters provide identity, persistence, deal generation, DDS, and transport mapping. Durable Object commands remain revisioned/idempotent, while DDS is a persisted alarm-backed internal action.

**Tech Stack:** Node.js 22, CommonJS, Express, Socket.IO 4.7.4, Cloudflare Workers/Durable Objects, SQLite-backed DO storage, Miniflare, `node:test`, Wrangler 4.

**Reference spec:** `docs/superpowers/specs/2026-10-15-classic-mode-core-migration-design.md`

---

## File Structure

### Shared core

- Create `classic/constants.cjs`: frozen seats, suits, ranks, phases, bids, error codes, and state-field allowlists.
- Create `classic/rules.cjs`: side/partner helpers, board rotation, bid comparison/validation, declarer selection, legal-play validation, and trick winner.
- Create `classic/scoring.cjs`: the existing duplicate score calculation and immutable board-score construction.
- Create `classic/state.cjs`: empty-state/deal-state construction, deep cloning, exact validation, and card-conservation checks.
- Create `classic/engine.cjs`: strict command validation and deterministic command-to-state/event/effect transitions.
- Create `classic/views.cjs`: per-recipient state and event projection, including hand and auction privacy.
- Create `classic/node-compat.cjs`: accepted-claim, alert edit, Q&A, and Node DDS trusted updates.

### Node integration

- Create `classic/node-adapter.js`: project/apply canonical fields, invoke the core, map errors/events/effects.
- Modify `server.js`: delegate only `mode === 'classic' && !teachingMode` standard paths; keep other modes and teaching paths unchanged.
- Create `test/helpers/classic-fixtures.js`: deterministic full deals and command transcript builders.
- Create focused `test/classic-*.test.js` files for core, view, compatibility, adapter, and server behavior.

### Worker integration

- Create `workers/src/room-foundation/classic-command.mjs`: bridge parsed Worker commands to the shared core.
- Create `workers/src/room-foundation/classic-deal.mjs`: generate a trusted unbiased 52-card deal from Web Crypto after command preflight.
- Create `workers/src/room-foundation/room-view.mjs`: the single foundation/classic snapshot and event composer.
- Create `workers/src/room-foundation/classic-dds-action.mjs`: bounded action payloads, retry timing, completion guards, and DDS response validation.
- Modify `workers/src/room-foundation/{protocol,router,stepstone-room,budget-model,constants}.mjs` for commands, display names, snapshots, state transitions, action recovery, and budget accounting.
- Create focused `workers/test/room-classic-*.test.mjs` integration and privacy tests; extend existing protocol/budget/lifecycle tests.

## Closed Data and Failure Contracts Used by Every Chunk

- Canonical classic card: exact `{suit:'S'|'H'|'D'|'C',rank:'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'T'|'J'|'Q'|'K'|'A'}`. The Worker public protocol accepts integer rank 2–14 and `classic-command.mjs` converts it before calling the core; Node already uses symbols.
- Board info: exact `{number:1..16,dealNumber:positiveSafeInteger,vul:'NONE'|'NS'|'EW'|'BOTH',dealer:'N'|'E'|'S'|'W'}`.
- Contract: exact `{level:1..7,suit:'C'|'D'|'H'|'S'|'NT',seat:seat,doubled:boolean,redoubled:boolean,doublerSeat:seat|null}`.
- DDS table: exact 5-row (`S,H,D,C,NT`) × 4-column (`N,E,S,W`) integer matrix, each value 0–13.
- Passed-out persisted score: exact `{dealNumber,boardNumber,score:0,passedOut:true,ddTable,biddingHistory,initialHands}`.
- Played/claimed persisted score: exact `{dealNumber,boardNumber,passedOut:false,contract,declarer,dummy,declarerTricks,needed,score,made,diff,vulnerability,biddingHistory,completedTricks,initialHands,ddTable,claim}`, where `claim` is null or exact `{claimer,tricksToWin,reason}`. `initialHands` remains private canonical history for the existing Node SCORING replay mapper; `classicViewFor` always removes it from Worker/general reconnect snapshots.
- Engine/view/compatibility malformed input throws exported `ClassicInputError` with `kind:'CLIENT_INPUT'`; adapters map it to Worker `INVALID_COMMAND` or the existing Node input error.
- Corrupted canonical state or invalid trusted context/deal throws exported `ClassicInvariantError` with `kind:'TRUSTED_STATE'`; adapters map it to Worker `SERVICE_CAPACITY` or generic Node server error.
- Legal game-state failures return exact `{ok:false,code:'CLASSIC_*'}` and never throw.
- Normal success is exact `{ok:true,state,events,effects,reply:{name,phase}}`; stale DDS no-op uses reply `{name:'classic.dd-ignored',phase}`, success uses `classic.dd-completed`, and terminal failure uses `classic.dd-failed`.
- Public command replies are literal: start `{name:'classic.start',phase:'BIDDING'}`; bid `{name:'classic.bid',phase:'BIDDING'|'PLAYING'|'SCORING'}`; play `{name:'classic.play',phase:'PLAYING'|'SCORING'}`; ready `{name:'classic.ready-next',phase:'SCORING'|'BIDDING'}`.
- Compatibility success replies are literal: alert edit `{name:'classic.bid-annotation-edited',phase:'BIDDING'}`; question append `{name:'classic.bid-question-added',phase:state.phase}`; answer `{name:'classic.bid-question-answered',phase:state.phase}`.
- Classic view exact root keys are `{schemaVersion,mode,phase,dealNumber,boardInfo,readyStatus,biddingHistory,currentBidder,currentContract,consecutivePasses,declarer,dummy,leader,currentPlayer,currentTrick,completedCount,nsTricks,ewTricks,dummyRevealed,claimSettlement,boardScores,ddTable,ddsStatus,hands}`. `hands` is exact `{N:cards|null,E:cards|null,S:cards|null,W:cards|null}`; null means concealed. Score views use the sanitized score shapes above. Every view/event result is recursively detached from canonical state.
- Full auction entry is exact `{seat,bid,alert,explain,qa}` and Q&A entry is exact `{asker,question,answer,answerer}`. Partner projection is exact `{seat,bid}`.
- Every successful pure call is tested with `deepFreeze(input)`, before/after `JSON.stringify` equality, and detached-output mutation checks; running two byte-equal transcripts is an additional determinism assertion, not the mutation assertion.

Compatibility-helper failure mapping is closed:

| Helper | Condition | Exact failure |
|---|---|---|
| All five | Unknown/missing keys, wrong primitive type, invalid seat/index syntax, or text over 500 Unicode scalars | throw `ClassicInputError` |
| `settleClassicClaim` | State is not PLAYING, including repeated settlement | `{ok:false,code:'CLASSIC_WRONG_PHASE'}` |
| `settleClassicClaim` | `tricksToWin` cannot partition the remaining tricks | throw `ClassicInputError` |
| `editClassicBidAnnotation` | State is not BIDDING | `{ok:false,code:'CLASSIC_WRONG_PHASE'}` |
| `editClassicBidAnnotation` | Existing entry is not owned by `seat` | `{ok:false,code:'CLASSIC_FORBIDDEN'}` |
| `editClassicBidAnnotation` | `bidIndex` is outside history | throw `ClassicInputError` |
| `appendClassicBidQuestion` | `bidIndex` is outside history | throw `ClassicInputError` |
| `appendClassicBidQuestion` | Asker is bidder or bidder's partner | `{ok:false,code:'CLASSIC_FORBIDDEN'}` |
| `answerClassicBidQuestion` | Bid/QA index missing or already answered | throw `ClassicInputError` |
| `answerClassicBidQuestion` | Answerer is not original bidder | `{ok:false,code:'CLASSIC_FORBIDDEN'}` |
| `applyClassicDdsCompletion` | Malformed/invalid table from the trusted DDS boundary | throw `ClassicInvariantError`; adapter converts this attempt to the documented DDS failure/retry path |

## Chunk 1: Deterministic Shared Classic Core

### Task 1: Lock Existing Classic Semantics with Fixtures and Rule Tests

**Files:**
- Create: `test/helpers/classic-fixtures.js`
- Create: `test/classic-rules.test.js`
- Create: `classic/constants.cjs`
- Create: `classic/rules.cjs`
- Reference: `server.js:28-253`, `public/js/bridge-rules.js:1-126`

- [ ] **Step 1: Write a failing canonical-card fixture test**

Assert classic canonical cards are exact `{suit:'S'|'H'|'D'|'C', rank:'2'|'3'|...|'T'|'J'|'Q'|'K'|'A'}` objects. Assert `orderedDeal()` returns exact N/E/S/W arrays, 13 cards each, and 52 unique suit/rank keys.

- [ ] **Step 2: Run the fixture test and verify RED**

Run: `node --test test/classic-rules.test.js`

Expected: FAIL because fixture/constants modules are absent.

- [ ] **Step 3: Implement card constants and fixture helpers**

Export frozen `SEATS`, `SUITS`, `RANKS`, `RANK_VALUE`, and `PHASES`. Add `card`, `orderedDeal`, `cloneDeal`, and `auction` test helpers. The Worker adapter will later convert public integer ranks 2–14 to these symbols; the Node browser boundary keeps its existing symbols.

- [ ] **Step 4: Run the fixture test and verify GREEN**

Run: `node --test test/classic-rules.test.js`

Expected: the canonical-card/52-card fixture test passes.

- [ ] **Step 5: Write failing seat and board-cycle tests**

Table-drive `nextSeat`, `partnerOf`, `sideOf`, and all 16 exact `{number,dealNumber,vul,dealer}` results from the existing `BOARD_INFO` table.

- [ ] **Step 5R: Run seat/board tests and verify RED**

Run: `node --test test/classic-rules.test.js`

Expected: FAIL on missing seat/board helpers.

- [ ] **Step 6: Implement seat and board helpers**

Add pure `nextSeat`, `partnerOf`, `sideOf`, and `boardInfoFor(dealNumber)` with positive-safe-integer validation.

- [ ] **Step 7: Run seat/board tests and verify GREEN**

Run: `node --test test/classic-rules.test.js`

Expected: seat and 16-board-cycle tables pass.

- [ ] **Step 8: Write failing contract-order and X/XX tests**

Define canonical `currentContract` as exact `{level,suit,seat,doubled,redoubled,doublerSeat}`, with `doublerSeat:null|'N'|'E'|'S'|'W'`. Cover all denomination ordering, Pass, opponent-only X, declaring-side-only XX, repeated X/XX rejection, `1H-Pass-Pass-X`, and `1H-X-Pass-Pass-XX`; intervening passes do not cancel X/XX rights.

```js
test('redouble remains legal for the declaring side after intervening passes', () => {
  const state = auction('1H', 'X');
  assert.equal(validateBid(state, 'S', 'XX').ok, true);
  assert.equal(validateBid(state, 'E', 'XX').code, 'CLASSIC_INVALID_BID');
});
```

- [ ] **Step 8R: Run auction-rule tests and verify RED**

Run: `node --test test/classic-rules.test.js`

Expected: FAIL on missing bid parsing/validation.

- [ ] **Step 9: Implement bid parsing/comparison/validation**

Export `parseBid`, `bidValue`, and `validateBid`. Accept only `Pass`, `X`, `XX`, or `/^[1-7](C|D|H|S|NT)$/`; return documented domain codes for legal-state failures and throw only for malformed trusted state.

- [ ] **Step 10: Run auction-rule tests and verify GREEN**

Run: `node --test test/classic-rules.test.js`

Expected: contract ordering and X/XX tables pass.

- [ ] **Step 11: Write failing declarer-selection tests**

Assert the first player on the winning side who bid the final denomination becomes declarer, including later raises by partner and intervening doubles.

- [ ] **Step 11R: Run declarer tests and verify RED**

Run: `node --test test/classic-rules.test.js`

Expected: FAIL on missing `declarerFor`.

- [ ] **Step 12: Implement declarer selection and rerun**

Implement `declarerFor(history, finalContract)` and run `node --test test/classic-rules.test.js`; expected all declarer tables pass.

- [ ] **Step 13: Write failing legal-play and trick-winner tests**

Cover held-card checks, follow suit, declarer acting for dummy only on dummy's turn, and winner selection with/without trump and tied-invalid input.

- [ ] **Step 13R: Run play-rule tests and verify RED**

Run: `node --test test/classic-rules.test.js`

Expected: FAIL on missing play helpers.

- [ ] **Step 14: Implement play rules and rerun**

Implement `effectivePlaySeat`, `validatePlay`, and `trickWinner`; use `RANK_VALUE` rather than numeric coercion. Run the focused test; expected all cases pass.

- [ ] **Step 15: Run the complete focused file**

Run: `node --test test/classic-rules.test.js`

Expected: all fixture, seat, board, auction, declarer, legal-play, and winner tests pass.

- [ ] **Step 16: Commit**

```powershell
git add classic/constants.cjs classic/rules.cjs test/helpers/classic-fixtures.js test/classic-rules.test.js
git commit -m "feat: extract classic bridge rules"
```

### Task 2: Define Canonical State and Duplicate Scoring

**Files:**
- Create: `classic/state.cjs`
- Create: `classic/scoring.cjs`
- Create: `test/classic-state.test.js`
- Create: `test/classic-scoring.test.js`
- Reference: `server.js:122-189`, `server.js:254-328`, `server.js:685-829`, `server.js:872-925`

- [ ] **Step 1: Write a failing exact LOBBY-state test**

Import planned `createClassicLobbyState()` and assert every key/value from the design: `dealNumber:0`, `boardInfo:null`, empty N/E/S/W hands, all readiness false, cleared auction/play/claim fields, empty scores, `ddTable:null`, and `ddsStatus:'IDLE'`.

- [ ] **Step 2: Run the LOBBY-state test and verify RED**

Run: `node --test test/classic-state.test.js`

Expected: FAIL with missing `createClassicLobbyState`.

- [ ] **Step 3: Implement the exact LOBBY constructor**

Export `createClassicLobbyState()` and `CLASSIC_STATE_KEYS`. Construct every nested object/array freshly; freeze only constants, not returned state.

- [ ] **Step 4: Run the LOBBY-state test and verify GREEN**

Run: `node --test test/classic-state.test.js`

Expected: exact LOBBY test passes.

- [ ] **Step 5: Write a failing initialized-deal test**

Define `createClassicDealState(previous, {hands,boardInfo})`. Assert `boardInfo` is exact `{number:1..16,dealNumber:positive safe integer,vul:'NONE'|'NS'|'EW'|'BOTH',dealer:seat}`; state is BIDDING/PENDING with 52 canonical cards, false readiness, dealer as current bidder, and cleared per-deal fields while preserving copied `boardScores`.

- [ ] **Step 5R: Run initialized-deal test and verify RED**

Run: `node --test test/classic-state.test.js`

Expected: FAIL because `createClassicDealState` is absent.

- [ ] **Step 6: Implement initialized-deal construction**

Implement the minimal constructor using `boardInfoFor` and cloned hands. Run the state test; expected the deal-state case passes.

- [ ] **Step 6G: Run initialized-deal test and verify GREEN**

Run: `node --test test/classic-state.test.js`

Expected: LOBBY and initialized-deal cases pass.

- [ ] **Step 7: Write failing exact-key/card-conservation tests**

For planned `validateClassicState(state)`, assert `{ok:true}` for valid LOBBY/BIDDING and `ClassicInvariantError` for an unknown root key, unknown card key, numeric classic rank, duplicate/missing card, invalid phase, unsafe counter, or `READY` with null DDS table.

- [ ] **Step 7R: Run exact-key/card tests and verify RED**

Run: `node --test test/classic-state.test.js`

Expected: FAIL because `validateClassicState` is absent.

- [ ] **Step 8: Implement root/nested exact-key validation**

Use explicit key arrays plus `Object.hasOwn`. Validate canonical card/board/contract/history/Q&A schemas and DDS status/table coupling. Run the state test; expected these cases pass.

- [ ] **Step 8G: Run exact-key/card tests and verify GREEN**

Run: `node --test test/classic-state.test.js`

Expected: exact-key, card, DDS coupling, and valid-state cases pass.

- [ ] **Step 9: Write failing phase-invariant tests**

Cover BIDDING empty tricks, PLAYING assigned seats and trick-total equality, normal SCORING with 13 completed tricks, claimed SCORING with `claimSettlement.completedAtClaim`, passed-out SCORING, card reconstruction, and exactly one latest score record for the finished deal.

- [ ] **Step 9R: Run phase-invariant tests and verify RED**

Run: `node --test test/classic-state.test.js`

Expected: FAIL on at least one unimplemented phase invariant.

- [ ] **Step 10: Implement phase-specific invariants**

Add closed per-phase branches; never repair or coerce invalid persisted state. Run the state test; expected every corruption case throws.

- [ ] **Step 10G: Run phase-invariant tests and verify GREEN**

Run: `node --test test/classic-state.test.js`

Expected: every valid phase passes and every corruption case throws `ClassicInvariantError`.

- [ ] **Step 11: Write failing base score tests**

Table-drive undoubled partscore/game/slam, vulnerable/nonvulnerable made/down results against current `calcScore`.

- [ ] **Step 11R: Run base scoring tests and verify RED**

Run: `node --test test/classic-scoring.test.js`

Expected: FAIL because `calculateDuplicateScore` is absent.

- [ ] **Step 12: Implement `calculateDuplicateScore` base cases**

Port current formulas without room access. Run `node --test test/classic-scoring.test.js`; expected base table passes.

- [ ] **Step 12G: Run base scoring tests and verify GREEN**

Run: `node --test test/classic-scoring.test.js`

Expected: all undoubled base rows pass.

- [ ] **Step 13: Add failing doubled/redoubled score tests**

Cover insult, doubled/redoubled overtricks, and the nonvulnerable/vulnerable undertrick ladders.

- [ ] **Step 13R: Run doubled scoring tests and verify RED**

Run: `node --test test/classic-scoring.test.js`

Expected: FAIL on doubled/redoubled rows not yet implemented.

- [ ] **Step 14: Complete doubled/redoubled scoring**

Implement only the missing branches and rerun the scoring file; expected all matrix rows pass.

- [ ] **Step 14G: Run doubled scoring tests and verify GREEN**

Run: `node --test test/classic-scoring.test.js`

Expected: the complete scoring matrix passes.

- [ ] **Step 15: Write failing immutable board-score-shape tests**

Define exact finish inputs: `{type:'passed-out'}`, `{type:'played'}`, and `{type:'claimed',claim:{claimer,tricksToWin,reason}}`. Assert `buildBoardScore(state, finish)` returns the current persisted fields, copies histories/tricks/hands, includes DDS, and does not mutate state.

- [ ] **Step 15R: Run board-score tests and verify RED**

Run: `node --test test/classic-scoring.test.js`

Expected: FAIL because `buildBoardScore` is absent.

- [ ] **Step 16: Implement `buildBoardScore`**

Reject unknown finish keys/types. Preserve the current score sign convention and claim metadata. Rerun state/scoring tests; expected all pass.

- [ ] **Step 16G: Run board-score tests and verify GREEN**

Run: `node --test test/classic-state.test.js test/classic-scoring.test.js`

Expected: exact persisted score shapes, detachment, and immutability pass.

- [ ] **Step 17: Commit**

```powershell
git add classic/state.cjs classic/scoring.cjs test/classic-state.test.js test/classic-scoring.test.js
git commit -m "feat: define classic state and scoring"
```

### Task 3: Implement Auction State Transitions

**Files:**
- Create: `classic/engine.cjs`
- Create: `test/classic-engine-auction.test.js`
- Modify: `classic/state.cjs`
- Modify: `classic/scoring.cjs`

- [ ] **Step 1: Write failing generic command/context validation tests**

For `preflightClassicCommand(state, command, context)` and `applyClassicCommand(state, command, context)`, reject unknown/missing command/context keys, invalid roles/seats, and spectator mutation. Assert thrown internal corruption is distinct from `{ok:false,code}` domain failure. Preflight accepts exact context `{actor,occupiedSeats}` and returns either the same domain failure or exact `{ok:true,needsDeal:boolean,nextDealNumber:number|null}` without changing state; apply accepts exact `{actor,occupiedSeats,deal}`.

- [ ] **Step 1R: Run dispatch validation tests and verify RED**

Run: `node --test test/classic-engine-auction.test.js`

Expected: FAIL because both command entry points are absent.

- [ ] **Step 2: Implement generic dispatch validation**

Implement one internal validator/dispatcher used by both exported functions, so payload/authorization/phase logic cannot diverge. Accept only exact `{name,payload}` plus the context shapes above. Return `needsDeal:true` only for a legal `classic.start` or legal fourth `classic.ready-next`; otherwise return false. Route only documented names and return `CLASSIC_FORBIDDEN` for spectator mutation. `applyClassicCommand` runs this same preflight before applying with its trusted deal.

- [ ] **Step 2G: Run dispatch validation tests and verify GREEN**

Run: `node --test test/classic-engine-auction.test.js`

Expected: both entry points agree on malformed/domain failures; malformed command throws `ClassicInputError`, malformed trusted context/state throws `ClassicInvariantError`, spectator mutation returns `CLASSIC_FORBIDDEN`, and deal need/number is exact.

- [ ] **Step 3: Write failing `classic.start` payload/authorization tests**

Require exact `{expectedRevision}` with a nonnegative safe integer, owner role, LOBBY, all four seats, and a trusted valid deal. Cover unknown/missing keys, invalid revision type, wrong phase, incomplete seats, and invalid deal context.

- [ ] **Step 3R: Run start tests and verify RED**

Run: `node --test test/classic-engine-auction.test.js`

Expected: FAIL on unimplemented `classic.start`.

- [ ] **Step 4: Implement `classic.start` validation and transition**

Return BIDDING state, exact reply `{name:'classic.start',phase:'BIDDING'}`, exact `classic.started {dealNumber,boardInfo}`, exact bidding-updated payload, and effect `{type:'classic.compute-dd-table',dealNumber}`. Do not put hands in events/effects.

- [ ] **Step 5: Run start tests and verify GREEN**

Run: `node --test test/classic-engine-auction.test.js`

Expected: start validation/transition cases pass; later bid tests may still fail.

- [ ] **Step 6: Write failing `classic.bid` exact-payload tests**

Require exact `{expectedRevision,bid,alert,explain}`; cover invalid types, unknown/missing keys, over-500 Unicode scalars, explanation when unalerted, wrong phase, unseated actor, and not-your-turn.

- [ ] **Step 6R: Run bid-validation tests and verify RED**

Run: `node --test test/classic-engine-auction.test.js`

Expected: FAIL on unimplemented bid payload/actor validation.

- [ ] **Step 7: Implement bid payload/actor validation**

Normalize successful history entries to exact `{seat,bid,alert:true|null,explain,qa:[]}` and return the documented `CLASSIC_*` codes without mutation.

- [ ] **Step 7G: Run bid-validation tests and verify GREEN**

Run: `node --test test/classic-engine-auction.test.js`

Expected: malformed payloads throw `ClassicInputError`; legal-state failures return `CLASSIC_WRONG_PHASE`, `CLASSIC_FORBIDDEN`, `CLASSIC_NOT_YOUR_TURN`, or `CLASSIC_INVALID_BID` as applicable.

- [ ] **Step 8: Write failing in-progress bid transition tests**

Cover Pass, new contract, X, XX, bidder rotation, reset/increment of pass count, exact reply, and exact `classic.bidding-updated` payload.

- [ ] **Step 8R: Run in-progress bid tests and verify RED**

Run: `node --test test/classic-engine-auction.test.js`

Expected: FAIL on in-progress state/event/reply assertions.

- [ ] **Step 9: Implement in-progress bid transition**

Reuse `rules.cjs`; copy only changed state/history/contract branches; return `{name:'classic.bid',phase:'BIDDING'}`.

- [ ] **Step 9G: Run in-progress bid tests and verify GREEN**

Run: `node --test test/classic-engine-auction.test.js`

Expected: Pass/contract/X/XX state, exact event payload, and reply cases pass.

- [ ] **Step 10: Write failing contracted-auction completion test**

Assert event order and full exact payloads:

```js
assert.deepEqual(result.events.map((event) => event.name), [
  'classic.bidding-updated',
  'classic.bidding-ended',
]);
```

- [ ] **Step 10R: Run contracted-completion test and verify RED**

Run: `node --test test/classic-engine-auction.test.js`

Expected: FAIL on PLAYING fields, exact payload, or `{name:'classic.bid',phase:'PLAYING'}`.

- [ ] **Step 11: Implement contracted-auction completion**

Assign exact declarer/dummy/leader/currentPlayer fields and enter PLAYING. Emit bidding-updated before bidding-ended.

- [ ] **Step 11G: Run contracted-completion test and verify GREEN**

Run: `node --test test/classic-engine-auction.test.js`

Expected: exact state, two events, and PLAYING reply pass.

- [ ] **Step 12: Write failing passed-out completion test**

Four opening passes must enter SCORING, append exactly one passed-out score, and emit bidding-updated then exact `classic.finished {reason:'passed-out',dealNumber,score}` without bidding-ended.

- [ ] **Step 12R: Run passed-out test and verify RED**

Run: `node --test test/classic-engine-auction.test.js`

Expected: FAIL on score/event or `{name:'classic.bid',phase:'SCORING'}`.

- [ ] **Step 13: Implement passed-out completion**

Reuse `buildBoardScore`; guard phase/history so replay cannot append twice.

- [ ] **Step 13G: Run passed-out test and verify GREEN**

Run: `node --test test/classic-engine-auction.test.js`

Expected: exact passed-out score, events, reply, and score-once assertion pass.

- [ ] **Step 14: Add complete-result determinism test**

Invoke the same full auction transcript twice from independently deep-cloned but byte-equal state/context and assert `JSON.stringify(resultA) === JSON.stringify(resultB)` after every command.

- [ ] **Step 14G: Run determinism/immutability tests**

Run: `node --test test/classic-engine-auction.test.js`

Expected: byte-equal results plus deep-frozen and before/after serialization assertions pass for start and every bid form.

- [ ] **Step 15: Run auction and earlier tests**

Run: `node --test test/classic-rules.test.js test/classic-state.test.js test/classic-scoring.test.js test/classic-engine-auction.test.js`

Expected: all pass.

- [ ] **Step 16: Commit**

```powershell
git add classic/engine.cjs classic/state.cjs classic/scoring.cjs test/classic-engine-auction.test.js
git commit -m "feat: add classic auction engine"
```

### Task 4: Implement Play, Trick Completion, Scoring, and Readiness

**Files:**
- Modify: `classic/engine.cjs`
- Modify: `classic/state.cjs`
- Create: `test/classic-engine-play.test.js`

- [ ] **Step 1: Write failing `classic.play` exact-payload tests**

Require exact `{expectedRevision,card:{suit,rank}}` at the core boundary, where canonical `rank` is the symbol form. Cover unknown/missing keys, invalid types/cards, wrong phase, spectator/unseated actor, and not-your-turn.

- [ ] **Step 1R: Run play-validation tests and verify RED**

Run: `node --test test/classic-engine-play.test.js`

Expected: FAIL on unsupported `classic.play`.

- [ ] **Step 2: Implement play payload/actor validation**

Return exact documented codes and preserve input for every failure.

- [ ] **Step 2G: Run play-validation tests and verify GREEN**

Run: `node --test test/classic-engine-play.test.js`

Expected: malformed payloads throw `ClassicInputError`; legal-state failures return wrong-phase/forbidden/not-your-turn codes.

- [ ] **Step 3: Write failing held-card/follow-suit tests**

Use a fixed PLAYING state to cover direct seat play, declarer acting for dummy, non-declarer dummy attempt, card-not-held, and must-follow-suit.

- [ ] **Step 3R: Run held-card/follow-suit tests and verify RED**

Run: `node --test test/classic-engine-play.test.js`

Expected: FAIL on held-card/dummy/follow-suit assertions.

- [ ] **Step 4: Implement effective-hand validation and card removal**

Remove exactly one canonical card from the effective hand. Emit exact `classic.card-played {seat,card,currentTrick}` with `seat` equal to the played hand, not necessarily the socket actor.

- [ ] **Step 4G: Run held-card/follow-suit tests and verify GREEN**

Run: `node --test test/classic-engine-play.test.js`

Expected: legal play returns `{name:'classic.play',phase:'PLAYING'}`; `CLASSIC_CARD_NOT_HELD` and `CLASSIC_MUST_FOLLOW_SUIT` cases pass.

- [ ] **Step 5: Write failing opening-lead/dummy-reveal test**

Assert the legacy-compatible opening-lead order: exact `classic.dummy-revealed {dummy}`, then `classic.card-played`; also assert the public state change.

- [ ] **Step 5R: Run dummy-reveal test and verify RED**

Run: `node --test test/classic-engine-play.test.js`

Expected: FAIL on missing reveal state/event.

- [ ] **Step 6: Implement dummy reveal and rerun**

Run `node --test test/classic-engine-play.test.js`; expected opening-lead cases pass.

- [ ] **Step 7: Write failing four-card trick tests**

Cover trump/no-trump winners, exact `classic.trick-ended {trick,winner,nsTricks,ewTricks}`, cleared current trick, and winner as next player.

- [ ] **Step 7R: Run trick-completion tests and verify RED**

Run: `node --test test/classic-engine-play.test.js`

Expected: FAIL on unimplemented trick completion.

- [ ] **Step 8: Implement trick completion and rerun**

Reuse `trickWinner`; append one copied trick and increment exactly one side. Run the focused file; expected trick cases pass.

- [ ] **Step 9: Write failing thirteenth-trick finish test**

Assert exact event order `classic.card-played`, `classic.trick-ended`, `classic.finished`; exact played payload; one immutable score; SCORING state; and no duplicate score when the last command is retried against the resulting state.

- [ ] **Step 9R: Run final-trick tests and verify RED**

Run: `node --test test/classic-engine-play.test.js`

Expected: FAIL on finish event/score or `{name:'classic.play',phase:'SCORING'}`.

- [ ] **Step 10: Implement normal board completion**

Reuse `buildBoardScore`; finish only when completed trick count becomes 13.

- [ ] **Step 10G: Run final-trick tests and verify GREEN**

Run: `node --test test/classic-engine-play.test.js`

Expected: exact final state/events/reply and score-once cases pass.

- [ ] **Step 11: Write failing `classic.ready-next` validation/toggle tests**

Require exact `{expectedRevision}`; cover unknown/missing keys, wrong phase, spectator/unseated actor, and one-seat toggle with exact `classic.ready-updated {readyStatus}`.

- [ ] **Step 11R: Run readiness-validation tests and verify RED**

Run: `node --test test/classic-engine-play.test.js`

Expected: FAIL on unsupported `classic.ready-next`.

- [ ] **Step 12: Implement single-seat readiness**

Copy `readyStatus`, toggle only actor seat, and return SCORING reply when fewer than four are ready.

- [ ] **Step 12G: Run single-ready tests and verify GREEN**

Run: `node --test test/classic-engine-play.test.js`

Expected: exact event and `{name:'classic.ready-next',phase:'SCORING'}` pass.

- [ ] **Step 13: Write failing fourth-ready next-deal test**

Require a trusted next deal, increment dealNumber exactly once, reset readiness/per-deal fields, emit exact `classic.ready-updated`, then `classic.started` and `classic.bidding-updated`, and return one DDS effect. Reject missing/invalid trusted deal as internal context failure.

- [ ] **Step 13R: Run fourth-ready tests and verify RED**

Run: `node --test test/classic-engine-play.test.js`

Expected: FAIL on next-deal transition, event order, effect, or BIDDING reply.

- [ ] **Step 14: Implement automatic next deal**

Call the shared deal constructor rather than duplicating reset logic.

- [ ] **Step 14G: Run fourth-ready tests and verify GREEN**

Run: `node --test test/classic-engine-play.test.js`

Expected: exact reset/events/effect and `{name:'classic.ready-next',phase:'BIDDING'}` pass.

- [ ] **Step 15: Add play transcript determinism test**

Run the same 52-play transcript twice from byte-equal clones and compare complete serialized results at every step, including final score.

- [ ] **Step 15G: Run determinism/immutability tests**

Run: `node --test test/classic-engine-play.test.js`

Expected: transcript byte equality plus deep-frozen/before-after checks pass for play and ready-next.

- [ ] **Step 16: Run all core engine tests**

Run: `node --test test/classic-*.test.js`

Expected: every rule/state/scoring/auction/play test passes.

- [ ] **Step 17: Commit**

```powershell
git add classic/engine.cjs classic/state.cjs test/classic-engine-play.test.js
git commit -m "feat: add classic play and board completion"
```

### Task 5: Add Recipient Views and Node Compatibility Mutations

**Files:**
- Create: `classic/views.cjs`
- Create: `classic/node-compat.cjs`
- Create: `test/classic-views.test.js`
- Create: `test/classic-node-compat.test.js`

- [ ] **Step 1: Write failing concealed-hand snapshot tests**

For exact viewer `{role:'OWNER'|'PLAYER'|'SPECTATOR',seat:seat|null}`, cover N/E/S/W/spectator before/after dummy reveal. Assert the exact root/hands schema in the closed contract, sanitized score keys, recursive absence of `initialHands`, credentials, command cache, and pending actions, plus before/after canonical-state serialization equality.

- [ ] **Step 1R: Run concealed-hand view tests and verify RED**

Run: `node --test test/classic-views.test.js`

Expected: FAIL because `classicViewFor` is absent.

- [ ] **Step 2: Implement explicit `classicViewFor` public shape**

Construct the view from the closed root-key allowlist; do not clone-then-delete. Recursively clone returned cards, history, tricks, scores, contracts, DDS, and claims. Run `node --test test/classic-views.test.js`; expected concealed-hand, root-key, recursive privacy, and detachment cases pass.

- [ ] **Step 3: Write failing auction privacy tests**

Assert self/opponent/spectator full public alert/Q&A fields and partner `{seat,bid}` only. Apply the same assertions to `classic.bidding-updated` and `classic.bidding-ended`; compare serialized per-viewer events to prove no shared unfiltered frame.

- [ ] **Step 3R: Run auction privacy tests and verify RED**

Run: `node --test test/classic-views.test.js`

Expected: FAIL because `classicEventFor` is absent or unfiltered.

- [ ] **Step 4: Implement shared auction/event projection**

Use one entry projection in both `classicViewFor` and `classicEventFor`. Rerun view tests; expected all privacy cases pass.

- [ ] **Step 4A: Write failing finished-event and archived-score privacy tests**

Project passed-out, played, and claimed `classic.finished` events for each viewer and assert exact documented payloads with no private state. For `classicViewFor`, assert every archived `boardScores[]` omits `initialHands` recursively and projects its stored `biddingHistory` with the same self/opponent/partner/spectator rule.

- [ ] **Step 4AR: Run finished/archive privacy tests and verify RED**

Run: `node --test test/classic-views.test.js`

Expected: FAIL if a finished event or archived score leaks hands/full partner annotations.

- [ ] **Step 4B: Implement finished/archive projection**

Build exact sanitized passed-out/played/claimed score objects from allowlists and reuse the auction-entry projector for archived history.

- [ ] **Step 4BG: Run all view privacy tests and verify GREEN**

Run: `node --test test/classic-views.test.js`

Expected: all live/archived/event privacy, exact-key, recursive exclusion, and detached-output assertions pass.

- [ ] **Step 5: Write failing `settleClassicClaim` key/phase tests**

Require exact `{claimer,tricksToWin,reason}` and assert every outcome in the compatibility failure table: malformed/bounds/partition exceptions, wrong-phase/repeated domain result, and corrupted-state invariant exception.

- [ ] **Step 5R: Run claim tests and verify RED**

Run: `node --test test/classic-node-compat.test.js`

Expected: FAIL because `settleClassicClaim` is absent.

- [ ] **Step 6: Implement claim settlement and exact finish event**

Record `completedAtClaim`, award totals to 13, append one score, enter SCORING, and return exact `{ok:true,state,events:[{name:'classic.finished',payload:{reason:'claimed',dealNumber,contract,declarer,nsTricks,ewTricks,score,claim}}],effects:[],reply:{name:'classic.claim-settled',phase:'SCORING'}}`.

- [ ] **Step 6G: Run claim tests and verify GREEN**

Run: `node --test test/classic-node-compat.test.js`

Expected: exact failure signals, state, finish event, reply, score-once, and frozen-input checks pass.

- [ ] **Step 7: Write failing `editClassicBidAnnotation` tests**

Require exact `{seat,bidIndex,alert,explain}` and assert exact input/wrong-phase/forbidden outcomes from the failure table, 500-scalar boundary, null explanation when unalerted, immutable update, and no animation events.

- [ ] **Step 7R: Run alert-edit tests and verify RED**

Run: `node --test test/classic-node-compat.test.js`

Expected: FAIL because `editClassicBidAnnotation` is absent.

- [ ] **Step 8: Implement bid annotation edit**

Copy only the selected history entry and return empty events/effects plus `{name:'classic.bid-annotation-edited',phase:'BIDDING'}`.

- [ ] **Step 8G: Run alert-edit tests and verify GREEN**

Run: `node --test test/classic-node-compat.test.js`

Expected: exact authorization/bounds/result plus frozen-input assertions pass.

- [ ] **Step 9: Write failing `appendClassicBidQuestion` tests**

Require exact `{bidIndex,asker,question}` and assert exact bad-index/input/forbidden outcomes from the failure table; append exact `{asker,question,answer:null,answerer:null}` with no names/events.

- [ ] **Step 9R: Run question tests and verify RED**

Run: `node --test test/classic-node-compat.test.js`

Expected: FAIL because `appendClassicBidQuestion` is absent.

- [ ] **Step 10: Implement question append and rerun**

Copy the entry and QA array and return `{name:'classic.bid-question-added',phase:state.phase}`.

- [ ] **Step 10G: Run question tests and verify GREEN**

Run: `node --test test/classic-node-compat.test.js`

Expected: exact opponent authorization, record shape, empty events, and immutability pass.

- [ ] **Step 11: Write failing `answerClassicBidQuestion` tests**

Require exact `{bidIndex,qaIdx,answerer,answer}` and assert exact missing/answered input errors and forbidden answerer outcome from the failure table; set answer/answerer with no animation events.

- [ ] **Step 11R: Run answer tests and verify RED**

Run: `node --test test/classic-node-compat.test.js`

Expected: FAIL because `answerClassicBidQuestion` is absent.

- [ ] **Step 12: Implement answer transition and rerun**

Return `{name:'classic.bid-question-answered',phase:state.phase}`; all Q&A cases must pass.

- [ ] **Step 12G: Run answer tests and verify GREEN**

Run: `node --test test/classic-node-compat.test.js`

Expected: exact bidder authorization, record update, empty events, and immutability pass.

- [ ] **Step 13: Write failing `applyClassicDdsCompletion` success/stale tests**

Require exact `{dealNumber,ddTable,failed}`. A table is the closed 5×4 integer matrix. Matching PENDING success must return READY with `events:[{name:'classic.dd-table-ready',payload:{dealNumber,ddTable}}]`, empty effects, and reply `{name:'classic.dd-completed',phase}`. Stale deal/nonpending state must return a detached but byte-equal state, empty arrays, and `{name:'classic.dd-ignored',phase}`.

- [ ] **Step 13R: Run DDS success/stale tests and verify RED**

Run: `node --test test/classic-node-compat.test.js`

Expected: FAIL because `applyClassicDdsCompletion` is absent.

- [ ] **Step 14: Implement DDS success/stale completion**

Do not alter board score history retroactively; the existing current Node payload mapper may attach current DDS at scoring delivery.

- [ ] **Step 14G: Run DDS success/stale tests and verify GREEN**

Run: `node --test test/classic-node-compat.test.js`

Expected: exact READY event/reply and stale no-op result pass.

- [ ] **Step 15: Write failing terminal DDS failure tests**

Accept exactly `{dealNumber,ddTable:null,failed:true}` for the matching pending deal; reject any non-null table with failed true and all unknown/missing keys; set FAILED with empty arrays and reply `{name:'classic.dd-failed',phase}`.

- [ ] **Step 15R: Run terminal DDS failure tests and verify RED**

Run: `node --test test/classic-node-compat.test.js`

Expected: FAIL on terminal failure result or strict-key rejection.

- [ ] **Step 16: Implement terminal DDS failure**

Return empty events/effects and a compact trusted reply. Rerun compatibility tests; expected all five exported helper suites pass.

- [ ] **Step 16G: Run all compatibility tests and verify GREEN**

Run: `node --test test/classic-node-compat.test.js`

Expected: all five helper suites, exact result objects, and deep-frozen input checks pass.

- [ ] **Step 17: Run all shared-core tests and full Node baseline**

Run: `node --test test/classic-*.test.js`

Run: `npm test`

Expected: focused tests pass and all pre-existing tests still have zero failures (the total is greater than the old 707 baseline).

- [ ] **Step 18: Commit**

```powershell
git add classic/views.cjs classic/node-compat.cjs test/classic-views.test.js test/classic-node-compat.test.js
git commit -m "feat: add classic views and compatibility helpers"
```

## Chunk 2: Node Adapter and Socket.IO Compatibility

### Node Adapter Contract

- `createClassicNodeAdapter({io,dealFactory,calcDDTable,logger})` requires `io.to(id).emit(name,payload)`, synchronous `dealFactory({dealNumber})->{hands,boardInfo}`, `calcDDTable(hands)->Promise<ddsTable>`, and `logger.error(message,metadata)`. It returns `initializeRoom(room)`, `start(room,{socketId,seat})`, `bid(room,{socketId,seat,bid,alert,explain})`, `play(room,{socketId,seat,card})`, `readyNext(room,{socketId,seat})`, `clearReadyForDisconnect(room,{socketId,seat})`, `settleClaim(room,{socketId,claimer,tricksToWin,reason})`, `editBidAnnotation(room,{socketId,seat,bidIndex,alert,explain})`, `appendBidQuestion(room,{socketId,seat,bidIndex,question})`, and `answerBidQuestion(room,{socketId,seat,bidIndex,qaIdx,answer})`.
- Every mutating method returns exact `{ok:true,phase,revision}` after applying/emitting or `{ok:false,code}` after any emitted/silent rejection. It never throws through a Socket.IO handler.
- `projectClassicState(room)` reads only `CLASSIC_STATE_KEYS`; `applyClassicState(room,state)` writes only those keys. `room.classicRevision` is adapter metadata, starts at 0, and increments after each successful public command; it is not part of canonical core state.
- Node Socket.IO payloads remain symbol-ranked. The adapter supplies `expectedRevision:room.classicRevision` because existing browser events do not carry Worker revisions.
- Domain/input/invariant mapping is exact: incomplete seats → `需要4名玩家全部就座后才能开始`; unauthorized start → `只有房主可以开始游戏`; not-your-turn bid/play → `还没到你叫牌` / `还没到你出牌`; card not held → `该牌不在你手中`; must follow → `必须跟出同花色`. `CLASSIC_INVALID_BID` derives the existing message from the attempted bid/current contract (`没有可加倍的定约`, `不能加倍己方定约`, `定约已被加倍`, `定约未被加倍`, `定约已被再加倍`, `不能再加倍己方的加倍`, or `叫品必须高于当前定约`). Other `ClassicInputError` → `请求格式无效`; invariant/unexpected → log metadata and `服务器暂时无法处理，请稍后重试`; wrong-phase legacy preconditions remain silent.
- `CLASSIC_FORBIDDEN` is method-specific: `start` emits `只有房主可以开始游戏`; `bid` emits `还没到你叫牌`; `play` emits `还没到你出牌`; `settleClaim` emits `无法确定声称座位`; `readyNext`, `editBidAnnotation`, `appendBidQuestion`, and `answerBidQuestion` reject silently to match their legacy handlers. Tests assert both the `{ok:false,code:'CLASSIC_FORBIDDEN'}` return and whether zero or one `appError` was emitted.
- The legacy event mapper preserves current browser order: `gameStart` per seat then `biddingUpdate`; final auction sends `biddingEnd` or `gameEnd` without an extra final `biddingUpdate`; opening lead sends `dummyRevealed → cardPlayed → playUpdate`; ordinary play sends `cardPlayed → playUpdate`; non-final fourth card sends `cardPlayed → trickEnd → playUpdate`; final card sends `cardPlayed → trickEnd → gameEnd` with no trailing `playUpdate`; readiness sends `nextDealUpdate` before the next `gameStart`.
- `classic.started` launches DDS only after canonical state is applied. DDS settlement re-projects the then-current room state and calls `applyClassicDdsCompletion`; it never applies an earlier captured room/state object.

### Task 6: Build the Node Projection/Apply/Error Boundary

**Files:**
- Create: `classic/node-adapter.js`
- Create: `test/classic-node-adapter.test.js`
- Modify: `server.js:254-328`

- [ ] **Step 1: Write failing projection allowlist tests**

Create a room fixture containing canonical fields plus sockets, player names, owner ID, claim/view metadata, and a sentinel. Assert `projectClassicState` returns exact canonical keys, deep-detached nested values, and excludes every adapter field.

- [ ] **Step 1R: Run projection tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL because `classic/node-adapter.js` is absent.

- [ ] **Step 2: Implement `projectClassicState`**

Iterate `CLASSIC_STATE_KEYS`; validate the projected result before returning it.

- [ ] **Step 2G: Run projection tests and verify GREEN**

Run: `node --test test/classic-node-adapter.test.js`

Expected: exact-key and detachment assertions pass.

- [ ] **Step 3: Write failing apply allowlist/atomicity tests**

Apply a changed canonical state and assert all canonical fields update while socket/name/owner/claim/view/sentinel fields remain reference-equal. Inject an invalid proposed state and assert no room field changes.

- [ ] **Step 3R: Run apply tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL because `applyClassicState` is absent.

- [ ] **Step 4: Implement validate-then-apply**

Validate and deep-clone all values before the first assignment; then assign the allowlist in one synchronous section.

- [ ] **Step 4G: Run apply tests and verify GREEN**

Run: `node --test test/classic-node-adapter.test.js`

Expected: allowlist and invalid-state no-partial-write cases pass.

- [ ] **Step 5: Write failing error-mapping tests**

With fake sockets/logger, assert each public `CLASSIC_*`, `ClassicInputError`, `ClassicInvariantError`, and unexpected exception maps according to the Node Adapter Contract and does not change `classicRevision`.

- [ ] **Step 5R: Run error tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL on missing mapper.

- [ ] **Step 6: Implement error mapping and initialize room revision**

Add `classicRevision:0` in `makeRoom`; keep it outside `roomState()` browser payload. Never expose exception text to a socket.

- [ ] **Step 6G: Run adapter boundary tests and verify GREEN**

Run: `node --test test/classic-node-adapter.test.js`

Expected: projection, apply, error, and revision initialization tests pass.

- [ ] **Step 7: Write failing standard-room initialization/isolation tests**

Assert `initializeRoom(room)` applies exact `createClassicLobbyState()` plus revision 0 only for newly created `mode === 'classic' && !teachingMode` rooms. Assert teaching/ultimate/problem/complex rooms retain their legacy `dealNumber`, hands, and phase fields.

- [ ] **Step 7R: Run initialization tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL because standard classic still has legacy `dealNumber:1`/`hands:null` and missing canonical fields.

- [ ] **Step 8: Implement guarded standard-room initialization**

After `createRoom` resolves requested mode, call `classicAdapter.initializeRoom(room)` only for standard classic. It must `Object.assign` a fresh `createClassicLobbyState()` and set adapter revision; all other modes remain untouched.

- [ ] **Step 8G: Run initialization/isolation tests and verify GREEN**

Run: `node --test test/classic-node-adapter.test.js`

Expected: exact standard LOBBY state validates; all nonstandard fixtures remain byte-equal.

- [ ] **Step 9: Commit**

```powershell
git add classic/node-adapter.js test/classic-node-adapter.test.js server.js
git commit -m "feat: add classic Node adapter boundary"
```

### Task 7: Delegate Standard Start and Bidding Without Browser Changes

**Files:**
- Modify: `classic/node-adapter.js`
- Modify: `server.js:606-829`, `server.js:1050-1245`
- Modify: `test/classic-node-adapter.test.js`
- Create: `test/helpers/classic-socket-fixture.js`

- [ ] **Step 1: Write failing per-seat `gameStart`/bidding mapper tests**

Use fake `io.to(id).emit` recording and N/E/S/W sockets. Assert `classic.started` sends each player only their own hand with exact legacy `gameStart` keys, then `classic.bidding-updated` produces the existing per-seat partner-alert filtering and `biddingUpdate` keys.

- [ ] **Step 1R: Run event-mapper tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL because the mapper is absent.

- [ ] **Step 2: Implement started/in-progress bidding mapping**

Build payloads from the committed room and `classicEventFor`; never pass a full room or canonical private state to `emit`.

- [ ] **Step 2G: Run mapper tests and verify GREEN**

Run: `node --test test/classic-node-adapter.test.js`

Expected: exact event order/payload and per-seat privacy pass.

- [ ] **Step 3: Write failing adapter `start` tests**

Cover owner/all-seat success, non-owner and incomplete-seat `appError`, state/revision update, `gameStart` order, and nonblocking DDS launch after state application. Assert accepted first start calls `dealFactory({dealNumber:1})` exactly once and every rejected owner/phase/seat preflight calls it zero times.

- [ ] **Step 3R: Run start tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL because adapter `start` is absent.

- [ ] **Step 4: Implement adapter `start`**

Call the shared `preflightClassicCommand` with authoritative actor/occupied-seat context before randomness. Only when it returns `needsDeal:true`, call `dealFactory({dealNumber:preflight.nextDealNumber})`; then call `applyClassicCommand` with the same command/context plus that deal, apply success, increment revision, map events, and launch effects.

- [ ] **Step 4G: Run start tests and verify GREEN**

Run: `node --test test/classic-node-adapter.test.js`

Expected: start authorization/state/events/effect assertions pass.

- [ ] **Step 5: Write failing adapter `bid` tests**

Cover Pass/contract/X/XX, legacy bid token conversion (`Double`→`X`, `Redouble`→`XX` only at the Node boundary), alert trimming/bounds, Chinese errors, final `biddingEnd`, and passed-out `gameEnd` with no extra final `biddingUpdate`.

- [ ] **Step 5R: Run bid adapter tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL because adapter `bid` is absent.

- [ ] **Step 6: Implement adapter `bid` and final-auction mapping**

Supply authoritative seat/revision; convert core contract tokens back to legacy payload tokens only where the browser expects them. Preserve current `biddingEnd` and passed-out `gameEnd` shapes.

- [ ] **Step 6G: Run bid adapter tests and verify GREEN**

Run: `node --test test/classic-node-adapter.test.js`

Expected: exact state, revision, errors, filtering, and legacy event order pass.

- [ ] **Step 7: Write failing server routing tests**

Use source-level dependency injection or exported handler seams to assert only `mode === 'classic' && !teachingMode` ownerStart/bid paths call the adapter; teaching, ultimate, problem, and complex calls still reach their previous functions.

- [ ] **Step 7R: Run routing tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL before `server.js` delegates standard paths.

- [ ] **Step 8: Delegate start/bid in `server.js`**

Keep existing nonstandard branches in place. Remove only the now-dead standard mutations after characterization assertions cover their legacy output.

- [ ] **Step 8G: Run focused and full Node tests**

Run: `node --test test/classic-node-adapter.test.js`

Run: `npm test`

Expected: adapter/routing tests and all pre-existing tests pass with zero failures.

- [ ] **Step 9: Commit**

```powershell
git add classic/node-adapter.js server.js test/classic-node-adapter.test.js test/helpers/classic-socket-fixture.js
git commit -m "feat: delegate classic start and bidding"
```

### Task 8: Delegate Standard Play, Scoring, and Next-Deal Readiness

**Files:**
- Modify: `classic/node-adapter.js`
- Modify: `server.js:650-925`, `server.js:1245-1303`, `server.js:1544-1563`
- Modify: `test/classic-node-adapter.test.js`

- [ ] **Step 1: Write failing play-event mapper tests**

Assert all four exact sequences from the Node Adapter Contract, including the absence of `playUpdate` after the final `gameEnd`. Verify dummy hand appears only at reveal and no opponent concealed hand leaks.

- [ ] **Step 1R: Run play-mapper tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL on missing play mapping.

- [ ] **Step 2: Implement play/finish legacy mapping**

Map from committed state and filtered events. Preserve existing `gameEnd` replay fields for Node SCORING while never including them in Worker/general views.

- [ ] **Step 2G: Run play-mapper tests and verify GREEN**

Run: `node --test test/classic-node-adapter.test.js`

Expected: exact order/payload/privacy passes.

- [ ] **Step 3: Write failing adapter `play` authorization tests**

Cover current player, declarer-for-dummy, illegal dummy actor, card-not-held, follow suit, claim-pending guard, state/revision increments, and Chinese error mapping.

- [ ] **Step 3R: Run play authorization tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL because adapter `play` is absent.

- [ ] **Step 4: Implement adapter `play`**

Build canonical card symbols from legacy payload, use authoritative socket seat, refuse play while adapter-owned `claimReq` exists, apply/map only on success.

- [ ] **Step 4G: Run play tests and verify GREEN**

Run: `node --test test/classic-node-adapter.test.js`

Expected: authorization/rules/state/events/revision pass.

- [ ] **Step 5: Write failing readiness mapper/adapter tests**

Assert one-seat toggle emits exact `nextDealUpdate` with zero dealFactory calls; fourth-ready from deal N calls `dealFactory({dealNumber:N+1})` exactly once, then emits new gameStart/biddingUpdate; test untoggle, rejected commands, and duplicate delivery consume zero randomness.

- [ ] **Step 5R: Run readiness tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL because `readyNext` is absent.

- [ ] **Step 6: Implement `readyNext`**

Call shared `preflightClassicCommand` with the exact ready command and authoritative actor/occupied-seat context. Return/map any preflight failure without randomness. Only when it returns `needsDeal:true`, call `dealFactory({dealNumber:preflight.nextDealNumber})`; then call `applyClassicCommand` with the same command/context plus that deal. Apply one core result, increment revision once, then map ordered events/effect.

- [ ] **Step 6G: Run readiness tests and verify GREEN**

Run: `node --test test/classic-node-adapter.test.js`

Expected: toggle/untoggle/fourth-ready exact behavior passes.

- [ ] **Step 7: Write failing standard-vs-teaching routing tests**

Assert standard `playCard`/`nextDeal` delegates; teaching continues through legacy owner-controlled-seat logic; ultimate/problem/complex handlers remain untouched.

- [ ] **Step 7R: Run routing tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL until standard handlers delegate.

- [ ] **Step 8: Delegate play/readiness and remove dead standard mutations**

Keep `bcastPlay`/scoring helpers only where legacy modes still call them; do not redirect teaching mode in this milestone.

- [ ] **Step 8G: Run focused and full Node tests**

Run: `node --test test/classic-node-adapter.test.js`

Run: `npm test`

Expected: all focused and pre-existing tests pass.

- [ ] **Step 8A: Write failing standard disconnect/readiness ownership tests**

In standard classic SCORING, disconnect a seat with `readyStatus[seat] === true` and assert `clearReadyForDisconnect` executes one canonical `classic.ready-next` toggle before socket removal, increments revision, and emits ready update; a false-ready disconnect is a no-op. Assert `chooseSeat`/disconnect perform no direct standard-classic readyStatus assignment. Teaching/ultimate/problem/complex retain exact legacy resets.

- [ ] **Step 8AR: Run disconnect/readiness tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL while `disconnect` and `chooseSeat` mutate standard canonical readiness directly.

- [ ] **Step 8B: Implement canonical standard disconnect clearing**

Before clearing a standard-classic socket, call `clearReadyForDisconnect` only when SCORING and that seat is ready; its core call can only toggle true→false and never receives a deal. Skip the legacy readyStatus writes for standard classic in both disconnect and chooseSeat; preserve them verbatim for all nonstandard paths.

- [ ] **Step 8BG: Run lifecycle ownership tests and verify GREEN**

Run: `node --test test/classic-node-adapter.test.js`

Expected: revisioned canonical reset/no-op and nonstandard byte-equivalence pass.

- [ ] **Step 9: Commit**

```powershell
git add classic/node-adapter.js server.js test/classic-node-adapter.test.js
git commit -m "feat: delegate classic play and readiness"
```

### Task 9: Route Deferred Node Features Through Compatibility Helpers

**Files:**
- Modify: `classic/node-adapter.js`
- Modify: `server.js:1304-1543`
- Modify: `test/classic-node-adapter.test.js`

- [ ] **Step 0: Write failing deferred-feature isolation tests**

Assert compatibility helpers are called only for accepted claim settlement, alert edit, question, answer, and DDS when `mode === 'classic' && !teachingMode`. Claim request/vote and last-trick request/vote remain adapter-owned legacy metadata and must call no compatibility helper until claim acceptance. Assert teaching and ultimate classic-adjacent handlers keep the full pre-migration path; problem/complex remain unaffected.

- [ ] **Step 0R: Run isolation tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL until explicit guards surround every deferred standard-classic adapter call.

- [ ] **Step 0G: Add explicit routing guards**

At accepted claim settlement, annotation/Q&A mutations, and DDS launch, branch to the compatibility adapter only for standard classic and leave the legacy body for all other modes/teaching. Keep claim/view request/vote metadata handlers legacy for both paths, but verify their standard path does not mutate canonical engine fields before an accepted settlement.

- [ ] **Step 0GG: Run deferred-feature isolation tests and verify GREEN**

Run: `node --test test/classic-node-adapter.test.js`

Expected: every standard call reaches one helper; every nonstandard fixture records zero helper calls and retains exact legacy outputs.

- [ ] **Step 1: Write failing accepted-claim adapter tests**

Keep claim request/votes adapter-owned. Assert unanimous/automatic acceptance calls `settleClassicClaim` once, emits existing `claimResult` before `gameEnd`, clears request metadata, applies canonical claimed state, and cannot settle twice. For standard classic `claimRequest`, assert per-recipient emission includes `allHands` only for opponent adjudicators; same-side/claimer/dummy payloads carry `allHands:{}`. Teaching keeps its legacy broadcast unchanged.

- [ ] **Step 1R: Run claim adapter tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL while server mutates trick totals/scores directly.

- [ ] **Step 2: Replace accepted-claim mutations with adapter settlement**

Preserve rejection/vote behavior; only accepted paths call the helper through the adapter. For standard classic, replace the one room-wide `claimRequest` emit with per-seat payloads so only opponent adjudicators receive `allHands`; keep teaching's legacy broadcast branch intact.

- [ ] **Step 2G: Run claim tests and verify GREEN**

Run: `node --test test/classic-node-adapter.test.js`

Expected: existing vote sequence plus single canonical score passes.

- [ ] **Step 3: Write failing alert/Q&A adapter tests**

Assert original bidder authorization, opponent-only questions, bidder-only answer, exact targeted legacy receive payloads with names joined from `playerNames`, and no direct canonical history mutation.

- [ ] **Step 3R: Run annotation tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL while server writes `biddingHistory` entries directly.

- [ ] **Step 4: Route alert/Q&A through compatibility helpers**

Apply returned state, increment `classicRevision`, and emit the current targeted Socket.IO messages. Last-trick request/vote remains adapter metadata and must leave before/after canonical serialization equal.

- [ ] **Step 4G: Run annotation/last-trick tests and verify GREEN**

Run: `node --test test/classic-node-adapter.test.js`

Expected: authorization, names, payloads, revision, and canonical no-mutation for last-trick voting pass.

- [ ] **Step 5: Write failing Node DDS race/stale/failure tests**

Use deferred promises: start DDS, commit a bid, then resolve DDS. Assert completion projects latest state, preserves bid/revision, sets READY, and emits current `ddTableReady` only when applicable. Resolve an old-deal promise after next deal and assert no-op. Reject/return invalid table and assert FAILED/no gameplay error.

- [ ] **Step 5R: Run DDS adapter tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL until effect settlement is wired through current state.

- [ ] **Step 6: Implement nonblocking Node DDS effect settlement**

On each promise settlement, project the current room, call `applyClassicDdsCompletion`, and apply only changed matching results. Log failures without emitting `appError`.

- [ ] **Step 6G: Run DDS adapter tests and verify GREEN**

Run: `node --test test/classic-node-adapter.test.js`

Expected: race preservation, stale no-op, READY/FAILED, and event behavior pass.

- [ ] **Step 7: Run full Node regression and commit**

Run: `npm test`

Expected: zero failures across new and pre-existing Node tests.

```powershell
git add classic/node-adapter.js server.js test/classic-node-adapter.test.js
git commit -m "refactor: preserve deferred classic features"
```

### Task 10: Prove the Real Socket.IO Standard-Classic Flow

**Files:**
- Create: `test/classic-server-integration.test.js`
- Create: `test/helpers/stepstone-server-harness.js`
- Modify: `classic/node-adapter.js`
- Modify: `server.js:420-532`, `server.js:4167-4171`

- [ ] **Step 1: Write failing start/stop harness test**

Require `server.js` without listening, call exported `startServer(0)`, connect to the returned actual port, then close Socket.IO/HTTP with no handles left. Assert `node server.js` still starts through `require.main === module`.

- [ ] **Step 1R: Run harness test and verify RED**

Run: `node --test test/classic-server-integration.test.js`

Expected: FAIL because server startup is not exported.

- [ ] **Step 2: Add the minimal testable startup seam**

Export `{app,server,io,startServer}`; guard the existing startup log/listen call with `require.main === module`. Do not create a second server factory or change production defaults.

- [ ] **Step 2G: Run harness and smoke tests**

Run: `node --test test/classic-server-integration.test.js test/smoke-server.test.js`

Expected: ephemeral-port lifecycle and existing smoke tests pass.

- [ ] **Step 3: Add four-client lobby/start/auction acceptance test**

Connect four `socket.io-client` instances, create/join/choose N/E/S/W, start as owner, assert one private 13-card hand each, run `1NT-Pass-Pass-Pass`, and assert exact existing biddingEnd/current-player state with no leaked hands.

- [ ] **Step 3G: Run live auction test and verify GREEN**

Run: `node --test test/classic-server-integration.test.js`

Expected: four-client auction passes.

- [ ] **Step 4: Extend the live test through 52 legal plays and next deal**

Drive play from received private/dummy hands, always following suit, acknowledge trick UI timing only through existing events, assert gameEnd/13 tricks, toggle all four nextDeal, and assert the second private deal starts.

- [ ] **Step 4G: Run complete live flow and verify GREEN**

Run: `node --test test/classic-server-integration.test.js`

Expected: full lobby→bidding→playing→scoring→next-deal flow passes.

- [ ] **Step 5: Write failing reconnect projection/privacy tests**

At BIDDING, PLAYING, open claim, open last-trick vote, and SCORING, call the planned `sendClassicReconnectState` for self/opponent/partner seats. Assert only own/public dummy hands outside claim adjudication; per-seat live and archived auction/Q&A filtering; archived score removal of `initialHands`; exact pending claim/vote and view/vote metadata; and exact legacy event order. During an open claim, only an opponent adjudicator receives the existing `allHands` payload required by `showClaimRecvModal`; same-side/claimer/dummy reconnects receive `allHands:{}`.

- [ ] **Step 5R: Run reconnect tests and verify RED**

Run: `node --test test/classic-node-adapter.test.js`

Expected: FAIL because current `sendReconnectState` sends unfiltered history/full archived state.

- [ ] **Step 6: Implement guarded standard-classic reconnect mapping**

Add `sendClassicReconnectState(room,seat,socket)` in `classic/node-adapter.js`. Build canonical data from `classicViewFor`; join player names and adapter-owned pending claim/view metadata separately. The sole concealed-hand exception is the existing open-claim adjudication payload sent only to an opponent voter; never attach private score hands. In `server.js`, route only standard classic reconnects to it; teaching/ultimate/problem/complex reconnect functions remain byte-unchanged.

- [ ] **Step 6G: Run reconnect unit tests and verify GREEN**

Run: `node --test test/classic-node-adapter.test.js`

Expected: all phase/privacy/filtering/pending-metadata and nonstandard-isolation assertions pass.

- [ ] **Step 7: Add live disconnect/reconnect acceptance test**

Disconnect one player mid-play, reconnect/choose the vacated seat, and assert the real Socket.IO stream matches the unit-tested filtered reconnect contract.

- [ ] **Step 7G: Run live reconnect acceptance test**

Run: `node --test test/classic-server-integration.test.js`

Expected: live reconnect passes with no concealed-hand or partner-annotation leak.

- [ ] **Step 8: Run Node gates and commit**

Run: `npm test`

Run: `npm run test:server:smoke`

Expected: zero failures and clean process shutdown.

```powershell
git add classic/node-adapter.js server.js test/classic-server-integration.test.js test/helpers/stepstone-server-harness.js
git commit -m "test: cover classic Socket.IO migration"
```

## Chunk 3: Durable Object Classic Integration and Recoverable DDS

### Task 11: Persist Display Names and Compose One Recipient Snapshot

**Files:**
- Create: `workers/src/room-foundation/room-view.mjs`
- Create: `workers/test/room-classic-view.test.mjs`
- Modify: `workers/src/room-foundation/router.mjs:118-167`
- Modify: `workers/src/room-foundation/stepstone-room.mjs:110-231`, `workers/src/room-foundation/stepstone-room.mjs:921-1080`
- Modify: `workers/test/room-bootstrap.integration.test.mjs`
- Modify: `workers/test/room-websocket.integration.test.mjs`

- [ ] **Step 1: Write failing display-name persistence and migration tests**

Create a room as `North`, join E/S/W as distinct names, evict/recreate the object, and assert the rebuilt authority cache retains every name. Seed the pre-migration `sessions` schema and assert construction adds `display_name TEXT NOT NULL DEFAULT ''` without losing the session. Empty legacy values project as `null`, while all new create/join paths persist the already validated name.

- [ ] **Step 1R: Run the persistence tests and verify RED**

Run: `node --test workers/test/room-bootstrap.integration.test.mjs workers/test/room-classic-view.test.mjs`

Expected: FAIL because router calls and session/cache rows currently discard `displayName`.

- [ ] **Step 2: Thread displayName through bootstrap and storage**

Pass `parsed.displayName` from both router calls into `initialize`/`join`. Add the non-null session column using an idempotent `PRAGMA table_info(sessions)` migration before recreating authority triggers. Update every session insert, authority-cache JSON trigger, `cacheSessionAuthority`, reconstruction parser, and authenticated-session copy to carry `displayName`. Reject a missing/invalid trusted name on new rows; keep `''` only as the migration default for old local objects.

- [ ] **Step 2G: Run persistence tests and verify GREEN**

Run: `node --test workers/test/room-bootstrap.integration.test.mjs workers/test/room-classic-view.test.mjs`

Expected: create/join/restart/migration cases pass without additional session reads during commands.

- [ ] **Step 3: Write failing exact snapshot/privacy tests**

Test `composeRoomSnapshot(stored,authorityMap,viewer)` against the exact outer keys in the design. Assert `viewer:{role,seat}`, `playerNames:{N,E,S,W}` with `null` for vacant/legacy-empty seats, and the exact `classicViewFor` projection. Cover owner, partner, opponent, spectator, dummy-before/after-opening-lead, SCORING, and detached-output mutation. Assert no token, session, connection, recent-command, pending-action, or `initialHands` key appears recursively.

- [ ] **Step 3R: Run view tests and verify RED**

Run: `node --test workers/test/room-classic-view.test.mjs`

Expected: FAIL because `publicRoomState` omits viewer/names/classic and bypasses shared privacy.

- [ ] **Step 4: Implement the single snapshot and event composer**

Export:

```js
composeRoomSnapshot(stored, authorities, viewer)
composeClassicEventFrame(event, revision, viewer)
```

The snapshot calls `classicViewFor(stored.classic,{role,seat})`. The event composer calls `classicEventFor` and returns exactly `{v:1,type:'event',name,payload:{revision,event}}`. It must return fresh JSON values and fail closed on malformed authority/state. Replace `publicRoomState` calls used by sync, conflict, reply, hello/reconnect, post-commit broadcast, and test inspection with this composer. Each socket obtains its current authoritative session separately; do not serialize one shared player snapshot.

- [ ] **Step 4G: Run view and foundation regressions**

Run: `node --test workers/test/room-classic-view.test.mjs workers/test/room-websocket.integration.test.mjs workers/test/room-foundation-protocol.test.mjs`

Expected: exact snapshots/privacy pass and existing hello/sync/revision behavior remains green.

- [ ] **Step 5: Commit**

```powershell
git add workers/src/room-foundation/room-view.mjs workers/src/room-foundation/router.mjs workers/src/room-foundation/stepstone-room.mjs workers/test/room-classic-view.test.mjs workers/test/room-bootstrap.integration.test.mjs workers/test/room-websocket.integration.test.mjs
git commit -m "feat: compose recipient-specific room snapshots"
```

### Task 12: Parse Classic Commands and Generate Trusted Worker Deals

**Files:**
- Create: `workers/src/room-foundation/classic-deal.mjs`
- Create: `workers/src/room-foundation/classic-command.mjs`
- Create: `workers/test/room-classic-command.test.mjs`
- Modify: `workers/src/room-foundation/protocol.mjs:176-209`
- Modify: `workers/src/room-foundation/constants.mjs`
- Modify: `workers/src/room-foundation/stepstone-room.mjs:1191-1210`
- Modify: `workers/test/room-foundation-protocol.test.mjs`
- Modify: `workers/test/room-command-cache.test.mjs`
- Modify: `workers/test/room-commands.integration.test.mjs`

- [ ] **Step 1: Write failing protocol-envelope and ownership tables**

Table-drive all four public classic command names. At the transport layer, require an exact frame envelope, plain payload, and present nonnegative-safe `expectedRevision`; reject any client-supplied top-level deal/seat, unknown command name, or wrong revision type. Deliberately assert that payload-specific extra/missing keys, bad bids, alert/explain mismatch, and bad card shapes survive generic parsing and are rejected later by the shared engine as `INVALID_COMMAND`. Assert `room.sync` remains exact `{}` and `foundation.increment` remains exact `{expectedRevision}` only under the test gate. Extend the closed public `ERROR_CODES` table with exactly seven codes—`CLASSIC_WRONG_PHASE`, `CLASSIC_FORBIDDEN`, `CLASSIC_SEATS_INCOMPLETE`, `CLASSIC_NOT_YOUR_TURN`, `CLASSIC_INVALID_BID`, `CLASSIC_CARD_NOT_HELD`, `CLASSIC_MUST_FOLLOW_SUIT`—and assert `CLASSIC_INVALID_DEAL_CONTEXT` and all internal diagnostics remain excluded.

- [ ] **Step 1R: Run protocol tests and verify RED**

Run: `node --test workers/test/room-foundation-protocol.test.mjs`

Expected: classic names are rejected and validation ownership/gating is not implemented.

- [ ] **Step 2: Extend generic parsing without duplicating core schemas**

Make `parseCommandFrame(value,{foundationTestEnabled=false}={})` validate only envelope/name/payload-object/revision ownership for classic names; the shared engine remains the sole exact classic payload and business-rule validator. Preserve frame-size behavior. Make `fingerprintCommand(value,options)` pass the same option to parsing (or fingerprint an already parsed command without reparsing). In `StepstoneRoom.handleCommand`, construct the option once from `env.ROOM_FOUNDATION_TEST === 'true'` and pass it to both calls. Update the closed public error table and every caller/test consistently.

- [ ] **Step 2G: Run protocol tests and verify GREEN**

Run: `node --test workers/test/room-foundation-protocol.test.mjs workers/test/room-command-cache.test.mjs workers/test/room-commands.integration.test.mjs`

Expected: generic validation, deferred classic-schema validation, canonical fingerprints, seven-code public error closure, and a real gated `foundation.increment` command all pass; the same command remains unavailable without the test gate.

- [ ] **Step 3: Write failing deal-generator tests**

Inject a deterministic `getRandomValues` source and assert Fisher–Yates returns four 13-card canonical hands with 52 unique cards. Add rejection-sampling cases proving values outside the largest multiple of the current range are discarded rather than modulo-biased. Test exact `createWorkerClassicDealFactory({env,getRandomValues})`, whose returned `dealFactory({dealNumber})` derives `boardInfoFor(dealNumber)`. In production mode it always uses Web Crypto and ignores a test-deal binding. Under exact `ROOM_FOUNDATION_TEST === 'true'`, it may parse `CLASSIC_TEST_DEALS_JSON` as an array of canonical four-seat hands and select index `dealNumber - 1`; malformed/exhausted fixtures throw a trusted invariant error and never fall back to randomness. Assert no Node/process/filesystem API is imported.

- [ ] **Step 3R: Run deal tests and verify RED**

Run: `node --test workers/test/room-classic-command.test.mjs`

Expected: FAIL because the trusted Worker deal module is absent.

- [ ] **Step 4: Implement unbiased Web Crypto deal generation**

Export low-level `createWorkerClassicDeal({getRandomValues=crypto.getRandomValues.bind(crypto)}={})` and env-bound `createWorkerClassicDealFactory({env,getRandomValues=crypto.getRandomValues.bind(crypto)})`. Build the canonical 52-card deck from shared constants, use rejection sampling for every Fisher–Yates index, and return detached `{hands,boardInfo}` from the factory. Parse/validate the exact-gated test fixture once when constructing the factory. Never accept entropy or a deal from the public command payload.

- [ ] **Step 4G: Run deal tests and verify GREEN**

Run: `node --test workers/test/room-classic-command.test.mjs`

Expected: deterministic, uniqueness, and rejection-sampling tests pass.

- [ ] **Step 5: Write failing adapter authorization/normalization tests**

Call the planned Worker adapter with owner/player/spectator authorities and occupied seats. Assert integer ranks map `10→'T'`, `11→'J'`, `12→'Q'`, `13→'K'`, `14→'A'`; malformed public payloads map the core's `ClassicInputError` to `INVALID_COMMAND`; owner-only start; seated-only mutations; declarer dummy control; four-seat start; and exact engine compact replies/events/effects. Verify `dealFactory` is called once only for an authorized legal `classic.start` or the fourth legal `classic.ready-next`, and zero times for spectator, wrong phase, or first three ready toggles. Duplicate and stale-revision detection remain `StepstoneRoom` responsibilities and are covered in Task 13 before this adapter can be called.

- [ ] **Step 5R: Run adapter tests and verify RED**

Run: `node --test workers/test/room-classic-command.test.mjs`

Expected: FAIL because `applyWorkerClassicCommand` is absent.

- [ ] **Step 6: Implement the thin Worker command adapter**

Export `applyWorkerClassicCommand({state,command,session,authorities,dealFactory})`. Derive actor seat from the authenticated authority and occupied seats from same-incarnation authorities. Preserve the payload's exact key set while converting a valid public integer rank to the canonical symbol; leave other malformed values for core validation. Call shared `preflightClassicCommand`, lazily request its exact next deal only when `needsDeal:true`, and then call `applyClassicCommand`. Map `ClassicInputError` to `INVALID_COMMAND`, public domain failures to their exact `CLASSIC_*` code, and invariant/unexpected failures to `SERVICE_CAPACITY` without internal details.

- [ ] **Step 6G: Run command tests and commit**

Run: `node --test workers/test/room-classic-command.test.mjs workers/test/room-foundation-protocol.test.mjs`

Expected: all protocol, authorization, normalization, and entropy-call assertions pass.

```powershell
git add workers/src/room-foundation/classic-deal.mjs workers/src/room-foundation/classic-command.mjs workers/src/room-foundation/protocol.mjs workers/src/room-foundation/constants.mjs workers/src/room-foundation/stepstone-room.mjs workers/test/room-classic-command.test.mjs workers/test/room-foundation-protocol.test.mjs workers/test/room-command-cache.test.mjs workers/test/room-commands.integration.test.mjs
git commit -m "feat: validate Worker classic commands"
```

### Task 13: Commit Classic Commands Atomically in StepstoneRoom

**Files:**
- Create: `workers/test/room-classic-runtime.test.mjs`
- Modify: `workers/src/room-foundation/stepstone-room.mjs`
- Modify: `workers/src/room-foundation/classic-deal.mjs`
- Modify: `workers/src/room-foundation/command-cache.mjs`
- Modify: `workers/test/helpers/room-worker-runtime.mjs`
- Modify: `workers/test/room-commands.integration.test.mjs`
- Modify: `workers/test/room-command-cache.test.mjs`

- [ ] **Step 1: Write failing initialization and start transaction tests**

Using the real Miniflare DO, assert initialization stores `classic:createClassicLobbyState()`. Connect four seats, send `classic.start`, and assert revision increments once, the persisted classic state enters BIDDING, the actor receives the exact compact reply/current recipient snapshot, every socket receives separately filtered `classic.started`, then `classic.bidding-updated`, then `room.snapshot`, and state plus command-cache changes commit or roll back together under injected precommit faults. Pending DDS action atomicity is deliberately deferred to Task 14.

- [ ] **Step 1R: Run runtime test and verify RED**

Run: `node --test workers/test/room-classic-runtime.test.mjs`

Expected: classic state/command handling is missing.

- [ ] **Step 2: Initialize classic state and one serialized mutation gate**

Add `classic:createClassicLobbyState()` to the initial `room_state` object in `initializeWithSession` and validate it during cache reconstruction. Add a promise-chain `runStateMutation(fn)` gate initialized in the constructor; keep the tail fulfilled after success or failure. Refactor mutating entry points into non-reentrant `...Locked` internals so command commits, authentication/session state changes, socket-close expiry scheduling, alarms, lifecycle transitions, and later DDS settlements enter the gate exactly once and no locked method waits on the same gate. DDS computation/delivery remain outside it. Add an overlap test showing a delayed command and expiry/alarm cannot both commit from the same stale cached state.

- [ ] **Step 2G: Run initialization/serialization tests**

Run: `node --test workers/test/room-classic-runtime.test.mjs workers/test/room-lifecycle.integration.test.mjs`

Expected: initial classic state and ordered mutation behavior pass without changing existing lifecycle outcomes.

- [ ] **Step 3: Integrate classic mutation into the gated CAS transaction**

After authority, cache, and expected-revision checks inside `runStateMutation`, delegate classic names to `applyWorkerClassicCommand`. Classic commands—including spectator attempts—must reach the core adapter; retain the old generic `FORBIDDEN` short-circuit only for the gated foundation mutation. Build `proposed={...state,classic:result.state,revision:+1,recentCommands:...}` and store exact compact reply `{name,phase}`. Extend command-cache validation to accept only foundation `{name:'foundation.increment'}` or allowlisted classic `{name,phase}` shapes. Preserve `foundationCounter` unchanged for classic commands; increment it only for the gated foundation command. Enforce the snapshot-size limit and existing single-row CAS. Return domain failures without writes, cache entries, entropy, events, or broadcasts.

- [ ] **Step 3G: Run start transaction tests and verify GREEN**

Run: `node --test workers/test/room-classic-runtime.test.mjs workers/test/room-command-cache.test.mjs`

Expected: start/rollback/recipient delivery tests pass.

- [ ] **Step 4: Add idempotency, spectator, stale-revision, and reply-refresh tests**

Assert exact duplicate delivery returns cached `{name,phase}` with a freshly composed current snapshot and no event replay/randomness/revision write. A real spectator classic mutation reaches the adapter and returns `CLASSIC_FORBIDDEN`, not generic `FORBIDDEN`, without a write. Conflicting ID reuse returns `COMMAND_CONFLICT`; stale revision returns `REVISION_CONFLICT` with the requester's filtered snapshot. Duplicate, conflict, and stale-revision start/ready commands must leave an instrumented deal factory untouched. Corrupt cache/state maps to `SERVICE_CAPACITY` and no partial write. Table-drive the closed public classic error allowlist so internal diagnostics cannot reach WebSocket frames.

- [ ] **Step 4G: Run command integrity tests**

Run: `node --test workers/test/room-classic-runtime.test.mjs workers/test/room-commands.integration.test.mjs`

Expected: classic and foundation cache/CAS guarantees pass.

- [ ] **Step 5: Add an exact-gated deterministic deal seam**

Construct `createWorkerClassicDealFactory({env})` once per `StepstoneRoom` and pass it to the command adapter. `classic-deal.mjs` reads `env.CLASSIC_TEST_DEALS_JSON` only when `env.ROOM_FOUNDATION_TEST === 'true'`, validates it as an array of canonical four-seat hands, selects strictly by `dealNumber - 1`, and derives board info, so eviction cannot reset a mutable cursor. Malformed/exhausted gated fixtures map to `SERVICE_CAPACITY` with no mutation. In every other environment the binding is ignored and Web Crypto is used. Extend the Miniflare runtime helper to pass the JSON string as a Worker var without adding a public RPC or route.

- [ ] **Step 5G: Prove the seam is closed in production mode**

Run: `node --test workers/test/room-classic-command.test.mjs workers/test/room-foundation-routing.test.mjs`

Expected: fixed deals are deterministic under the exact test gate and unavailable otherwise.

- [ ] **Step 6: Add complete fixed-deal DO transcript test**

Run one deterministic start, legal auction, 52 legal plays, scoring, four readiness commands, and second deal through WebSockets. Assert persisted state after every command matches the same shared-core transcript, revisions are monotonic, event order matches the design, and no recipient observes concealed hands or `initialHands`.

- [ ] **Step 6G: Run the full DO transcript**

Run: `node --test workers/test/room-classic-runtime.test.mjs`

Expected: LOBBY→BIDDING→PLAYING→SCORING→BIDDING passes with byte-equivalent canonical classic states.

- [ ] **Step 7: Add hibernation, reconnect, takeover, and SQL-profile tests**

Evict/recreate between phases, reconnect the same session, replace an old connection, and sync as all viewer roles. Assert restored state/revision/names/privacy, old socket closure, no event replay, and exactly the existing one room-state row read/write profile for an ordinary command with zero per-recipient SQL reads.

- [ ] **Step 7G: Run Worker runtime regressions and commit**

Run: `npm run test:workers`

Expected: all pre-existing foundation and new classic runtime tests pass.

```powershell
git add workers/src/room-foundation/stepstone-room.mjs workers/src/room-foundation/classic-deal.mjs workers/src/room-foundation/command-cache.mjs workers/test/room-classic-runtime.test.mjs workers/test/helpers/room-worker-runtime.mjs workers/test/room-commands.integration.test.mjs workers/test/room-command-cache.test.mjs
git commit -m "feat: persist classic commands in Durable Objects"
```

### Task 14: Add Recoverable At-Least-Once DDS Actions

**Files:**
- Create: `workers/src/room-foundation/classic-dds-action.mjs`
- Create: `workers/test/room-classic-dds.test.mjs`
- Modify: `workers/src/dds-wasm-adapter.mjs`
- Modify: `workers/test/dds-adapter.test.mjs`
- Modify: `workers/src/room-foundation/stepstone-room.mjs:566-584`, `workers/src/room-foundation/stepstone-room.mjs:838-891`, `workers/src/room-foundation/stepstone-room.mjs:1191-1409`
- Modify: `workers/src/index.mjs`
- Modify: `workers/test/helpers/room-worker-runtime.mjs`

- [ ] **Step 1: Write failing bounded-action helper tests**

Assert the action payload is exact `{generationId,dealNumber,attempt}` with a UUID generation, positive safe deal number, and attempt 1..3. Attempt 1 starts immediately while its persisted backstop is due at +5 seconds; failure schedules attempt 2 at +5 seconds, and its failure schedules attempt 3 at +30 seconds; attempt 3 failure is terminal. Reject unknown keys, malformed DDS tables, or classic hands not convertible to the DDS adapter's integer-rank input.

- [ ] **Step 1R: Run DDS helper tests and verify RED**

Run: `node --test workers/test/room-classic-dds.test.mjs`

Expected: FAIL because the action module is absent.

- [ ] **Step 2: Implement DDS action validation and client factory**

First make `createWasmDdsClient` retry-safe: its cached `modulePromise` must reset on a rejected `loadModule`, while concurrent callers still share one in-flight initialization; add a unit test where initialization fails once and the same client succeeds next call. In `classic-dds-action.mjs`, explicitly import `createWasmDdsClient` from `../dds-wasm-adapter.mjs`, `loadDdsModule` from `../dds-wasm-loader.mjs`, and `ddsWasm` from `../../vendor/bridge-dds/dds-worker.wasm`. Create one module-scoped lazy client whose `loadModule` calls `loadDdsModule(ddsWasm)` and exposes only `calcDDTablePbn`/`solveBoardPbn`; retry attempts can now recover after initialization rejection and expose only internal failure classification. Export canonical-hands-to-integer conversion, payload parse/build helpers, retry due-time helpers, and table validation through the shared DDS/core boundaries. Do not expose DDS bodies/errors to clients.

- [ ] **Step 2G: Run helper tests and verify GREEN**

Run: `node --test workers/test/dds-adapter.test.mjs workers/test/room-classic-dds.test.mjs`

Expected: payload/timing/conversion/client tests pass.

- [ ] **Step 3: Write failing atomic action-creation and immediate-attempt tests**

On `classic.start` and fourth-ready next deal, assert the same storage transaction that commits `ddsStatus:'PENDING'` upserts exactly one row with `action_id='classic-dd-table'`, `kind='classic-dd-table'`, a fresh generation, matching deal/incarnation, attempt 1, and a +5-second backstop alarm. The row must not duplicate hands. Assert rollback removes state, command cache, row, and alarm change together. After commit, an immediate attempt starts via `ctx.waitUntil`; its persisted alarm remains until a matching settlement.

- [ ] **Step 3R: Run action-creation tests and verify RED**

Run: `node --test workers/test/room-classic-dds.test.mjs`

Expected: deal effects are not yet materialized.

- [ ] **Step 4: Materialize the effect in the command transaction**

When the engine returns `classic.compute-dd-table`, enter the Task 13 mutation gate and use `await ctx.storage.transaction(async () => ...)`—not `transactionSync`—for the room-state CAS, command-cache state, fixed action-row replacement, and awaited `storage.setAlarm(earliestDue)`. This transaction performs no network/DDS await. Return the committed `{incarnation,generationId,dealNumber,attempt:1}` descriptor in the internal outcome. After commit/event delivery, schedule `attemptClassicDdsAction(descriptor)` with `ctx.waitUntil`; never await DDS in the client command handler. Ordinary commands keep the same one-row SQL profile and use the same gate/CAS path without adding an action row.

- [ ] **Step 4G: Run creation tests and verify GREEN**

Run: `node --test workers/test/room-classic-dds.test.mjs`

Expected: atomic row/alarm/immediate-attempt behavior passes.

- [ ] **Step 5: Write failing success/race/replacement tests**

Pause DDS, commit a legal bid, then release DDS. Assert completion re-reads and merges into the latest state, increments revision once, deletes only the matching generation/attempt row, sets READY/table, emits one filtered `classic.dd-table-ready` then snapshots, and preserves the bid. Replace the action with a next-deal generation and assert the late old completion cannot mutate state or delete the replacement. Repeat completion and assert idempotent no-op. Force the immediate call and due alarm to overlap on the same attempt; cover success/success, success/failure, and failure/failure orderings so only the first matching settlement or retry update wins.

- [ ] **Step 5R: Run settlement tests and verify RED**

Run: `node --test workers/test/room-classic-dds.test.mjs`

Expected: serialized matching settlement is absent.

- [ ] **Step 6: Implement latest-state guarded settlement**

Run completion through Task 13's `runStateMutation` gate. In a fresh storage transaction, require fixed action row + matching incarnation/generation/deal/**attempt** + latest `classic.ddsStatus === 'PENDING'`. Apply `applyClassicDdsCompletion` to the latest classic state, CAS revision/state/action deletion/alarm recomputation atomically, update in-memory caches, then deliver event/snapshots after commit. A mismatch returns without deleting or rescheduling anything.

- [ ] **Step 6G: Run settlement tests and verify GREEN**

Run: `node --test workers/test/room-classic-dds.test.mjs`

Expected: success, command race, replacement, and repeated completion pass.

- [ ] **Step 7: Write failing alarm/retry/eviction tests**

Fail DDS three times and assert a failure updates only a row matching the descriptor's exact incarnation/generation/deal/attempt: attempt 1→2 due +5s and attempt 2→3 due +30s, with no gameplay error or classic revision on retry scheduling. An older overlapping failure cannot advance or overwrite a newer attempt. Feed a malformed table and assert it follows the identical retry/terminal-failure path. On attempt 3, assert one revision increment, FAILED/null table, action deletion, and recipient snapshots. Evict after start and between retries; `recoverAlarm` and `alarm()` must resume the persisted action. Unknown/malformed action rows fail closed without touching a valid replacement, and room closing still cleans them through the existing lifecycle.

- [ ] **Step 7R: Run recovery tests and verify RED**

Run: `node --test workers/test/room-classic-dds.test.mjs`

Expected: alarm dispatcher does not recognize `classic-dd-table`.

- [ ] **Step 8: Implement retry and alarm recovery**

Extend the due-action dispatcher with the classic kind. The alarm snapshots a descriptor under `runStateMutation`, releases the gate before awaiting DDS, then settles/retries through the gate again. For attempts 1/2, update only the row whose incarnation/generation/deal/current attempt still match and recompute the earliest alarm in the same storage transaction. For terminal failure, call the same guarded settlement using `{failed:true,ddTable:null}`. Preserve existing handshake/expiry/release ordering and never hold either the mutation gate or a storage transaction across DDS computation.

- [ ] **Step 8G: Run DDS and lifecycle regressions**

Run: `node --test workers/test/room-classic-dds.test.mjs workers/test/room-lifecycle.integration.test.mjs workers/test/feasibility-room.test.mjs`

Expected: all DDS race/recovery and existing action lifecycle tests pass.

- [ ] **Step 9: Expose only test seams and commit**

If Miniflare needs deterministic DDS/fault control, add narrowly gated `ROOM_FOUNDATION_TEST === 'true'` methods to the wrapper/runtime helper; production behavior must always use embedded Wasm and no public route.

```powershell
git add workers/src/dds-wasm-adapter.mjs workers/src/room-foundation/classic-dds-action.mjs workers/src/room-foundation/stepstone-room.mjs workers/src/index.mjs workers/test/dds-adapter.test.mjs workers/test/room-classic-dds.test.mjs workers/test/helpers/room-worker-runtime.mjs
git commit -m "feat: recover classic DDS actions"
```

### Task 15: Prove Free-Plan Cost and Bundle Compatibility

**Files:**
- Modify: `workers/src/room-foundation/budget-model.mjs`
- Modify: `workers/test/room-budget-model.test.mjs`
- Modify: `workers/test/room-budget-accounting.integration.test.mjs`
- Modify: `scripts/simulate-worker-room-budget.mjs`
- Modify: `workers/test/room-foundation-routing.test.mjs`

- [ ] **Step 1: Write failing DDS budget cases**

Set the reproducible Plan B classic scenario to exactly **one complete played deal per modeled room** within the existing 1,000-command reservation. First use Miniflare SQL accounting to observe separately: atomic action creation plus alarm, guarded retry-row/alarm updates, matching action delete, and trusted classic-state settlement. Assert each observation has the expected table/index/alarm/delete split and that ordinary commands still read/write one state row with zero recipient reads. Add explicit named modeled operations equal to those measured profiles. Worst-case compute accounting includes **four DDS computations**: overlapping immediate/backstop executions of logical attempt 1, then attempts 2 and 3. Run both one-deal variants: successful completion after eviction and attempt-3 exhaustion; each also includes a maximum legal auction, 52 plays, and reconnect snapshots. Assert all five Plan B targets and Free allowances pass without summing mutually exclusive success/failure settlement variants.

- [ ] **Step 1R: Run budget tests and verify RED**

Run: `node --test workers/test/room-budget-model.test.mjs`

Expected: accounting lacks classic DDS observations and the report omits the measured operations/scenarios.

- [ ] **Step 2: Extend measured budget model and simulator output**

Keep ordinary command cost at one room-state read/write and zero per-recipient reads. Add the bounded one-deal DDS action costs separately from the exact integration observations, assert every modeled DDS SQL cost equals its observed profile, and include four worst-case compute executions plus alarm handler billing/duration/storage. Expose `classicDealsPerRoom:1`, `logicalDdsAttemptsPerDeal:3`, and `maxDdsComputationsPerDeal:4` in the report scenario, and make the simulator print the one-deal assumption and both outcome variants. Do not relax existing targets to make a failure pass.

- [ ] **Step 2G: Run budget simulator**

Run: `node --test workers/test/room-budget-accounting.integration.test.mjs workers/test/room-budget-model.test.mjs`

Run: `npm run simulate:workers-room-budget`

Expected: measured/model equality passes, the process exits 0, and every target/free-plan gate is true with explicit DDS rows/requests/computations.

- [ ] **Step 3: Add dry-run and route-closure assertions**

Assert Wrangler retains `workers_dev:false`, no route/custom-domain entry, and the only public room routing remains gated by exact `ROOM_FOUNDATION_TEST === 'true'`. Run the real bundle so the CommonJS shared core and embedded Wasm imports are proven together.

- [ ] **Step 3G: Run build/route gates**

Run: `node --test workers/test/room-foundation-routing.test.mjs`

Run: `npx --no-install wrangler deploy --dry-run --config workers/wrangler.jsonc`

Expected: tests and bundle succeed; output performs no network deployment and defines no public route.

- [ ] **Step 4: Run Worker suite and commit**

Run: `npm run test:workers`

Expected: zero failures.

```powershell
git add workers/src/room-foundation/budget-model.mjs workers/test/room-budget-model.test.mjs workers/test/room-budget-accounting.integration.test.mjs scripts/simulate-worker-room-budget.mjs workers/test/room-foundation-routing.test.mjs
git commit -m "test: budget classic Durable Object flow"
```

## Chunk 4: Cross-Platform Parity and Milestone Gates

### Task 16: Prove Shared-Core Parity Across Node and Durable Objects

**Files:**
- Create: `test/classic-cross-platform-parity.test.js`
- Create: `test/fixtures/classic-transcripts.json`
- Modify if a proven divergence exists: `classic/*.cjs`
- Modify if a proven divergence exists: `classic/node-adapter.js`
- Modify if a proven divergence exists: `server.js`
- Modify if a proven divergence exists: `workers/src/room-foundation/{classic-command,room-view,stepstone-room}.mjs`
- Modify: `test/helpers/classic-fixtures.js`
- Modify: `workers/test/room-classic-runtime.test.mjs`

- [ ] **Step 1: Define fixed transport-neutral transcripts**

Store at least: passed-out board, doubled/redoubled made contract, defeated contract, dummy-controlled play, maximum-length legal auction, 52-card play, and next-deal readiness. A fixture uses `deals:[...]` indexed by deal number (not a singular deal), plus the complete canonical actor/command sequence, so the next-deal case has at least two independently validated 52-card deals. No expected state is copied from either adapter. Construct the maximum auction with three opening passes, then every legal contract/X/XX opportunity separated by the maximum two nonterminal passes, and the final three passes; independently assert exactly **319 calls**, every call legal, and auction termination only at the last call.

- [ ] **Step 2: Write the failing parity runner**

For every fixture, execute the pure core, Node adapter, and real Miniflare Durable Object with DDS paused on both adapters (a deferred Node promise and the exact-gated Worker DDS controller). Translate canonical symbol card ranks to Worker integers only at the Worker input boundary. Before each Worker command, read its latest authoritative snapshot revision; never reuse a guessed revision. Require every transcript item to produce its expected successful compact reply on all three paths and assert the complete command list was consumed—no rejected/skipped item may be omitted from comparison. After each item, select and validate exactly every `CLASSIC_STATE_KEYS` field from each path and compare byte-equal objects; do not use a recursive normalizer or ignore a classic field. At named DDS checkpoints, settle both adapters with the same fixed valid table, wait for their trusted update, then compare again; otherwise `ddsStatus` remains PENDING. Separately assert each adapter's event/view contract and recipient privacy.

- [ ] **Step 2R: Run parity test and verify RED**

Run: `node --test test/classic-cross-platform-parity.test.js`

Expected: FAIL until both adapters expose the test transcript seams and all mappings agree.

- [ ] **Step 3: Add minimal transcript seams and fix only proven divergence**

Reuse existing adapter functions/runtime helpers and their deterministic deal/DDS seams; do not add a third rules implementation. Any mismatch must be corrected at the shared core or the responsible transport mapper, with a focused regression assertion added before the fix. The parity test may remove outer room revision/name metadata only by selecting the exact canonical classic object; it may not rewrite its contents.

- [ ] **Step 3G: Run cross-platform and focused suites**

Run: `node --test test/classic-cross-platform-parity.test.js test/classic-node-adapter.test.js test/classic-server-integration.test.js`

Run: `node --test workers/test/room-classic-runtime.test.mjs workers/test/room-classic-dds.test.mjs`

Expected: every transcript is canonically equal and all transport-specific assertions pass.

- [ ] **Step 4: Commit**

```powershell
git add classic server.js workers/src/room-foundation/classic-command.mjs workers/src/room-foundation/room-view.mjs workers/src/room-foundation/stepstone-room.mjs test/classic-cross-platform-parity.test.js test/fixtures/classic-transcripts.json test/helpers/classic-fixtures.js workers/test/room-classic-runtime.test.mjs
git commit -m "test: prove classic cross-platform parity"
git status --short
```

Expected after commit: clean status; every implementation file changed to fix a proven parity divergence is included.

### Task 17: Run Final Regression, Safety, and Scope Gates

**Files:**
- Modify if necessary: `README.md`
- Modify: `docs/superpowers/specs/2026-10-15-classic-mode-core-migration-design.md` only to record verified completion evidence, not to redesign scope

- [ ] **Step 1: Run all Node tests**

Run: `npm test`

Expected: zero failures, including standard classic, teaching, ultimate, problem, complex, DDS wrapper, and server integration tests.

- [ ] **Step 2: Run the server smoke gate**

Run: `npm run test:server:smoke`

Expected: server starts on an ephemeral port, answers the smoke probe, and exits cleanly with no leaked handles.

- [ ] **Step 3: Run all Worker tests serially**

Run: `npm run test:workers`

Expected: zero failures, including room lifecycle, protocol, classic flow/privacy, DDS recovery, SQL accounting, route closure, and prior DDS feasibility tests.

- [ ] **Step 4: Run budget and bundle gates**

Run: `npm run simulate:workers-room-budget`

Run: `npx --no-install wrangler deploy --dry-run --config workers/wrangler.jsonc`

Expected: every budget gate passes and dry-run bundles successfully without deploying.

- [ ] **Step 5: Review the implementation diff before documentation**

Require `git status --short` to be empty, then use `@superpowers:requesting-code-review` with the design spec, full committed diff, and verification outputs. If the review is clean, record that result and skip the conditional fix commit. If it finds a confirmed issue, add a regression assertion, fix it at its owning task, and rerun the smallest affected test plus Steps 1–4. Because the status was clean immediately before review, stage the complete reviewed fix set—including any new regression/helper file—and commit it atomically:

```powershell
git add --all
git diff --cached --check
git commit -m "fix: address classic migration review"
git status --short
```

Expected: either no fix commit was needed, or one clean, reviewed fix commit exists and status is empty. Do not run the commit command when there are no changes.

- [ ] **Step 6: Record concise verified architecture notes**

Capture `git rev-parse HEAD` now as the **final implementation commit** (the later documentation commit is intentionally not self-referenced). Update README only if current startup/testing text would otherwise mislead: Node/Socket.IO remains the production browser path; Durable Object classic parity is test-gated backend work; no Worker endpoint has been published. In the design spec, replace its implementation-status note with a concise verified-evidence section naming the completed scope, that final implementation commit, and the four passing gate commands; do not paste generated logs or credentials.

- [ ] **Step 7: Commit milestone documentation**

```powershell
git add README.md docs/superpowers/specs/2026-10-15-classic-mode-core-migration-design.md
git commit -m "docs: record classic backend parity gates"
```

- [ ] **Step 8: Re-run final gates after all commits**

Run Steps 1–4 again against the documented final tree. Expected: all Node, server smoke, Worker, budget, and dry-run bundle gates pass after both review fixes and documentation.

- [ ] **Step 9: Audit the final committed milestone boundary**

Run:

```powershell
git diff --name-status workers-room-foundation-v1...HEAD
git diff --exit-code workers-room-foundation-v1...HEAD -- public
git diff workers-room-foundation-v1...HEAD -- workers/wrangler.jsonc workers/src/index.mjs workers/src/room-foundation/router.mjs package.json .github scripts
rg -n '"routes"|custom_domains|workers_dev' workers/wrangler.jsonc
git diff --check workers-room-foundation-v1...HEAD
```

Expected: the complete name-status list contains only milestone files; the `public/` diff is empty; `workers_dev` remains false; no routes/custom domains/DNS/deployment workflow or public frontend transport changes exist; `index.mjs` still exposes room routing only through the existing exact test gate; diff check is clean. Inspect the full baseline diff for credentials/token-shaped literals and require none—there is no exemption for unrelated frontend content on this branch.

- [ ] **Step 10: Prepare integration handoff**

Run `git diff --check` and `git status --short`; expected clean status after the documentation commit. Use `@superpowers:verification-before-completion`, then `@superpowers:finishing-a-development-branch`. Report the exact passing commands and commits. Do not deploy, create a public route, change `stepstone.hogetsu.uk`, or alter DNS in this milestone.


