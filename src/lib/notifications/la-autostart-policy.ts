// 재설치/첫 실행 인앱 Live Activity 자동 시작 — 순수 판정 (삼순 1.0.9(16) 재판정 blocker②).
// I/O 없는 순수 함수만 — qa:la-autostart 스모크에서 직접 검증한다.

/** /api/game-live 응답에서 판정에 필요한 필드만 (useLiveGame LiveGameData 부분집합). */
export interface AutoStartCandidateGame {
  gameId: string;
  isLive: boolean;
  /** "scheduled" | "live" | "final" | "cancelled" (game-live route status). */
  status?: string;
  /** 시작 시각 "HH:MM" (G_TM). scheduled 30분 이내 판정용. */
  time?: string;
}

/** scheduled 카드를 인앱 start로 복구할 시작 전 윈도우 (서버 p2s 30분 전 발송과 대칭). */
export const SCHEDULED_START_WINDOW_MS = 30 * 60 * 1000;

/** gameId(YYYYMMDD + away 2자 + home 2자 + 회차) → 팀 코드 쌍. 형식 불일치 = null. */
export function parseGameIdCodes(
  gameId: string,
): { away: string; home: string } | null {
  const m = gameId.match(/^\d{8}([A-Z]{2})([A-Z]{2})\d$/);
  return m ? { away: m[1], home: m[2] } : null;
}

/**
 * gameId 앞 8자(YYYYMMDD) + "HH:MM" 시작 시각 → KST epoch ms. 파싱 불가 = null.
 * KBO 경기 시각은 전부 KST(UTC+9)라 고정 오프셋으로 조립(런타임 TZ 무관하게 결정적).
 */
export function gameStartMs(gameId: string, time: string | undefined): number | null {
  const dm = gameId.match(/^(\d{4})(\d{2})(\d{2})/);
  const tm = (time ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!dm || !tm) return null;
  const [, y, mo, d] = dm;
  const hh = tm[1].padStart(2, "0");
  const ms = Date.parse(`${y}-${mo}-${d}T${hh}:${tm[2]}:00+09:00`);
  return Number.isFinite(ms) ? ms : null;
}

/** 인앱 자동 start 대상 판정 결과 — 어떤 상태 프레임으로 start할지. */
export type StartableKind = "live" | "scheduled";

/**
 * 인앱 자동 start 대상인 최애팀 경기 선택 (삼순 5조건 재판정 blocker② 보완①).
 * - 라이브 최애팀 경기가 있으면 그것을 우선 (kind="live")
 * - 없으면 *시작 30분 이내* scheduled 최애팀 경기 (kind="scheduled") — 서버 p2s가
 *   경기 30분 전 scheduled 카드를 띄우는데 재설치로 날아간 경우 인앱에서 복구.
 *   시작 시각이 이미 지났어도 status가 아직 scheduled면(경기 지연) 포함(상한만 30분).
 * - gameId 파싱 실패(특수 포맷)·최애팀 미설정("")·cancelled는 안전 제외.
 */
export function pickMyTeamStartableGame<T extends AutoStartCandidateGame>(
  games: T[],
  myTeamCode: string,
  nowMs: number,
): { game: T; kind: StartableKind } | null {
  if (!myTeamCode) return null;
  const isMine = (g: T) => {
    const codes = parseGameIdCodes(g.gameId);
    return !!codes && (codes.away === myTeamCode || codes.home === myTeamCode);
  };
  // 라이브 우선
  const live = games.find((g) => g.isLive && isMine(g));
  if (live) return { game: live, kind: "live" };
  // 시작 30분 이내 scheduled
  const scheduled = games.find((g) => {
    if (g.isLive || g.status !== "scheduled" || !isMine(g)) return false;
    const startMs = gameStartMs(g.gameId, g.time);
    return startMs !== null && startMs - nowMs <= SCHEDULED_START_WINDOW_MS;
  });
  return scheduled ? { game: scheduled, kind: "scheduled" } : null;
}

/**
 * 오늘 경기 목록에서 *라이브 중인 최애팀 경기* 선택. 없으면 null.
 * (하위호환 — 기존 호출부/스모크 유지. 신규 경로는 pickMyTeamStartableGame 사용.)
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
