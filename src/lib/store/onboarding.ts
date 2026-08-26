/**
 * 온보딩 상태 관리 + guest_id
 *
 * 상태:
 * - not_started: 팀 미선택
 * - team_selected: 팀 선택 완료, 선수 미선택
 * - completed: 온보딩 완료 (팀 + 선수)
 * - skipped: 팀 선택 후 선수 스킵
 */

const GUEST_ID_KEY = "kbo-guest-id";
const ONBOARDING_KEY = "kbo-onboarding-status";

export type OnboardingStatus = "not_started" | "team_selected" | "completed" | "skipped";

export function getGuestId(): string {
  if (typeof window === "undefined") return "";
  let id = localStorage.getItem(GUEST_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(GUEST_ID_KEY, id);
  }
  return id;
}

export function getOnboardingStatus(): OnboardingStatus {
  if (typeof window === "undefined") return "not_started";
  return (localStorage.getItem(ONBOARDING_KEY) as OnboardingStatus) || "not_started";
}

export function setOnboardingStatus(status: OnboardingStatus): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(ONBOARDING_KEY, status);
}

/** 온보딩 상태 제거 (계정 전환·로그아웃 시 공식 clear). guest_id는 유지. */
export function clearOnboardingStatus(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ONBOARDING_KEY);
}

export function isOnboardingDone(): boolean {
  const status = getOnboardingStatus();
  return status === "completed" || status === "skipped";
}

export function needsPlayerSetup(): boolean {
  return getOnboardingStatus() === "skipped";
}
