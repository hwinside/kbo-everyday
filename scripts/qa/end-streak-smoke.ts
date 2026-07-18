/**
 * 종료 알림 연승/연패 표기 정책 스모크 (end-streak-policy.ts).
 * 실행: npm run qa:end-streak
 * 배경: #cs 2026-07-18 "4연패인데 3연패로 발송" — 라이브 순위표 갱신 지연 off-by-one.
 */
import { decideEndStreakCount, parseSnapshotStreak } from "../../src/lib/notifications/end-streak-policy";

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

console.log(`\n${pass + fail} cases — pass ${pass}, fail ${fail}`);
if (fail > 0) process.exit(1);
