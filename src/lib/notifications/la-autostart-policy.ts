// 재설치/첫 실행 인앱 Live Activity 자동 시작 — 순수 판정 (삼순 1.0.9(16) 재판정 blocker②).
// I/O 없는 순수 함수만 — qa:la-autostart 스모크에서 직접 검증한다.

/** /api/game-live 응답에서 판정에 필요한 필드만 (useLiveGame LiveGameData 부분집합). */
export interface AutoStartCandidateGame {
  gameId: string;
  isLive: boolean;
}

/** gameId(YYYYMMDD + away 2자 + home 2자 + 회차) → 팀 코드 쌍. 형식 불일치 = null. */
export function parseGameIdCodes(
  gameId: string,
): { away: string; home: string } | null {
  const m = gameId.match(/^\d{8}([A-Z]{2})([A-Z]{2})\d$/);
  return m ? { away: m[1], home: m[2] } : null;
}

/**
 * 오늘 경기 목록에서 *라이브 중인 최애팀 경기* 선택. 없으면 null.
 * - isLive만 대상 (scheduled 프레임은 p2s 전용 — 인앱 start는 live 상태만 지원)
 * - gameId 파싱 실패(올스타 등 특수 포맷)는 안전하게 제외
 * - 최애팀 미설정("")은 항상 null (비참여 유저에 카드 금지, #527 게이트와 동일)
 */
export function pickMyTeamLiveGame<T extends AutoStartCandidateGame>(
  games: T[],
  myTeamCode: string,
): T | null {
  if (!myTeamCode) return null;
  return (
    games.find((g) => {
      if (!g.isLive) return false;
      const codes = parseGameIdCodes(g.gameId);
      return !!codes && (codes.away === myTeamCode || codes.home === myTeamCode);
    }) ?? null
  );
}
