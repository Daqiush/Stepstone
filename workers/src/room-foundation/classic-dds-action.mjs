import { createWasmDdsClient } from '../dds-wasm-adapter.mjs';
import { loadDdsModule } from '../dds-wasm-loader.mjs';
import ddsWasm from '../../vendor/bridge-dds/dds-worker.wasm';
import {
  classicHandsToInteger,
  validateClassicDdsTable,
} from './classic-dds-contract.mjs';

export {
  CLASSIC_DDS_ACTION_ID,
  CLASSIC_DDS_ACTION_KIND,
  CLASSIC_DDS_BACKSTOP_MS,
  buildClassicDdsAction,
  classicHandsToInteger,
  parseClassicDdsActionPayload,
  retryClassicDdsAction,
  validateClassicDdsTable,
} from './classic-dds-contract.mjs';

const embeddedDdsClient = createWasmDdsClient({
  loadModule: async () => {
    const module = await loadDdsModule(ddsWasm);
    return {
      calcDDTablePbn: value => module.calcDDTablePbn(value),
      solveBoardPbn: value => module.solveBoardPbn(value),
    };
  },
});

export async function calculateClassicDdTable(hands) {
  const table = await embeddedDdsClient.calcDDTable(classicHandsToInteger(hands));
  return validateClassicDdsTable(table);
}
