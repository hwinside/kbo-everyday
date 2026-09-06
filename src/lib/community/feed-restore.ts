"use client";

/**
 * 커뮤니티 피드 복원(스크롤 + 로드된 페이지 수).
 *
 * 문제: 피드를 깊게 스크롤(무한 스크롤로 N페이지 로드)한 뒤 글 상세로 들어갔다가 뒤로가기로
 * 나오면 피드가 맨 위로 초기화된다. Next.js App Router가 스크롤 위치를 복원해줘도 **소용이 없다** —
 * `useUnifiedFeed`는 마운트마다 1페이지(20건)만 다시 불러오므로 문서 높이가 스크롤 위치보다
 * 훨씬 짧아져 브라우저가 복원한 offset이 잘려버린다. 즉 스크롤만 저장해서는 못 고친다.
 * 실측(production, 390x844): scrollY 12849 → 1243, 카드 31 → 11.
 *
 * 그래서 이 모듈은 두 가지를 함께 다룬다:
 *   ① 뒤로가기로 돌아온 것인지 판별(popstate 확정) — push 네비게이션에서는 복원하지 않는다.
 *   ② 떠날 때의 `pageCount`(로드된 페이지 수)와 `scrollY`를 저장 → 복귀 시 같은 분량을 채운 뒤 복원.
 *
 * PR #597(홈 '커뮤니티 최신글' → 상세 복귀)과는 **다른 화면·다른 원인**이다. #597은 홈의 한 섹션으로
 * 스크롤을 되돌리는 것이고, 여기는 피드 자체의 페이지네이션 상태가 유실되는 문제다.
 */

const KEY_PREFIX = "kbo:feed-restore:";
/**
 * popstate(뒤로가기)가 실제로 일어났음을 표시하는 1회용 플래그.
 * ⚠️ 값은 boolean 이 아니라 **뒤로가기가 도착한 경로**다. 전역 boolean 으로 두면 피드와 무관한
 * 뒤로가기(예: 경기 상세 → 순위 → 뒤로)가 남긴 플래그를 그 다음 피드 push 진입이 주워먹어
 * "push 진입은 최상단" 계약이 깨진다(삼순 리뷰 실측: 경기 back 후 커뮤니티 push 인데 12972 복원).
 * 그래서 pop 이 도착한 경로와 마운트한 피드 경로가 **같을 때만** 복원으로 승격한다.
 */
const POP_KEY = "kbo:feed-restore:popped-path";
/** 저장 상태 유효시간. 오래된 세션까지 복원하면 오히려 낯선 위치로 튄다. */
export const RESTORE_TTL_MS = 30 * 60 * 1000;

export type FeedRestoreState = {
  /** 복원해야 할 페이지 수(= 떠날 때 로드돼 있던 페이지 수). */
  pageCount: number;
  /** 떠날 때의 window.scrollY. */
  scrollY: number;
  /** 저장 시각(ms). TTL 판정용. */
  savedAt: number;
};

function storageKey(feedKey: string): string {
  return `${KEY_PREFIX}${feedKey}`;
}

/** sessionStorage 접근은 private mode/차단 환경에서 throw 할 수 있어 전부 안전 래핑한다. */
function safeGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* private mode 등 — 복원은 부가 기능이므로 조용히 포기 */
  }
}

function safeRemove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* noop */
  }
}

/**
 * 저장된 복원 상태를 파싱한다. 형식이 깨졌거나 TTL이 지났으면 null.
 * (순수 함수 — 회귀 테스트에서 직접 검증)
 */
export function parseRestoreState(raw: string | null, now: number): FeedRestoreState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const pageCount = o.pageCount;
  const scrollY = o.scrollY;
  const savedAt = o.savedAt;
  if (typeof pageCount !== "number" || !Number.isFinite(pageCount) || pageCount < 1) return null;
  if (typeof scrollY !== "number" || !Number.isFinite(scrollY) || scrollY < 0) return null;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  if (now - savedAt > RESTORE_TTL_MS) return null;
  return { pageCount, scrollY, savedAt };
}

/** 피드를 떠나기 직전 상태 저장. pageCount<=1 이면 복원할 게 없으므로 저장하지 않는다. */
export function saveFeedRestore(feedKey: string, pageCount: number, scrollY: number, now = Date.now()): void {
  if (pageCount <= 1 && scrollY <= 0) {
    safeRemove(storageKey(feedKey));
    return;
  }
  safeSet(storageKey(feedKey), JSON.stringify({ pageCount, scrollY, savedAt: now } satisfies FeedRestoreState));
}

/** 저장된 복원 상태 읽기(소비하지 않음). */
export function readFeedRestore(feedKey: string, now = Date.now()): FeedRestoreState | null {
  return parseRestoreState(safeGet(storageKey(feedKey)), now);
}

/** 복원 상태 소비(1회용) — 복원 후 다시 쓰이지 않도록 제거. */
export function clearFeedRestore(feedKey: string): void {
  safeRemove(storageKey(feedKey));
}

/**
 * 떠날 때 저장 판정(순수 — 회귀에서 직접 검증).
 *
 * 0 을 두 종류로 구분하는 게 핵심이다.
 *  - **라우터가 만든 0**: 상세로 이동할 때 스크롤이 먼저 0 으로 되돌아간 뒤 피드가 언마운트된다.
 *    이걸 저장하면 진짜 위치가 지워진다(실측 12972 → 0 → 복원해도 맨 위). → 무시(`ignore`).
 *  - **유저가 만든 진짜 0**: 유저가 직접 맨 위로 올렸다면 복원할 게 없다. 이때 그냥 무시하면
 *    오래된 깊은 위치가 남아 다음 복귀에 거기로 튄다(삼순 실측). → 저장 상태 제거(`clear`).
 *
 * 둘을 가르는 신호가 `leaving`(링크 클릭으로 이 피드를 떠나는 중인가)이다.
 */
export type FeedPersistDecision = "save" | "clear" | "ignore";

export function decideFeedPersist(leaving: boolean, scrollY: number): FeedPersistDecision {
  if (leaving) return "ignore";
  if (scrollY <= 0) return "clear";
  return "save";
}

/**
 * 한 번 확정된 복원 의사(intent). **effect 재실행에도 살아남아야 하는 값**이다.
 *
 * 왜 필요한가(삼순 재리뷰 실측): 로그인 세션의 전체문서 뒤로가기에서
 *  1. `useUnifiedFeed` 초기 effect 가 back_forward 를 1회 소비하고 저장값을 읽는다
 *  2. `AuthProvider` 는 문서 로드마다 `user=null` 로 시작한 뒤 세션을 읽어 `setUser` 한다
 *  3. effect dep 에 `user?.id` 가 있어 **같은 feed 에서 즉시 재실행**된다
 *  4. 두 번째 실행은 1회용 back_forward 를 다시 소비할 수 없어 `cameBack=false` → 저장값을 지우고,
 *     첫 복원 load 는 cleanup 으로 취소된다 → 12972 → 1243 / cards 31 → 12 (원 사고 재현)
 *
 * 그래서 "뒤로가기였는가 + 무엇을 복원할 것인가"를 **feed 단위로 한 번만** 확정하고 이후 재실행은
 * 그 확정본을 재사용한다. 재소비도, 삭제도 하지 않는다.
 */
export type FeedRestoreIntent = {
  /** 이 intent 가 속한 피드 키. 키가 바뀌면 새로 확정한다. */
  feedKey: string;
  /** 복원 대상. 뒤로가기가 아니었거나 저장분이 없으면 null. */
  state: FeedRestoreState | null;
};

/**
 * 복원 의사 확정(순수 — 부작용은 주입된 probe 안에만 있다).
 * 같은 feedKey 로 다시 불리면 **probe 를 호출하지 않고** 이전 확정본을 그대로 돌려준다.
 */
export function resolveFeedRestoreIntent(args: {
  prev: FeedRestoreIntent | null;
  feedKey: string;
  /** 1회용 뒤로가기 플래그 소비(부작용) — 최초 확정 때만 호출된다. */
  consumeBack: () => boolean;
  /** 저장 상태 읽기 — 최초 확정 때만 호출된다. */
  readSaved: () => FeedRestoreState | null;
}): { intent: FeedRestoreIntent; fresh: boolean } {
  const { prev, feedKey, consumeBack, readSaved } = args;
  if (prev && prev.feedKey === feedKey) return { intent: prev, fresh: false };
  const cameBack = consumeBack();
  return { intent: { feedKey, state: cameBack ? readSaved() : null }, fresh: true };
}

/**
 * pop 경로와 마운트한 피드 경로를 대조해 "이 피드로의 뒤로가기"인지 판정(순수 — 회귀에서 직접 검증).
 * 플래그는 어느 경로든 1회용이므로 불일치여도 소비해서 버린다(다음 진입에 다시 주워먹지 않게).
 */
export function matchesPoppedFeed(poppedPath: string | null, feedPath: string): boolean {
  if (poppedPath === null) return false;
  return poppedPath === feedPath;
}

/**
 * 뒤로가기(popstate)로 **이 피드로** 돌아왔는지 확정 플래그를 소비한다.
 * 클릭 시점에는 "뒤로 돌아올지" 알 수 없으므로, 실제 popstate 이벤트에서만 세워진 플래그만 신뢰한다.
 * 이렇게 해야 탭바로 피드에 새로 들어오는(push) 경우엔 복원이 발동하지 않는다.
 */
export function consumeBackNavigation(feedPath: string): boolean {
  const popped = safeGet(POP_KEY);
  if (popped !== null) {
    safeRemove(POP_KEY);
    return matchesPoppedFeed(popped, feedPath);
  }
  // SPA popstate 가 없더라도 뒤로가기일 수 있다 — 모바일 웹뷰/새로고침 경로에서는 뒤로가기가
  // **전체 문서 로드**로 처리돼 JS 컨텍스트가 초기화되고 popstate 리스너 자체가 없다(실측).
  // 이때는 Navigation Timing 의 back_forward 타입으로 판별한다.
  return consumeBackForwardLoad(feedPath);
}

/** Navigation Timing 엔트리에서 이번 **문서 로드**의 종류와 URL 경로를 뽑는다. */
export function backForwardEntryPath(): string | null {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (!nav || nav.type !== "back_forward") return null;
    return new URL(nav.name, window.location.origin).pathname;
  } catch {
    return null;
  }
}

/**
 * 전체 문서 로드 뒤로가기를 1회만 인정한다.
 * ⚠️ `performance` 의 navigation type 은 **문서 전체**의 속성이라 그 뒤 SPA 로 어디를 더 눌러도
 * 계속 back_forward 로 남는다. 그래서 (a) 문서 진입 URL 이 이 피드인지 (b) 아직 소비 안 됐는지를
 * 함께 본다. 이게 없으면 "bf 로드로 경기 화면 → push 로 피드"가 뒤로가기로 오인된다.
 */
let backForwardConsumed = false;
export function consumeBackForwardLoad(feedPath: string): boolean {
  if (backForwardConsumed) return false;
  if (backForwardEntryPath() !== feedPath) return false;
  backForwardConsumed = true;
  return true;
}

/** popstate 리스너 등록(모듈 싱글턴). SPA 수명 동안 1회만 붙는다. */
let popListenerAttached = false;
export function ensurePopStateListener(): void {
  if (popListenerAttached || typeof window === "undefined") return;
  popListenerAttached = true;
  // Next의 non-capture popstate 핸들러가 Suspense 경계를 동기 재렌더하면 피드의 초기
  // effect까지 이 이벤트 안에서 실행될 수 있다. 등록 순서에 맡기면 복원 의사가 먼저
  // 'push'로 확정돼 저장분이 지워진다. target의 capture 단계에서 먼저 표시해야
  // 라우터의 렌더/커밋 시점과 무관하게 소비자가 같은 popstate를 볼 수 있다.
  window.addEventListener("popstate", () => {
    // popstate 시점의 location 은 이미 도착지로 갱신돼 있다(실측) → 그대로 경로를 남긴다.
    safeSet(POP_KEY, window.location.pathname);
  }, { capture: true });
}
