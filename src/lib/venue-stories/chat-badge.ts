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

/** 크관 채팅 렌더 시 로드된 참석자 명단 snapshot — *어느 경기*의 명단인지 함께 고정. */
export type VenueAttendees = { gameId: string; ids: Set<string> };

/**
 * [직관] 배지 표시 여부 판정 (GameChat 렌더의 단일 진실 소스).
 *
 * 반드시 명단 snapshot 의 gameId 가 *현재 보고 있는* 경기와 일치할 때만 true.
 * 유저가 여러 경기 크관을 오갈 때(경기 A→B 전환) 이전 경기 명단이나 늦게 도착한
 * 이전 요청 응답이 새 경기 채팅에 오표시되는 것을 이 가드로 구조적으로 차단한다.
 * 명단 미로드(null)나 pending/실패 상태에서도 안전하게 false.
 */
export function shouldShowVenueBadge(
  attendees: VenueAttendees | null,
  currentGameId: string,
  userId: string,
): boolean {
  return attendees?.gameId === currentGameId && attendees.ids.has(userId);
}
