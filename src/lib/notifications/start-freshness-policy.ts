// 시작 알림 신선도 가드 (2026-07-23 하린아빠 지시: "이미 늦은 시작알림은 발송 안되게 가드까지 넣어").
//
// 예정시각 +90분 윈도우(START_WINDOW_MS)만으로는 cron/파서 장애가 몇십 분 만에 복구될 때
// 이미 한창 진행 중인 경기에도 "⚾ 경기 시작!"이 뒷북으로 나간다(7/23 실사고에서 확인된 갭).
// 경기 진행도(이닝) 기반 가드를 추가한다: 1회초를 지난 경기는 이미 시작한 지 오래 → 발송 금지.
//
// 우천 등 지연 시작 경기는 실제 개시 시점에야 state=2·1회초로 관측되므로 정상 발송된다
// (예정시각 기준 윈도우와 달리 지연 시작을 오탐하지 않는다). 이닝 정보가 없는 개시 직후
// 순간은 신선한 것으로 보고 기존 시간 윈도우가 커버한다.
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
