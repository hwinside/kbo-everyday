import { NextRequest, NextResponse } from "next/server";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const KBO_BASE = "https://www.koreabaseball.com";
const CRON_SECRET = process.env.CRON_SECRET || "";

const TEAMS: [string, string, number][] = [
  ["HT", "KIA", 6], ["OB", "두산", 2], ["LT", "롯데", 7],
  ["SS", "삼성", 8], ["SK", "SSG", 4], ["NC", "NC", 5],
  ["HH", "한화", 9], ["WO", "키움", 10], ["LG", "LG", 1], ["KT", "KT", 3],
];

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

function extractPlayerIds(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const pattern = /playerId=(\d+)[^>]*>\s*([^<]+)/g;
  let m;
  while ((m = pattern.exec(html)) !== null) {
    map.set(m[2].trim(), m[1]);
  }
  return map;
}

interface RosterPlayer {
  name: string;
  team: string;
  teamId: number;
  position: string;
  kboId: string;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const logId = await startJob("roster-update");
  const teamResults: Record<string, number> = {};

  try {
    const allPlayers: RosterPlayer[] = [];
    const seen = new Set<string>();

    // Batter page (default: top 30 by AVG, all teams mixed)
    const batterHtml = await fetchHtml(
      `${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx?sort=HRA_RT`,
    );
    const batterRows = parseTable(batterHtml);
    const batterIds = extractPlayerIds(batterHtml);

    for (const c of batterRows) {
      const name = c[1] || "";
      const team = c[2] || "";
      if (!name || !team) continue;
      const key = `${name}::${team}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allPlayers.push({
        name,
        team,
        teamId: TEAMS.find(([, t]) => t === team)?.[2] ?? 0,
        position: "야수",
        kboId: batterIds.get(name) || "",
      });
    }

    // Pitcher pages - multiple sort keys for broader coverage
    const pitcherSortKeys = ["ERA_RT", "SV_CN", "HOLD_CN", "W_CN", "KK_CN"];
    for (const sort of pitcherSortKeys) {
      const html = await fetchHtml(
        `${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx?sort=${sort}`,
      );
      const rows = parseTable(html);
      const ids = extractPlayerIds(html);

      for (const c of rows) {
        const name = c[1] || "";
        const team = c[2] || "";
        if (!name || !team) continue;
        const key = `${name}::${team}`;
        if (seen.has(key)) {
          const existing = allPlayers.find((p) => p.name === name && p.team === team);
          if (existing) existing.position = "투수";
          continue;
        }
        seen.add(key);
        allPlayers.push({
          name,
          team,
          teamId: TEAMS.find(([, t]) => t === team)?.[2] ?? 0,
          position: "투수",
          kboId: ids.get(name) || "",
        });
      }
    }

    // Count per team
    for (const p of allPlayers) {
      teamResults[p.team] = (teamResults[p.team] || 0) + 1;
    }
    const totalPlayers = allPlayers.length;

    // Upsert to Supabase players_roster table
    const playersWithId = allPlayers.filter((p) => p.kboId);
    let upsertCount = 0;
    if (playersWithId.length > 0) {
      const supabase = getSupabaseAdmin();
      const rows = playersWithId.map((p) => ({
        kbo_id: p.kboId,
        name: p.name,
        team: p.team,
        team_id: p.teamId,
        position: p.position,
        back_no: "",
        updated_at: new Date().toISOString(),
      }));
      const BATCH = 200;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const { error } = await supabase
          .from("players_roster")
          .upsert(batch, { onConflict: "kbo_id", ignoreDuplicates: false });
        if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
        upsertCount += batch.length;
      }
    }

    const summary = Object.entries(teamResults)
      .map(([t, n]) => `${t}:${n}`)
      .join(", ");

    await finishJob(logId, "success", `총 ${totalPlayers}명 수집, ${upsertCount}명 upsert (${summary})`);

    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      totalPlayers,
      upsertCount,
      teamResults,
    });
  } catch (e) {
    await finishJob(logId, "error", undefined, (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
