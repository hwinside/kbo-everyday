/**
 * 직관 다이어리 보관(archive) — cleanup 액션 결정 순수함수 회귀 스모크 (S1).
 * 실행: npm run qa:venue-cleanup-action
 *  - resolveCleanupAction: 분류(classifyCleanupRow) → archive / delete / quarantine_keep 매핑.
 *  - 스펙 §2: expired_after_end(active)→archive / removed 30일 격리 / stale_cap·cleanup_failed 삭제 유지.
 */
import {
  classifyCleanupRow,
  resolveCleanupAction,
  VENUE_STORY_REMOVED_QUARANTINE_DAYS,
} from "../../src/lib/venue-stories/expiry-policy";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

const H = 3600_000;
const DAY = 24 * H;
const T0 = Date.parse("2026-07-20T09:30:00Z");
const endedAt = new Date(T0).toISOString();

console.log("[상수 회귀]");
ok("removed 격리 30일", VENUE_STORY_REMOVED_QUARANTINE_DAYS === 30);

console.log("[정상 만료 → 보관/삭제 분기]");
{
  // 종료 확정 + 종료+24h 경과 → expired_after_end
  const cls = classifyCleanupRow({ status: "active", gameEndedAt: endedAt, expiresAtMs: T0 + 24 * H, nowMs: T0 + 24 * H + 1 });
  ok("active 만료 분류 = expired_after_end", cls === "expired_after_end");
  ok(
    "expired_after_end + active → archive (삭제 대신 보관)",
    resolveCleanupAction({ cls, status: "active", removedAtMs: null, nowMs: T0 + 24 * H + 1 }) === "archive",
  );
  ok(
    "expired_after_end + pending(미검증) → delete (누수 방지, 기존 동작)",
    resolveCleanupAction({ cls, status: "pending", removedAtMs: null, nowMs: T0 + 24 * H + 1 }) === "delete",
  );
}

console.log("[만료 전 active → keep(정리 대상 아님)]");
{
  const cls = classifyCleanupRow({ status: "active", gameEndedAt: endedAt, expiresAtMs: T0 + 24 * H, nowMs: T0 + 23 * H });
  ok("만료 전 active → keep", cls === "keep");
  // keep 는 route 에서 resolveCleanupAction 호출 전 skip 되지만, 방어적으로 no-op 확인
  ok(
    "keep 을 resolve 해도 no-op(quarantine_keep)",
    resolveCleanupAction({ cls, status: "active", removedAtMs: null, nowMs: T0 + 23 * H }) === "quarantine_keep",
  );
}

console.log("[stale_cap(finalize 장애) → delete 유지 + 관제]");
{
  const cls = classifyCleanupRow({ status: "active", gameEndedAt: null, expiresAtMs: T0 + 72 * H, nowMs: T0 + 72 * H + 1 });
  ok("종료 미확정 + 안전상한 도달 → stale_cap", cls === "stale_cap");
  ok(
    "stale_cap → delete (기존 누수 방지 삭제 동작 유지)",
    resolveCleanupAction({ cls, status: "active", removedAtMs: null, nowMs: T0 + 72 * H + 1 }) === "delete",
  );
}

console.log("[removed 30일 격리 경계]");
{
  const now = T0 + 40 * DAY; // 판정 시각
  const removed29 = now - 29 * DAY;
  const removed30 = now - 30 * DAY;
  const removed31 = now - 31 * DAY;
  const cls = classifyCleanupRow({ status: "removed", gameEndedAt: null, expiresAtMs: null, nowMs: now });
  ok("removed 분류 = flagged", cls === "flagged");
  ok(
    "removed 29일 → quarantine_keep (미노출 격리, 오신고 복구 여지)",
    resolveCleanupAction({ cls, status: "removed", removedAtMs: removed29, nowMs: now }) === "quarantine_keep",
  );
  ok(
    "removed 정확히 30일 → delete",
    resolveCleanupAction({ cls, status: "removed", removedAtMs: removed30, nowMs: now }) === "delete",
  );
  ok(
    "removed 31일 → delete",
    resolveCleanupAction({ cls, status: "removed", removedAtMs: removed31, nowMs: now }) === "delete",
  );
  ok(
    "removed + removed_at null(레거시/검증실패) → delete (기존 즉시 정리 유지)",
    resolveCleanupAction({ cls, status: "removed", removedAtMs: null, nowMs: now }) === "delete",
  );
  ok(
    "removed + removed_at NaN → delete (fail-safe: 격리 미상은 즉시 정리)",
    resolveCleanupAction({ cls, status: "removed", removedAtMs: NaN, nowMs: now }) === "delete",
  );
}

console.log("[cleanup_failed → delete 재시도 유지]");
{
  const cls = classifyCleanupRow({ status: "cleanup_failed", gameEndedAt: null, expiresAtMs: null, nowMs: T0 });
  ok("cleanup_failed 분류 = flagged", cls === "flagged");
  ok(
    "cleanup_failed → delete (storage 삭제 재시도, 기존 동작)",
    resolveCleanupAction({ cls, status: "cleanup_failed", removedAtMs: null, nowMs: T0 }) === "delete",
  );
}

console.log("[archived 안전장치 — cleanup 이 절대 삭제 금지]");
{
  // 방어: 어떤 분류로 들어와도 status='archived' 면 quarantine_keep(삭제 금지).
  ok(
    "archived + expired_after_end 분류여도 → quarantine_keep (다이어리 영구 보관 보호)",
    resolveCleanupAction({ cls: "expired_after_end", status: "archived", removedAtMs: null, nowMs: T0 + 100 * DAY }) === "quarantine_keep",
  );
  ok(
    "archived + stale_cap 분류여도 → quarantine_keep",
    resolveCleanupAction({ cls: "stale_cap", status: "archived", removedAtMs: null, nowMs: T0 + 100 * DAY }) === "quarantine_keep",
  );
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
