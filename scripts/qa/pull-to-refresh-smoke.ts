/**
 * PullToRefresh arm 게이트 회귀 (삼순 #731 NO-GO: 중첩 input/modal/scroller 제스처 무시).
 * 실행: npx tsx scripts/qa/pull-to-refresh-smoke.ts
 */
import { nodeBlocksPull } from "../../src/components/PullToRefresh";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

// (1) 입력 요소에서 시작 → arm 안 함
ok("INPUT 시작 → 차단", nodeBlocksPull({ tag: "INPUT" }) === true);
ok("TEXTAREA 시작 → 차단", nodeBlocksPull({ tag: "TEXTAREA" }) === true);
ok("SELECT 시작 → 차단", nodeBlocksPull({ tag: "SELECT" }) === true);
ok("contentEditable 시작 → 차단", nodeBlocksPull({ tag: "DIV", contentEditable: true }) === true);

// (2) 모달/중첩 스크롤러에서 시작 → arm 안 함
ok("role=dialog(모달) 시작 → 차단", nodeBlocksPull({ tag: "DIV", role: "dialog" }) === true);
ok("중첩 overflow-y 스크롤러 시작 → 차단", nodeBlocksPull({ tag: "DIV", scrollableY: true }) === true);

// (3) 일반 page-level 콘텐츠에서 시작 → arm(차단 안 함)
ok("일반 DIV 콘텐츠 → 통과(arm)", nodeBlocksPull({ tag: "DIV" }) === false);
ok("일반 P/버튼 등 → 통과(arm)", nodeBlocksPull({ tag: "P", role: null, scrollableY: false }) === false);
ok("overflow 있으나 스크롤 불가(내용 짧음) → 통과", nodeBlocksPull({ tag: "DIV", scrollableY: false }) === false);

console.log(`\npull-to-refresh smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
