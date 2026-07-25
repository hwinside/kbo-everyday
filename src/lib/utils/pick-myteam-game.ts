/**
 * MY TEAM 오늘 경기를 경기 탭 상단 우선 카드로 고를 때의 선택 규칙.
 *
 * 더블헤더처럼 하루에 MY TEAM 경기가 여러 개면, 배열 첫 경기가 아니라
 * 상태 우선순위(live > scheduled > final > cancelled)로 가장 의미있는 경기를 고른다.
 * (예: 1차전 final → 2차전 live 순서면 진행 중인 2차전을 상단에 노출)
 * 동일 우선순위면 배열 순서(=경기 시간 순)를 유지한다.
 */
export type MyTeamGameStatus = "scheduled" | "live" | "final" | "cancelled";

export interface MyTeamGameLike {
  awayTeamId: number;
  homeTeamId: number;
  status: MyTeamGameStatus;
}

const STATUS_PRIORITY: Record<MyTeamGameStatus, number> = {
  live: 0,
  scheduled: 1,
  final: 2,
  cancelled: 3,
};

export function pickMyTeamPriorityGame<T extends MyTeamGameLike>(
  games: T[],
  myTeamId: number | null,
): T | null {
  if (myTeamId == null) return null;
  const mine = games.filter(
    (g) => g.awayTeamId === myTeamId || g.homeTeamId === myTeamId,
  );
  if (mine.length === 0) return null;
  // reduce 는 엄격 부등호(<)만 쓰므로 동일 우선순위에서는 먼저 나온 경기가 유지된다(안정 선택).
  return mine.reduce((best, g) =>
    (STATUS_PRIORITY[g.status] ?? 9) < (STATUS_PRIORITY[best.status] ?? 9) ? g : best,
  );
}
