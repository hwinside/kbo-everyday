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

// 적용일 freshness 허용 범위(삼순 P1 4차): 운영 기대는 "당일"이나, KST 자정 경계/KBO 반영
// 지연을 감안해 실행일(0) 또는 실행일-1(어제)까지만 허용한다. 그 밖(더 오래된 stale / 미래)은 거부.
export const ROSTER_DATE_MAX_AGE_DAYS = 1;

/** 주어진 시각의 KST(UTC+9) 달력 날짜를 YYYYMMDD로 반환. */
export function kstDateString(now: Date): string {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** YYYYMMDD → UTC 자정 기준 에포크 일수(날짜 간 차이 계산용). */
function yyyymmddToUtcDays(yyyymmdd: string): number {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/**
 * 수집 결과 sanity 검증. 이상이면 사유 문자열, 정상이면 null.
 * - 날짜는 8자리 YYYYMMDD
 * - 적용일 freshness: KST 실행일 대비 [실행일-ROSTER_DATE_MAX_AGE_DAYS, 실행일] 범위(stale/미래 거부)
 * - 10구단 전부 수집
 * - 팀당 인원이 [TEAM_ROSTER_MIN, TEAM_ROSTER_MAX] 범위(0명/파싱 실패/마크업 변경 탐지)
 *
 * @param now 실행 시각(freshness 기준). 기본값 = 현재 시각. 테스트는 고정 시각을 주입한다.
 */
export function validateRosterCollection(
  date: string,
  teams: { teamId: number; entries: { length: number } }[],
  now: Date = new Date(),
): string | null {
  if (!/^\d{8}$/.test(date)) {
    return `등록명단 날짜 형식 이상: "${date}" (YYYYMMDD 기대)`;
  }
  // 적용일 freshness(삼순 P1 4차): 형식만 맞고 stale/미래인 날짜를 최신 payload로 쓰지 않도록
  // KST 실행일과 대조한다. KBO가 캐시/마크업 오류로 유효한 과거 날짜를 줘도 과거 스냅샷을 덮지 않는다.
  const today = kstDateString(now);
  const ageDays = yyyymmddToUtcDays(today) - yyyymmddToUtcDays(date);
  if (ageDays < 0) {
    return `등록명단 적용일이 미래: "${date}" (KST 실행일 ${today})`;
  }
  if (ageDays > ROSTER_DATE_MAX_AGE_DAYS) {
    return `등록명단 적용일 stale: "${date}"이 KST 실행일 ${today}보다 ${ageDays}일 과거(허용 ${ROSTER_DATE_MAX_AGE_DAYS}일 이내)`;
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
