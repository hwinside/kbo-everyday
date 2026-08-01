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
/** popstate(뒤로가기)가 실제로 일어났음을 표시. push 네비게이션과 구별하기 위한 1회용 플래그. */
const POP_KEY = "kbo:feed-restore:popped";
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
 * 뒤로가기(popstate)로 돌아왔는지 확정 플래그를 소비한다.
 * 클릭 시점에는 "뒤로 돌아올지" 알 수 없으므로, 실제 popstate 이벤트에서만 세워진 플래그만 신뢰한다.
 * 이렇게 해야 탭바로 피드에 새로 들어오는(push) 경우엔 복원이 발동하지 않는다.
 */
export function consumeBackNavigation(): boolean {
  const popped = safeGet(POP_KEY) === "1";
  if (popped) {
    safeRemove(POP_KEY);
    return true;
  }
  // SPA popstate 가 없더라도 뒤로가기일 수 있다 — 모바일 웹뷰/새로고침 경로에서는 뒤로가기가
  // **전체 문서 로드**로 처리돼 JS 컨텍스트가 초기화되고 popstate 리스너 자체가 없다(실측).
  // 이때는 Navigation Timing 의 back_forward 타입으로 판별한다.
  return isBackForwardNavigation();
}

/** 이번 문서 로드가 뒤로/앞으로 이동으로 발생했는지(Navigation Timing). */
export function isBackForwardNavigation(): boolean {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return nav?.type === "back_forward";
  } catch {
    return false;
  }
}

/** popstate 리스너 등록(모듈 싱글턴). SPA 수명 동안 1회만 붙는다. */
let popListenerAttached = false;
export function ensurePopStateListener(): void {
  if (popListenerAttached || typeof window === "undefined") return;
  popListenerAttached = true;
  window.addEventListener("popstate", () => {
    safeSet(POP_KEY, "1");
  });
}
