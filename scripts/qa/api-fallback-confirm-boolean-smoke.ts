/**
 * TS caller 가 confirm_api_fallback_alert 의 반환 boolean 을 실제로 소비하는지 결정론적 검증
 * (삼순 4차 NO-GO: DB fence 는 원자적이지만 settleAttempt 이 confirm boolean 을 무시하면
 *  stale 전송이 sent 로 카운트되어 이중 경보/오집계가 남는다).
 *
 * 네트워크 0: supabaseAdmin 싱글톤의 .rpc 를 몽키패치하고 global.fetch 를 stub 한다.
 * drainApiFallbackAlerts() 는 각 due outbox 에 대해 settleAttempt 을 태우므로,
 *  - confirm=true  → summary.sent=1  (우리 토큰이 소유 소비)
 *  - confirm=false → summary.sent=0, failed=1 (stale: audit/state 안 바꿈 → sent 로 안 셈)
 *  - confirm RPC error → sent=0, failed=1 (소유 미확정)
 * boolean 을 무시하는 구현이면 confirm=false 에서도 sent=1 이 되어 이 테스트가 실패한다.
 * 실행: npm run qa:api-fallback-confirm-boolean
 */

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log("  ✅ " + name);
  } else {
    fail++;
    console.error("  ❌ " + name);
  }
}

async function main() {
  // import 부작용(싱글톤 생성) 방지용 placeholder env + confirm 도달 위한 텔레그램 토큰.
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-placeholder";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-placeholder";
  process.env.TELEGRAM_BOT_TOKEN ??= "test-bot-token";

  // 텔레그램 전송을 항상 2xx(ACK)로 stub → delivered=true 라 confirm 경로로 진입.
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;

  // 시나리오별 confirm 반환값을 제어. rpc 호출을 기록해 실제 소비 경로를 확인.
  let confirmData: unknown = true;
  let confirmError: { message: string } | null = null;
  const rpcLog: string[] = [];

  const adminMod = await import("../../src/lib/supabase/admin");
  const admin = adminMod.supabaseAdmin as unknown as {
    rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
  admin.rpc = async (fn: string) => {
    rpcLog.push(fn);
    if (fn === "drain_api_fallback_alerts") {
      return {
        data: [
          {
            api_name: "kbo-scoreboard-linescore",
            attempt_token: "11111111-1111-1111-1111-111111111111",
            reason: "schema-error",
            error_message: "deterministic test",
          },
        ],
        error: null,
      };
    }
    if (fn === "confirm_api_fallback_alert") {
      return { data: confirmData, error: confirmError };
    }
    if (fn === "nack_api_fallback_alert") {
      return { data: true, error: null };
    }
    return { data: null, error: null };
  };

  const { drainApiFallbackAlerts } = await import("../../src/lib/monitoring/api-fallback-tracker");

  try {
    // ── 시나리오 1: confirm=true → 소유 소비 → sent 1 ──
    confirmData = true;
    confirmError = null;
    rpcLog.length = 0;
    const s1 = await drainApiFallbackAlerts({ leaseSeconds: 120, maxBatch: 20 });
    ok("confirm=true → drained 1", s1.drained === 1);
    ok("confirm=true → sent 1", s1.sent === 1);
    ok("confirm=true → failed 0", s1.failed === 0);
    ok("confirm=true → confirm RPC 실제 호출됨", rpcLog.includes("confirm_api_fallback_alert"));
    ok("confirm=true → nack 미호출", !rpcLog.includes("nack_api_fallback_alert"));

    // ── 시나리오 2: confirm=false(stale) → sent 로 안 셈(boolean 소비 증명) ──
    confirmData = false;
    confirmError = null;
    const s2 = await drainApiFallbackAlerts({ leaseSeconds: 120, maxBatch: 20 });
    ok("confirm=false → drained 1", s2.drained === 1);
    ok("confirm=false(stale) → sent 0 (boolean 소비)", s2.sent === 0);
    ok("confirm=false(stale) → failed 1", s2.failed === 1);

    // ── 시나리오 3: confirm RPC error → 소유 미확정 → sent 0 ──
    confirmData = null;
    confirmError = { message: "rpc boom" };
    const s3 = await drainApiFallbackAlerts({ leaseSeconds: 120, maxBatch: 20 });
    ok("confirm error → sent 0", s3.sent === 0);
    ok("confirm error → failed 1", s3.failed === 1);

    ok("텔레그램 전송(fetch) 세 시나리오 모두 실행됨", fetchCalls === 3);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\napi-fallback confirm boolean 소비: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
