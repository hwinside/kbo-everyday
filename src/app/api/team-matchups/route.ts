import { NextRequest, NextResponse } from "next/server";
import { getSeasonGames } from "@/lib/crawler/season-games-cache";
import { TEAMS } from "@/lib/constants/teams";
import { aggregateMatchups } from "@/lib/team/matchup-aggregate";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const teamSlug = searchParams.get("team");
  const seasonParam = searchParams.get("season") ?? "2026";
  const season = parseInt(seasonParam, 10);

  if (!teamSlug) {
    return NextResponse.json({ error: "team (slug) is required" }, { status: 400 });
  }

  const team = TEAMS.find((t) => t.slug === teamSlug);
  if (!team) {
    return NextResponse.json({ error: "Unknown team slug" }, { status: 404 });
  }

  try {
    const allGames = await getSeasonGames(season);

    // 정규시즌(srId 0)만 집계 — KBO API가 요청 srId 필터를 무시해 시범경기가 섞이던 버그 fix
    // (2026-07-21 #cs 제보: 롯데 47승49패 표시 vs 실제 정규 39승47패)
    const { byOpponent, total: agg } = aggregateMatchups(allGames, team.id);

    const opponents = TEAMS.filter((t) => t.id !== team.id).map((opp) => {
      const rec = byOpponent.get(opp.id) ?? { wins: 0, losses: 0, draws: 0 };
      const played = rec.wins + rec.losses;
      return {
        slug: opp.slug,
        name: opp.name,
        shortName: opp.shortName,
        wins: rec.wins,
        losses: rec.losses,
        draws: rec.draws,
        winPct: played > 0 ? rec.wins / played : 0,
      };
    });

    const totalPlayed = agg.wins + agg.losses;
    const total = {
      wins: agg.wins,
      losses: agg.losses,
      draws: agg.draws,
      winRate: totalPlayed > 0 ? agg.wins / totalPlayed : 0,
    };

    return NextResponse.json(
      { team: teamSlug, season, total, opponents },
      { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1200" } }
    );
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
