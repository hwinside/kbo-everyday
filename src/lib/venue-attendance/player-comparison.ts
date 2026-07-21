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

function evaluateDelta(delta: number, baseline: number): PerformanceEvaluation {
  const similarBand = Math.max(0.5, Math.abs(baseline) * 0.15);
  if (delta > similarBand) return "above";
  if (delta < -similarBand) return "below";
  return "similar";
}

function didPlay(row: PlayerGameLog): boolean {
  return row.player_type === "pitcher"
    ? row.ip_outs > 0 || row.er > 0 || row.h_allowed > 0 || row.k > 0 || row.bb_allowed > 0
    : row.ab > 0 || row.h > 0 || row.hr > 0 || row.rbi > 0 || row.bb > 0 || row.so > 0;
}

function average(rows: PlayerGameLog[], field: keyof PlayerGameLog): number {
  return rows.reduce((sum, row) => sum + Number(row[field] ?? 0), 0) / rows.length;
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
    const todayImpact = current.h + current.hr * 2 + current.rbi * 0.5;
    const averageImpact = priorAverage
      ? priorAverage.h + priorAverage.hr * 2 + priorAverage.rbi * 0.5
      : 0;

    return {
      type: "batter",
      state: enoughSample ? "rated" : "sample_limited",
      evaluation: priorAverage
        ? evaluateDelta(todayImpact - averageImpact, averageImpact)
        : null,
      priorAppearances: prior.length,
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
  const todayImpact = current.ip_outs / 3 + current.k * 0.75 - current.er * 1.5;
  const averageImpact = priorAverage
    ? priorAverage.innings + priorAverage.strikeouts * 0.75 - priorAverage.er * 1.5
    : 0;

  return {
    type: "pitcher",
    state: enoughSample ? "rated" : "sample_limited",
    evaluation: priorAverage
      ? evaluateDelta(todayImpact - averageImpact, averageImpact)
      : null,
    priorAppearances: prior.length,
    today,
    average: priorAverage,
  };
}

/** 현재 최애선수 중 해당 경기 참가팀 선수만, 그 경기 이전 시즌 경기당 평균과 비교한다. */
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
