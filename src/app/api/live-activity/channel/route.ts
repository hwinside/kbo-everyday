import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";

// Broadcast 채널 조회 (스펙 v4 §서버 7) — 앱이 인앱 `.channel` start 전에 호출.
// 양쪽 env의 channel id를 모두 반환하고, *선택은 클라가* 자기 빌드의 컴파일타임
// env 상수(#if DEBUG → sandbox / else production)로 한다 — 서버는 env를 추정하지 않음.
// 비로그인 허용(읽기 전용·비밀 아님: 채널 구독엔 이 id가 필요하고 발송 권한과 무관).
export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId || !/^\d{8}[A-Z]{4}\d$/.test(gameId)) {
    return NextResponse.json({ error: "gameId required" }, { status: 400 });
  }
  const { data, error } = await supabase
    .from("live_activity_channels")
    .select("environment, channel_id")
    .eq("game_id", gameId)
    .eq("status", "active");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const out: { production: string | null; sandbox: string | null } = {
    production: null,
    sandbox: null,
  };
  for (const r of (data ?? []) as { environment: "production" | "sandbox"; channel_id: string }[]) {
    out[r.environment] = r.channel_id;
  }
  return NextResponse.json(out);
}
