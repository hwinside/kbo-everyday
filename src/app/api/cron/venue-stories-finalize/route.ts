import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { fetchGames } from "@/lib/crawler/kbo-api";
import { isTerminalGameStatus, finalizedExpiryIso } from "@/lib/venue-stories/expiry-policy";

const CRON_SECRET = process.env.CRON_SECRET || "";

export const maxDuration = 30;

function gameDateFromId(gameId: string): string | null {
  const m = /^(\d{8})/.exec(gameId);
  return m ? m[1] : null;
}

/**
 * 직관 라이브 만료 확정 cron:
 *  진행중→terminal(final/cancelled) 전이를 감지해 **CAS(game_ended_at IS NULL 가드) 성공 후에만**
 *  game_ended_at 을 확정하고 만료를 감지시각+24h 로 확정한다(하린아빠 스펙: 종료+24h).
 *  terminal 전에는 업로드 시 넣은 시작+72h 안전상한(장애 정책)만 존재 — 조기삭제 금지.
 *  vercel.json 스케줄은 UTC 5-18(KST 14:00~03:59)로 연장지연·서스펜드 등 늦은 종료도 당일 감지한다.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // game_ended_at 미확정 + 아직 노출/대기 중인 스토리의 gameId 수집
  const { data: rows, error } = await supabase
    .from("venue_stories")
    .select("game_id")
    .is("game_ended_at", null)
    .in("status", ["active", "pending"])
    .limit(2000);
  if (error) {
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }
  const gameIds = [...new Set((rows ?? []).map((r) => r.game_id as string))];
  if (gameIds.length === 0) {
    return NextResponse.json({ finalized: 0, checked: 0 });
  }

  // 날짜별로 묶어 fetchGames 를 최소 호출
  const byDate = new Map<string, Set<string>>();
  for (const gid of gameIds) {
    const d = gameDateFromId(gid);
    if (!d) continue;
    const set = byDate.get(d) ?? new Set<string>();
    set.add(gid);
    byDate.set(d, set);
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const expiresIso = finalizedExpiryIso(nowMs);

  let finalized = 0;
  let faults = 0;
  for (const [date, wantSet] of byDate) {
    let games;
    try {
      games = await fetchGames(date);
    } catch {
      faults++; // 이 날짜는 다음 실행에서 재시도(game_ended_at 미확정 유지)
      continue;
    }
    for (const g of games) {
      if (!wantSet.has(g.gameId)) continue;
      // terminal(final/cancelled) 전이에서만 만료 확정
      if (!isTerminalGameStatus(g.status)) continue;
      const { error: updErr } = await supabase
        .from("venue_stories")
        .update({ game_ended_at: nowIso, expires_at: expiresIso })
        .eq("game_id", g.gameId)
        .is("game_ended_at", null); // CAS: 첫 확정만(멱등) — 재실행이 만료를 느리게 밀지 않음
      if (updErr) {
        faults++;
        continue;
      }
      finalized++;
    }
  }

  if (faults > 0) {
    return NextResponse.json({ finalized, checked: gameIds.length, faults }, { status: 500 });
  }
  return NextResponse.json({ finalized, checked: gameIds.length });
}
