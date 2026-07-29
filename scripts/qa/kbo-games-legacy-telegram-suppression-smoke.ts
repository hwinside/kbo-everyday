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

  let insertCalls = 0;
  const adminMod = await import("../../src/lib/supabase/admin");
  const admin = adminMod.supabaseAdmin as unknown as {
    from: () => { insert: () => Promise<{ error: null }> };
  };
  admin.from = () => ({
    insert: async () => {
      insertCalls++;
      return { error: null };
    },
  });

  const realFetch = globalThis.fetch;
  let telegramCalls = 0;
  globalThis.fetch = (async () => {
    telegramCalls++;
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;

  try {
    const { trackFallback } = await import("../../src/lib/monitoring/api-fallback-tracker");

    for (let i = 0; i < 5; i++) {
      await trackFallback("kbo-games", "timeout", { errorMessage: `failure-${i}` });
    }
    ok("kbo-games 이벤트 저장은 유지", insertCalls === 5);
    ok("kbo-games legacy Telegram은 임계치 이후에도 0회", telegramCalls === 0);

    for (let i = 0; i < 3; i++) {
      await trackFallback("naver-standings", "timeout", { errorMessage: `control-${i}` });
    }
    ok("다른 legacy API 이벤트 저장 유지", insertCalls === 8);
    ok("다른 legacy API 경보 동작은 유지", telegramCalls === 1);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\nkbo-games legacy Telegram suppression: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
