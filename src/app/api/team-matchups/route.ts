import { NextRequest, NextResponse } from "next/server";
import { getSeasonGames } from "@/lib/crawler/season-games-cache";
import { TEAMS } from "@/lib/constants/teams";

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
    // 정규시즌(srId=0)만 집계 — 시범경기(SR=1)·올스타(SR=9)·포스트시즌이 섞이면
    // 상대전적 합계가 공식 순위표와 어긋난다 (2026-07-21 CS: 롯데 47승49패 오표시)
    const allGames = await getSeasonGames(season, "0");

    // Only final games involving this team
    const teamGames = allGames.filter(
      (g) =>
        g.status === "final" &&
        (g.awayTeamId === team.id || g.homeTeamId === team.id)
    );

    // Aggregate W/L/D per opponent
    const byOpponent = new Map<number, { wins: number; losses: number; draws: number }>();

    for (const g of teamGames) {
      const isHome = g.homeTeamId === team.id;
      const oppId = isHome ? g.awayTeamId : g.homeTeamId;
      const myScore = isHome ? g.homeScore : g.awayScore;
      const oppScore = isHome ? g.awayScore : g.homeScore;

      if (myScore === null || oppScore === null) continue;

      const rec = byOpponent.get(oppId) ?? { wins: 0, losses: 0, draws: 0 };
      if (myScore > oppScore) rec.wins++;
      else if (myScore < oppScore) rec.losses++;
      else rec.draws++;
      byOpponent.set(oppId, rec);
    }

    let totalWins = 0, totalLosses = 0, totalDraws = 0;

    const opponents = TEAMS.filter((t) => t.id !== team.id).map((opp) => {
      const rec = byOpponent.get(opp.id) ?? { wins: 0, losses: 0, draws: 0 };
      totalWins += rec.wins;
      totalLosses += rec.losses;
      totalDraws += rec.draws;
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

    const totalPlayed = totalWins + totalLosses;
    const total = {
      wins: totalWins,
      losses: totalLosses,
      draws: totalDraws,
      winRate: totalPlayed > 0 ? totalWins / totalPlayed : 0,
    };

    return NextResponse.json(
      { team: teamSlug, season, total, opponents },
      { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1200" } }
    );
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
