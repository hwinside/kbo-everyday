import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { resolveGameVenue } from "@/lib/venue-stories/venue-resolve";
import { evaluateGeofence } from "@/lib/venue-stories/geofence";
import { probeMediaObject } from "@/lib/venue-stories/media-probe";
import {
  parseStoragePublicUrl as parseVenueStorageUrl,
  ownsPath as ownsVenuePath,
} from "@/lib/venue-stories/storage-path";
import {
  VENUE_STORY_MAX_DURATION_MS,
  VENUE_STORY_DURATION_TOLERANCE_MS,
  VENUE_STORY_MAX_BYTES,
  VENUE_STORY_MAX_PER_USER_PER_GAME,
  VENUE_GEOFENCE_MAX_ACCURACY_M,
  VENUE_STORY_CONSENT_VERSION,
  type VenueStory,
} from "@/lib/venue-stories/types";

export const maxDuration = 30;

/** 우리 Supabase storage 공개 URL 검증 + { bucket, path } 파싱(canonicalization 우회 차단) */
function parseStoragePublicUrl(url: string): { bucket: string; path: string } | null {
  return parseVenueStorageUrl(url, process.env.NEXT_PUBLIC_SUPABASE_URL);
}

/** 소유권 바인딩: canonical path 가 venue-stories/{gameId}/{userId}/{파일} 규격이고 gameId/userId 일치 */
function ownsPath(path: string, gameId: string, userId: string): boolean {
  return ownsVenuePath(path, gameId, userId);
}

/** 신뢰 유저의 차단 목록(작성자 필터용). 조회 실패 시 null → 호출부가 fail-closed 처리. */
async function blockedAuthorIds(viewerId: string): Promise<Set<string> | null> {
  const { data, error } = await supabase
    .from("user_blocks")
    .select("blocked_id")
    .eq("blocker_id", viewerId);
  if (error) return null;
  return new Set((data ?? []).map((r) => r.blocked_id as string));
}

// GET: 경기별 active 직관 스토리 목록 (차단 유저 제외)
export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) {
    return NextResponse.json({ error: "gameId 필요" }, { status: 400 });
  }

  // 로그인 유저면 차단 목록으로 필터. 차단 조회 실패는 fail-closed(노출 차단).
  let blocked = new Set<string>();
  const verified = await getVerifiedUserFromRequest(req);
  if (verified) {
    const b = await blockedAuthorIds(verified.user.id);
    if (b == null) {
      return NextResponse.json({ error: "조회 실패" }, { status: 500 });
    }
    blocked = b;
  }

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
  const consentVersion = typeof body.consentVersion === "number" ? body.consentVersion : null;

  if (!gameId) return NextResponse.json({ error: "gameId 필요" }, { status: 400 });
  // UGC 가이드라인 동의 서버 필수 검증 — **현재 버전과 정확히 일치하는 유한 정수**만 허용
  // (device-local 상속·API 직호출·future-version 위조 audit 전부 차단).
  if (
    consentVersion == null ||
    !Number.isInteger(consentVersion) ||
    consentVersion !== VENUE_STORY_CONSENT_VERSION
  ) {
    return NextResponse.json({ error: "업로드 가이드라인 동의가 필요해요" }, { status: 400 });
  }
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

  // 4) 미디어 객체 실제 존재·크기·매직바이트 서버 검증(fail-closed, maxBytes 선제 차단)
  const probe = await probeMediaObject(mediaUrl, mediaType, VENUE_STORY_MAX_BYTES);
  if (!probe.ok) {
    const msg = probe.reason === "too_large" ? "파일이 너무 큽니다 (최대 60MB)" : "업로드된 미디어를 확인할 수 없어요";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  // 영상 포스터 썸네일도 이미지로 실검증 — 유효하지 않으면 메타에서 드롭(옵션값)
  let thumbUrlOut: string | null = thumbUrl;
  let thumbBucketOut: string | null = thumb?.bucket ?? null;
  let thumbPathOut: string | null = thumb?.path ?? null;
  if (thumb && thumbUrl) {
    const tprobe = await probeMediaObject(thumbUrl, "image", VENUE_STORY_MAX_BYTES);
    if (!tprobe.ok) {
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
  // 즉시 노출(하린아빠 스펙): 영상도 바로 active + needs_transcode=true(720p 최적화·ffprobe 사후 검증), 사진도 active
  const initialStatus = "active";
  const needsTranscode = mediaType === "video";
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
    p_consent_version: consentVersion,
    p_needs_transcode: needsTranscode,
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
