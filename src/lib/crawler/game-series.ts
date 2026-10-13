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
