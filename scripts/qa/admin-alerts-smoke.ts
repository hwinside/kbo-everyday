/**
 * admin-alerts 전이 판정 스모크 (2026-07-18).
 * - decideAdminAlerts: "상태 전이 시에만 알림" 계약
 * - decideAlertPersistence: 전달 실패 시 claim revert(다음 틱 재시도) 계약
 * - CAS 동시 실행 시뮬레이션: 같은 전이를 두 실행이 동시 claim해도 승자 1명만 발송
 *
 * 실행: npm run qa:admin-alerts
 */
import {
  decideAdminAlerts,
  decideAlertPersistence,
  type AdminAlertDecision,
  type JobLevelSnapshot,
} from "../../src/lib/admin/job-health";
import { normalizeMessageId } from "../../src/lib/admin/dm-notify";

let pass = 0;
let fail = 0;

function snap(jobName: string, level: JobLevelSnapshot["level"], reason = "r"): JobLevelSnapshot {
  return { jobName, label: jobName, level, reason };
}

function check(
  name: string,
  prev: Record<string, string>,
  current: JobLevelSnapshot[],
  expected: Array<{ jobName: string; kind: "problem" | "recovered" }>,
) {
  const out = decideAdminAlerts(new Map(Object.entries(prev)), current);
  const got = out.map((a) => `${a.jobName}:${a.kind}`).sort().join(",");
  const want = expected.map((a) => `${a.jobName}:${a.kind}`).sort().join(",");
  if (got === want) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} — expected [${want}] got [${got}]`);
  }
}

console.log("admin-alerts transition smoke");

// 신규 problem 진입 → 알림
check("healthy→error = problem 알림", { a: "healthy" }, [snap("a", "error")], [{ jobName: "a", kind: "problem" }]);
check("healthy→stale = problem 알림", { a: "healthy" }, [snap("a", "stale")], [{ jobName: "a", kind: "problem" }]);
check("직전 상태 없음→error = problem 알림", {}, [snap("a", "error")], [{ jobName: "a", kind: "problem" }]);

// 동일 problem 유지 → 반복 알림 없음
check("error→error = 무알림", { a: "error" }, [snap("a", "error")], []);
check("stale→stale = 무알림", { a: "stale" }, [snap("a", "stale")], []);

// problem 레벨 간 전이 → 재알림 (상황이 바뀐 것)
check("error→stale = problem 재알림", { a: "error" }, [snap("a", "stale")], [{ jobName: "a", kind: "problem" }]);
check("stale→error = problem 재알림", { a: "stale" }, [snap("a", "error")], [{ jobName: "a", kind: "problem" }]);

// 복구 전이 → recovered 1회
check("error→healthy = recovered", { a: "error" }, [snap("a", "healthy")], [{ jobName: "a", kind: "recovered" }]);
check("stale→partial = recovered (partial은 problem 아님)", { a: "stale" }, [snap("a", "partial")], [{ jobName: "a", kind: "recovered" }]);

// 정상 유지/정상 간 전이 → 무알림
check("직전 상태 없음→healthy = 무알림", {}, [snap("a", "healthy")], []);
check("healthy→partial = 무알림", { a: "healthy" }, [snap("a", "partial")], []);
check("partial→healthy = 무알림", { a: "partial" }, [snap("a", "healthy")], []);

// unknown은 경고도 복구도 만들지 않음 (판정 불가 회색)
check("error→unknown = 무알림", { a: "error" }, [snap("a", "unknown")], []);
check("unknown→healthy = 무알림", { a: "unknown" }, [snap("a", "healthy")], []);
check("unknown→error = problem 알림", { a: "unknown" }, [snap("a", "error")], [{ jobName: "a", kind: "problem" }]);

// 다중 job 독립 판정
check(
  "다중 job — 각각 독립 전이",
  { a: "healthy", b: "error", c: "stale" },
  [snap("a", "error"), snap("b", "error"), snap("c", "healthy")],
  [
    { jobName: "a", kind: "problem" },
    { jobName: "c", kind: "recovered" },
  ],
);

// ---- decideAlertPersistence: 전달 결과 → persist/revert ----
function checkPersist(name: string, outcome: { sent: number; failed: number }, want: "persist" | "revert") {
  const got = decideAlertPersistence(outcome);
  if (got === want) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} — expected ${want} got ${got}`);
  }
}

console.log("\nalert persistence (전달 실패/구독조회 오류 = revert → 다음 틱 재시도)");
checkPersist("전달 성공(sent 1) = persist", { sent: 1, failed: 0 }, "persist");
checkPersist("부분 성공(sent 1, failed 1) = persist", { sent: 1, failed: 1 }, "persist");
checkPersist("실제 구독 0개(sent 0, failed 0) = persist (vacuous)", { sent: 0, failed: 0 }, "persist");
checkPersist("전송 전패(sent 0, failed 2) = revert", { sent: 0, failed: 2 }, "revert");
// 2차 P1: 구독 조회 DB 오류를 "구독 0개"와 구분 — queryError면 revert
checkPersist("구독조회 DB오류(queryError, 0/0) = revert", { sent: 0, failed: 0, queryError: true }, "revert");

// ---- normalizeMessageId: BIGSERIAL(number) 정합 (2차 P0) ----
function checkMsgId(name: string, input: unknown, want: number | null) {
  const got = normalizeMessageId(input);
  if (got === want) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} — expected ${want} got ${got}`);
  }
}

console.log("\nnormalizeMessageId (dm_messages.id = BIGSERIAL number 정합)");
checkMsgId("양의 정수 number", 12345, 12345);
checkMsgId("insert 반환 정수 문자열도 허용", "12345", 12345);
checkMsgId("거대 정수 문자열(15자리)", "999999999999999", 999999999999999);
checkMsgId("0 = 거부", 0, null);
checkMsgId("음수 = 거부", -5, null);
checkMsgId("소수 = 거부", 12.5, null);
checkMsgId("UUID 문자열 = 거부 (구 contract 회귀 방지)", "a1b2c3d4-0000-0000-0000-000000000000", null);
checkMsgId("빈 문자열 = 거부", "", null);
checkMsgId("null = 거부", null, null);
checkMsgId("undefined = 거부", undefined, null);
checkMsgId("비정규 문자열(앞 0) = 거부", "012", null);

// ---- CAS 동시 실행 시뮬레이션 ----
// cron 라우트의 claim SQL 의미론과 동일한 in-memory CAS:
// - prevLevel null → insert-if-absent (이미 있으면 패배)
// - prevLevel 있음 → 현재 저장 레벨이 prevLevel일 때만 전진 (아니면 패배)
// 두 실행이 같은 prev 스냅샷을 읽고 같은 전이를 claim해도 승자는 정확히 1명.
class InMemoryAlertState {
  private levels = new Map<string, string>();
  claim(alert: AdminAlertDecision): boolean {
    const stored = this.levels.get(alert.jobName) ?? null;
    if (alert.prevLevel === null) {
      if (stored !== null) return false;
      this.levels.set(alert.jobName, alert.newLevel);
      return true;
    }
    if (stored !== alert.prevLevel) return false;
    this.levels.set(alert.jobName, alert.newLevel);
    return true;
  }
  revert(alert: AdminAlertDecision) {
    const stored = this.levels.get(alert.jobName) ?? null;
    if (stored !== alert.newLevel) return;
    if (alert.prevLevel === null) this.levels.delete(alert.jobName);
    else this.levels.set(alert.jobName, alert.prevLevel);
  }
  get(jobName: string): string | null {
    return this.levels.get(jobName) ?? null;
  }
}

function checkConcurrent(
  name: string,
  seed: Record<string, string>,
  current: JobLevelSnapshot[],
  expectWinners: number,
) {
  const store = new InMemoryAlertState();
  const seedMap = new Map(Object.entries(seed));
  for (const [k, v] of seedMap) store.claim({ jobName: k, label: k, reason: "r", kind: "problem", prevLevel: null, newLevel: v as JobLevelSnapshot["level"] });
  // 두 실행이 같은 prev 스냅샷을 읽음 (겹침 재현)
  const alertsA = decideAdminAlerts(seedMap, current);
  const alertsB = decideAdminAlerts(seedMap, current);
  let winners = 0;
  for (const a of [...alertsA, ...alertsB]) if (store.claim(a)) winners++;
  if (winners === expectWinners) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} — expected winners=${expectWinners} got ${winners}`);
  }
}

console.log("\nCAS 동시 실행 idempotency (승자 1회만 발송)");
checkConcurrent("신규 problem 진입 × 동시 2실행 = 승자 1", {}, [snap("a", "error")], 1);
checkConcurrent("기존 행 전이 × 동시 2실행 = 승자 1", { a: "healthy" }, [snap("a", "error")], 1);
checkConcurrent("2잡 동시 전이 × 2실행 = 잡당 승자 1 (총 2)", { a: "healthy", b: "error" }, [snap("a", "stale"), snap("b", "healthy")], 2);

// revert 후 재시도 가능 검증: 전달 실패 → revert → 다음 틱 같은 전이 재-claim 성공
{
  const store = new InMemoryAlertState();
  const prev = new Map<string, string>();
  const [alert] = decideAdminAlerts(prev, [snap("a", "error")]);
  const won = store.claim(alert);
  store.revert(alert); // 전송 전패 가정
  const retry = store.claim(alert); // 다음 틱 동일 전이
  if (won && retry && store.get("a") === "error") {
    pass++;
    console.log("  ✅ revert 후 다음 틱 재-claim 성공 (영구 누락 없음)");
  } else {
    fail++;
    console.log(`  ❌ revert 후 재-claim 실패 won=${won} retry=${retry} level=${store.get("a")}`);
  }
}

console.log(`\n${pass}/${pass + fail} PASS`);
if (fail > 0) process.exit(1);
