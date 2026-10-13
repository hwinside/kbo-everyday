/**
 * AuthContext가 소유하는 **동기** 활성 사용자 신원 (PR #1297 삼순 7차 재설계).
 *
 * 왜 별도 모듈인가: React state(`setUser`)와 소비자 `useEffect`는 렌더 **후**에
 * 갱신된다. `setUser(B)` 직후 effect가 돌기 **전에** A 저장 응답이 도착하면,
 * 소비자 쪽 ref는 여전히 A라 계정 전환 오염(A 데이터가 B 화면 로컬에 commit)이
 * 재현된다(passive-effect stale 창).
 *
 * 왜 UID가 아니라 `{uid, epoch}`인가 (삼순 7차): UID 단독 비교는
 * `A→B→A`·동일 UID 로그아웃→재로그인을 구분하지 못한다 — 옛 A 요청의 늦은 응답이나
 * 계정별 saver의 옛 `lastSaved`가 UID 비교를 **다시 통과**해 새 세션 로컬을 덮는다.
 * epoch은 uid가 실제로 바뀔 때마다(로그아웃 null 경유 포함) 단조 증가하므로,
 * 요청 시작 시 캡처한 `{uid, epoch}`와 commit 직전 값이 **epoch까지 일치**할 때만
 * commit을 허용하면 이 두 경계가 닫힌다.
 *
 * 왜 revision fence인가 (삼순 7차): async `syncSession()` 완료가 최신
 * `onAuthStateChange` **뒤에** 도착하면 옛 UID를 재게시할 수 있다. 모든 게시에
 * 단조 `revision`을 부여하고, async 조회는 시작 시 티켓을 받아 게시 직전 더 최신
 * 게시가 있었으면 **폐기**한다.
 *
 * 프레임워크 비의존 순수 모듈 — tsx/node로 직접 회귀를 태운다(검증 가능성 = 배치).
 */

export interface AuthIdentity {
  uid: string | null;
  epoch: number;
}

let uid: string | null = null;
let epoch = 0; // uid 전환마다 +1 (A→B→A·동일 UID 재인증 구분)
let revision = 0; // 모든 auth 게시마다 +1 (늦은 syncSession fence)

function normalize(u: string | null | undefined): string | null {
  return typeof u === "string" && u ? u : null;
}

/** 현재 활성 신원 스냅샷(동기). */
export function getAuthIdentity(): AuthIdentity {
  return { uid, epoch };
}

/** 현재 활성 사용자 UID(동기). 호환용 — commit 관문은 isSameAuthIdentity를 쓴다. */
export function getActiveAuthUid(): string | null {
  return uid;
}

/**
 * 권위 게시 — onAuthStateChange·signOut 등 auth 이벤트에서 동기 호출.
 * 항상 revision을 올리고, uid가 실제로 바뀐 경우에만 epoch을 올린다(토큰 갱신 등
 * 동일 uid 반복 게시는 epoch 유지 → 진행 중 저장을 불필요하게 무효화하지 않음).
 */
export function commitAuthIdentity(nextUid: string | null | undefined): AuthIdentity {
  revision += 1;
  const norm = normalize(nextUid);
  if (norm !== uid) {
    uid = norm;
    epoch += 1;
  }
  return { uid, epoch };
}

/** async 조회(syncSession) 시작 시 티켓 발급 — 현재 revision 스냅샷. */
export function beginAuthDispatch(): number {
  return revision;
}

/**
 * async 조회 결과 게시 — 시작 티켓 이후 더 최신 게시(revision 증가)가 있었으면
 * **폐기**(fence)한다. 적용했으면 true. 늦은 syncSession이 최신 onAuthStateChange를
 * 되돌리는 것을 원천 차단.
 */
export function commitAuthIdentityIfCurrent(
  nextUid: string | null | undefined,
  ticket: number
): boolean {
  if (ticket < revision) return false; // 늦음 — 최신 이벤트가 이미 게시됨
  commitAuthIdentity(nextUid);
  return true;
}

/**
 * commit 관문 — 요청 시작 스냅샷이 **현재 신원과 uid+epoch 모두 일치**할 때만 true.
 * uid만 같고 epoch이 다르면(A→B→A·동일 UID 재인증) false → 옛 응답/옛 lastSaved commit 차단.
 * 미로그인(uid null)·결손 스냅샷은 fail-close(false).
 */
export function isSameAuthIdentity(snapshot: AuthIdentity | null | undefined): boolean {
  if (!snapshot || typeof snapshot.uid !== "string" || !snapshot.uid) return false;
  return snapshot.uid === uid && snapshot.epoch === epoch;
}

/**
 * PUT 전 fail-close (삼순 8차): 요청 시작 스냅샷이 현재 신원이고(uid+epoch 일치)
 * **React 측 user.id와도 uid가 일치**할 때만 true. auth 모듈은 B로 바뀌었는데
 * React closure가 아직 A인 창에서 A 화면 선택값을 B 토큰으로 B DB에 저장하는
 * 것을 저장(PUT) 전에 차단한다.
 */
export function isAuthIdentityForUser(
  snapshot: AuthIdentity | null | undefined,
  reactUserId: string | null | undefined
): boolean {
  if (typeof reactUserId !== "string" || !reactUserId) return false;
  if (!isSameAuthIdentity(snapshot)) return false;
  return snapshot!.uid === reactUserId;
}

/** 테스트 전용 — 모듈 상태 초기화(블록 간 상태 누수 방지). */
export function __resetAuthIdentityForTest(): void {
  uid = null;
  epoch = 0;
  revision = 0;
}
