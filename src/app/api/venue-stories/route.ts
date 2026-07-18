import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import {
  VENUE_STORY_MAX_DURATION_MS,
  VENUE_STORY_DURATION_TOLERANCE_MS,
  VENUE_STORY_TTL_HOURS,
  VENUE_STORY_MAX_PER_USER_PER_GAME,
  type VenueStory,
} from "@/lib/venue-stories/types";

const ALLOWED_BUCKETS = new Set(["videos", "photos"]);

/** 우리 Supabase storage 공개 URL 인지 검증하고 { bucket, path } 파싱 */
function parseStoragePublicUrl(
  url: string,
): { bucket: string; path: string } | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base || typeof url !== "string") return null;
  const prefix = `${base}/storage/v1/object/public/`;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length).split("?")[0];
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const bucket = rest.slice(0, slash);
  const path = decodeURIComponent(rest.slice(slash + 1));
  if (!ALLOWED_BUCKETS.has(bucket) || !path) return null;
  return { bucket, path };
}

// GET: 경기별 active 직관 스토리 목록
export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) {
    return NextResponse.json({ error: "gameId 필요" }, { status: 400 });
  }

  const { data: rows, error } = await supabase
    .from("venue_stories")
    .select(
      "id, game_id, user_id, media_type, media_url, thumb_url, duration_ms, width, height, caption, created_at",
    )
    .eq("game_id", gameId)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  const list = rows ?? [];
  const userIds = [...new Set(list.map((r) => r.user_id as string))];
  const profileMap = new Map<
    string,
    { nickname: string | null; avatar_url: string | null; team_id: number | null }
  >();
  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, nickname, avatar_url, team_id")
      .in("id", userIds);
    for (const p of profiles ?? []) {
      profileMap.set(p.id as string, {
        nickname: (p.nickname as string) ?? null,
        avatar_url: (p.avatar_url as string) ?? null,
        team_id: (p.team_id as number) ?? null,
      });
    }
  }

  const stories: VenueStory[] = list.map((r) => {
    const prof = profileMap.get(r.user_id as string);
    return {
      id: r.id as number,
      gameId: r.game_id as string,
      userId: r.user_id as string,
      mediaType: r.media_type as "video" | "image",
      mediaUrl: r.media_url as string,
      thumbUrl: (r.thumb_url as string) ?? null,
      durationMs: (r.duration_ms as number) ?? null,
      width: (r.width as number) ?? null,
      height: (r.height as number) ?? null,
      caption: (r.caption as string) ?? null,
      createdAt: r.created_at as string,
      author: {
        nickname: prof?.nickname ?? null,
        avatarUrl: prof?.avatar_url ?? null,
        teamId: prof?.team_id ?? null,
      },
    };
  });

  return NextResponse.json({ stories });
}

// POST: 직관 스토리 생성 (verified user, expires_at 서버 권위)
export async function POST(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }
  const userId = verified.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청" }, { status: 400 });
  }

  const gameId = typeof body.gameId === "string" ? body.gameId.trim() : "";
  const mediaType = body.mediaType;
  const mediaUrl = typeof body.mediaUrl === "string" ? body.mediaUrl : "";
  const thumbUrl = typeof body.thumbUrl === "string" ? body.thumbUrl : null;
  const durationMs =
    typeof body.durationMs === "number" ? Math.round(body.durationMs) : null;
  const width = typeof body.width === "number" ? Math.round(body.width) : null;
  const height = typeof body.height === "number" ? Math.round(body.height) : null;
  const caption =
    typeof body.caption === "string" ? body.caption.trim().slice(0, 200) : null;

  if (!gameId) {
    return NextResponse.json({ error: "gameId 필요" }, { status: 400 });
  }
  if (mediaType !== "video" && mediaType !== "image") {
    return NextResponse.json({ error: "mediaType 오류" }, { status: 400 });
  }

  const media = parseStoragePublicUrl(mediaUrl);
  if (!media) {
    return NextResponse.json({ error: "미디어 URL 오류" }, { status: 400 });
  }
  let thumb: { bucket: string; path: string } | null = null;
  if (thumbUrl) {
    thumb = parseStoragePublicUrl(thumbUrl);
    if (!thumb) {
      return NextResponse.json({ error: "썸네일 URL 오류" }, { status: 400 });
    }
  }

  if (mediaType === "video") {
    if (
      durationMs != null &&
      durationMs > VENUE_STORY_MAX_DURATION_MS + VENUE_STORY_DURATION_TOLERANCE_MS
    ) {
      return NextResponse.json(
        { error: "영상은 15초 이하만 올릴 수 있어요" },
        { status: 400 },
      );
    }
  }

  // 게임당 유저 상한(스팸 방지)
  const { count } = await supabase
    .from("venue_stories")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("game_id", gameId)
    .eq("status", "active");
  if ((count ?? 0) >= VENUE_STORY_MAX_PER_USER_PER_GAME) {
    return NextResponse.json(
      { error: "이 경기에 올릴 수 있는 개수를 초과했어요" },
      { status: 429 },
    );
  }

  const expiresAt = new Date(
    Date.now() + VENUE_STORY_TTL_HOURS * 3600_000,
  ).toISOString();

  const { data: inserted, error } = await supabase
    .from("venue_stories")
    .insert({
      game_id: gameId,
      user_id: userId,
      media_type: mediaType,
      media_url: mediaUrl,
      media_bucket: media.bucket,
      media_path: media.path,
      thumb_url: thumbUrl,
      thumb_bucket: thumb?.bucket ?? null,
      thumb_path: thumb?.path ?? null,
      duration_ms: durationMs,
      width,
      height,
      caption,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    return NextResponse.json({ error: "저장 실패" }, { status: 500 });
  }

  return NextResponse.json({ success: true, id: inserted.id });
}
