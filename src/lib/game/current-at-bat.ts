import type { InningRelay } from "@/app/api/game-relay/route";
import type { GameDetailResponse } from "@/app/api/game-detail/route";
import { resolveConsistentPitcher } from "@/lib/game/current-pitcher-consistency";

/** 크관 현재 타석 카드에 넣을 최소 형태 (batterName + 진행 중 투구). */
export type CurrentAtBat = NonNullable<InningRelay["currentAtBat"]>;

/**
 * 크관 LiveView 현재 타석 파생 SSOT.
 *
 * relay가 있으면 parser의 `currentAtBat` 계약만 사용한다 — terminal 을 본 순간
 * parser가 currentAtBat 을 제거하므로 여기서도 null 이 되어 "빈 현재 타석"이 사라진다.
 * 과거엔 `?? currentBatter` fallback 이 있어, relay 가 먼저 terminal 을 본 구간에
 * useLiveGame(느린 polling)의 stale `currentBatter`로 완료된 타자를 다시 "현재 타석"으로
 * 합성하는 버그가 있었다(삼순 blocker 3). relay 존재 시 그 fallback 을 끊는다.
 *
 * relay 가 아예 없을 때(문자중계 fallback)만 currentBatter 로 최소 카드를 만든다.
 */
export function resolveCurrentAtBat(args: {
  hasRelay: boolean;
  latestInning: InningRelay | null | undefined;
  currentBatter: string | null | undefined;
}): CurrentAtBat | null {
  const { hasRelay, latestInning, currentBatter } = args;
  if (hasRelay) {
    // relay 계약이 SSOT. terminal 뒤엔 currentAtBat 이 없으므로 카드 미노출(0개).
    return latestInning?.currentAtBat ?? null;
  }
  // relay 부재 시에만 최소 fallback (type:8 0구 상당).
  return currentBatter ? { batterName: currentBatter, pitches: [] } : null;
}

/**
 * 크관 현재타석 카드 *전용* 투수명 결속 (교차팀 매치업 방지).
 *
 * 이 카드만 두 소스를 섞는다: 타자 = relay(3초 폴링, 빠름), 투수 = game-live(10초 폴링, 느림).
 * 하프 전환 window 에 relay 는 새 하프 타자를 먼저 반영하고 game-live 는 이전 하프 투수
 * (= 새 하프에선 공격팀 소속)를 최대 ~10초 유지 → 같은 팀 타자 vs 투수(교차팀) 렌더.
 * (2026-09-03 실측: 7회초 롯데 전민재 vs 롯데 비슬리. KBO raw 는 원자적 = 클라 skew.)
 *
 * ⚠️ 범위: **이 카드에만** 적용한다(삼순 리뷰 ①). deriveGameState 의 전역 currentPitcher 를
 * 지우면 game-live 기준으로 내부 정합한 FieldView·MatchupCard·LiveStats 의 정상 투수까지
 * reverse skew/relay 지연 때 사라진다. 그 세 소비처는 타자·투수가 같은 game-live 스냅샷이라
 * 애초에 교차팀이 나지 않으므로 건드리지 않는다.
 *
 * relay 최신 이닝의 half 가 SSOT. currentPitcher(game-live) 가 그 하프의 *공격팀* 투수명단에만
 * 있으면 이전 하프 stale → null(투수칸 미표시). 수비팀 소속/양팀 동시/미상/명단 결측은 유지(fail-safe).
 * 이름 매칭은 정규화 containment(game-live `비슬리` ⊂ boxScore `제러미 비슬리`).
 *
 * 순수 함수(node 직접 실행·결함주입 게이트 대상). 렌더 컴포넌트 밖에 둔다.
 */
export function resolveCurrentAtBatCardPitcher(args: {
  /** relay 최신 이닝(현재 하프의 SSOT). half 로 공격/수비팀을 정한다. */
  latestInning: InningRelay | null | undefined;
  /** game-live(느린 소스)에서 온 현재 투수명. */
  currentPitcher: string | null | undefined;
  /** game-detail boxScore(투수 팀 귀속 판정용). */
  boxScore: GameDetailResponse["boxScore"] | null | undefined;
}): string | null {
  const { latestInning, currentPitcher, boxScore } = args;
  // half 가 SSOT — relay 최신 이닝에서 직접 취한다(여기가 wiring seam).
  const relayHalf = latestInning?.half ?? null;
  return resolveConsistentPitcher({
    currentPitcher,
    relayHalf,
    awayPitcherNames: boxScore?.awayPitchers?.map((p) => p.name) ?? null,
    homePitcherNames: boxScore?.homePitchers?.map((p) => p.name) ?? null,
  });
}
