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
export const STORY_PILL_BOTTOM_OFFSET = 20; // 댓글 pill 하단
export const STORY_PILL_HEIGHT = 48; // pill 높이(Tailwind h-12)
export const STORY_PILL_SIDE_INSET = 12; // pill 좌/우 여백(left-3/right-3)
export const STORY_CAPTION_BOTTOM_OFFSET = 84; // 캡션 하단(pill 위)

export type StoryTapZone = "prev" | "next" | "pill" | "none";

/** safe-area 포함 bottom calc 문자열 — 컴포넌트가 이 상수로 CSS 를 만들게 해 분류기와 값이 어긋나지 않게. */
export function safeBottomCalc(offsetPx: number): string {
  return `calc(var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + ${offsetPx}px)`;
}

/**
 * 뷰포트 좌표(px)를 탭 존으로 분류.
 * - pill: 하단 pill 사각형([H-(safe+68), H-(safe+20)] 세로, [inset, W-inset] 가로) → 댓글 모달 오픈
 * - prev/next: pill 위 넘기기 존(y ≤ H-(safe+76)), 좌 1/3 = prev / 우 2/3 = next
 * - none: pill 상단과 넘기기 존 사이 갭(넘김·모달 어느 것도 아님)
 */
export function classifyStoryTap(input: {
  viewportWidth: number;
  viewportHeight: number;
  safeBottom: number;
  x: number;
  y: number;
}): StoryTapZone {
  const { viewportWidth: w, viewportHeight: h, safeBottom, x, y } = input;
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
  if (y >= 0 && y <= navBottom) {
    return x < w / 3 ? "prev" : "next";
  }
  return "none";
}
