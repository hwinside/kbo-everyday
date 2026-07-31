/**
 * 직관 스토리 뷰어 하단 레이아웃 오프셋 + 탭 존 분류 (삼순 #948 반영).
 *
 * 좌/우 넘기기(prev/next) 탭 존이 하단 '댓글 달기' pill 을 덮으면, pill 주변 탭이 스토리 넘김으로
 * 먹혀 댓글 모달이 잘 안 열린다(하린아빠 7/29 안드 — pill 8px 위만 눌러도 넘김 발동). 넘기기 존을
 * pill 위에서 끊어(bottom offset) pill·캡션 영역을 넘김에서 제외한다.
 *
 * 아래 상수를 컴포넌트 style 과 이 분류기가 공유한다(값 drift 방지). NAV(76) > PILL_TOP(20+48=68)
 * 이라 pill 상단 위 8px 갭이 남아 pill 경계 탭이 넘김으로 새지 않는다.
 */

export const STORY_NAV_BOTTOM_OFFSET = 76; // 좌/우 넘기기 존 하단 컷(safe-area 위)
/**
 * 좌/우 넘기기 존 상단 컷(safe-area-inset-top 아래). 헤더(음소거/더보기/닫기 X)는
 * top = safeTop+28 에서 시작해 44px 터치타깃을 차지한다(= safeTop+72 까지). 예전엔 넘기기 존이
 * top-0 라 헤더 오른쪽 아래에 깔려 X 근처 빗맞은 탭이 "다음 스토리"로 새어나갔다(하린아빠 7/31 iOS
 * "X 잘 안 눌림"). 하단 pill 컷과 대칭으로 헤더 아래 8px 갭을 두고 잘라낸다.
 */
export const STORY_NAV_TOP_OFFSET = 80; // 28(헤더 top) + 44(터치타깃) + 8(갭)
export const STORY_PILL_BOTTOM_OFFSET = 20; // 댓글 pill 하단
export const STORY_PILL_HEIGHT = 48; // pill 높이(Tailwind h-12)
export const STORY_PILL_SIDE_INSET = 12; // pill 좌/우 여백(left-3/right-3)
export const STORY_CAPTION_BOTTOM_OFFSET = 84; // 캡션 하단(pill 위)

export type StoryTapZone = "prev" | "next" | "pill" | "none";

/** 짧은 탭(즉시 이동) ↔ 길게 누르기(일시정지) 경계(ms). 인스타그램처럼 1탭 = 1이동. */
export const STORY_NAV_TAP_MAX_MS = 200;
/** 탭으로 인정하는 최대 이동거리(px) — 이상은 스와이프/스크롤로 보고 이동하지 않는다. */
export const STORY_NAV_TAP_SLOP_PX = 10;

/**
 * 넘기기 존 pointerup 이 "즉시 이동하는 짧은 탭"인지 순수 판정.
 * 기존엔 pointerdown 에서 바로 setPaused(true), pointerup 에서 setPaused(false) 하고 이동은 click 에만
 * 걸려 있어, 첫 탭이 일시정지/재생 토글에 먹혀 오른쪽을 두 번 눌러야 다음 영상으로 넘어갔다
 * (하린아빠 7/31 iOS). 짧은 탭은 pointerup 에서 즉시 이동, 길게 누르기만 일시정지로 분리한다.
 */
export function isStoryNavTap(input: {
  elapsedMs: number;
  deltaX: number;
  deltaY: number;
}): boolean {
  if (input.elapsedMs >= STORY_NAV_TAP_MAX_MS) return false;
  return Math.hypot(input.deltaX, input.deltaY) <= STORY_NAV_TAP_SLOP_PX;
}

/** safe-area 포함 bottom calc 문자열 — 컴포넌트가 이 상수로 CSS 를 만들게 해 분류기와 값이 어긋나지 않게. */
export function safeBottomCalc(offsetPx: number): string {
  return `calc(env(safe-area-inset-bottom, 0px) + ${offsetPx}px)`;
}

/**
 * 뷰포트 좌표(px)를 탭 존으로 분류.
 * - pill: 하단 pill 사각형([H-(safe+68), H-(safe+20)] 세로, [inset, W-inset] 가로) → 댓글 모달 오픈
 * - prev/next: 헤더 아래~pill 위 넘기기 존(safeTop+80 ≤ y ≤ H-(safe+76)), 좌 1/3 = prev / 우 2/3 = next
 * - none: 헤더 영역(닫기 X 등)과 pill 상단~넘기기 존 사이 갭(넘김·모달 어느 것도 아님)
 */
export function classifyStoryTap(input: {
  viewportWidth: number;
  viewportHeight: number;
  safeBottom: number;
  /** safe-area-inset-top(px). 생략 시 0 — 헤더 아래 컷은 여전히 STORY_NAV_TOP_OFFSET 만큼 적용. */
  safeTop?: number;
  x: number;
  y: number;
}): StoryTapZone {
  const { viewportWidth: w, viewportHeight: h, safeBottom, x, y } = input;
  const safeTop = input.safeTop ?? 0;
  const pillTop = h - (safeBottom + STORY_PILL_BOTTOM_OFFSET + STORY_PILL_HEIGHT);
  const pillBottom = h - (safeBottom + STORY_PILL_BOTTOM_OFFSET);
  if (
    y >= pillTop &&
    y <= pillBottom &&
    x >= STORY_PILL_SIDE_INSET &&
    x <= w - STORY_PILL_SIDE_INSET
  ) {
    return "pill";
  }
  const navBottom = h - (safeBottom + STORY_NAV_BOTTOM_OFFSET);
  const navTop = safeTop + STORY_NAV_TOP_OFFSET;
  if (y >= navTop && y <= navBottom) {
    return x < w / 3 ? "prev" : "next";
  }
  return "none";
}
