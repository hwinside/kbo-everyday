// 직관 다이어리 미디어(archive) 조회 순수 로직 + 조회 오케스트레이션(DI) — S2.
//
// 본인이 올린 사진/영상(status active+archived)을 경기별로 묶어 /my 다이어리에서 열람한다.
// 승·무·패/승률(venue_attendance)과는 별개 데이터라 API 도 분리된다(회귀 격리).
//
// 이 파일은 DB·네트워크가 없는 순수 변환 + "데이터 접근 포트(deps)"를 주입받는 오케스트레이터를 담는다.
// 실제 supabase 쿼리/서명은 route 가 deps 로 주입하고, 회귀 스모크는 SQL 술어를 그대로 흉내낸 fake deps 로
// 미인증/소유권/상태/keyset/starvation/서명 계약을 고정한다(collectReferencedPaths 와 동일 DI 패턴).

import { VENUE_STORY_ARCHIVE_BUCKET, VENUE_STORY_MAX_PER_USER_PER_GAME } from "../venue-stories/types";

// ── 상수 ──────────────────────────────────────────────────────────────
/** 목록 모드에서 경기 row 에 얹을 썸네일 최대 장수(화면 정의 §3.1: 6장 + `+N`). */
export const VENUE_DIARY_THUMBNAILS_PER_GAME = 6;

/** 목록 모드 한 페이지 경기 수(경기 단위 keyset 페이지네이션). */
export const VENUE_DIARY_GAMES_PER_PAGE = 30;

/** 경기당(유저) 미디어 상한 — 업로드 RPC(create_venue_story) 가 강제하는 게임당 유저 상한과 동일 SSOT. */
export const VENUE_DIARY_MAX_MEDIA_PER_GAME = VENUE_STORY_MAX_PER_USER_PER_GAME;

/**
 * 목록 모드 row over-fetch 상한(bounded, keyset).
 * (경기당 미디어 ≤ MAX) 를 이용해 "첫 GAMES_PER_PAGE 경기의 완전성"을 보장하는 크기다:
 *   (GAMES_PER_PAGE+1)*MAX + 1 행을 가져오면
 *   - 서로 다른 경기가 GAMES_PER_PAGE 개 초과로 보이면 → (GAMES_PER_PAGE+1)번째 경기가 "시작"됐다는 뜻이라
 *     앞 GAMES_PER_PAGE 경기는 모든 행이 이 창 안에 들어와 count 가 정확하다(경계 중간 절단 0).
 *   - GAMES_PER_PAGE 개 이하만 보이면 행 수 < fetch 상한 이므로 마지막 경기까지 완전(끝 도달).
 * 따라서 51번째 경기/500 경계 누락 0 + 경기별 count 정확(삼순 Blocker 2).
 */
export const VENUE_DIARY_LIST_ROW_FETCH =
  (VENUE_DIARY_GAMES_PER_PAGE + 1) * VENUE_DIARY_MAX_MEDIA_PER_GAME + 1;

/** 상세 모드 경기당 미디어 스캔 상한(bounded). 게임당 유저 업로드 상한의 여유 배수. */
export const VENUE_DIARY_MEDIA_PER_GAME_CAP = 60;

/** 상세 모드 story별 댓글 목록 상한(최신 100개) — 기존 라이브 댓글 계약(VENUE_STORY_COMMENT_LIST_LIMIT)과 동일. */
export const VENUE_DIARY_COMMENT_LIST_LIMIT = 100;

/** archived 미디어 signed URL 만료(초). 짧게 유지(본인 열람 세션 단위). */
export const VENUE_DIARY_SIGNED_URL_TTL_SEC = 3600;

/** 다이어리에 노출할 상태(공개 종료 후 보관본 포함). 공개면과 달리 archived 도 본인은 열람. */
export const DIARY_STATUSES = ["active", "archived"] as const;

// ── 행/응답 타입 ──────────────────────────────────────────────────────
/** venue_stories 에서 다이어리 조회에 필요한 컬럼. bucket/path 로 공개(public)/보관(signed) URL 을 판별한다. */
export interface VenueStoryMediaRow {
  id: number;
  game_id: string;
  game_date: string | null;
  media_type: "video" | "image";
  media_url: string;
  thumb_url: string | null;
  media_bucket: string | null;
  media_path: string | null;
  thumb_bucket: string | null;
  thumb_path: string | null;
  caption: string | null;
  venue_verified: boolean | null;
  stadium_name: string | null;
  status: string;
  created_at: string;
}

/**
 * URL 참조(ref) — 실제 URL 문자열로 물질화하기 전 단계.
 *  - public: 공개 버킷의 저장된 공개 URL 그대로.
 *  - signed: private archive 버킷 객체 → route 가 createSignedUrl 로 물질화(공개 URL 절대 미노출).
 */
export type MediaUrlRef =
  | { kind: "public"; url: string }
  | { kind: "signed"; bucket: string; path: string };

/** 객체가 private archive 버킷에 있는가(=서명 필요). */
function isPrivateBucket(bucket: string | null): boolean {
  return bucket === VENUE_STORY_ARCHIVE_BUCKET;
}

/**
 * 썸네일 URL ref 선택: 썸네일 객체 우선, 없으면 사진 원본. 영상+썸네일 없음이면 표시 불가(null).
 * private(archived) → signed ref(경로만), public(active) → 저장된 공개 URL. archived 에 공개 URL 을 절대 쓰지 않는다.
 */
export function pickThumbRef(row: VenueStoryMediaRow): MediaUrlRef | null {
  if (row.status === "archived") {
    if (row.thumb_path) {
      return row.thumb_bucket === VENUE_STORY_ARCHIVE_BUCKET
        ? { kind: "signed", bucket: row.thumb_bucket, path: row.thumb_path }
        : null;
    }
    if (row.media_type === "image" && row.media_path) {
      return row.media_bucket === VENUE_STORY_ARCHIVE_BUCKET
        ? { kind: "signed", bucket: row.media_bucket, path: row.media_path }
        : null;
    }
    return null;
  }
  if (row.thumb_path && row.thumb_bucket) {
    if (isPrivateBucket(row.thumb_bucket)) {
      return { kind: "signed", bucket: row.thumb_bucket, path: row.thumb_path };
    }
    return row.thumb_url ? { kind: "public", url: row.thumb_url } : null;
  }
  if (row.media_type === "image" && row.media_path && row.media_bucket) {
    if (isPrivateBucket(row.media_bucket)) {
      return { kind: "signed", bucket: row.media_bucket, path: row.media_path };
    }
    return row.media_url ? { kind: "public", url: row.media_url } : null;
  }
  return null;
}

/** 상세 원본 URL ref. archived+private만 signed, archived+public/missing은 null(fail-closed). */
export function pickMediaRef(row: VenueStoryMediaRow): MediaUrlRef | null {
  if (row.status === "archived") {
    return row.media_bucket === VENUE_STORY_ARCHIVE_BUCKET && row.media_path
      ? { kind: "signed", bucket: row.media_bucket, path: row.media_path }
      : null;
  }
  if (row.media_bucket && row.media_path && isPrivateBucket(row.media_bucket)) {
    return { kind: "signed", bucket: row.media_bucket, path: row.media_path };
  }
  return { kind: "public", url: row.media_url };
}

/** 상세 썸네일 URL ref(없으면 null). private → signed, 아니면 공개 URL. */
export function pickDetailThumbRef(row: VenueStoryMediaRow): MediaUrlRef | null {
  if (!row.thumb_path || !row.thumb_bucket) return null;
  if (row.status === "archived" && row.thumb_bucket !== VENUE_STORY_ARCHIVE_BUCKET) {
    return null;
  }
  if (isPrivateBucket(row.thumb_bucket)) {
    return { kind: "signed", bucket: row.thumb_bucket, path: row.thumb_path };
  }
  return row.thumb_url ? { kind: "public", url: row.thumb_url } : null;
}

/** archived 행은 모든 존재 객체가 private archive bucket을 가리켜야만 응답 가능하다. */
export function isDiaryRowStorageSafe(row: VenueStoryMediaRow): boolean {
  if (row.status !== "archived") return true;
  if (!row.media_path || row.media_bucket !== VENUE_STORY_ARCHIVE_BUCKET) return false;
  if (row.thumb_path && row.thumb_bucket !== VENUE_STORY_ARCHIVE_BUCKET) return false;
  return true;
}

// ── 목록 모드(경기 단위 keyset) ────────────────────────────────────────
/** 목록 커서 — 마지막으로 "완전히" 담은 경기의 (game_date, game_id). */
export interface DiaryListCursor {
  gameDate: string;
  gameId: string;
}

/** 커서 인코딩: `${game_date}|${game_id}`. game_date 는 항상 존재(season 범위 필터가 null 을 배제). */
export function encodeDiaryCursor(c: DiaryListCursor): string {
  return `${c.gameDate}|${c.gameId}`;
}

/** 커서 파싱(형식 오류 → null). */
export function parseDiaryCursor(raw: string | null | undefined): DiaryListCursor | null {
  if (!raw) return null;
  const idx = raw.indexOf("|");
  if (idx <= 0 || idx === raw.length - 1) return null;
  const gameDate = raw.slice(0, idx);
  const gameId = raw.slice(idx + 1);
  if (!gameDate || !gameId) return null;
  return { gameDate, gameId };
}

/** 목록 모드 썸네일(ref 단계). */
export interface DiaryMediaThumbRef {
  id: number;
  mediaType: "video" | "image";
  ref: MediaUrlRef;
  venueVerified: boolean;
}

/** 목록 모드 경기별 미디어 요약(ref 단계 — URL 미물질화). */
export interface DiaryGameGroupRef {
  gameId: string;
  gameDate: string | null;
  stadiumName: string | null;
  counts: { image: number; video: number; total: number };
  thumbnails: DiaryMediaThumbRef[];
}

/** 목록 모드 썸네일(물질화 후 — 최종 JSON). */
export interface DiaryMediaThumb {
  id: number;
  mediaType: "video" | "image";
  thumbUrl: string;
  venueVerified: boolean;
}

/** 목록 모드 경기별 미디어 요약(최종 JSON). */
export interface DiaryGameMediaGroup {
  gameId: string;
  gameDate: string | null;
  stadiumName: string | null;
  counts: { image: number; video: number; total: number };
  thumbnails: DiaryMediaThumb[];
}

/**
 * game_date DESC, game_id DESC, created_at DESC, id DESC 로 정렬된 rows 를 경기별로 묶어
 * 카운트 + 최신 썸네일 ref 소수를 만든다(입력 정렬 보존 = 안정).
 */
function groupRowsByGameRef(
  rows: readonly VenueStoryMediaRow[],
  thumbnailsPerGame: number,
): DiaryGameGroupRef[] {
  const order: string[] = [];
  const byGame = new Map<string, DiaryGameGroupRef>();

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

    const ref = pickThumbRef(row);
    if (ref && group.thumbnails.length < thumbnailsPerGame) {
      group.thumbnails.push({
        id: row.id,
        mediaType: row.media_type,
        ref,
        venueVerified: row.venue_verified ?? false,
      });
    }
  }
  return order.map((gameId) => byGame.get(gameId)!);
}

/**
 * 경기 단위 keyset 페이지네이션(순수). over-fetch 된 rows 를 경기별로 묶고 첫 gamesPerPage 경기만 확정한다.
 * gamesPerPage 초과 경기가 보이면 다음 경기가 시작된 것이므로 앞 경기들은 완전(count 정확) → 잘라내고 nextCursor 세팅.
 * (완전성 근거는 VENUE_DIARY_LIST_ROW_FETCH 주석 참조 — 호출부는 반드시 그 상한으로 fetch 해야 한다.)
 */
export function paginateDiaryGames(
  rows: readonly VenueStoryMediaRow[],
  opts?: { gamesPerPage?: number; thumbnailsPerGame?: number },
): { games: DiaryGameGroupRef[]; nextCursor: string | null; hasMore: boolean } {
  const gamesPerPage = opts?.gamesPerPage ?? VENUE_DIARY_GAMES_PER_PAGE;
  const thumbnailsPerGame = opts?.thumbnailsPerGame ?? VENUE_DIARY_THUMBNAILS_PER_GAME;
  const all = groupRowsByGameRef(rows, thumbnailsPerGame);
  const hasMore = all.length > gamesPerPage;
  const games = hasMore ? all.slice(0, gamesPerPage) : all;
  const last = games[games.length - 1];
  const nextCursor =
    hasMore && last && last.gameDate != null
      ? encodeDiaryCursor({ gameDate: last.gameDate, gameId: last.gameId })
      : null;
  return { games, nextCursor, hasMore };
}

/** ref 그룹들에서 서명이 필요한 archive 경로를 수집(중복 제거). */
export function collectSignPaths(groups: readonly DiaryGameGroupRef[]): string[] {
  const set = new Set<string>();
  for (const g of groups) {
    for (const t of g.thumbnails) {
      if (t.ref.kind === "signed") set.add(t.ref.path);
    }
  }
  return [...set];
}

/** ref → 최종 URL 물질화. signed 인데 서명 실패(맵 미존재)면 그 썸네일은 제외(공개 URL 대체 금지). */
export function materializeGames(
  groups: readonly DiaryGameGroupRef[],
  signed: ReadonlyMap<string, string>,
): DiaryGameMediaGroup[] {
  return groups.map((g) => ({
    gameId: g.gameId,
    gameDate: g.gameDate,
    stadiumName: g.stadiumName,
    counts: g.counts,
    thumbnails: g.thumbnails.flatMap((t) => {
      const url = t.ref.kind === "public" ? t.ref.url : signed.get(t.ref.path);
      if (!url) return [];
      return [{ id: t.id, mediaType: t.mediaType, thumbUrl: url, venueVerified: t.venueVerified }];
    }),
  }));
}

// ── 상세 모드(캐러셀 + story별 댓글) ──────────────────────────────────
/** 상세 미디어 1건(ref 단계). */
export interface DiaryMediaItemRef {
  id: number;
  gameId: string;
  mediaType: "video" | "image";
  mediaRef: MediaUrlRef;
  thumbRef: MediaUrlRef | null;
  caption: string | null;
  venueVerified: boolean;
  stadiumName: string | null;
  createdAt: string;
}

/** 상세 읽기전용 댓글 1건. */
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

/** 상세 미디어 1건(물질화 + 댓글 블록). */
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
  comments: DiaryMediaComment[];
  commentTotal: number;
}

/** 상세 미디어 ref 변환(created_at ASC 정렬 입력 가정 — 캐러셀 정순). */
export function buildDiaryMediaRefItem(row: VenueStoryMediaRow): DiaryMediaItemRef | null {
  const mediaRef = pickMediaRef(row);
  if (!mediaRef) return null;
  return {
    id: row.id,
    gameId: row.game_id,
    mediaType: row.media_type,
    mediaRef,
    thumbRef: pickDetailThumbRef(row),
    caption: row.caption,
    venueVerified: row.venue_verified ?? false,
    stadiumName: row.stadium_name,
    createdAt: row.created_at,
  };
}

/** 상세 ref 아이템들에서 서명이 필요한 archive 경로 수집(중복 제거). */
export function collectDetailSignPaths(items: readonly DiaryMediaItemRef[]): string[] {
  const set = new Set<string>();
  for (const it of items) {
    if (it.mediaRef.kind === "signed") set.add(it.mediaRef.path);
    if (it.thumbRef?.kind === "signed") set.add(it.thumbRef.path);
  }
  return [...set];
}

/** ref → URL 물질화(signed 실패 시 원본은 빈 문자열, 썸네일은 null — 공개 URL 대체 금지). */
function resolveRefUrl(ref: MediaUrlRef, signed: ReadonlyMap<string, string>): string | null {
  if (ref.kind === "public") return ref.url;
  return signed.get(ref.path) ?? null;
}

/** 댓글 raw row(미삭제, created_at DESC) 를 정순(오래된→최신)으로 반전 + 작성자 매핑. */
export interface DiaryCommentRow {
  id: number;
  story_id: number;
  user_id: string;
  content: string;
  created_at: string;
}

export function toStoryCommentBlock(
  rowsDesc: readonly DiaryCommentRow[],
  authorFor: (userId: string) => DiaryMediaComment["author"],
): DiaryMediaComment[] {
  const list: DiaryMediaComment[] = [];
  // DESC 입력을 unshift 로 정순 누적(채팅처럼 오래된→최신).
  for (const row of rowsDesc) {
    list.unshift({
      id: row.id,
      storyId: row.story_id,
      userId: row.user_id,
      content: row.content,
      createdAt: row.created_at,
      author: authorFor(row.user_id),
    });
  }
  return list;
}

// ── 오케스트레이터(DI) ────────────────────────────────────────────────
/**
 * 목록/상세 데이터 접근 포트. route 가 supabase 백엔드 구현을 주입한다.
 * 각 fetch 는 **소유권(user_id=본인)·상태(active+archived)·keyset** 을 SQL 에서 강제한 뒤 rows 를 돌려준다.
 * 실패(fault)는 null 로 표현해 오케스트레이터가 5xx 로 승격한다.
 */
export interface DiaryListDeps {
  /** 본인 active+archived, season 범위, (game_date,game_id) DESC keyset, limit 까지. fault → null. */
  fetchListRows(args: {
    userId: string;
    season: number;
    cursor: DiaryListCursor | null;
    limit: number;
  }): Promise<VenueStoryMediaRow[] | null>;
  /** archive 경로들 → signed URL 맵(path→url). fault → null. */
  signArchiveUrls(paths: string[]): Promise<Map<string, string> | null>;
}

export type DiaryResult<T> =
  | { ok: true; body: T }
  | { ok: false; status: number; body: { error: string } };

/** 목록 모드 오케스트레이션(순수 로직 + 주입 fetch). userId=null 이면 미인증 401. */
export async function buildDiaryList(
  deps: DiaryListDeps,
  args: { userId: string | null; season: number; cursor: DiaryListCursor | null },
): Promise<DiaryResult<{ season: number; games: DiaryGameMediaGroup[]; nextCursor: string | null; hasMore: boolean }>> {
  if (!args.userId) return { ok: false, status: 401, body: { error: "인증이 필요합니다" } };
  const rows = await deps.fetchListRows({
    userId: args.userId,
    season: args.season,
    cursor: args.cursor,
    limit: VENUE_DIARY_LIST_ROW_FETCH,
  });
  if (rows == null) return { ok: false, status: 500, body: { error: "미디어 조회 실패" } };
  if (rows.some((row) => !isDiaryRowStorageSafe(row))) {
    return { ok: false, status: 503, body: { error: "미디어 보관 처리 중" } };
  }

  const { games: refGames, nextCursor, hasMore } = paginateDiaryGames(rows);
  const signPaths = collectSignPaths(refGames);
  let signed = new Map<string, string>();
  if (signPaths.length > 0) {
    const result = await deps.signArchiveUrls(signPaths);
    if (result == null || signPaths.some((path) => !result.has(path))) {
      return { ok: false, status: 500, body: { error: "미디어 조회 실패" } };
    }
    signed = result;
  }
  const games = materializeGames(refGames, signed);
  return { ok: true, body: { season: args.season, games, nextCursor, hasMore } };
}

export interface DiaryDetailDeps {
  /** 본인+경기 한정 active+archived 미디어(created_at ASC), limit 까지. fault → null. */
  fetchGameMedia(args: {
    userId: string;
    gameId: string;
    limit: number;
  }): Promise<VenueStoryMediaRow[] | null>;
  /** story별 미삭제(deleted_at IS NULL) 댓글 최신 limit개 + 전체 total. fault → null. */
  fetchStoryComments(args: {
    storyId: number;
    limit: number;
  }): Promise<{ rowsDesc: DiaryCommentRow[]; total: number } | null>;
  /** 댓글 작성자 프로필 매핑 클로저. fault → null. */
  resolveAuthors(
    userIds: string[],
  ): Promise<((userId: string) => DiaryMediaComment["author"]) | null>;
  /** archive 경로들 → signed URL 맵. fault → null. */
  signArchiveUrls(paths: string[]): Promise<Map<string, string> | null>;
}

/** 상세 모드 오케스트레이션. userId=null 이면 401. */
export async function buildDiaryDetail(
  deps: DiaryDetailDeps,
  args: { userId: string | null; gameId: string },
): Promise<DiaryResult<{ gameId: string; media: DiaryMediaItem[] }>> {
  if (!args.userId) return { ok: false, status: 401, body: { error: "인증이 필요합니다" } };

  const rows = await deps.fetchGameMedia({
    userId: args.userId,
    gameId: args.gameId,
    limit: VENUE_DIARY_MEDIA_PER_GAME_CAP,
  });
  if (rows == null) return { ok: false, status: 500, body: { error: "미디어 조회 실패" } };
  if (rows.some((row) => !isDiaryRowStorageSafe(row))) {
    return { ok: false, status: 503, body: { error: "미디어 보관 처리 중" } };
  }

  const refItems = rows.map(buildDiaryMediaRefItem);
  if (refItems.some((item) => item == null)) {
    return { ok: false, status: 503, body: { error: "미디어 보관 처리 중" } };
  }
  const safeRefItems = refItems as DiaryMediaItemRef[];

  // story별 bounded 댓글(각 story 최신 100개 + total) — 전역 limit 500 이 특정 story 를 굶기던 문제 제거(Blocker 2).
  const blocks: { rowsDesc: DiaryCommentRow[]; total: number }[] = [];
  for (const it of safeRefItems) {
    const block = await deps.fetchStoryComments({
      storyId: it.id,
      limit: VENUE_DIARY_COMMENT_LIST_LIMIT,
    });
    if (block == null) return { ok: false, status: 500, body: { error: "댓글 조회 실패" } };
    blocks.push(block);
  }

  const authorIds = [...new Set(blocks.flatMap((b) => b.rowsDesc.map((r) => r.user_id)))];
  const authorFor = await deps.resolveAuthors(authorIds);
  if (authorFor == null) return { ok: false, status: 500, body: { error: "댓글 조회 실패" } };

  // archive signed URL(원본+썸네일)
  const signPaths = collectDetailSignPaths(safeRefItems);
  let signed = new Map<string, string>();
  if (signPaths.length > 0) {
    const result = await deps.signArchiveUrls(signPaths);
    if (result == null || signPaths.some((path) => !result.has(path))) {
      return { ok: false, status: 500, body: { error: "미디어 조회 실패" } };
    }
    signed = result;
  }

  const media: DiaryMediaItem[] = safeRefItems.map((it, i) => ({
    id: it.id,
    gameId: it.gameId,
    mediaType: it.mediaType,
    mediaUrl: resolveRefUrl(it.mediaRef, signed) ?? "",
    thumbUrl: it.thumbRef ? resolveRefUrl(it.thumbRef, signed) : null,
    caption: it.caption,
    venueVerified: it.venueVerified,
    stadiumName: it.stadiumName,
    createdAt: it.createdAt,
    comments: toStoryCommentBlock(blocks[i].rowsDesc, authorFor),
    commentTotal: blocks[i].total,
  }));

  return { ok: true, body: { gameId: args.gameId, media } };
}
