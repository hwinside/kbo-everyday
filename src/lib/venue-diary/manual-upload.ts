import type { ResolvedVenue } from "@/lib/venue-stories/venue-resolve";

export const VENUE_DIARY_MANUAL_SOURCE = "diary_manual" as const;
export const VENUE_DIARY_MANUAL_SEASON = 2026;

export type ManualDiaryGameDecision =
  | { ok: true }
  | { ok: false; status: 403 | 404; error: string };

export type ManualAttendanceTeamDecision =
  | { ok: true; favoriteTeamId: number }
  | { ok: false; status: 400 | 403; error: string };

/**
 * 과거 경기 직접 추가는 실제 KBO 2026 종료 경기만 허용한다.
 * 시간 경과나 gameId 날짜만으로 종료를 추정하지 않고 crawler의 final 상태를 권위로 쓴다.
 */
export function decideManualDiaryGame(
  venue: Pick<ResolvedVenue, "exists" | "gameDate" | "status">,
): ManualDiaryGameDecision {
  if (!venue.exists || !venue.gameDate) {
    return { ok: false, status: 404, error: "경기를 확인할 수 없어요" };
  }
  if (!venue.gameDate.startsWith(`${VENUE_DIARY_MANUAL_SEASON}-`)) {
    return {
      ok: false,
      status: 403,
      error: `${VENUE_DIARY_MANUAL_SEASON} 시즌 경기만 직접 추가할 수 있어요`,
    };
  }
  if (venue.status !== "final") {
    return {
      ok: false,
      status: 403,
      error:
        venue.status === "cancelled"
          ? "취소된 경기는 직접 추가할 수 없어요"
          : "종료된 경기만 직접 추가할 수 있어요",
    };
  }
  return { ok: true };
}

/** 직접 등록 응원팀은 실제 경기 참가팀 중 하나여야 한다. */
export function decideManualAttendanceTeam(
  value: unknown,
  venue: Pick<ResolvedVenue, "awayTeamId" | "homeTeamId">,
): ManualAttendanceTeamDecision {
  if (!Number.isInteger(value)) {
    return { ok: false, status: 400, error: "응원팀을 선택해주세요" };
  }
  const favoriteTeamId = value as number;
  if (
    favoriteTeamId !== venue.awayTeamId &&
    favoriteTeamId !== venue.homeTeamId
  ) {
    return { ok: false, status: 403, error: "이 경기의 참가팀만 선택할 수 있어요" };
  }
  return { ok: true, favoriteTeamId };
}
