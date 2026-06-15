import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { startJob, finishJob } from "@/lib/admin/job-logger";
import { fetchGames } from "@/lib/crawler/kbo-api";
import { ingestGameRows, type PlayerGameLogRow, type UnresolvedBoxScorePlayer } from "@/lib/game-logs/ingest";
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
 * 경기별 탭/주간 추이가 6/6 백필에서 멈추지 않도록, 매 실행마다 KST 오늘+어제의
 * final 경기를 player_game_logs에 멱등 upsert. (KBO 경기는 ~22~23:30 KST 종료, 일부는
 * 자정 넘김 → 어제까지 함께 적재해 누락/크로스미드나잇 방어.)
 * UNIQUE(kbo_id, player_type, game_id) 멱등 — 여러 번 돌아도 안전.
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

    // 경기별 박스스코어 → 행 매핑 (실패한 경기는 건너뜀, 나머지는 진행)
    // unresolved: 박스스코어엔 떴지만 로스터 미등록이라 스킵된 선수 (신규/시즌중 합류 탐지)
    const unresolved: UnresolvedBoxScorePlayer[] = [];
    const settled = await Promise.allSettled(finals.map((g) => ingestGameRows(g, unresolved)));
    const rows: PlayerGameLogRow[] = [];
    let gamesOk = 0;
    let gamesNoBox = 0;
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value) {
        gamesOk++;
        rows.push(...r.value);
      } else {
        gamesNoBox++;
      }
    }

    let upserted = 0;
    if (rows.length > 0) {
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error } = await supabaseAdmin
          .from("player_game_logs")
          .upsert(chunk, { onConflict: "kbo_id,player_type,game_id" });
        if (error) throw new Error(`upsert 실패 @${i}: ${error.message}`);
        upserted += chunk.length;
      }
    }

    // 미등록 선수 탐지 → 슬랙 알림 (부가 기능, throw 없음). 결과는 summary에 항상 기록.
    const gapResult = await notifyRosterGaps(unresolved);
    const gapNote = gapResult.gaps.length
      ? ` | ⚠️미등록 ${gapResult.gaps.length}명 [${gapResult.gaps
          .map((g) => `${g.name}(${g.teamName})`)
          .join(",")}] (알림:${gapResult.status})`
      : "";

    const summary = `${dates.join(",")} | final ${finals.length} (박스 ${gamesOk}/없음 ${gamesNoBox}) | upsert ${upserted}행${gapNote}`;
    await finishJob(logId, "success", summary);

    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      dates,
      finals: finals.length,
      gamesOk,
      gamesNoBox,
      upserted,
      rosterGaps: gapResult.gaps,
      rosterGapAlert: gapResult.status,
    });
  } catch (e) {
    await finishJob(logId, "error", undefined, (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
