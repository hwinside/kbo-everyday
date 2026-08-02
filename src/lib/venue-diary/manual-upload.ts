import type { ResolvedVenue } from "@/lib/venue-stories/venue-resolve";

export const VENUE_DIARY_MANUAL_SOURCE = "diary_manual" as const;
/**
 * 직접 추가 허용 시즌 SSOT. UI 시즌 칩·서버 게이트가 모두 이 배열을 쓴다(최신 시즌 우선).
 * 시즌을 늘릴 때 여기만 고치면 클라/서버가 같이 움직인다.
 */
export const VENUE_DIARY_MANUAL_SEASONS = [2026, 2025] as const;
export type VenueDiaryManualSeason = (typeof VENUE_DIARY_MANUAL_SEASONS)[number];
/** 기본 선택 시즌(=최신). 기존 단수 상수를 쓰던 곳의 호환 이름. */
export const VENUE_DIARY_MANUAL_SEASON = VENUE_DIARY_MANUAL_SEASONS[0];

export function isVenueDiaryManualSeason(
  season: number,
): season is VenueDiaryManualSeason {
  return (VENUE_DIARY_MANUAL_SEASONS as readonly number[]).includes(season);
}

/** `YYYY-MM-DD` 게임 날짜에서 허용 시즌을 판정. 형식이 어긋나면 null(fail-closed). */
export function manualSeasonOfGameDate(
  gameDate: string | null,
): VenueDiaryManualSeason | null {
  if (!gameDate || !/^\d{4}-\d{2}-\d{2}$/.test(gameDate)) return null;
  const year = Number(gameDate.slice(0, 4));
  return isVenueDiaryManualSeason(year) ? year : null;
}

export type ManualDiaryGameDecision =
  | { ok: true }
  | { ok: false; status: 403 | 404; error: string };

/**
 * 과거 경기 직접 추가는 허용 시즌(VENUE_DIARY_MANUAL_SEASONS)의 실제 KBO 종료 경기만 허용한다.
 * 시간 경과나 gameId 날짜만으로 종료를 추정하지 않고 crawler의 final 상태를 권위로 쓴다.
 */
export function decideManualDiaryGame(
  venue: Pick<ResolvedVenue, "exists" | "gameDate" | "status">,
): ManualDiaryGameDecision {
  if (!venue.exists || !venue.gameDate) {
    return { ok: false, status: 404, error: "경기를 확인할 수 없어요" };
  }
  if (manualSeasonOfGameDate(venue.gameDate) == null) {
    return {
      ok: false,
      status: 403,
      error: `${[...VENUE_DIARY_MANUAL_SEASONS]
        .slice()
        .sort((a, b) => a - b)
        .join("·")} 시즌 경기만 직접 추가할 수 있어요`,
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
