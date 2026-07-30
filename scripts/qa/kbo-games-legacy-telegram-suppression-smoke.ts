let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`);
  }
}

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-placeholder";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-placeholder";
  process.env.TELEGRAM_BOT_TOKEN ??= "test-bot-token";

  const adminMod = await import("../../src/lib/supabase/admin");
  const admin = adminMod.supabaseAdmin as unknown as {
    rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: null }>;
  };

  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  admin.rpc = (name, args) => {
    rpcCalls.push({ name, args });
    return new Promise(() => {});
  };

  const realFetch = globalThis.fetch;
  let telegramCalls = 0;
  globalThis.fetch = (async () => {
    telegramCalls++;
    return new Promise(() => {});
  }) as typeof fetch;

  try {
    const { trackFallback } = await import("../../src/lib/monitoring/api-fallback-tracker");

    const claimStarted = Date.now();
    await trackFallback("kbo-games", "timeout", { errorMessage: "claim pending" });
    const claimElapsed = Date.now() - claimStarted;
    ok("event 1건 → durable claim RPC 1회", rpcCalls.length === 1 && rpcCalls[0]?.name === "claim_api_fallback_alert");
    ok("durable 정책 5분/3회/30분/120초", (
      rpcCalls[0]?.args.p_window_minutes === 5 &&
      rpcCalls[0]?.args.p_threshold === 3 &&
      rpcCalls[0]?.args.p_cooldown_minutes === 30 &&
      rpcCalls[0]?.args.p_lease_seconds === 120
    ));
    ok("claim RPC pending이어도 사용자 경로 100ms 내 반환", claimElapsed < 100);

    admin.rpc = async (name, args) => {
      rpcCalls.push({ name, args });
      return { data: [{ should_send: true, attempt_token: "token-1" }], error: null };
    };
    const telegramStarted = Date.now();
    await trackFallback("kbo-games", "timeout", { errorMessage: "telegram pending" });
    const telegramElapsed = Date.now() - telegramStarted;
    ok("Telegram pending이어도 사용자 경로 100ms 내 반환", telegramCalls === 1 && telegramElapsed < 100);
    ok("legacy insert/buffer/fanout 경로 없이 durable claim만 사용", rpcCalls.every((c) => c.name === "claim_api_fallback_alert"));
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\nkbo-games durable fallback tracking: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
