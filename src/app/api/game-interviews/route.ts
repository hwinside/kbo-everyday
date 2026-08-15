import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { interviewPlayerLinks } from "@/lib/video/postgame-interviews-route-policy";

const GAME_ID_RE = /^\d{8}[A-Z]{4}\d$/;

/**
 * 캐시 정책 — 알림 시점과 페이지 노출 시점의 불일치를 막는다.
 *
 * 2026-08-15 실측 사고: 문정빈 인터뷰가 22:55:08에 DB 저장되고 같은 cron run이
 * 알림을 보냈는데, 유저가 22:56:34에 들어가니 목록이 비어 있었다(22:59 노출).
 * 원인은 데이터가 아니라 이 응답의 `stale-while-revalidate=300`이다 —
 * s-maxage 60초가 지나도 엣지는 최대 5분간 **옛 응답(빈 목록)을 그대로 서빙**하고
 * 뒤에서만 갱신한다. 실측 헤더: `x-vercel-cache: STALE`, `age: 117`.
 *
 * 삼순 NO-GO P0-3: `s-maxage=10` 도 **10초짜리 빈 목록을 여전히 허용**하고, 더 나쁜 건
 * 이미 캐시된 `collecting=false` 응답(60+300 SWR)이 false→true 전환 뒤에도 그대로
 * 남는다 — 동적 헤더는 **이미 저장된 응답을 무효화하지 못한다**. 그래서 인터뷰가
 * 붙을 수 있는 경기(수집 전·중)는 Edge·브라우저 모두 `no-store`로 닫는다.
 *
 * `collecting=false` + 목록이 이미 채워진 경기만 캐시한다 — 그젠 더 변할 일이 없어
 * 빈 목록이 고착될 위험이 없다. 빈 목록은 수집 전일 수 있으므로 캐시하지 않는다.
 */
export function interviewCacheControl(collecting: boolean, itemCount: number): string {
  // 수집 중이거나 아직 비어 있다 — 어떤 캐시도 두지 않는다(저장 자체를 막아
  // false→true 전환 직후에도 남은 응답이 없게 한다).
  if (collecting || itemCount === 0) return "no-store";
  // 수집 종료 + 목록 확정 — 기존 캐시 정책으로 비용 방어.
  return "public, s-maxage=60, stale-while-revalidate=300";
}

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
      .select("status, expires_at, winner_team_id")
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
        players: interviewPlayerLinks(item.player_names ?? [], job?.winner_team_id),
        sourceKind: item.source_kind,
      })),
      collecting,
      collectionEndsAt: collecting ? job.expires_at : null,
    },
    { headers: { "Cache-Control": interviewCacheControl(collecting, (items ?? []).length) } },
  );
}
