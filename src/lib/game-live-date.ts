import { toKSTDateString } from "@/lib/utils/date-kst";

export function resolveGameLiveDate(gameId?: string, now = new Date()): string {
  const gameDate = gameId?.match(/^(\d{8})/)?.[1];
  return gameDate ?? toKSTDateString(now.toISOString()).replaceAll("-", "");
}
