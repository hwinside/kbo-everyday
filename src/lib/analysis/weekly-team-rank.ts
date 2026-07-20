/**
 * 주간 팀 타율/방어율의 "같은 주차·10구단 competition ranking".
 *
 * 팀카드 그래프는 최신 *주간* 집계인데 괄호 순위를 `/api/team-records`(시즌 누적)에서 붙이면
 * timebase가 어긋나 "그래프는 우상향인데 순위는 하락"이 재발한다(삼순 #728 NO-GO).
 * → 괄호 순위를 그래프와 같은 주차·같은 10구단 주간 집계에서 competition ranking(동률 1,2,2,4)으로 산출.
 */
export interface WeekGameLogRow {
  team_id: number;
  ab: number;
  h: number;
  ip_outs: number;
  er: number;
}

/** value 기준 competition ranking(동률 같은 순위: 1,2,2,4). higherIsBetter=true면 큰 값이 1위. */
export function competitionRank(
  entries: { teamId: number; value: number }[],
  higherIsBetter: boolean,
): Map<number, number> {
  const sorted = [...entries].sort((a, b) =>
    higherIsBetter ? b.value - a.value : a.value - b.value,
  );
  const map = new Map<number, number>();
  let rank = 1;
  sorted.forEach((e, i) => {
    if (i > 0 && e.value !== sorted[i - 1].value) rank = i + 1;
    map.set(e.teamId, rank);
  });
  return map;
}

/** 한 주차 로그 → 팀별 타율(h/ab) competition rank (ab>0 팀만). */
export function weeklyBattingRankMap(rows: WeekGameLogRow[]): Map<number, number> {
  const agg = new Map<number, { ab: number; h: number }>();
  for (const r of rows) {
    const e = agg.get(r.team_id) ?? { ab: 0, h: 0 };
    e.ab += Number(r.ab) || 0;
    e.h += Number(r.h) || 0;
    agg.set(r.team_id, e);
  }
  const entries = [...agg.entries()]
    .filter(([, e]) => e.ab > 0)
    .map(([teamId, e]) => ({ teamId, value: e.h / e.ab }));
  return competitionRank(entries, true);
}

/** 한 주차 로그 → 팀별 방어율((er*27)/outs) competition rank (outs>0 팀만, 낮을수록 1위). */
export function weeklyPitchingRankMap(rows: WeekGameLogRow[]): Map<number, number> {
  const agg = new Map<number, { outs: number; er: number }>();
  for (const r of rows) {
    const e = agg.get(r.team_id) ?? { outs: 0, er: 0 };
    e.outs += Number(r.ip_outs) || 0;
    e.er += Number(r.er) || 0;
    agg.set(r.team_id, e);
  }
  const entries = [...agg.entries()]
    .filter(([, e]) => e.outs > 0)
    .map(([teamId, e]) => ({ teamId, value: (e.er * 27) / e.outs }));
  return competitionRank(entries, false);
}
