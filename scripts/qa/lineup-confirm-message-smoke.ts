/**
 * 라인업 확정 알림 문구/전이 판정 순수 회귀 (하린아빠 스펙, gate ①④).
 * 실행: npm run qa:lineup-confirm-message
 */
import {
  toKstHhmm,
  teamShortName,
  formatLineupConfirmMessage,
  shouldEmitLineupConfirm,
} from "../../src/lib/notifications/lineup-confirm-message";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}

console.log("[KST HH:MM 포맷 — 서버 TZ 무관]");
// 2026-07-29T09:05:00Z = 18:05 KST
ok("09:05Z → 18:05 KST", toKstHhmm(new Date("2026-07-29T09:05:00Z")) === "18:05");
// 자정 경계: 2026-07-29T15:00:00Z = 다음날 00:00 KST
ok("15:00Z → 00:00 KST(자정 경계)", toKstHhmm(new Date("2026-07-29T15:00:00Z")) === "00:00");
// 한 자리 시/분 zero-pad
ok("00:30Z → 09:30 KST zero-pad 없음 확인", toKstHhmm(new Date("2026-07-29T00:30:00Z")) === "09:30");
ok("22:07Z → 07:07 KST(익일 이월+zero-pad)", toKstHhmm(new Date("2026-07-28T22:07:00Z")) === "07:07");

console.log("[팀 shortName]");
ok("id 1 → LG", teamShortName(1) === "LG");
ok("id 3 → KT", teamShortName(3) === "KT");
ok("id 6 → KIA", teamShortName(6) === "KIA");
ok("미상 id → 폴백", teamShortName(999) === "999팀");

console.log("[확정 문구 exact — gate ④]");
{
  const m = formatLineupConfirmMessage({
    teamId: 1,
    confirmedAt: new Date("2026-07-29T09:05:00Z"), // 18:05 KST
    gameTimeKst: "18:30",
  });
  ok(
    "body 정확",
    m.body === "금일 18:05 시 18:30전의 LG 라인업이 확정되었습니다. 자세한 라인업을 확인해보세요.",
  );
  ok("title = '{팀} 라인업 확정'", m.title === "LG 라인업 확정");
}
{
  const m = formatLineupConfirmMessage({
    teamId: 9,
    confirmedAt: new Date("2026-07-29T04:03:00Z"), // 13:03 KST
    gameTimeKst: "14:00",
  });
  ok(
    "다른 팀/시각 body 정확",
    m.body === `금일 13:03 시 14:00전의 ${teamShortName(9)} 라인업이 확정되었습니다. 자세한 라인업을 확인해보세요.`,
  );
}

console.log("[전이 판정 — gate ①② 앞단]");
ok("확정+미발송+정상 → 발송", shouldEmitLineupConfirm({ lineupConfirmed: true, alreadyNotified: false }) === true);
ok("미확정 → 미발송", shouldEmitLineupConfirm({ lineupConfirmed: false, alreadyNotified: false }) === false);
ok("이미 발송(중복) → 미발송", shouldEmitLineupConfirm({ lineupConfirmed: true, alreadyNotified: true }) === false);
ok("취소/연기 fail-safe → 미발송", shouldEmitLineupConfirm({ lineupConfirmed: true, alreadyNotified: false, gameCancelled: true }) === false);

console.log(`\n라인업 확정 문구/전이: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
