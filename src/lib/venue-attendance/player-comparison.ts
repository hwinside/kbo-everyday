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
export type PerformanceState = "rated" | "sample_limited" | "not_played" | "pending";

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

function didPlay(row: PlayerGameLog): boolean {
  return row.player_type === "pitcher"
    ? row.ip_outs > 0 || row.er > 0 || row.h_allowed > 0 || row.k > 0 || row.bb_allowed > 0
    : row.ab > 0 || row.h > 0 || row.hr > 0 || row.rbi > 0 || row.bb > 0 || row.so > 0;
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
    const todayMetric = rate([current], "batter");
    const averageMetric = rate(prior, "batter");

    return {
      type: "batter",
      state: enoughSample ? "rated" : "sample_limited",
      evaluation:
        enoughSample && todayMetric != null && averageMetric != null
          ? evaluateDelta(todayMetric - averageMetric)
          : null,
      priorAppearances: prior.length,
      metricLabel: "타율",
      todayMetric,
      averageMetric,
      today,
    };
  }

  const today = { ipOuts: current.ip_outs, er: current.er, strikeouts: current.k };
  const todayMetric = rate([current], "pitcher");
  const averageMetric = rate(prior, "pitcher");

  return {
    type: "pitcher",
    state: enoughSample ? "rated" : "sample_limited",
    evaluation:
      enoughSample && todayMetric != null && averageMetric != null
        ? evaluateDelta(averageMetric - todayMetric)
        : null,
    priorAppearances: prior.length,
    metricLabel: "ERA",
    todayMetric,
    averageMetric,
    today,
  };
}

/** 현재 최애선수 중 해당 경기 참가팀 선수만, 그 경기 이전 시즌 누적 타율/ERA와 비교한다. */
export function buildFavoritePlayerPerformances(params: {
  favorites: FavoritePlayerSnapshot[];
  logs: PlayerGameLog[];
  game: KboGame | null;
  gameLogReady: boolean;
}): FavoritePlayerPerformance[] {
  const { favorites, logs, game, gameLogReady } = params;
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
    const currentRows = (currentByPlayer.get(favorite.playerId) ?? []).filter(didPlay);
    if (!participatingTeams.has(favorite.teamId) && currentRows.length === 0) continue;

    if (game.status !== "final" || !gameLogReady) {
      result.push({ playerId: favorite.playerId, name: favorite.name, state: "pending", lines: [] });
      continue;
    }

    if (currentRows.length === 0) {
      result.push({ playerId: favorite.playerId, name: favorite.name, state: "not_played", lines: [] });
      continue;
    }

    const lines = currentRows.map((current) => {
      const prior = logs.filter(
        (log) =>
          log.kbo_id === favorite.playerId &&
          log.player_type === current.player_type &&
          didPlay(log) &&
          log.game_date < game.date.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
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
