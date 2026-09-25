import createDds from '../vendor/bridge-dds/dds-worker.mjs';

const SEATS = ['N', 'E', 'S', 'W'];
const STRAINS = ['S', 'H', 'D', 'C', 'NT'];
const RANKS = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
const DEAL_PBN = {
  trump: 0,
  first: 4,
  currentTrickSuit: 8,
  currentTrickRank: 20,
  remainCards: 32,
  remainCardsBytes: 80,
  size: 32 + 80,
};
let modulePromise;

function checked(code) {
  if (code !== 1) throw new Error(`DDS API error ${code}`);
}

// The adapter supplies a seat label on each hand. DDS PBN uses one seat label
// followed by four clockwise hands, so keep the adapter format at this boundary.
function ddsHands(value) {
  const parts = value.split(' ');
  if (parts.length !== 4 || parts.some((part, index) => !part.startsWith(`${SEATS[index]}:`))) {
    throw new TypeError('Invalid adapter PBN hands');
  }
  return `N:${parts.map((part) => part.slice(2)).join(' ')}`;
}

function withBuffers(module, sizes, run) {
  const pointers = sizes.map((size) => module._malloc(size));
  try {
    if (pointers.some((pointer) => !pointer)) throw new Error('DDS allocation failed');
    return run(...pointers);
  } finally {
    for (const pointer of pointers) if (pointer) module._free(pointer);
  }
}

export function decodeFutureTricks(module, future) {
  const count = module.getValue(future + 4, 'i32');
  if (count < 1 || count > 13) throw new Error('Invalid DDS futureTricks count');
  const score = module.getValue(future + 164, 'i32');
  const cards = [];
  for (let index = 0; index < count; index += 1) {
    const suit = STRAINS[module.getValue(future + 8 + index * 4, 'i32')];
    const rank = module.getValue(future + 60 + index * 4, 'i32');
    const equals = module.getValue(future + 112 + index * 4, 'i32');
    const candidateScore = module.getValue(future + 164 + index * 4, 'i32');
    if (candidateScore !== score || !suit || suit === 'NT' || rank < 2 || rank > 14) throw new Error('Invalid DDS candidate');
    cards.push({ suit, rank });
    for (let lower = 2; lower < rank; lower += 1) {
      if (equals & (1 << lower)) cards.push({ suit, rank: lower });
    }
  }
  return { score, cards };
}

function bind(module) {
  module._SetMaxThreads(0);
  // Emscripten refreshes the exported view after memory growth. Read it for
  // each sample instead of retaining an earlier, possibly detached buffer.
  const heapBytes = () => module.HEAPU8.buffer.byteLength;
  if (!Number.isSafeInteger(heapBytes()) || heapBytes() <= 0) throw new Error('DDS Wasm memory unavailable');
  return {
    heapBytes,
    calcDDTablePbn(value) {
      return withBuffers(module, [80, 80], (deal, result) => {
        module.stringToUTF8(ddsHands(value), deal, 80);
        checked(module._CalcDDtablePBN(deal, result));
        return Object.fromEntries(SEATS.map((seat, hand) => [seat,
          Object.fromEntries(STRAINS.map((strain, index) => [strain,
            module.getValue(result + 4 * (index * 4 + hand), 'i32')]))]));
      });
    },
    solveBoardPbn(value) {
      const fields = Object.fromEntries(value.split(';').map((part) => {
        const at = part.indexOf('=');
        return [part.slice(0, at), part.slice(at + 1)];
      }));
      const trick = fields.trick ? fields.trick.split(',') : [];
      const first = SEATS.indexOf(fields.leader);
      if (!STRAINS.includes(fields.trump) || first < 0 || trick.length > 3 ||
          SEATS[(first + trick.length) % 4] !== fields.turn) throw new TypeError('Invalid adapter PBN deal');
      return withBuffers(module, [DEAL_PBN.size, 216], (deal, future) => {
        module.setValue(deal + DEAL_PBN.trump, STRAINS.indexOf(fields.trump), 'i32');
        module.setValue(deal + DEAL_PBN.first, first, 'i32');
        for (let index = 0; index < 3; index += 1) {
          const card = trick[index];
          module.setValue(deal + DEAL_PBN.currentTrickSuit + index * 4, card ? STRAINS.indexOf(card[0]) : 0, 'i32');
          module.setValue(deal + DEAL_PBN.currentTrickRank + index * 4, card ? (RANKS[card[1]] ?? Number(card[1])) : 0, 'i32');
        }
        module.stringToUTF8(ddsHands(fields.hands), deal + DEAL_PBN.remainCards, DEAL_PBN.remainCardsBytes);
        // -1 asks for the maximum score; 2 returns every optimum play; mode 1
        // still computes a score when the player has just one legal card.
        checked(module._SolveBoardPBN(deal, -1, 2, 1, future, 0));
        return decodeFutureTricks(module, future);
      });
    },
  };
}

export async function loadDdsModule(precompiledWasm) {
  if (!modulePromise) {
    modulePromise = Promise.resolve().then(() => createDds(precompiledWasm ? { wasm: precompiledWasm } : undefined)).then(bind).catch(() => {
      modulePromise = undefined;
      const error = new Error('DDS module initialization failed');
      error.code = 'DDS_FAILURE';
      throw error;
    });
  }
  return modulePromise;
}
