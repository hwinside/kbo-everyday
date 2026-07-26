import assert from "node:assert/strict";
import {
  buildDiaryMediaItem,
  groupCommentsByStory,
  groupStoriesByGame,
  VENUE_DIARY_THUMBNAILS_PER_GAME,
  type DiaryCommentRow,
  type DiaryMediaComment,
  type VenueStoryMediaRow,
} from "../../src/lib/venue-diary/media";

function media(overrides: Partial<VenueStoryMediaRow> = {}): VenueStoryMediaRow {
  return {
    id: 1,
    game_id: "20260724LGLT0",
    game_date: "2026-07-24",
    media_type: "image",
    media_url: "https://cdn.example/photos/a.jpg",
    thumb_url: null,
    caption: null,
    venue_verified: true,
    stadium_name: "잠실",
    status: "active",
    created_at: "2026-07-24T10:00:00Z",
    ...overrides,
  };
}

// 1) 경기별 그룹핑: 카운트(image/video/total) + 썸네일 상한 + 입력 순서 보존
{
  const rows: VenueStoryMediaRow[] = [
    // 최신 경기(7-24): 이미지 2 + 영상 1
    media({ id: 11, game_id: "G2", game_date: "2026-07-24", media_type: "image" }),
    media({ id: 12, game_id: "G2", game_date: "2026-07-24", media_type: "video", thumb_url: "https://cdn/thumb12.jpg" }),
    media({ id: 13, game_id: "G2", game_date: "2026-07-24", media_type: "image" }),
    // 이전 경기(7-19): 이미지 1
    media({ id: 21, game_id: "G1", game_date: "2026-07-19", media_type: "image" }),
  ];
  const groups = groupStoriesByGame(rows);
  assert.equal(groups.length, 2, "경기 2개로 그룹");
  assert.equal(groups[0].gameId, "G2", "입력 순서(최신 먼저) 보존");
  assert.deepEqual(groups[0].counts, { image: 2, video: 1, total: 3 }, "카운트 정확");
  assert.equal(groups[0].thumbnails.length, 3, "표시 가능 썸네일 3장");
  assert.equal(groups[1].counts.total, 1, "두 번째 경기 총 1");
  assert.equal(groups[1].gameDate, "2026-07-19");
}

// 2) 영상+썸네일 없음 → 썸네일 목록에서 제외되지만 카운트에는 포함
{
  const rows: VenueStoryMediaRow[] = [
    media({ id: 1, game_id: "G", media_type: "video", thumb_url: null }),
    media({ id: 2, game_id: "G", media_type: "image", media_url: "https://cdn/p2.jpg", thumb_url: null }),
  ];
  const [group] = groupStoriesByGame(rows);
  assert.equal(group.counts.total, 2, "카운트는 영상 포함 2");
  assert.equal(group.thumbnails.length, 1, "썸네일 없는 영상은 미리보기 제외");
  assert.equal(group.thumbnails[0].id, 2);
  assert.equal(group.thumbnails[0].thumbUrl, "https://cdn/p2.jpg", "사진은 원본 URL로 썸네일 대체");
}

// 3) 썸네일 상한 초과 시 최신순 상한까지만
{
  const rows: VenueStoryMediaRow[] = Array.from({ length: 10 }, (_, i) =>
    media({ id: 100 + i, game_id: "G", media_type: "image", media_url: `https://cdn/${i}.jpg` }),
  );
  const [group] = groupStoriesByGame(rows);
  assert.equal(group.counts.total, 10);
  assert.equal(
    group.thumbnails.length,
    VENUE_DIARY_THUMBNAILS_PER_GAME,
    "썸네일은 상한(6)까지만",
  );
  assert.equal(group.thumbnails[0].id, 100, "최신(입력 첫)부터 채움");
}

// 4) 상세 item 변환: null-safe(venue_verified null → false), 필드 매핑
{
  const item = buildDiaryMediaItem(
    media({ id: 7, media_type: "video", media_url: "https://cdn/v.mp4", thumb_url: "https://cdn/vt.jpg", venue_verified: null, caption: "직관!" }),
  );
  assert.equal(item.id, 7);
  assert.equal(item.mediaType, "video");
  assert.equal(item.mediaUrl, "https://cdn/v.mp4");
  assert.equal(item.thumbUrl, "https://cdn/vt.jpg");
  assert.equal(item.caption, "직관!");
  assert.equal(item.venueVerified, false, "null → false fail-safe");
}

// 5) 댓글 그룹핑: story_id 별 분리 + DESC 입력을 정순(오래된→최신)으로 반전 + 작성자 매핑
{
  const authorFor = (userId: string): DiaryMediaComment["author"] =>
    userId === "u1"
      ? { nickname: "팬A", avatarUrl: null, teamId: 1 }
      : { nickname: null, avatarUrl: null, teamId: null };
  // DB 는 created_at DESC 로 내려줌
  const rowsDesc: DiaryCommentRow[] = [
    { id: 3, story_id: 10, user_id: "u1", content: "세번째", created_at: "2026-07-24T10:03:00Z" },
    { id: 2, story_id: 10, user_id: "u2", content: "두번째", created_at: "2026-07-24T10:02:00Z" },
    { id: 1, story_id: 10, user_id: "u1", content: "첫번째", created_at: "2026-07-24T10:01:00Z" },
    { id: 9, story_id: 20, user_id: "u1", content: "다른스토리", created_at: "2026-07-24T10:05:00Z" },
  ];
  const byStory = groupCommentsByStory(rowsDesc, authorFor);
  const s10 = byStory.get(10)!;
  assert.equal(s10.length, 3);
  assert.deepEqual(s10.map((c) => c.content), ["첫번째", "두번째", "세번째"], "정순 반전");
  assert.equal(s10[0].author.nickname, "팬A", "작성자 매핑");
  assert.equal(s10[1].author.nickname, null, "미매핑 유저는 익명 형태");
  assert.equal(byStory.get(20)!.length, 1, "다른 스토리 분리");
}

console.log("venue-diary-media-smoke: OK");
