# Complex Bridge Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-player complex-bridge mode with 52 complex cards, simultaneous partnership bidding, and independent four-seat trick play.

**Architecture:** Isolate deck, follow-suit, trick comparison, and bid adjudication in a testable CommonJS rules module. Extend the existing Socket.IO room flow with a compact complex-game state, and add a dedicated page that renders each controllable 13-card hand as a complex-plane matrix.

**Tech Stack:** Node.js, Express, Socket.IO, vanilla JavaScript, CSS.

---

### Task 1: Rules engine

**Files:** Create `complex-bridge.js`, `test/complex-bridge.test.js`.

- [ ] Write failing Node assertions for deck size/identity, directional following, Ace trump order, and bid settlement.
- [ ] Run `node test/complex-bridge.test.js` and verify missing-module failure.
- [ ] Implement the smallest rules module that passes those assertions.
- [ ] Re-run the test file.

### Task 2: Server mode

**Files:** Modify `server.js`.

- [ ] Add complex room ownership, two-player seating, deal/bid/play state, Socket.IO handlers, and reconnection snapshots.
- [ ] Validate every card server-side and emit only partnership-private hands.
- [ ] Verify syntax with `node --check server.js`.

### Task 3: Lobby and client

**Files:** Modify `public/index.html`, `public/js/lobby.js`, `public/css/main.css`; create `public/complex.html`, `public/js/complex-game.js`, `public/css/complex.css`.

- [ ] Add the complex-mode tile with disabled Mahjong and active Bridge entry.
- [ ] Redirect complex room members to the dedicated page.
- [ ] Render each local seat as a labeled 5×5 complex plane; support bidding, turn-specific card clicks, result, and reconnection.
- [ ] Verify JavaScript syntax using `node --check` for all new scripts.

### Task 4: End-to-end verification

**Files:** All above.

- [ ] Run rules assertions and server/client syntax checks.
- [ ] Start the server and confirm it exposes the new pages.
- [ ] Commit and push after Git permissions recover.
