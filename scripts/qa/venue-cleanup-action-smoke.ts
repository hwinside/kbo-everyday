/**
 * 직관 다이어리 보관(archive) — cleanup 액션 결정 순수함수 회귀 스모크 (S1).
 * 실행: npm run qa:venue-cleanup-action
 *  - resolveCleanupAction: 분류(classifyCleanupRow) → archive / delete / force_delete / quarantine_keep 매핑(스펙 §2.2 승인 계약).
 *  - 스펙 §2.2: expired_after_end(active)→archive / removed 30일 격리(null·미만→keep) / stale_cap→keep+관제.
 *    cleanup_failed → removed_at 있는 removed출신만 30일·TTL 후 delete·force_delete / removed_at null 출신불명은 game_ended_at 무관 격리+관제.
 *  - isCleanupActionable: cleanup 배치 조회(WHERE) 경계 = starvation 방지 반례 고정(삼순 NO-GO blocker 1: stale_cap·격리 배제).
 */
import {
  classifyCleanupRow,
  resolveCleanupAction,
  isCleanupActionable,
  VENUE_STORY_REMOVED_QUARANTINE_DAYS,
  VENUE_STORY_CLEANUP_FAILED_TTL_DAYS,
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
ok("cleanup_failed 영구실패 TTL 7일", VENUE_STORY_CLEANUP_FAILED_TTL_DAYS === 7);

console.log("[정상 만료 → 보관/삭제 분기]");
{
  // 종료 확정 + 종료+24h 경과 → expired_after_end
  const cls = classifyCleanupRow({ status: "active", gameEndedAt: endedAt, expiresAtMs: T0 + 24 * H, nowMs: T0 + 24 * H + 1 });
  ok("active 만료 분류 = expired_after_end", cls === "expired_after_end");
  ok(
    "expired_after_end + active → archive (삭제 대신 보관)",
    resolveCleanupAction({ cls, status: "active", removedAtMs: null, gameEndedAtMs: T0, cleanupFailedAtMs: null, nowMs: T0 + 24 * H + 1 }) === "archive",
  );
  ok(
    "expired_after_end + pending(미검증) → delete (누수 방지, 기존 동작)",
    resolveCleanupAction({ cls, status: "pending", removedAtMs: null, gameEndedAtMs: T0, cleanupFailedAtMs: null, nowMs: T0 + 24 * H + 1 }) === "delete",
  );
}

console.log("[만료 전 active → keep(정리 대상 아님)]");
{
  const cls = classifyCleanupRow({ status: "active", gameEndedAt: endedAt, expiresAtMs: T0 + 24 * H, nowMs: T0 + 23 * H });
  ok("만료 전 active → keep", cls === "keep");
  // keep 는 route 에서 resolveCleanupAction 호출 전 skip 되지만, 방어적으로 no-op 확인
  ok(
    "keep 을 resolve 해도 no-op(quarantine_keep)",
    resolveCleanupAction({ cls, status: "active", removedAtMs: null, gameEndedAtMs: T0, cleanupFailedAtMs: null, nowMs: T0 + 23 * H }) === "quarantine_keep",
  );
}

console.log("[stale_cap(finalize 장애) → quarantine_keep + 관제]");
{
  const cls = classifyCleanupRow({ status: "active", gameEndedAt: null, expiresAtMs: T0 + 72 * H, nowMs: T0 + 72 * H + 1 });
  ok("종료 미확정 + 안전상한 도달 → stale_cap", cls === "stale_cap");
  ok(
    "stale_cap → quarantine_keep (finalize 장애 = 즉시삭제 금지, 격리 + 관제)",
    resolveCleanupAction({ cls, status: "active", removedAtMs: null, gameEndedAtMs: null, cleanupFailedAtMs: null, nowMs: T0 + 72 * H + 1 }) === "quarantine_keep",
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
    resolveCleanupAction({ cls, status: "removed", removedAtMs: removed29, gameEndedAtMs: null, cleanupFailedAtMs: null, nowMs: now }) === "quarantine_keep",
  );
  ok(
    "removed 정확히 30일 → delete",
    resolveCleanupAction({ cls, status: "removed", removedAtMs: removed30, gameEndedAtMs: null, cleanupFailedAtMs: null, nowMs: now }) === "delete",
  );
  ok(
    "removed 31일 → delete",
    resolveCleanupAction({ cls, status: "removed", removedAtMs: removed31, gameEndedAtMs: null, cleanupFailedAtMs: null, nowMs: now }) === "delete",
  );
  ok(
    "removed + removed_at null(레거시/검증실패) → quarantine_keep (즉시삭제 금지, migration 백필로 격리 시계 시작)",
    resolveCleanupAction({ cls, status: "removed", removedAtMs: null, gameEndedAtMs: null, cleanupFailedAtMs: null, nowMs: now }) === "quarantine_keep",
  );
  ok(
    "removed + removed_at NaN → quarantine_keep (fail-safe: 확정 30일 경과 없이는 삭제 금지)",
    resolveCleanupAction({ cls, status: "removed", removedAtMs: NaN, gameEndedAtMs: null, cleanupFailedAtMs: null, nowMs: now }) === "quarantine_keep",
  );
}

console.log("[cleanup_failed → removed출신 TTL 삭제 / 출신불명 격리]");
{
  const cls = classifyCleanupRow({ status: "cleanup_failed", gameEndedAt: null, expiresAtMs: null, nowMs: T0 });
  ok("cleanup_failed 분류 = flagged", cls === "flagged");
  const now = T0 + 40 * DAY;
  const removedOver30 = now - 31 * DAY; // removed 격리 30일 경과
  const removedUnder30 = now - 29 * DAY; // removed 격리 30일 미만
  const ttl = VENUE_STORY_CLEANUP_FAILED_TTL_DAYS;
  // ── removed 출신(removed_at 존재) ──
  ok(
    "cleanup_failed + removed_at(30일 미만) → quarantine_keep (격리 유지, 오신고 복구 여지)",
    resolveCleanupAction({ cls, status: "cleanup_failed", removedAtMs: removedUnder30, gameEndedAtMs: null, cleanupFailedAtMs: now - 10 * DAY, nowMs: now }) === "quarantine_keep",
  );
  ok(
    "cleanup_failed + removed_at(30일 경과) + TTL 미경과 → delete (storage 재삭제 재시도)",
    resolveCleanupAction({ cls, status: "cleanup_failed", removedAtMs: removedOver30, gameEndedAtMs: null, cleanupFailedAtMs: now - 1 * DAY, nowMs: now }) === "delete",
  );
  ok(
    `cleanup_failed + removed_at(30일 경과) + cleanup_failed_at TTL(${ttl}일) 경과 → force_delete (무한 재시도 중단, 강제 행 삭제)`,
    resolveCleanupAction({ cls, status: "cleanup_failed", removedAtMs: removedOver30, gameEndedAtMs: null, cleanupFailedAtMs: now - ttl * DAY, nowMs: now }) === "force_delete",
  );
  ok(
    "cleanup_failed_at TTL 경계: 정확히 7일 경과 → force_delete",
    resolveCleanupAction({ cls, status: "cleanup_failed", removedAtMs: removedOver30, gameEndedAtMs: null, cleanupFailedAtMs: now - ttl * DAY, nowMs: now }) === "force_delete",
  );
  ok(
    "cleanup_failed_at TTL 경계: 7일 직전(경과 미달) → delete(재시도, 아직 강제삭제 아님)",
    resolveCleanupAction({ cls, status: "cleanup_failed", removedAtMs: removedOver30, gameEndedAtMs: null, cleanupFailedAtMs: now - ttl * DAY + 1, nowMs: now }) === "delete",
  );
  ok(
    "cleanup_failed + removed_at(30일 경과) + cleanup_failed_at null(레거시) → delete(재시도, TTL 미확정이라 강제삭제 안 함)",
    resolveCleanupAction({ cls, status: "cleanup_failed", removedAtMs: removedOver30, gameEndedAtMs: null, cleanupFailedAtMs: null, nowMs: now }) === "delete",
  );
  // ── 출신 불명(removed_at null): game_ended_at 만으로 active/pending 구분 불가 → 격리 ──
  ok(
    "cleanup_failed + removed_at null + game_ended_at 존재 → quarantine_keep (자동 archive/delete 금지)",
    resolveCleanupAction({ cls, status: "cleanup_failed", removedAtMs: null, gameEndedAtMs: T0, cleanupFailedAtMs: now - 100 * DAY, nowMs: now }) === "quarantine_keep",
  );
  ok(
    "cleanup_failed + removed_at null + game_ended_at null → quarantine_keep (출신불명 격리+관제)",
    resolveCleanupAction({ cls, status: "cleanup_failed", removedAtMs: null, gameEndedAtMs: null, cleanupFailedAtMs: now - 100 * DAY, nowMs: now }) === "quarantine_keep",
  );
}

console.log("[archived 안전장치 — cleanup 이 절대 삭제 금지]");
{
  // 방어: 어떤 분류로 들어와도 status='archived' 면 quarantine_keep(삭제 금지).
  ok(
    "archived + expired_after_end 분류여도 → quarantine_keep (다이어리 영구 보관 보호)",
    resolveCleanupAction({ cls: "expired_after_end", status: "archived", removedAtMs: null, gameEndedAtMs: T0, cleanupFailedAtMs: null, nowMs: T0 + 100 * DAY }) === "quarantine_keep",
  );
  ok(
    "archived + stale_cap 분류여도 → quarantine_keep",
    resolveCleanupAction({ cls: "stale_cap", status: "archived", removedAtMs: null, gameEndedAtMs: null, cleanupFailedAtMs: null, nowMs: T0 + 100 * DAY }) === "quarantine_keep",
  );
}

console.log("[isCleanupActionable — 조회(WHERE) 경계 = starvation 방지(삼순 NO-GO blocker 1)]");
{
  const now = T0 + 40 * DAY;
  const under30 = now - 29 * DAY; // 격리 30일 미만
  const over30 = now - 31 * DAY; // 격리 30일 경과
  // 정상 만료 archive 후보(active/pending + expires_at ≤ now + game_ended_at 확정)
  ok(
    "active 만료 + game_ended_at 확정 → actionable(archive 후보)",
    isCleanupActionable({ status: "active", expiresAtMs: now - H, gameEndedAtMs: now - 25 * H, removedAtMs: null, nowMs: now }) === true,
  );
  ok(
    "pending 만료 + game_ended_at 확정 → actionable",
    isCleanupActionable({ status: "pending", expiresAtMs: now - H, gameEndedAtMs: now - 25 * H, removedAtMs: null, nowMs: now }) === true,
  );
  // ★ blocker 1 핵심: active/pending 만료지만 game_ended_at 미확정(stale_cap) → 조회 제외(no-op batch 점유 방지)
  ok(
    "active 만료지만 game_ended_at null(stale_cap) → 조회 제외(별도 count 로만 관제)",
    isCleanupActionable({ status: "active", expiresAtMs: now - H, gameEndedAtMs: null, removedAtMs: null, nowMs: now }) === false,
  );
  ok(
    "pending 만료지만 game_ended_at null(stale_cap) → 조회 제외",
    isCleanupActionable({ status: "pending", expiresAtMs: now - H, gameEndedAtMs: null, removedAtMs: null, nowMs: now }) === false,
  );
  ok(
    "active 만료 전(expires_at > now) → 조회 제외",
    isCleanupActionable({ status: "active", expiresAtMs: now + H, gameEndedAtMs: now - 25 * H, removedAtMs: null, nowMs: now }) === false,
  );
  // cleanup_failed → removed 출신·30일 경과만 실행 배치, 출신불명/30일미만은 별도 격리+관제
  ok(
    "cleanup_failed + removed_at null(출신불명) → 조회 제외(별도 count 관제)",
    isCleanupActionable({ status: "cleanup_failed", expiresAtMs: null, gameEndedAtMs: null, removedAtMs: null, nowMs: now }) === false,
  );
  ok(
    "cleanup_failed + removed_at 30일 미만 → 조회 제외(격리 유지)",
    isCleanupActionable({ status: "cleanup_failed", expiresAtMs: null, gameEndedAtMs: null, removedAtMs: under30, nowMs: now }) === false,
  );
  ok(
    "cleanup_failed + removed_at 30일 경과 → actionable(delete/force_delete)",
    isCleanupActionable({ status: "cleanup_failed", expiresAtMs: null, gameEndedAtMs: null, removedAtMs: over30, nowMs: now }) === true,
  );
  // removed: 30일 경과만 조회, 30일 미만·null은 no-op → SELECT 에서 제외(배치 점유 방지)
  ok(
    "removed 30일 경과 → actionable(delete)",
    isCleanupActionable({ status: "removed", expiresAtMs: null, gameEndedAtMs: null, removedAtMs: over30, nowMs: now }) === true,
  );
  ok(
    "removed 30일 미만 → 조회 제외(no-op 격리가 limit 을 점유하지 않음)",
    isCleanupActionable({ status: "removed", expiresAtMs: null, gameEndedAtMs: null, removedAtMs: under30, nowMs: now }) === false,
  );
  ok(
    "removed removed_at null → 조회 제외(격리 유지)",
    isCleanupActionable({ status: "removed", expiresAtMs: null, gameEndedAtMs: null, removedAtMs: null, nowMs: now }) === false,
  );
  ok(
    "archived → 조회 제외(보관 완료, 재-archive 금지)",
    isCleanupActionable({ status: "archived", expiresAtMs: now - H, gameEndedAtMs: now - 25 * H, removedAtMs: null, nowMs: now }) === false,
  );

  // 핵심 반례: 저-id stale_cap 500 + 출신불명 cleanup_failed 500 + 격리 removed 500 + 실행가능 후보 3.
  // 조회 단계(isCleanupActionable) 필터 → id 정렬 → limit 500 이므로 1500건 no-op 이 뒤 후보를 굶지 않음.
  type Cand = { id: number; status: string; expiresAtMs: number | null; gameEndedAtMs: number | null; removedAtMs: number | null };
  const staleCap500: Cand[] = Array.from({ length: 500 }, (_, i) => ({
    id: i + 1, status: "active", expiresAtMs: now - H, gameEndedAtMs: null, removedAtMs: null, // game_ended_at null = stale_cap
  }));
  const quarantined500: Cand[] = Array.from({ length: 500 }, (_, i) => ({
    id: 500 + i + 1, status: "removed", expiresAtMs: null, gameEndedAtMs: null, removedAtMs: under30, // 30일 미만 격리
  }));
  const unknownCleanupFailed500: Cand[] = Array.from({ length: 500 }, (_, i) => ({
    id: 1000 + i + 1, status: "cleanup_failed", expiresAtMs: null, gameEndedAtMs: now - 25 * H, removedAtMs: null,
  }));
  const actionables: Cand[] = [
    { id: 9001, status: "active", expiresAtMs: now - H, gameEndedAtMs: now - 25 * H, removedAtMs: null }, // archive
    { id: 9002, status: "cleanup_failed", expiresAtMs: null, gameEndedAtMs: null, removedAtMs: over30 }, // removed 출신 delete/force_delete
    { id: 9003, status: "removed", expiresAtMs: null, gameEndedAtMs: null, removedAtMs: over30 }, // 격리 만료 delete
  ];
  const selected = [...staleCap500, ...quarantined500, ...unknownCleanupFailed500, ...actionables]
    .filter((r) => isCleanupActionable({ status: r.status, expiresAtMs: r.expiresAtMs, gameEndedAtMs: r.gameEndedAtMs, removedAtMs: r.removedAtMs, nowMs: now }))
    .sort((a, b) => a.id - b.id)
    .slice(0, 500)
    .map((r) => r.id);
  ok(
    "stale_cap 500 + 출신불명 cleanup_failed 500 + 격리 removed 500 은 제외되고 실행대상 3건만 선택",
    selected.join(",") === "9001,9002,9003",
  );
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
