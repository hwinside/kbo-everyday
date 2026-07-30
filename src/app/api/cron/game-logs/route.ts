import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import { fetchGames } from "@/lib/crawler/kbo-api";
import { ingestGameWithLedger, type LedgerIngestResult } from "@/lib/game-logs/ledger-ingest";
import type { UnresolvedBoxScorePlayer } from "@/lib/game-logs/ingest";
import { notifyRosterGaps } from "@/lib/game-logs/roster-gap-alert";
import { getKSTToday, getKSTYesterday } from "@/lib/utils/date-kst";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET || "";

// 정규시즌만 (srId="0"). 백필(scripts/backfill-game-logs.mts)과 동일 — 시범/포스트 제외로
// 시즌 누적 AVG/ERA 오염 방지.
const REGULAR_SEASON_SR_ID = "0";

/**
 * 경기 종료 자동 적재 cron (선수 스탯 보강 V1 — 빌드 2 후속).
 * spec: specs/stats/player-stats-v1.md §7
 *
 * 직관 통계 S1a부터 경기 단위 적재는 ledger-ingest 오케스트레이터를 쓴다:
 * strict 필수필드 검증(결측→0 강등 금지) + raw=resolved=persisted 1:1 가드 +
 * canonical payload hash 검증 후 player_game_log_ingestions ledger에 완료 증거를 남긴다.
 * (Notion "[기획] 직관 다이어리 통계 v1" rev5 §11·§12)
 *
 * 매 실행마다 KST 오늘+어제의 final 경기를 멱등 upsert. (KBO 경기는 ~22~23:30 KST 종료,
 * 일부는 자정 넘김 → 어제까지 함께 적재해 누락/크로스미드나잇 방어.)
 * UNIQUE(kbo_id, player_type, game_id) + ledger PK(game_id) 멱등 — 여러 번 돌아도 안전.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const logId = await startJob("game-logs-ingest");

  try {
    const dates = [getKSTToday(), getKSTYesterday()].map((d) => d.replace(/-/g, ""));

    // 날짜별 정규시즌 경기 → final만
    const gameLists = await Promise.all(dates.map((d) => fetchGames(d, REGULAR_SEASON_SR_ID)));
    const finalsById = new Map<string, (typeof gameLists)[number][number]>();
    for (const list of gameLists) {
      for (const g of list) {
        if (g.status === "final") finalsById.set(g.gameId, g);
      }
    }
    const finals = [...finalsById.values()];

    // 경기별: strict 적재 + ledger 기록 (경기 1건 실패는 건너뛰고 나머지 진행)
    const settled = await Promise.allSettled(finals.map((g) => ingestGameWithLedger(supabaseAdmin, g)));
    const results: LedgerIngestResult[] = [];
    let gamesFailed = 0;
    const unresolved: UnresolvedBoxScorePlayer[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled") {
        results.push(r.value);
        unresolved.push(...r.value.unresolved);
      } else {
        gamesFailed++;
      }
    }
    const complete = results.filter((r) => r.status === "complete").length;
    const incomplete = results.filter((r) => r.status === "incomplete");
    const upserted = results.reduce((sum, r) => sum + r.rowsUpserted, 0);

    // 미등록 선수 탐지 → 슬랙 알림 (부가 기능, throw 없음). 결과는 summary에 항상 기록.
    const gapResult = await notifyRosterGaps(unresolved);
    const gapNote = gapResult.gaps.length
      ? ` | ⚠️미등록 ${gapResult.gaps.length}명 [${gapResult.gaps
          .map((g) => `${g.name}(${g.teamName})`)
          .join(",")}] (알림:${gapResult.status})`
      : "";
    const incompleteNote = incomplete.length
      ? ` | incomplete ${incomplete.length} [${incomplete
          .map((r) => `${r.gameId}:${r.failureReason}`)
          .join(",")}]`
      : "";

    const summary = `${dates.join(",")} | final ${finals.length} (complete ${complete}/incomplete ${incomplete.length}/에러 ${gamesFailed}) | upsert ${upserted}행${incompleteNote}${gapNote}`;
    await finishJob(logId, "success", summary);

    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      dates,
      finals: finals.length,
      complete,
      incomplete: incomplete.map((r) => ({ gameId: r.gameId, reason: r.failureReason })),
      gamesFailed,
      upserted,
      rosterGaps: gapResult.gaps,
      rosterGapAlert: gapResult.status,
    });
  } catch (e) {
    await finishJob(logId, "error", undefined, (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
