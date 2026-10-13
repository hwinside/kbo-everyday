import type { KboGame } from "@/lib/crawler/kbo-api";
import { seriesLabel, postseasonGameLabel } from "@/lib/crawler/game-series";

export const POSTSEASON_STAGES = ["4", "3", "5", "7"] as const;
export interface Seed { rank: number; teamId: number; name: string }
export interface LadderRound {
  id: string; label: string; participants: { teamId: number; name: string; wins: number }[];
  placeholder: string; draws: number; winnerId: number | null;
  state: "waiting" | "scheduled" | "live" | "complete" | "changed";
  games: (KboGame & { displayLabel: string; notNeeded: boolean })[];
}
export interface LadderSnapshot { season: number; fetchedAt: number; rounds: LadderRound[]; currentStage: string; seeds: Seed[] }

/** Only completed scores count; the WC advantage is never added to actual wins. */
export function buildPostseasonLadder(season: number, games: KboGame[], seeds: Seed[], fetchedAt: number): LadderSnapshot {
  const valid = games.filter(g => g.gameId.startsWith(String(season)) && POSTSEASON_STAGES.includes(g.srId as typeof POSTSEASON_STAGES[number]));
  if (new Set(valid.map(g => g.gameId)).size !== valid.length) throw new Error("Duplicate postseason identity");
  const placeholders = ["4위 · 5위", "3위 · WC 승자", "2위 · 준PO 승자", "1위 · PO 승자"];
  const rounds = POSTSEASON_STAGES.map((id, index): LadderRound => {
    const stageGames = valid.filter(g => g.srId === id).sort((a,b) => a.gameId.localeCompare(b.gameId));
    const teams = new Map<number, { teamId: number; name: string; wins: number }>();
    for (const g of stageGames) {
      teams.set(g.awayTeamId, teams.get(g.awayTeamId) ?? { teamId: g.awayTeamId, name: g.awayName, wins: 0 });
      teams.set(g.homeTeamId, teams.get(g.homeTeamId) ?? { teamId: g.homeTeamId, name: g.homeName, wins: 0 });
    }
    if (teams.size > 2) throw new Error("Conflicting postseason participants");
    let draws = 0;
    for (const g of stageGames) {
      if (g.status !== "final") continue;
      if (!Number.isFinite(g.awayScore) || !Number.isFinite(g.homeScore) || g.awayScore! < 0 || g.homeScore! < 0) throw new Error("Missing final score");
      if (g.awayScore === g.homeScore) draws++;
      else teams.get(g.awayScore! > g.homeScore! ? g.awayTeamId : g.homeTeamId)!.wins++;
    }
    const participants = [...teams.values()];
    let winnerId: number | null = null;
    if (id === "4") {
      const fourth = seeds.find(s => s.rank === 4)?.teamId;
      const fifth = seeds.find(s => s.rank === 5)?.teamId;
      // Without verified seeds, do not guess the WC advantage from home/away.
      if (fourth && fifth && teams.has(fourth) && teams.has(fifth)) {
        if (teams.get(fourth)!.wins >= 1 || draws >= 1) winnerId = fourth;
        else if (teams.get(fifth)!.wins >= 2) winnerId = fifth;
      }
    } else winnerId = participants.find(t => t.wins >= (id === "7" ? 4 : 3))?.teamId ?? null;
    const state = winnerId ? "complete" : stageGames.some(g => g.status === "live") ? "live"
      : stageGames.some(g => g.status === "scheduled") ? "scheduled"
      : stageGames.some(g => g.status === "cancelled") ? "changed" : "waiting";
    const seedRank = [0,3,2,1][index];
    const seed = seeds.find(s => s.rank === seedRank);
    const placeholder = seed ? `${seed.name} · ${["", "WC", "준PO", "PO"][index]} 승자` : placeholders[index];
    return { id, label: seriesLabel(id), participants, placeholder, draws, winnerId, state,
      games: stageGames.map(g => ({ ...g, displayLabel: postseasonGameLabel(g.srId,g.gameLabel,g.status), notNeeded: !!winnerId && g.status === "scheduled" })) };
  });
  const current = rounds.find(r => r.state === "live") ?? rounds.find(r => r.state !== "complete" && r.games.length) ?? [...rounds].reverse().find(r => r.state === "complete") ?? rounds[0];
  return { season, fetchedAt, rounds, currentStage: current.id, seeds };
}
