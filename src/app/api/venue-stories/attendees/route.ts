import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { attendeeUserIdsFromRows } from "@/lib/venue-stories/chat-badge";

// GET: 경기별 직관 인증 유저 id 목록 — 크관 채팅 [직관] 배지용.
// 판정 기준·만료 정책 근거는 src/lib/venue-stories/chat-badge.ts 주석 참조.
// user_id 만 반환한다(미디어/캡션 등 스토리 본문 미노출). 스토리 자체가
// 작성자 공개 컨텐츠라 작성자 id 목록 공개는 기존 노출 범위 이내.
export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) {
    return NextResponse.json({ error: "gameId 필요" }, { status: 400 });
  }

  // query-guard: bounded -- 단일 경기 스코프 + 인당 상한 10(VENUE_STORY_MAX_PER_USER_PER_GAME)
  // + 만료 +24h 행 삭제(cleanup cron)로 경기당 행수 소규모, limit 500 방어
  const { data, error } = await supabase
    .from("venue_stories")
    .select("user_id")
    .eq("game_id", gameId)
    .eq("status", "active")
    .limit(500);

  if (error) {
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  return NextResponse.json(
    { userIds: attendeeUserIdsFromRows((data ?? []) as Array<{ user_id: string }>) },
    // 배지는 실시간성 불요(새 업로더는 다음 입장 시 반영이면 충분) → 60s 캐시로 부하 방어
    { headers: { "Cache-Control": "public, max-age=60, s-maxage=60" } },
  );
}
