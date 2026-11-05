/** Single-game series identity. Never infer postseason rounds from calendar dates. */
export const SERIES_IDS = ["0", "1", "3", "4", "5", "7", "9"] as const;
export type GameSeriesId = typeof SERIES_IDS[number];
export function normalizeSeriesId(value: unknown): GameSeriesId | undefined {
  const id = String(value ?? "");
  return (SERIES_IDS as readonly string[]).includes(id) ? id as GameSeriesId : undefined;
}
export function seriesIdFromNaverId(id: string): GameSeriesId | undefined {
  const prefix = id.slice(0, 4);
  return ({ "3333": "3", "4444": "4", "5555": "5", "7777": "7", "9999": "9" } as Record<string, GameSeriesId>)[prefix];
}
export function isPostseason(srId: unknown): boolean {
  return ["3", "4", "5", "7"].includes(String(srId));
}
export function seriesLabel(srId: unknown): string {
  return ({ "3": "준PO", "4": "WC", "5": "PO", "7": "KS" } as Record<string, string>)[String(srId)] ?? "";
}

/** Prefer canonical stage identity; display a game number only when the source supplies one. */
export function postseasonGameLabel(srId: unknown, gameLabel?: string, status?: string): string {
  const stage = seriesLabel(srId);
  if (!stage) return "";
  const n = Number(gameLabel?.match(/(\d+)\s*$/)?.[1]);
  const max = String(srId) === "4" ? 2 : String(srId) === "7" ? 7 : 5;
  if (!Number.isInteger(n) || n <= 0 || n > max) return stage;
  const minimum = String(srId) === "4" ? 1 : String(srId) === "7" ? 4 : 3;
  return `${stage} ${n}차전${status === "scheduled" && n > minimum ? " · 필요시" : ""}`;
}

/** Team calendar totals are regular-season only; individual PS results stay visible. */
export function summarizeRegularSeasonResults(days: { srId?: string; result: "W" | "L" | "D" | null }[]) {
  let wins = 0, losses = 0, draws = 0;
  for (const day of days) {
    if (day.srId !== "0") continue;
    if (day.result === "W") wins++;
    else if (day.result === "L") losses++;
    else if (day.result === "D") draws++;
  }
  const total = wins + losses + draws;
  return { wins, losses, draws, winRate: total > 0 ? wins / total : 0 };
}
