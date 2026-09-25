// The same caller supplies both requests to the fixed Durable Object. The
// counter must advance by exactly one, proving the ping ran after this solve.
export async function probeTimedSolve({ sendSolve, sendPing, expectedCompletedOperations, now,
  validateSolveResponse = () => {} }) {
  if (!Number.isSafeInteger(expectedCompletedOperations) || expectedCompletedOperations < 0) {
    throw new Error('Inconclusive queue ordering: invalid previous operation count');
  }
  const solvePromise = Promise.resolve(sendSolve()).then((response) => ({ response, completedAt: now() }));
  const pingStarted = now();
  const pingPromise = Promise.resolve(sendPing()).then((response) => ({ response, completedAt: now() }));
  pingPromise.catch(() => {}); // Observe rejection if solve fails before ping is awaited.
  const { response: solveResponse, completedAt: solveCompletedAt } = await solvePromise;
  validateSolveResponse(solveResponse);
  const { response: ping, completedAt } = await pingPromise;
  if (ping?.ok !== true || !Number.isSafeInteger(ping.completedOperations)
      || ping.completedOperations !== expectedCompletedOperations + 1) {
    throw new Error(`Inconclusive queue ordering: expected completedOperations=${expectedCompletedOperations + 1}, got ${ping?.completedOperations ?? 'missing'}`);
  }
  return { solveResponse, solveCompletedAt, queueDelayMs: completedAt - pingStarted,
    completedOperations: ping.completedOperations };
}
