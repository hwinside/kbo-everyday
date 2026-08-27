import { NextRequest, NextResponse } from "next/server";
import { fetchGames, fetchBoxScore, fetchGameLinescore } from "@/lib/crawler/kbo-api";
import { TEAMS } from "@/lib/constants/teams";

const CRON_SECRET = process.env.CRON_SECRET || "";

// ===== Helpers =====

function getKSTDateStr(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
}

function teamShortName(teamId: number): string {
  return TEAMS.find((t) => t.id === teamId)?.shortName || `팀${teamId}`;
}

// ===== Main =====

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? "";
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const todayKbo = getKSTDateStr();
  const results: { gameId: string; status: string; reason: string }[] = [];

  try {
    // 1. Fetch today's games
    const games = await fetchGames(todayKbo);
    const finalGames = games.filter((g) => g.status === "final");

    if (finalGames.length === 0) {
      return NextResponse.json({ ok: true, message: "No final games today", results });
    }

    // 2. 모든 종료 경기를 POST한다. API가 prompt version+fingerprint가 current면 즉시 cache를
    // 반환하고, legacy/stale이면 재생성한다(버전만 보고 skip하면 legacy가 영구 잔존).
    const appUrl =
      process.env.NEXT_PUBLIC_BASE_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://keubo.fan");

    for (const game of finalGames) {
      // Fetch boxscore + linescore
      const [boxScore, linescore] = await Promise.all([
        fetchBoxScore(game.gameId),
        fetchGameLinescore(game.gameId),
      ]);

      if (!boxScore) {
        results.push({ gameId: game.gameId, status: "skip", reason: "no boxscore" });
        continue;
      }

      const totalAB = [...boxScore.awayBatters, ...boxScore.homeBatters].reduce(
        (s, b) => s + b.atBats, 0
      );
      if (totalAB === 0) {
        results.push({ gameId: game.gameId, status: "skip", reason: "totalAB=0" });
        continue;
      }

      // Build payload matching BoxScoreInput
      const payload = {
        gameId: game.gameId,
        awayTeam: teamShortName(game.awayTeamId),
        homeTeam: teamShortName(game.homeTeamId),
        awayScore: linescore?.away.R ?? game.awayScore ?? 0,
        homeScore: linescore?.home.R ?? game.homeScore ?? 0,
        linescore: linescore
          ? {
              away: { innings: linescore.away.innings, R: linescore.away.R, H: linescore.away.H, E: linescore.away.E },
              home: { innings: linescore.home.innings, R: linescore.home.R, H: linescore.home.H, E: linescore.home.E },
            }
          : undefined,
        awayBatters: boxScore.awayBatters.map((b) => ({
          name: b.name, ab: b.atBats, r: b.runs, h: b.hits,
          rbi: b.rbi, hr: b.hr, bb: b.bb, so: b.so, avg: b.avg || "",
        })),
        homeBatters: boxScore.homeBatters.map((b) => ({
          name: b.name, ab: b.atBats, r: b.runs, h: b.hits,
          rbi: b.rbi, hr: b.hr, bb: b.bb, so: b.so, avg: b.avg || "",
        })),
        awayPitchers: boxScore.awayPitchers.map((p) => ({
          name: p.name, ip: p.inningsPitched, h: p.hits, r: p.runs,
          er: p.earnedRuns, bb: p.walks, so: p.strikeouts, hr: p.hr,
          np: p.pitchCount, result: p.decision || undefined,
        })),
        homePitchers: boxScore.homePitchers.map((p) => ({
          name: p.name, ip: p.inningsPitched, h: p.hits, r: p.runs,
          er: p.earnedRuns, bb: p.walks, so: p.strikeouts, hr: p.hr,
          np: p.pitchCount, result: p.decision || undefined,
        })),
      };

      try {
        const res = await fetch(`${appUrl}/api/game-summary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (res.status === 202) {
          results.push({ gameId: game.gameId, status: "pending", reason: "generation in flight" });
        } else if (res.ok) {
          results.push({ gameId: game.gameId, status: "generated", reason: "ok" });
        } else {
          const err = await res.text().catch(() => "unknown");
          results.push({ gameId: game.gameId, status: "error", reason: `${res.status}: ${err.slice(0, 100)}` });
        }
      } catch (e) {
        results.push({
          gameId: game.gameId,
          status: "error",
          reason: (e as Error).message?.slice(0, 100) || "fetch failed",
        });
      }
    }

    return NextResponse.json({ ok: true, total: finalGames.length, results });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }
}
