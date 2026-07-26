// 직관 다이어리 미디어(archive) 조회 순수 로직 — S2.
//
// 본인이 올린 사진/영상(status active+archived)을 경기별로 묶어 /my 다이어리에서 열람한다.
// 승·무·패/승률(venue_attendance)과는 별개 데이터라 API 도 분리된다(회귀 격리).
// 이 파일은 DB·네트워크 없는 순수 변환만 담는다(테스트 대상). 조회/권한은 route 가 소유한다.

/** 목록 모드에서 경기 row 에 얹을 썸네일 최대 장수(화면 정의 §3.1: 6장 + `+N`). */
export const VENUE_DIARY_THUMBNAILS_PER_GAME = 6;

/** 목록 모드 시즌 스캔 상한(bounded). 다이어리 인덱스 (user_id, game_date DESC, game_id DESC)로 커버. */
export const VENUE_DIARY_STORY_SCAN_CAP = 500;

/** 상세 모드 경기당 미디어 상한(bounded). 게임당 유저 업로드 상한(10)의 여유 배수. */
export const VENUE_DIARY_MEDIA_PER_GAME_CAP = 60;

/** 상세 모드 경기 단위 댓글 스캔 상한(bounded). 미디어×댓글을 한 번에 IN 조회 후 미디어별로 그룹. */
export const VENUE_DIARY_COMMENTS_SCAN_CAP = 500;

/** venue_stories 에서 다이어리 조회에 필요한 컬럼만. media_url/thumb_url 은 저장된 공개 URL 그대로. */
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

/** 목록 모드 썸네일(경량 — 카운트 옆 미리보기용). */
export interface DiaryMediaThumb {
  id: number;
  mediaType: "video" | "image";
  /** 썸네일 우선, 없으면 원본(사진). 저장된 공개 URL 재사용. */
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
