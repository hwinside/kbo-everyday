import { NextRequest, NextResponse } from "next/server";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import {
  buildDiaryMediaItem,
  groupCommentsByStory,
  groupStoriesByGame,
  VENUE_DIARY_COMMENTS_SCAN_CAP,
  VENUE_DIARY_MEDIA_PER_GAME_CAP,
  VENUE_DIARY_STORY_SCAN_CAP,
  type DiaryCommentRow,
  type DiaryMediaComment,
  type VenueStoryMediaRow,
} from "@/lib/venue-diary/media";

// 미디어 조회만 수행하는 읽기 전용 API — 무거운 트랜스코딩/검증 없음.
export const maxDuration = 30;

// 다이어리에 노출할 상태(공개 종료 후 보관본 포함). 공개면과 달리 archived 도 본인은 열람.
const DIARY_STATUSES = ["active", "archived"] as const;

// 다이어리 조회에 필요한 컬럼(공개 URL·메타). 저장된 media_url/thumb_url 은 공개 버킷 URL 그대로 재사용.
const MEDIA_COLUMNS =
  "id, game_id, game_date, media_type, media_url, thumb_url, caption, venue_verified, stadium_name, status, created_at";

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
): Promise<(userId: string) => DiaryMediaComment["author"]> {
  const map = new Map<string, DiaryMediaComment["author"]>();
  if (userIds.length > 0) {
    // query-guard: bounded -- 댓글 스캔 상한에서 나온 유저 id IN 조회(최대 500행)
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, nickname, avatar_url, team_id")
      .in("id", userIds);
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
  return listResponse(userId, requestedSeason);
}

/** 목록 모드: 시즌 내 본인 미디어(active+archived)를 경기별로 묶어 카운트+썸네일 소수. */
async function listResponse(userId: string, season: number): Promise<NextResponse> {
  // query-guard: bounded -- 다이어리 인덱스(user_id, game_date DESC, game_id DESC) + 시즌 범위 + 상한 스캔
  const { data, error } = await supabase
    .from("venue_stories")
    .select(MEDIA_COLUMNS)
    .eq("user_id", userId)
    .in("status", DIARY_STATUSES)
    .gte("game_date", `${season}-01-01`)
    .lt("game_date", `${season + 1}-01-01`)
    .order("game_date", { ascending: false })
    .order("game_id", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(VENUE_DIARY_STORY_SCAN_CAP);

  if (error) {
    return NextResponse.json({ error: "미디어 조회 실패" }, { status: 500 });
  }

  const rows = (data ?? []) as VenueStoryMediaRow[];
  const games = groupStoriesByGame(rows);

  return NextResponse.json(
    { season, games },
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

  const rows = (data ?? []) as VenueStoryMediaRow[];
  const items = rows.map(buildDiaryMediaItem);
  const storyIds = items.map((item) => item.id);

  // 댓글: 미디어(스토리)별 미삭제(작성자/운영 삭제분 제외)만. 미디어를 한 번에 IN 조회 후 그룹.
  let commentRows: DiaryCommentRow[] = [];
  if (storyIds.length > 0) {
    // query-guard: bounded -- 경기 미디어(≤60)의 미삭제 댓글을 스캔 상한(500)까지만
    const { data: comments, error: commentError } = await supabase
      .from("venue_story_comments")
      .select("id, story_id, user_id, content, created_at")
      .in("story_id", storyIds)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(VENUE_DIARY_COMMENTS_SCAN_CAP);
    if (commentError) {
      return NextResponse.json({ error: "댓글 조회 실패" }, { status: 500 });
    }
    commentRows = (comments ?? []) as DiaryCommentRow[];
  }

  const authorFor = await buildAuthorLookup([
    ...new Set(commentRows.map((row) => row.user_id)),
  ]);
  const commentsByStory = groupCommentsByStory(commentRows, authorFor);

  const media = items.map((item) => ({
    ...item,
    comments: commentsByStory.get(item.id) ?? [],
  }));

  return NextResponse.json(
    { gameId, media },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
