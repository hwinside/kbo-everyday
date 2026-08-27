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
// Naver(primary) user-facing timeout SSOT. 기본 fetchNaverGames 5s 를 그대로 쓰면 Naver blackhole 시
// 건강한 KBO 폴백도 5초 뒤에야 반환된다(삼순 NO-GO P0). 짧게 잡아 Naver-down 시도 bounded.
export const USER_FACING_NAVER_TIMEOUT_MS = 2000;

/**
 * Naver 베이스(primary)에 KBO 라이브 상세를 gameId 로 매칭 오버레이한다.
 * - 스코어/상태/이닝: Naver 유지(primary) — 두 소스 스코어 flicker 방지.
 * - BSO/주자/현재투타: 양쪽 모두 live 인 경기에만 KBO 값 오버레이(예정/종료는 base 유지).
 * - 선발/승패투/세이브/랭크/방송: 상태 무관, KBO 값이 있으면 채움(Naver 는 "" / 0 으로 degrade).
 * 순수 함수(테스트용 export).
 */
export function mergeKboEnrichment(naverBase: KboGame[], kboGames: KboGame[]): KboGame[] {
  const kboById = new Map(kboGames.map((g) => [g.gameId, g]));
  const merged = naverBase.map((base) => {
    const k = kboById.get(base.gameId);
    if (!k) return base;
    // 휘발성 in-game 상태(BSO/주자/현재투타)는 두 소스가 '정확히 같은 라이브 순간'일 때만
    // 오버레이. 이닝/초말/양팀 스코어 하나라도 다르면 서로 다른 시점의 KBO 값이 Naver 최신
    // 스코어에 섞여 유령 상태가 된다(삼순 NO-GO P1) → Naver degrade 값 유지.
    const sameLiveMoment =
      base.status === "live" && k.status === "live" &&
      base.inning === k.inning && base.isTop === k.isTop &&
      base.awayScore === k.awayScore && base.homeScore === k.homeScore;
    // 결과 투수(승/패/세이브)는 양쪽 종료일 때만 의미.
    const bothFinal = base.status === "final" && k.status === "final";
    // 취소 사유는 KBO 에만 있다(Naver schedule 피드에 해당 필드가 없어 base 는 항상 null).
    // primary 가 Naver 이므로 여기서 오버레이 하지 않으면 사유가 영영 유저에게 안 닿는다.
    // 단 **양쪽이 모두 cancelled** 일 때만 실는다 — 상태는 base(Naver) 가 canonical 이라
    // KBO 만 cancelled 인 시점 불일치 구간에서 사유만 새어나오면 base.status(live/final) 와
    // 모순된 표기가 된다(값-플래그 결속, liveDetailFromKbo 와 동일 축).
    const bothCancelled = base.status === "cancelled" && k.status === "cancelled";
    return {
      ...base,
      strikes: sameLiveMoment ? k.strikes : base.strikes,
      balls: sameLiveMoment ? k.balls : base.balls,
      outs: sameLiveMoment ? k.outs : base.outs,
      runnersOn: sameLiveMoment ? k.runnersOn : base.runnersOn,
      currentPitcher: sameLiveMoment ? k.currentPitcher : base.currentPitcher,
      currentBatter: sameLiveMoment ? k.currentBatter : base.currentBatter,
      // provenance: 오버레이를 실제로 한 때만 KBO 관측값이다. 시점 불일치로 오버레이를 포기하면
      // 남는 값은 Naver degrade(0/false) 이므로 base 의 플래그(false)를 그대로 유지해야 한다.
      // 값과 플래그를 같은 조건으로 묶어야 "값은 degrade 인데 플래그만 true" 가 구조적으로 불가능해진다.
      liveDetailFromKbo: sameLiveMoment ? k.liveDetailFromKbo : base.liveDetailFromKbo,
      cancelReason: bothCancelled ? (k.cancelReason ?? base.cancelReason) : base.cancelReason,
      // 준정적(시점 무관): 선발/랭크/방송 — KBO 값 있으면 채움
      awayStarterName: k.awayStarterName || base.awayStarterName,
      homeStarterName: k.homeStarterName || base.homeStarterName,
      awayRank: k.awayRank || base.awayRank,
      homeRank: k.homeRank || base.homeRank,
      broadcastChannels: base.broadcastChannels ?? k.broadcastChannels,
      // 결과 투수: 양쪽 final 일 때만
      winPitcher: bothFinal ? k.winPitcher || base.winPitcher : base.winPitcher,
      losePitcher: bothFinal ? k.losePitcher || base.losePitcher : base.losePitcher,
      savePitcher: bothFinal ? k.savePitcher || base.savePitcher : base.savePitcher,
    };
  });
  // KBO-only 경기(Naver 가 부분목록이라 놓친 경기)를 deterministic union 으로 보존(삼순 NO-GO P1).
  // gameId 유일성 보장: seen 집합을 Naver id 로 시드 → Naver 중복도, KBO 내부 중복(upstream 부분
  // 열화/중복 응답)도 둘 다 dedupe. 결과는 항상 result.length === unique gameId size (삼순 P1).
  const seen = new Set(naverBase.map((g) => g.gameId));
  const kboOnly: KboGame[] = [];
  for (const g of [...kboGames].sort((a, b) => a.gameId.localeCompare(b.gameId))) {
    if (seen.has(g.gameId)) continue;
    seen.add(g.gameId);
    kboOnly.push(g);
  }
  return [...merged, ...kboOnly];
}

/**
 * 유저 대면 경기목록. Naver(primary) + KBO(enrich) 를 병렬로 호출해 병합한다.
 * - Naver 성공 → 베이스. KBO enrich 성공 & 경기 있으면 오버레이, 아니면 Naver 베이스(BSO degrade).
 * - Naver 가 (드물게) 빈데 KBO 에 경기 있으면 KBO 사용(Naver-wrongly-empty 안전망).
 * - Naver 실패 → KBO 폴백(full data). 둘 다 실패면 throw.
 * 총 소요 ≈ max(Naver ~30ms, KBO enrich ≤1.5s). KBO 열화여도 홈은 ≤1.5s 안에 수렴.
 */
export async function fetchGamesUserFacing(date: string): Promise<KboGame[]> {
  return (await fetchGamesUserFacingWithMeta(date)).games;
}

/**
 * 경기목록 + 소스 가용성 메타. `kboGameIds` = KBO 조회가 성공했을 때 그 응답에 들어있던
 * gameId 집합, KBO 조회 실패면 null.
 *
 * 왜 필요한가 (삼순 2026-08-11 #1147 P0): Naver 선발명은 항상 빈값이라, KBO enrich 가
 * 죽으면 결과 경기의 선발이 빈 것이 "아직 발표 안 됨"인지 "소스 장애"인지 구분되지 않는다.
 * 이 메타가 없으면 소비자(야잘알봇 선발 매치업)가 KBO timeout 을 `미발표`로 거짓 안내하게 된다.
 * 홈/기존 경로는 games 만 쓰므로 동작 불변.
 */
export async function fetchGamesUserFacingWithMeta(
  date: string,
): Promise<{ games: KboGame[]; kboGameIds: Set<string> | null }> {
  const [naverR, kboR] = await Promise.allSettled([
    fetchNaverGames(date, undefined, { timeoutMs: USER_FACING_NAVER_TIMEOUT_MS }),
    fetchKboGamesOnly(date, "0,1,3,4,5,7,9", { timeoutMs: KBO_ENRICH_TIMEOUT_MS }),
  ]);

  const kboGameIds = kboR.status === "fulfilled"
    ? new Set(kboR.value.map((g) => g.gameId))
    : null;

  // 모든 반환 경로를 mergeKboEnrichment 로 통일해 gameId 유일성 불변식을 공통 적용한다
  // (삼순 P1: base===[] / Naver 실패 직접 반환이 dedupe 를 우회하던 것 차단).
  if (naverR.status === "fulfilled") {
    const base = naverR.value;
    const kbo = kboR.status === "fulfilled" ? kboR.value : [];
    // Naver 가 빈데 KBO 에 경기 있으면 Naver 오탐 가능 → KBO 전체 사용(안전망). dedupe 는 merge 가.
    if (base.length === 0 && kbo.length > 0) return { games: mergeKboEnrichment([], kbo), kboGameIds };
    // KBO enrich + KBO-only union + dedupe(mergeKboEnrichment 내부).
    return { games: mergeKboEnrichment(base, kbo), kboGameIds };
  }

  // Naver 실패 → KBO 폴백(전체 데이터, dedupe 정규화). KBO 도 실패면 원래 Naver 에러로 throw.
  if (kboR.status === "fulfilled") return { games: mergeKboEnrichment([], kboR.value), kboGameIds };
  throw (naverR as PromiseRejectedResult).reason ?? new Error("games fetch failed (Naver+KBO)");
}
