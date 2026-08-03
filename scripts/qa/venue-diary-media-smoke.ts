import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildDiaryMediaItem,
  collectDiaryPrivateRefs,
  groupCommentsByStory,
  groupStoriesByGame,
  isValidDiaryGameId,
  loadDiaryCommentBlocks,
  loadDiaryProfilesInBatches,
  paginateDiaryGames,
  parseDiaryCursor,
  resolveDiaryServeRow,
  VENUE_DIARY_GAMES_PER_PAGE,
  VENUE_DIARY_LIST_ROW_FETCH,
  VENUE_DIARY_PROFILE_BATCH_SIZE,
  VENUE_DIARY_THUMBNAILS_PER_GAME,
  type DiaryCommentRow,
  type DiaryMediaComment,
  type VenueStoryMediaDbRow,
  type VenueStoryMediaRow,
} from "../../src/lib/venue-diary/media";
import { venueSignCacheKey } from "../../src/lib/venue-stories/media-url";
import {
  decideManualDiaryGame,
  manualSeasonOfGameDate,
  VENUE_DIARY_MANUAL_SEASONS,
  VENUE_DIARY_MANUAL_SOURCE,
} from "../../src/lib/venue-diary/manual-upload";

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
    attendance_source: "story_geofence",
    stadium_name: "잠실",
    status: "active",
    created_at: "2026-07-24T10:00:00Z",
    ...overrides,
  };
}

function dbMedia(overrides: Partial<VenueStoryMediaDbRow> = {}): VenueStoryMediaDbRow {
  return {
    ...media(),
    media_bucket: "photos",
    media_path: "venue-stories/G/u/a.jpg",
    thumb_bucket: null,
    thumb_path: null,
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
  assert.equal(item.source, "story_geofence", "durable source 응답");
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

// 6) A1 private-first 서빙 통합: venue-media signed, 레거시 public 유지, staging/failure fail-closed
{
  const privateRow = dbMedia({
    id: 30,
    media_url: "https://stored.invalid/venue-media/a.jpg",
    media_bucket: "venue-media",
    media_path: "venue-stories/G/u/a.jpg",
    thumb_url: "https://stored.invalid/venue-media/a-thumb.jpg",
    thumb_bucket: "venue-media",
    thumb_path: "venue-stories/G/u/a-thumb.jpg",
  });
  assert.deepEqual(
    collectDiaryPrivateRefs([privateRow]),
    [
      { bucket: "venue-media", path: "venue-stories/G/u/a.jpg" },
      { bucket: "venue-media", path: "venue-stories/G/u/a-thumb.jpg" },
    ],
    "private media/thumb ref 수집",
  );

  const signed = new Map<string, string | null>([
    [venueSignCacheKey("venue-media", "venue-stories/G/u/a.jpg"), "signed://media"],
    [venueSignCacheKey("venue-media", "venue-stories/G/u/a-thumb.jpg"), "signed://thumb"],
  ]);
  const servedPrivate = resolveDiaryServeRow(privateRow, signed);
  assert.equal(servedPrivate?.media_url, "signed://media", "venue-media 원본은 signed URL");
  assert.equal(servedPrivate?.thumb_url, "signed://thumb", "venue-media 썸네일은 signed URL");

  const legacy = dbMedia({
    id: 31,
    media_url: "https://cdn.example/photos/legacy.jpg",
    media_bucket: "photos",
    thumb_url: null,
  });
  assert.equal(
    resolveDiaryServeRow(legacy, new Map())?.media_url,
    "https://cdn.example/photos/legacy.jpg",
    "A3 전 레거시 public URL 병존",
  );

  assert.equal(
    resolveDiaryServeRow(
      (() => {
        const staging = dbMedia({
        id: 32,
        media_bucket: "venue-staging",
        media_path: "venue-stories/G/u/unverified.mp4",
        });
        assert.deepEqual(
          collectDiaryPrivateRefs([staging]),
          [],
          "venue-staging은 signed URL 발급 대상에도 포함하지 않음",
        );
        return staging;
      })(),
      new Map([
        [
          venueSignCacheKey("venue-staging", "venue-stories/G/u/unverified.mp4"),
          "signed://must-not-serve",
        ],
      ]),
    ),
    null,
    "venue-staging은 본인 다이어리에서도 미검증 상태라 차단",
  );
  assert.equal(
    resolveDiaryServeRow(privateRow, new Map()),
    null,
    "private 서명 실패·누락은 저장 URL 폴백 없이 fail-closed",
  );
}

// 7) owner/API/RLS 계약: bearer 검증 + 본인 user_id 고정, 클라이언트 direct SELECT 차단
{
  const route = readFileSync(
    new URL("../../src/app/api/me/venue-diary/media/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /getVerifiedUserFromRequest\(req\)/, "검증된 bearer 사용자만 허용");
  assert.equal(
    route.match(/\.eq\("user_id", userId\)/g)?.length,
    3,
    "목록·상세·영상 claim 확인 모두 verified owner로 고정",
  );
  assert.doesNotMatch(
    route,
    /searchParams\.get\(["']userId["']\)/,
    "타인 userId를 입력받는 우회 경로 없음",
  );
  assert.match(
    route,
    /ttlSec:\s*VENUE_ACTIVE_SIGNED_URL_TTL_SEC[\s\S]*cacheMs:\s*VENUE_ACTIVE_SIGNED_URL_CACHE_MS/,
    "private signed URL은 5분 TTL/4분 캐시 계약",
  );

  const schema = readFileSync(
    new URL("../../supabase/migrations/20260718_venue_stories.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    schema,
    /ALTER TABLE venue_stories ENABLE ROW LEVEL SECURITY/,
    "venue_stories RLS 활성",
  );
  assert.doesNotMatch(
    schema,
    /CREATE POLICY[\s\S]*?ON venue_stories/i,
    "클라이언트 정책 0개 — service role API만 접근",
  );
}

// 7) raw 500행 경계 회귀: 경기 단위 keyset으로 55경기×10건 count 누락 없이 순회
{
  const all = Array.from({ length: 55 }, (_, gameIndex) =>
    Array.from({ length: 10 }, (_, mediaIndex) =>
      media({
        id: gameIndex * 100 + mediaIndex,
        game_id: `G${String(55 - gameIndex).padStart(3, "0")}`,
        game_date: "2026-07-01",
        created_at: `2026-07-01T10:${String(mediaIndex).padStart(2, "0")}:00Z`,
      }),
    ),
  )
    .flat()
    .sort(
      (a, b) =>
        b.game_date!.localeCompare(a.game_date!) ||
        b.game_id.localeCompare(a.game_id) ||
        b.created_at.localeCompare(a.created_at) ||
        b.id - a.id,
    );

  const seen = new Map<string, number>();
  let cursor: ReturnType<typeof parseDiaryCursor> = null;
  for (let page = 0; page < 10; page++) {
    const candidates = all
      .filter(
        (row) =>
          cursor == null ||
          row.game_date! < cursor.gameDate ||
          (row.game_date === cursor.gameDate && row.game_id < cursor.gameId),
      )
      .slice(0, VENUE_DIARY_LIST_ROW_FETCH);
    const result = paginateDiaryGames(candidates);
    for (const game of result.games) seen.set(game.gameId, game.counts.total);
    if (!result.hasMore || !result.nextCursor) break;
    cursor = parseDiaryCursor(result.nextCursor);
    assert.ok(cursor, "nextCursor 파싱");
  }
  assert.equal(VENUE_DIARY_GAMES_PER_PAGE, 30);
  assert.equal(seen.size, 55, "51번째 이후 경기까지 누락 0");
  assert.ok([...seen.values()].every((count) => count === 10), "경기 경계 count 절단 0");
}

// 8) 댓글은 story별 bounded: 600댓글 story가 이웃 5댓글 story를 굶기지 않음
async function testStoryCommentBounds() {
  const calls: Array<{ storyId: number; limit: number }> = [];
  const blocks = await loadDiaryCommentBlocks([10, 11], async (storyId, limit) => {
    calls.push({ storyId, limit });
    const total = storyId === 10 ? 600 : 5;
    return {
      rowsDesc: Array.from({ length: Math.min(total, limit) }, (_, index) => ({
        id: storyId * 1000 + index,
        story_id: storyId,
        user_id: "u",
        content: `c${index}`,
        created_at: `2026-07-01T10:${String(index % 60).padStart(2, "0")}:00Z`,
      })),
      total,
    };
  });
  assert.ok(blocks);
  assert.deepEqual(calls, [
    { storyId: 10, limit: 100 },
    { storyId: 11, limit: 100 },
  ]);
  assert.equal(blocks[0].rowsDesc.length, 100);
  assert.equal(blocks[0].total, 600);
  assert.equal(blocks[1].rowsDesc.length, 5, "다른 story starvation 0");
  assert.equal(blocks[1].total, 5);
}

// 10) actual-wiring: 10 story×100 unique commenter도 profile `.in()`은 100 UUID씩만 호출
async function testProfileBatchBounds() {
  const userIds = Array.from(
    { length: 10 },
    (_, story) =>
      Array.from({ length: 100 }, (_, author) => `u-${story}-${author}`),
  ).flat();
  const calls: string[][] = [];
  const profiles = await loadDiaryProfilesInBatches(userIds, async (batch) => {
    calls.push(batch);
    return batch.map((id) => ({ id }));
  });
  assert.equal(VENUE_DIARY_PROFILE_BATCH_SIZE, 100);
  assert.equal(calls.length, 10, "1,000 unique UUID를 10개 batch로 분리");
  assert.ok(calls.every((batch) => batch.length <= 100), "모든 .in batch ≤100");
  assert.equal(profiles?.length, 1_000, "batch 결과 병합 누락 0");

  const deduped = await loadDiaryProfilesInBatches(
    [...userIds.slice(0, 100), ...userIds.slice(0, 100)],
    async (batch) => batch,
  );
  assert.equal(deduped?.length, 100, "중복 UUID는 호출 전 제거");
  assert.equal(
    await loadDiaryProfilesInBatches(["u"], async () => null),
    null,
    "한 batch 실패도 fail-closed",
  );
}

assert.equal(isValidDiaryGameId("20260726WOHT0"), true);
assert.equal(isValidDiaryGameId("G_1-2"), true);
assert.equal(isValidDiaryGameId("G,or(status.eq.active)"), false, "PostgREST filter injection 차단");
assert.equal(parseDiaryCursor("2026-07-01|G,or(status.eq.active)"), null);

// 9) 과거 직접 추가: 허용 시즌의 실제 final만, durable source/비공개/전체 보존 상한 계약
// 허용 시즌은 SSOT 배열을 그대로 순회한다 — 시즌을 늘려도 테스트가 같이 움직이고,
// 배열에서 특정 시즌을 빼면 여기서 RED 가 난다.
assert.ok(
  VENUE_DIARY_MANUAL_SEASONS.includes(2025) &&
    VENUE_DIARY_MANUAL_SEASONS.includes(2026),
  "2025·2026 직접 추가 허용 시즌",
);
for (const season of VENUE_DIARY_MANUAL_SEASONS) {
  assert.deepEqual(
    decideManualDiaryGame({
      exists: true,
      gameDate: `${season}-07-24`,
      status: "final",
    }),
    { ok: true },
    `${season} final 허용`,
  );
  for (const status of ["scheduled", "live", "cancelled"] as const) {
    assert.equal(
      decideManualDiaryGame({ exists: true, gameDate: `${season}-07-24`, status })
        .ok,
      false,
      `${season} ${status} 거부`,
    );
  }
  // 포스트시즌(10~11월)도 같은 시즌으로 허용돼야 한다.
  assert.equal(
    decideManualDiaryGame({
      exists: true,
      gameDate: `${season}-10-31`,
      status: "final",
    }).ok,
    true,
    `${season} 포스트시즌 final 허용`,
  );
}
for (const year of [2024, 2027]) {
  assert.equal(
    decideManualDiaryGame({
      exists: true,
      gameDate: `${year}-07-24`,
      status: "final",
    }).ok,
    false,
    `허용 시즌 밖(${year}) 거부`,
  );
}
// 시즌 판정은 접두 문자열이 아니라 연도 파싱 — 형식이 어긋나면 fail-closed.
assert.equal(manualSeasonOfGameDate("2025-07-24"), 2025);
assert.equal(manualSeasonOfGameDate("20250724"), null, "YYYY-MM-DD 형식만 인정");
assert.equal(manualSeasonOfGameDate("2025-7-24"), null, "zero-pad 안 된 날짜 거부");
assert.equal(manualSeasonOfGameDate(null), null);
assert.equal(
  decideManualDiaryGame({
    exists: true,
    gameDate: "20250724",
    status: "final",
  }).ok,
  false,
  "형식 어긋난 gameDate 거부",
);
assert.equal(VENUE_DIARY_MANUAL_SOURCE, "diary_manual");

const manualMigration = readFileSync(
  new URL(
    "../../supabase/migrations/20260727_venue_diary_manual_upload.sql",
    import.meta.url,
  ),
  "utf8",
);
assert.match(
  manualMigration,
  /pg_advisory_xact_lock[\s\S]*status IN \('active', 'pending', 'archived'\)/,
  "동시성 lock 안에서 보존 상태 전체 상한",
);
assert.equal(
  manualMigration.match(/status IN \('active', 'pending', 'archived'\)/g)?.length,
  3,
  "partial index+직접 추가 RPC+라이브 RPC가 동일 보존 상한 사용",
);
assert.match(
  manualMigration,
  /v_status := CASE WHEN p_media_type = 'video' THEN 'pending' ELSE 'archived' END/,
  "사진은 즉시 archived, 영상은 검증 전 pending",
);
assert.match(
  manualMigration,
  /false, 'diary_manual'/,
  "수동 기록은 venue_verified=false + durable source",
);
assert.match(
  manualMigration,
  /attendance_source <> 'diary_manual'[\s\S]*status <> 'archived'[\s\S]*media_bucket = 'venue-media'/,
  "미검증 staging 영상의 archived 오염을 DB constraint로 차단",
);
assert.match(
  manualMigration,
  /GREATEST\(p_expires_at, now\(\) \+ interval '7 days'\)/,
  "pending 영상은 7일 복구창 확보",
);
assert.match(
  manualMigration,
  /archived_at, game_ended_at[\s\S]*CASE WHEN v_status = 'archived' THEN now\(\) ELSE NULL END,[\s\S]*now\(\)/,
  "실제 final 검증 시각을 기록해 finalizer 재계산 대상에서 제외",
);
assert.match(
  manualMigration,
  /venue_attendance\.source = 'diary_manual'[\s\S]*EXCLUDED\.source = 'story_geofence'/,
  "GPS 인증만 수동 기록을 승격하고 반대 강등은 금지",
);
const diaryRoute = readFileSync(
  new URL("../../src/app/api/me/venue-diary/media/route.ts", import.meta.url),
  "utf8",
);
const diaryPost =
  diaryRoute.match(/export async function POST[\s\S]*?(?=\/\*\* 조회한 유저)/)?.[0] ?? "";
assert.match(diaryRoute, /decideManualDiaryGame\(venue\)/, "KBO actual final 검증");
assert.doesNotMatch(
  diaryPost,
  /\b(lat|lng|accuracy)\b/,
  "직접 추가 POST는 GPS 입력 불필요",
);
assert.match(
  diaryPost,
  /ownsPath\(parsed\.path, gameId, userId\)/,
  "사진 경로를 verified owner에 바인딩",
);
assert.match(
  diaryPost,
  /parsed\.bucket !== VENUE_STORY_PRIVATE_MEDIA_BUCKET/,
  "신규 직접 추가 사진은 private venue-media만 허용",
);
assert.match(
  diaryRoute,
  /validateVenueVideoRow\([\s\S]*promoteStatus: "archived"/,
  "직접 추가 영상은 검증 성공 후 archived로만 승격",
);
const publicRoute = readFileSync(
  new URL("../../src/app/api/venue-stories/route.ts", import.meta.url),
  "utf8",
);
assert.match(
  publicRoute,
  /\.eq\("status", "active"\)[\s\S]*\.gt\("expires_at"/,
  "공개 트레이는 active만 조회해 diary_manual archived 노출 0",
);

Promise.all([testStoryCommentBounds(), testProfileBatchBounds()])
  .then(() => console.log("venue-diary-media-smoke: OK"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
