import type { KboRawGame } from "@/types/api";
import { runBeforeDeadline } from "@/lib/async-deadline";
import { parseKboGameListPayload } from "@/lib/notifications/widget-fast-loop";

const KBO_MAIN = "https://www.koreabaseball.com/ws/Main.asmx";

/**
 * KBO 라이브 스코어보드 원천.
 * ok:false는 HTTP/network/schema 실패이며 정상 "경기 0"과 구분한다.
 */
export async function fetchKboLiveGames(
  date: string,
  deadlineAtMs?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  ok: boolean;
  games: KboRawGame[];
  trace: { sourceAtMs: number; fetchedAtMs: number };
}> {
  const sourceAtMs = Date.now();
  try {
    const remainingMs = deadlineAtMs == null ? null : deadlineAtMs - Date.now();
    const response = await runBeforeDeadline(
      () => fetchImpl(`${KBO_MAIN}/GetKboGameList`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
          "Referer": "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
        },
        body: `leId=1&srId=0,1,3,4,5,7,8,9&date=${date}`,
        cache: "no-store",
        ...(remainingMs != null
          ? { signal: AbortSignal.timeout(Math.max(1, remainingMs)) }
          : {}),
      }),
      deadlineAtMs,
    );
    if (!response.ok) {
      return { ok: false, games: [], trace: { sourceAtMs, fetchedAtMs: Date.now() } };
    }
    const json = await runBeforeDeadline(() => response.json(), deadlineAtMs).catch(() => null);
    const games = parseKboGameListPayload(json);
    const fetchedAtMs = Date.now();
    if (games === null) return { ok: false, games: [], trace: { sourceAtMs, fetchedAtMs } };
    return { ok: true, games, trace: { sourceAtMs, fetchedAtMs } };
  } catch {
    return { ok: false, games: [], trace: { sourceAtMs, fetchedAtMs: Date.now() } };
  }
}
