/**
 * Smoke/regression — 공유 YouTube quota 원장 순수 로직.
 *
 * 검증(src/lib/video/youtube-quota.ts):
 *  · getQuotaDate — Pacific(LA) 날짜 경계 (KST 16:00 리셋과 일치)
 *  · quotaJobStatus — quota degrade는 warning(성공 오표기 교정), hardError는 error
 *  · reserveQuota — RPC 응답 매핑 + RPC 실패 시 백스톱(allowed=true+ledgerError)
 *
 * 실행: npx tsx scripts/qa/youtube-quota-smoke.ts  (npm run qa:youtube-quota)
 */
import "./_smoke-env";
import {
  getQuotaDate,
  quotaJobStatus,
  reserveQuota,
  recordQuota,
  resolveQuotaCap,
  YT_QUOTA_DAILY_DEFAULT,
} from "@/lib/video/youtube-quota";

let fail = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) fail++;
}

// ── resolveQuotaCap: 비정상 env fail-closed(삼순 3번) ─────────────
ok("cap: 정상값 '8000' → 8000", resolveQuotaCap("8000") === 8000);
ok("cap: 미설정 → 기본", resolveQuotaCap(undefined) === YT_QUOTA_DAILY_DEFAULT);
ok("cap: 'abc' → 기본(fail-closed)", resolveQuotaCap("abc") === YT_QUOTA_DAILY_DEFAULT);
ok("cap: '0' → 기본", resolveQuotaCap("0") === YT_QUOTA_DAILY_DEFAULT);
ok("cap: '-500' → 기본", resolveQuotaCap("-500") === YT_QUOTA_DAILY_DEFAULT);
ok("cap: 과대 '99999999' → 기본", resolveQuotaCap("99999999") === YT_QUOTA_DAILY_DEFAULT);
ok("cap: 소수 '8000.7' → floor 8000", resolveQuotaCap("8000.7") === 8000);

// ── getQuotaDate: Pacific 경계 ──────────────────────────────────────
// 2026-07-19 15:00 KST = 2026-07-18 23:00 PDT → Pacific 날짜 07-18
ok(
  "KST 15:00(리셋 전) → Pacific 전날",
  getQuotaDate(new Date("2026-07-19T06:00:00Z")) === "2026-07-18",
);
// 2026-07-19 17:00 KST = 2026-07-19 01:00 PDT → Pacific 날짜 07-19 (리셋 후)
ok(
  "KST 17:00(리셋 후) → Pacific 당일",
  getQuotaDate(new Date("2026-07-19T08:00:00Z")) === "2026-07-19",
);
ok("YYYY-MM-DD 포맷", /^\d{4}-\d{2}-\d{2}$/.test(getQuotaDate(new Date())));

// ── quotaJobStatus: degrade=warning 교정 ────────────────────────────
ok("정상 → success", quotaJobStatus({ hardErrors: 0, degraded: false }) === "success");
ok("quota degrade → warning(성공 오표기 아님)", quotaJobStatus({ hardErrors: 0, degraded: true }) === "warning");
ok("hardError → error", quotaJobStatus({ hardErrors: 2, degraded: false }) === "error");
ok("hardError+degrade → error 우선", quotaJobStatus({ hardErrors: 1, degraded: true }) === "error");

// ── reserveQuota: RPC 매핑 + 백스톱 ─────────────────────────────────
type RpcResp = { data: unknown; error: { message: string } | null };
function fakeSb(resp: RpcResp) {
  return { rpc: async () => resp } as unknown as Parameters<typeof reserveQuota>[0];
}
(async () => {
  const allow = await reserveQuota(
    fakeSb({ data: [{ allowed: true, used_after: 400, remaining: 9100 }], error: null }),
    100,
  );
  ok("allowed=true 매핑", allow.allowed === true && allow.remaining === 9100 && allow.used === 400);

  const deny = await reserveQuota(
    fakeSb({ data: [{ allowed: false, used_after: 9500, remaining: 0 }], error: null }),
    100,
  );
  ok("allowed=false(cap 초과) 매핑", deny.allowed === false && deny.remaining === 0);

  // RPC 실패 → 백스톱(allowed=true, ledgerError) — 파이프라인 안 막음
  const err = await reserveQuota(
    fakeSb({ data: null, error: { message: "relation does not exist" } }),
    100,
  );
  ok("RPC 오류 → 백스톱 allowed=true", err.allowed === true && !!err.ledgerError);

  // data 빈 응답 → 백스톱
  const empty = await reserveQuota(fakeSb({ data: [], error: null }), 100);
  ok("빈 응답 → 백스톱 allowed=true", empty.allowed === true && !!empty.ledgerError);

  // recordQuota는 오류를 삼켜 파이프라인을 막지 않음 (throw 안 함)
  let threw = false;
  try {
    await recordQuota(fakeSb({ data: null, error: { message: "boom" } }), 100);
  } catch { threw = true; }
  ok("recordQuota는 throw 안 함(best-effort)", !threw);
  ok("recordQuota units<=0 무시", (await recordQuota(fakeSb({ data: null, error: null }), 0)) === undefined);

  console.log(`\n${fail === 0 ? "🟢 ALL PASS" : `🔴 ${fail} FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
})();
