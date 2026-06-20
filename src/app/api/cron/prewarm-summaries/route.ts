import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchGames, fetchBoxScore } from "@/lib/crawler/kbo-api";
import { TEAMS } from "@/lib/constants/teams";

const CRON_SECRET = process.env.CRON_SECRET || "";
const PROMPT_VERSION = 12; // must match game-summary route

// ===== Helpers =====

function getKSTDateStr(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
}

function teamShortName(teamId: number): string {
  return TEAMS.find((t) => t.id === teamId)?.shortName || `팀${teamId}`;
}

// KBO ScoreBoard API for linescore
const KBO_BASE = "https://www.koreabaseball.com";
const HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: KBO_BASE,
};

interface LinescoreSide {
  innings: (number | null)[];
  R: number;
  H: number;
  E: number;
}

async function fetchLinescore(gameId: string): Promise<{ away: LinescoreSide; home: LinescoreSide } | null> {
  try {
    const seasonId = gameId.slice(0, 4);
    const body = `leId=1&srId=0&seasonId=${seasonId}&gameId=${gameId}`;
    const res = await fetch(`${KBO_BASE}/GetScoreBoard`, {
      method: "POST",
      headers: HEADERS,
      body,
      next: { revalidate: 0 },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length < 2 || !data[1]) return null;

    const raw = Array.isArray(data[1]) && data[1].length > 0 ? data[1][0] : data[1];
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed?.rows || parsed.rows.length < 2) return null;

    function parseRow(row: { Text: string }[]): LinescoreSide {
      // row: [team, inn1, inn2, ..., R, H, E]
      const cells = row.map((c) => c.Text?.trim());
      const R = parseInt(cells[cells.length - 3] || "0") || 0;
      const H = parseInt(cells[cells.length - 2] || "0") || 0;
      const E = parseInt(cells[cells.length - 1] || "0") || 0;
      const innings = cells.slice(1, cells.length - 3).map((v) => {
        if (!v || v === "-" || v === "&nbsp;") return null;
        const n = parseInt(v);
        return isNaN(n) ? null : n;
      });
      return { innings, R, H, E };
    }

    return {
      away: parseRow(parsed.rows[0].row),
      home: parseRow(parsed.rows[1].row),
    };
  } catch {
    return null;
  }
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

    // 2. Check which games already have current-version cache
    const gameIds = finalGames.map((g) => g.gameId);
    const { data: cached } = await supabaseAdmin
      .from("game_summaries")
      .select("game_id, prompt_version")
      .in("game_id", gameIds);

    const cachedMap = new Map((cached ?? []).map((c) => [c.game_id, c.prompt_version]));

    // 3. Pre-warm missing/outdated summaries
    const appUrl =
      process.env.NEXT_PUBLIC_BASE_URL ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://keubo.fan");

    for (const game of finalGames) {
      const cachedVersion = cachedMap.get(game.gameId);
      if (cachedVersion != null && cachedVersion >= PROMPT_VERSION) {
        results.push({ gameId: game.gameId, status: "skip", reason: "cache current" });
        continue;
      }

      // Fetch boxscore + linescore
      const [boxScore, linescore] = await Promise.all([
        fetchBoxScore(game.gameId),
        fetchLinescore(game.gameId),
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

        if (res.ok) {
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
