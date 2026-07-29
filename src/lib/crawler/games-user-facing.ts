// 유저 대면(홈 SSR + /api/games) 경기목록 — Naver primary + KBO enrich 하이브리드.
//
// 결정(2026-07-29 하린아빠): 벤치 결과 KBO는 tail latency가 치명적(avg 831ms·max 5.7s,
// 지금 열화 구간 실패율 56%)이고 Naver는 안정적(avg 30ms·max 105ms·실패 0%). 두 소스는
// 같은 공식 피드에서 병렬로 받으므로 freshness는 tie이고 차이는 배달 신뢰성뿐 → 유저 대면
// 경로는 Naver 를 primary 로 스코어/상태/이닝을 항상 빠르게 공급하고, KBO 는 비차단·짧은
// budget 으로 BSO/주자/현재투타/선발/랭크만 enrich 한다(KBO 살아있을 때만; 죽으면 graceful).
//
// cron/배치는 이 경로를 쓰지 않는다 — 지연 민감하지 않고 KBO 필드/시리즈 필터가 필요하므로
// 기존 fetchGames(KBO-primary) 를 그대로 쓴다(블래스트 반경 0).

import { fetchKboGamesOnly, type KboGame } from "@/lib/crawler/kbo-api";
import { fetchNaverGames } from "@/lib/crawler/naver-games";

// KBO enrich 는 비차단 성격 — 짧은 budget. 살아있으면 <1s, 열화면 이 상한에서 끊고 Naver 만.
export const KBO_ENRICH_TIMEOUT_MS = 1500;

/**
 * Naver 베이스(primary)에 KBO 라이브 상세를 gameId 로 매칭 오버레이한다.
 * - 스코어/상태/이닝: Naver 유지(primary) — 두 소스 스코어 flicker 방지.
 * - BSO/주자/현재투타: 양쪽 모두 live 인 경기에만 KBO 값 오버레이(예정/종료는 base 유지).
 * - 선발/승패투/세이브/랭크/방송: 상태 무관, KBO 값이 있으면 채움(Naver 는 "" / 0 으로 degrade).
 * 순수 함수(테스트용 export).
 */
export function mergeKboEnrichment(naverBase: KboGame[], kboGames: KboGame[]): KboGame[] {
  const kboById = new Map(kboGames.map((g) => [g.gameId, g]));
  return naverBase.map((base) => {
    const k = kboById.get(base.gameId);
    if (!k) return base;
    const overlayLive = base.status === "live" && k.status === "live";
    return {
      ...base,
      strikes: overlayLive ? k.strikes : base.strikes,
      balls: overlayLive ? k.balls : base.balls,
      outs: overlayLive ? k.outs : base.outs,
      runnersOn: overlayLive ? k.runnersOn : base.runnersOn,
      currentPitcher: overlayLive ? k.currentPitcher : base.currentPitcher,
      currentBatter: overlayLive ? k.currentBatter : base.currentBatter,
      awayStarterName: k.awayStarterName || base.awayStarterName,
      homeStarterName: k.homeStarterName || base.homeStarterName,
      winPitcher: k.winPitcher || base.winPitcher,
      losePitcher: k.losePitcher || base.losePitcher,
      savePitcher: k.savePitcher || base.savePitcher,
      awayRank: k.awayRank || base.awayRank,
      homeRank: k.homeRank || base.homeRank,
      broadcastChannels: base.broadcastChannels ?? k.broadcastChannels,
    };
  });
}

/**
 * 유저 대면 경기목록. Naver(primary) + KBO(enrich) 를 병렬로 호출해 병합한다.
 * - Naver 성공 → 베이스. KBO enrich 성공 & 경기 있으면 오버레이, 아니면 Naver 베이스(BSO degrade).
 * - Naver 가 (드물게) 빈데 KBO 에 경기 있으면 KBO 사용(Naver-wrongly-empty 안전망).
 * - Naver 실패 → KBO 폴백(full data). 둘 다 실패면 throw.
 * 총 소요 ≈ max(Naver ~30ms, KBO enrich ≤1.5s). KBO 열화여도 홈은 ≤1.5s 안에 수렴.
 */
export async function fetchGamesUserFacing(date: string): Promise<KboGame[]> {
  const [naverR, kboR] = await Promise.allSettled([
    fetchNaverGames(date),
    fetchKboGamesOnly(date, "0,1,3,4,5,7,9", { timeoutMs: KBO_ENRICH_TIMEOUT_MS }),
  ]);

  if (naverR.status === "fulfilled") {
    const base = naverR.value;
    const kbo = kboR.status === "fulfilled" ? kboR.value : [];
    // Naver 가 빈데 KBO 에 경기 있으면 Naver 오탐 가능 → KBO 사용(안전망).
    if (base.length === 0 && kbo.length > 0) return kbo;
    return kbo.length > 0 ? mergeKboEnrichment(base, kbo) : base;
  }

  // Naver 실패 → KBO 폴백(전체 데이터). KBO 도 실패면 원래 Naver 에러로 throw.
  if (kboR.status === "fulfilled") return kboR.value;
  throw (naverR as PromiseRejectedResult).reason ?? new Error("games fetch failed (Naver+KBO)");
}
