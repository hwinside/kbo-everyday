import type { VenueStory } from "./types";
import { mergePendingStories } from "./composer-helpers";

// 공개 signed URL(최대 5분)이 뷰어 체류 중 만료되기 전에 현재 스토리만 재발급한다.
// 단건 refresh API는 캐시를 우회해 새 URL을 발급하므로 4분마다 갱신해 1분 여유를 둔다.
export const VENUE_STORY_URL_REFRESH_MS = 240_000;
export const VENUE_STORY_URL_RETRY_MS = 10_000;
export const VENUE_STORY_URL_MAX_ATTEMPTS = 3;
export const VENUE_STORY_URL_RETRY_COOLDOWN_MS = 60_000;
// mint(getSafeSession/fetch/json)는 자체 timeout 이 없으면 요청 1회가 안 끝날 때
// in-flight·다음 timer 가 영구 정지한다 → 반드시 이 상한 안에 settle 시켜 10초 retry 로 넘긴다.
// retry(10초)보다 짧고 5분 URL 만료보다 훨씬 짧게 두어 여러 번 복구 기회를 확보한다.
export const VENUE_STORY_URL_MINT_TIMEOUT_MS = 8_000;

export interface VenueStoryUrlRefresh {
  id: number;
  mediaUrl: string;
  thumbUrl: string | null;
}

export function shouldRefreshVenueStoryUrl(input: {
  storyId: number;
  previousStoryId: number | null;
  lastRefreshAt: number;
  now: number;
}): boolean {
  return (
    input.storyId !== input.previousStoryId ||
    input.now - input.lastRefreshAt >= VENUE_STORY_URL_REFRESH_MS
  );
}

/** 한 cycle은 3회로 제한하고, 모두 실패하면 1분 뒤 새 cycle로 복구를 계속 시도한다. */
export function venueStoryUrlRetryDelay(failedAttempts: number): number {
  return failedAttempts < VENUE_STORY_URL_MAX_ATTEMPTS
    ? VENUE_STORY_URL_RETRY_MS
    : VENUE_STORY_URL_RETRY_COOLDOWN_MS;
}

/**
 * mint 를 반드시 timeoutMs 안에 settle 시킨다.
 * run 이 끝나지 않아도 timer 가 controller.abort() 하고 timeoutValue 로 resolve 하므로,
 * 호출부의 in-flight/다음 timer 가 영구 정지하지 않는다(삼순: never-settle→timeout/abort).
 * setTimer/clearTimer/controller 를 주입받아 실제 콜백·timer 경로를 회귀로 고정할 수 있다.
 */
export async function mintWithTimeout<T, H = unknown>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutValue: T,
  opts: {
    timeoutMs: number;
    setTimer: (fn: () => void, ms: number) => H;
    clearTimer: (handle: H) => void;
    controller: AbortController;
  },
): Promise<T> {
  let timer: H | null = null;
  const timeout = new Promise<T>((resolve) => {
    timer = opts.setTimer(() => {
      opts.controller.abort();
      resolve(timeoutValue);
    }, opts.timeoutMs);
  });
  try {
    return await Promise.race([
      run(opts.controller.signal).catch(() => timeoutValue),
      timeout,
    ]);
  } finally {
    if (timer != null) opts.clearTimer(timer);
  }
}

/**
 * 뷰어 체류 중 현재 스토리 signed URL 재발급 루프(순수·주입형).
 * - 성공 후에만 last-success 를 기록(실패는 갱신시각 미선기록 → 5분 만료 전 복구).
 * - 실패는 10초 bounded retry(3회 후 1분 cooldown).
 * - in-flight/current-story guard 로 중복 요청·전환 오염을 막는다.
 * setTimer/clearTimer/now/refresh 를 주입받아 컴포넌트와 테스트가 동일 코드를 실행한다.
 * 반환값은 cleanup(취소) 함수.
 */
export interface VenueStoryUrlRefreshLoopDeps<H = unknown> {
  storyId: number;
  isCurrentStory: () => boolean;
  // controller 는 loop 가 소유한다. cleanup/전환 시 loop 가 즉시 abort하며, timeout 도 같은 controller 를 abort 한다.
  // refresh 는 이 controller.signal 로 fetch 를 끊고 setStories apply 전에 signal.aborted 를 확인해야 한다(오염0).
  refresh: (storyId: number, controller: AbortController) => Promise<boolean>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => H;
  clearTimer: (handle: H) => void;
  // AbortController 소유권을 loop 가 가진다(테스트 주입용). 기본은 전역 AbortController.
  makeController?: () => AbortController;
  getPreviousStoryId: () => number | null;
  setPreviousStoryId: (value: number) => void;
  getLastRefreshAt: () => number;
  setLastRefreshAt: (value: number) => void;
}

export function startVenueStoryUrlRefresh<H = unknown>(
  deps: VenueStoryUrlRefreshLoopDeps<H>,
): () => void {
  let cancelled = false;
  let inFlight = false;
  let failedAttempts = 0;
  let timer: H | null = null;
  // 현재 in-flight mint 의 controller. loop 가 소유해 cleanup/전환 시 즉시 abort 한다.
  let activeController: AbortController | null = null;
  const makeController = deps.makeController ?? (() => new AbortController());
  const isCurrent = () => !cancelled && deps.isCurrentStory();
  const schedule = (delayMs: number) => {
    if (timer != null) deps.clearTimer(timer);
    timer = deps.setTimer(() => void run(), delayMs);
  };
  const run = async () => {
    if (!isCurrent() || inFlight) return;
    const now = deps.now();
    if (
      !shouldRefreshVenueStoryUrl({
        storyId: deps.storyId,
        previousStoryId: deps.getPreviousStoryId(),
        lastRefreshAt: deps.getLastRefreshAt(),
        now,
      })
    ) {
      schedule(
        Math.max(1, deps.getLastRefreshAt() + VENUE_STORY_URL_REFRESH_MS - now),
      );
      return;
    }
    inFlight = true;
    const controller = makeController();
    activeController = controller;
    let success = false;
    try {
      success = await deps.refresh(deps.storyId, controller);
    } catch {
      success = false;
    } finally {
      inFlight = false;
      if (activeController === controller) activeController = null;
    }
    // A 요청 중 B로 전환/cleanup 된 경우(=cancelled 또는 isCurrentStory=false) A 결과를 반영하지 않고
    // 재예약도 안 한다(오염0·누수 차단). 단, timeout 으로만 abort 된 경우(isCurrent 유지)는
    // 정상 실패 취급해 아래 retry 로 넘긴다(controller.signal.aborted 를 여기서 게이트하면
    // timeout 도 같이 막혀 5분 공백이 재발생한다). 늦은 setStories 유입은 callback 의 aborted 확인이 막는다.
    if (!isCurrent()) return;
    if (success) {
      deps.setPreviousStoryId(deps.storyId);
      deps.setLastRefreshAt(deps.now());
      failedAttempts = 0;
      schedule(VENUE_STORY_URL_REFRESH_MS);
      return;
    }
    failedAttempts += 1;
    const delay = venueStoryUrlRetryDelay(failedAttempts);
    if (delay === VENUE_STORY_URL_RETRY_COOLDOWN_MS) failedAttempts = 0;
    schedule(delay);
  };
  void run();
  return () => {
    cancelled = true;
    if (timer != null) deps.clearTimer(timer);
    // 전환/언마운트 시 in-flight mint 를 즉시 abort 해 늦은 결과 유입·리소스 누수를 막는다.
    if (activeController != null) activeController.abort();
  };
}

/** 현재 ID·순번·메타데이터는 그대로 두고 signed URL만 교체한다. */
export function applyVenueStoryUrlRefresh(
  stories: VenueStory[],
  refresh: VenueStoryUrlRefresh,
): VenueStory[] {
  return stories.map((story) =>
    story.id === refresh.id
      ? { ...story, mediaUrl: refresh.mediaUrl, thumbUrl: refresh.thumbUrl }
      : story,
  );
}

export function shouldApplyAutomaticStoryRefresh(input: {
  automatic: boolean;
  requestId: number;
  latestRequestId: number;
  blocked: boolean;
  hidden: boolean;
}): boolean {
  if (input.requestId !== input.latestRequestId) return false;
  if (!input.automatic) return true;
  return !input.blocked && !input.hidden;
}

/**
 * fetch 응답을 목록에 commit 할지 판정한다.
 * 비정상 응답(401/500 등)은 false → 호출부가 setStories 를 건너뛰어 마지막 정상 목록을 보존한다.
 * (삼순 왕복2: res.ok boolean 만으로는 non-2xx 보존이 회귀로 고정되지 않는다 → 이 정책을 순수화)
 */
export function shouldCommitStoryFetch(ok: boolean): boolean {
  return ok;
}

/**
 * apply 경로의 최종 목록을 구성한다(순수). 실패 카드를 선두에 유지하고 서버 active + 낙관 pending 을 병합.
 * 컴포넌트의 setStories 업데이터가 이 함수를 그대로 사용해, "200 신규 목록 반영 / 401·500 기존 목록 보존"
 * 계약을 harness 로 고정한다.
 */
export function buildCommittedStories(
  prev: VenueStory[],
  server: VenueStory[],
  failedIds: ReadonlySet<number>,
  pendingIds: ReadonlySet<number>,
): VenueStory[] {
  const failed = prev
    .filter((story) => failedIds.has(story.id))
    .map((story) => ({
      ...story,
      processing: false,
      stalled: false,
      failed: true,
    }));
  return [...failed, ...mergePendingStories(prev, server, pendingIds)];
}
