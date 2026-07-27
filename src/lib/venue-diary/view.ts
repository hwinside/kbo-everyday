// 직관 다이어리 A4 UI 순수 뷰 로직 — 상태 판정만(DOM/네트워크 없음, 회귀 테스트 대상).
//
// 화면별 분기(GPS인증/직접추가 라벨 · 경기 선택 N/10 · 업로드 항목 상태 · 상세 댓글 숨김)를
// 컴포넌트에서 떼어내 순수 함수로 고정한다. 계약은 /api/me/venue-diary/media, /api/me/venue-attendance.

import { VENUE_STORY_MAX_PER_USER_PER_GAME } from "@/lib/venue-stories/types";

/** 홈 경기 카드에 붙는 썸네일 최대 장수(목업 ①: 6장 + `+N`). */
export const VENUE_DIARY_HOME_THUMBNAILS = 6;

/** 경기당 미디어 상한(경기 선택 잠금 기준). API 계약과 동일한 스팸 상한을 재사용한다. */
export const VENUE_DIARY_MEDIA_CAP = VENUE_STORY_MAX_PER_USER_PER_GAME;

/** GPS 인증 / 직접 추가 라벨. 'GPS 인증'은 인증 배지, '직접 추가'는 중립 태그. */
export type DiarySourceKind = "gps" | "manual";

export interface DiarySourceLabel {
  kind: DiarySourceKind;
  text: string;
}

const SOURCE_LABEL: Record<DiarySourceKind, DiarySourceLabel> = {
  gps: { kind: "gps", text: "GPS 인증" },
  manual: { kind: "manual", text: "직접 추가" },
};

/**
 * 경기 카드 라벨(목업 ①·②). 썸네일 중 하나라도 venueVerified=true 면 GPS 인증, 아니면 직접 추가.
 * (API 계약 2: thumbnails 에 venueVerified=true 있으면 `GPS 인증`.)
 */
export function diaryGameSourceLabel(
  thumbnails: ReadonlyArray<{ venueVerified: boolean }>,
): DiarySourceLabel {
  return thumbnails.some((t) => t.venueVerified) ? SOURCE_LABEL.gps : SOURCE_LABEL.manual;
}

/** 단일 미디어(상세 뷰어)의 라벨. */
export function diaryMediaSourceLabel(venueVerified: boolean): DiarySourceLabel {
  return venueVerified ? SOURCE_LABEL.gps : SOURCE_LABEL.manual;
}

/**
 * 경기 선택 화면(②)의 픽 버튼 상태.
 *  - 0개: "선택"(pick)
 *  - 0 < count < cap: "N/10 · 더 추가"(add)
 *  - count ≥ cap: "🔒 10/10" 잠금(locked)
 */
export type DiaryPickState =
  | { kind: "pick" }
  | { kind: "add"; count: number; cap: number }
  | { kind: "locked"; cap: number };

export function diaryPickState(
  count: number,
  cap: number = VENUE_DIARY_MEDIA_CAP,
): DiaryPickState {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (safe >= cap) return { kind: "locked", cap };
  if (safe > 0) return { kind: "add", count: safe, cap };
  return { kind: "pick" };
}

/** 픽 상태의 보조 설명(목업 ②의 회색 상태 라인). */
export function diaryPickCaption(state: DiaryPickState): string | null {
  if (state.kind === "add") return `이미 ${state.count}개 올림`;
  if (state.kind === "locked") return "가득 채움";
  return null;
}

/** 잠금 여부(선택 불가) — 컴포넌트 disabled 게이트. */
export function diaryPickLocked(state: DiaryPickState): boolean {
  return state.kind === "locked";
}

/**
 * 업로드 항목(③)의 클라이언트 상태 머신.
 *  - queued: 선택만 됨(대기)
 *  - uploading: storage 업로드 중(percent 0~100)
 *  - processing: 영상 서버 처리 중(pending)
 *  - done: 저장 완료(사진 즉시 / 영상 검증 후)
 *  - failed: 업로드·검증 실패(재시도 가능)
 */
export type DiaryUploadPhase =
  | "queued"
  | "uploading"
  | "processing"
  | "done"
  | "failed";

export interface DiaryUploadItemState {
  phase: DiaryUploadPhase;
  /** uploading 일 때 0~100. */
  percent?: number;
  mediaType?: "image" | "video";
}

export interface DiaryUploadBadge {
  kind: DiaryUploadPhase;
  label: string;
}

/** 항목 오버레이 배지(목업 ③: 완료 ✓ / 업로드 중 % / 영상 처리 중 / 실패·다시 시도). */
export function diaryUploadBadge(item: DiaryUploadItemState): DiaryUploadBadge {
  switch (item.phase) {
    case "done":
      return { kind: "done", label: "완료" };
    case "uploading": {
      const pct = Math.max(0, Math.min(100, Math.round(item.percent ?? 0)));
      return { kind: "uploading", label: `업로드 중 ${pct}%` };
    }
    case "processing":
      return { kind: "processing", label: "영상 처리 중" };
    case "failed":
      return { kind: "failed", label: "실패 · 다시 시도" };
    default:
      return { kind: "queued", label: "대기 중" };
  }
}

export interface DiaryUploadCta {
  /** wait: 진행 중(비활성 톤) · go: 저장 완료(강조) · idle: 선택 대기. */
  kind: "idle" | "wait" | "go";
  label: string;
  /** 하단 보조 안내(영상 처리 중일 때). */
  subLabel: string | null;
}

/**
 * 배치 CTA(③ 하단). 업로드/처리 진행 중이면 대기, 처리만 남았으면 "나머지 저장됨" 안내,
 * 전부 완료면 완료(go). 항목이 없으면 idle.
 */
export function diaryUploadCta(
  items: ReadonlyArray<DiaryUploadItemState>,
): DiaryUploadCta {
  if (items.length === 0) {
    return { kind: "idle", label: "사진·영상을 선택하세요", subLabel: null };
  }
  const uploading = items.filter((i) => i.phase === "uploading").length;
  const processing = items.filter((i) => i.phase === "processing").length;
  const failed = items.filter((i) => i.phase === "failed").length;
  const done = items.filter((i) => i.phase === "done").length;

  if (uploading > 0) {
    return { kind: "wait", label: `${uploading}개 올리는 중…`, subLabel: null };
  }
  if (processing > 0) {
    return {
      kind: "wait",
      label: `${processing}개 처리 중 · 나머지 저장됨`,
      subLabel: "영상 처리가 끝나면 다이어리에 자동으로 떠요",
    };
  }
  if (done > 0 && failed === 0) {
    return { kind: "go", label: `${done}개 저장 완료`, subLabel: null };
  }
  if (done > 0 && failed > 0) {
    return {
      kind: "go",
      label: `${done}개 저장됨 · ${failed}개 실패`,
      subLabel: "실패한 항목은 다시 시도할 수 있어요",
    };
  }
  if (failed > 0) {
    return { kind: "idle", label: "다시 시도해주세요", subLabel: null };
  }
  return { kind: "idle", label: "사진·영상을 선택하세요", subLabel: null };
}

/**
 * 상세 뷰어(④) 댓글 노출 여부. GPS 인증(venueVerified=true)만 읽기전용 댓글을 보여주고,
 * 직접 추가(false)는 댓글 영역 대신 안내 문구를 노출한다(API 계약 3).
 */
export function diaryShowsComments(venueVerified: boolean): boolean {
  return venueVerified === true;
}

/** 홈(①) GPS 인증 요약(직관 기록 API summary). '전체' 세그먼트는 시즌별 summary를 합산한다. */
export interface DiaryVenueSummary {
  attendanceCount: number;
  wins: number;
  losses: number;
  draws: number;
  finalCount: number;
  winRate: number | null;
}

/**
 * 여러 시즌 summary를 합산한다('전체' 세그먼트). winRate는 합산 승/무/패로 재계산한다
 * (시즌별 winRate 평균이 아니라 전체 표본 기준).
 */
export function mergeVenueSummaries(
  summaries: ReadonlyArray<DiaryVenueSummary>,
): DiaryVenueSummary {
  const acc = summaries.reduce(
    (sum, s) => ({
      attendanceCount: sum.attendanceCount + s.attendanceCount,
      wins: sum.wins + s.wins,
      losses: sum.losses + s.losses,
      draws: sum.draws + s.draws,
      finalCount: sum.finalCount + s.finalCount,
    }),
    { attendanceCount: 0, wins: 0, losses: 0, draws: 0, finalCount: 0 },
  );
  const decided = acc.wins + acc.losses + acc.draws;
  return { ...acc, winRate: decided > 0 ? acc.wins / decided : null };
}

/** 홈(①) 경기 카드에 얹을 미디어 썸네일. */
export interface DiaryHomeThumb {
  id: number;
  mediaType: "video" | "image";
  thumbUrl: string;
  venueVerified: boolean;
}

/** 홈(①) 경기 미디어 그룹(목록 API 계약 2). */
export interface DiaryMediaGroupInput {
  gameId: string;
  gameDate: string | null;
  stadiumName: string | null;
  counts: { image: number; video: number; total: number };
  thumbnails: DiaryHomeThumb[];
}

/** 홈(①) 승·무·패/점수 소스(직관 기록 API). */
export interface DiaryAttendanceInput {
  gameId: string;
  result: "W" | "L" | "D" | null;
  awayTeam: { id: number; name: string; score: number | null } | null;
  homeTeam: { id: number; name: string; score: number | null } | null;
}

/** 홈(①) 경기 카드 뷰모델 — 미디어(썸네일)와 성적(점수/결과)을 gameId로 병합. */
export interface DiaryHomeGame {
  gameId: string;
  gameDate: string | null;
  stadiumName: string | null;
  label: DiarySourceLabel;
  thumbnails: DiaryHomeThumb[];
  /** 썸네일로 보여준 것 외 나머지 개수(`+N`). */
  extraCount: number;
  total: number;
  result: "W" | "L" | "D" | null;
  awayTeam: { id: number; name: string; score: number | null } | null;
  homeTeam: { id: number; name: string; score: number | null } | null;
}

/**
 * 미디어 그룹(썸네일·라벨)과 직관 기록(점수·결과)을 gameId로 병합한다.
 * 미디어 그룹 순서(최신 경기 먼저)를 보존한다. 썸네일은 홈 상한(6)까지만, 나머지는 extraCount.
 */
export function buildDiaryHomeGames(input: {
  mediaGroups: ReadonlyArray<DiaryMediaGroupInput>;
  attendanceGames: ReadonlyArray<DiaryAttendanceInput>;
  thumbnailsPerGame?: number;
}): DiaryHomeGame[] {
  const cap = input.thumbnailsPerGame ?? VENUE_DIARY_HOME_THUMBNAILS;
  const byGame = new Map<string, DiaryAttendanceInput>();
  for (const game of input.attendanceGames) byGame.set(game.gameId, game);

  return input.mediaGroups.map((group) => {
    const attendance = byGame.get(group.gameId) ?? null;
    const thumbnails = group.thumbnails.slice(0, cap);
    const extraCount = Math.max(0, group.counts.total - thumbnails.length);
    return {
      gameId: group.gameId,
      gameDate: group.gameDate,
      stadiumName: group.stadiumName,
      label: diaryGameSourceLabel(group.thumbnails),
      thumbnails,
      extraCount,
      total: group.counts.total,
      result: attendance?.result ?? null,
      awayTeam: attendance?.awayTeam ?? null,
      homeTeam: attendance?.homeTeam ?? null,
    };
  });
}

// ── 목록 cursor 전페이지 병합(Blocker 1) ─────────────────────────────────────
// A2 목록 API 는 30경기 keyset(nextCursor/hasMore)로 응답한다. 첫 페이지만 쓰면 31번째+ 경기가
// 홈에서 영구 미노출되고 N/10 count 가 0 으로 틀린다 → hasMore 동안 cursor 로 순차 fetch 해 병합한다.

/** 한 시즌 목록 페이지(서버 응답 shape). */
export interface DiaryMediaPage {
  games: DiaryMediaGroupInput[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * cursor 페이징 무한루프 방지 상한. 경기당 유저 상한 10, 페이지당 30경기이므로
 * 40페이지(=1200경기)면 단일 시즌 현실 표본을 크게 상회한다(방어선).
 */
export const VENUE_DIARY_MAX_LIST_PAGES = 40;

/**
 * 다음 cursor 페이지를 계속 fetch 할지 판정한다(무한루프 가드).
 * hasMore=true·유효 cursor·상한 미만일 때만 진행한다.
 */
export function shouldFetchNextDiaryPage(input: {
  hasMore: boolean;
  nextCursor: string | null;
  pagesFetched: number;
  maxPages?: number;
}): boolean {
  const max = input.maxPages ?? VENUE_DIARY_MAX_LIST_PAGES;
  return (
    input.hasMore &&
    typeof input.nextCursor === "string" &&
    input.nextCursor.length > 0 &&
    input.pagesFetched < max
  );
}

/**
 * cursor 로 순차 fetch 한 페이지들을 순서 보존 병합하고 gameId 중복을 제거한다(첫 등장 우선).
 * 서버가 (game_date DESC, game_id DESC) 안정 정렬을 하므로 페이지 경계 중복만 방어한다.
 */
export function mergeDiaryMediaPages(
  pages: ReadonlyArray<{ games: ReadonlyArray<DiaryMediaGroupInput> }>,
): DiaryMediaGroupInput[] {
  const seen = new Set<string>();
  const merged: DiaryMediaGroupInput[] = [];
  for (const page of pages) {
    for (const game of page.games) {
      if (seen.has(game.gameId)) continue;
      seen.add(game.gameId);
      merged.push(game);
    }
  }
  return merged;
}

// ── signed URL 4분 재발급 apply(Blocker 1) ──────────────────────────────────
// A2 signed URL TTL=5분. 뷰어 체류·목록 노출 중 만료 전 재발급하되 id/순서/카운트/댓글은 보존하고
// URL(mediaUrl/thumbUrl)만 교체한다. 재발급 루프는 refresh-policy.startVenueStoryUrlRefresh 를 재사용한다.

export interface DiaryDetailUrlRefresh {
  id: number;
  mediaUrl: string;
  thumbUrl: string | null;
}

/** 상세 뷰어: 기존 미디어의 id/순서/댓글은 그대로 두고 signed URL 만 최신값으로 교체(late apply 안전). */
export function applyDiaryDetailUrlRefresh<
  T extends { id: number; mediaUrl: string; thumbUrl: string | null },
>(media: ReadonlyArray<T>, fresh: ReadonlyArray<DiaryDetailUrlRefresh>): T[] {
  const byId = new Map(fresh.map((m) => [m.id, m]));
  return media.map((m) => {
    const next = byId.get(m.id);
    return next ? { ...m, mediaUrl: next.mediaUrl, thumbUrl: next.thumbUrl } : m;
  });
}

/** 홈 목록: 경기별 썸네일 thumbUrl 만 최신 첫 페이지 값으로 교체(id/순서/카운트 보존). */
export function applyDiaryThumbUrlRefresh(
  groups: ReadonlyArray<DiaryMediaGroupInput>,
  fresh: ReadonlyArray<DiaryMediaGroupInput>,
): DiaryMediaGroupInput[] {
  const freshThumbById = new Map<number, string>();
  for (const g of fresh) {
    for (const t of g.thumbnails) freshThumbById.set(t.id, t.thumbUrl);
  }
  return groups.map((g) => ({
    ...g,
    thumbnails: g.thumbnails.map((t) => {
      const url = freshThumbById.get(t.id);
      return url != null ? { ...t, thumbUrl: url } : t;
    }),
  }));
}

// ── 명시적 업로드 CTA + caption 소스(Blocker 2) ──────────────────────────────
// 파일 선택은 queued 까지만. 동의 완료 + 제출 시점 caption 을 읽는 명시적 CTA 로만 전송을 시작한다.

/** 실제 전송할 항목만(queued/failed). done/uploading/processing 은 재전송하지 않는다. */
export function diaryUploadTargets<T extends { state: DiaryUploadItemState }>(
  items: ReadonlyArray<T>,
): T[] {
  return items.filter(
    (i) => i.state.phase === "queued" || i.state.phase === "failed",
  );
}

/** 업로드 시작 가능 여부: 동의 완료 + 전송 대상(queued/failed) 존재. */
export function diaryCanStartUpload(
  items: ReadonlyArray<DiaryUploadItemState>,
  agreed: boolean,
): boolean {
  return agreed && items.some((i) => i.phase === "queued" || i.phase === "failed");
}

/** POST body 의 caption 소스 — 선택 순간 closure 가 아니라 제출 시점 입력값을 정규화해 넘긴다. */
export function diaryCaptionForSubmit(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 하단 기본 버튼 상태.
 *  - 전송 대상(queued/failed)이 남고 업로드 중이 아니면 명시적 업로드 CTA(action=upload).
 *  - 그 외(업로드/처리 중·완료·빈 상태)는 기존 배치 CTA(action=close).
 */
export interface DiaryBottomCta {
  action: "upload" | "close";
  kind: "idle" | "wait" | "go" | "start";
  label: string;
  subLabel: string | null;
  disabled: boolean;
}

export function diaryBottomCta(
  items: ReadonlyArray<DiaryUploadItemState>,
  agreed: boolean,
): DiaryBottomCta {
  const uploading = items.some((i) => i.phase === "uploading");
  const pending = items.filter(
    (i) => i.phase === "queued" || i.phase === "failed",
  ).length;
  if (pending > 0 && !uploading) {
    return {
      action: "upload",
      kind: "start",
      label: agreed ? `${pending}개 올리기` : "가이드라인에 동의해주세요",
      subLabel: null,
      disabled: !agreed,
    };
  }
  const base = diaryUploadCta(items);
  return {
    action: "close",
    kind: base.kind,
    label: base.kind === "idle" ? "완료" : base.label,
    subLabel: base.subLabel,
    disabled: base.kind === "wait",
  };
}

// ── uploading 이탈 경고 / pending 안전 카피(Blocker 3) ────────────────────────
// uploading(XHR/fetch 진행 중)에는 이탈 경고 + actual guard, 서버 pending/processing 에만 "나가도 계속".

export interface DiaryLeaveNotice {
  tone: "warn" | "safe";
  text: string;
  /** 실제 이탈 가드(close/back/beforeunload confirm) 필요 여부. uploading 일 때만 true. */
  guard: boolean;
}

export function diaryLeaveNotice(
  items: ReadonlyArray<DiaryUploadItemState>,
): DiaryLeaveNotice {
  if (items.some((i) => i.phase === "uploading")) {
    return {
      tone: "warn",
      text: "🔒 올리는 중이에요. 지금 나가면 업로드가 중단돼요.",
      guard: true,
    };
  }
  if (items.some((i) => i.phase === "processing")) {
    return {
      tone: "safe",
      text: "🔒 사진·영상은 비공개로 저장돼요. 영상 처리는 나가도 계속돼요.",
      guard: false,
    };
  }
  return {
    tone: "safe",
    text: "🔒 올린 사진·영상은 비공개로 저장돼 나만 볼 수 있어요.",
    guard: false,
  };
}
