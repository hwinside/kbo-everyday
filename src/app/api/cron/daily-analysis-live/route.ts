import { NextRequest, NextResponse } from "next/server";
import { fetchGames } from "@/lib/crawler/kbo-api";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { runDailyAnalysis } from "@/lib/analysis/daily-analysis-core";
import {
  resolveLiveTarget,
  isAlreadyReflected,
  runLiveAnalysisWithClaim,
  interpretClaimRpc,
  assertLookupOk,
  type SlateState,
} from "@/lib/analysis/daily-analysis-live-policy";

/**
 * 당일 경기가 모두 끝나면 순위 AI 분석을 '즉시' 그날 경기 기준으로 재생성한다.
 *
 * 기존엔 다음날 01:00 크론(daily-analysis) 하나로만 갱신돼, 경기가 밤에 끝나도
 * 다음날 새벽까지 "어제 경기 기준"으로 떠 있었다. 이 크론이 저녁~자정 시간대 매 10분 돌면서
 * 오늘 경기가 전부 종료(final/취소, ≥1 final)되는 순간 한 번만 재생성한다.
 *
 * P0② catch-up: cron '10분마다 7-15시(UTC)' = KST 16:00~00:50. UTC 15시(KST 00시대) tick이 23:51~자정 이후 끝난 지연/연장
 *   경기는 오늘 슬레이트로는 못 잡으므로, 오늘이 아직(진행중/미개시)이고 어제가 전부 종료면
 *   gameDate=어제·saveDate=오늘으로 catch-up 저장(01:00 백스톱과 멱등).
 * P0① readiness: 순위/타이틀 원천이 finals 반영 전이면 core가 not_ready로 skip → 다음 tick 재시도.
 * 멱등성: saveDate 행이 이미 gameDate를 반영했으면 skip(하루 1회). 동시 호출은 date-unique claim으로 방지.
 * 스냅샷은 건드리지 않음(core의 live 모드) → '오늘 결과 반영됨' 칩 baseline 보존.
 * 다음날 01:00 백스톱은 그대로 유지(이 트리거 실패해도 새벽에 보정).
 */
const CRON_SECRET = process.env.CRON_SECRET || "";

// claim lease: 이 시간 경과한 claim은 크래시로 간주하고 재획득 허용. 생성 1회는 수 분 내라 10분이면 충분.
const CLAIM_LEASE_SECONDS = 600;

function kstDateISO(offsetDays = 0): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10); // YYYY-MM-DD
}

function toSlate(games: { status: string }[]): SlateState {
  const finalCount = games.filter((g) => g.status === "final").length;
  const allTerminal = games.length > 0 && games.every((g) => g.status === "final" || g.status === "cancelled");
  return { hasGames: games.length > 0, allTerminal, finalCount };
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const todayISO = kstDateISO(0);
  const yesterdayISO = kstDateISO(-1);

  // 1) 오늘/어제 슬레이트 상태 확인(catch-up 판정에 둘 다 필요)
  let todaySlate: SlateState;
  let yesterdaySlate: SlateState;
  try {
    const [todayGames, yesterdayGames] = await Promise.all([
      fetchGames(todayISO.replace(/-/g, "")),
      fetchGames(yesterdayISO.replace(/-/g, "")),
    ]);
    todaySlate = toSlate(todayGames);
    yesterdaySlate = toSlate(yesterdayGames);
  } catch (e) {
    // 경기 조회 실패를 200으로 숨기면 크론이 계속 조용히 동다 실패를 못 드러낸다.
    // 다음 10분 tick이 재시도하되, 5xx로 돌려 운영 관제에 실패가 드러나게 한다.
    return NextResponse.json(
      { ok: false, skipped: "games fetch failed", error: (e as Error).message },
      { status: 500 },
    );
  }

  // 2) 처리할 {gameDate, saveDate} 해석(정상 당일 / 자정 이후 catch-up)
  const target = resolveLiveTarget({ todayISO, yesterdayISO, today: todaySlate, yesterday: yesterdaySlate });
  if (!target) {
    return NextResponse.json({
      ok: true,
      skipped: "no terminal slate to reflect",
      today: todaySlate,
      yesterday: yesterdaySlate,
    });
  }

  // 3) 멱등성 — saveDate 행이 이미 gameDate를 반영했으면 skip (claim 획득 전 값싼 게이트).
  //    조회 오류를 미반영으로 축약하면 중복 생성 위험 → fail-closed(5xx). 다음 tick 재시도.
  let existing: { delta_json: unknown } | null;
  try {
    const lookup = await supabaseAdmin
      .from("daily_analysis")
      .select("delta_json")
      .eq("date", target.saveDate)
      .eq("type", "standings")
      .maybeSingle();
    assertLookupOk(lookup, "existing analysis");
    existing = lookup.data;
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message, ...target }, { status: 500 });
  }
  const meta = existing?.delta_json as { sameDayLive?: boolean; lastUpdated?: string } | null;
  if (isAlreadyReflected(target.gameDate, target.saveDate, meta)) {
    return NextResponse.json({ ok: true, skipped: "already reflected", ...target });
  }

  // 4) 원자적 claim(saveDate 기준) → 생성(live, core가 readiness gate) → not-ready/실패면 해제.
  //    claim RPC 오류(마이그 누락/권한)는 interpretClaimRpc가 throw → contention(data!==true, 200)과 분리해
  //    5xx로 종료(관제 노출). run() 예외도 claim 해제 후 5xx, run() 500은 shouldReleaseAfterRun이 해제.
  let outcome: { status: number; body: Record<string, unknown> };
  try {
    outcome = await runLiveAnalysisWithClaim({
      claim: async () =>
        interpretClaimRpc(
          await supabaseAdmin.rpc("claim_daily_analysis_live", {
            p_date: target.saveDate,
            p_lease_seconds: CLAIM_LEASE_SECONDS,
          }),
        ),
      release: async () => {
        await supabaseAdmin.from("daily_analysis_live_claims").delete().eq("analysis_date", target.saveDate);
      },
      run: () => runDailyAnalysis("live", { gameDate: target.gameDate, saveDate: target.saveDate }),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message, ...target }, { status: 500 });
  }

  return NextResponse.json({ ...target, ...outcome.body }, { status: outcome.status });
}

export const dynamic = "force-dynamic";
export const revalidate = 0;
