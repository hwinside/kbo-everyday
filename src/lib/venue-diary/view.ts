// 직관 다이어리 A4 UI 순수 뷰 로직 — 상태 판정만(DOM/네트워크 없음, 회귀 테스트 대상).
//
// 화면별 분기(GPS인증/직접추가 라벨 · 경기 선택 N/10 · 업로드 항목 상태 · 상세 댓글 숨김)를
// 컴포넌트에서 떼어내 순수 함수로 고정한다. 계약은 /api/me/venue-diary/media, /api/me/venue-attendance.

import { VENUE_STORY_MAX_PER_USER_PER_GAME } from "@/lib/venue-stories/types";
import {
  mintWithTimeout,
  VENUE_STORY_URL_MINT_TIMEOUT_MS,
} from "@/lib/venue-stories/refresh-policy";

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
  | "failed"
  | "stalled";

export interface DiaryUploadItemState {
  phase: DiaryUploadPhase;
  /** uploading 일 때 0~100. */
  percent?: number;
  mediaType?: "image" | "video";
  /** POST 반환 story id — pending 영상 terminal 추적용(Blocker 3). */
  storyId?: number;
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
    case "stalled":
      return { kind: "stalled", label: "처리 지연 · 나중에 확인" };
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

// ── 승률 표시 범위 토글(2026-07-30 정책 변경) ──────────────────────────────────────
// 기본값: 승률·승/패/무는 GPS 인증 + 직접 추가(diary_manual) 전체(all).
// 옵션: 토글로 GPS 인증만(gps) 전환. 인증 직관수(배지 계약)는 항상 certified 을 쓴다.

/** 승률 표시 범위: all = GPS+직접 추가(기본) · gps = GPS 인증만. */
export type DiaryWinRateScope = "all" | "gps";

/** 기본 범위 — 직접 추가 포함 전체(하린아빠 확정 2026-07-30). */
export const DIARY_WIN_RATE_DEFAULT_SCOPE: DiaryWinRateScope = "all";

/** 한 시즌의 summary 쌍: certified = GPS 인증만 · overall = 직접 추가 포함 전체. */
export interface DiarySummaryPair {
  certified: DiaryVenueSummary;
  overall: DiaryVenueSummary;
}

/** 여러 시즌의 summary 쌍을 한 번에 합산한다('전체' 세그먼트). */
export function mergeDiarySummaryPairs(
  pairs: ReadonlyArray<DiarySummaryPair>,
): DiarySummaryPair {
  return {
    certified: mergeVenueSummaries(pairs.map((p) => p.certified)),
    overall: mergeVenueSummaries(pairs.map((p) => p.overall)),
  };
}

/** 토글 범위에 맞는 승률·승/패/무 소스 summary. 인증 직관수에는 쓰지 않는다. */
export function diaryDisplaySummary(
  pair: DiarySummaryPair,
  scope: DiaryWinRateScope,
): DiaryVenueSummary {
  return scope === "gps" ? pair.certified : pair.overall;
}

/** 승률 아래 범위 캐프션 — 지금 보는 승률이 어느 집합 기준인지 명시. */
export function diaryWinRateScopeCaption(scope: DiaryWinRateScope): string {
  return scope === "gps" ? "승률·승패 · GPS 인증만" : "승률·승패 · 직접 추가 포함";
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

// ── signed URL 4분 재발급 callback — A1 mintWithTimeout bounded(Blocker 1) ─────────────
// getSafeSession/fetch/json 이 1회라도 non-settle 이면 startVenueStoryUrlRefresh 의 inFlight 가 영구
// 고정되고 retry timer 가 안 잡힌다 → 세션 취득까지 포함한 전체 mint 를 mintWithTimeout(8s, loop
// controller) 로 감싸 반드시 settle시킨다(VenueStorySection A1 production 패턴 동일).
// getToken/fetch/apply 를 주입받아 컴포넌트와 테스트가 동일 콜백 경로를 실행한다(actual-wiring).

export interface DiaryBoundedRefreshTimers<H = unknown> {
  timeoutMs?: number;
  setTimer: (fn: () => void, ms: number) => H;
  clearTimer: (handle: H) => void;
}

/**
 * 홈 목록 썸네일 signed URL 재발급 refresh 콜백(Blocker 1+2). 현재 로드한 cursor 전페이지를
 * 재발급해 31번째+ 썸네일도 만료 전 갱신한다(fetchAllPages = 전페이지). 전체 mint 는
 * mintWithTimeout 로 bounded.
 */
export function makeDiaryThumbRefresh<H = unknown>(deps: {
  seasons: ReadonlyArray<number>;
  getToken: () => Promise<string | null>;
  fetchAllPages: (
    token: string,
    season: number,
    signal: AbortSignal,
  ) => Promise<DiaryMediaGroupInput[] | null>;
  isCurrent: () => boolean;
  apply: (fresh: DiaryMediaGroupInput[]) => void;
  timers: DiaryBoundedRefreshTimers<H>;
}): (storyId: number, controller: AbortController) => Promise<boolean> {
  return (_storyId, controller) =>
    mintWithTimeout(
      async (signal) => {
        const token = await deps.getToken();
        if (!token) return false;
        const results = await Promise.all(
          deps.seasons.map((s) => deps.fetchAllPages(token, s, signal)),
        );
        if (results.some((r) => r == null)) return false;
        // 전환/cleanup 로 abort 되었거나 소유권이 바뀌었으면 늦은 응답을 반영하지 않는다.
        if (signal.aborted || !deps.isCurrent()) return false;
        deps.apply(results.flatMap((r) => r ?? []));
        return true;
      },
      false,
      {
        timeoutMs: deps.timers.timeoutMs ?? VENUE_STORY_URL_MINT_TIMEOUT_MS,
        setTimer: deps.timers.setTimer,
        clearTimer: deps.timers.clearTimer,
        controller,
      },
    );
}

/**
 * 상세 뷰어 signed URL 재발급 refresh 콜백(Blocker 1). fetchMedia 는 gameId 를 closure 로 가진다.
 * 전체 mint 를 mintWithTimeout 로 bounded 해 never-settle 에도 8s에 settle→retry 된다.
 */
export function makeDiaryDetailRefresh<H = unknown>(deps: {
  getToken: () => Promise<string | null>;
  fetchMedia: (
    token: string | null,
    signal: AbortSignal,
  ) => Promise<DiaryDetailUrlRefresh[] | null>;
  isCurrent: () => boolean;
  apply: (fresh: DiaryDetailUrlRefresh[]) => void;
  timers: DiaryBoundedRefreshTimers<H>;
}): (storyId: number, controller: AbortController) => Promise<boolean> {
  return (_storyId, controller) =>
    mintWithTimeout(
      async (signal) => {
        const token = await deps.getToken();
        const fresh = await deps.fetchMedia(token, signal);
        if (fresh == null) return false;
        if (signal.aborted || !deps.isCurrent()) return false;
        deps.apply(fresh);
        return true;
      },
      false,
      {
        timeoutMs: deps.timers.timeoutMs ?? VENUE_STORY_URL_MINT_TIMEOUT_MS,
        setTimer: deps.timers.setTimer,
        clearTimer: deps.timers.clearTimer,
        controller,
      },
    );
}

// ── pending 영상 id 추적 terminal poll(Blocker 3) ─────────────────────────────
// POST 반환 story id 를 추적해 pending→archived/timeout terminal 까지 polling 한다.
// 고정 지연 60초 뒤 blindly 종료하던 것을 id 승급 관측으로 바꾼다(uploader 항목 영구 processing 방지).
// probe 는 상세 GET(active|archived)에서 id 존재 여부를 반환 — found=archived 승급.
// 상세 GET 은 active|archived 만 주므로 실제 관측값은 found(archived) / not-found(계속) 뿐이다.
// production 도달 불가인 `removed` terminal 은 허위계약이라 제거했다(삼순 3차 B3).

export type DiaryPendingTerminal = "archived" | "timeout";

/** 한 번의 poll 관측. found=상세 GET(active|archived)에 id 등장(승급). null 은 관측 실패(계속). */
export interface DiaryPendingProbe {
  found: boolean;
}

/**
 * poll 관측 + 남은 시도 횟수로 terminal 을 판정한다(순수).
 * found→archived, 못 찾고 시도 소진→timeout, 그 외는 계속(null).
 */
export function classifyDiaryPendingPoll(input: {
  probe: DiaryPendingProbe | null;
  attemptsLeft: number;
}): DiaryPendingTerminal | null {
  if (input.probe?.found) return "archived";
  if (input.attemptsLeft <= 0) return "timeout";
  return null;
}

/** terminal → uploader 항목 phase: archived→done, timeout→stalled. */
export function diaryPendingTerminalPhase(
  terminal: DiaryPendingTerminal,
): DiaryUploadPhase {
  return terminal === "archived" ? "done" : "stalled";
}

/**
 * pending 영상 terminal poll 루프(순수·주입형). delays 순서대로 probe 해 terminal 까지 돌고,
 * terminal 에서 onTerminal 을 호출한 뒤 멈춘다(타이머 중단). 반환값은 cancel 함수.
 *
 * poll 1회도 반드시 bounded settle 시킨다: probe 를 mintWithTimeout(per-poll AbortController)로 감싸
 * probe 가 throw 하거나 never-settle 이어도 null 로 떨어져 다음 tick 이 예약된다(영구정지 0, 삼순 3차 B3).
 * cleanup 은 activeController.abort() 로 in-flight probe 를 즉시 끊는다.
 * setTimer/clearTimer/makeController 를 주입받아 컴포넌트와 테스트가 동일 코드를 실행한다(actual-wiring).
 */
export function startDiaryPendingPoll<H = unknown>(deps: {
  delays: ReadonlyArray<number>;
  probe: (signal: AbortSignal) => Promise<DiaryPendingProbe | null>;
  onTerminal: (terminal: DiaryPendingTerminal) => void;
  setTimer: (fn: () => void, ms: number) => H;
  clearTimer: (handle: H) => void;
  makeController?: () => AbortController;
  probeTimeoutMs?: number;
}): () => void {
  let cancelled = false;
  let timer: H | null = null;
  let activeController: AbortController | null = null;
  let index = 0;
  const makeController = deps.makeController ?? (() => new AbortController());
  const timeoutMs = deps.probeTimeoutMs ?? VENUE_STORY_URL_MINT_TIMEOUT_MS;
  const schedule = () => {
    if (timer != null) deps.clearTimer(timer);
    timer = deps.setTimer(() => void step(), deps.delays[index] ?? 0);
  };
  const step = async () => {
    if (cancelled) return;
    const controller = makeController();
    activeController = controller;
    // probe 전체(getSafeSession→fetch→json)를 8s bounded: throw→catch→null, never-settle→abort→null.
    const probe = await mintWithTimeout<DiaryPendingProbe | null, H>(
      (signal) => deps.probe(signal),
      null,
      { timeoutMs, setTimer: deps.setTimer, clearTimer: deps.clearTimer, controller },
    );
    if (activeController === controller) activeController = null;
    if (cancelled) return;
    const attemptsLeft = deps.delays.length - (index + 1);
    const terminal = classifyDiaryPendingPoll({ probe, attemptsLeft });
    if (terminal) {
      deps.onTerminal(terminal);
      return;
    }
    index += 1;
    if (index < deps.delays.length) schedule();
  };
  if (deps.delays.length > 0) schedule();
  return () => {
    cancelled = true;
    if (timer != null) deps.clearTimer(timer);
    if (activeController != null) activeController.abort();
  };
}

// ── 경기별 N/10 counts(Blocker 4) ─────────────────────────────────────
// AddGameSheet 는 경기 선택이 2026 고정이므로 항상 2026 counts 를 써야 한다. 현재 홈 탭(2025)의
// mediaGroups 로 counts 를 만들면 2026 기존 10/10 경기가 0/10·선택가능으로 오표시된다.

/** 경기 미디어 그룹들을 gameId→total 개수 Map 으로 만든다(N/10 오버레이 소스). */
export function buildDiaryCountsMap(
  groups: ReadonlyArray<DiaryMediaGroupInput>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const g of groups) map.set(g.gameId, g.counts.total);
  return map;
}

/**
 * AddGameSheet 경기 선택 비활성 판정(fail-closed, Blocker 4). 2026 counts 가 확정(countsReady)되기
 * 전에는 어떤 경기도 선택 불가 — 미확정 count 를 0 으로 오인해 10/10 경기를 선택가능으로
 * 노출하고 업로드 후 서버 10cap 실패하는 fail-open 을 막는다. 확정 후에만 상한(locked)을 반영.
 */
export function diaryAddSelectDisabled(
  countsReady: boolean,
  count: number,
): boolean {
  if (!countsReady) return true;
  return diaryPickLocked(diaryPickState(count));
}

// counts 는 특정 (userId, open 세션, 시즌)에 결속된다. 재오픈/유저 전환/시즌 전환 첫 렌더에서
// 이전 counts 를 countsReady=true 로 그대로 넘기면 fail-open(기존 10/10 을 0/10 로 오표시)이 된다.
// 특히 시즌은 counts 집합 자체가 달라지므로 key 에 반드시 포함해야 한다.
// effect 초기화는 렌더 뒤라 첫 렌더를 못 막으므로, 렌더 단계에서 owner key 불일치면 즉시
// fail-closed 한다(Blocker: 재오픈/유저/시즌 전환 stale counts).

/** counts 소유 key: 이 counts 가 어느 유저·open 세션·시즌에 대한 것인지. */
export function diaryCountsOwnerKey(
  userId: string,
  openSeq: number,
  season: number,
): string {
  return `${userId}:${openSeq}:${season}`;
}

/** owner 가 현재 열린 (userId, openSeq, season) key 와 정확히 일치할 때만 ready(렌더 단계 fail-closed). */
export function diaryCountsReady(
  owner: string | null,
  currentKey: string | null,
): boolean {
  return owner != null && currentKey != null && owner === currentKey;
}
