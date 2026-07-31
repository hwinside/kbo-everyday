import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

const GAME_ID_RE = /^\d{8}[A-Z]{4}\d$/;

export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId") ?? "";
  if (!GAME_ID_RE.test(gameId)) {
    return NextResponse.json({ error: "invalid gameId", items: [], collecting: false }, { status: 400 });
  }

  const [{ data: items, error }, { data: job }] = await Promise.all([
    // query-guard: bounded -- 단일 game_id의 경기 상세 UI는 고신뢰 인터뷰 최대 6개만 노출.
    supabaseAdmin
      .from("postgame_interviews")
      .select("video_id, title, channel, channel_id, thumbnail, published_at, player_names, source_kind")
      .eq("game_id", gameId)
      .eq("confidence", "high")
      .order("source_kind", { ascending: true })
      .order("published_at", { ascending: true })
      .limit(6),
    supabaseAdmin
      .from("postgame_interview_jobs")
      .select("status, expires_at")
      .eq("game_id", gameId)
      .maybeSingle(),
  ]);

  if (error) {
    return NextResponse.json({ error: "query failed", items: [], collecting: false }, { status: 500 });
  }

  const collecting =
    job?.status === "collecting"
    && Number.isFinite(Date.parse(job.expires_at))
    && Date.parse(job.expires_at) > Date.now();

  return NextResponse.json(
    {
      items: (items ?? []).map((item) => ({
        videoId: item.video_id,
        title: item.title,
        channel: item.channel,
        channelId: item.channel_id,
        thumbnail: item.thumbnail,
        publishedAt: item.published_at,
        playerNames: item.player_names ?? [],
        sourceKind: item.source_kind,
      })),
      collecting,
      collectionEndsAt: collecting ? job.expires_at : null,
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    },
  );
}
