/** Reviewer-only fixed-budget sampling. Timeouts are missing observations, not safe answers. */
export class LiveSampleBudget {
  readonly counts = new Map<string, { attempted: number; observed: number; timeouts: number }>();

  constructor(readonly rounds: number, readonly minimumObserved: number) {
    if (!Number.isInteger(rounds) || !Number.isInteger(minimumObserved)
      || minimumObserved < 1 || minimumObserved > rounds) throw new Error("invalid sample budget");
  }

  async sample<T>(key: string, call: () => Promise<T>): Promise<
    { status: "observed"; value: T } | { status: "timeout" }
  > {
    const count = this.counts.get(key) ?? { attempted: 0, observed: 0, timeouts: 0 };
    if (count.attempted >= this.rounds) throw new Error("sample budget exhausted");
    this.counts.set(key, count);
    count.attempted++;
    try {
      const value = await call();
      count.observed++;
      return { status: "observed", value };
    } catch (error) {
      // AbortSignal.timeout emits TimeoutError. Do not mask assertion, auth,
      // malformed-response, manual abort, or unrelated transport failures.
      if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
      count.timeouts++;
      return { status: "timeout" };
    }
  }

  summary() {
    const rows = [...this.counts].map(([key, count]) => ({ key, ...count }));
    return {
      rows,
      attempted: rows.reduce((n, row) => n + row.attempted, 0),
      observed: rows.reduce((n, row) => n + row.observed, 0),
      timeouts: rows.reduce((n, row) => n + row.timeouts, 0),
      incomplete: rows.filter(row => row.attempted !== this.rounds || row.observed < this.minimumObserved),
    };
  }
}
