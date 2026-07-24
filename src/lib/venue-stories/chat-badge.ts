// 크관 [직관] 배지 — 해당 경기에 직관 스토리를 올린 유저 판정.
//
// 기준: 그 경기(game_id)에 status='active' 스토리 1개 이상.
// - expires_at 은 보지 않는다: 스토리가 만료돼도 "직관 인증 사실"은 불변이므로
//   그 경기 채팅에서는 라벨을 유지한다.
// - status='removed'(신고 삭제)·'cleanup_failed'·'pending'(검증 전)은 제외.
// - 만료 +24h 후 cleanup cron 이 행 자체를 삭제하면 자연히 목록에서 빠진다
//   (그 시점엔 경기도 끝난 지 하루 이상이라 실사용 영향 없음).

/** 스토리 행 목록 → 중복 제거된 작성자 user_id 목록 (응답 payload 최소화). */
export function attendeeUserIdsFromRows(rows: Array<{ user_id: string }>): string[] {
  return [...new Set(rows.map((r) => r.user_id))];
}
