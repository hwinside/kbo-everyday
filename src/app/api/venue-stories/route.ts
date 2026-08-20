import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { getVerifiedUserFromRequest, confirmEmailPrivilege } from "@/lib/auth/verified-user";
import { resolveGameVenue } from "@/lib/venue-stories/venue-resolve";
import { evaluateGeofence, isVenueUploadBlocked } from "@/lib/venue-stories/geofence";
import { probeMediaObject } from "@/lib/venue-stories/media-probe";
import { VENUE_IMAGE_TOO_HEAVY_MSG } from "@/lib/venue-stories/media-limits";
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
  VENUE_STORY_STAGING_BUCKET,
  VENUE_STORY_PRIVATE_MEDIA_BUCKET,
  type VenueStory,
} from "@/lib/venue-stories/types";
import {
  resolveServeUrl,
  signVenueObject,
  isPrivateVenueBucket,
  signActivePrivateRefs,
} from "@/lib/venue-stories/media-url";
import { decideListAuth } from "@/lib/venue-stories/auth-consent";
import { validateVenueVideoRow } from "@/lib/venue-stories/video-validate-server";
import { canBypassVenueGeofenceForQa, isAdminEmail } from "@/lib/admin/admin-users";
import { withAdminViewCounts, sumViewCountsByStory } from "@/lib/venue-stories/view-tracking";
import { completeRequestedUploadStatuses } from "@/lib/venue-stories/composer-helpers";

// 영상 즉시 검증(다운로드 최대 50MiB + ffprobe)을 요청 안에서 수행
export const maxDuration = 60;

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
  const refreshStoryIdParam = req.nextUrl.searchParams.get("refreshStoryId");
  const refreshStoryId =
    refreshStoryIdParam == null || refreshStoryIdParam === ""
      ? null
      : Number(refreshStoryIdParam);
  if (
    refreshStoryId != null &&
    (!Number.isSafeInteger(refreshStoryId) || refreshStoryId <= 0)
  ) {
    return NextResponse.json({ error: "refreshStoryId가 올바르지 않습니다" }, { status: 400 });
  }

  // 로그인 유저면 차단 목록으로 필터. 차단 조회 실패는 fail-closed(노출 차단).
  // invalid bearer 는 익명 강등 금지(차단 필터가 꺼짐) → 401 거부(삼순 09:44 #3).
  let blocked = new Set<string>();
  const verified = await getVerifiedUserFromRequest(req);
  const auth = decideListAuth(!!req.headers.get("authorization"), verified?.user.id ?? null);
  if (auth.kind === "reject") {
    return NextResponse.json({ error: "인증이 유효하지 않습니다" }, { status: 401 });
  }
  if (auth.kind === "user") {
    const b = await blockedAuthorIds(auth.userId);
    if (b == null) {
      return NextResponse.json({ error: "조회 실패" }, { status: 500 });
    }
    blocked = b;
  }

  // 업로드 직후 낙관 카드의 pending/active/removed 상태 조회. 일반 목록은 active 전용이라
  // removed 를 pending 과 구분할 수 없으므로, 인증된 업로더 본인 행만 최대 게임당 상한(10개) 조회한다.
  const requestedStatusIds = [
    ...new Set(
      (req.nextUrl.searchParams.get("statusIds") ?? "")
        .split(",")
        .map((value) => Number(value))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ].slice(0, VENUE_STORY_MAX_PER_USER_PER_GAME);
  let uploadStatuses: Array<{ id: number; status: string }> = [];
  if (requestedStatusIds.length > 0) {
    if (auth.kind !== "user") {
      return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
    }
    // query-guard: bounded -- statusIds 는 위에서 게임당 업로드 상한 10개로 제한
    const { data: statusRows, error: statusError } = await supabase
      .from("venue_stories")
      .select("id, status")
      .eq("game_id", gameId)
      .eq("user_id", auth.userId)
      .in("id", requestedStatusIds);
    if (statusError) {
      return NextResponse.json({ error: "상태 조회 실패" }, { status: 500 });
    }
    uploadStatuses = (statusRows ?? []).map((row) => ({
      id: row.id as number,
      status: row.status as string,
    }));
    // cleanup cron 이 removed 행을 storage 정리 뒤 DELETE 할 수 있다. 요청한 본인 낙관 id가
    // 조회 결과에서 사라진 경우도 terminal failure 로 종결해 pending 카드가 무한 잔류하지 않게 한다.
    // 다른 사용자의 id와 실제 미존재 id는 모두 missing 이라 소유권/존재 여부는 노출하지 않는다.
    uploadStatuses = completeRequestedUploadStatuses(requestedStatusIds, uploadStatuses);
  }

  // query-guard: bounded -- 일반 목록은 created_at DESC 100행, URL refresh는 exact id 1행으로 아래 분기에서 제한
  let storiesQuery = supabase
    .from("venue_stories")
    .select(
      "id, game_id, user_id, media_type, media_url, media_bucket, media_path, thumb_url, thumb_bucket, thumb_path, duration_ms, width, height, caption, venue_verified, created_at, expires_at",
    )
    .eq("game_id", gameId)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString());
  storiesQuery =
    refreshStoryId == null
      ? storiesQuery.order("created_at", { ascending: false }).limit(100)
      : storiesQuery.eq("id", refreshStoryId).limit(1);
  const { data: rows, error } = await storiesQuery;

  if (error) {
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }

  const list = (rows ?? []).filter((r) => !blocked.has(r.user_id as string));

  // A안 A1: 공개 트레이/뷰어는 private venue-media 만 서버 발급 signed URL 로 서빙한다.
  // 한 요청의 모든 미노출 media/thumb 경로를 버킷별 배치로 묶어 발급 콜 수를 최소화한다.
  // 레거시 공개 버킷(videos/photos) 행은 저장된 공개 URL 그대로(A3 이관 전까지 혼재 허용).
  //
  // 삼순 blocker 2: 공개 signed URL 은 짧은 TTL(≤5m)이고 각 행의 expires_at 잔여시간
  // 이하로 cap 한다. 같은 effective TTL 은 묶어 배치 발급하고 캐시는 TTL 보다 짧게 둔다.
  const signed = await signActivePrivateRefs(
    list.flatMap((r) => [
      {
        bucket: r.media_bucket as string | null,
        path: r.media_path as string | null,
        expiresAt: r.expires_at as string | null,
      },
      {
        bucket: r.thumb_bucket as string | null,
        path: r.thumb_path as string | null,
        expiresAt: r.expires_at as string | null,
      },
    ]),
    // 뷰어 단건 갱신은 기존 최대 4분 캐시를 재사용하면 남은 유효시간이 짧을 수 있다.
    // 매 진입/tick마다 새 URL을 mint해 21번째 영상·61번째 사진·5분 pause 경계를 닫는다.
    refreshStoryId == null ? undefined : { cache: new Map() },
  );

  // 뷰어 체류 중 URL-only 재발급. 목록/순번/현재 ID를 다시 commit하지 않도록 현재 active 행의
  // signed URL만 반환한다. removed·expired·차단·서명 실패는 null(fail-closed).
  if (refreshStoryId != null) {
    const row = list[0];
    if (!row) return NextResponse.json({ urlRefresh: null });
    const mediaUrl = resolveServeUrl(
      {
        bucket: row.media_bucket as string | null,
        path: row.media_path as string | null,
        url: (row.media_url as string) ?? null,
      },
      signed,
      { publicServe: true },
    );
    if (mediaUrl == null) return NextResponse.json({ urlRefresh: null });
    return NextResponse.json({
      urlRefresh: {
        id: row.id as number,
        mediaUrl,
        thumbUrl: resolveServeUrl(
          {
            bucket: row.thumb_bucket as string | null,
            path: row.thumb_path as string | null,
            url: (row.thumb_url as string) ?? null,
          },
          signed,
          { publicServe: true },
        ),
      },
    });
  }

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

  // fail-closed: private ref 서명 실패/venue-staging(공개 mint 불가)면 media 가 null → 해당 story 제외.
  // 레거시 공개 행은 저장 URL 로 null 이 아니므로 그대로 노출(호환). raw 저장 경로 폴백 없음.
  const stories: VenueStory[] = [];
  for (const r of list) {
    const prof = profileMap.get(r.user_id as string);
    const mediaUrl = resolveServeUrl(
      {
        bucket: r.media_bucket as string | null,
        path: r.media_path as string | null,
        url: (r.media_url as string) ?? null,
      },
      signed,
      { publicServe: true },
    );
    // private 서빙 실패/차단 → 공개 노출 금지(story 제외). raw 저장 URL 폴백 절대 금지.
    if (mediaUrl == null) continue;
    stories.push({
      id: r.id as number,
      gameId: r.game_id as string,
      userId: r.user_id as string,
      mediaType: r.media_type as "video" | "image",
      mediaUrl,
      thumbUrl: resolveServeUrl(
        {
          bucket: r.thumb_bucket as string | null,
          path: r.thumb_path as string | null,
          url: (r.thumb_url as string) ?? null,
        },
        signed,
        { publicServe: true },
      ),
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
    });
  }

  // 조회수는 일단 관리자만(하린아빠 2026-07-29) — #735 게시글 배지와 동일하게 관리자 세션에만
  // clickCount/impressionCount 를 붙인다. 일반·익명 응답에는 필드 자체 부재(withAdminViewCounts 가 보장,
  // 회귀는 qa:venue-story-views 클라 스모크가 고정). 조회 실패는 목록 응답을 막지 않는다(부가 지표).
  const isAdmin =
    auth.kind === "user" &&
    !!verified &&
    (await confirmEmailPrivilege(verified.user.email, verified.token, isAdminEmail));
  let viewCounts = new Map<number, { click: number; impression: number }>();
  if (isAdmin && stories.length > 0) {
    // query-guard: bounded -- 목록은 최대 100 스토리, active 스토리 수명(종료+24h)상 스토리당 daily 행 수일 이내
    const { data: viewRows, error: viewError } = await supabase
      .from("venue_story_view_daily")
      .select("story_id, kind, view_count")
      .in("story_id", stories.map((s) => s.id));
    if (!viewError) viewCounts = sumViewCountsByStory(viewRows);
  }

  return NextResponse.json({ stories: withAdminViewCounts(stories, isAdmin, viewCounts), uploadStatuses });
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
  // 영상: private staging 경로(venue-stories/{gameId}/{userId}/{file}) — 공개 URL 아님(B+①)
  const mediaPath = typeof body.mediaPath === "string" ? body.mediaPath : "";
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
  //  - video: staging 경로 직접 검증(strict allowlist 규격 + gameId/userId 일치)
  //  - image: 공개 URL canonical 파싱 후 검증
  let media: { bucket: string; path: string };
  if (mediaType === "video") {
    if (!mediaPath || !ownsPath(mediaPath, gameId, userId)) {
      return NextResponse.json({ error: "미디어 경로 권한 오류" }, { status: 403 });
    }
    media = { bucket: VENUE_STORY_STAGING_BUCKET, path: mediaPath };
  } else {
    const parsed = parseStoragePublicUrl(mediaUrl);
    if (!parsed || !ownsPath(parsed.path, gameId, userId)) {
      return NextResponse.json({ error: "미디어 경로 권한 오류" }, { status: 403 });
    }
    media = parsed;
  }
  let thumb: { bucket: string; path: string } | null = null;
  if (thumbUrl) {
    thumb = parseStoragePublicUrl(thumbUrl);
    if (!thumb || !ownsPath(thumb.path, gameId, userId)) {
      return NextResponse.json({ error: "썸네일 경로 권한 오류" }, { status: 403 });
    }
  }

  // 2) 실제 경기/구장/시간 검증 (fail-closed)
  // 관리자 QA 계정은 지오펜스와 마찬가지로 업로드 시간창(종료·마감)도 우회한다 —
  // 종료 경기에도 QA 업로드가 가능해야 한다(하린아빠 7/25 04:38 리포트: 종료 경기 올리기 비활성).
  // 좌표·gameDate 미상은 QA도 fail-closed(경기 자체가 없거나 미매핑이면 검증 불가).
  // 지오펜스·시간창 우회 = 권한 부여 → 서버 권위 확인(삼순 필수③).
  const qaBypass = await confirmEmailPrivilege(
    verified.user.email,
    verified.token,
    canBypassVenueGeofenceForQa,
  );
  const venue = await resolveGameVenue(gameId);
  if (!venue.exists) {
    return NextResponse.json({ error: venue.reason ?? "경기를 확인할 수 없어요" }, { status: 404 });
  }
  if (!venue.coord || venue.expiresAtMs == null || !venue.gameDate) {
    return NextResponse.json(
      { error: venue.reason ?? "지금은 올릴 수 없어요" },
      { status: 403 },
    );
  }
  // 관리자 QA는 시간창(시작 전·종료 후)만 우회. **취소 경기는 관리자도 fail-closed**
  // — 클라와 동일한 isVenueUploadBlocked 판정(단일 소스, 삼순 #832 왕복2).
  if (
    isVenueUploadBlocked({
      uploadOpen: venue.uploadOpen,
      gateKind: venue.gateKind,
      privileged: qaBypass,
    })
  ) {
    return NextResponse.json(
      { error: venue.reason ?? "지금은 올릴 수 없어요" },
      { status: 403 },
    );
  }

  // 3) 지오펜스: 일반 유저는 fail-closed. 관리자 QA 계정도 실제 GPS를 통과한 경우만
  // 직관 이력에 포함하고, 구장 밖 우회 업로드는 admin_qa로 분리한다(승률 오염 방지).
  const geo = evaluateGeofence({
    lat,
    lng,
    accuracy,
    coord: venue.coord,
    maxAccuracy: VENUE_GEOFENCE_MAX_ACCURACY_M,
  });
  // qaBypass 는 위(2단계)에서 이미 계산됨 — 지오펜스/시간창 우회 동일 관리자 권한
  if (!geo.ok && !qaBypass) {
    return NextResponse.json({ error: geo.reason ?? "직관 인증이 필요해요" }, { status: 403 });
  }
  const attendanceSource = geo.ok ? "story_geofence" : "admin_qa";

  // 4) 이미지 객체 실제 존재·크기·매직바이트 서버 검증(fail-closed, maxBytes 선제 차단).
  // 영상은 private signed URL Range probe가 Vercel에서 응답을 끝내지 않아 60초 timeout을
  // 만들 수 있다. 아래 step 6이 service_role 직접 download(50MiB 상한) + ffprobe를 수행하므로
  // 영상은 그 단일 권위 검증 경로만 사용한다(검증 전 pending/비노출 불변식 유지).
  if (mediaType === "image") {
    // A안 A1: private venue-media 저장 이미지는 공개 URL 이 없으므로 서버 signed URL 을 발급해 probe 한다.
    // 레거시 공개 버킷은 기존대로 mediaUrl(공개) 그대로 fetch.
    let imageReadUrl = mediaUrl;
    if (isPrivateVenueBucket(media.bucket)) {
      const signed = await signVenueObject(media.bucket, media.path);
      if (!signed) {
        return NextResponse.json({ error: "업로드된 미디어를 확인할 수 없어요" }, { status: 400 });
      }
      imageReadUrl = signed;
    }
    const probe = await probeMediaObject(imageReadUrl, mediaType, VENUE_STORY_MAX_BYTES);
    if (!probe.ok) {
      // MB 숫자 노출 금지(삼순 #813 blocker) — Composer가 data.error를 그대로 노출한다.
      // 이 branch는 사진 전용. 영상 초과분은 step 6 서버 검증(download ≤ 50MiB 강제)이
      // fault→pending 비노출로 fail-close하며 크기 관련 유저 문구를 내보내지 않는다.
      const msg =
        probe.reason === "too_large"
          ? VENUE_IMAGE_TOO_HEAVY_MSG
          : "업로드된 미디어를 확인할 수 없어요";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  }
  // 영상 포스터 썸네일도 이미지로 실검증 — 유효하지 않으면 메타에서 드롭(옵션값)
  let thumbUrlOut: string | null = thumbUrl;
  let thumbBucketOut: string | null = thumb?.bucket ?? null;
  let thumbPathOut: string | null = thumb?.path ?? null;
  if (thumb && thumbUrl) {
    // private 버킷 포스터도 signed URL 로 probe(레거시 공개 버킷은 공개 URL 그대로).
    let thumbReadUrl: string | null = thumbUrl;
    if (isPrivateVenueBucket(thumb.bucket)) {
      thumbReadUrl = await signVenueObject(thumb.bucket, thumb.path);
    }
    const tprobe = thumbReadUrl
      ? await probeMediaObject(thumbReadUrl, "image", VENUE_STORY_MAX_BYTES)
      : { ok: false as const, size: null };
    if (!tprobe.ok) {
      thumbUrlOut = null;
      thumbBucketOut = null;
      thumbPathOut = null;
    }
  }
  // 영상 클라 duration 힌트는 빠른 거부용일 뿐 — 서버 권위 검증은 아래 즉시 ffprobe(B+①)
  if (
    mediaType === "video" &&
    durationMs != null &&
    durationMs > VENUE_STORY_MAX_DURATION_MS + VENUE_STORY_DURATION_TOLERANCE_MS
  ) {
    return NextResponse.json({ error: "영상은 15초 이하만 올릴 수 있어요" }, { status: 400 });
  }

  // 5) 게임당 유저 상한 + insert 원자 처리(RPC advisory lock) — count→insert 레이스 방지(삼순 NO-GO #2)
  // B+①(삼순 09:44 #1): 영상은 **pending**(목록·원본 URL 미노출)으로 넣고 같은 요청 안에서
  // 즉시 ffprobe 검증 → 통과 시에만 active 승격(원본 공개) + 720p 는 백그라운드. 사진은 바로 active.
  const isVideo = mediaType === "video";
  const initialStatus = isVideo ? "pending" : "active";
  const needsTranscode = isVideo;
  // 영상 media_url 은 승격 후 공개될 최종 URL(공개 videos 버킷, 같은 path) — pending 동안 객체 미존재(비노출)
  // 영상 media_url 은 승격 후 private venue-media 객체를 가리키는 durable 참조값(NOT NULL 충족용).
  // 서빙은 media_bucket 기준으로 signed URL 을 발급하므로 이 값 자체는 공개 URL 로 사용되지 않는다.
  const finalMediaUrl = isVideo
    ? supabase.storage.from(VENUE_STORY_PRIVATE_MEDIA_BUCKET).getPublicUrl(media.path).data.publicUrl
    : mediaUrl;
  const { data: rpcData, error } = await supabase.rpc("create_venue_story_v2", {
    p_game_id: gameId,
    p_user_id: userId,
    p_media_type: mediaType,
    p_media_url: finalMediaUrl,
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
    p_attendance_source: attendanceSource,
    p_game_date: venue.gameDate,
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

  // 6) 영상 즉시 검증(B+①): 같은 요청 안에서 ffprobe 구조·15초 서버 권위 검증.
  //  - 통과 → 원본 공개 버킷 승격 + pending→active CAS(즉시 공개)
  //  - 실패 → pending→removed CAS + staging 정리(노출 0)
  //  - fault → pending 유지(검증 약화 금지) — 30분 복구 워커가 처리, 목록엔 계속 미노출
  if (isVideo && typeof inserted.id === "number") {
    const validated = await validateVenueVideoRow({
      id: inserted.id,
      media_bucket: media.bucket,
      media_path: media.path,
    });
    if (validated.outcome === "rejected") {
      const msg =
        validated.reason === "duration_exceeded"
          ? "영상은 15초 이하만 올릴 수 있어요"
          : "영상을 확인할 수 없어요. 다시 시도해주세요";
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    if (validated.outcome === "promoted" || validated.outcome === "already_claimed") {
      return NextResponse.json({ success: true, id: inserted.id, status: "active" });
    }
    // fault: pending 유지 — 복구 워커가 처리(최대 30분+지연). 업로드 자체는 접수 성공.
    return NextResponse.json({ success: true, id: inserted.id, status: "pending" });
  }

  return NextResponse.json({ success: true, id: inserted.id, status: initialStatus });
}
