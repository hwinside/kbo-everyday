/**
 * KBO LINEUP_CK 파서 순수 회귀 (라인업 확정 트리거).
 * 실행: npm run qa:lineup-ck
 */
import { parseLineupCk } from "../../src/lib/crawler/lineup-confirmed";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}

// game-detail 응답 형태: data[0] = [{ LINEUP_CK: true/false }]
ok("LINEUP_CK true → true", parseLineupCk([[{ LINEUP_CK: true }], [], [], [], []]) === true);
ok("LINEUP_CK false → false", parseLineupCk([[{ LINEUP_CK: false }], []]) === false);
ok("빈 배열 → null", parseLineupCk([]) === null);
ok("data[0] 빈 → null", parseLineupCk([[]]) === null);
ok("LINEUP_CK 키 없음 → null", parseLineupCk([[{ FOO: 1 }]]) === null);
ok("비배열 → null", parseLineupCk(null) === null);
ok("문자열 → null", parseLineupCk("x") === null);
ok("truthy 비-boolean(1) → true", parseLineupCk([[{ LINEUP_CK: 1 }]]) === true);
ok("falsy(0) → false", parseLineupCk([[{ LINEUP_CK: 0 }]]) === false);

console.log(`\nlineup-ck 파서: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
