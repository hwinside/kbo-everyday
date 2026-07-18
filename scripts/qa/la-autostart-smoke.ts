// 인앱 자동 시작 판정 스모크 (삼순 1.0.9(16) 재판정 blocker②) — npm run qa:la-autostart
import {
  parseGameIdCodes,
  pickMyTeamLiveGame,
  pickMyTeamStartableGame,
  gameStartMs,
  retriggerAllowedByPref,
  decideAndroidSuppressionStep,
  SCHEDULED_START_WINDOW_MS,
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

// ── gameStartMs (KST 고정 오프셋) ──
check("startMs: 정규 date+time → KST epoch",
  gameStartMs("20260718KTLG0", "18:30"), Date.parse("2026-07-18T18:30:00+09:00"));
check("startMs: 한 자리 시각도 파싱", gameStartMs("20260718KTLG0", "9:05"),
  Date.parse("2026-07-18T09:05:00+09:00"));
check("startMs: time 없음 → null", gameStartMs("20260718KTLG0", undefined), null);
check("startMs: gameId 날짜부 이상 → null", gameStartMs("BADID", "18:30"), null);

// ── pickMyTeamLiveGame (하위호환) ──
const liveGames = [
  { gameId: "20260718KTLG0", isLive: true },
  { gameId: "20260718OBSS0", isLive: true },
  { gameId: "20260718HHNC0", isLive: false },
];
check("pickLive: 최애팀(home) 라이브 선택", pickMyTeamLiveGame(liveGames, "LG"), liveGames[0]);
check("pickLive: 최애팀 미설정 → null", pickMyTeamLiveGame(liveGames, ""), null);

// ── pickMyTeamStartableGame (신규 — live 우선 + scheduled 30분 이내) ──
const START = Date.parse("2026-07-18T18:30:00+09:00");
const games = [
  { gameId: "20260718KTLG0", isLive: false, status: "scheduled", time: "18:30" },
  { gameId: "20260718OBSS0", isLive: true, status: "live", time: "17:00" },
];

// live 우선
check("startable: 라이브 최애팀 우선 (kind=live)",
  pickMyTeamStartableGame(games, "OB", START - 60 * 60 * 1000),
  { game: games[1], kind: "live" });

// scheduled 30분 이내
check("startable: scheduled 시작 30분 이내 → 선택 (kind=scheduled)",
  pickMyTeamStartableGame([games[0]], "LG", START - 20 * 60 * 1000),
  { game: games[0], kind: "scheduled" });
check("startable: scheduled 정확히 30분 전 경계 → 포함",
  pickMyTeamStartableGame([games[0]], "LG", START - SCHEDULED_START_WINDOW_MS),
  { game: games[0], kind: "scheduled" });
check("startable: scheduled 시작 31분 전 → 아직 제외 (윈도우 밖)",
  pickMyTeamStartableGame([games[0]], "LG", START - 31 * 60 * 1000), null);
check("startable: scheduled 시작 시각 지났지만 아직 scheduled(지연) → 포함",
  pickMyTeamStartableGame([games[0]], "LG", START + 10 * 60 * 1000),
  { game: games[0], kind: "scheduled" });

// 라이브 우선순위: 라이브+scheduled 둘 다 최애팀이면 라이브 선택
const bothMine = [
  { gameId: "20260718LGKT0", isLive: false, status: "scheduled", time: "18:30" },
  { gameId: "20260718NCLG0", isLive: true, status: "live", time: "17:00" },
];
check("startable: 라이브+scheduled 둘 다 최애팀 → 라이브 우선",
  pickMyTeamStartableGame(bothMine, "LG", START - 20 * 60 * 1000),
  { game: bothMine[1], kind: "live" });

// 게이트
check("startable: 최애팀 미설정(\"\") → null (#527 게이트)",
  pickMyTeamStartableGame(games, "", START), null);
check("startable: 최애팀 경기 없음 → null",
  pickMyTeamStartableGame(games, "LT", START), null);
check("startable: cancelled는 scheduled 아님 → 제외",
  pickMyTeamStartableGame([{ gameId: "20260718KTLG0", isLive: false, status: "cancelled", time: "18:30" }], "LG", START),
  null);
check("startable: gameId 파싱 불가 라이브 → 제외",
  pickMyTeamStartableGame([{ gameId: "SPECIAL-XX", isLive: true, status: "live", time: "18:30" }], "LG", START),
  null);
check("startable: 빈 목록 → null", pickMyTeamStartableGame([], "LG", START), null);

// 재설치 사고 재현 ①: 경기 시작 20분 전 재설치 첫 실행 → scheduled 카드 인앱 복구
check("startable: [사고 재현①] 경기 20분 전 재설치 첫 실행 → scheduled 복구",
  pickMyTeamStartableGame([games[0]], "LG", START - 20 * 60 * 1000),
  { game: games[0], kind: "scheduled" });
// 재설치 사고 재현 ②: 라이브 중(OBSS0) 재설치 → 라이브 카드 인앱 복구
check("startable: [사고 재현②] 라이브 중 재설치 → 라이브 복구",
  pickMyTeamStartableGame([games[1]], "OB", START + 30 * 60 * 1000),
  { game: games[1], kind: "live" });

// ── 수동 재노출(잠금화면 카드 다시 표시) 게이트 — PR #680 삼순 재리뷰 blocker(fail-closed) ──
check("retrigger: strict pref enabled → 진행 허용", retriggerAllowedByPref("enabled"), true);
check("retrigger: strict pref disabled → 차단", retriggerAllowedByPref("disabled"), false);
check("retrigger: [지정 회귀] prefs 조회 실패(토큰없음/non-OK/예외) → 차단(start 0회)",
  retriggerAllowedByPref("failed"), false);
check("retrigger: [지정 회귀] LiveUpdate 브릿지 조회 실패(null) → failed(start 0회)",
  decideAndroidSuppressionStep(null), "failed");
check("retrigger: 승격 opt-in → suppression 리셋 경로", 
  decideAndroidSuppressionStep({ supported: true, enabled: true }), "reset");
check("retrigger: 승격 미지원(구빌드/OS<16) → 재게시만",
  decideAndroidSuppressionStep({ supported: false, enabled: false }), "post");
check("retrigger: 지원하나 opt-out → 재게시만(억제 개념 없음)",
  decideAndroidSuppressionStep({ supported: true, enabled: false }), "post");

console.log(`\nla-autostart-smoke: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
