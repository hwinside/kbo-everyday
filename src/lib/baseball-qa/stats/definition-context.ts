import { KBO_OFFICIAL_METRIC_TERMS } from "./kbo-official-metric-columns";

export type DefinitionPeriodScope = "season" | "career" | "mixed" | "unspecified";

/** Application-resolved topic only. Never store model prose, counts or repair data. */
export interface StatDefinitionContext {
  version: 1;
  terms: string[];
  period: DefinitionPeriodScope;
}

const PERIODS: readonly unknown[] = ["season", "career", "mixed", "unspecified"];
const TERMS = new Set<string>(KBO_OFFICIAL_METRIC_TERMS);

/** Old/malformed envelope metadata cannot introduce arbitrary prompt content. */
export function readStatDefinitionContext(value: unknown): StatDefinitionContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || !Array.isArray(row.terms) || row.terms.length === 0 || row.terms.length > TERMS.size ||
      !row.terms.every((term) => typeof term === "string" && TERMS.has(term)) ||
      new Set(row.terms).size !== row.terms.length || !PERIODS.includes(row.period)) return undefined;
  return { version: 1, terms: [...row.terms] as string[], period: row.period as DefinitionPeriodScope };
}
