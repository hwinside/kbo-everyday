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
    const {
      getRecentFallbackBufferSizeForTest,
      trackFallback,
    } = await import("../../src/lib/monitoring/api-fallback-tracker");

    // 유저 대면 /api/stats(+cron) 트래픽이 KBO 열화 중 인스턴스마다 첫 알림을 발사하던 폭주 경로.
    // batter: 임계치(3회)를 훨씬 넘겨도 legacy Telegram 은 0회여야 한다(이벤트 저장은 유지).
    for (let i = 0; i < 5; i++) {
      await trackFallback("kbo-player-stats-batter", "timeout", { errorMessage: `batter-${i}` });
    }
    ok("kbo-player-stats-batter 이벤트 저장은 유지", insertCalls === 5);
    ok("kbo-player-stats-batter legacy Telegram은 임계치 이후에도 0회", telegramCalls === 0);
    ok("kbo-player-stats-batter 이벤트는 in-memory buffer에 남지 않음", getRecentFallbackBufferSizeForTest() === 0);

    for (let i = 0; i < 5; i++) {
      await trackFallback("kbo-player-stats-pitcher", "timeout", { errorMessage: `pitcher-${i}` });
    }
    ok("kbo-player-stats-pitcher 이벤트 저장은 유지", insertCalls === 10);
    ok("kbo-player-stats-pitcher legacy Telegram은 임계치 이후에도 0회", telegramCalls === 0);
    ok("kbo-player-stats-pitcher 이벤트는 in-memory buffer에 남지 않음", getRecentFallbackBufferSizeForTest() === 0);

    // 다른 legacy API 경보 동작은 그대로 유지되는지(과억제 회귀 방지).
    for (let i = 0; i < 3; i++) {
      await trackFallback("naver-standings", "timeout", { errorMessage: `control-${i}` });
    }
    ok("다른 legacy API 이벤트 저장 유지", insertCalls === 13);
    ok("다른 legacy API 경보 동작은 유지", telegramCalls === 1);
    ok("다른 legacy API in-memory threshold는 유지", getRecentFallbackBufferSizeForTest() === 3);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\nplayer-stats legacy Telegram suppression: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
