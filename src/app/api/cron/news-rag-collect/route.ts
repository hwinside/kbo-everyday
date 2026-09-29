import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { TEAMS } from "@/lib/constants/teams";
import { collectYesterdayCandidates, type RawCandidateSink } from "@/lib/news-clipping";
import { mapWithConcurrency } from "@/lib/naver-news";
import { toNewsArticleRows } from "@/lib/baseball-qa/rag/news-articles";
import { ingestNewsArticles, type TeamCollection } from "@/lib/baseball-qa/rag/news-ingest";
import { newsCollectionWindow } from "@/lib/baseball-qa/rag/news-collection-window";

// Independent from DM delivery: no Gemini selection, OG lookup, or send path.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: "missing_config" }, { status: 500 });
  const window = newsCollectionWindow(req.nextUrl.searchParams.get("period"));
  if (!window) return NextResponse.json({ error: "invalid_period" }, { status: 400 });
  const { clipDate, articleDate, period, coverageDetail } = window;
  const deadline = Date.now() + 180_000;
  const collections = new Map<number, TeamCollection>(TEAMS.map((t) => [t.id, {
    teamId: t.id, rows: [], truncated: false, pagesFetched: 0, error: "not_collected", coverageDetail,
  }]));
  const collectRaw: RawCandidateSink = (teamId, items, meta) => {
    collections.set(teamId, { teamId, rows: toNewsArticleRows(items, teamId), ...meta, coverageDetail });
  };
  await mapWithConcurrency(TEAMS, 1, async (team) => {
    try {
      // The shared collector filters by the supplied KST date. DM callers still pass yesterday.
      await collectYesterdayCandidates(team.shortName, team.id, articleDate, collectRaw, deadline);
    } catch (error) {
      collections.set(team.id, { teamId: team.id, rows: [], truncated: false, pagesFetched: 0,
        error: error instanceof Error ? error.message : "collection_failed", coverageDetail });
    }
  });
  const cells = [...collections.values()];
  const result = await ingestNewsArticles(getSupabaseAdmin(), cells, articleDate, { budgetMs: 60_000 });
  const failedTeams = cells.filter((c) => c.error).map((c) => c.teamId);
  const truncatedTeams = cells.filter((c) => c.truncated).map((c) => c.teamId);
  const ok = failedTeams.length === 0 && truncatedTeams.length === 0 && result.failedRows === 0 && !result.timedOut
    && result.coverageWritten === TEAMS.length;
  return NextResponse.json({ ok, clipDate, articleDate, period, failedTeams, truncatedTeams, ragIngest: result }, { status: ok ? 200 : 503 });
}
