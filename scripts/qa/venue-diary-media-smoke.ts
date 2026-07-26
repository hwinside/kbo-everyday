import assert from "node:assert/strict";
import {
  buildDiaryDetail,
  buildDiaryList,
  collectSignPaths,
  encodeDiaryCursor,
  paginateDiaryGames,
  parseDiaryCursor,
  pickMediaRef,
  pickThumbRef,
  toStoryCommentBlock,
  VENUE_DIARY_GAMES_PER_PAGE,
  VENUE_DIARY_LIST_ROW_FETCH,
  VENUE_DIARY_THUMBNAILS_PER_GAME,
  type DiaryCommentRow,
  type DiaryListCursor,
  type DiaryListDeps,
  type DiaryDetailDeps,
  type DiaryMediaComment,
  type VenueStoryMediaRow,
} from "../../src/lib/venue-diary/media";
import { VENUE_STORY_ARCHIVE_BUCKET } from "../../src/lib/venue-stories/types";

function media(overrides: Partial<VenueStoryMediaRow> = {}): VenueStoryMediaRow {
  return {
    id: 1,
    game_id: "20260724LGLT0",
    game_date: "2026-07-24",
    media_type: "image",
    media_url: "https://cdn.example/storage/v1/object/public/photos/a.jpg",
    thumb_url: null,
    media_bucket: "photos",
    media_path: "venue-stories/20260724LGLT0/u1/a.jpg",
    thumb_bucket: null,
    thumb_path: null,
    caption: null,
    venue_verified: true,
    stadium_name: "잠실",
    status: "active",
    created_at: "2026-07-24T10:00:00Z",
    ...overrides,
  };
}

// ── 순수 그룹핑/썸네일 ─────────────────────────────────────────────────
// 1) 경기별 그룹핑: 카운트 + 썸네일 상한 + 입력 순서 보존
{
  const rows: VenueStoryMediaRow[] = [
    media({ id: 11, game_id: "G2", game_date: "2026-07-24", media_type: "image" }),
    media({ id: 12, game_id: "G2", game_date: "2026-07-24", media_type: "video", thumb_bucket: "photos", thumb_path: "t12.jpg", thumb_url: "https://cdn/thumb12.jpg" }),
    media({ id: 13, game_id: "G2", game_date: "2026-07-24", media_type: "image" }),
    media({ id: 21, game_id: "G1", game_date: "2026-07-19", media_type: "image" }),
  ];
  const { games } = paginateDiaryGames(rows);
  assert.equal(games.length, 2, "경기 2개로 그룹");
  assert.equal(games[0].gameId, "G2", "입력 순서(최신 먼저) 보존");
  assert.deepEqual(games[0].counts, { image: 2, video: 1, total: 3 }, "카운트 정확");
  assert.equal(games[0].thumbnails.length, 3, "표시 가능 썸네일 3장");
  assert.equal(games[1].counts.total, 1);
}

// 2) 영상+썸네일 없음 → 썸네일 제외되지만 카운트 포함
{
  const rows: VenueStoryMediaRow[] = [
    media({ id: 1, game_id: "G", media_type: "video", thumb_bucket: null, thumb_path: null }),
    media({ id: 2, game_id: "G", media_type: "image", media_url: "https://cdn/p2.jpg", thumb_bucket: null, thumb_path: null }),
  ];
  const [group] = paginateDiaryGames(rows).games;
  assert.equal(group.counts.total, 2, "카운트는 영상 포함 2");
  assert.equal(group.thumbnails.length, 1, "썸네일 없는 영상은 미리보기 제외");
  assert.equal(group.thumbnails[0].id, 2);
}

// 3) 썸네일 상한 초과 시 최신순 상한(6)까지만
{
  const rows: VenueStoryMediaRow[] = Array.from({ length: 10 }, (_, i) =>
    media({ id: 100 + i, game_id: "G", media_type: "image", media_url: `https://cdn/${i}.jpg` }),
  );
  const [group] = paginateDiaryGames(rows).games;
  assert.equal(group.counts.total, 10);
  assert.equal(group.thumbnails.length, VENUE_DIARY_THUMBNAILS_PER_GAME, "썸네일 상한(6)");
}

// ── URL ref: archived 는 signed, active 는 public (Blocker 1 / 회귀 ⑦ 순수 레벨) ─────────
{
  const active = media({ status: "active", media_bucket: "photos", media_path: "venue-stories/G/u/a.jpg" });
  const thumbRef = pickThumbRef(active);
  assert.deepEqual(thumbRef, { kind: "public", url: active.media_url }, "active 사진 → 공개 URL");
  assert.deepEqual(pickMediaRef(active), { kind: "public", url: active.media_url });

  const archived = media({
    status: "archived",
    media_bucket: VENUE_STORY_ARCHIVE_BUCKET,
    media_path: "venue-stories/G/u/a.jpg",
    media_url: "https://cdn.example/storage/v1/object/public/photos/a.jpg", // 저장된 stale 공개 URL — 절대 안 나가야 함
  });
  const aThumb = pickThumbRef(archived);
  assert.equal(aThumb?.kind, "signed", "archived 사진 썸네일 → signed ref");
  assert.deepEqual(aThumb, { kind: "signed", bucket: VENUE_STORY_ARCHIVE_BUCKET, path: "venue-stories/G/u/a.jpg" });
  assert.equal(pickMediaRef(archived).kind, "signed", "archived 원본 → signed ref(공개 URL 아님)");

  const archivedVideo = media({
    status: "archived",
    media_type: "video",
    media_bucket: VENUE_STORY_ARCHIVE_BUCKET,
    media_path: "venue-stories/G/u/v.mp4",
    thumb_bucket: VENUE_STORY_ARCHIVE_BUCKET,
    thumb_path: "venue-stories/G/u/v.jpg",
    thumb_url: "https://cdn.example/storage/v1/object/public/photos/v.jpg",
  });
  const vThumb = pickThumbRef(archivedVideo);
  assert.deepEqual(vThumb, { kind: "signed", bucket: VENUE_STORY_ARCHIVE_BUCKET, path: "venue-stories/G/u/v.jpg" }, "archived 영상 썸네일 → signed");
}

// 4) 커서 인코딩/파싱 라운드트립
{
  const c: DiaryListCursor = { gameDate: "2026-07-24", gameId: "20260724LGLT0" };
  assert.deepEqual(parseDiaryCursor(encodeDiaryCursor(c)), c);
  assert.equal(parseDiaryCursor(null), null);
  assert.equal(parseDiaryCursor("noseparator"), null);
  assert.equal(parseDiaryCursor("2026-07-24|"), null);
}

// ── 회귀 하네스 ────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ❌ ${name}`); }
}

const PUBLIC_MARKER = "/object/public/";
const tests: (() => Promise<void>)[] = [];

/** 테이블 → SQL 술어(소유권·상태·season·keyset·정렬·limit)를 그대로 흉내낸 fake fetchListRows. */
function fakeListDeps(table: VenueStoryMediaRow[], calls: { userId: string; limit: number }[] = []): DiaryListDeps {
  return {
    async fetchListRows({ userId, season, cursor, limit }) {
      calls.push({ userId, limit });
      const rows = table
        .filter((r) => r.user_id === userId) // 소유권(② 타인 미노출)
        .filter((r) => r.status === "active" || r.status === "archived") // ③ active+archived 만
        .filter((r) => r.game_date != null && r.game_date >= `${season}-01-01` && r.game_date < `${season + 1}-01-01`)
        .filter((r) => {
          if (!cursor) return true;
          // (game_date, game_id) DESC keyset — 커서보다 과거만
          return (
            r.game_date! < cursor.gameDate ||
            (r.game_date === cursor.gameDate && r.game_id < cursor.gameId)
          );
        })
        .sort((a, b) =>
          b.game_date!.localeCompare(a.game_date!) ||
          b.game_id.localeCompare(a.game_id) ||
          b.created_at.localeCompare(a.created_at) ||
          b.id - a.id,
        )
        .slice(0, limit);
      return rows;
    },
    async signArchiveUrls(paths) {
      return new Map(paths.map((p) => [p, `https://sign.example/${p}?token=xyz`]));
    },
  };
}

// user_id 를 VenueStoryMediaRow 에 부착(테이블 전용 확장)
type Row = VenueStoryMediaRow & { user_id: string };
function row(o: Partial<Row> & { id: number; game_id: string; game_date: string; user_id: string }): Row {
  return { ...media(o), user_id: o.user_id, ...o } as Row;
}

// ① 미인증 401
tests.push(async () => {
  const res = await buildDiaryList(fakeListDeps([]), { userId: null, season: 2026, cursor: null });
  ok("① 목록 미인증 401", !res.ok && res.status === 401);
  const dRes = await buildDiaryDetail({} as DiaryDetailDeps, { userId: null, gameId: "G" });
  ok("① 상세 미인증 401", !dRes.ok && dRes.status === 401);
});

// ②③ 타인 소유행/비다이어리 상태 미노출
tests.push(async () => {
  const table: Row[] = [
    row({ id: 1, game_id: "20260724A", game_date: "2026-07-24", user_id: "me", status: "active" }),
    row({ id: 2, game_id: "20260724A", game_date: "2026-07-24", user_id: "other", status: "active" }), // 타인
    row({ id: 3, game_id: "20260723B", game_date: "2026-07-23", user_id: "me", status: "removed" }), // 비다이어리
    row({ id: 4, game_id: "20260722C", game_date: "2026-07-22", user_id: "me", status: "pending" }), // 비다이어리
    row({ id: 5, game_id: "20260721D", game_date: "2026-07-21", user_id: "me", status: "archived" }),
  ];
  const res = await buildDiaryList(fakeListDeps(table), { userId: "me", season: 2026, cursor: null });
  ok("②③ 결과 존재", res.ok);
  if (res.ok) {
    const ids = res.body.games.flatMap((g) => g.thumbnails.map((t) => t.id));
    ok("② 타인 소유행 미노출", !ids.includes(2));
    ok("③ removed/pending 미노출(active+archived만)", !ids.includes(3) && !ids.includes(4));
    ok("③ active+archived 노출", res.body.games.length === 2);
  }
});

// ⑤ 501행/51경기 경계 누락 0 + 경기별 count 정확 (raw .limit(500) 이면 51경기+ 누락)
tests.push(async () => {
  const GAMES = 55;
  const PER_GAME = 10; // 게임당 유저 상한
  const table: Row[] = [];
  for (let g = 0; g < GAMES; g++) {
    const day = String(g + 1).padStart(2, "0");
    const gameDate = `2026-03-${day}`; // 03월 1~55? → 유효성 위해 날짜는 문자열 비교만 쓰므로 형식만 유지
    const gameId = `2026-03-${day}#G`;
    for (let m = 0; m < PER_GAME; m++) {
      table.push(row({ id: g * 100 + m, game_id: gameId, game_date: gameDate, user_id: "me", status: g % 2 === 0 ? "active" : "archived", media_type: "image" }));
    }
  }
  // 전 페이지 순회
  const seen = new Map<string, number>();
  let cursor: DiaryListCursor | null = null;
  let pages = 0;
  const deps = fakeListDeps(table);
  for (;;) {
    pages++;
    const res = await buildDiaryList(deps, { userId: "me", season: 2026, cursor });
    if (!res.ok) { ok("⑤ 페이지 성공", false); break; }
    for (const gg of res.body.games) seen.set(gg.gameId, gg.counts.total);
    if (!res.body.hasMore || !res.body.nextCursor) break;
    cursor = parseDiaryCursor(res.body.nextCursor);
    if (pages > 10) { ok("⑤ 무한루프 방지", false); break; }
  }
  ok("⑤ 55경기 전부 복원(51경기+ 누락 0)", seen.size === GAMES);
  ok("⑤ 모든 경기 count=10 정확(경계 절단 0)", [...seen.values()].every((c) => c === PER_GAME));
  ok("⑤ 페이지당 상한 = GAMES_PER_PAGE", VENUE_DIARY_GAMES_PER_PAGE === 30);
});

// ⑤-b 혼합 크기(1~10) 경기가 over-fetch 경계를 걸쳐도 count 정확
tests.push(async () => {
  const table: Row[] = [];
  for (let g = 0; g < 40; g++) {
    const day = String(g + 1).padStart(2, "0");
    const per = (g % 10) + 1; // 1~10
    for (let m = 0; m < per; m++) {
      table.push(row({ id: g * 100 + m, game_id: `2026-05-${day}#G`, game_date: `2026-05-${day}`, user_id: "me", status: "active", media_type: "image" }));
    }
  }
  const expected = new Map<string, number>();
  for (const r of table) expected.set(r.game_id, (expected.get(r.game_id) ?? 0) + 1);

  const seen = new Map<string, number>();
  let cursor: DiaryListCursor | null = null;
  const deps = fakeListDeps(table);
  for (let i = 0; i < 10; i++) {
    const res = await buildDiaryList(deps, { userId: "me", season: 2026, cursor });
    if (!res.ok) break;
    for (const gg of res.body.games) seen.set(gg.gameId, gg.counts.total);
    if (!res.body.hasMore || !res.body.nextCursor) break;
    cursor = parseDiaryCursor(res.body.nextCursor);
  }
  ok("⑤-b 혼합 크기 경기 전부 복원", seen.size === expected.size);
  ok("⑤-b 혼합 크기 count 정확", [...expected].every(([k, v]) => seen.get(k) === v));
  ok("⑤-b over-fetch 상한 = (31)*10+1", VENUE_DIARY_LIST_ROW_FETCH === 311);
});

// ⑦ archived 응답에 public URL 미반환(signed 만), active 는 public 유지
tests.push(async () => {
  const table: Row[] = [
    row({ id: 1, game_id: "20260724A", game_date: "2026-07-24", user_id: "me", status: "active", media_type: "image", media_bucket: "photos", media_path: "venue-stories/A/me/a.jpg", media_url: "https://cdn/storage/v1/object/public/photos/a.jpg" }),
    row({ id: 2, game_id: "20260723B", game_date: "2026-07-23", user_id: "me", status: "archived", media_type: "image", media_bucket: VENUE_STORY_ARCHIVE_BUCKET, media_path: "venue-stories/B/me/b.jpg", media_url: "https://cdn/storage/v1/object/public/photos/b.jpg" }),
  ];
  const res = await buildDiaryList(fakeListDeps(table), { userId: "me", season: 2026, cursor: null });
  ok("⑦ 목록 성공", res.ok);
  if (res.ok) {
    const urls = res.body.games.flatMap((g) => g.thumbnails.map((t) => t.thumbUrl));
    ok("⑦ 목록 archived 썸네일은 signed(public URL 0)", urls.some((u) => u.startsWith("https://sign.example/")) && !urls.some((u) => u.includes(PUBLIC_MARKER + "photos") && u.includes("/b.jpg")));
    ok("⑦ 목록 active 썸네일은 공개 URL 유지", urls.some((u) => u.includes(PUBLIC_MARKER)));
  }
  // collectSignPaths: archived 만 수집
  const { games } = paginateDiaryGames(table);
  ok("⑦ 서명 대상은 archived 경로만", collectSignPaths(games).length === 1);
});

// ── 상세: story별 bounded 댓글 + starvation 0 (⑥) + deleted_at(④) + signed(⑦) ─────────
function fakeDetailDeps(
  mediaTable: Row[],
  commentTable: (DiaryCommentRow & { deleted: boolean })[],
): DiaryDetailDeps {
  return {
    async fetchGameMedia({ userId, gameId, limit }) {
      return mediaTable
        .filter((r) => r.user_id === userId && r.game_id === gameId) // 소유권+경기
        .filter((r) => r.status === "active" || r.status === "archived") // active+archived만
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
        .slice(0, limit);
    },
    async fetchStoryComments({ storyId, limit }) {
      const all = commentTable
        .filter((c) => c.story_id === storyId && !c.deleted) // ④ deleted_at IS NULL
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
      return { rowsDesc: all.slice(0, limit), total: all.length };
    },
    async resolveAuthors() {
      return (uid: string): DiaryMediaComment["author"] => ({ nickname: uid, avatarUrl: null, teamId: null });
    },
    async signArchiveUrls(paths) {
      return new Map(paths.map((p) => [p, `https://sign.example/${p}?token=xyz`]));
    },
  };
}

{
  const gameId = "20260724A";
  const mediaTable: Row[] = [
    row({ id: 10, game_id: gameId, game_date: "2026-07-24", user_id: "me", status: "active", media_type: "image", media_bucket: "photos", media_path: "venue-stories/A/me/1.jpg", media_url: "https://cdn/storage/v1/object/public/photos/1.jpg" }),
    row({ id: 11, game_id: gameId, game_date: "2026-07-24", user_id: "me", status: "archived", media_type: "video", media_bucket: VENUE_STORY_ARCHIVE_BUCKET, media_path: "venue-stories/A/me/2.mp4", thumb_bucket: VENUE_STORY_ARCHIVE_BUCKET, thumb_path: "venue-stories/A/me/2.jpg", media_url: "https://cdn/storage/v1/object/public/videos/2.mp4" }),
    row({ id: 12, game_id: gameId, game_date: "2026-07-24", user_id: "other", status: "active", media_type: "image", media_path: "x" }), // 타인
  ];
  // story 10: 댓글 600개(200 삭제) / story 11: 댓글 5개 — 전역 limit 500 이면 story 11 굶음
  const comments: (DiaryCommentRow & { deleted: boolean })[] = [];
  for (let i = 0; i < 600; i++) comments.push({ id: 100000 + i, story_id: 10, user_id: `u${i % 3}`, content: `c${i}`, created_at: `2026-07-24T10:${String(i % 60).padStart(2, "0")}:00Z`, deleted: i < 200 });
  for (let i = 0; i < 5; i++) comments.push({ id: 200000 + i, story_id: 11, user_id: "v", content: `d${i}`, created_at: `2026-07-24T11:0${i}:00Z`, deleted: false });

  tests.push(async () => {
  const res = await buildDiaryDetail(fakeDetailDeps(mediaTable, comments), { userId: "me", gameId });
  ok("상세 성공", res.ok);
  if (res.ok) {
    ok("② 상세 타인 미디어 미노출", res.body.media.length === 2 && res.body.media.every((m) => m.id !== 12));
    const s10 = res.body.media.find((m) => m.id === 10)!;
    const s11 = res.body.media.find((m) => m.id === 11)!;
    ok("⑥ story10 최신 100개 bounded", s10.comments.length === 100);
    ok("④⑥ story10 total=미삭제 400(삭제 200 제외)", s10.commentTotal === 400);
    ok("⑥ story11 starvation 0 (5개 유지)", s11.comments.length === 5 && s11.commentTotal === 5);
    ok("⑥ 댓글 정순(오래된→최신)", s11.comments[0].content === "d0" && s11.comments[4].content === "d4");
    ok("⑦ 상세 active 원본 공개 URL 유지", s10.mediaUrl.includes(PUBLIC_MARKER));
    ok("⑦ 상세 archived 원본 signed(public URL 0)", s11.mediaUrl.startsWith("https://sign.example/") && !s11.mediaUrl.includes(PUBLIC_MARKER));
    ok("⑦ 상세 archived 썸네일 signed", (s11.thumbUrl ?? "").startsWith("https://sign.example/"));
  }
  });
}

// toStoryCommentBlock 순수 반전
{
  const authorFor = (uid: string): DiaryMediaComment["author"] => ({ nickname: uid, avatarUrl: null, teamId: null });
  const desc: DiaryCommentRow[] = [
    { id: 3, story_id: 10, user_id: "u1", content: "3", created_at: "2026-07-24T10:03:00Z" },
    { id: 2, story_id: 10, user_id: "u2", content: "2", created_at: "2026-07-24T10:02:00Z" },
    { id: 1, story_id: 10, user_id: "u1", content: "1", created_at: "2026-07-24T10:01:00Z" },
  ];
  const list = toStoryCommentBlock(desc, authorFor);
  assert.deepEqual(list.map((c) => c.content), ["1", "2", "3"], "정순 반전");
}

// 비동기 테스트 순차 실행 후 결과 집계
(async () => {
  for (const t of tests) await t();
  if (fail > 0) {
    console.error(`venue-diary-media-smoke: FAIL (${fail} failed, ${pass} passed)`);
    process.exit(1);
  }
  console.log(`venue-diary-media-smoke: OK (${pass} route-contract + pure assertions)`);
})();
