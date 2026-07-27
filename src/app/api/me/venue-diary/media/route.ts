import { NextRequest, NextResponse } from "next/server";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { resolveGameVenue } from "@/lib/venue-stories/venue-resolve";
import { probeMediaObject } from "@/lib/venue-stories/media-probe";
import { VENUE_IMAGE_TOO_HEAVY_MSG } from "@/lib/venue-stories/media-limits";
import {
  parseStoragePublicUrl,
  ownsPath,
} from "@/lib/venue-stories/storage-path";
import {
  VENUE_STORY_CONSENT_VERSION,
  VENUE_STORY_DURATION_TOLERANCE_MS,
  VENUE_STORY_MAX_BYTES,
  VENUE_STORY_MAX_DURATION_MS,
  VENUE_STORY_MAX_PER_USER_PER_GAME,
  VENUE_STORY_PRIVATE_MEDIA_BUCKET,
  VENUE_STORY_STAGING_BUCKET,
} from "@/lib/venue-stories/types";
import {
  isPrivateVenueBucket,
  signVenueObject,
  signPrivateRefs,
  VENUE_ACTIVE_SIGNED_URL_CACHE_MS,
  VENUE_ACTIVE_SIGNED_URL_TTL_SEC,
} from "@/lib/venue-stories/media-url";
import {
  buildDiaryMediaItem,
  collectDiaryPrivateRefs,
  groupCommentsByStory,
  isValidDiaryGameId,
  loadDiaryCommentBlocks,
  loadDiaryProfilesInBatches,
  paginateDiaryGames,
  parseDiaryCursor,
  resolveDiaryServeRow,
  VENUE_DIARY_LIST_ROW_FETCH,
  VENUE_DIARY_MEDIA_PER_GAME_CAP,
  type DiaryCommentRow,
  type DiaryListCursor,
  type DiaryMediaComment,
  type VenueStoryMediaDbRow,
} from "@/lib/venue-diary/media";
import {
  decideManualDiaryGame,
  VENUE_DIARY_MANUAL_SOURCE,
} from "@/lib/venue-diary/manual-upload";
import { validateVenueVideoRow } from "@/lib/venue-stories/video-validate-server";

// GET 조회 + POST 영상 즉시 ffprobe 검증.
export const maxDuration = 60;

// 다이어리에 노출할 상태(공개 종료 후 보관본 포함). 공개면과 달리 archived 도 본인은 열람.
const DIARY_STATUSES = ["active", "archived"] as const;

// private venue-media는 bucket/path로 signed URL을 발급하고, 레거시 public URL은 그대로 사용한다.
const MEDIA_COLUMNS =
  "id, game_id, game_date, media_type, media_url, media_bucket, media_path, thumb_url, thumb_bucket, thumb_path, caption, venue_verified, attendance_source, stadium_name, status, created_at";

async function resolveDiaryRows(dbRows: VenueStoryMediaDbRow[]) {
  // archived는 expires_at이 과거라 active cap을 적용할 수 없다. 본인 인증 응답에서도
  // 공유 가능한 URL의 잔존창을 짧게 유지하도록 고정 5분 TTL/4분 캐시로 발급한다.
  const signed = await signPrivateRefs(collectDiaryPrivateRefs(dbRows), {
    ttlSec: VENUE_ACTIVE_SIGNED_URL_TTL_SEC,
    cacheMs: VENUE_ACTIVE_SIGNED_URL_CACHE_MS,
  });
  return dbRows.flatMap((row) => {
    const served = resolveDiaryServeRow(row, signed);
    return served == null ? [] : [served];
  });
}

function currentKstYear(): number {
  return Number(
    new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric" }).format(
      new Date(),
    ),
  );
}

/**
 * 종료 경기 직접 추가. GPS를 받지 않으며, 서버가 owner/path/final/file을 검증한 뒤
 * image는 archived, video는 pending→archived로만 저장한다.
 */
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
  const mediaPath = typeof body.mediaPath === "string" ? body.mediaPath : "";
  const thumbUrl = typeof body.thumbUrl === "string" ? body.thumbUrl : null;
  const durationMs =
    typeof body.durationMs === "number" ? Math.round(body.durationMs) : null;
  const width = typeof body.width === "number" ? Math.round(body.width) : null;
  const height = typeof body.height === "number" ? Math.round(body.height) : null;
  const caption =
    typeof body.caption === "string" ? body.caption.trim().slice(0, 200) : null;
  const consentVersion =
    typeof body.consentVersion === "number" ? body.consentVersion : null;

  if (!isValidDiaryGameId(gameId) || gameId.length < 8) {
    return NextResponse.json({ error: "gameId 형식 오류" }, { status: 400 });
  }
  if (mediaType !== "video" && mediaType !== "image") {
    return NextResponse.json({ error: "mediaType 오류" }, { status: 400 });
  }
  if (
    consentVersion == null ||
    !Number.isInteger(consentVersion) ||
    consentVersion !== VENUE_STORY_CONSENT_VERSION
  ) {
    return NextResponse.json(
      { error: "업로드 가이드라인 동의가 필요해요" },
      { status: 400 },
    );
  }

  let media: { bucket: string; path: string };
  if (mediaType === "video") {
    if (!mediaPath || !ownsPath(mediaPath, gameId, userId)) {
      return NextResponse.json({ error: "미디어 경로 권한 오류" }, { status: 403 });
    }
    media = { bucket: VENUE_STORY_STAGING_BUCKET, path: mediaPath };
  } else {
    const parsed = parseStoragePublicUrl(
      mediaUrl,
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    );
    if (
      !parsed ||
      parsed.bucket !== VENUE_STORY_PRIVATE_MEDIA_BUCKET ||
      !ownsPath(parsed.path, gameId, userId)
    ) {
      return NextResponse.json({ error: "미디어 경로 권한 오류" }, { status: 403 });
    }
    media = parsed;
  }

  let thumb: { bucket: string; path: string } | null = null;
  if (thumbUrl) {
    thumb = parseStoragePublicUrl(
      thumbUrl,
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    );
    if (
      !thumb ||
      thumb.bucket !== VENUE_STORY_PRIVATE_MEDIA_BUCKET ||
      !ownsPath(thumb.path, gameId, userId)
    ) {
      return NextResponse.json({ error: "썸네일 경로 권한 오류" }, { status: 403 });
    }
  }

  // 날짜 prefix만 신뢰하지 않고 KBO actual status=final을 매 요청 확인한다.
  const venue = await resolveGameVenue(gameId);
  const eligibility = decideManualDiaryGame(venue);
  if (!eligibility.ok) {
    return NextResponse.json(
      { error: eligibility.error },
      { status: eligibility.status },
    );
  }

  if (mediaType === "image") {
    const readUrl = isPrivateVenueBucket(media.bucket)
      ? await signVenueObject(media.bucket, media.path)
      : null;
    const probe = readUrl
      ? await probeMediaObject(readUrl, "image", VENUE_STORY_MAX_BYTES)
      : { ok: false as const, size: null };
    if (!probe.ok) {
      return NextResponse.json(
        {
          error:
            "reason" in probe && probe.reason === "too_large"
              ? VENUE_IMAGE_TOO_HEAVY_MSG
              : "업로드된 미디어를 확인할 수 없어요",
        },
        { status: 400 },
      );
    }
  }

  let thumbUrlOut: string | null = thumbUrl;
  let thumbBucketOut: string | null = thumb?.bucket ?? null;
  let thumbPathOut: string | null = thumb?.path ?? null;
  if (thumb) {
    const readUrl = await signVenueObject(thumb.bucket, thumb.path);
    const probe = readUrl
      ? await probeMediaObject(readUrl, "image", VENUE_STORY_MAX_BYTES)
      : { ok: false as const, size: null };
    if (!probe.ok) {
      thumbUrlOut = null;
      thumbBucketOut = null;
      thumbPathOut = null;
    }
  }

  if (
    mediaType === "video" &&
    durationMs != null &&
    durationMs > VENUE_STORY_MAX_DURATION_MS + VENUE_STORY_DURATION_TOLERANCE_MS
  ) {
    return NextResponse.json(
      { error: "영상은 15초 이하만 올릴 수 있어요" },
      { status: 400 },
    );
  }

  const finalMediaUrl =
    mediaType === "video"
      ? supabase.storage
          .from(VENUE_STORY_PRIVATE_MEDIA_BUCKET)
          .getPublicUrl(media.path).data.publicUrl
      : mediaUrl;
  // query-guard: bounded -- RPC는 단일 story id/status JSON만 반환
  const { data: rpcData, error } = await supabase.rpc(
    "create_venue_diary_manual_story",
    {
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
      p_expires_at: new Date(venue.expiresAtMs ?? Date.now()).toISOString(),
      p_max_per_game: VENUE_STORY_MAX_PER_USER_PER_GAME,
      p_consent_version: consentVersion,
      p_game_date: venue.gameDate,
    },
  );
  if (error) {
    return NextResponse.json({ error: "저장 실패" }, { status: 500 });
  }
  const result = (rpcData ?? {}) as {
    ok?: boolean;
    error?: string;
    id?: number;
    status?: string;
  };
  if (result.ok === false) {
    if (result.error === "limit") {
      return NextResponse.json(
        { error: "이 경기에 올릴 수 있는 개수를 초과했어요" },
        { status: 429 },
      );
    }
    return NextResponse.json({ error: "저장 실패" }, { status: 500 });
  }
  if (typeof result.id !== "number") {
    return NextResponse.json({ error: "저장 실패" }, { status: 500 });
  }

  if (mediaType === "video") {
    const validated = await validateVenueVideoRow(
      {
        id: result.id,
        media_bucket: media.bucket,
        media_path: media.path,
      },
      { promoteStatus: "archived" },
    );
    if (validated.outcome === "rejected") {
      return NextResponse.json(
        {
          error:
            validated.reason === "duration_exceeded"
              ? "영상은 15초 이하만 올릴 수 있어요"
              : "영상을 확인할 수 없어요. 다시 시도해주세요",
        },
        { status: 400 },
      );
    }
    if (validated.outcome === "already_claimed") {
      const { data: claimed } = await supabase
        .from("venue_stories")
        .select("status")
        .eq("id", result.id)
        .eq("user_id", userId)
        .maybeSingle();
      if (claimed?.status !== "archived") {
        return NextResponse.json(
          { error: "영상을 확인할 수 없어요. 다시 시도해주세요" },
          { status: 400 },
        );
      }
    }
    return NextResponse.json({
      success: true,
      id: result.id,
      status: validated.outcome === "fault" ? "pending" : "archived",
      source: VENUE_DIARY_MANUAL_SOURCE,
    });
  }

  return NextResponse.json({
    success: true,
    id: result.id,
    status: "archived",
    source: VENUE_DIARY_MANUAL_SOURCE,
  });
}

/** 조회한 유저 id 집합으로 profiles 를 한 번에 로드해 authorFor 클로저를 만든다. */
async function buildAuthorLookup(
  userIds: string[],
): Promise<((userId: string) => DiaryMediaComment["author"]) | null> {
  const map = new Map<string, DiaryMediaComment["author"]>();
  if (userIds.length > 0) {
    const profiles = await loadDiaryProfilesInBatches(userIds, async (batch) => {
      // query-guard: bounded -- Production URL 안전 상한 100 UUID 배치
      const { data, error } = await supabase
        .from("profiles")
        .select("id, nickname, avatar_url, team_id")
        .in("id", batch);
      return error ? null : (data ?? []);
    });
    if (profiles == null) return null;
    for (const p of profiles) {
      map.set(p.id as string, {
        nickname: (p.nickname as string) ?? null,
        avatarUrl: (p.avatar_url as string) ?? null,
        teamId: (p.team_id as number) ?? null,
      });
    }
  }
  return (userId: string) =>
    map.get(userId) ?? { nickname: null, avatarUrl: null, teamId: null };
}

/**
 * 본인 전용 직관 다이어리 미디어.
 *  - gameId 없음(목록 모드): 시즌 내 경기별 미디어 카운트 + 최신 썸네일 소수.
 *  - gameId 있음(상세 모드): 그 경기 미디어 전체 + 미디어별 읽기전용 댓글.
 * 둘 다 user_id = 본인만 조회한다(타인 user_id 조회 불가). 공개 RLS 없음(service_role + 본인 검증).
 */
export async function GET(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  if (!verified) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }
  const userId = verified.user.id;

  const gameId = req.nextUrl.searchParams.get("gameId");
  if (gameId != null) {
    if (!isValidDiaryGameId(gameId)) {
      return NextResponse.json({ error: "gameId 형식 오류" }, { status: 400 });
    }
    return detailResponse(userId, gameId);
  }

  const nowYear = currentKstYear();
  const requestedSeason = Number(req.nextUrl.searchParams.get("season") ?? nowYear);
  if (
    !Number.isInteger(requestedSeason) ||
    requestedSeason < 2020 ||
    requestedSeason > nowYear
  ) {
    return NextResponse.json({ error: "season 형식 오류" }, { status: 400 });
  }
  const cursorParam = req.nextUrl.searchParams.get("cursor");
  const cursor = parseDiaryCursor(cursorParam);
  if (cursorParam != null && cursor == null) {
    return NextResponse.json({ error: "cursor 형식 오류" }, { status: 400 });
  }
  return listResponse(userId, requestedSeason, cursor);
}

/** 목록 모드: 시즌 내 본인 미디어(active+archived)를 경기별로 묶어 카운트+썸네일 소수. */
async function listResponse(
  userId: string,
  season: number,
  cursor: DiaryListCursor | null,
): Promise<NextResponse> {
  // query-guard: bounded -- 게임당 유저 업로드 상한 10을 이용한 경기 단위 keyset over-fetch
  let query = supabase
    .from("venue_stories")
    .select(MEDIA_COLUMNS)
    .eq("user_id", userId)
    .in("status", DIARY_STATUSES)
    .gte("game_date", `${season}-01-01`)
    .lt("game_date", `${season + 1}-01-01`);
  if (cursor) {
    query = query.or(
      `game_date.lt.${cursor.gameDate},and(game_date.eq.${cursor.gameDate},game_id.lt.${cursor.gameId})`,
    );
  }
  const { data, error } = await query
    .order("game_date", { ascending: false })
    .order("game_id", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(VENUE_DIARY_LIST_ROW_FETCH);

  if (error) {
    return NextResponse.json({ error: "미디어 조회 실패" }, { status: 500 });
  }

  const dbRows = (data ?? []) as VenueStoryMediaDbRow[];
  const rows = await resolveDiaryRows(dbRows);
  if (rows.length !== dbRows.length) {
    return NextResponse.json({ error: "미디어 URL 발급 실패" }, { status: 503 });
  }
  const { games, nextCursor, hasMore } = paginateDiaryGames(rows);

  return NextResponse.json(
    { season, games, nextCursor, hasMore },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

/** 상세 모드: 특정 경기의 본인 미디어 전체 + 미디어별 읽기전용 댓글(미삭제만). */
async function detailResponse(userId: string, gameId: string): Promise<NextResponse> {
  // query-guard: bounded -- 본인+경기 한정, 경기당 미디어 상한 스캔(created_at ASC = 캐러셀 정순)
  const { data, error } = await supabase
    .from("venue_stories")
    .select(MEDIA_COLUMNS)
    .eq("user_id", userId)
    .eq("game_id", gameId)
    .in("status", DIARY_STATUSES)
    .order("created_at", { ascending: true })
    .limit(VENUE_DIARY_MEDIA_PER_GAME_CAP);

  if (error) {
    return NextResponse.json({ error: "미디어 조회 실패" }, { status: 500 });
  }

  const dbRows = (data ?? []) as VenueStoryMediaDbRow[];
  const rows = await resolveDiaryRows(dbRows);
  if (rows.length !== dbRows.length) {
    return NextResponse.json({ error: "미디어 URL 발급 실패" }, { status: 503 });
  }
  const items = rows.map(buildDiaryMediaItem);
  // story별 최신 100개 + exact total. 전역 cap이 댓글 많은 한 story 때문에 다른 story를
  // 굶기던 경로를 제거한다.
  const commentBlocks = await loadDiaryCommentBlocks(
    items.map((item) => item.id),
    async (storyId, limit) => {
      const [list, count] = await Promise.all([
        // query-guard: bounded -- story별 최신 댓글 목록 상한(라이브 계약 동일)
        supabase
          .from("venue_story_comments")
          .select("id, story_id, user_id, content, created_at")
          .eq("story_id", storyId)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(limit),
        // query-guard: bounded -- exact count 전용(head=true, 행 전송 없음)
        supabase
          .from("venue_story_comments")
          .select("id", { count: "exact", head: true })
          .eq("story_id", storyId)
          .is("deleted_at", null),
      ]);
      if (list.error || count.error) return null;
      return {
        rowsDesc: (list.data ?? []) as DiaryCommentRow[],
        total: count.count ?? list.data?.length ?? 0,
      };
    },
  );
  if (commentBlocks == null) {
    return NextResponse.json({ error: "댓글 조회 실패" }, { status: 500 });
  }
  const commentRows = commentBlocks.flatMap((block) => block.rowsDesc);

  const authorFor = await buildAuthorLookup([
    ...new Set(commentRows.map((row) => row.user_id)),
  ]);
  if (authorFor == null) {
    return NextResponse.json({ error: "댓글 조회 실패" }, { status: 500 });
  }
  const commentsByStory = groupCommentsByStory(commentRows, authorFor);

  const media = items.map((item, index) => ({
    ...item,
    comments: commentsByStory.get(item.id) ?? [],
    commentTotal: commentBlocks[index]?.total ?? 0,
  }));

  return NextResponse.json(
    { gameId, media },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
