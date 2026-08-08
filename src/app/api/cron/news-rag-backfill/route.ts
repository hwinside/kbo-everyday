import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { TEAMS } from "@/lib/constants/teams";
import { collectBackfillCandidates, kstDateString } from "@/lib/news-clipping";
import { toNewsArticleRows, NEWS_BACKFILL_DAYS } from "@/lib/baseball-qa/rag/news-articles";
import { ingestNewsArticles, type TeamCollection } from "@/lib/baseball-qa/rag/news-ingest";
import { judgeBackfillOutcome, buildBackfillCells } from "@/lib/baseball-qa/rag/news-backfill-outcome";

// 야잘알봇 기사 근거 **백필** — 수동 실행 전용. vercel.json cron 에 등록하지 않는다.
//
// 왜 필요한가
//   일일 cron(/api/cron/news-clipping)은 "어제 하루치" 만 수집한다. 그래서 배포 직후
//   근거는 하루치뿐이고 30일 창이 차기까지 30일이 걸린다. 출시 판정을 그때까지 미룰 수 없다.
//
// 무엇을 하지 않는가
//   · **쪽지를 보내지 않는다.** 클리핑 발송 경로를 아예 타지 않는다(빌더 호출 없음).
//   · Gemini 요약·OG 썸네일도 호출하지 않는다. 근거 적재에 불필요하고 비용만 든다.
//
// 한계 (2026-08-07 실측)
//   네이버 검색 API 는 start 상한 1000 → 쿼리당 최대 1,000건이다. 그 1,000건이 며칠 치인지는
//   팀 기사량에 달려 LG 는 약 9일, 키움은 약 16일까지만 닿는다. **30일 전체 커버는 불가능**하며,
//   어디서 막혔는지는 응답과 커버리지 원장(reached_api_limit / oldest_reached)에 남는다.

export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET || "";

/**
 * 팀 동시 수집 수 = **1**.
 *
 * 왜 병렬화하지 않는가 (2026-08-07 실측)
 *   동시성 3으로 14일 백필을 돌렸더니 첫 팀에서 바로 HTTP 429 가 떨어졌다.
 *   일 한도(25,000)가 아니라 초당 제한이다 — 전체 호출은 99회에 불과했다(한도의 0.4%).
 *   순차 수행 + fetchNaverNews 의 호출 간격 게이트로 10팀 14일이 28초에 완주된다.
 *   속도를 위해 병렬화하면 절반즁 빈 채로 끝난다 — 조용한 부분 수집이 가장 나쁜 결과다.
 */
const TEAM_CONCURRENCY = 1;

/** 적재 예산. 발송이 없으므로 일일 cron(25초)보다 넉넉히 쓴다. */
const BACKFILL_BUDGET_MS = 120_000;

/**
 * 수집 단계 전체 deadline.
 *
 * 왜 필요한가 (삼순 NO-GO)
 *   호출당 timeout(8초)·429 재시도는 **호출 하나**만 보호한다. 10팀 × 최대 7쿼리 × 10페이지가
 *   전부 느려지면 합계는 maxDuration(300초)을 넘고, 그러면 route 가 통째로 죽어 적재도 커버리지도
 *   남지 않는다. 수집을 여기서 끊고 **거둔 만큼이라도 적재 + 원장 기록**을 끝내는 게 낫다.
 *   적재 예산(120초)과 응답 여유를 뺀 값이다.
 */
const BACKFILL_COLLECT_DEADLINE_MS = 150_000;

function authorized(req: NextRequest): boolean {
  // fail-closed — env 미설정이면 전부 거부
  return Boolean(CRON_SECRET) && req.headers.get("authorization") === `Bearer ${CRON_SECRET}`;
}

interface TeamBackfillReport {
  team: string;
  days: number;
  collected: number;
  pagesFetched: number;
  queriesUsed: number;
  reachedApiLimit: boolean;
  oldestReached: string | null;
  error?: string;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * body: { days?: number }  — 며칠 전까지 백필할지(기본 = 보유기간 30일, 상한도 30일).
 * 보유기간을 넘겨 요청해도 적재 즉시 purge 대상이 되므로 상한에서 잘라낸다.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "missing_config" }, { status: 500 });
  }

  let body: { days?: number } = {};
  try {
    body = (await req.json()) as { days?: number };
  } catch {
    // body 생략 허용 — 기본값으로 진행한다.
  }

  const requestedDays = Number.isFinite(body.days) ? Number(body.days) : NEWS_BACKFILL_DAYS;
  const days = Math.min(Math.max(Math.trunc(requestedDays), 1), NEWS_BACKFILL_DAYS);
  const untilDate = kstDateString(-1); // 어제까지. 오늘치는 일일 cron 이 내일 가져간다.
  const sinceDate = kstDateString(-days);
  // 요청 창의 모든 날짜(오름차순). 팀당 이 개수만큼 원장 행이 남는다 = 10팀 × days 칸.
  const windowDates = Array.from({ length: days }, (_, i) => kstDateString(-(days - i)));

  const collectDeadline = Date.now() + BACKFILL_COLLECT_DEADLINE_MS;

  const reports = await mapWithConcurrency(TEAMS, TEAM_CONCURRENCY, async (team): Promise<{
    report: TeamBackfillReport;
    collections: TeamCollection[];
  }> => {
    // 순차 수집이라 앞 팀이 예산을 다 쓰면 뒤 팀은 아예 시도하지 못한다.
    // 그 사실을 원장에 남긴다 — "기사 0건" 으로 두면 다음 실행이 뭘 채워야 할지 모른다.
    if (Date.now() >= collectDeadline) {
      const detail = `collect deadline ${BACKFILL_COLLECT_DEADLINE_MS}ms exceeded`;
      return {
        report: {
          team: team.shortName, days: 0, collected: 0, pagesFetched: 0, queriesUsed: 0,
          reachedApiLimit: false, oldestReached: null, error: detail,
        },
        collections: windowDates.map((clipDate) => ({
          teamId: team.id, clipDate, rows: [], truncated: false, pagesFetched: 0, error: detail,
        })),
      };
    }
    try {
      const result = await collectBackfillCandidates(
        team.shortName, sinceDate, untilDate, collectDeadline,
      );
      const itemsByDate = new Map(result.days.map((d) => [d.clipDate, d.items]));

      // **요청 창의 모든 날짜**를 원장에 남긴다. 수집된 날짜만 기록하면(result.days.map)
      // 기사가 0건인 날과 API 가 못 닿은 날은 행 자체가 없어, 나중에 "10팀 × N일 확보" 를
      // 증명할 수 없다. 없는 행은 "안 쌓임" 과 "못 가져옴" 을 둘 다 의미할 수 있기 때문이다.
      // 칸 편성은 공용 함수로. route 안에 인라인으로 두면 게이트가 collector→칸→판정
      // 사슬을 직접 태울 수 없어, deadlineHit 결속이 끊겨도 GREEN 이 난다(삼순 NO-GO).
      const collections: TeamCollection[] = buildBackfillCells({
        teamId: team.id,
        windowDates,
        result,
        rowsByDate: new Map(
          [...itemsByDate].map(([d, items]) => [d, toNewsArticleRows(items, team.id)]),
        ),
        deadlineDetail: `collect deadline ${BACKFILL_COLLECT_DEADLINE_MS}ms exceeded mid-team`,
      });
      const partialDetail = collections[0]?.error;
      return {
        report: {
          team: team.shortName,
          days: result.days.length,
          collected: collections.reduce((sum, c) => sum + c.rows.length, 0),
          pagesFetched: result.pagesFetched,
          queriesUsed: result.queriesUsed,
          reachedApiLimit: result.reachedApiLimit,
          oldestReached: result.oldestReached,
          // 예산이 끊었으면 이 팀 결과는 부분이다(각 칸에도 같은 사유가 박혀 판정에 반영된다).
          error: partialDetail,
        },
        collections,
      };
    } catch (e) {
      const message = (e as Error).message;
      console.error(`[news-rag-backfill] collect failed (${team.shortName}):`, message);
      // 수집 실패도 커버리지에 남긴다 — "그 팀 그날 기사가 없다" 와 구분되어야 한다.
      return {
        report: {
          team: team.shortName, days: 0, collected: 0, pagesFetched: 0, queriesUsed: 0,
          reachedApiLimit: false, oldestReached: null, error: message,
        },
        // 실패도 창 전체에 기록한다 — 한 날짜만 남기면 나머지 날짜가 "미시도" 인지 "0건" 인지 모른다.
        collections: windowDates.map((clipDate) => ({
          teamId: team.id, clipDate, rows: [], truncated: false, pagesFetched: 0, error: message,
        })),
      };
    }
  });

  const admin = getSupabaseAdmin();
  const ingested = await ingestNewsArticles(
    admin,
    reports.flatMap((r) => r.collections),
    untilDate,
    { budgetMs: BACKFILL_BUDGET_MS },
  );

  const reachedLimit = reports.filter((r) => r.report.reachedApiLimit).map((r) => r.report.team);
  // 성공 판정은 공용 함수 하나로. route 가 자체 계산하면 게이트가 같은 로직을
  // 재구현하게 되고, 그러면 판정이 죽어도 게이트는 GREEN 이 난다.
  const coverage = judgeBackfillOutcome(reports.flatMap((r) => r.collections), ingested);

  return NextResponse.json({
    ok: coverage.ok,
    window: { sinceDate, untilDate, days },
    ingest: ingested,
    teams: reports.map((r) => r.report),
    // 요청 창을 다 못 덮은 팀. 이 목록이 비어 있지 않으면 그 팀의 근거는 창보다 얕다.
    reachedApiLimit: reachedLimit,
    // "14일 전수 기사" 가 아니라 "14일 **범위 확보**" 다. 전 칸이 covered 일 때만 range_covered.
    coverage,
  }, { status: coverage.ok ? 200 : 207 });
}
