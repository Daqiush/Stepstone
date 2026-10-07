// The caller must enqueue both distinct DO operations synchronously. The
// second operation then waits on the same queue as every ordinary command.
export async function runOrderedQueueProbe({ enqueueSolve, enqueuePing, now }) {
  const startedAt = now();
  const solving = Promise.resolve(enqueueSolve()).then((solveResponse) => ({
    solveResponse, solveCompletedMs: now() - startedAt,
  }));
  const pinging = Promise.resolve(enqueuePing()).then((pingResponse) => ({
    pingResponse, queueDelayMs: now() - startedAt,
  }));
  const [solve, ping] = await Promise.all([solving, pinging]);
  return { ...solve, ...ping };
}
