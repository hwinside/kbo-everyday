import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import playersRoster from "@/lib/constants/players-roster.json";
import type { RosterPlayer } from "@/types/api";
import { resolvePlayer } from "@/lib/utils/resolve-player";

const KBO_BASE = "https://www.koreabaseball.com";
const CRON_SECRET = process.env.CRON_SECRET || "";

interface PlayerStat {
  rank: number;
  name: string;
  team: string;
  [key: string]: string | number;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: KBO_BASE,
    },
    next: { revalidate: 0 },
  });
  return res.text();
}

function parseTable(html: string): string[][] {
  const rows: string[][] = [];
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return rows;
  const trMatches = tbodyMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  if (!trMatches) return rows;
  for (const tr of trMatches) {
    const cells: string[] = [];
    const tdMatches = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (tdMatches) {
      for (const td of tdMatches) {
        cells.push(td.replace(/<[^>]+>/g, "").trim());
      }
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function fetchBatterStats(roster: RosterPlayer[]): Promise<PlayerStat[]> {
  // GAME_CN 정렬로 출장기록 있는 전체 타자 수집 (HRA_RT는 규정타석 충족자만 반환)
  return fetchHtml(`${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx?sort=GAME_CN`)
    .then((html) => parseTable(html))
    .then((rows) =>
      rows.map((c, i) => {
        const name = c[1] || "";
        const team = c[2] || "";
        const found = resolvePlayer({ name, team }, roster, { context: "cron/stats:batter" });
        return {
          rank: i + 1,
          name,
          team,
          avg: c[3] || ".000",
          games: parseInt(c[4]) || 0,
          pa: parseInt(c[5]) || 0,
          ab: parseInt(c[6]) || 0,
          runs: parseInt(c[7]) || 0,
          hits: parseInt(c[8]) || 0,
          doubles: parseInt(c[9]) || 0,
          triples: parseInt(c[10]) || 0,
          hr: parseInt(c[11]) || 0,
          tb: parseInt(c[12]) || 0,
          rbi: parseInt(c[13]) || 0,
          sac: parseInt(c[14]) || 0,
          sf: parseInt(c[15]) || 0,
          kboId: found?.kboId || "",
          playerId: found?.kboId || "",
        };
      }),
    );
}

function parsePitcherRow(c: string[], roster: RosterPlayer[]): PlayerStat {
  const name = c[1] || "";
  const team = c[2] || "";
  const found = resolvePlayer({ name, team }, roster, { context: "cron/stats:pitcher" });
  return {
    rank: 0,
    name,
    team,
    era: c[3] || "0.00",
    games: parseInt(c[4]) || 0,
    wins: parseInt(c[5]) || 0,
    losses: parseInt(c[6]) || 0,
    saves: parseInt(c[7]) || 0,
    holds: parseInt(c[8]) || 0,
    wpct: c[9] || "0.000",
    ip: c[10] || "0",
    h: parseInt(c[11]) || 0,
    hr: parseInt(c[12]) || 0,
    bb: parseInt(c[13]) || 0,
    hbp: parseInt(c[14]) || 0,
    so: parseInt(c[15]) || 0,
    r: parseInt(c[16]) || 0,
    er: parseInt(c[17]) || 0,
    whip: c[18] || "0.00",
    kboId: found?.kboId || "",
    playerId: found?.kboId || "",
  };
}

async function fetchPitcherStats(roster: RosterPlayer[]): Promise<PlayerStat[]> {
  const sortKeys = ["ERA_RT", "SV_CN", "HOLD_CN", "W_CN", "KK_CN", "GAME_CN", "INN2_CN", "HIT_CN", "BB_CN", "R_CN"];
  const merged = new Map<string, PlayerStat>();

  const results = await Promise.all(
    sortKeys.map(async (sort) => {
      const url = `${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx?sort=${sort}`;
      const html = await fetchHtml(url);
      return parseTable(html);
    }),
  );

  for (const rows of results) {
    for (const c of rows) {
      const name = c[1] || "";
      const team = c[2] || "";
      const key = `${name}::${team}`;
      if (!merged.has(key)) {
        merged.set(key, parsePitcherRow(c, roster));
      }
    }
  }

  const stats = [...merged.values()].sort(
    (a, b) => Number(a.era || 99) - Number(b.era || 99),
  );
  stats.forEach((p, i) => {
    p.rank = i + 1;
  });
  return stats;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const logId = await startJob("stats-update");
  const supabase = supabaseAdmin;
  const roster = playersRoster as RosterPlayer[];

  try {
    const [batters, pitchers] = await Promise.all([
      fetchBatterStats(roster),
      fetchPitcherStats(roster),
    ]);

    // Upsert to Supabase stats tables
    const { error: batterErr } = await supabase
      .from("player_stats_batter")
      .upsert(
        batters.map((b) => ({
          name: b.name,
          team: b.team,
          kbo_id: b.kboId,
          rank: b.rank,
          avg: b.avg,
          games: b.games,
          pa: b.pa,
          ab: b.ab,
          runs: b.runs,
          hits: b.hits,
          doubles: b.doubles,
          triples: b.triples,
          hr: b.hr,
          tb: b.tb,
          rbi: b.rbi,
          sac: b.sac,
          sf: b.sf,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "name,team" },
      );

    const { error: pitcherErr } = await supabase
      .from("player_stats_pitcher")
      .upsert(
        pitchers.map((p) => ({
          name: p.name,
          team: p.team,
          kbo_id: p.kboId,
          rank: p.rank,
          era: p.era,
          games: p.games,
          wins: p.wins,
          losses: p.losses,
          saves: p.saves,
          holds: p.holds,
          wpct: p.wpct,
          ip: p.ip,
          h: p.h,
          hr: p.hr,
          bb: p.bb,
          hbp: p.hbp,
          so: p.so,
          r: p.r,
          er: p.er,
          whip: p.whip,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "name,team" },
      );

    const dbErrors: string[] = [];
    if (batterErr) dbErrors.push(`batter: ${batterErr.message}`);
    if (pitcherErr) dbErrors.push(`pitcher: ${pitcherErr.message}`);

    const summary = `타자 ${batters.length}명, 투수 ${pitchers.length}명 수집`;

    if (dbErrors.length > 0) {
      await finishJob(logId, "error", summary, dbErrors.join("; "));
    } else {
      await finishJob(logId, "success", summary);
    }

    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      batters: batters.length,
      pitchers: pitchers.length,
      dbErrors: dbErrors.length > 0 ? dbErrors : undefined,
    });
  } catch (e) {
    await finishJob(logId, "error", undefined, (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
