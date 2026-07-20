/**
 * 스모크: 관리자 화이트리스트 게이트(isAdminEmail) — 조회수 관리자 전용 노출의 핵심 판정.
 * 실행: npm run qa:admin-view
 */
import { isAdminEmail, ADMIN_EMAILS } from "../../src/lib/admin/admin-users";

let pass = 0;
let fail = 0;
function check(label: string, got: boolean, want: boolean) {
  if (got === want) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${label}: got ${got}, want ${want}`);
  }
}

// 화이트리스트 계정 = 관리자
check("harinclaw admin", isAdminEmail("harinclaw@gmail.com"), true);
check("yoonyeonryul admin", isAdminEmail("yoonyeonryul@gmail.com"), true);
// 대소문자/공백 무시
check("uppercase admin", isAdminEmail("Harinclaw@Gmail.com"), true);
check("whitespace admin", isAdminEmail("  yoonyeonryul@gmail.com  "), true);
// 비관리자
check("random user", isAdminEmail("someone@gmail.com"), false);
check("empty", isAdminEmail(""), false);
check("null", isAdminEmail(null), false);
check("undefined", isAdminEmail(undefined), false);
// 부분/유사 매칭 오탐 방지
check("prefix spoof", isAdminEmail("harinclaw@gmail.com.evil.com"), false);
check("substring spoof", isAdminEmail("xharinclaw@gmail.com"), false);
// 화이트리스트는 소문자 정규형으로 저장돼 있어야 함(비교 안정성)
check("list is lowercase", ADMIN_EMAILS.every((e) => e === e.toLowerCase()), true);

console.log(`admin-view-smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
