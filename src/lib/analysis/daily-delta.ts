import type { KboGame, TeamStanding } from "@/lib/crawler/kbo-api";

// ===== Types =====

export interface StandingsSnapshot {
  date: string;
  team_id: number;
  rank: number;
  wins: number;
  losses: number;
  draws: number;
  win_rate: number;
  games_behind: number;
  streak: string | null;
}

export interface StatsSnapshotRow {
  date: string;
  category: string;
  rank: number;
  player_name: string;
  team: string;
  value: number;
}

// ===== Standings Delta =====

export interface TeamDelta {
  team_id: number;
  rankChange: number; // positive = moved up
  gamesBehindChange: number;
  oldRank: number;
  newRank: number;
  wins: number;
  losses: number;
  draws: number;
  win_rate: number;
  games_behind: number;
  streak: string | null;
}

export interface StandingsDelta {
  date: string;
  top: TeamDelta[];    // 1~3위
  mid: TeamDelta[];    // 4~7위
  bottom: TeamDelta[]; // 8~10위
  summary: string;
}

export function computeStandingsDelta(
  today: StandingsSnapshot[],
  yesterday: StandingsSnapshot[],
): StandingsDelta {
  const yesterdayMap = new Map(yesterday.map((s) => [s.team_id, s]));
  const deltas: TeamDelta[] = [];

  for (const t of today) {
    const y = yesterdayMap.get(t.team_id);
    deltas.push({
      team_id: t.team_id,
      rankChange: y ? y.rank - t.rank : 0,
      gamesBehindChange: y ? y.games_behind - t.games_behind : 0,
      oldRank: y?.rank ?? t.rank,
      newRank: t.rank,
      wins: t.wins,
      losses: t.losses,
      draws: t.draws,
      win_rate: t.win_rate,
      games_behind: t.games_behind,
      streak: t.streak,
    });
  }

  deltas.sort((a, b) => a.newRank - b.newRank);

  const movedTeams = deltas.filter((d) => d.rankChange !== 0);
  const summary = movedTeams.length > 0
    ? `${movedTeams.length}개 팀 순위 변동`
    : "순위 변동 없음";

  return {
    date: today[0]?.date ?? "",
    top: deltas.filter((d) => d.newRank <= 3),
    mid: deltas.filter((d) => d.newRank >= 4 && d.newRank <= 7),
    bottom: deltas.filter((d) => d.newRank >= 8),
    summary,
  };
}

// ===== Titles Delta =====

export interface CategoryDelta {
  category: string;
  leaderChanged: boolean;
  oldLeader: { player_name: string; team: string; value: number } | null;
  newLeader: { player_name: string; team: string; value: number };
  top5: {
    player_name: string;
    team: string;
    value: number;
    rankChange: number;
    valueChange: number;
  }[];
}

export interface TitlesDelta {
  date: string;
  categories: CategoryDelta[];
  summary: string;
}

export function computeTitlesDelta(
  today: StatsSnapshotRow[],
  yesterday: StatsSnapshotRow[],
): TitlesDelta {
  const categories = [...new Set(today.map((s) => s.category))];
  const results: CategoryDelta[] = [];

  for (const cat of categories) {
    const todayRows = today.filter((s) => s.category === cat).sort((a, b) => a.rank - b.rank);
    const yesterdayRows = yesterday.filter((s) => s.category === cat);
    const yesterdayMap = new Map(yesterdayRows.map((s) => [`${s.player_name}::${s.team}`, s]));

    const newLeaderRow = todayRows[0];
    if (!newLeaderRow) continue;

    const oldLeaderRow = yesterdayRows.find((s) => s.rank === 1) ?? null;
    const leaderChanged = oldLeaderRow
      ? oldLeaderRow.player_name !== newLeaderRow.player_name || oldLeaderRow.team !== newLeaderRow.team
      : false;

    const top5 = todayRows.slice(0, 5).map((row) => {
      const yRow = yesterdayMap.get(`${row.player_name}::${row.team}`);
      return {
        player_name: row.player_name,
        team: row.team,
        value: row.value,
        rankChange: yRow ? yRow.rank - row.rank : 0,
        valueChange: yRow ? row.value - yRow.value : 0,
      };
    });

    results.push({
      category: cat,
      leaderChanged,
      oldLeader: oldLeaderRow ? { player_name: oldLeaderRow.player_name, team: oldLeaderRow.team, value: oldLeaderRow.value } : null,
      newLeader: { player_name: newLeaderRow.player_name, team: newLeaderRow.team, value: newLeaderRow.value },
      top5,
    });
  }

  const changedLeaders = results.filter((r) => r.leaderChanged);
  const summary = changedLeaders.length > 0
    ? `${changedLeaders.map((r) => r.category).join(", ")} 1위 교체`
    : "타이틀 1위 변동 없음";

  return { date: today[0]?.date ?? "", categories: results, summary };
}

// ===== Streak Calculation =====

export function computeStreak(
  teamId: number,
  games: KboGame[],
  previousStreak: string | null,
): string {
  const teamGames = games.filter(
    (g) => g.status === "final" && (g.awayTeamId === teamId || g.homeTeamId === teamId),
  );

  if (teamGames.length === 0) return previousStreak ?? "-";

  const results: ("W" | "L" | "D")[] = [];
  for (const g of teamGames) {
    const isAway = g.awayTeamId === teamId;
    const myScore = isAway ? (g.awayScore ?? 0) : (g.homeScore ?? 0);
    const opScore = isAway ? (g.homeScore ?? 0) : (g.awayScore ?? 0);
    if (myScore > opScore) results.push("W");
    else if (myScore < opScore) results.push("L");
    else results.push("D");
  }

  const lastResult = results[results.length - 1];
  if (lastResult === "D") return "무";

  const prevCount = parseStreakCount(previousStreak);
  const prevType = previousStreak?.includes("연승") ? "W" : previousStreak?.includes("연패") ? "L" : null;

  if (prevType === lastResult) {
    const count = prevCount + results.filter((r) => r === lastResult).length;
    return lastResult === "W" ? `${count}연승` : `${count}연패`;
  }

  const count = results.filter((r) => r === lastResult).length;
  return lastResult === "W" ? `${count}연승` : `${count}연패`;
}

function parseStreakCount(streak: string | null): number {
  if (!streak) return 0;
  const m = streak.match(/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

// ===== Game Events Extraction =====

export interface GameEvent {
  gameId: string;
  awayTeam: string;
  homeTeam: string;
  awayScore: number;
  homeScore: number;
  winPitcher: string;
  losePitcher: string;
  savePitcher: string;
  isBlowout: boolean;
  scoreDiff: number;
}

export function extractGameEvents(games: KboGame[]): GameEvent[] {
  return games
    .filter((g) => g.status === "final")
    .map((g) => {
      const awayScore = g.awayScore ?? 0;
      const homeScore = g.homeScore ?? 0;
      const diff = Math.abs(awayScore - homeScore);
      return {
        gameId: g.gameId,
        awayTeam: g.awayName,
        homeTeam: g.homeName,
        awayScore,
        homeScore,
        winPitcher: g.winPitcher,
        losePitcher: g.losePitcher,
        savePitcher: g.savePitcher,
        isBlowout: diff >= 5,
        scoreDiff: diff,
      };
    });
}
