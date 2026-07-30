import type { KboRawGame } from "@/types/api";
import { runBeforeDeadline } from "@/lib/async-deadline";
import { parseKboGameListPayload } from "@/lib/notifications/widget-fast-loop";
import { fetchNaverGames } from "@/lib/crawler/naver-games";
import type { KboGame } from "@/lib/crawler/kbo-api";

const KBO_MAIN = "https://www.koreabaseball.com/ws/Main.asmx";
const KBO_PRIMARY_BUDGET_MS = 1_500;

type LiveGamesSource = "kbo" | "naver";

function naverGameToRaw(game: KboGame): KboRawGame {
  const state = game.status === "live"
    ? "2"
    : game.status === "final"
      ? "3"
      : game.status === "cancelled"
        ? "4"
        : "1";
  return {
    G_ID: game.gameId,
    G_DT: game.date,
    G_TM: game.time,
    S_NM: game.stadium,
    AWAY_ID: game.gameId.slice(8, 10),
    HOME_ID: game.gameId.slice(10, 12),
    AWAY_NM: game.awayName,
    HOME_NM: game.homeName,
    T_SCORE_CN: game.awayScore == null ? "" : String(game.awayScore),
    B_SCORE_CN: game.homeScore == null ? "" : String(game.homeScore),
    GAME_INN_NO: game.inning,
    GAME_TB_SC: game.isTop ? "T" : "B",
    GAME_STATE_SC: state,
    CANCEL_SC_ID: game.status === "cancelled" ? "1" : "0",
    T_PIT_P_NM: game.awayStarterName,
    B_PIT_P_NM: game.homeStarterName,
    W_PIT_P_NM: game.winPitcher,
    L_PIT_P_NM: game.losePitcher,
    SV_PIT_P_NM: game.savePitcher,
    STRIKE_CN: game.strikes,
    BALL_CN: game.balls,
    OUT_CN: game.outs,
    B1_BAT_ORDER_NO: game.runnersOn.first ? 1 : 0,
    B2_BAT_ORDER_NO: game.runnersOn.second ? 1 : 0,
    B3_BAT_ORDER_NO: game.runnersOn.third ? 1 : 0,
    B_P_NM: game.isTop ? game.currentPitcher : game.currentBatter,
    T_P_NM: game.isTop ? game.currentBatter : game.currentPitcher,
    T_RANK_NO: game.awayRank,
    B_RANK_NO: game.homeRank,
  };
}

/**
 * 서버 알림/Live Activity용 라이브 스코어보드.
 * KBO를 짧게 시도한 뒤 HTTP/network/schema 실패면 남은 deadline 안에서 Naver로
 * failover한다. 두 소스 모두 실패한 ok:false는 정상 "경기 0"과 구분한다.
 */
export async function fetchKboLiveGames(
  date: string,
  deadlineAtMs?: number,
  fetchImpl: typeof fetch = fetch,
  fetchNaverImpl: typeof fetchNaverGames = fetchNaverGames,
): Promise<{
  ok: boolean;
  games: KboRawGame[];
  trace: { source: LiveGamesSource; sourceAtMs: number; fetchedAtMs: number };
}> {
  const sourceAtMs = Date.now();
  try {
    const kboDeadlineAtMs = Math.min(
      deadlineAtMs ?? Date.now() + KBO_PRIMARY_BUDGET_MS,
      Date.now() + KBO_PRIMARY_BUDGET_MS,
    );
    const remainingMs = kboDeadlineAtMs - Date.now();
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
        signal: AbortSignal.timeout(Math.max(1, remainingMs)),
      }),
      kboDeadlineAtMs,
    );
    if (response.ok) {
      const json = await runBeforeDeadline(() => response.json(), kboDeadlineAtMs).catch(() => null);
      const games = parseKboGameListPayload(json);
      const fetchedAtMs = Date.now();
      if (games !== null) {
        return { ok: true, games, trace: { source: "kbo", sourceAtMs, fetchedAtMs } };
      }
    }
  } catch {
    // Naver failover below.
  }

  try {
    const remainingMs = (deadlineAtMs ?? Date.now() + 5_000) - Date.now();
    if (remainingMs <= 0) throw new Error("live_games_deadline_exceeded");
    const games = await fetchNaverImpl(date, undefined, {
      signal: AbortSignal.timeout(remainingMs),
    });
    return {
      ok: true,
      games: games.map(naverGameToRaw),
      trace: { source: "naver", sourceAtMs, fetchedAtMs: Date.now() },
    };
  } catch {
    return {
      ok: false,
      games: [],
      trace: { source: "kbo", sourceAtMs, fetchedAtMs: Date.now() },
    };
  }
}
