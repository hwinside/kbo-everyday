/**
 * 종료 알림 연승/연패 표기 정책 스모크 (end-streak-policy.ts).
 * 실행: npm run qa:end-streak
 * 배경: #cs 2026-07-18 "4연패인데 3연패로 발송" — 라이브 순위표 갱신 지연 off-by-one.
 */
import { decideEndStreakCount, parseSnapshotStreak } from "../../src/lib/notifications/end-streak-policy";
import { computeStreak } from "../../src/lib/analysis/daily-delta";
import type { KboGame } from "../../src/lib/crawler/kbo-api";

let pass = 0;
let fail = 0;
function eq<T>(name: string, actual: T, expected: T) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

console.log("[parseSnapshotStreak]");
eq("'3연패' 파싱", parseSnapshotStreak("3연패"), { n: 3, dir: "패" });
eq("'10연승' 파싱", parseSnapshotStreak("10연승"), { n: 10, dir: "승" });
eq("'1무' → null", parseSnapshotStreak("1무"), null);
eq("라이브 포맷 '3패' → null (스냅샷 포맷 아님)", parseSnapshotStreak("3패"), null);
eq("null → null", parseSnapshotStreak(null), null);
eq("'0연패' → null", parseSnapshotStreak("0연패"), null);

console.log("[스냅샷 경로 — 어제까지 + 오늘 결과 직접 계산]");
eq("🔴 재현: 어제 3연패 + 오늘 패 → 4연패 (사고 케이스)", decideEndStreakCount({
  snapshotStreak: "3연패", hasSnapshot: true, result: "패", finalsToday: 1, liveStreak: { n: 3, dir: "패" },
}), 4);
eq("어제 3연패 + 오늘 승 → 1연승 = 미표시", decideEndStreakCount({
  snapshotStreak: "3연패", hasSnapshot: true, result: "승", finalsToday: 1, liveStreak: { n: 3, dir: "패" },
}), null);
eq("어제 2연승 + 오늘 승 → 3연승", decideEndStreakCount({
  snapshotStreak: "2연승", hasSnapshot: true, result: "승", finalsToday: 1, liveStreak: undefined,
}), 3);
eq("어제 1연승 + 오늘 승 → 2연승 (표시 시작점)", decideEndStreakCount({
  snapshotStreak: "1연승", hasSnapshot: true, result: "승", finalsToday: 1, liveStreak: undefined,
}), 2);
eq("어제 1연패 + 오늘 승 → 1연승 = 미표시", decideEndStreakCount({
  snapshotStreak: "1연패", hasSnapshot: true, result: "승", finalsToday: 1, liveStreak: undefined,
}), null);
eq("어제 1무 + 오늘 패 → 1연패 = 미표시", decideEndStreakCount({
  snapshotStreak: "1무", hasSnapshot: true, result: "패", finalsToday: 1, liveStreak: undefined,
}), null);
eq("스냅샷 streak null(파싱불가) + 오늘 패 → 미표시 (라이브로 새지 않음)", decideEndStreakCount({
  snapshotStreak: null, hasSnapshot: true, result: "패", finalsToday: 1, liveStreak: { n: 5, dir: "패" },
}), null);
eq("스냅샷 경로에선 라이브 값 무시 (라이브가 이미 갱신됐어도 이중가산 없음)", decideEndStreakCount({
  snapshotStreak: "3연패", hasSnapshot: true, result: "패", finalsToday: 1, liveStreak: { n: 4, dir: "패" },
}), 4);

console.log("[폴백 경로 — 스냅샷 부재/더블헤더: 기존 방향일치 동작 유지]");
eq("스냅샷 부재 + 라이브 3패·오늘 패 → 3 (기존 동작)", decideEndStreakCount({
  snapshotStreak: undefined, hasSnapshot: false, result: "패", finalsToday: 1, liveStreak: { n: 3, dir: "패" },
}), 3);
eq("스냅샷 부재 + 라이브 3패·오늘 승 → 방향 모순 fail-closed", decideEndStreakCount({
  snapshotStreak: undefined, hasSnapshot: false, result: "승", finalsToday: 1, liveStreak: { n: 3, dir: "패" },
}), null);
eq("스냅샷 부재 + 라이브 미상 → 미표시", decideEndStreakCount({
  snapshotStreak: undefined, hasSnapshot: false, result: "패", finalsToday: 1, liveStreak: undefined,
}), null);
eq("더블헤더(finalsToday=2): 스냅샷 있어도 라이브 폴백", decideEndStreakCount({
  snapshotStreak: "3연패", hasSnapshot: true, result: "패", finalsToday: 2, liveStreak: { n: 4, dir: "패" },
}), 4);
eq("더블헤더 + 라이브 방향 불일치 → 미표시", decideEndStreakCount({
  snapshotStreak: "3연패", hasSnapshot: true, result: "승", finalsToday: 2, liveStreak: { n: 3, dir: "패" },
}), null);

// ===== computeStreak (스냅샷 생성부) — 혼합 더블헤더 순차 계산 회귀 (삼순 #687 NO-GO) =====

/** 최소 필드 경기 fixture — teamId 1 기준 결과로 점수 구성 */
function G(gameId: string, result: "승" | "패" | "무", status: KboGame["status"] = "final"): KboGame {
  const my = result === "승" ? 5 : result === "패" ? 2 : 3;
  const op = result === "승" ? 2 : result === "패" ? 5 : 3;
  return {
    gameId, date: "20260717", time: "18:30", stadium: "", awayTeamId: 1, homeTeamId: 3,
    awayName: "LG", homeName: "KT", awayScore: my, homeScore: op, inning: 9, isTop: false,
    status, awayStarterName: "", homeStarterName: "",
  } as unknown as KboGame;
}

console.log("[computeStreak — 더블헤더 순차 replay]");
eq("🔴 삼순 재현: 직전 2연패 + DH[승,패] → 1연패 (종전 3연패 오산)",
  computeStreak(1, [G("20260717LGKT1", "승"), G("20260717LGKT2", "패")], "2연패"), "1연패");
eq("직전 2연패 + DH[패,승] → 1연승",
  computeStreak(1, [G("20260717LGKT1", "패"), G("20260717LGKT2", "승")], "2연패"), "1연승");
eq("직전 2연패 + DH[패,패] → 4연패",
  computeStreak(1, [G("20260717LGKT1", "패"), G("20260717LGKT2", "패")], "2연패"), "4연패");
eq("직전 2연승 + DH[승,승] → 4연승",
  computeStreak(1, [G("20260717LGKT1", "승"), G("20260717LGKT2", "승")], "2연승"), "4연승");
eq("단일경기 기존 동작 유지: 3연패 + [패] → 4연패",
  computeStreak(1, [G("20260717LGKT0", "패")], "3연패"), "4연패");
eq("단일경기: 3연패 + [승] → 1연승",
  computeStreak(1, [G("20260717LGKT0", "승")], "3연패"), "1연승");
eq("무승부 종결: 2연패 + [무] → 무",
  computeStreak(1, [G("20260717LGKT0", "무")], "2연패"), "무");
eq("무 다음 경기: 무 + [패] → 1연패",
  computeStreak(1, [G("20260717LGKT0", "패")], "무"), "1연패");
eq("DH[무,패]: 무가 연패 리셋 → 1연패 (종전 3연패 오산)",
  computeStreak(1, [G("20260717LGKT1", "무"), G("20260717LGKT2", "패")], "2연패"), "1연패");
eq("경기 없음 → 이전 streak 유지",
  computeStreak(1, [], "2연패"), "2연패");
eq("입력 순서 무관 — gameId 정렬로 1차전 먼저: [2차전승, 1차전패] → 1연승",
  computeStreak(1, [G("20260717LGKT2", "승"), G("20260717LGKT1", "패")], "2연패"), "1연승");
eq("prev null + [패] → 1연패",
  computeStreak(1, [G("20260717LGKT0", "패")], null), "1연패");
eq("final 아닌 경기 무시: live 경기만 있으면 prev 유지",
  computeStreak(1, [G("20260717LGKT0", "패", "live")], "2연패"), "2연패");

console.log(`\n${pass + fail} cases — pass ${pass}, fail ${fail}`);
if (fail > 0) process.exit(1);
