// 잠금화면 카드 마스터 게이트 fence + 구빌드 컨트롤 판정 스모크 (PR #686 삼순 재리뷰
// blocker①② 회귀 고정). 실행: npm run qa:lock-gate
//
// blocker① 재현(삼순 지정): 지연 GET + 빠른 OFF PUT — boot GET이 true를 읽음 → 사용자
// OFF(clear+PUT false) → 늦게 끝난 boot GET이 true를 다시 적용 → 카드 재게시.
// fence 계약: 캡처 시점 이후 명시 토글이 하나라도 있으면 그 load 결과는 폐기된다.

import {
  createLockCardGateFence,
  advanceLockCardGateFence,
  captureLockCardGateFence,
  shouldApplyLockCardLoad,
  decideLockCardMasterControl,
} from "../../src/lib/capacitor/lock-card-gate-fence";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    pass += 1;
    console.log(`  PASS ${name}`);
  } else {
    fail += 1;
    console.error(`  FAIL ${name}`);
  }
}

console.log("[lock-card-gate-smoke] fence — load가 명시 토글을 후승하지 않는다");
{
  // 1. 토글 없는 평시 load — 적용 허용
  const f = createLockCardGateFence();
  const gen = captureLockCardGateFence(f);
  check("plain load applies", shouldApplyLockCardLoad(f, gen) === true);
}
{
  // 2. 삼순 지정 재현: boot GET 시작(캡처) → 사용자 OFF(advance) → 늦은 GET 완료 → 폐기
  const f = createLockCardGateFence();
  const bootGen = captureLockCardGateFence(f); // boot GET 시작
  advanceLockCardGateFence(f); // 사용자 OFF (clear + PUT false)
  check("stale boot GET discarded after explicit OFF", shouldApplyLockCardLoad(f, bootGen) === false);
}
{
  // 3. 토글 이후 시작된 새 load — 최신 상태 반영 경로는 살아있어야 한다
  const f = createLockCardGateFence();
  advanceLockCardGateFence(f); // 사용자 OFF
  const gen = captureLockCardGateFence(f); // 이후 새 GET 시작
  check("fresh load after toggle applies", shouldApplyLockCardLoad(f, gen) === true);
}
{
  // 4. 병렬 load 2건(부팅 + 카드 로드) 모두 토글 이전 캡처 → 둘 다 폐기
  const f = createLockCardGateFence();
  const bootGen = captureLockCardGateFence(f);
  const cardGen = captureLockCardGateFence(f);
  advanceLockCardGateFence(f);
  check("parallel boot load discarded", shouldApplyLockCardLoad(f, bootGen) === false);
  check("parallel card load discarded", shouldApplyLockCardLoad(f, cardGen) === false);
}
{
  // 5. 연속 토글(on→off→on) 뒤 과거 load — 여전히 폐기(세대 불일치)
  const f = createLockCardGateFence();
  const gen = captureLockCardGateFence(f);
  advanceLockCardGateFence(f);
  advanceLockCardGateFence(f);
  advanceLockCardGateFence(f);
  check("load older than multiple toggles discarded", shouldApplyLockCardLoad(f, gen) === false);
}
{
  // 6. 롤백도 명시 토글(advance) — 롤백 이전 캡처 load는 폐기
  const f = createLockCardGateFence();
  advanceLockCardGateFence(f); // 사용자 OFF
  const gen = captureLockCardGateFence(f); // GET 시작
  advanceLockCardGateFence(f); // PUT 실패 롤백(ON 복원)
  check("load older than rollback discarded", shouldApplyLockCardLoad(f, gen) === false);
}

console.log("[lock-card-gate-smoke] master control — 구빌드 안드 거짓 토글 차단");
{
  // 7. iOS: W3c 서버 경로라 빌드 무관 — 항상 enabled
  check(
    "ios always enabled",
    decideLockCardMasterControl({ isAndroidNative: false, nativeGateSupported: null }) === "enabled",
  );
  // 8. 안드 + 게이트 탑재 빌드(vc14+) — enabled
  check(
    "android with native gate enabled",
    decideLockCardMasterControl({ isAndroidNative: true, nativeGateSupported: true }) === "enabled",
  );
  // 9. 안드 + 구빌드(메서드 부재) — needs-update
  check(
    "android old build needs-update",
    decideLockCardMasterControl({ isAndroidNative: true, nativeGateSupported: false }) === "needs-update",
  );
  // 10. 안드 + 프로브 미완/실패(null) — fail-closed needs-update
  check(
    "android unknown probe fail-closed",
    decideLockCardMasterControl({ isAndroidNative: true, nativeGateSupported: null }) === "needs-update",
  );
}

console.log(`\n[lock-card-gate-smoke] ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
