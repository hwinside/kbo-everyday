/**
 * 라이브 API 엣지 캐시 계약 회귀.
 *
 * 배경(Vercel 비용 절감 트랙): `/api/game-relay`·`/api/game-live`·`/api/contextual-stats`
 * 가 전부 `x-vercel-cache: MISS` + `max-age=0, must-revalidate` 로 나가고 있어, 같은
 * 경기를 보는 동시 시청자 N 명이 전부 origin 을 때리고 있었다. 라이브 3s 폴링에서
 * 뷰어당 960KB/분 → 경기룸 origin transfer 의 대부분을 차지한다.
 *
 * 이 게이트가 막는 회귀는 **비용이 아니라 신선도·정확성**이다. 캐시를 켜면 다음이
 * 조용히 깨질 수 있고, 전부 유저에게 보이는 버그다:
 *
 *   (1) 열화(degraded) 응답이 엣지에 고정 → TTL 동안 stale 값이 박제되고 다음 폴링의
 *       자가복구가 막힌다. last-good 을 "내보내되 캐시하지 않는" 계약이 필요하다.
 *   (2) `since` 캐시 키 폭발 → 클라이언트마다 다른 since 를 보내면 URL 이 갈라져
 *       캐시 적중이 0 이 된다(= 켠 의미가 없는데 켰다고 착각).
 *   (3) 브라우저 사설 캐시에 걸려 폴링이 관측 불가능하게 늦어짐.
 *
 * **검증 방식**: 헤더 상수를 문자열로 비교하지 않는다. 실제 route 의 `GET` 을 호출해
 * 나온 `Response` 의 `Cache-Control` 을 읽는다. upstream 은 `fetch` seam 을 주입해
 * 정상/열화/에러를 결정론적으로 만든다.
 */
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "smoke-service-role-key";

let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failures.push(`${name}: ${(e as Error).message}`);
      console.log(`  ✗ ${name}\n      ${(e as Error).message}`);
    }
  })();
}

/** Cache-Control 을 파싱해 의미 단위로 판정한다(문자열 완전일치 금지 — 순서/공백에 취약). */
function parseCacheControl(res: Response): {
  raw: string;
  sMaxAge: number | null;
  maxAge: number | null;
  noStore: boolean;
  mustRevalidate: boolean;
  swr: number | null;
} {
  const raw = res.headers.get("Cache-Control") ?? "";
  const parts = raw.split(",").map((p) => p.trim().toLowerCase());
  const num = (key: string): number | null => {
    const hit = parts.find((p) => p.startsWith(`${key}=`));
    if (!hit) return null;
    const v = Number(hit.slice(key.length + 1));
    return Number.isFinite(v) ? v : null;
  };
  return {
    raw,
    sMaxAge: num("s-maxage"),
    maxAge: num("max-age"),
    noStore: parts.includes("no-store"),
    mustRevalidate: parts.includes("must-revalidate"),
    swr: num("stale-while-revalidate"),
  };
}

/** 엣지에 캐시되는 응답이어야 한다. */
function assertEdgeCacheable(res: Response, expectTtl: number, label: string) {
  const cc = parseCacheControl(res);
  assert.equal(cc.noStore, false, `${label}: no-store 가 붙어 캐시 불가 (${cc.raw})`);
  assert.equal(cc.sMaxAge, expectTtl, `${label}: s-maxage 가 ${expectTtl} 이 아님 (${cc.raw})`);
  assert.equal(cc.maxAge, 0, `${label}: 브라우저 사설 캐시가 열림 max-age=${cc.maxAge} (${cc.raw})`);
  assert.equal(cc.mustRevalidate, true, `${label}: must-revalidate 누락 (${cc.raw})`);
  // 신선도 계약: SWR 은 TTL 만료 후에도 낡은 응답을 내보내므로 max staleness 가 TTL 을
  // 넘어간다 = 활성 유저 신선도 저하. 절대 붙으면 안 된다.
  assert.equal(cc.swr, null, `${label}: stale-while-revalidate 가 붙어 신선도 상한이 깨짐 (${cc.raw})`);
}

/** 엣지에 절대 캐시되면 안 되는 응답이어야 한다. */
function assertNotCacheable(res: Response, label: string) {
  const cc = parseCacheControl(res);
  assert.equal(
    cc.sMaxAge,
    null,
    `${label}: 열화/에러 응답인데 s-maxage=${cc.sMaxAge} 로 엣지에 박제됨 (${cc.raw})`,
  );
  assert.equal(cc.noStore, true, `${label}: no-store 가 아님 (${cc.raw})`);
}

async function main() {
  console.log("\n=== live-edge-cache-smoke ===\n");

  const {
    RELAY_EDGE_TTL_SECONDS,
    LIVE_LIST_EDGE_TTL_SECONDS,
    edgeCacheHeaders,
    liveCacheHeaders,
    NO_STORE_HEADERS,
  } = await import("../../src/lib/http/live-cache");

  const { resolveDeltaSince } = await import("../../src/lib/game/relay-delta");

  console.log("[1] 캐시 헤더 SSOT 계약");

  await check("정상 응답은 s-maxage 로 엣지 캐시 + 브라우저 캐시 금지", () => {
    const h = edgeCacheHeaders(2);
    const res = new Response(null, { headers: h });
    assertEdgeCacheable(res, 2, "edgeCacheHeaders(2)");
  });

  await check("SWR 은 어떤 경로로도 생성되지 않는다(신선도 상한 == TTL)", () => {
    for (const ttl of [1, 2, 5, 30]) {
      const cc = parseCacheControl(new Response(null, { headers: edgeCacheHeaders(ttl) }));
      assert.equal(cc.swr, null, `ttl=${ttl} 에서 SWR 발생: ${cc.raw}`);
      assert.equal(cc.sMaxAge, ttl, `ttl=${ttl} 반영 실패: ${cc.raw}`);
    }
  });

  await check("잘못된 TTL 은 fail-close(무기한 캐시 금지)", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      const res = new Response(null, { headers: edgeCacheHeaders(bad) });
      assertNotCacheable(res, `edgeCacheHeaders(${bad})`);
    }
  });

  await check("liveCacheHeaders(false) 는 no-store — 열화 응답 박제 방지", () => {
    assertNotCacheable(new Response(null, { headers: liveCacheHeaders(false, 2) }), "cacheable=false");
    assertEdgeCacheable(new Response(null, { headers: liveCacheHeaders(true, 2) }), 2, "cacheable=true");
  });

  await check("NO_STORE_HEADERS 는 브라우저·엣지 모두 금지", () => {
    assertNotCacheable(new Response(null, { headers: NO_STORE_HEADERS }), "NO_STORE_HEADERS");
  });

  console.log("\n[2] since 캐시 키 폭발 방지 (resolveDeltaSince)");

  await check("같은 이닝을 보는 시청자는 since 가 동일 — 키 1개로 수렴", () => {
    const canonical = 7;
    // 서로 다른 클라이언트가 서로 다른 로컬 보유 상태를 갖고 있어도,
    // canonical 과 일치하는 쪽은 전부 같은 since 를 낸다.
    const followers = [7, 7, 7].map((localMax) =>
      resolveDeltaSince({ localMaxInning: localMax, canonicalInning: canonical, wantFull: false }),
    );
    assert.deepEqual(followers, [7, 7, 7], "따라잡은 클라이언트끼리 since 불일치");
  });

  await check("뒤처진/앞선 클라이언트는 since=0(full) — 키 모양이 2개로 고정", () => {
    const canonical = 7;
    const laggards = [1, 3, 6, 8, 9].map((localMax) =>
      resolveDeltaSince({ localMaxInning: localMax, canonicalInning: canonical, wantFull: false }),
    );
    assert.deepEqual(laggards, [0, 0, 0, 0, 0], "불일치 클라이언트가 고유 since 를 냄(키 폭발)");
  });

  await check("시청자 1,000명 시뮬레이션에서 distinct 키가 상수(<=2)", () => {
    const canonical = 5;
    const keys = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      // 현실적 분포: 대부분 따라잡았고 일부는 갓 진입(0) 또는 뒤처짐.
      const localMax = i % 7 === 0 ? (i % 4) : canonical;
      const since = resolveDeltaSince({
        localMaxInning: localMax,
        canonicalInning: canonical,
        wantFull: i % 10 === 0,
      });
      keys.add(since > 0 ? `since=${since}` : "full");
    }
    assert.ok(
      keys.size <= 2,
      `distinct 캐시 키가 ${keys.size} 개 (>2). 시청자 수에 비례하면 엣지 캐시가 무효화된다: ${[...keys].join(",")}`,
    );
  });

  await check("self-heal(wantFull) 차례는 항상 full", () => {
    assert.equal(
      resolveDeltaSince({ localMaxInning: 7, canonicalInning: 7, wantFull: true }),
      0,
      "wantFull 인데 delta 를 요청함 — 지난 이닝 정정 self-heal 이 깨진다",
    );
  });

  await check("canonical 미확인(0)이면 full — 잘못된 delta 로 구멍 만들지 않음", () => {
    assert.equal(resolveDeltaSince({ localMaxInning: 7, canonicalInning: 0, wantFull: false }), 0);
    assert.equal(resolveDeltaSince({ localMaxInning: 0, canonicalInning: 7, wantFull: false }), 0);
  });

  console.log("\n[3] 실제 route GET 이 계약대로 헤더를 낸다");

  const relayRoute = await import("../../src/app/api/game-relay/route");
  const { NextRequest } = await import("next/server");

  const originalFetch = globalThis.fetch;

  const makeReq = (qs: string) =>
    new NextRequest(new URL(`http://localhost/api/game-relay?${qs}`));

  await check("gameId 누락 400 은 no-store", async () => {
    const res = await relayRoute.GET(makeReq(""));
    assert.equal(res.status, 400);
    assertNotCacheable(res, "game-relay 400");
  });

  await check("upstream 하드실패 503 은 no-store — 에러가 엣지에 박제되지 않음", async () => {
    globalThis.fetch = (async () =>
      new Response("upstream down", { status: 503 })) as typeof fetch;
    try {
      const res = await relayRoute.GET(makeReq("gameId=20260805LGOB0"));
      assert.equal(res.status, 503, `기대 503, 실제 ${res.status}`);
      assertNotCacheable(res, "game-relay 503");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * 이닝별 upstream 응답을 직접 조종해 정상/열화를 결정론적으로 만든다.
   * `failInnings` 에 들어있는 이닝은 fetch 실패(null) 취급 → last-good 스냅샷
   * 경로로 떨어져 degraded 가 된다.
   */
  function installRelayUpstream(opts: {
    currentInning: number;
    failInnings?: Set<number>;
    playsPerInning?: (inning: number) => number;
  }) {
    const { currentInning, failInnings = new Set<number>() } = opts;
    const playsPerInning = opts.playsPerInning ?? (() => 2);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      const m = /[?&]inning=(\d+)/.exec(url);
      if (!m) return new Response("{}", { status: 200 });
      const inning = Number(m[1]);
      if (failInnings.has(inning)) {
        return new Response("inning upstream down", { status: 500 });
      }
      // 실제 Naver 스키마: newest-first 배열. titleStyle "0" = 이닝 헤더,
      // 그 외 = 타석 relay(textOptions). type 8 = 타석 시작, 13 = 타석 결과.
      // 파서(parseInningRelays)가 이 형식을 요구하므로 픽스처를 가짜로 만들면
      // innings 가 빈 배열로 나온다(= 이 게이트가 실제로 잡았던 지점).
      const atBats = Array.from({ length: playsPerInning(inning) }, (_, k) => ({
        title: `${k + 1}번타자 테스트타자${k + 1}`,
        titleStyle: "8",
        textOptions: [
          { seqno: inning * 100 + k * 2, text: `${k + 1}번타자 테스트타자${k + 1}`, type: 8 },
          {
            seqno: inning * 100 + k * 2 + 1,
            text: `테스트타자${k + 1} : 1루액타`,
            type: 13,
          },
        ],
      }));
      const header = {
        title: `${inning}회초 테스트 공격`,
        titleStyle: "0",
      };
      // newest-first: 타석을 역순으로 두고 헤더가 마지막에 온다.
      const textRelays = [...atBats].reverse().concat([header] as never[]);
      return new Response(
        JSON.stringify({ result: { textRelayData: { inn: currentInning, textRelays } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
  }

  await check("정상 응답은 실제로 엣지 캐시 대상이다(200 + s-maxage)", async () => {
    installRelayUpstream({ currentInning: 3 });
    try {
      const res = await relayRoute.GET(makeReq("gameId=20260805EDGE1"));
      assert.equal(res.status, 200, `기대 200, 실제 ${res.status}`);
      assertEdgeCacheable(res, RELAY_EDGE_TTL_SECONDS, "game-relay 200");
      const body = (await res.json()) as { innings?: unknown[] };
      assert.ok(
        Array.isArray(body.innings) && body.innings.length > 0,
        "캐시 가능 판정을 받았는데 이닝 본문이 비어있음(빈 응답을 박제할 뻔)",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await check(
    "부분실패(last-good 대체) 응답은 200 이지만 캐시 금지 — 열화 박제 방지",
    async () => {
      // 1) 먼저 정상 응답으로 last-good 스냅샷을 쌓는다.
      installRelayUpstream({ currentInning: 4 });
      try {
        const warm = await relayRoute.GET(makeReq("gameId=20260805EDGE2"));
        assert.equal(warm.status, 200, "사전 상태 구성 실패");
      } finally {
        globalThis.fetch = originalFetch;
      }

      // 2) route 내부 responseCache TTL(2s) 을 피해 새 gameId 가 아닌 동일 경기로
      //    재요청하되, 이번엔 일부 이닝을 죽인다. inning 힌트를 바꿔 cacheKey 를
      //    바꾸면 warm cache HIT 을 피해 fresh 경로를 타게 된다.
      installRelayUpstream({ currentInning: 4, failInnings: new Set([3]) });
      try {
        const res = await relayRoute.GET(makeReq("gameId=20260805EDGE2&inning=4"));
        assert.equal(res.status, 200, `부분실패는 last-good 으로 200 이어야 함, 실제 ${res.status}`);
        assertNotCacheable(res, "game-relay degraded 200");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  await check("동일 쿼리 재요청은 upstream 을 다시 때리지 않는다(origin 보호)", async () => {
    let upstreamCalls = 0;
    installRelayUpstream({ currentInning: 2 });
    const wrapped = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      upstreamCalls++;
      return wrapped(...args);
    }) as typeof fetch;
    try {
      await relayRoute.GET(makeReq("gameId=20260805EDGE3"));
      const afterFirst = upstreamCalls;
      assert.ok(afterFirst > 0, "첫 요청이 upstream 을 안 타지 않음(픽스처 오류)");
      // TTL(2s) 내 연속 요청 → route 내부 캐시 HIT 으로 upstream 추가 호출 0.
      await relayRoute.GET(makeReq("gameId=20260805EDGE3"));
      assert.equal(
        upstreamCalls,
        afterFirst,
        `TTL 내 재요청이 upstream 을 ${upstreamCalls - afterFirst}회 더 호출함`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await check("warm cache HIT 응답도 엣지 캐시 헤더를 잃지 않는다", async () => {
    installRelayUpstream({ currentInning: 5 });
    try {
      const first = await relayRoute.GET(makeReq("gameId=20260805EDGE4"));
      assert.equal(first.status, 200);
      const second = await relayRoute.GET(makeReq("gameId=20260805EDGE4"));
      assert.equal(second.status, 200);
      assertEdgeCacheable(second, RELAY_EDGE_TTL_SECONDS, "game-relay warm HIT");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("\n실패:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
