import { NextRequest, NextResponse } from "next/server";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import {
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

// 미디어 조회만 수행하는 읽기 전용 API — 무거운 트랜스코딩/검증 없음.
export const maxDuration = 30;

// 다이어리에 노출할 상태(공개 종료 후 보관본 포함). 공개면과 달리 archived 도 본인은 열람.
const DIARY_STATUSES = ["active", "archived"] as const;

// private venue-media는 bucket/path로 signed URL을 발급하고, 레거시 public URL은 그대로 사용한다.
const MEDIA_COLUMNS =
  "id, game_id, game_date, media_type, media_url, media_bucket, media_path, thumb_url, thumb_bucket, thumb_path, caption, venue_verified, stadium_name, status, created_at";

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

/** 조회한 유저 id 집합으로 profiles 를 한 번에 로드해 authorFor 클로저를 만든다. */
async function buildAuthorLookup(
  userIds: string[],
): Promise<((userId: string) => DiaryMediaComment["author"]) | null> {
  const map = new Map<string, DiaryMediaComment["author"]>();
  if (userIds.length > 0) {
    // query-guard: bounded -- 경기 미디어 상한×story별 댓글 상한에서 나온 유니크 user id
    const { data: profiles, error } = await supabase
      .from("profiles")
      .select("id, nickname, avatar_url, team_id")
      .in("id", userIds);
    if (error) return null;
    for (const p of profiles ?? []) {
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
