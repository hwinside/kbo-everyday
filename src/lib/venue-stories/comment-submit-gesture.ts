/**
 * 직관 스토리 댓글 전송 제스처 상태기계 + 재진입 가드 (삼순 #948 4차 NO-GO 반영).
 *
 * 배경: 안드에서 전송 버튼 onClick 은 탭 순간 입력창 blur→키보드 내려감→시트 재계산으로
 * 버튼이 손가락 밑에서 이동해 click 이 씨힌다(전송 눌러도 토스트·저장 없음, 하린아빠 7/29 리포트).
 *
 * 해법: pointerdown 에서 preventDefault(입력창 포커스 유지→키보드/시트 불변)만 하고, 제출 확정은
 * "이 버튼 위에서 끝난 primary pointerup"(+데스크톱 click 폴백)에서만 한다.
 *
 * 삼순 blocker 1: pointerdown 즉시 제출은 pointercancel(스크롤 제스처)·drag-out 도 전송하므로 금지.
 * ⚠️ 터치는 implicit pointer capture 라 drag-out 해도 pointerup 이 원래 버튼에서 발생 →
 *    릴리즈 좌표가 버튼 밖이면 drag-out 으로 보고 제출하지 않는다(bounds 체크).
 */

export interface PressState {
  pressActive: boolean;
  /** pointerdown 좌표(있으면 stationary-tap 판정에 사용). 없으면 bounds 판정만. */
  originX?: number;
  originY?: number;
}

/**
 * 제자리 탭 허용 반경(px). iOS 이모지 키보드가 뜨/닫히면 pointerdown~pointerup 사이 시각
 * 뷰포트가 흔들려 버튼 getBoundingClientRect() 가 이동한다 → 손가락은 가만히 있었는데
 * "버튼 밖 릴리즈(drag-out)"로 오판돼 제출이 통째로 씨힜다(하린아빠 7/31 iOS 이모지 리포트).
 * 손가락 이동량 자체가 이 반경 이내면 레이아웃이 어떻게 흔들렸든 진짜 탭으로 본다.
 */
export const COMMENT_SUBMIT_TAP_SLOP_PX = 12;

export interface PointerUpLike {
  isPrimary?: boolean;
  button?: number;
  clientX?: number;
  clientY?: number;
  bounds?: { left: number; top: number; right: number; bottom: number } | null;
}

export function createPressState(): PressState {
  return { pressActive: false };
}

/** pointerdown: press 시작 + 시작 좌표 기록(제출은 pointerup/click). 호출부가 preventDefault 로 포커스 유지. */
export function markPressStart(
  state: PressState,
  origin: { clientX?: number; clientY?: number } = {},
): void {
  state.pressActive = true;
  state.originX = typeof origin.clientX === "number" ? origin.clientX : undefined;
  state.originY = typeof origin.clientY === "number" ? origin.clientY : undefined;
}

/** pointercancel/leave: 스크롤·드래그로 제스처 취소 → 제출 안 함. */
export function cancelPress(state: PressState): void {
  state.pressActive = false;
  state.originX = undefined;
  state.originY = undefined;
}

/**
 * pointerup: 이 버튼 위에서 끝난 primary(주 버튼) 탭만 제출 승인.
 * - press 이미 해제됨(pointercancel/중복 up) → false
 * - 비-primary 포인터 / 보조 버튼(button>0) → false
 * - 손가락이 거의 안 움직인 제자리 탭(≤ SLOP) → true (레이아웃 shift 로 bounds 가 밀려도 제출)
 * - 그 외 릴리즈 좌표가 버튼 bounds 밖(touch implicit-capture drag-out) → false
 * 어느 경우든 press 는 소비(해제)한다.
 */
export function shouldSubmitOnPointerUp(state: PressState, e: PointerUpLike = {}): boolean {
  if (!state.pressActive) return false;
  state.pressActive = false;
  const originX = state.originX;
  const originY = state.originY;
  state.originX = undefined;
  state.originY = undefined;
  if (e.isPrimary === false) return false;
  if (typeof e.button === "number" && e.button > 0) return false;
  if (
    typeof originX === "number" &&
    typeof originY === "number" &&
    typeof e.clientX === "number" &&
    typeof e.clientY === "number" &&
    Math.hypot(e.clientX - originX, e.clientY - originY) <= COMMENT_SUBMIT_TAP_SLOP_PX
  ) {
    return true; // 제자리 탭: bounds 가 키보드/시트 재계산으로 밀렸어도 진짜 탭
  }
  if (
    e.bounds &&
    typeof e.clientX === "number" &&
    typeof e.clientY === "number" &&
    (e.clientX < e.bounds.left ||
      e.clientX > e.bounds.right ||
      e.clientY < e.bounds.top ||
      e.clientY > e.bounds.bottom)
  ) {
    return false; // drag-out: 버튼 밖에서 릴리즈
  }
  return true;
}

/**
 * 전송 재진입/중복 가드. 동기 lock(ref.current) 로, pointerup 제출 뒤 따라오는 trailing click 이
 * 같은 탭에서 두 번째 POST 하지 않게 막는다(commentBusy 는 setState 라 같은 탭 내 stale).
 * story·내용 유무·busy·lock 을 모두 확인.
 */
export function canBeginCommentSubmit(opts: {
  hasStory: boolean;
  hasContent: boolean;
  busy: boolean;
  locked: boolean;
}): boolean {
  return opts.hasStory && opts.hasContent && !opts.busy && !opts.locked;
}
