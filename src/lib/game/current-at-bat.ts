import type { InningRelay } from "@/app/api/game-relay/route";

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
