/**
 * KBO 등록명단 수집 결과 sanity 검증 (순수 로직 — 스모크 테스트 대상).
 *
 * 배경(삼순 P1): 기존 수집 함수는 HTTP status/토큰/날짜/인원수를 검증하지 않아,
 * KBO 403/마크업 변경으로 0명 파싱돼도 팀 skip 후 최종 ok:true가 가능했다.
 * 실제 HTTP는 crawler/kbo-api.ts fetchRegisterRosters가 담당하고, "무엇이 정상 수집인가"
 * 판정은 여기 순수 함수로 분리해 테스트한다(외부 호출/DB 의존 없음 — 스모크가 import 가능).
 */

/** 수집 실패를 마커링하는 전용 예외(cron이 5xx fail-closed + 운영 알림으로 분기). */
export class RosterCollectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RosterCollectionError";
  }
}

// 팀당 1군 등록 인원 sanity 범위(실측 297/10≈30명 기준). 이 범위 밖이면 마크업 변경/차단 간주.
export const TEAM_ROSTER_MIN = 20;
export const TEAM_ROSTER_MAX = 40;
export const EXPECTED_TEAM_COUNT = 10;

/**
 * 수집 결과 sanity 검증. 이상이면 사유 문자열, 정상이면 null.
 * - 날짜는 8자리 YYYYMMDD
 * - 10구단 전부 수집
 * - 팀당 인원이 [TEAM_ROSTER_MIN, TEAM_ROSTER_MAX] 범위(0명/파싱 실패/마크업 변경 탐지)
 */
export function validateRosterCollection(
  date: string,
  teams: { teamId: number; entries: { length: number } }[],
): string | null {
  if (!/^\d{8}$/.test(date)) {
    return `등록명단 날짜 형식 이상: "${date}" (YYYYMMDD 기대)`;
  }
  if (teams.length !== EXPECTED_TEAM_COUNT) {
    return `구단 수 이상: ${teams.length}개 수집(${EXPECTED_TEAM_COUNT}구단 기대)`;
  }
  const bad = teams.filter(
    (t) => t.entries.length < TEAM_ROSTER_MIN || t.entries.length > TEAM_ROSTER_MAX,
  );
  if (bad.length > 0) {
    return (
      `팀당 인원 sanity 실패(${TEAM_ROSTER_MIN}~${TEAM_ROSTER_MAX} 범위 밖): ` +
      bad.map((t) => `team ${t.teamId}=${t.entries.length}명`).join(", ")
    );
  }
  return null;
}
