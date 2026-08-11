/**
 * KBO canonical gameId 형식 가드.
 *
 * canonical 형식: `YYYYMMDD` + 팀코드 4자리(원정+홈, 예: LGWO) + 시리즈/DH 1자리
 * 예: `20260811LGWO0`, 더블헤더 `20260811LGWO1`, 올스타 `20260711WEEA0`.
 *
 * WHY (2026-08-11 인시던트): 네이버식 긴 ID(`20260811LGWO02026`, 연도 suffix
 * 포함)를 relay/detail 라우트에 넘기면 `toNaverGameId`가 연도를 한 번 더 붙여
 * (`…LGWO020262026`) 네이버 404를 유발한다. 이 자기유발 404가 "네이버가 Vercel을
 * 차단" 오판 → 3시간짜리 우회 작업(PR #1150, 폐기)으로 이어졌다. 형식이 아닌
 * ID는 업스트림에 도달하기 전에 400으로 fail-close해 같은 사고를 구조적으로
 * 차단한다.
 */
export const CANONICAL_KBO_GAME_ID_RE = /^\d{8}[A-Z]{4}\d$/;

export function isCanonicalKboGameId(gameId: string): boolean {
  return CANONICAL_KBO_GAME_ID_RE.test(gameId);
}

/** 400 응답 본문에 실을 안내 메시지 (라우트 공용). */
export const GAME_ID_FORMAT_HINT =
  "expected canonical KBO gameId like 20260811LGWO0 (8-digit date + 4-letter team pair + 1-digit series)";
