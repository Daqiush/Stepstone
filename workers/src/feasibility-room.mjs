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
    this.remoteDecisions = Promise.resolve();
    this.activationId = crypto.randomUUID();
    this.accounting = {
      workerInbound: 0,
      doFetchArrivals: 0,
      queuedDoCommands: 0,
      sqliteRows: { reads: 0, writes: 0 },
    };
    this.sql = state.storage.sql;
    this.injectFailure = env.DDS_LOCAL_TEST === 'true' && env.DDS_TEST_FAIL_FIRST_SOLVE === 'true';
    this.injectInitFailure = env.DDS_LOCAL_TEST === 'true' && env.DDS_TEST_FAIL_FIRST_INIT === 'true';
    this.delayMs = env.DDS_LOCAL_TEST === 'true' ? Number(env.DDS_TEST_SOLVE_DELAY_MS || 0) : 0;
    state.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS test_operations (
        run_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, operation_id)
      )`);
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
    if (this.remoteIdentity(request)) return this.remoteFetch(request);
    if (new URL(request.url).pathname === '/__dds/ordered-probe') return this.orderedProbe(request);
    return this.enqueue(() => this.handle(request));
  }

  remoteIdentity(request) {
    const runId = request.headers.get('x-dds-run-id');
    const operationId = request.headers.get('x-dds-operation-id');
    const requestHash = request.headers.get('x-dds-request-hash');
    return runId && operationId && requestHash ? { runId, operationId, requestHash } : null;
  }

  serializeRemoteDecision(command) {
    const operation = this.remoteDecisions.then(command);
    this.remoteDecisions = operation.then(() => {}, () => {});
    return operation;
  }

  accountingSnapshot() {
    return { ...this.accounting };
  }

  remoteEnvelope(operationResult, replayed) {
    return Response.json({
      operationResult,
      replayed,
      buildId: this.env.DDS_DEPLOYMENT_BUILD_ID || null,
      accounting: this.accountingSnapshot(),
    });
  }

  async remoteFetch(request) {
    const identity = this.remoteIdentity(request);
    this.accounting.workerInbound += 1;
    this.accounting.doFetchArrivals += 1;
    return this.serializeRemoteDecision(() => this.resolveRemoteOperation(request, identity));
  }

  async resolveRemoteOperation(request, identity) {
    const rows = this.sql.exec(
      'SELECT request_hash, response_json FROM test_operations WHERE run_id = ? AND operation_id = ?',
      identity.runId, identity.operationId,
    ).toArray();
    this.accounting.sqliteRows.reads += 1;
    const stored = rows[0];
    if (stored) {
      if (stored.request_hash !== identity.requestHash) return failure('OPERATION_CONFLICT', 409);
      return this.remoteEnvelope(JSON.parse(stored.response_json), true);
    }

    const path = new URL(request.url).pathname;
    const response = path === '/__dds/ordered-probe'
      ? await this.orderedProbe(request, true)
      : await this.enqueue(() => this.handle(request, true));
    if (!response.ok) return response;
    const operationResult = { ...(await response.json()), activationId: this.activationId };
    this.sql.exec(
      'INSERT INTO test_operations (run_id, operation_id, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
      identity.runId, identity.operationId, identity.requestHash, JSON.stringify(operationResult), Date.now(),
    );
    this.accounting.sqliteRows.writes += 1;
    return this.remoteEnvelope(operationResult, false);
  }

  enqueue(command) {
    const operation = this.queued.then(command);
    this.queued = operation.then(() => {}, () => {});
    return operation;
  }

  async orderedProbe(request, remote = false) {
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
    if (remote) this.accounting.queuedDoCommands += 2;
    let solveStatus;
    let pingStatus;
    const pair = await runOrderedQueueProbe({
      enqueueSolve: () => this.enqueue(async () => {
        const response = await this.handle(solve);
        solveStatus = response.status;
        return response.json();
      }),
      enqueuePing: () => this.enqueue(async () => {
        const response = await this.handle(ping);
        pingStatus = response.status;
        return response.json();
      }),
      now: () => performance.now(),
    });
    if (!pair.solveResponse?.ok) return failure(pair.solveResponse?.error?.code || 'DDS_FAILURE', solveStatus || 500);
    if (!pair.pingResponse?.ok) return failure(pair.pingResponse?.error?.code || 'DDS_FAILURE', pingStatus || 500);
    return Response.json({ ok: true, ...pair });
  }

  async handle(request, remote = false) {
    const path = new URL(request.url).pathname;
    if (path === '/__dds/ping') {
      await request.text();
      return Response.json({ ok: true, completedOperations: this.completedOperations });
    }
    if (path === '/__dds/metrics') {
      await request.text();
      return Response.json({ ok: true, completedOperations: this.completedOperations,
        initMs: this.initMs, heapBytes: this.heapBytes?.() ?? null,
        buildId: this.env.DDS_DEPLOYMENT_BUILD_ID || null,
        workerVersionId: this.env.DDS_DEPLOYMENT_VERSION_ID || null });
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
      if (remote && (path === '/__dds/table' || path === '/__dds/solve')) this.accounting.queuedDoCommands += 1;
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
