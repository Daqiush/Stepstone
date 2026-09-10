'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { resolveDdsPaths } = require('../dds-paths');
const { runDdsProcess } = require('../dds-process');
const { createDdsClient } = require('../dds-wrapper');

const FULL_DEAL = {
  N: Array.from({ length: 13 }, (_, i) => ({ suit: 'S', rank: i + 2 })),
  E: Array.from({ length: 13 }, (_, i) => ({ suit: 'H', rank: i + 2 })),
  S: Array.from({ length: 13 }, (_, i) => ({ suit: 'D', rank: i + 2 })),
  W: Array.from({ length: 13 }, (_, i) => ({ suit: 'C', rank: i + 2 })),
};

function createRealClient(paths) {
  return createDdsClient({ paths, runProcess: runDdsProcess, existsSync: fs.existsSync });
}

async function smokeCalc(calcPath) {
  const table = await createRealClient({ calc: calcPath, solve: '' }).calcDDTable(FULL_DEAL);
  const valid = Array.isArray(table)
    && table.length === 5
    && table.every((row) => (
      Array.isArray(row)
      && row.length === 4
      && row.every((value) => Number.isInteger(value) && value >= 0 && value <= 13)
    ));
  if (!valid) throw new Error(`Invalid dds_calc smoke result from ${calcPath}`);
  return table;
}

async function smokeSolve(solvePath) {
  const result = await createRealClient({ calc: '', solve: solvePath }).solveBoard({
    trump: 'NT',
    trickLeader: 'N',
    trickPlayed: [],
    hands: FULL_DEAL,
  });
  const northCards = new Set(FULL_DEAL.N.map((card) => `${card.suit}:${card.rank}`));
  const valid = result
    && Number.isInteger(result.score)
    && result.score >= 0
    && result.score <= 13
    && Array.isArray(result.cards)
    && result.cards.length >= 1
    && result.cards.some((card) => northCards.has(`${card.suit}:${card.rank}`));
  if (!valid) throw new Error(`Invalid dds_solve smoke result from ${solvePath}`);
  return result;
}

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const paths = resolveDdsPaths({ rootDir });
  await Promise.all([
    smokeCalc(paths.calc).catch((error) => {
      throw new Error(`${paths.calc}: ${error.message}`, { cause: error });
    }),
    smokeSolve(paths.solve).catch((error) => {
      throw new Error(`${paths.solve}: ${error.message}`, { cause: error });
    }),
  ]);
  console.log(`DDS smoke checks passed: ${paths.calc}, ${paths.solve}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[DDS smoke] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { FULL_DEAL, smokeCalc, smokeSolve };
