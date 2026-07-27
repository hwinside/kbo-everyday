// 직관 다이어리 미디어(archive) 조회 순수 로직 — S2.
//
// 본인이 올린 사진/영상(status active+archived)을 경기별로 묶어 /my 다이어리에서 열람한다.
// 승·무·패/승률(venue_attendance)과는 별개 데이터라 API 도 분리된다(회귀 격리).
// 이 파일은 DB·네트워크 없는 순수 변환만 담는다(테스트 대상). 조회/권한은 route 가 소유한다.

import {
  isPublicServablePrivateBucket,
  resolveServeUrl,
  type VenueMediaRef,
} from "@/lib/venue-stories/media-url";
import { VENUE_STORY_MAX_PER_USER_PER_GAME } from "@/lib/venue-stories/types";

/** 목록 모드에서 경기 row 에 얹을 썸네일 최대 장수(화면 정의 §3.1: 6장 + `+N`). */
export const VENUE_DIARY_THUMBNAILS_PER_GAME = 6;

/** 목록 한 페이지 경기 수. */
export const VENUE_DIARY_GAMES_PER_PAGE = 30;

/**
 * 경기 단위 페이지 완전성 상한.
 * 게임당 유저 업로드 상한 10개이므로 (30+1)경기×10 + 다음 경기 존재 확인 1행이면
 * 첫 30경기의 count를 절단하지 않고 hasMore를 판정할 수 있다.
 */
export const VENUE_DIARY_LIST_ROW_FETCH =
  (VENUE_DIARY_GAMES_PER_PAGE + 1) * VENUE_STORY_MAX_PER_USER_PER_GAME + 1;

/** 상세 모드 경기당 미디어 상한(bounded). 게임당 유저 업로드 상한(10)의 여유 배수. */
export const VENUE_DIARY_MEDIA_PER_GAME_CAP = 60;

/** 상세 모드 story별 최신 댓글 목록 상한(라이브 댓글 계약과 동일). */
export const VENUE_DIARY_COMMENT_LIST_LIMIT = 100;

/** 목록 커서 — 마지막으로 완전히 반환한 경기의 (game_date, game_id). */
export interface DiaryListCursor {
  gameDate: string;
  gameId: string;
}

export function isValidDiaryGameId(gameId: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(gameId);
}

export function encodeDiaryCursor(cursor: DiaryListCursor): string {
  return `${cursor.gameDate}|${cursor.gameId}`;
}

export function parseDiaryCursor(raw: string | null | undefined): DiaryListCursor | null {
  if (!raw) return null;
  const split = raw.indexOf("|");
  if (split <= 0 || split === raw.length - 1) return null;
  const gameDate = raw.slice(0, split);
  const gameId = raw.slice(split + 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate) || !isValidDiaryGameId(gameId)) return null;
  return { gameDate, gameId };
}

/**
 * venue_stories 원본 행(DB 조회 그대로). private venue-media 행은 media_url 이 공개 접근 불가한
 * 저장 URL(getPublicUrl 형태)이므로 서빙 전 bucket/path 로 signed URL 을 발급해야 한다.
 */
export interface VenueStoryMediaDbRow {
  id: number;
  game_id: string;
  game_date: string | null;
  media_type: "video" | "image";
  media_url: string | null;
  media_bucket: string | null;
  media_path: string | null;
  thumb_url: string | null;
  thumb_bucket: string | null;
  thumb_path: string | null;
  caption: string | null;
  venue_verified: boolean | null;
  stadium_name: string | null;
  status: string;
  created_at: string;
}

/** 다이어리 조회에 필요한 컬럼(서빙 URL 해석 완료 상태). media_url 은 서빙 가능한 serve URL. */
export interface VenueStoryMediaRow {
  id: number;
  game_id: string;
  game_date: string | null;
  media_type: "video" | "image";
  media_url: string;
  thumb_url: string | null;
  caption: string | null;
  venue_verified: boolean | null;
  stadium_name: string | null;
  status: string;
  created_at: string;
}

/** 다이어리 서빙은 공개 트레이와 동일: venue-media 만 mint, venue-staging(미검증)은 차단. */
const DIARY_SERVE_OPTS = { publicServe: true } as const;

/**
 * DB 원본 행 + 서명 맵 → serve URL 해석한 행. fail-closed:
 *  - media serve URL 이 null(private 서명 실패/경로 누락/staging 차단)이면 행 자체를 드롭(null 반환)
 *    → 깨진 미디어를 다이어리에 노출하지 않는다.
 *  - thumb serve URL 은 null 허용(목록은 pickThumbUrl 이 image 원본으로 폴백, 상세는 null 허용).
 * 레거시 공개 버킷(videos/photos)은 resolveServeUrl 이 저장 URL 그대로 반환.
 */
export function resolveDiaryServeRow(
  row: VenueStoryMediaDbRow,
  signed: Map<string, string | null>,
): VenueStoryMediaRow | null {
  const mediaUrl = resolveServeUrl(
    { bucket: row.media_bucket, path: row.media_path, url: row.media_url },
    signed,
    DIARY_SERVE_OPTS,
  );
  if (mediaUrl == null) return null; // fail-closed: 본문 미디어 미해석 → 생략
  const thumbUrl = resolveServeUrl(
    { bucket: row.thumb_bucket, path: row.thumb_path, url: row.thumb_url },
    signed,
    DIARY_SERVE_OPTS,
  );
  return {
    id: row.id,
    game_id: row.game_id,
    game_date: row.game_date,
    media_type: row.media_type,
    media_url: mediaUrl,
    thumb_url: thumbUrl,
    caption: row.caption,
    venue_verified: row.venue_verified,
    stadium_name: row.stadium_name,
    status: row.status,
    created_at: row.created_at,
  };
}

/** DB 원본 행들에서 다이어리 서명이 허용된 venue-media ref만 수집한다(staging mint 금지). */
export function collectDiaryPrivateRefs(
  rows: readonly VenueStoryMediaDbRow[],
): VenueMediaRef[] {
  const refs: VenueMediaRef[] = [];
  for (const row of rows) {
    if (isPublicServablePrivateBucket(row.media_bucket) && row.media_path) {
      refs.push({ bucket: row.media_bucket, path: row.media_path });
    }
    if (isPublicServablePrivateBucket(row.thumb_bucket) && row.thumb_path) {
      refs.push({ bucket: row.thumb_bucket, path: row.thumb_path });
    }
  }
  return refs;
}

/** 목록 모드 썸네일(경량 — 카운트 옆 미리보기용). */
export interface DiaryMediaThumb {
  id: number;
  mediaType: "video" | "image";
  /** 썸네일 우선, 없으면 사진 원본 serve URL. */
  thumbUrl: string;
  venueVerified: boolean;
}

/** 목록 모드 경기별 미디어 요약(경기 row 에 오버레이). */
export interface DiaryGameMediaGroup {
  gameId: string;
  gameDate: string | null;
  stadiumName: string | null;
  counts: { image: number; video: number; total: number };
  /** 최신순 최대 VENUE_DIARY_THUMBNAILS_PER_GAME 장. */
  thumbnails: DiaryMediaThumb[];
}

/** 상세 모드 미디어 1건(캐러셀). */
export interface DiaryMediaItem {
  id: number;
  gameId: string;
  mediaType: "video" | "image";
  mediaUrl: string;
  thumbUrl: string | null;
  caption: string | null;
  venueVerified: boolean;
  stadiumName: string | null;
  createdAt: string;
}

/** 상세 모드 읽기전용 댓글 1건(작성자/운영 삭제분 제외 후). */
export interface DiaryMediaComment {
  id: number;
  storyId: number;
  userId: string;
  content: string;
  createdAt: string;
  author: {
    nickname: string | null;
    avatarUrl: string | null;
    teamId: number | null;
  };
}

/** 썸네일 URL 선택: 썸네일 있으면 그것, 없으면 사진 원본. 영상이고 썸네일 없으면 표시할 게 없어 제외. */
function pickThumbUrl(row: VenueStoryMediaRow): string | null {
  if (row.thumb_url) return row.thumb_url;
  if (row.media_type === "image") return row.media_url;
  return null;
}

/**
 * 목록 모드 그룹핑 — game_date DESC, game_id DESC, created_at DESC 로 정렬된 rows 를
 * 경기(game_id)별로 묶어 카운트 + 최신 썸네일 소수를 만든다. 입력 정렬을 그대로 보존(안정).
 */
export function groupStoriesByGame(
  rows: readonly VenueStoryMediaRow[],
  thumbnailsPerGame: number = VENUE_DIARY_THUMBNAILS_PER_GAME,
): DiaryGameMediaGroup[] {
  const order: string[] = [];
  const byGame = new Map<string, DiaryGameMediaGroup>();

  for (const row of rows) {
    let group = byGame.get(row.game_id);
    if (!group) {
      group = {
        gameId: row.game_id,
        gameDate: row.game_date,
        stadiumName: row.stadium_name,
        counts: { image: 0, video: 0, total: 0 },
        thumbnails: [],
      };
      byGame.set(row.game_id, group);
      order.push(row.game_id);
    }

    group.counts.total += 1;
    if (row.media_type === "image") group.counts.image += 1;
    else group.counts.video += 1;

    // 최신순 상한 장수까지만 썸네일 첨부(표시 가능한 URL 이 있을 때만).
    const thumbUrl = pickThumbUrl(row);
    if (thumbUrl && group.thumbnails.length < thumbnailsPerGame) {
      group.thumbnails.push({
        id: row.id,
        mediaType: row.media_type,
        thumbUrl,
        venueVerified: row.venue_verified ?? false,
      });
    }
  }

  return order.map((gameId) => byGame.get(gameId)!);
}

/** raw story over-fetch를 경기 단위 페이지로 확정한다. */
export function paginateDiaryGames(
  rows: readonly VenueStoryMediaRow[],
  gamesPerPage: number = VENUE_DIARY_GAMES_PER_PAGE,
): {
  games: DiaryGameMediaGroup[];
  nextCursor: string | null;
  hasMore: boolean;
} {
  const grouped = groupStoriesByGame(rows);
  const hasMore = grouped.length > gamesPerPage;
  const games = hasMore ? grouped.slice(0, gamesPerPage) : grouped;
  const last = games.at(-1);
  return {
    games,
    hasMore,
    nextCursor:
      hasMore && last?.gameDate
        ? encodeDiaryCursor({ gameDate: last.gameDate, gameId: last.gameId })
        : null,
  };
}

/** 상세 모드 미디어 변환(created_at ASC 정렬 입력 가정 — 캐러셀 정순). */
export function buildDiaryMediaItem(row: VenueStoryMediaRow): DiaryMediaItem {
  return {
    id: row.id,
    gameId: row.game_id,
    mediaType: row.media_type,
    mediaUrl: row.media_url,
    thumbUrl: row.thumb_url,
    caption: row.caption,
    venueVerified: row.venue_verified ?? false,
    stadiumName: row.stadium_name,
    createdAt: row.created_at,
  };
}

/** 댓글 raw row(미삭제만 조회된 상태) 를 story_id 별로 묶고 각 그룹을 정순(오래된→최신)으로. */
export interface DiaryCommentRow {
  id: number;
  story_id: number;
  user_id: string;
  content: string;
  created_at: string;
}

export interface DiaryStoryCommentBlock {
  storyId: number;
  rowsDesc: DiaryCommentRow[];
  total: number;
}

/**
 * 댓글은 story별로 독립 조회한다. 한 story의 대량 댓글이 다른 story의 목록을 굶기지 않으며,
 * 호출부는 각 조회에서 deleted_at IS NULL + 최신 limit + exact total을 보장한다.
 */
export async function loadDiaryCommentBlocks(
  storyIds: readonly number[],
  fetchStory: (
    storyId: number,
    limit: number,
  ) => Promise<{ rowsDesc: DiaryCommentRow[]; total: number } | null>,
): Promise<DiaryStoryCommentBlock[] | null> {
  const blocks = await Promise.all(
    storyIds.map(async (storyId) => {
      const result = await fetchStory(storyId, VENUE_DIARY_COMMENT_LIST_LIMIT);
      return result == null ? null : { storyId, ...result };
    }),
  );
  if (blocks.some((block) => block == null)) return null;
  return blocks.filter((block): block is DiaryStoryCommentBlock => block != null);
}

export function groupCommentsByStory(
  rowsDesc: readonly DiaryCommentRow[],
  authorFor: (userId: string) => DiaryMediaComment["author"],
): Map<number, DiaryMediaComment[]> {
  const byStory = new Map<number, DiaryMediaComment[]>();
  // DESC 입력을 unshift 로 정순 누적(채팅처럼 오래된→최신).
  for (const row of rowsDesc) {
    const list = byStory.get(row.story_id) ?? [];
    list.unshift({
      id: row.id,
      storyId: row.story_id,
      userId: row.user_id,
      content: row.content,
      createdAt: row.created_at,
      author: authorFor(row.user_id),
    });
    byStory.set(row.story_id, list);
  }
  return byStory;
}
