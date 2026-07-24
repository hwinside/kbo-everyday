// ② 구버전 업데이트 넛지 정책 (LA gap 감축 트랙, 2026-07-23).
// build15 이하 iOS 앱은 broadcast 채널 미지원(p2s 채널 내장 게이트 = os18+ && build16+)이라
// 잠금화면 카드 갱신이 앱 wake에만 의존 → gap의 구조적 원인. 라이브 경기 맥락에서
// "앱 업데이트하면 잠금화면 실시간 갱신이 안정화됩니다" 인앱 배너 1회를 띄운다.
// 순수 판정 함수 — 컴포넌트/QA 스모크가 공유한다.

/** broadcast 채널 지원 최소 앱 빌드(CFBundleVersion). p2sChannelEligible의 build 게이트와 동일 값. */
export const LA_CHANNEL_MIN_APP_BUILD = 16;

/** 세션당 1회 dismiss 저장 키(sessionStorage). */
export const LA_NUDGE_DISMISS_KEY = "la_update_nudge_dismissed";

/**
 * 넛지 노출 판정.
 * - iOS 네이티브 앱(WebView)에서만 — Android/웹은 대상 아님.
 * - appBuild가 *확인된* 구버전(<16)일 때만. null(브릿지 미보고/웹)은 구버전 확증이
 *   없으므로 노출 안 함(보수적 — 오노출이 미노출보다 나쁨).
 * - 라이브 경기 맥락에서만, 세션당 1회(dismiss 후 재노출 없음).
 */
export function shouldShowLaUpdateNudge(i: {
  platform: string | null;
  appBuild: number | null;
  isLive: boolean;
  dismissed: boolean;
}): boolean {
  if (!i.isLive || i.dismissed) return false;
  if (i.platform !== "ios") return false;
  return i.appBuild !== null && i.appBuild < LA_CHANNEL_MIN_APP_BUILD;
}
