// 홈 SSR 라이브 데이터 — 경기목록(fetchGames 결과, Naver 폴백 포함)을 LiveGameData 로
// 순수 변환한다. 별도 KBO 2차 직호출은 하지 않는다.
//
// 배경(2026-07-29 삼순 리뷰 3차): 기존 홈 page.tsx 의 2차 raw KBO 직호출은 (1) AbortSignal
// 이 없어 KBO blackhole 시 홈 SSR 이 영원히 hang 했고, (2) fetchGames(GetKboGameList JSON)
// 응답에 이미 BSO/주자/현재 투타(strikes/balls/outs/runnersOn/currentBatter/currentPitcher)
// 가 전부 들어 있어 같은 KBO 엔드포인트를 한 틱에 두 번 때리는 중복이었다. → 2차 호출을
// 제거하고 경기목록에서 순수 변환. KBO 완전 장애 시에도 fetchGames 의 Naver 폴백 결과로
// 홈 라이브 카드가 합성된다(BSO/주자 상세는 Naver schedule 에 없어 0/빈값 graceful degrade,
// in-game 상세는 game-live 폴링·중계(Naver 경로)가 커버).

import type { KboGame } from "@/lib/crawler/kbo-api";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";

/**
 * KboGame(경기목록 — fetchGames, Naver 폴백 포함) → LiveGameData 순수 변환.
 * KBO 정상 응답이면 BSO/주자/현재 투타 상세가 그대로 살아 있고,
 * Naver 폴백 결과면 스코어/상태/이닝만 유지되고 상세는 graceful 0/빈값.
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
      // 취소 사유 — 홈 SSR 초기 진입 경로도 사유를 실어야 한다(삼순 NO-GO ①).
      // useHomeInit 은 initialGames 가 있으면 클라이언트 재조회를 건너뛰므로,
      // 여기서 누락되면 첫 화면은 영영 고정 문구로 남는다.
      cancelReason: g.status === "cancelled" ? (g.cancelReason ?? null) : null,
      isLive: g.status === "live",
      time: g.time,
      awayStarterName: g.awayStarterName || null,
      homeStarterName: g.homeStarterName || null,
    }),
  );
}
