/**
 * admin-alerts 전이 판정 스모크 (2026-07-18).
 * decideAdminAlerts 순수 함수 — "상태 전이 시에만 알림" 계약을 고정한다.
 *
 * 실행: npm run qa:admin-alerts
 */
import { decideAdminAlerts, type JobLevelSnapshot } from "../../src/lib/admin/job-health";

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

console.log(`\n${pass}/${pass + fail} PASS`);
if (fail > 0) process.exit(1);
