#!/usr/bin/env node
// spdsl-compile.js — Stepstone Problem DSL compiler
//
// Usage:
//   node spdsl-compile.js input.spdsl
//       → prints JSON fragment: { ewHands, testCases }
//
//   node spdsl-compile.js input.spdsl template.json
//       → merges fragment into template.json and prints full problem JSON
//
// The output "ewHands" field comes from TC0's dist (top-level default).
// Subsequent TCs include "ewHands" only if their dist differs from TC0.

'use strict';
const fs = require('fs');

// ── Card helpers ────────────────────────────────────────────────────────────

const RANK_MAP = {
  '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,
  'T':10,'J':11,'Q':12,'K':13,'A':14
};
const SUIT_SET = new Set(['S','H','D','C']);

function parseCard(token) {
  const t = token.toUpperCase();
  // ANY: accept any card (NS-side wildcard, no suit/rank check)
  if (t === 'ANY') return { suit: null, rank: 'ANY' };
  const suit = t[0];
  const rankStr = t.slice(1);
  if (!SUIT_SET.has(suit)) throw new Error(`Unknown suit in card token: "${token}"`);
  // Dynamic selectors: H_MAX / H_MIN / H_WIN → highest/lowest/min-winning of that suit at runtime
  const sel = rankStr.replace(/^_/, ''); // accept both H_MAX and HMAX
  if (sel === 'MAX' || sel === 'MIN' || sel === 'WIN' || sel === 'ANY' || sel === 'LT_10') return { suit, rank: sel };
  const rank = RANK_MAP[rankStr];
  if (rank === undefined) throw new Error(`Unknown rank in card token: "${token}"`);
  return { suit, rank };
}

function parseCardList(tokens) {
  return tokens.filter(Boolean).map(parseCard);
}

function cardsEqual(a, b) {
  return a.suit === b.suit && a.rank === b.rank;
}

function handsEqual(ha, hb) {
  if (ha.length !== hb.length) return false;
  const sorted = h => [...h].sort((x, y) => x.suit < y.suit ? -1 : x.suit > y.suit ? 1 : x.rank - y.rank);
  const sa = sorted(ha), sb = sorted(hb);
  return sa.every((c, i) => cardsEqual(c, sb[i]));
}

// ── Parser ──────────────────────────────────────────────────────────────────

function stripComments(src) {
  return src.split('\n')
    .map(line => line.replace(/#.*$/, '').trimEnd())
    .join('\n');
}

function parseDSL(src) {
  const clean = stripComments(src);
  const lines = clean.split('\n');

  const dists = {};   // name → { parent, patches }
  const scripts = {}; // name → [{seat, card}]
  const tcs = [];     // [{label, dist, from, script}]

  let i = 0;

  function peek() { return i < lines.length ? lines[i].trim() : null; }
  function next() { return i < lines.length ? lines[i++].trim() : null; }

  function readBlock() {
    // Current line already consumed and ended with '{'; read until matching '}'
    const body = [];
    while (i < lines.length) {
      const line = next();
      if (line === '}') break;
      if (line === '') continue;
      body.push(line);
    }
    return body;
  }

  while (i < lines.length) {
    const line = next();
    if (!line) continue;

    // ── DIST ──
    if (/^DIST\s/.test(line)) {
      const m = line.match(/^DIST\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{$/);
      if (!m) throw new Error(`Malformed DIST declaration: "${line}"`);
      const [, name, parent] = m;
      const patches = {}; // key → cards  key = 'E'|'W'|'E.H'|'W.S' etc.
      for (const bl of readBlock()) {
        const mSuit = bl.match(/^([EW])\.([SHDC]):\s+(.+)$/i);
        const mFull = bl.match(/^([EW]):\s+(.+)$/i);
        if (mSuit) {
          const seat = mSuit[1].toUpperCase();
          const suit = mSuit[2].toUpperCase();
          const ranks = mSuit[3].trim().split(/\s+/);
          patches[`${seat}.${suit}`] = ranks.map(r => {
            const rank = RANK_MAP[r.toUpperCase()];
            if (rank === undefined) throw new Error(`Unknown rank "${r}" in DIST ${name}`);
            return { suit, rank };
          });
        } else if (mFull) {
          const seat = mFull[1].toUpperCase();
          const tokens = mFull[2].trim().split(/\s+/);
          patches[seat] = parseCardList(tokens);
        } else {
          throw new Error(`Unrecognized line in DIST "${name}": "${bl}"`);
        }
      }
      dists[name] = { parent: parent || null, patches };
      continue;
    }

    // ── SCRIPT ──
    if (/^SCRIPT\s/.test(line)) {
      const m = line.match(/^SCRIPT\s+(\w+)\s*\{$/);
      if (!m) throw new Error(`Malformed SCRIPT declaration: "${line}"`);
      const [, name] = m;
      const plays = [];
      for (const bl of readBlock()) {
        const mp = bl.match(/^([NSEW]):\s+(\S+)$/i);
        if (!mp) throw new Error(`Unrecognized line in SCRIPT "${name}": "${bl}"`);
        plays.push({ seat: mp[1].toUpperCase(), card: parseCard(mp[2]) });
      }
      scripts[name] = plays;
      continue;
    }

    // ── TESTCASES ──
    if (/^TESTCASES\s*\{$/.test(line)) {
      // 直接逐行读取（不用 readBlock），以便正确处理内嵌 TC { } 子块
      while (i < lines.length) {
        const bl = next();
        if (bl === null || bl === undefined) continue;
        if (bl === '') continue;
        if (bl === '}') break;  // TESTCASES 结束

        const mBlock = bl.match(/^TC(?:\s+(\w+))?\s+(.+\S)\s*\{$/);
        const mLine  = !mBlock && bl.match(/^TC(?:\s+(\w+))?\s+(.+)$/);
        const m = mBlock || mLine;
        if (!m) throw new Error(`Unrecognized line in TESTCASES: "${bl}"`);
        const label = m[1] || null;
        const params = {};
        for (const kv of m[2].matchAll(/(\w+)=(\S+)/g)) {
          params[kv[1]] = kv[2];
        }
        if (!params.dist)   throw new Error(`TC "${label || '?'}" missing dist=`);
        if (!params.script) throw new Error(`TC "${label || '?'}" missing script=`);
        const tcEntry = {
          label,
          dist:     params.dist,
          from:     params.from !== undefined ? parseInt(params.from, 10) : 0,
          script:   params.script,
          branches: [],
        };
        // 若以 { 结尾，读取内部 BRANCH 指令直到对应的 }
        if (mBlock) {
          while (i < lines.length) {
            const sub = next();
            if (sub === null || sub === undefined || sub === '') continue;
            if (sub === '}') break;
            const mb = sub.match(/^BRANCH\s+(.+)$/);
            if (!mb) throw new Error(`Unrecognized line in TC block: "${sub}"`);
            const bp = {};
            for (const kv of mb[1].matchAll(/(\w+)=(\S+)/g)) bp[kv[1]] = kv[2];
            if (bp.at === undefined) throw new Error(`BRANCH missing at=`);
            if (!bp.script)         throw new Error(`BRANCH missing script=`);
            tcEntry.branches.push({ at: parseInt(bp.at, 10), script: bp.script });
          }
        }
        tcs.push(tcEntry);
      }
      continue;
    }

    if (line) {
      throw new Error(`Unexpected top-level line: "${line}"`);
    }
  }

  return { dists, scripts, tcs };
}

// ── Distribution resolution ─────────────────────────────────────────────────

function resolveDist(name, dists, visited = new Set()) {
  if (visited.has(name)) throw new Error(`Circular DIST extends: ${name}`);
  visited.add(name);

  const d = dists[name];
  if (!d) throw new Error(`Unknown DIST: "${name}"`);

  let base = { E: [], W: [] };
  if (d.parent) {
    base = resolveDist(d.parent, dists, visited);
  }

  const result = { E: [...base.E], W: [...base.W] };

  for (const [key, cards] of Object.entries(d.patches)) {
    if (key === 'E' || key === 'W') {
      result[key] = [...cards];
    } else {
      // e.g. "E.H" — replace all cards of that suit for that seat
      const [seat, suit] = key.split('.');
      result[seat] = result[seat].filter(c => c.suit !== suit).concat(cards);
    }
  }

  // Validate: 13 cards per seat
  for (const seat of ['E', 'W']) {
    if (result[seat].length !== 13) {
      console.warn(`Warning: DIST "${name}" seat ${seat} has ${result[seat].length} cards (expected 13)`);
    }
  }

  return result;
}

// ── Compiler ────────────────────────────────────────────────────────────────

function compile(src) {
  const { dists, scripts, tcs } = parseDSL(src);

  if (tcs.length === 0) throw new Error('No TESTCASES defined');

  const resolved = tcs.map(tc => {
    const ewHands = resolveDist(tc.dist, dists);
    const script = scripts[tc.script];
    if (!script) throw new Error(`Unknown SCRIPT: "${tc.script}"`);
    return { ...tc, ewHands, script };
  });

  // TC0's ewHands become the top-level "ewHands" in the problem JSON
  const topEwHands = resolved[0].ewHands;

  const testCases = resolved.map((tc, idx) => {
    const obj = {};

    // Include ewHands if different from TC0 (or always for TC1+, to be explicit)
    if (idx > 0) {
      obj.ewHands = tc.ewHands;
    }
    if (tc.from > 0) {
      obj.branchTrick = tc.from;
    }
    obj.script = tc.script;

    // Deviation branches: { at, script: scriptName } → { at, script: resolvedPlayArray }
    if (tc.branches && tc.branches.length > 0) {
      obj.deviationBranches = tc.branches.map(b => {
        const branchScript = scripts[b.script];
        if (!branchScript) throw new Error(`Unknown SCRIPT in BRANCH: "${b.script}"`);
        return { at: b.at, script: branchScript };
      });
    }

    return obj;
  });

  return { ewHands: topEwHands, testCases };
}

// ── Entry point ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help') {
  console.error([
    'Usage:',
    '  node spdsl-compile.js <input.spdsl>',
    '      Print JSON fragment: { ewHands, testCases }',
    '',
    '  node spdsl-compile.js <input.spdsl> <template.json>',
    '      Merge fragment into template.json and print full problem JSON',
    '',
    'Card notation: [SHDC][AKQJT98765432]  e.g. SA HQ DT C2',
    'DIST extends: E.H: Q T 5 2  (ranks only, suit from field name)',
  ].join('\n'));
  process.exit(args.length === 0 ? 1 : 0);
}

let src;
try {
  src = fs.readFileSync(args[0], 'utf8');
} catch (e) {
  console.error(`Cannot read "${args[0]}": ${e.message}`);
  process.exit(1);
}

let fragment;
try {
  fragment = compile(src);
} catch (e) {
  console.error(`Compile error: ${e.message}`);
  process.exit(1);
}

if (args[1]) {
  // Merge into template JSON
  let template;
  try {
    template = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  } catch (e) {
    console.error(`Cannot read template "${args[1]}": ${e.message}`);
    process.exit(1);
  }
  const out = { ...template, ewHands: fragment.ewHands, testCases: fragment.testCases };
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(JSON.stringify(fragment, null, 2));
}
