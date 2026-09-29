/** Independent reviewer gate: real route + ingest, mocked external collection/DB; no live writes. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import { TEAMS } from "../../src/lib/constants/teams";
import { newsCollectionWindow } from "../../src/lib/baseball-qa/rag/news-collection-window";
import { ingestNewsArticles, type NewsIngestClient, type CoverageRow } from "../../src/lib/baseball-qa/rag/news-ingest";
import { toNewsArticleRows } from "../../src/lib/baseball-qa/rag/news-articles";
import type { RawCandidateSink } from "../../src/lib/news-clipping";

const midnight = Date.parse("2026-09-28T15:00:00Z");
assert.equal(newsCollectionWindow("today", midnight)?.articleDate, "2026-09-29");
assert.equal(newsCollectionWindow("today", midnight - 1)?.articleDate, "2026-09-28");
assert.equal(newsCollectionWindow(null, midnight)?.articleDate, "2026-09-28");
assert.equal(newsCollectionWindow("today", Date.parse("2026-12-31T15:00:00Z"))?.clipDate, "2027-01-01");
assert.equal(newsCollectionWindow("arbitrary"), null);

const config = JSON.parse(readFileSync("vercel.json", "utf8"));
assert.ok(config.crons.some((c: { path: string; schedule: string }) => c.path === "/api/cron/news-rag-collect" && c.schedule === "50 23,0 * * *"));
assert.ok(config.crons.some((c: { path: string; schedule: string }) => c.path === "/api/cron/news-rag-collect?period=today" && c.schedule === "0,30 * * * *"));
assert.ok(config.crons.some((c: { path: string; schedule: string }) => c.path === "/api/cron/news-rag-embed" && c.schedule === "5,20,35,50 * * * *"));
assert.equal(config.crons.filter((c: { path: string }) => c.path.startsWith("/api/cron/news-clipping?")).length, 10);

const code = ts.transpileModule(readFileSync("src/app/api/cron/news-rag-collect/route.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
type Mode = "ok" | "collect_failed" | "truncated" | "ingest_failed" | "coverage_failed";
async function probe(period: string | null, mode: Mode = "ok", authorized = true, now = Date.now()) {
  const dates: string[] = [];
  const coverage: CoverageRow[] = [];
  const client: NewsIngestClient = { rpc: async (name, args) => {
    if (name === "record_baseball_genius_news_coverage") {
      coverage.push(...args.p_rows as CoverageRow[]);
      return mode === "coverage_failed" ? { data: null, error: { message: "fixture coverage failure" } }
        : { data: coverage.length, error: null };
    }
    return mode === "ingest_failed" ? { data: null, error: { message: "fixture ingest failure" } }
      : { data: [{ inserted: 1, updated: 0, reembed_queued: 1 }], error: null };
  } };
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse },
    "@/lib/supabase/admin": { getSupabaseAdmin: () => client },
    "@/lib/constants/teams": { TEAMS },
    "@/lib/news-clipping": { collectYesterdayCandidates: async (_short: string, team: number, date: string, sink: RawCandidateSink) => {
      dates.push(date);
      if (mode === "collect_failed") throw new Error("fixture collect failure");
      sink(team, [{ title: "LG 트윈스 테스트 기사", description: "검증 전용 기사입니다.",
        link: `https://n.news.naver.com/mnews/article/001/${team}`, pubDate: `${date}T00:00:00+09:00` }],
      { truncated: mode === "truncated", pagesFetched: 1 });
    } },
    "@/lib/naver-news": { mapWithConcurrency: async (teams: typeof TEAMS, _limit: number, fn: (team: typeof TEAMS[number]) => Promise<void>) => {
      for (const team of teams) await fn(team);
    } },
    "@/lib/baseball-qa/rag/news-articles": { toNewsArticleRows },
    "@/lib/baseball-qa/rag/news-ingest": { ingestNewsArticles },
    "@/lib/baseball-qa/rag/news-collection-window": { newsCollectionWindow: (value: string | null) => newsCollectionWindow(value, now) },
  };
  const exports: { GET?: (req: NextRequest) => Promise<Response> } = {};
  new Function("require", "exports", code)((name: string) => {
    assert.ok(name in modules, `unexpected external dependency ${name}`);
    return modules[name];
  }, exports);
  const response = await exports.GET!(new NextRequest(`https://example.com/api/cron/news-rag-collect${period === null ? "" : `?period=${period}`}`, {
    headers: authorized ? { authorization: "Bearer qa-only-cron" } : {},
  }));
  return { response, body: await response.json(), coverage, dates };
}
async function main() {
  const previousSecret = process.env.CRON_SECRET;
  const previousService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.CRON_SECRET = "qa-only-cron";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "qa-only-not-a-credential";
  try {
    for (const period of [null, "today"] as const) {
      const result = await probe(period);
      assert.equal(result.response.status, 200);
      assert.equal(result.dates.length, TEAMS.length);
      assert.ok(result.dates.every(date => date === newsCollectionWindow(period)!.articleDate));
      assert.equal(result.coverage.length, TEAMS.length);
      assert.ok(result.coverage.every(row => row.clip_date === result.body.articleDate));
      assert.ok(result.coverage.every(row => row.detail?.includes(`article_date=${result.body.articleDate}`)));
      assert.ok(result.coverage.every(row => row.detail?.includes(`period=${period ?? "yesterday"}`)));
    }
    for (const mode of ["collect_failed", "truncated", "ingest_failed", "coverage_failed"] as const) {
      const result = await probe("today", mode);
      assert.equal(result.response.status, 503, mode);
      assert.equal(result.body.ok, false, mode);
      assert.ok(result.coverage.every(row => row.detail?.includes("period=today")), mode);
    }
    // Reproduce the real coverage RPC conflict key across the morning boundary.
    for (const previousMode of ["collect_failed", "truncated"] as const) {
      const previous = await probe(null, previousMode, true, Date.parse("2026-09-28T23:50:00Z"));
      const today = await probe("today", "ok", true, Date.parse("2026-09-29T00:00:00Z"));
      const rows = new Map<string, CoverageRow>();
      for (const result of [previous, today]) {
        for (const row of result.coverage) rows.set(`${row.clip_date}:${row.team_id}`, row);
      }
      assert.equal(previous.response.status, 503);
      assert.equal(today.response.status, 200);
      assert.equal(rows.size, TEAMS.length * 2);
      for (const team of TEAMS) {
        assert.notEqual(rows.get(`2026-09-28:${team.id}`)?.status, "ok");
        assert.equal(rows.get(`2026-09-29:${team.id}`)?.status, "ok");
      }
      // The following morning finalizes the same article day, not the new run day.
      const finalized = await probe(null, "collect_failed", true, Date.parse("2026-09-29T23:50:00Z"));
      for (const row of finalized.coverage) rows.set(`${row.clip_date}:${row.team_id}`, row);
      assert.equal(rows.size, TEAMS.length * 2);
      for (const team of TEAMS) assert.notEqual(rows.get(`2026-09-29:${team.id}`)?.status, "ok");
    }
    const rejected = await probe("today", "ok", false);
    assert.equal(rejected.response.status, 401);
    assert.equal(rejected.dates.length, 0);
    const invalid = await probe("arbitrary");
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.dates.length, 0);
    delete process.env.CRON_SECRET;
    assert.equal((await probe("today")).response.status, 401);
    console.log("intraday route/date/auth/failure/coverage/schedule boundaries PASS; live cadence/backlog NOT verified");
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousService;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
