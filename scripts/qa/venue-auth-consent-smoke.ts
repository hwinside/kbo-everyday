/**
 * 직관 라이브 GET bearer / consent scope 회귀 스모크 — 삼순 09:44 #3·#4 (7)(8).
 * 실행: npm run qa:venue-auth-consent
 *  (7) invalid bearer 익명 강등 금지(차단 필터 우회 차단) → 401
 *  (8) UGC 동의 key user-scoped — 계정 전환 시 타 계정 동의 상속 금지
 */
import { decideListAuth, consentStorageKey } from "../../src/lib/venue-stories/auth-consent";
import { VENUE_STORY_CONSENT_VERSION } from "../../src/lib/venue-stories/types";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

console.log("[(7) 목록 GET bearer 판정]");
ok("헤더 없음 → 익명 허용", decideListAuth(false, null).kind === "anon");
ok("invalid bearer → reject(401, 익명 강등 금지)", decideListAuth(true, null).kind === "reject");
const valid = decideListAuth(true, A);
ok("valid bearer → user + 차단필터 대상 id", valid.kind === "user" && valid.userId === A);
ok("헤더 없이 userId 만 있는 비정상 조합도 user 처리(검증 성공 우선)", decideListAuth(false, A).kind === "user");

console.log("[(8) consent key user-scoped]");
const keyA = consentStorageKey(VENUE_STORY_CONSENT_VERSION, A);
const keyB = consentStorageKey(VENUE_STORY_CONSENT_VERSION, B);
ok("user 별 key 상이(계정 전환 시 A 동의가 B 로 상속 불가)", keyA != null && keyB != null && keyA !== keyB);
ok("key 에 userId 포함", keyA?.includes(A) === true && keyB?.includes(B) === true);
ok("버전 포함(문구 개정 시 재동의)", keyA?.includes(`_v${VENUE_STORY_CONSENT_VERSION}_`) === true);
ok("userId 미상 → null(기기 공용 기억 금지)", consentStorageKey(VENUE_STORY_CONSENT_VERSION, null) === null);
ok("구 기기공용 key(venueStoryGuidelineAgreed_v1)와 불일치 — 레거시 상속 차단", keyA !== `venueStoryGuidelineAgreed_v${VENUE_STORY_CONSENT_VERSION}`);

// 계정 전환 시나리오: A 가 동의 저장 → B 세션이 같은 기기에서 열림 → B key 로는 미동의
{
  const store = new Map<string, string>();
  if (keyA) store.set(keyA, "1"); // A 동의
  const agreedForB = keyB != null && store.get(keyB) === "1";
  ok("계정 전환(B) 시 미체크 상태(=A 동의 미상속)", agreedForB === false);
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
