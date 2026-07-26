/**
 * 직관 라이브 만료 계약 회귀 스모크 — 삼순 09:44 #2·#4 (4).
 * 실행: npm run qa:venue-expiry
 *  - final idempotency(CAS 가드)·KBO fault(스킵)·늦은 종료(스케줄 커버리지)·terminal 전 cleanup 금지
 *  - 만료 = 경기 종료+24h. 시작+72h 는 별도 안전상한(장애 정책·관제, 정상 만료 아님).
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  isTerminalGameStatus,
  finalizedExpiryIso,
  safetyCapExpiryIso,
  classifyCleanupRow,
  isCleanupActionable,
  VENUE_STORY_REMOVED_QUARANTINE_DAYS,
} from "../../src/lib/venue-stories/expiry-policy";
import {
  VENUE_STORY_EXPIRY_HOURS_AFTER_END,
  VENUE_STORY_SAFETY_CAP_HOURS_AFTER_START,
} from "../../src/lib/venue-stories/types";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

const H = 3600_000;
const T0 = Date.parse("2026-07-20T09:30:00Z");

console.log("[terminal 판정 — finalize 는 final/cancelled 에서만 확정]");
ok("final → terminal", isTerminalGameStatus("final") === true);
ok("cancelled → terminal", isTerminalGameStatus("cancelled") === true);
ok("live → 미확정(만료 확정 금지)", isTerminalGameStatus("live") === false);
ok("ready → 미확정", isTerminalGameStatus("ready") === false);
ok("KBO fault(undefined status) → 미확정(다음 실행 재시도)", isTerminalGameStatus(undefined) === false);

console.log("[만료 산식 — 종료+24h / 시작+72h 분리]");
ok(`finalize 확정 만료 = 감지+${VENUE_STORY_EXPIRY_HOURS_AFTER_END}h`, Date.parse(finalizedExpiryIso(T0)) === T0 + 24 * H);
ok(`업로드 시 안전상한 = 시작+${VENUE_STORY_SAFETY_CAP_HOURS_AFTER_START}h (30h 조기삭제 계약 위반 제거)`, Date.parse(safetyCapExpiryIso(T0)) === T0 + 72 * H);
ok("상수 회귀: 안전상한 72h", VENUE_STORY_SAFETY_CAP_HOURS_AFTER_START === 72);

console.log("[finalize idempotency — CAS(game_ended_at IS NULL) 계약]");
// 첫 확정: ended null → 확정. 재실행: ended 존재 → route 의 .is("game_ended_at", null) 가드로 no-op.
// 순수 레벨에선 '이미 확정된 행'의 재분류가 만료를 밀지 않음을 확인.
{
  const endedAt = new Date(T0).toISOString();
  const confirmedExpiry = T0 + 24 * H;
  const later = T0 + 5 * H; // finalize 가 5시간 뒤 재실행돼도
  const cls = classifyCleanupRow({ status: "active", gameEndedAt: endedAt, expiresAtMs: confirmedExpiry, nowMs: later });
  ok("확정된 만료는 재실행에도 유지(keep, 종료+24h 전 삭제 금지)", cls === "keep");
}

console.log("[cleanup — terminal 전 expiry 삭제 금지]");
ok(
  "종료 미확정 + 상한 미도달 → keep",
  classifyCleanupRow({ status: "active", gameEndedAt: null, expiresAtMs: T0 + 72 * H, nowMs: T0 + 30 * H }) === "keep",
);
ok(
  "종료 미확정 + 30h 경과(구 계약 삭제 시점) → keep (조기삭제 금지 회귀)",
  classifyCleanupRow({ status: "active", gameEndedAt: null, expiresAtMs: T0 + 72 * H, nowMs: T0 + 31 * H }) === "keep",
);
ok(
  "종료 미확정 + 안전상한(72h) 도달 → stale_cap(장애 격리 + 관제)",
  classifyCleanupRow({ status: "active", gameEndedAt: null, expiresAtMs: T0 + 72 * H, nowMs: T0 + 72 * H + 1 }) === "stale_cap",
);
ok(
  "종료 확정 + 종료+24h 전 → keep",
  classifyCleanupRow({ status: "active", gameEndedAt: new Date(T0).toISOString(), expiresAtMs: T0 + 24 * H, nowMs: T0 + 23 * H }) === "keep",
);
ok(
  "종료 확정 + 종료+24h 경과 → expired_after_end(정상 만료)",
  classifyCleanupRow({ status: "active", gameEndedAt: new Date(T0).toISOString(), expiresAtMs: T0 + 24 * H, nowMs: T0 + 24 * H + 1 }) === "expired_after_end",
);
{
  // S1(#869 재작업): 만료 scan 은 조회(WHERE) 단계에서 "이번 실행에 실제 처리 가능한 행"만 뽑는다(isCleanupActionable):
  //   active/pending 만료 + game_ended_at 확정 ⊕ cleanup_failed/removed(removed_at ≤ now-30d).
  //   archived / 30일미만·null removed·cleanup_failed / stale_cap(game_ended_at null) 는 제외. id 오름차순→500 제한.
  const nowIso = new Date(T0).toISOString();
  const quarantineCutoffIso = new Date(T0 - VENUE_STORY_REMOVED_QUARANTINE_DAYS * 24 * H).toISOString();
  const route = readFileSync(
    resolve(__dirname, "../../src/app/api/cron/venue-stories-cleanup/route.ts"),
    "utf-8",
  );
  const filterAt = route.indexOf(
    "`and(status.in.(active,pending),expires_at.lte.${nowIso},game_ended_at.not.is.null),and(status.eq.cleanup_failed,removed_at.lte.${quarantineCutoffIso}),and(status.eq.removed,removed_at.lte.${quarantineCutoffIso})`",
  );
  const orderAt = route.indexOf('.order("id", { ascending: true })', filterAt);
  const limitAt = route.indexOf(".limit(500)", orderAt);
  ok(
    "route는 실행가능 행(active/pending 정상만료 + removed출신 cleanup_failed@≥30d + removed@≥30d)만 필터→id 정렬→500 제한",
    filterAt >= 0 && orderAt > filterAt && limitAt > orderAt,
  );
  // stale_cap 관제는 배치와 분리된 별도 count(head:true)로 유지됨을 확인(삼순 blocker 1).
  const staleCapCountAt = route.indexOf('.is("game_ended_at", null)');
  const staleCapHeadAt = route.indexOf('count: "exact", head: true');
  ok(
    "stale_cap 관제 = 별도 bounded count(head:true, game_ended_at IS NULL) 유지(삭제/전이 없이 5xx 신호만)",
    staleCapHeadAt >= 0 && staleCapCountAt >= 0,
  );
  const unknownCleanupFailedAt = route.indexOf('.eq("status", "cleanup_failed")');
  const unknownRemovedAt = route.indexOf('.is("removed_at", null)', unknownCleanupFailedAt);
  ok(
    "출신불명 cleanup_failed 관제 = 별도 bounded count(head:true, removed_at IS NULL) 유지",
    unknownCleanupFailedAt >= 0 && unknownRemovedAt > unknownCleanupFailedAt,
  );
  void nowIso;
  void quarantineCutoffIso;
  // 반례 고정: 저-id stale_cap 500 ⊕ 출신불명 cleanup_failed 500 ⊕ 격리 removed 500 ⊕ archived 500 ⊕ 실행가능 3건.
  // isCleanupActionable 필터 → 2000 no-op 은 제외되고 뒤 실행대상 3건만 선택된다.
  const under30 = T0 - 29 * 24 * H; // 격리 30일 미만
  const over30 = T0 - 31 * 24 * H; // 격리 30일 경과
  type Cand = { id: number; status: string; expiresAtMs: number | null; gameEndedAtMs: number | null; removedAtMs: number | null };
  const staleCap500: Cand[] = Array.from({ length: 500 }, (_, i) => ({
    id: i + 1, status: "active", expiresAtMs: T0 - 1, gameEndedAtMs: null, removedAtMs: null, // game_ended_at null = stale_cap
  }));
  const quarantined500: Cand[] = Array.from({ length: 500 }, (_, i) => ({
    id: 500 + i + 1, status: "removed", expiresAtMs: null, gameEndedAtMs: null, removedAtMs: under30,
  }));
  const archived500: Cand[] = Array.from({ length: 500 }, (_, i) => ({
    id: 2000 + i, status: "archived", expiresAtMs: T0 - 1, gameEndedAtMs: T0 - 25 * H, removedAtMs: null,
  }));
  const unknownCleanupFailed500: Cand[] = Array.from({ length: 500 }, (_, i) => ({
    id: 3000 + i, status: "cleanup_failed", expiresAtMs: null, gameEndedAtMs: T0 - 25 * H, removedAtMs: null,
  }));
  const scanTargets: Cand[] = [
    { id: 9001, status: "active", expiresAtMs: T0 - 1, gameEndedAtMs: T0 - 25 * H, removedAtMs: null }, // → archive
    { id: 9002, status: "cleanup_failed", expiresAtMs: null, gameEndedAtMs: null, removedAtMs: over30 }, // → removed 출신 삭제
    { id: 9003, status: "removed", expiresAtMs: null, gameEndedAtMs: null, removedAtMs: over30 }, // → 격리 만료 delete
  ];
  const selected = [...staleCap500, ...quarantined500, ...archived500, ...unknownCleanupFailed500, ...scanTargets]
    .filter((row) => isCleanupActionable({ status: row.status, expiresAtMs: row.expiresAtMs, gameEndedAtMs: row.gameEndedAtMs, removedAtMs: row.removedAtMs, nowMs: T0 }))
    .sort((a, b) => a.id - b.id)
    .slice(0, 500)
    .map((row) => row.id);
  ok(
    "stale_cap/출신불명 cleanup_failed/격리 removed/archived 각 500건 제외 후 실행대상 3건만 선택",
    selected.join(",") === "9001,9002,9003",
  );
}
ok(
  "pending 도 terminal 전 expiry 삭제 금지",
  classifyCleanupRow({ status: "pending", gameEndedAt: null, expiresAtMs: T0 + 72 * H, nowMs: T0 + 10 * H }) === "keep",
);
ok(
  "removed 는 만료 무관 즉시 정리 대상",
  classifyCleanupRow({ status: "removed", gameEndedAt: null, expiresAtMs: T0 + 72 * H, nowMs: T0 }) === "flagged",
);
ok(
  "cleanup_failed → flagged(후속 출신 판정 대상)",
  classifyCleanupRow({ status: "cleanup_failed", gameEndedAt: null, expiresAtMs: null, nowMs: T0 }) === "flagged",
);
ok(
  "expires 미상(null) → keep(fail-safe, 오삭제 금지)",
  classifyCleanupRow({ status: "active", gameEndedAt: null, expiresAtMs: null, nowMs: T0 }) === "keep",
);
ok(
  "expires NaN → keep(fail-safe)",
  classifyCleanupRow({ status: "active", gameEndedAt: null, expiresAtMs: NaN, nowMs: T0 }) === "keep",
);

console.log("[늦은 종료 커버리지 — finalize cron 스케줄]");
{
  const vercel = JSON.parse(readFileSync(resolve(__dirname, "../../vercel.json"), "utf-8")) as {
    crons: { path: string; schedule: string }[];
  };
  const finalize = vercel.crons.find((c) => c.path === "/api/cron/venue-stories-finalize");
  ok("finalize cron 등록", !!finalize);
  const m = /^\*\/10 (\d+)-(\d+) \* \* \*$/.exec(finalize?.schedule ?? "");
  const fromH = m ? parseInt(m[1], 10) : -1;
  const toH = m ? parseInt(m[2], 10) : -1;
  // KST 00:50 종료 = UTC 15:50 → hour 15 / KST 03:30 종료 = UTC 18:30 → hour 18 까지 커버
  ok("UTC 15시(KST 자정 직후 종료) 커버", fromH <= 15 && toH >= 15);
  ok("UTC 18시(KST 03시대 늦은 종료) 커버 — 구 5-15 갭 해소", fromH <= 16 && toH >= 18);
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
