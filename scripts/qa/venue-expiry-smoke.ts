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
  "종료 미확정 + 안전상한(72h) 도달 → stale_cap(장애 정책 삭제 + 관제)",
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
ok(
  "pending 도 terminal 전 expiry 삭제 금지",
  classifyCleanupRow({ status: "pending", gameEndedAt: null, expiresAtMs: T0 + 72 * H, nowMs: T0 + 10 * H }) === "keep",
);
ok(
  "removed 는 만료 무관 즉시 정리 대상",
  classifyCleanupRow({ status: "removed", gameEndedAt: null, expiresAtMs: T0 + 72 * H, nowMs: T0 }) === "flagged",
);
ok(
  "cleanup_failed 재시도 대상",
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
