'use strict';
const fs = require('node:fs');

const { ddsSetupHint, resolveDdsPaths } = require('./dds-paths');
const { runDdsProcess } = require('./dds-process');

// Suit index: S=0, H=1, D=2, C=3  (matches DDS constants.h card_suit order)
const SUIT_IDX      = { S:0, H:1, D:2, C:3 };
const SUIT_FROM_IDX = ['S', 'H', 'D', 'C'];
// Hand index: N=0, E=1, S=2, W=3
const HAND_IDX      = { N:0, E:1, S:2, W:3 };
// Trump index: S=0, H=1, D=2, C=3, NT=4
const TRUMP_IDX     = { S:0, H:1, D:2, C:3, NT:4 };
// Rank value (same as server.js RANK_VAL)
const RANK_VAL = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };

function handsToBitmasks(hands) {
  // Returns 4×4 array: remainCards[hand][suit] as unsigned int bitmask
  // DDS encoding: rank r → bit r (2=0x0004, 3=0x0008, ..., A(14)=0x4000)
  const rc = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  for (const [seat, cards] of Object.entries(hands)) {
    const h = HAND_IDX[seat];
    for (const card of cards) {
      const s = SUIT_IDX[card.suit];
      const r = typeof card.rank === 'number' ? Math.round(card.rank) : (RANK_VAL[card.rank] || parseInt(card.rank));
      rc[h][s] |= (1 << r);
    }
  }
  return rc;
}

// calcDDTable: full double-dummy table for all 5 strains × 4 hands
// Resolve: table[strain][hand] = total tricks (0-13)
// strain: 0=S, 1=H, 2=D, 3=C, 4=NT   hand: 0=N, 1=E, 2=S, 3=W
function createDdsClient({ paths, runProcess, existsSync }) {
  function checkBinary(programPath) {
    if (!existsSync(programPath)) {
      throw new Error(`DDS binary not found: ${programPath}; ${ddsSetupHint(paths)}`);
    }
  }

  async function calcDDTable(hands) {
    checkBinary(paths.calc);
    const input = handsToBitmasks(hands).flat().join(' ');
    const output = await runProcess(paths.calc, input);
    const trimmed = output.trim();
    const nums = trimmed
      ? trimmed.split(/\s+/).map(Number).filter(Number.isFinite)
      : [];
    if (nums.length !== 20) throw new Error('Unexpected DDS output length: ' + nums.length);

    // Build table[strain 0-4][hand 0-3]
    const table = [];
    for (let s = 0; s < 5; s++) table.push(nums.slice(s * 4, s * 4 + 4));
    return table;
  }

// solveBoard: find optimal card(s) for the current player at a specific game position
//
// deal: {
//   trump:        'S'|'H'|'D'|'C'|'NT'
//   trickLeader:  'N'|'E'|'S'|'W'  (leader of current trick; equals currentPlayer if trick just started)
//   trickPlayed:  [{suit, rank}, ...]  (cards already played in current trick, in play order, 0-3 entries)
//   hands:        {N:[{suit,rank},...], E:[...], S:[...], W:[...]}  (remaining cards for each seat)
// }
//
// Returns Promise<{ score: number, cards: [{suit, rank}] }>
//   score = tricks the trickLeader's side can guarantee from this position onwards
//   cards = all equally-optimal cards for the CURRENT player to play
//
// Note on `score` interpretation: this is the count of REMAINING tricks the CURRENT PLAYER's side
// can guarantee, starting from (and including) the current trick.
// The "current player" is determined by: first + trickLen (mod 4).
// Example: trickLeader=S (NS), trickLen=3, current player=E (EW) → score = EW guaranteed tricks.
  async function solveBoard(deal) {
    checkBinary(paths.solve);

    const trumpIdx  = TRUMP_IDX[deal.trump] ?? 4;
    const firstIdx  = HAND_IDX[deal.trickLeader];
    const trickLen  = (deal.trickPlayed || []).length;

    // Build remaining-cards bitmasks
    const rc = handsToBitmasks(deal.hands);

    // Assemble input line: trump first trickLen [suit rank]×trickLen [bitmask]×16
    let input = `${trumpIdx} ${firstIdx} ${trickLen}`;
    for (const card of (deal.trickPlayed || [])) {
      const s = SUIT_IDX[card.suit];
      const r = typeof card.rank === 'number' ? Math.round(card.rank) : (RANK_VAL[card.rank] || parseInt(card.rank));
      input += ` ${s} ${r}`;
    }
    for (let h = 0; h < 4; h++)
      for (let s = 0; s < 4; s++)
        input += ` ${rc[h][s]}`;
    input += '\n';

    const output = await runProcess(paths.solve, input);
    const trimmed = output.trim();
    if (!trimmed) throw new Error('dds_solve: empty output');

    const nums = trimmed.split(/\s+/).map(Number);
    if (nums.length < 2) throw new Error('dds_solve: empty output');
    const score    = nums[0];
    const numCards = nums[1];
    const cards    = [];
    for (let i = 0; i < numCards; i++) {
      const suitI = nums[2 + i * 2];
      const rank  = nums[3 + i * 2];
      if (!isNaN(suitI) && !isNaN(rank)) {
        cards.push({ suit: SUIT_FROM_IDX[suitI], rank });
      }
    }
    return { score, cards };
  }

  return { calcDDTable, solveBoard };
}

const defaultClient = createDdsClient({
  paths: resolveDdsPaths({ rootDir: __dirname }),
  runProcess: runDdsProcess,
  existsSync: fs.existsSync,
});

module.exports = {
  calcDDTable: defaultClient.calcDDTable,
  solveBoard: defaultClient.solveBoard,
  createDdsClient,
};
