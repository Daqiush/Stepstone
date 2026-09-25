import { createWasmDdsClient, DdsInputError } from './dds-wasm-adapter.mjs';
import { loadDdsModule } from './dds-wasm-loader.mjs';
import ddsWasm from '../vendor/bridge-dds/dds-worker.wasm';
import { runOrderedQueueProbe } from './ordered-queue-probe.mjs';

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
    if (new URL(request.url).pathname === '/__dds/ordered-probe') return this.orderedProbe(request);
    return this.enqueue(() => this.handle(request));
  }

  enqueue(command) {
    const operation = this.queued.then(command);
    this.queued = operation.then(() => {}, () => {});
    return operation;
  }

  async orderedProbe(request) {
    let body;
    try { body = await request.json(); }
    catch { return failure('INVALID_DEAL', 400); }
    // This outer request is never put on the queue: doing so and awaiting the
    // two inner commands would deadlock. Both inner commands use the ordinary
    // queue, with no await between their enqueues.
    const solve = new Request(new URL('/__dds/solve', request.url), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const ping = new Request(new URL('/__dds/ping', request.url), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const pair = await runOrderedQueueProbe({
      enqueueSolve: () => this.enqueue(async () => (await this.handle(solve)).json()),
      enqueuePing: () => this.enqueue(async () => (await this.handle(ping)).json()),
      now: () => performance.now(),
    });
    return Response.json({ ok: true, ...pair });
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
