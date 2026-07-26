/**
 * 직관 다이어리 보관(archive) — cleanup 액션 결정 순수함수 회귀 스모크 (S1).
 * 실행: npm run qa:venue-cleanup-action
 *  - resolveCleanupAction: 분류(classifyCleanupRow) → archive / delete / reprocess / quarantine_keep 매핑(스펙 §2.2 승인 계약).
 *  - 스펙 §2.2: expired_after_end(active)→archive / removed 30일 격리(null·미만→keep) / cleanup_failed→reprocess / stale_cap→keep+관제.
 *  - isCleanupActionable: cleanup 배치 조회(WHERE) 경계 = starvation 방지 반례 고정(삼순 NO-GO blocker 1).
 */
import {
  classifyCleanupRow,
  resolveCleanupAction,
  isCleanupActionable,
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
    "stale_cap → quarantine_keep (finalize 장애 = 즉시삭제 금지, 격리 + 관제)",
    resolveCleanupAction({ cls, status: "active", removedAtMs: null, nowMs: T0 + 72 * H + 1 }) === "quarantine_keep",
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
    "removed + removed_at null(레거시/검증실패) → quarantine_keep (즉시삭제 금지, migration 백필로 격리 시계 시작)",
    resolveCleanupAction({ cls, status: "removed", removedAtMs: null, nowMs: now }) === "quarantine_keep",
  );
  ok(
    "removed + removed_at NaN → quarantine_keep (fail-safe: 확정 30일 경과 없이는 삭제 금지)",
    resolveCleanupAction({ cls, status: "removed", removedAtMs: NaN, nowMs: now }) === "quarantine_keep",
  );
}

console.log("[cleanup_failed → delete 재시도 유지]");
{
  const cls = classifyCleanupRow({ status: "cleanup_failed", gameEndedAt: null, expiresAtMs: null, nowMs: T0 });
  ok("cleanup_failed 분류 = flagged", cls === "flagged");
  ok(
    "cleanup_failed → reprocess (storage 재삭제 재시도, 즉시 영구삭제 금지)",
    resolveCleanupAction({ cls, status: "cleanup_failed", removedAtMs: null, nowMs: T0 }) === "reprocess",
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

console.log("[isCleanupActionable — 조회(WHERE) 경계 = starvation 방지(삼순 NO-GO blocker 1)]");
{
  const now = T0 + 40 * DAY;
  const under30 = now - 29 * DAY; // 격리 30일 미만
  const over30 = now - 31 * DAY; // 격리 30일 경과
  // 정상 만료 archive 후보(active/pending + expires_at ≤ now)
  ok(
    "active 만료 → actionable(archive/stale_cap 후보)",
    isCleanupActionable({ status: "active", expiresAtMs: now - H, removedAtMs: null, nowMs: now }) === true,
  );
  ok(
    "pending 만료 → actionable",
    isCleanupActionable({ status: "pending", expiresAtMs: now - H, removedAtMs: null, nowMs: now }) === true,
  );
  ok(
    "active 만료 전(expires_at > now) → 조회 제외",
    isCleanupActionable({ status: "active", expiresAtMs: now + H, removedAtMs: null, nowMs: now }) === false,
  );
  // cleanup_failed → 재처리 대상(항상 조회)
  ok(
    "cleanup_failed → actionable(reprocess)",
    isCleanupActionable({ status: "cleanup_failed", expiresAtMs: null, removedAtMs: null, nowMs: now }) === true,
  );
  // removed: 30일 경과만 조회, 30일 미만·null은 no-op → SELECT 에서 제외(배치 점유 방지)
  ok(
    "removed 30일 경과 → actionable(delete)",
    isCleanupActionable({ status: "removed", expiresAtMs: null, removedAtMs: over30, nowMs: now }) === true,
  );
  ok(
    "removed 30일 미만 → 조회 제외(no-op 격리가 limit 을 점유하지 않음)",
    isCleanupActionable({ status: "removed", expiresAtMs: null, removedAtMs: under30, nowMs: now }) === false,
  );
  ok(
    "removed removed_at null → 조회 제외(격리 유지)",
    isCleanupActionable({ status: "removed", expiresAtMs: null, removedAtMs: null, nowMs: now }) === false,
  );
  ok(
    "archived → 조회 제외(보관 완료, 재-archive 금지)",
    isCleanupActionable({ status: "archived", expiresAtMs: now - H, removedAtMs: null, nowMs: now }) === false,
  );

  // 핵심 반례(삼순 probe: selected=500/actionable=0): 저-id 격리 removed 500 + 실행가능 후보 3.
  // 조회 단계(isCleanupActionable) 필터 → id 정렬 → limit 500 이므로 500건 격리가 뒤 후보를 굶지 않음.
  type Cand = { id: number; status: string; expiresAtMs: number | null; removedAtMs: number | null };
  const quarantined500: Cand[] = Array.from({ length: 500 }, (_, i) => ({
    id: i + 1, status: "removed", expiresAtMs: null, removedAtMs: under30, // 30일 미만 격리
  }));
  const actionables: Cand[] = [
    { id: 9001, status: "active", expiresAtMs: now - H, removedAtMs: null }, // archive
    { id: 9002, status: "cleanup_failed", expiresAtMs: null, removedAtMs: null }, // reprocess
    { id: 9003, status: "removed", expiresAtMs: null, removedAtMs: over30 }, // 격리 만료 delete
  ];
  const selected = [...quarantined500, ...actionables]
    .filter((r) => isCleanupActionable({ status: r.status, expiresAtMs: r.expiresAtMs, removedAtMs: r.removedAtMs, nowMs: now }))
    .sort((a, b) => a.id - b.id)
    .slice(0, 500)
    .map((r) => r.id);
  ok(
    "격리 removed 500건은 SELECT 에서 제외되고 archive/reprocess/격리만료 removed 만 선택(500건 batch starvation 제거)",
    selected.join(",") === "9001,9002,9003",
  );
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
