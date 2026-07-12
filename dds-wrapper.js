'use strict';
const { spawn } = require('child_process');
const path  = require('path');
const fs    = require('fs');

const DDS_EXE       = path.join(__dirname, 'dds', 'Build', 'bin', 'x64', 'Release', 'dds_calc.exe');
const DDS_SOLVE_EXE = path.join(__dirname, 'dds', 'Build', 'bin', 'x64', 'Release', 'dds_solve.exe');

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
function calcDDTable(hands) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DDS_EXE)) {
      return reject(new Error('dds_calc.exe not found — build DDS first (see dds/CLAUDE.md)'));
    }
    const input = handsToBitmasks(hands).flat().join(' ');
    const proc  = spawn(DDS_EXE);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('DDS process failed: ' + err.trim()));
      const nums = out.trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
      if (nums.length !== 20) return reject(new Error('Unexpected DDS output length: ' + nums.length));
      // Build table[strain 0-4][hand 0-3]
      const table = [];
      for (let s = 0; s < 5; s++) table.push(nums.slice(s * 4, s * 4 + 4));
      resolve(table);
    });
    proc.stdin.write(input);
    proc.stdin.end();
  });
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
function solveBoard(deal) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DDS_SOLVE_EXE)) {
      return reject(new Error('dds_solve.exe not found — build DDS first (run dds/build_calc.bat)'));
    }

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

    const proc = spawn(DDS_SOLVE_EXE);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`dds_solve failed (code ${code}): ${err.trim()}`));
      const nums = out.trim().split(/\s+/).map(Number);
      if (nums.length < 2) return reject(new Error('dds_solve: empty output'));
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
      resolve({ score, cards });
    });
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

module.exports = { calcDDTable, solveBoard };
