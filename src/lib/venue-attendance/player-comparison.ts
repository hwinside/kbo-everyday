import type { KboGame } from "@/lib/crawler/kbo-api";

export interface FavoritePlayerSnapshot {
  playerId: string;
  name: string;
  teamId: number;
  position?: string;
}

export interface PlayerGameLog {
  kbo_id: string;
  player_type: "batter" | "pitcher";
  game_id: string;
  game_date: string;
  team_id: number;
  ab: number;
  h: number;
  hr: number;
  rbi: number;
  bb: number;
  so: number;
  ip_outs: number;
  er: number;
  h_allowed: number;
  k: number;
  bb_allowed: number;
}

export type PerformanceEvaluation = "above" | "similar" | "below";
export type PerformanceState = "rated" | "sample_limited" | "pending";

export interface PlayerPerformanceLine {
  type: "batter" | "pitcher";
  state: "rated" | "sample_limited";
  evaluation: PerformanceEvaluation | null;
  priorAppearances: number;
  metricLabel: "타율" | "ERA";
  todayMetric: number | null;
  averageMetric: number | null;
  today: {
    ab?: number;
    h?: number;
    hr?: number;
    rbi?: number;
    ipOuts?: number;
    er?: number;
    strikeouts?: number;
  };
  average: {
    ab?: number;
    h?: number;
    hr?: number;
    rbi?: number;
    innings?: number;
    er?: number;
    strikeouts?: number;
  } | null;
}

export interface FavoritePlayerPerformance {
  playerId: string;
  name: string;
  state: PerformanceState;
  lines: PlayerPerformanceLine[];
}

function evaluateDelta(delta: number): PerformanceEvaluation {
  if (delta > 0.0005) return "above";
  if (delta < -0.0005) return "below";
  return "similar";
}

function average(rows: PlayerGameLog[], field: keyof PlayerGameLog): number {
  return rows.reduce((sum, row) => sum + Number(row[field] ?? 0), 0) / rows.length;
}

function rate(rows: PlayerGameLog[], type: "batter" | "pitcher"): number | null {
  if (type === "pitcher") {
    const outs = rows.reduce((sum, row) => sum + row.ip_outs, 0);
    const earnedRuns = rows.reduce((sum, row) => sum + row.er, 0);
    return outs > 0 ? (earnedRuns * 27) / outs : null;
  }
  const atBats = rows.reduce((sum, row) => sum + row.ab, 0);
  const hits = rows.reduce((sum, row) => sum + row.h, 0);
  return atBats > 0 ? hits / atBats : null;
}

function buildLine(
  current: PlayerGameLog,
  prior: PlayerGameLog[],
): PlayerPerformanceLine {
  const enoughSample = prior.length >= 3;

  if (current.player_type === "batter") {
    const today = { ab: current.ab, h: current.h, hr: current.hr, rbi: current.rbi };
    const priorAverage = enoughSample
      ? {
          ab: average(prior, "ab"),
          h: average(prior, "h"),
          hr: average(prior, "hr"),
          rbi: average(prior, "rbi"),
        }
      : null;
    const todayMetric = rate([current], "batter");
    const averageMetric = rate(prior, "batter");

    return {
      type: "batter",
      state: enoughSample ? "rated" : "sample_limited",
      evaluation:
        priorAverage && todayMetric != null && averageMetric != null
          ? evaluateDelta(todayMetric - averageMetric)
          : null,
      priorAppearances: prior.length,
      metricLabel: "타율",
      todayMetric,
      averageMetric,
      today,
      average: priorAverage,
    };
  }

  const today = { ipOuts: current.ip_outs, er: current.er, strikeouts: current.k };
  const priorAverage = enoughSample
    ? {
        innings: average(prior, "ip_outs") / 3,
        er: average(prior, "er"),
        strikeouts: average(prior, "k"),
      }
      : null;
  const todayMetric = rate([current], "pitcher");
  const averageMetric = rate(prior, "pitcher");

  return {
    type: "pitcher",
    state: enoughSample ? "rated" : "sample_limited",
    evaluation:
      priorAverage && todayMetric != null && averageMetric != null
        ? evaluateDelta(averageMetric - todayMetric)
        : null,
    priorAppearances: prior.length,
    metricLabel: "ERA",
    todayMetric,
    averageMetric,
    today,
    average: priorAverage,
  };
}

/** 현재 최애선수 중 해당 경기 참가팀 선수만, 그 경기 이전 시즌 경기당 평균과 비교한다. */
export function buildFavoritePlayerPerformances(params: {
  favorites: FavoritePlayerSnapshot[];
  logs: PlayerGameLog[];
  game: KboGame | null;
  logsReady: boolean;
}): FavoritePlayerPerformance[] {
  const { favorites, logs, game, logsReady } = params;
  if (!game) return [];

  const participatingTeams = new Set([game.awayTeamId, game.homeTeamId]);
  const currentByPlayer = new Map<string, PlayerGameLog[]>();
  for (const log of logs) {
    if (log.game_id !== game.gameId) continue;
    const list = currentByPlayer.get(log.kbo_id) ?? [];
    list.push(log);
    currentByPlayer.set(log.kbo_id, list);
  }

  const result: FavoritePlayerPerformance[] = [];
  for (const favorite of favorites) {
    const currentRows = currentByPlayer.get(favorite.playerId) ?? [];
    if (!participatingTeams.has(favorite.teamId) && currentRows.length === 0) continue;

    if (game.status !== "final" || !logsReady) {
      result.push({ playerId: favorite.playerId, name: favorite.name, state: "pending", lines: [] });
      continue;
    }

    // 경기 단위 완전 적재 신호가 없으므로 행 부재를 미출전으로 단정하지 않는다.
    // resolvePlayer 누락/부분 적재일 수 있어 안전하게 확인 중을 유지한다.
    if (currentRows.length === 0) {
      result.push({ playerId: favorite.playerId, name: favorite.name, state: "pending", lines: [] });
      continue;
    }

    const lines = currentRows.map((current) => {
      const targetDate = game.date.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
      const prior = logs.filter(
        (log) =>
          log.kbo_id === favorite.playerId &&
          log.player_type === current.player_type &&
          (log.game_date < targetDate ||
            (log.game_date === targetDate && log.game_id < game.gameId)),
      );
      return buildLine(current, prior);
    });
    result.push({
      playerId: favorite.playerId,
      name: favorite.name,
      state: lines.every((line) => line.state === "rated") ? "rated" : "sample_limited",
      lines,
    });
  }

  return result;
}
