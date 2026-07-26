import { NextRequest, NextResponse } from "next/server";
import { getVerifiedUserFromRequest } from "@/lib/auth/verified-user";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { VENUE_STORY_ARCHIVE_BUCKET } from "@/lib/venue-stories/types";
import {
  buildDiaryDetail,
  buildDiaryList,
  parseDiaryCursor,
  DIARY_STATUSES,
  VENUE_DIARY_SIGNED_URL_TTL_SEC,
  type DiaryCommentRow,
  type DiaryListDeps,
  type DiaryDetailDeps,
  type DiaryMediaComment,
  type VenueStoryMediaRow,
} from "@/lib/venue-diary/media";

// 미디어 조회만 수행하는 읽기 전용 API — 무거운 트랜스코딩/검증 없음.
export const maxDuration = 30;

// 다이어리 조회 컬럼. media_url/thumb_url(공개 URL) 은 active 전용, archived 는 bucket/path 로 signed URL 발급.
const MEDIA_COLUMNS =
  "id, game_id, game_date, media_type, media_url, thumb_url, media_bucket, media_path, thumb_bucket, thumb_path, caption, venue_verified, stadium_name, status, created_at";

function currentKstYear(): number {
  return Number(
    new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric" }).format(
      new Date(),
    ),
  );
}

/** private archive 버킷 경로들 → 짧은 signed URL 맵(path→url). 최상위 오류면 null(5xx 승격). */
async function signArchiveUrls(paths: string[]): Promise<Map<string, string> | null> {
  const { data, error } = await supabase.storage
    .from(VENUE_STORY_ARCHIVE_BUCKET)
    .createSignedUrls(paths, VENUE_DIARY_SIGNED_URL_TTL_SEC);
  if (error || !data) return null;
  const map = new Map<string, string>();
  for (const row of data) {
    if (!row.error && row.path && row.signedUrl) map.set(row.path, row.signedUrl);
  }
  return map;
}

/** 조회한 유저 id 집합으로 profiles 를 한 번에 로드해 authorFor 클로저를 만든다. */
async function resolveAuthors(
  userIds: string[],
): Promise<((userId: string) => DiaryMediaComment["author"]) | null> {
  const map = new Map<string, DiaryMediaComment["author"]>();
  if (userIds.length > 0) {
    // query-guard: bounded -- 댓글 목록 상한에서 나온 유저 id IN 조회(스토리≤60 × 100 상한의 유니크 유저)
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

const listDeps: DiaryListDeps = {
  async fetchListRows({ userId, season, cursor, limit }) {
    // query-guard: bounded -- 다이어리 인덱스(user_id, game_date DESC, game_id DESC) 위 경기 단위 keyset 페이지(경기당 미디어 ≤10 → 완전성 보장 상한)
    let q = supabase
      .from("venue_stories")
      .select(MEDIA_COLUMNS)
      .eq("user_id", userId)
      .in("status", DIARY_STATUSES)
      .gte("game_date", `${season}-01-01`)
      .lt("game_date", `${season + 1}-01-01`);
    if (cursor) {
      // (game_date, game_id) DESC keyset — 커서보다 "이후"(더 과거) 경기만.
      q = q.or(
        `game_date.lt.${cursor.gameDate},and(game_date.eq.${cursor.gameDate},game_id.lt.${cursor.gameId})`,
      );
    }
    const { data, error } = await q
      .order("game_date", { ascending: false })
      .order("game_id", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (error) return null;
    return (data ?? []) as VenueStoryMediaRow[];
  },
  signArchiveUrls,
};

const detailDeps: DiaryDetailDeps = {
  async fetchGameMedia({ userId, gameId, limit }) {
    // query-guard: bounded -- 본인+경기 한정, 경기당 미디어 상한 스캔(created_at ASC = 캐러셀 정순)
    const { data, error } = await supabase
      .from("venue_stories")
      .select(MEDIA_COLUMNS)
      .eq("user_id", userId)
      .eq("game_id", gameId)
      .in("status", DIARY_STATUSES)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(limit);
    if (error) return null;
    return (data ?? []) as VenueStoryMediaRow[];
  },
  async fetchStoryComments({ storyId, limit }) {
    // story별 최신 limit개(정순 반전) + 전체 total — 전역 limit 이 특정 story 를 굶기지 않도록 story별 bounded(기존 라이브 계약 동일).
    const [listRes, countRes] = await Promise.all([
      // query-guard: bounded -- 스토리당 댓글은 최신 100개 UI 목록만 제공한다(라이브 댓글 계약과 동일)
      supabase
        .from("venue_story_comments")
        .select("id, story_id, user_id, content, created_at")
        .eq("story_id", storyId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(limit),
      // query-guard: bounded -- head:true 카운트 전용(행 전송 없음)
      supabase
        .from("venue_story_comments")
        .select("id", { count: "exact", head: true })
        .eq("story_id", storyId)
        .is("deleted_at", null),
    ]);
    if (listRes.error || countRes.error) return null;
    return {
      rowsDesc: (listRes.data ?? []) as DiaryCommentRow[],
      total: countRes.count ?? (listRes.data?.length ?? 0),
    };
  },
  resolveAuthors,
  signArchiveUrls,
};

/**
 * 본인 전용 직관 다이어리 미디어.
 *  - gameId 없음(목록 모드): 경기 단위 keyset 페이지 — 경기별 정확 카운트 + 최신 썸네일 6장 + nextCursor/hasMore.
 *  - gameId 있음(상세 모드): 그 경기 미디어 전체 + 미디어(story)별 읽기전용 댓글(최신 100개 + total).
 * 둘 다 user_id=본인만 조회(공개 RLS 없음). archived 미디어는 private archive 버킷 signed URL 로만 서빙.
 */
export async function GET(req: NextRequest) {
  const verified = await getVerifiedUserFromRequest(req);
  const userId = verified?.user.id ?? null;

  const gameId = req.nextUrl.searchParams.get("gameId");
  if (gameId != null) {
    const result = await buildDiaryDetail(detailDeps, { userId, gameId });
    return NextResponse.json(result.body, {
      status: result.ok ? 200 : result.status,
      headers: result.ok ? { "Cache-Control": "private, no-store" } : undefined,
    });
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
  const cursor = parseDiaryCursor(req.nextUrl.searchParams.get("cursor"));
  const result = await buildDiaryList(listDeps, { userId, season: requestedSeason, cursor });
  return NextResponse.json(result.body, {
    status: result.ok ? 200 : result.status,
    headers: result.ok ? { "Cache-Control": "private, no-store" } : undefined,
  });
}
