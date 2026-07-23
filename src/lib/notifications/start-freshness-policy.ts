// 시작 알림 신선도 가드 (2026-07-23 하린아빠 지시: "이미 늦은 시작알림은 발송 안되게 가드까지 넣어").
//
// 예정시각 +90분 윈도우(START_WINDOW_MS)만으로는 cron/파서 장애가 몇십 분 만에 복구될 때
// 이미 한창 진행 중인 경기에도 "⚾ 경기 시작!"이 뒷북으로 나간다(7/23 실사고에서 확인된 갭).
// 경기 진행도(이닝) 기반 가드를 추가한다: 1회초를 지난 경기는 이미 시작한 지 오래 → 발송 금지.
//
// 우천 등 지연 시작 경기는 실제 개시 시점에야 state=2·1회초로 관측되므로 정상 발송된다
// (예정시각 기준 윈도우와 달리 지연 시작을 오탐하지 않는다). 이닝 정보가 없는 개시 직후
// 순간은 신선한 것으로 보고 기존 시간 윈도우가 커버한다.
// scheduled→live 전환 연속 관측 허용 폭: warmup cron은 매분 돌므로 정상이면 마지막 "예정" 관측이
// 1~2분 전이다. 배포/일시 장애로 몇 틱 빠져도 정시성을 잃지 않는 범위로 5분까지 허용.
// 그 이상 벤 관측 공백 = 장애 복구 뒷북 위험 → 발송 금지(mark-only).
export const SCHEDULED_SEEN_RECENT_MS = 5 * 60 * 1000;

// 시작알림 발송 게이트 (2026-07-23 삼순 post-merge blocker 반영):
// "최근 scheduled→live 전환을 연속 관측한 경우만 발송, 첫 관측이 이미 live거나 stale이면 mark-only".
// - lastSeenScheduledAtMs === null: 이 경기를 "예정" 상태로 본 적이 없음 = 첫 관측이 이미 live
//   (장애 복구·재배포·기능 도입 직후) → 발송 금지.
// - 관측이 SCHEDULED_SEEN_RECENT_MS보다 오래넨: cron 공백 동안 무슨 일이 있었는지 모름 → 금지.
// - 우천 등 지연 시작: cron이 실제 개시 직전까지 계속 "예정"을 관측하므로 정상 발송된다.
// - 이닝 가드(isStartNotificationFresh)는 이중 안전망으로 유지.
export function shouldSendStartNotification(params: {
  lastSeenScheduledAtMs: number | null;
  nowMs: number;
  inningNo: number | null | undefined;
  isTop: boolean | null | undefined;
}): boolean {
  if (params.lastSeenScheduledAtMs === null) return false;
  if (params.nowMs - params.lastSeenScheduledAtMs > SCHEDULED_SEEN_RECENT_MS) return false;
  return isStartNotificationFresh({ inningNo: params.inningNo, isTop: params.isTop });
}

export function isStartNotificationFresh(params: {
  /** KBO GAME_INN_NO — 개시 직후 등 미제공이면 null */
  inningNo: number | null | undefined;
  /** GAME_TB_SC === "T" 여부. 미제공이면 null(판단 보류 → fresh) */
  isTop: boolean | null | undefined;
}): boolean {
  const inning = typeof params.inningNo === "number" ? params.inningNo : null;
  if (inning === null) return true;
  if (inning > 1) return false;
  if (inning === 1 && params.isTop === false) return false; // 1회말 = 이미 수십 분 경과
  return true;
}
