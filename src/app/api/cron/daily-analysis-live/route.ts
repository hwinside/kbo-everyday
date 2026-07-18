import { NextRequest, NextResponse } from "next/server";
import { fetchGames } from "@/lib/crawler/kbo-api";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { runDailyAnalysis } from "@/lib/analysis/daily-analysis-core";

/**
 * 당일 경기가 모두 끝나면 순위 AI 분석을 '즉시' 그날 경기 기준으로 재생성한다.
 *
 * 기존엔 다음날 01:00 크론(daily-analysis) 하나로만 갱신돼, 경기가 밤에 끝나도
 * 다음날 새벽까지 "어제 경기 기준"으로 떠 있었다. 이 크론이 저녁 시간대(KST 16:00~23:59)
 * 매 10분 돌면서 오늘 경기가 전부 종료(final/취소, ≥1 final)되는 순간 한 번만 재생성한다.
 *
 * - 경기 없는 날 / 전부 우천취소 → no-op (기존 휴식일 로직은 새벽 백스톱이 담당)
 * - 아직 경기 진행 중 → no-op (모든 경기가 terminal일 때만 발화)
 * - 멱등성: 이미 오늘 라이브 분석이 생성됐으면(delta_json.sameDayLive) skip → 하루 1회만 발화
 * - 스냅샷은 건드리지 않음(core의 live 모드) → '오늘 결과 반영됨' 칩 baseline 보존
 * - 다음날 01:00 백스톱은 그대로 유지(이 트리거 실패해도 새벽에 보정)
 */
const CRON_SECRET = process.env.CRON_SECRET || "";

function getKSTDateISO(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10); // YYYY-MM-DD
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const todayISO = getKSTDateISO();
  const todayKbo = todayISO.replace(/-/g, "");

  // 1) 오늘 경기 상태 확인
  let games;
  try {
    games = await fetchGames(todayKbo);
  } catch (e) {
    return NextResponse.json({ ok: false, skipped: "games fetch failed", error: (e as Error).message });
  }

  if (games.length === 0) {
    return NextResponse.json({ ok: true, skipped: "no games today", date: todayISO });
  }

  const allTerminal = games.every((g) => g.status === "final" || g.status === "cancelled");
  const finals = games.filter((g) => g.status === "final");

  if (!allTerminal) {
    return NextResponse.json({
      ok: true,
      skipped: "games in progress",
      date: todayISO,
      total: games.length,
      final: finals.length,
    });
  }
  if (finals.length === 0) {
    // 전 경기 우천취소 등 — 반영할 결과 없음
    return NextResponse.json({ ok: true, skipped: "no final games (all cancelled)", date: todayISO });
  }

  // 2) 멱등성 — 이미 오늘 라이브 분석이 생성됐으면 skip (하루 1회만)
  const { data: existing } = await supabaseAdmin
    .from("daily_analysis")
    .select("delta_json")
    .eq("date", todayISO)
    .eq("type", "standings")
    .maybeSingle();
  const already = (existing?.delta_json as Record<string, unknown> | null)?.sameDayLive === true;
  if (already) {
    return NextResponse.json({ ok: true, skipped: "already generated (sameDayLive)", date: todayISO });
  }

  // 3) 오늘 경기 전부 종료 → 즉시 분석 재생성 (live 모드)
  const { status, body } = await runDailyAnalysis("live");
  return NextResponse.json(body, { status });
}

export const dynamic = "force-dynamic";
export const revalidate = 0;
