import type { GameEvent } from "@/types/game-events";

// 홈런 득점(예: 솔로 홈런 1점)은 at_bat_homerun 푸시가 이미 커버한다. 그런데 그 득점이
// 라이브 스코어에 *뒤늦게* 반영되면(홈런은 BoxScore에서 먼저 감지, 점수는 다음 폴링에서
// 갱신) generator가 같은 사이클이 아니라 run_scored를 따로 emit → 같은 1점에 "홈런!"+"득점!"
// 2푸시가 나간다(고객 제보 2026-06-24 #SSLG, 오스틴 솔로 홈런). generator의 같은-사이클
// suppression(event-generator #213-①)이 폴링 시차로 놓치는 이 케이스를, 알림 레이어가
// 전체(누적) 이벤트 기준으로 막는다. 큰 이닝의 후속 안타 득점까지 삼키지 않도록 같은 half
// (inning+isTop) + 짧은 시간창 안의 홈런만 매칭한다(시차는 보통 1폴링 ≈ 60s 이내).
//
// 순수 함수(DB·FCM 의존 없음) — game-score.ts에서 사용하고 smoke 테스트가 직접 검증한다.
export const HR_RUN_DEDUPE_WINDOW_MS = 180_000;

export function isHomerunCoveredRun(ev: GameEvent, allEvents: GameEvent[]): boolean {
  if (ev.type !== "run_scored") return false;
  const t = Date.parse(ev.timestamp);
  if (!Number.isFinite(t)) return false; // 타임스탬프 불량 → 억제하지 않음(중복 < 미발송)
  return allEvents.some((e) => {
    if (e.type !== "at_bat_homerun") return false;
    if (e.isTop !== ev.isTop || e.inning !== ev.inning) return false;
    const ht = Date.parse(e.timestamp);
    return Number.isFinite(ht) && Math.abs(ht - t) <= HR_RUN_DEDUPE_WINDOW_MS;
  });
}
