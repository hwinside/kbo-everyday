/**
 * AuthContext가 소유하는 **동기** 활성 사용자 신원 (PR #1297 삼순 6차 재설계).
 *
 * 왜 별도 모듈인가: React state(`setUser`)와 소비자 `useEffect`는 렌더 **후**에
 * 갱신된다. `setUser(B)` 직후 effect가 돌기 **전에** A 저장 응답이 도착하면,
 * 소비자 쪽 ref는 여전히 A라 계정 전환 오염(A 데이터가 B 화면 로컬에 commit)이
 * 재현된다(passive-effect stale 창).
 *
 * 이 모듈은 AuthContext의 auth 이벤트 콜백(onAuthStateChange/syncSession/signOut)
 * 에서 **동기적으로** 갱신된다 — auth 이벤트가 도착한 그 tick에 즉시 값이 바뀌므로,
 * 이후(별도 microtask/macrotask)에 도착하는 저장 응답의 commit 직전 조회는 항상
 * 최신 활성 사용자를 본다. 프레임워크 비의존 순수 모듈이라 tsx/node로 직접 회귀를
 * 태울 수 있다(검증 가능성 = 배치의 함수).
 *
 * 계약: 저장 요청 시작 시 활성 UID를 캡처(requestUserId) → commit 직전
 * `getActiveAuthUid()`와 대조. 불일치(계정 전환)면 성공·실패 commit 전부 skip.
 */

let activeAuthUid: string | null = null;

/** 현재 활성 사용자 UID(동기 조회). 미로그인/로그아웃이면 null. */
export function getActiveAuthUid(): string | null {
  return activeAuthUid;
}

/**
 * AuthContext 전용 — auth 이벤트(로그인·계정 전환·로그아웃)에서 동기 갱신.
 * 빈 문자열·비문자열은 null로 정규화(fail-close 대조가 항상 미일치가 되도록).
 */
export function setActiveAuthUid(uid: string | null | undefined): void {
  activeAuthUid = typeof uid === "string" && uid ? uid : null;
}
