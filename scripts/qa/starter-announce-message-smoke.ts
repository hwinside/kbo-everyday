/**
 * 예고선발 공개 알림 — 순수 게이트/문구 회귀 (삼순 조건부 GO 계약).
 * 한쪽만 공개 미발송 · 취소 억제 · 변경(이미 발송) 재발송 없음 · 문구/날짜 포맷.
 * 실행: npm run qa:starter-announce-message
 */
import {
  bothStartersOfficial,
  shouldEmitStarterAnnounce,
  formatStarterAnnounceMessage,
  formatKstMonthDay,
} from "../../src/lib/notifications/starter-announce-message";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}`); }
}

// ── bothStartersOfficial: 양팀 확정 대기 계약 ──
ok("양팀 공식값 → true", bothStartersOfficial("김윤식", "폰세") === true);
ok("한쪽만 공개(홈만) → false(대기)", bothStartersOfficial("", "폰세") === false);
ok("한쪽만 공개(원정만) → false(대기)", bothStartersOfficial("김윤식", "") === false);
ok("양쪽 빈값 → false", bothStartersOfficial("", "") === false);
ok("공백 문자열은 빈값 취급", bothStartersOfficial("  ", "폰세") === false);

// ── shouldEmitStarterAnnounce: 실제 전이 + 1회 계약 + fail-safe ──
ok("실제 빈값→공식값 전이 → 발송", shouldEmitStarterAnnounce({ bothOfficial: true, alreadyNotified: false, sawUnannouncedBefore: true }) === true);
ok("빈값 관측 이력 없는 공식값(rollout 기공개) → baseline 미발송", shouldEmitStarterAnnounce({ bothOfficial: true, alreadyNotified: false, sawUnannouncedBefore: false }) === false);
ok("이미 발송 → 재발송 없음(재수집/선발 변경 공통)", shouldEmitStarterAnnounce({ bothOfficial: true, alreadyNotified: true, sawUnannouncedBefore: true }) === false);
ok("양팀 미확정 → 미발송", shouldEmitStarterAnnounce({ bothOfficial: false, alreadyNotified: false, sawUnannouncedBefore: true }) === false);
ok("취소 경기 → 미발송 억제", shouldEmitStarterAnnounce({ bothOfficial: true, alreadyNotified: false, sawUnannouncedBefore: true, gameCancelled: true }) === false);

// ── 날짜 포맷 ──
ok("YYYYMMDD → M월 D일", formatKstMonthDay("20260801") === "8월 1일");
ok("두 자리 일자", formatKstMonthDay("20260715") === "7월 15일");
ok("파싱 불가 → 원문 유지(방어)", formatKstMonthDay("bogus") === "bogus");

// ── 문구 ──
{
  const msg = formatStarterAnnounceMessage({
    teamId: 1, // LG (수신자 최애팀)
    awayTeamId: 1,
    homeTeamId: 9, // 한화
    awayStarterName: "김윤식",
    homeStarterName: " 폰세 ",
    gameDate: "20260731",
    gameTimeKst: "18:30",
  });
  ok("title 에 최애팀 shortName", msg.title === "LG 예고선발 공개");
  ok("body 에 날짜·시각·양팀 선발 맞대결", msg.body.includes("7월 31일 18:30") && msg.body.includes("LG(김윤식)") && msg.body.includes("(폰세)"));
  ok("선발명 trim 반영", !msg.body.includes(" 폰세 "));
}
{
  const msg = formatStarterAnnounceMessage({
    teamId: 9999, // 미상 팀 방어 폴백
    awayTeamId: 3,
    homeTeamId: 5,
    awayStarterName: "쿠에바스",
    homeStarterName: "하트",
    gameDate: "20260801",
    gameTimeKst: "17:00",
  });
  ok("미상 팀 방어 폴백", msg.title.startsWith("9999팀"));
}

console.log(`\nstarter-announce message/gate: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
