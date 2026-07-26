export interface SummaryCacheVersion {
  createdAt: string | null;
  generationStartedAt: number | null;
}

export interface SummaryCacheWrite {
  createdAt: string;
  generationStartedAt: number;
}

export interface SummaryCacheFenceStore {
  read(): Promise<SummaryCacheVersion | null>;
  insert(write: SummaryCacheWrite): Promise<"saved" | "conflict" | "error">;
  updateIfVersion(
    expectedCreatedAt: string | null,
    write: SummaryCacheWrite,
  ): Promise<"saved" | "conflict" | "error">;
}

export type SummaryCacheWriteResult = "saved" | "superseded" | "error";

function nextVersion(observedCreatedAt: string | null): string {
  const observedMs = observedCreatedAt ? Date.parse(observedCreatedAt) : 0;
  return new Date(Math.max(Date.now(), Number.isFinite(observedMs) ? observedMs + 1 : 0)).toISOString();
}

/**
 * Optimistic CAS fence for summary writes.
 *
 * A later generation may replace an earlier one, but an earlier generation can
 * never overwrite a cache row already written by a later generation.
 */
export async function writeSummaryCacheWithFence(
  store: SummaryCacheFenceStore,
  generationStartedAt: number,
  maxAttempts = 5,
): Promise<SummaryCacheWriteResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const observed = await store.read();
    if (
      observed?.generationStartedAt != null &&
      observed.generationStartedAt > generationStartedAt
    ) {
      return "superseded";
    }

    const write = {
      createdAt: nextVersion(observed?.createdAt ?? null),
      generationStartedAt,
    };
    const result = observed
      ? await store.updateIfVersion(observed.createdAt, write)
      : await store.insert(write);

    if (result === "saved") return "saved";
    if (result === "error") return "error";
  }
  return "error";
}
