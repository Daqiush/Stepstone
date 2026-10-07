// The local Worker enqueues the solve and a separate ping synchronously on
// one Durable Object. The counter and timestamps validate the returned pair.
export async function probeTimedSolve({ sendOrderedPair, expectedCompletedOperations,
  validateSolveResponse = () => {} }) {
  if (!Number.isSafeInteger(expectedCompletedOperations) || expectedCompletedOperations < 0) {
    throw new Error('Inconclusive queue ordering: invalid previous operation count');
  }
  const pair = await sendOrderedPair();
  if (pair?.ok !== true || !pair.solveResponse || !pair.pingResponse
      || !Number.isFinite(pair.solveCompletedMs) || pair.solveCompletedMs < 0
      || !Number.isFinite(pair.queueDelayMs) || pair.queueDelayMs < pair.solveCompletedMs) {
    throw new Error('Malformed ordered queue probe: missing or out-of-order response/timing');
  }
  validateSolveResponse(pair.solveResponse);
  const ping = pair.pingResponse;
  if (ping?.ok !== true || !Number.isSafeInteger(ping.completedOperations)
      || ping.completedOperations !== expectedCompletedOperations + 1) {
    throw new Error(`Inconclusive queue ordering: expected completedOperations=${expectedCompletedOperations + 1}, got ${ping?.completedOperations ?? 'missing'}`);
  }
  return { solveResponse: pair.solveResponse, solveCompletedMs: pair.solveCompletedMs,
    queueDelayMs: pair.queueDelayMs,
    completedOperations: ping.completedOperations };
}
