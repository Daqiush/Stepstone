#!/usr/bin/env node
// spdsl-gen.js — SPDSL GEN block expander
//
// Usage:
//   node spdsl-gen.js input.spdsl [template.json]
//       Processes GEN blocks and outputs expanded SPDSL or full problem JSON.
//
// A GEN block describes abstract trump-extraction rules and is expanded into
// a set of concrete SCRIPT entries — one per valid card combination path.
//
// GEN block syntax (embedded in a .spdsl file):
//
//   GEN <name> {
//     DIST <dist_name>          # hand state reference (must be defined above)
//     PREFIX { <plays> }        # fixed pre-extraction plays (advances hand state)
//
//     TRICK {                   # one extraction trick
//       <seat>: HIGH(<suit>)    # enumerate: all cards in hand > all opp cards of suit
//       <seat>: LOW(<suit>)     # enumerate: all non-high cards of suit in hand
//       <seat>: MIN(<suit>)     # fixed: lowest card of suit in hand
//       <seat>: MAX(<suit>)     # fixed: highest card of suit in hand
//       <seat>: FOLLOW(<suit>)  # fixed: lowest card of suit (forced follow, no enumerate)
//       <seat>: DISCARD(<suit>) # fixed: lowest card of suit (forced discard, no enumerate)
//     }
//     ...more TRICKs
//   }
//
// Generated scripts are named <name>_path0, <name>_path1, etc.
// Generated TESTCASES inherit dist and from from the GEN block context.

'use strict';
const fs = require('fs');
const path = require('path');

// ── Card helpers ─────────────────────────────────────────────────────────────

const RANK_MAP = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };
const RANK_SYM = { 14:'A',13:'K',12:'Q',11:'J',10:'T',9:'9',8:'8',7:'7',6:'6',5:'5',4:'4',3:'3',2:'2' };
const SUIT_SET = new Set(['S','H','D','C']);

function parseCard(token) {
  const t = token.toUpperCase();
  const suit = t[0];
  if (!SUIT_SET.has(suit)) throw new Error(`Bad suit: "${token}"`);
  const rs = t.slice(1).replace(/^_/,'');
  if (rs === 'MAX' || rs === 'MIN') return { suit, rank: rs };
  const rank = RANK_MAP[rs];
  if (rank === undefined) throw new Error(`Bad rank: "${token}"`);
  return { suit, rank };
}

function cardStr(c) {
  if (c.rank === 'MAX' || c.rank === 'MIN') return c.suit + '_' + c.rank;
  return c.suit + RANK_SYM[c.rank];
}

function removeCard(hand, card) {
  const idx = hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
  if (idx < 0) return hand;
  const h = [...hand]; h.splice(idx, 1); return h;
}

function suitMax(hand, suit) {
  const sc = hand.filter(c => c.suit === suit);
  return sc.length === 0 ? null : sc.reduce((b,c) => c.rank > b.rank ? c : b);
}

function suitMin(hand, suit) {
  const sc = hand.filter(c => c.suit === suit);
  return sc.length === 0 ? null : sc.reduce((b,c) => c.rank < b.rank ? c : b);
}

function oppMaxRank(ewHands, suit) {
  // Highest rank among E+W for given suit
  let best = 0;
  for (const seat of ['E','W']) {
    for (const c of ewHands[seat]) {
      if (c.suit === suit && c.rank > best) best = c.rank;
    }
  }
  return best;
}

// ── GEN block parser ─────────────────────────────────────────────────────────

// Parse a sequence of "SEAT: RULE" lines
// Returns [{seat, ruleType, suit, fixed?}]
function parseTrickRules(lines) {
  return lines.map(line => {
    const m = line.match(/^([NSEW]):\s*(\w+)\(([SHDC])\)$/i);
    if (!m) throw new Error(`Bad TRICK line: "${line}"`);
    const seat = m[1].toUpperCase();
    const rule = m[2].toUpperCase();
    const suit = m[3].toUpperCase();
    if (!['HIGH','LOW','MIN','MAX','FOLLOW','DISCARD'].includes(rule))
      throw new Error(`Unknown rule "${rule}" in TRICK`);
    return { seat, rule, suit };
  });
}

// Parse a PREFIX block: returns [{seat, card}]
function parsePrefixLines(lines) {
  // Lines may contain space-separated seat:card tokens within a line
  const plays = [];
  for (const line of lines) {
    // e.g. "W: CK  N: C2  E: C4  S: CA" or "W: CK"
    for (const m of line.matchAll(/([NSEW]):\s*([A-Z0-9_]+)/gi)) {
      plays.push({ seat: m[1].toUpperCase(), card: parseCard(m[2]) });
    }
  }
  return plays;
}

// Parse a GEN block body, returning { distName, prefix, tricks }
function parseGenBody(bodyLines) {
  const result = { distName: null, prefix: [], tricks: [] };
  let i = 0;

  while (i < bodyLines.length) {
    const line = bodyLines[i++].trim();
    if (!line) continue;

    if (line.startsWith('DIST ')) {
      result.distName = line.slice(5).trim();
    } else if (line.startsWith('PREFIX {')) {
      const block = [];
      while (i < bodyLines.length) {
        const bl = bodyLines[i++].trim();
        if (bl === '}') break;
        if (bl) block.push(bl);
      }
      result.prefix = parsePrefixLines(block);
    } else if (line === 'TRICK {') {
      const block = [];
      while (i < bodyLines.length) {
        const bl = bodyLines[i++].trim();
        if (bl === '}') break;
        if (bl) block.push(bl);
      }
      result.tricks.push(parseTrickRules(block));
    }
  }
  return result;
}

// ── Path generator ───────────────────────────────────────────────────────────

// Apply PREFIX plays to hand state (returns new {NS, EW} hand state)
function applyPrefix(nsHands, ewHands, prefix) {
  let ns = { N: [...nsHands.N], S: [...nsHands.S] };
  let ew = { E: [...ewHands.E], W: [...ewHands.W] };
  for (const { seat, card } of prefix) {
    if (seat === 'N' || seat === 'S') ns[seat] = removeCard(ns[seat], card);
    else ew[seat] = removeCard(ew[seat], card);
  }
  return { ns, ew };
}

// Given rule + current hand state, return list of candidate cards (concrete)
// Returns [] if no valid card found
function candidatesForRule(rule, suit, seat, nsHands, ewHands) {
  const hand = (seat === 'N' || seat === 'S') ? nsHands[seat] : ewHands[seat];
  const suitCards = hand.filter(c => c.suit === suit);

  switch (rule) {
    case 'HIGH': {
      const oppMax = oppMaxRank(ewHands, suit);
      const highs = suitCards.filter(c => c.rank > oppMax);
      return highs; // enumerate all
    }
    case 'LOW': {
      const oppMax = oppMaxRank(ewHands, suit);
      const lows = suitCards.filter(c => c.rank <= oppMax);
      return lows; // enumerate all
    }
    case 'MIN': {
      const m = suitMin(hand, suit);
      return m ? [m] : [];
    }
    case 'MAX': {
      const m = suitMax(hand, suit);
      return m ? [m] : [];
    }
    case 'FOLLOW': {
      // Forced follow: pick lowest (no enumeration)
      const m = suitMin(hand, suit);
      return m ? [m] : [];
    }
    case 'DISCARD': {
      // Forced discard of given suit: pick lowest (no enumeration)
      const m = suitMin(hand, suit);
      return m ? [m] : [];
    }
    default:
      return [];
  }
}

// Recursive path generator
// trickRules: array of tricks (each trick = array of {seat,rule,suit})
// Returns array of paths, each path = [{seat,card}, ...]
function generatePaths(trickRules, nsHands, ewHands, pathSoFar) {
  if (trickRules.length === 0) return [pathSoFar];

  const [thisTrick, ...restTricks] = trickRules;
  const paths = [];

  // Find which seats have enumerable rules (HIGH, LOW, ANY)
  // and which have fixed rules (MIN, MAX, FOLLOW, DISCARD)
  // We enumerate the Cartesian product of all enumerable seats, then fix the rest.

  const enumSeats = thisTrick.filter(r => ['HIGH','LOW'].includes(r.rule));
  const fixedSeats = thisTrick.filter(r => !['HIGH','LOW'].includes(r.rule));

  // Build enumerable candidates
  const enumCandidates = enumSeats.map(r =>
    candidatesForRule(r.rule, r.suit, r.seat, nsHands, ewHands).map(card => ({ seat: r.seat, card }))
  );

  // Cartesian product of enum candidates
  function cartesian(arrays) {
    if (arrays.length === 0) return [[]];
    const [first, ...rest] = arrays;
    const restProduct = cartesian(rest);
    return first.flatMap(item => restProduct.map(r => [item, ...r]));
  }

  const enumCombinations = enumCandidates.length === 0 ? [[]] : cartesian(enumCandidates);

  for (const combo of enumCombinations) {
    // Build this trick's plays
    const trickPlays = [];
    let currNs = { N: [...nsHands.N], S: [...nsHands.S] };
    let currEw = { E: [...ewHands.E], W: [...ewHands.W] };

    let valid = true;

    // Apply enumerated choices first
    for (const { seat, card } of combo) {
      trickPlays.push({ seat, card });
      if (seat === 'N' || seat === 'S') currNs[seat] = removeCard(currNs[seat], card);
      else currEw[seat] = removeCard(currEw[seat], card);
    }

    // Apply fixed choices
    for (const r of fixedSeats) {
      const cards = candidatesForRule(r.rule, r.suit, r.seat, currNs, currEw);
      if (cards.length === 0) { valid = false; break; }
      const card = cards[0];
      trickPlays.push({ seat: r.seat, card });
      if (r.seat === 'N' || r.seat === 'S') currNs[r.seat] = removeCard(currNs[r.seat], card);
      else currEw[r.seat] = removeCard(currEw[r.seat], card);
    }

    if (!valid) continue;

    // Recurse
    const subPaths = generatePaths(restTricks, currNs, currEw, [...pathSoFar, ...trickPlays]);
    paths.push(...subPaths);
  }

  return paths;
}

// ── Main SPDSL processor ─────────────────────────────────────────────────────

function stripComments(src) {
  return src.split('\n').map(l => l.replace(/#.*$/, '').trimEnd()).join('\n');
}

// Parse all DIST, SCRIPT, GEN, TESTCASES blocks from src
// Returns { dists, scripts, gens, testcaseBlocks, rawSrc }
// 'rawSrc' is the source with GEN blocks replaced by generated SCRIPT blocks
function processGEN(src, nsHands) {
  const clean = stripComments(src);
  const lines = clean.split('\n');

  const dists = {};       // name → { parent, patches }
  const output = [];      // processed lines (GEN blocks replaced)
  const genScripts = [];  // [{name, dist, plays}] generated scripts
  const genTCs = [];      // [{label, dist, from, script}] generated TCs

  let i = 0;

  function readBlock() {
    const body = [];
    let depth = 1;
    while (i < lines.length) {
      const l = lines[i++].trim();
      if (l.endsWith('{')) { depth++; body.push(l); }
      else if (l === '}') { depth--; if (depth === 0) break; body.push(l); }
      else if (l) body.push(l);
    }
    return body;
  }

  // Simple DIST parsing (needed to resolve hand states)
  function parseDist(name, parent, bodyLines) {
    const patches = {};
    for (const bl of bodyLines) {
      const mSuit = bl.match(/^([EW])\.([SHDC]):\s+(.+)$/i);
      const mFull = bl.match(/^([EW]):\s+(.+)$/i);
      if (mSuit) {
        const seat = mSuit[1].toUpperCase(), suit = mSuit[2].toUpperCase();
        const ranks = mSuit[3].trim().split(/\s+/);
        patches[`${seat}.${suit}`] = ranks.map(r => {
          const rank = RANK_MAP[r.toUpperCase()];
          if (!rank) throw new Error(`Bad rank "${r}" in DIST ${name}`);
          return { suit, rank };
        });
      } else if (mFull) {
        const seat = mFull[1].toUpperCase();
        const tokens = mFull[2].trim().split(/\s+/);
        patches[seat] = tokens.map(t => {
          const s = t[0].toUpperCase(), rs = t.slice(1).toUpperCase();
          if (!SUIT_SET.has(s)) throw new Error(`Bad suit "${t}" in DIST ${name}`);
          const rank = RANK_MAP[rs]; if (!rank) throw new Error(`Bad rank "${t}" in DIST ${name}`);
          return { suit: s, rank };
        });
      }
    }
    dists[name] = { parent: parent || null, patches };
  }

  function resolveDist(name, visited = new Set()) {
    if (visited.has(name)) throw new Error(`Circular DIST: ${name}`);
    visited.add(name);
    const d = dists[name];
    if (!d) throw new Error(`Unknown DIST: "${name}"`);
    let base = { E: [], W: [] };
    if (d.parent) base = resolveDist(d.parent, visited);
    const result = { E: [...base.E], W: [...base.W] };
    for (const [key, cards] of Object.entries(d.patches)) {
      if (key === 'E' || key === 'W') result[key] = [...cards];
      else { const [seat,suit] = key.split('.'); result[seat] = result[seat].filter(c=>c.suit!==suit).concat(cards); }
    }
    return result;
  }

  while (i < lines.length) {
    const line = lines[i].trim();

    if (/^DIST\s+\w+/.test(line)) {
      const m = line.match(/^DIST\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{$/);
      if (!m) { output.push(lines[i++]); continue; }
      const [, name, parent] = m;
      i++;
      const body = readBlock();
      parseDist(name, parent, body);
      // Re-emit original DIST block verbatim
      output.push(`DIST ${name}${parent ? ` extends ${parent}` : ''} {`);
      for (const bl of body) output.push('  ' + bl);
      output.push('}');
    } else if (/^GEN\s+\w+\s*\{$/.test(line)) {
      const genName = line.match(/^GEN\s+(\w+)/)[1];
      i++;
      const body = readBlock();
      const genDef = parseGenBody(body);

      if (!genDef.distName || !dists[genDef.distName]) {
        throw new Error(`GEN "${genName}": DIST "${genDef.distName}" not found`);
      }

      const ewHands = resolveDist(genDef.distName);
      const { ns: nsAfterPrefix, ew: ewAfterPrefix } = applyPrefix(nsHands, ewHands, genDef.prefix);

      const allPaths = generatePaths(genDef.tricks, nsAfterPrefix, ewAfterPrefix, []);

      if (allPaths.length === 0) {
        console.warn(`Warning: GEN "${genName}" produced 0 paths`);
        continue;
      }

      // Each path = prefix plays + path plays
      const fullPlays = path => [...genDef.prefix, ...path];

      // Emit generated SCRIPT blocks
      for (let pi = 0; pi < allPaths.length; pi++) {
        const scriptName = `${genName}_path${pi}`;
        output.push(`SCRIPT ${scriptName} {`);
        for (const { seat, card } of fullPlays(allPaths[pi])) {
          output.push(`  ${seat}: ${cardStr(card)}`);
        }
        output.push('}');
        genScripts.push({ name: scriptName, dist: genDef.distName, plays: fullPlays(allPaths[pi]) });
      }

      // Emit generated TESTCASES block
      output.push(`# Generated TCs for GEN ${genName} (${allPaths.length} paths)`);
      output.push('TESTCASES {');
      for (let pi = 0; pi < allPaths.length; pi++) {
        const scriptName = `${genName}_path${pi}`;
        output.push(`  TC ${genName}_${pi} dist=${genDef.distName} from=0 script=${scriptName}`);
      }
      output.push('}');
    } else {
      output.push(lines[i++]);
    }
  }

  return output.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error([
    'Usage: node spdsl-gen.js <input.spdsl> [template.json]',
    '',
    'Expands GEN blocks into SCRIPT + TESTCASES entries, then compiles.',
    '',
    'In the GEN block, DIST must be defined above and the template.json',
    'must provide NS hands (used to track hand state during generation).',
  ].join('\n'));
  process.exit(1);
}

let src, template;
try { src = fs.readFileSync(args[0], 'utf8'); } catch(e) { console.error(`Cannot read "${args[0]}": ${e.message}`); process.exit(1); }
if (args[1]) {
  try { template = JSON.parse(fs.readFileSync(args[1], 'utf8')); } catch(e) { console.error(`Cannot read template: ${e.message}`); process.exit(1); }
}

const nsHands = template ? { N: template.hands.N, S: template.hands.S } : { N: [], S: [] };

// Expand GEN blocks → expanded SPDSL source
let expanded;
try { expanded = processGEN(src, nsHands); } catch(e) { console.error(`GEN expand error: ${e.message}`); process.exit(1); }

// Now compile the expanded SPDSL using spdsl-compile.js logic
const compileScript = path.join(__dirname, 'spdsl-compile.js');
const tmpFile = args[0].replace(/\.spdsl$/, '_expanded.spdsl');
fs.writeFileSync(tmpFile, expanded);

// Run compile
const { execSync } = require('child_process');
try {
  const cmd = args[1]
    ? `node "${compileScript}" "${tmpFile}" "${args[1]}"`
    : `node "${compileScript}" "${tmpFile}"`;
  const out = execSync(cmd, { encoding: 'utf8' });
  console.log(out);
} catch(e) {
  console.error('Compile error:', e.stderr || e.message);
} finally {
  try { fs.unlinkSync(tmpFile); } catch(_) {}
}
