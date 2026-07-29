// 홈 SSR 라이브 데이터 공급 — KBO GameList 직호출로 BSO/주자 상세를 얻되, 반드시 bounded 하고
// 실패/timeout(blackhole)/스키마 열화 시 경기목록(Naver 폴백 포함)에서 합성한다.
//
// 배경(2026-07-29 삼순 리뷰): 기존 홈 page.tsx 의 2차 KBO 직호출은 AbortSignal 이 없어
// KBO blackhole(응답 없이 hang) 시 홈 SSR 이 영원히 끝나지 않았다. fetchGames 는 Naver
// 폴백으로 살아나도 이 2차 호출이 hang 하면 홈 전체가 죽는다. → 여기서 bounded + graceful 합성.

import { isKboGameCancelled, type KboGame } from "@/lib/crawler/kbo-api";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import { resolveCurrentPlayers } from "@/lib/kbo-player-mapping";
import type { KboRawGame } from "@/types/api";

const HOME_LIVE_KBO_URL = "https://www.koreabaseball.com/ws/Main.asmx/GetKboGameList";
// 홈 2차 라이브 호출 예산. KBO 완전 장애여도 홈 SSR 이 이 안에서 합성으로 수렴한다.
const HOME_LIVE_BUDGET_MS = 3500;

/**
 * KboGame(경기목록 — fetchGames, 즉 Naver 폴백 포함) → LiveGameData 합성.
 * KBO 라이브 직호출이 죽어도 경기목록의 스코어/상태/이닝으로 홈 라이브 카드를 채운다.
 * BSO/주자 상세는 경기목록에 없어 0/빈값으로 graceful degrade(상세·중계 Naver 경로가 커버).
 */
export function liveGamesFromKboGames(games: KboGame[]): LiveGameData[] {
  return games.map(
    (g): LiveGameData => ({
      gameId: g.gameId,
      awayName: g.awayName,
      homeName: g.homeName,
      awayScore: g.status !== "scheduled" ? g.awayScore ?? 0 : 0,
      homeScore: g.status !== "scheduled" ? g.homeScore ?? 0 : 0,
      inning: g.inning ?? 0,
      isTop: g.isTop,
      balls: g.balls ?? 0,
      strikes: g.strikes ?? 0,
      outs: g.outs ?? 0,
      runner1b: g.runnersOn.first,
      runner2b: g.runnersOn.second,
      runner3b: g.runnersOn.third,
      runner1bOrder: 0,
      runner2bOrder: 0,
      runner3bOrder: 0,
      runner1bName: null,
      runner2bName: null,
      runner3bName: null,
      currentBatter: g.currentBatter || null,
      currentPitcher: g.currentPitcher || null,
      currentInning: g.inning ? `${g.inning}회${g.isTop ? "초" : "말"}` : "",
      stadium: g.stadium,
      status: g.status,
      isLive: g.status === "live",
      time: g.time,
      awayStarterName: g.awayStarterName || null,
      homeStarterName: g.homeStarterName || null,
    }),
  );
}

/** raw KBO GameList → LiveGameData (BSO/주자/투타 상세 포함). */
function mapRawLiveGame(g: KboRawGame): LiveGameData {
  const status = isKboGameCancelled(g.CANCEL_SC_ID)
    ? "cancelled"
    : g.GAME_STATE_SC === "3"
      ? "final"
      : g.GAME_STATE_SC === "2"
        ? "live"
        : "scheduled";
  return {
    gameId: g.G_ID,
    awayName: g.AWAY_NM,
    homeName: g.HOME_NM,
    awayScore: status !== "scheduled" ? parseInt(g.T_SCORE_CN) || 0 : 0,
    homeScore: status !== "scheduled" ? parseInt(g.B_SCORE_CN) || 0 : 0,
    inning: g.GAME_INN_NO ?? 0,
    isTop: g.GAME_TB_SC === "T",
    balls: g.BALL_CN ?? 0,
    strikes: g.STRIKE_CN ?? 0,
    outs: g.OUT_CN ?? 0,
    runner1b: (g.B1_BAT_ORDER_NO ?? 0) > 0,
    runner2b: (g.B2_BAT_ORDER_NO ?? 0) > 0,
    runner3b: (g.B3_BAT_ORDER_NO ?? 0) > 0,
    runner1bOrder: g.B1_BAT_ORDER_NO ?? 0,
    runner2bOrder: g.B2_BAT_ORDER_NO ?? 0,
    runner3bOrder: g.B3_BAT_ORDER_NO ?? 0,
    runner1bName: null,
    runner2bName: null,
    runner3bName: null,
    ...resolveCurrentPlayers({
      tPlayerName: g.T_P_NM,
      bPlayerName: g.B_P_NM,
      gameTbSc: g.GAME_TB_SC,
    }),
    date: g.G_DT,
    stadium: g.S_NM,
    status,
    currentInning: g.GAME_INN_NO ? `${g.GAME_INN_NO}회${g.GAME_TB_SC === "T" ? "초" : "말"}` : "",
    isLive: g.GAME_STATE_SC === "2",
    awayStarterName: g.T_PIT_P_NM?.trim() || null,
    homeStarterName: g.B_PIT_P_NM?.trim() || null,
  } as LiveGameData;
}

/**
 * 홈 라이브 데이터: KBO GameList 직호출(bounded)로 상세를 얻되, 실패/timeout/열화 시
 * 경기목록(fallbackGames, Naver 폴백 포함)에서 합성해 홈 SSR 이 절대 hang 하지 않게 한다.
 * KBO 정상 응답(경기 배열 존재)이면 그 상세를 쓰고, 빈/열화 응답이면 합성으로 수렴.
 */
export async function fetchHomeLiveGames(
  yyyymmdd: string,
  fallbackGames: KboGame[],
  opts?: { budgetMs?: number },
): Promise<LiveGameData[]> {
  try {
    const res = await fetch(HOME_LIVE_KBO_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
        "Referer": "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
      },
      body: `leId=1&srId=0,1,3,4,5,7,8,9&date=${yyyymmdd}`,
      signal: AbortSignal.timeout(opts?.budgetMs ?? HOME_LIVE_BUDGET_MS),
      cache: "no-store",
    });
    if (!res.ok) return liveGamesFromKboGames(fallbackGames);
    const data = await res.json();
    if (!Array.isArray(data?.game) || data.game.length === 0) {
      // KBO 라이브가 빈/열화 → 경기목록(Naver 폴백 포함)에서 합성.
      return liveGamesFromKboGames(fallbackGames);
    }
    return (data.game as KboRawGame[]).map(mapRawLiveGame);
  } catch {
    // timeout/blackhole/네트워크 → 경기목록에서 합성(bounded).
    return liveGamesFromKboGames(fallbackGames);
  }
}
