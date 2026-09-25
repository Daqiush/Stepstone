import { createWasmDdsClient, DdsInputError } from './dds-wasm-adapter.mjs';
import { loadDdsModule } from './dds-wasm-loader.mjs';
import ddsWasm from '../vendor/bridge-dds/dds-worker.wasm';

function failure(code, status) {
  return Response.json({ ok: false, error: { code } }, { status });
}

export class FeasibilityRoom {
  constructor(state, env) {
    this.env = env;
    this.completedOperations = 0;
    this.queued = Promise.resolve();
    this.injectFailure = env.DDS_LOCAL_TEST === 'true' && env.DDS_TEST_FAIL_FIRST_SOLVE === 'true';
    this.injectInitFailure = env.DDS_LOCAL_TEST === 'true' && env.DDS_TEST_FAIL_FIRST_INIT === 'true';
    this.delayMs = env.DDS_LOCAL_TEST === 'true' ? Number(env.DDS_TEST_SOLVE_DELAY_MS || 0) : 0;
    state.blockConcurrencyWhile(async () => {
      await this.initialize();
      this.initFailurePending = !this.client;
    });
  }

  async initialize() {
    const started = performance.now();
    try {
      if (this.injectInitFailure) {
        this.injectInitFailure = false;
        throw new Error('isolated initialization failure');
      }
      const module = await loadDdsModule(ddsWasm);
      this.heapBytes = module.heapBytes;
      this.client = createWasmDdsClient({ loadModule: async () => ({
        calcDDTablePbn: (hands) => module.calcDDTablePbn(hands),
        solveBoardPbn: (deal) => {
          if (this.injectFailure) {
            this.injectFailure = false;
            throw new Error('isolated test failure');
          }
          return module.solveBoardPbn(deal);
        },
      }) });
    } catch {
      this.client = null;
      this.heapBytes = null;
    }
    this.initMs = performance.now() - started;
  }

  fetch(request) {
    const operation = this.queued.then(() => this.handle(request));
    this.queued = operation.then(() => {}, () => {});
    return operation;
  }

  async handle(request) {
    const path = new URL(request.url).pathname;
    if (path === '/__dds/ping') {
      await request.text();
      return Response.json({ ok: true, completedOperations: this.completedOperations });
    }
    if (path === '/__dds/metrics') {
      await request.text();
      return Response.json({ ok: true, completedOperations: this.completedOperations,
        initMs: this.initMs, heapBytes: this.heapBytes?.() ?? null });
    }
    let body;
    try { body = await request.json(); }
    catch { return failure('INVALID_DEAL', 400); }
    if (!this.client && this.initFailurePending) {
      this.initFailurePending = false;
      return failure('DDS_FAILURE', 500);
    }
    if (!this.client) await this.initialize();
    if (!this.client) return failure('DDS_FAILURE', 500);
    try {
      if (path === '/__dds/solve' && this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      const started = performance.now();
      const result = path === '/__dds/table'
        ? await this.client.calcDDTable(body?.hands)
        : await this.client.solveBoard(body?.deal);
      const solveMs = performance.now() - started;
      const metrics = { initMs: this.initMs, solveMs, heapBytes: this.heapBytes() };
      this.completedOperations += 1;
      return Response.json({ ok: true, result, metrics });
    } catch (error) {
      if (error instanceof DdsInputError || error?.code === 'INVALID_DEAL') {
        return failure('INVALID_DEAL', 400);
      }
      return failure('DDS_FAILURE', 500);
    }
  }
}
