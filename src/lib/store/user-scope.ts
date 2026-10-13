import { clearFavoritePlayers } from "./favorites";
import { clearMyTeamId } from "./myteam";
import { clearOnboardingStatus } from "./onboarding";

/**
 * 계정 전환·로그아웃 시 이전 계정의 로컬 스코프 데이터 일괄 정리 (공식 helper,
 * PR #1297 삼순 6차 재설계).
 *
 * 각 store의 **공식 clear**를 호출해 키의 SSOT를 store에 둔다 — AuthContext가
 * 하드코딩 키 배열(`['kbo-my-team','kbo-onboarding-status','favorite_players']`)로
 * 지우던 결함을 제거한다. 그 배열은 ①실제 최애 키가 `kbo-favorite-players`인데
 * `favorite_players`라 오타로 못 지웠고 ②팀은 localStorage만 지워 cookie의 이전
 * 계정 값이 남았다.
 *
 * 정리 대상:
 * - 최애선수: `kbo-favorite-players` (localStorage) — clearFavoritePlayers
 * - 마이팀: `kbo-my-team` (localStorage + cookie 둘 다) — clearMyTeamId
 * - 온보딩 상태: `kbo-onboarding-status` (localStorage) — clearOnboardingStatus
 */
export function clearUserScopedStores(): void {
  clearFavoritePlayers();
  clearMyTeamId();
  clearOnboardingStatus();
}
