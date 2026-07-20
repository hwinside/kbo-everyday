import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { resolveGameVenue } from "@/lib/venue-stories/venue-resolve";
import { evaluateGeofence } from "@/lib/venue-stories/geofence";
import {
  VENUE_STORY_MAX_DURATION_MS,
  VENUE_STORY_DURATION_TOLERANCE_MS,
  VENUE_STORY_MAX_BYTES,
  VENUE_STORY_MAX_PER_USER_PER_GAME,
  VENUE_GEOFENCE_MAX_ACCURACY_M,
  type VenueStory,
} from "@/lib/venue-stories/types";

const ALLOWED_BUCKETS = new Set(["videos", "photos"]);

export const maxDuration = 30;

/** 우리 Supabase storage 공개 URL 검증 + { bucket, path } 파싱 */
function parseStoragePublicUrl(url: string): { bucket: string; path: string } | null {
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

/** 소유권 바인딩: 경로가 venue-stories/{gameId}/{userId}/ 아래인지 */
function ownsPath(path: string, gameId: string, userId: string): boolean {
  return path.startsWith(`venue-stories/${gameId}/${userId}/`);
}

/** 매직 바이트로 실제 파일 형식 판별(클라 지정 Content-Type 불신). */
function magicMediaType(head: Uint8Array): "image" | "video" | null {
  const b = head;
  const has = (off: number, sig: number[]) => sig.every((v, i) => b[off + i] === v);
  // 이미지
  if (has(0, [0xff, 0xd8, 0xff])) return "image"; // JPEG
  if (has(0, [0x89, 0x50, 0x4e, 0x47])) return "image"; // PNG
  if (has(0, [0x47, 0x49, 0x46, 0x38])) return "image"; // GIF8
  if (has(0, [0x52, 0x49, 0x46, 0x46]) && has(8, [0x57, 0x45, 0x42, 0x50])) return "image"; // RIFF....WEBP
  // 영상: ISO-BMFF(mp4/mov)는 offset4 'ftyp'
  if (has(4, [0x66, 0x74, 0x79, 0x70])) return "video"; // ....ftyp
  if (has(0, [0x1a, 0x45, 0xdf, 0xa3])) return "video"; // Matroska/WebM
  return null;
}

/**
 * storage 객체 실제 존재·크기·**매직 바이트** 서버 검증(Range GET). fail-closed:
 * 크기 미상이거나 매직으로 판별한 형식이 선언 타입과 다르면 ok=false.
 * 클라가 업로드 때 지정한 Content-Type 메타는 신뢰하지 않는다(삼순 NO-GO #2).
 */
async function probeObject(
  url: string,
  declaredType: "image" | "video",
): Promise<{ ok: boolean; size: number | null }> {
  try {
    const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-63" } });
    if (!res.ok && res.status !== 206) return { ok: false, size: null };
    const cr = res.headers.get("content-range"); // "bytes 0-63/12345"
    const cl = res.headers.get("content-length");
    let size: number | null = null;
    if (cr) {
      const total = cr.split("/")[1];
      size = total && total !== "*" ? parseInt(total, 10) : null;
    } else if (cl && res.status === 200) {
      // 서버가 Range 무시하고 전체를 준 경우 content-length = 전체 크기
      size = parseInt(cl, 10);
    }
    if (size == null || Number.isNaN(size) || size <= 0) return { ok: false, size: null };
    const buf = new Uint8Array(await res.arrayBuffer());
    const kind = magicMediaType(buf);
    if (kind == null || kind !== declaredType) return { ok: false, size };
    return { ok: true, size };
  } catch {
    return { ok: false, size: null };
  }
}

/** 신뢰 유저의 차단 목록(작성자 필터용) */
async function blockedAuthorIds(viewerId: string): Promise<Set<string>> {
  const { data } = await supabase
    .from("user_blocks")
    .select("blocked_id")
    .eq("blocker_id", viewerId);
  return new Set((data ?? []).map((r) => r.blocked_id as string));
}

// GET: 경기별 active 직관 스토리 목록 (차단 유저 제외)
export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) {
    return NextResponse.json({ error: "gameId 필요" }, { status: 400 });
  }

  // 로그인 유저면 차단 목록으로 필터
  let blocked = new Set<string>();
  const verified = await getVerifiedUserFromRequest(req);
  if (verified) blocked = await blockedAuthorIds(verified.user.id);

  const { data: rows, error } = await supabase
    .from("venue_stories")
    .select(
      "id, game_id, user_id, media_type, media_url, thumb_url, duration_ms, width, height, caption, venue_verified, created_at",
    )
    .eq("game_id", gameId)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  const list = (rows ?? []).filter((r) => !blocked.has(r.user_id as string));
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
      venueVerified: (r.venue_verified as boolean) ?? false,
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

// POST: 직관 스토리 생성 (소유권 바인딩 + 실제 경기/구장/시간 + 지오펜스 + 크기/MIME 서버 검증)
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
  const lat = typeof body.lat === "number" ? body.lat : null;
  const lng = typeof body.lng === "number" ? body.lng : null;
  const accuracy = typeof body.accuracy === "number" ? body.accuracy : null;

  if (!gameId) return NextResponse.json({ error: "gameId 필요" }, { status: 400 });
  if (mediaType !== "video" && mediaType !== "image") {
    return NextResponse.json({ error: "mediaType 오류" }, { status: 400 });
  }
  if (!/^[A-Za-z0-9_-]{8,}$/.test(gameId)) {
    return NextResponse.json({ error: "gameId 형식 오류" }, { status: 400 });
  }

  // 1) 소유권 바인딩: 미디어/썸네일 경로가 업로더 본인 예약 경로 아래여야 함
  const media = parseStoragePublicUrl(mediaUrl);
  if (!media || !ownsPath(media.path, gameId, userId)) {
    return NextResponse.json({ error: "미디어 경로 권한 오류" }, { status: 403 });
  }
  let thumb: { bucket: string; path: string } | null = null;
  if (thumbUrl) {
    thumb = parseStoragePublicUrl(thumbUrl);
    if (!thumb || !ownsPath(thumb.path, gameId, userId)) {
      return NextResponse.json({ error: "썸네일 경로 권한 오류" }, { status: 403 });
    }
  }

  // 2) 실제 경기/구장/시간 검증 (fail-closed)
  const venue = await resolveGameVenue(gameId);
  if (!venue.exists) {
    return NextResponse.json({ error: venue.reason ?? "경기를 확인할 수 없어요" }, { status: 404 });
  }
  if (!venue.uploadOpen || !venue.coord || venue.expiresAtMs == null) {
    return NextResponse.json(
      { error: venue.reason ?? "지금은 올릴 수 없어요" },
      { status: 403 },
    );
  }

  // 3) 지오펜스: 위치 필수 + accuracy 상한 + 반경 (fail-closed 순수 판정 공유)
  const geo = evaluateGeofence({
    lat,
    lng,
    accuracy,
    coord: venue.coord,
    maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M,
  });
  if (!geo.ok) {
    return NextResponse.json({ error: geo.reason ?? "직관 인증이 필요해요" }, { status: 403 });
  }

  // 4) 미디어 객체 실제 존재·크기·매직바이트 서버 검증(fail-closed)
  const probe = await probeObject(mediaUrl, mediaType);
  if (!probe.ok) {
    return NextResponse.json({ error: "업로드된 미디어를 확인할 수 없어요" }, { status: 400 });
  }
  if (probe.size != null && probe.size > VENUE_STORY_MAX_BYTES) {
    return NextResponse.json({ error: "파일이 너무 큽니다 (최대 60MB)" }, { status: 400 });
  }
  // 영상 포스터 썸네일도 이미지로 실검증 — 유효하지 않으면 메타에서 드롭(옵션값)
  let thumbUrlOut: string | null = thumbUrl;
  let thumbBucketOut: string | null = thumb?.bucket ?? null;
  let thumbPathOut: string | null = thumb?.path ?? null;
  if (thumb && thumbUrl) {
    const tprobe = await probeObject(thumbUrl, "image");
    if (!tprobe.ok || (tprobe.size != null && tprobe.size > VENUE_STORY_MAX_BYTES)) {
      thumbUrlOut = null;
      thumbBucketOut = null;
      thumbPathOut = null;
    }
  }
  // 영상 클라 duration 힌트(참고용, 실제 검증은 트랜스코딩 워커 ffprobe)
  if (
    mediaType === "video" &&
    durationMs != null &&
    durationMs > VENUE_STORY_MAX_DURATION_MS + VENUE_STORY_DURATION_TOLERANCE_MS
  ) {
    return NextResponse.json({ error: "영상은 15초 이하만 올릴 수 있어요" }, { status: 400 });
  }

  // 5) 게임당 유저 상한 + insert 원자 처리(RPC advisory lock) — count→insert 레이스 방지(삼순 NO-GO #2)
  // 영상은 pending(720p·duration 검증 후 워커가 active), 사진은 active
  const initialStatus = mediaType === "video" ? "pending" : "active";
  const { data: rpcData, error } = await supabase.rpc("create_venue_story", {
    p_game_id: gameId,
    p_user_id: userId,
    p_media_type: mediaType,
    p_media_url: mediaUrl,
    p_media_bucket: media.bucket,
    p_media_path: media.path,
    p_thumb_url: thumbUrlOut,
    p_thumb_bucket: thumbBucketOut,
    p_thumb_path: thumbPathOut,
    p_duration_ms: durationMs,
    p_width: width,
    p_height: height,
    p_caption: caption,
    p_stadium_name: venue.stadiumName,
    p_status: initialStatus,
    p_expires_at: new Date(venue.expiresAtMs).toISOString(),
    p_max_per_game: VENUE_STORY_MAX_PER_USER_PER_GAME,
  });
  if (error) {
    return NextResponse.json({ error: "저장 실패" }, { status: 500 });
  }
  const result = (rpcData ?? {}) as { ok?: boolean; error?: string; id?: number };
  if (result.ok === false) {
    if (result.error === "limit") {
      return NextResponse.json(
        { error: "이 경기에 올릴 수 있는 개수를 초과했어요" },
        { status: 429 },
      );
    }
    return NextResponse.json({ error: "저장 실패" }, { status: 500 });
  }
  const inserted = { id: result.id };

  return NextResponse.json({ success: true, id: inserted.id, status: initialStatus });
}
