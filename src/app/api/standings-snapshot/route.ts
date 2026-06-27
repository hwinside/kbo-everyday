import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchGames } from "@/lib/crawler/kbo-api";

/**
 * 순위표 '오늘 결과 반영됨 / 오늘 결과 반영 전' 칩 판정용 baseline 제공.
 *
 * baseline = "오늘 경기 직전까지의 팀별 누적 경기수(승+패+무)".
 * 클라이언트는 `현재 누적(standings) - baseline >= 오늘 final 경기수` 이면 '반영됨'으로 판정한다.
 *
 * daily_standings_snapshot은 매일 01:00 KST cron(daily-analysis)이 그날 날짜로 누적을 저장한다.
 * 즉 date=D 스냅샷 = D 새벽(오늘 경기 시작 전) 시점 누적 = "D-1 경기까지 반영".
 *
 * 문제: cron이 하루라도 누락되면 date=오늘 스냅샷이 통째로 비어, 기존 단순 eq 매칭은
 * baseline을 못 찾아 10팀 전부 '반영 전'으로 떨어진다(2026-06-19 스냅샷 누락 사례).
 * 또 단순히 latest 스냅샷으로 fallback하면 그 사이 경기 반영분 때문에 `cur-base`가 과대해져
 * false-positive('반영됨' 오표기)가 난다.
 *
 * 해결: cron 누락에 견고하도록 baseline을 '복원'한다.
 *   1) date <= 요청일 중 '가장 최근' 스냅샷 S를 baseline 씨앗으로 잡고 (= "S-1까지 반영")
 *   2) S일 ~ 어제(요청일-1)까지의 KBO final 경기수를 팀별로 더해 "오늘 경기 직전 누적"을 복원.
 * 스냅샷이 오늘 날짜로 정상 존재하면 보정 일자가 비어 기존 동작과 동일하다.
 */
export async function GET(req: NextRequest) {
  const dateParam = req.nextUrl.searchParams.get("date"); // YYYYMMDD (오늘 KST)
  if (!dateParam || !/^\d{8}$/.test(dateParam)) {
    return NextResponse.json({ error: "date param required (YYYYMMDD)" }, { status: 400 });
  }
  const isoToday = `${dateParam.slice(0, 4)}-${dateParam.slice(4, 6)}-${dateParam.slice(6, 8)}`;

  // 1) 요청일 이하 '가장 최근' 스냅샷 date 찾기 (cron 누락 시 과거로 떨어짐)
  const { data: latestRow, error: latestErr } = await supabaseAdmin
    .from("daily_standings_snapshot")
    .select("date")
    .lte("date", isoToday)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestErr) {
    return NextResponse.json({ error: latestErr.message }, { status: 500 });
  }
  if (!latestRow?.date) {
    // 스냅샷 자체가 없음 → baseline 불가, 보수적으로 빈 응답(클라가 '반영 전' 처리)
    return NextResponse.json(
      { date: isoToday, snapshotDate: null, count: 0, teams: [] },
      { headers: { "Cache-Control": "no-store, must-revalidate" } },
    );
  }
  const snapshotDate = latestRow.date as string; // YYYY-MM-DD

  // 2) 스냅샷 누적(팀별 경기수) = baseline 씨앗 ("snapshotDate-1까지 반영")
  const { data: snapRows, error: snapErr } = await supabaseAdmin
    .from("daily_standings_snapshot")
    .select("team_id, wins, losses, draws")
    .eq("date", snapshotDate);

  if (snapErr) {
    return NextResponse.json({ error: snapErr.message }, { status: 500 });
  }

  const baseline = new Map<number, number>();
  for (const r of snapRows ?? []) {
    baseline.set(Number(r.team_id), Number(r.wins) + Number(r.losses) + Number(r.draws));
  }

  // 3) 보정 일자 = [snapshotDate, ..., 어제(isoToday 미만)]  ← '오늘 경기 직전'까지만
  //    snapshotDate가 오늘이면 보정 일자가 비어 기존 동작과 동일.
  const gapDates = enumerateDates(snapshotDate, isoToday);

  // KBO API 폭주 방지 cap. 정상 시즌이면 0~2일; 큰 갭은 데이터 이상이므로 보수적으로 빈 응답.
  const MAX_GAP = 14;
  if (gapDates.length > MAX_GAP) {
    return NextResponse.json(
      { date: isoToday, snapshotDate, count: 0, teams: [], note: "snapshot gap too large" },
      { headers: { "Cache-Control": "no-store, must-revalidate" } },
    );
  }

  if (gapDates.length > 0) {
    const results = await Promise.allSettled(
      gapDates.map((d) => fetchGames(d.replace(/-/g, ""))),
    );
    for (const res of results) {
      if (res.status !== "fulfilled") continue;
      for (const g of res.value) {
        if (g.status !== "final") continue;
        if (g.homeTeamId) baseline.set(g.homeTeamId, (baseline.get(g.homeTeamId) ?? 0) + 1);
        if (g.awayTeamId) baseline.set(g.awayTeamId, (baseline.get(g.awayTeamId) ?? 0) + 1);
      }
    }
  }

  const teams = Array.from(baseline.entries()).map(([teamId, games]) => ({ teamId, games }));

  return NextResponse.json(
    { date: isoToday, snapshotDate, count: teams.length, teams },
    { headers: { "Cache-Control": "no-store, must-revalidate" } },
  );
}

/** startIso(포함) ~ endIsoExclusive(미포함) 사이 날짜 목록(YYYY-MM-DD). */
function enumerateDates(startIso: string, endIsoExclusive: string): string[] {
  const out: string[] = [];
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIsoExclusive}T00:00:00Z`);
  for (let d = start; d < end; d = new Date(d.getTime() + 86400000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export const dynamic = "force-dynamic";
export const revalidate = 0;
