import { resolveTeamId } from "@/lib/crawler/kbo-api";
import { getTeamById } from "@/lib/constants/teams";
import type { Seed } from "./ladder";

export async function loadPostseasonSeeds(season: number): Promise<Seed[]> {
  try {
    const response = await fetch(`https://api-gw.sports.naver.com/statistics/categories/kbo/seasons/${season}/teams?gameType=REGULAR_SEASON`, {
      headers: { Referer: "https://sports.news.naver.com/" }, signal: AbortSignal.timeout(2500), cache: "no-store",
    });
    if (!response.ok) return [];
    const body = await response.json();
    const rows = body?.success === true ? body.result?.seasonTeamStats : null;
    if (!Array.isArray(rows) || rows.length !== 10) return [];
    const seeds: Seed[] = rows.map((r: { ranking: number; teamId: string; gameCount: number }) => {
      if (r.gameCount !== 144) throw new Error("Regular standings not final");
      const teamId = resolveTeamId(r.teamId, "");
      const name = getTeamById(teamId)?.shortName;
      if (!name || !Number.isInteger(r.ranking) || r.ranking < 1 || r.ranking > 10) throw new Error("Invalid final standings");
      return { rank: r.ranking, teamId, name };
    });
    if (new Set(seeds.map(s=>s.rank)).size !== 10 || new Set(seeds.map(s=>s.teamId)).size !== 10) return [];
    return seeds.filter(s=>s.rank <= 5);
  } catch { return []; }
}
