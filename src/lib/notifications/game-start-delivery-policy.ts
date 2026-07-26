export function gameStartDeliveryWindow(
  snapshotDeadlineAtMs: number,
  nowMs: number,
  routeDeadlineAtMs = snapshotDeadlineAtMs,
): {
  deadlineAtMs: number;
  ttlSeconds: number;
  apnsExpirationSeconds: number;
} | null {
  const transportDeadlineAtMs = Math.min(snapshotDeadlineAtMs, routeDeadlineAtMs);
  if (nowMs >= transportDeadlineAtMs) return null;
  const remainingSeconds = Math.max(1, Math.ceil((snapshotDeadlineAtMs - nowMs) / 1000));
  return {
    deadlineAtMs: transportDeadlineAtMs,
    ttlSeconds: Math.min(90, remainingSeconds),
    apnsExpirationSeconds: Math.min(90, remainingSeconds),
  };
}

export async function drainGameStartDeliveryBatches<Row>(args: {
  deadlineAtMs: number;
  claim: () => Promise<Row[]>;
  process: (rows: Row[]) => Promise<number>;
  now?: () => number;
}): Promise<number> {
  const now = args.now ?? Date.now;
  let acceptedDelta = 0;
  while (now() < args.deadlineAtMs) {
    const claimed = await args.claim();
    if (claimed.length === 0) break;
    acceptedDelta += await args.process(claimed);
  }
  return acceptedDelta;
}
