// 인앱 자동 시작 판정 스모크 (삼순 1.0.9(16) 재판정 blocker②) — npm run qa:la-autostart
import {
  parseGameIdCodes,
  pickMyTeamLiveGame,
} from "../../src/lib/notifications/la-autostart-policy";

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

// ── parseGameIdCodes ──
check("parse: 정규 gameId", parseGameIdCodes("20260718KTLG0"), { away: "KT", home: "LG" });
check("parse: 형식 불일치(올스타 등) → null", parseGameIdCodes("20260711NADR0X"), null);
check("parse: 빈 문자열 → null", parseGameIdCodes(""), null);

// ── pickMyTeamLiveGame ──
const games = [
  { gameId: "20260718KTLG0", isLive: true },
  { gameId: "20260718OBSS0", isLive: true },
  { gameId: "20260718HHNC0", isLive: false }, // 예정
];

check("pick: 최애팀(home) 라이브 경기 선택", pickMyTeamLiveGame(games, "LG"), games[0]);
check("pick: 최애팀(away) 라이브 경기 선택", pickMyTeamLiveGame(games, "OB"), games[1]);
check("pick: 최애팀 경기가 예정(비라이브) → null (scheduled는 p2s 전용)",
  pickMyTeamLiveGame(games, "HH"), null);
check("pick: 최애팀 경기 없음 → null", pickMyTeamLiveGame(games, "LT"), null);
check("pick: 최애팀 미설정(\"\") → null (#527 게이트 — 비참여 유저 카드 금지)",
  pickMyTeamLiveGame(games, ""), null);
check("pick: gameId 파싱 불가 라이브 경기는 제외 (안전)",
  pickMyTeamLiveGame([{ gameId: "SPECIAL-XX", isLive: true }], "LG"), null);
check("pick: 빈 목록 → null", pickMyTeamLiveGame([], "LG"), null);

// 재설치 사고 재현(2026-07-17 하린아빠): 재설치 직후 첫 실행 — p2s claim 잔존과 무관하게
// 라이브 최애팀 경기(KTLG0)가 선택돼 인앱 start 대상이 된다.
check("pick: [사고 재현] 재설치 첫 실행 → 라이브 최애팀 경기 선택(인앱 start 대상)",
  pickMyTeamLiveGame(games, "KT"), games[0]);

console.log(`\nla-autostart-smoke: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
