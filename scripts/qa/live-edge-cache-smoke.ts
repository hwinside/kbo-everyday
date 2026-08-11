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


/**
 * KBO Basic.aspx / Situation.aspx 의 **parser-valid** HTML fixture.
 *
 * 왜 필요한가(삼순 NO-GO 2026-08-06 5차): 앞선 자가복구 검사는 "복구" 응답으로
 * `<html><body>recovered</body></html>` 를 줬는데, 그건 parser 가 basic=null·
 * situation=빈 배열로 떨어뜨려 **여전히 degraded** 다. 즉 재조회만 증명하고
 * 정상 데이터 노출·정상 bundle 의 full-TTL 재캐시는 전혀 안 태우는 false-green 이었다.
 * 실제 parser 가 값을 뽑아내는 마크업이어야 복구를 증명할 수 있다.
 */
function row(cells: string[]): string {
  return `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
}
function table(rows: string[][]): string {
  return `<table>${rows.map(row).join("")}</table>`;
}

/** 포지션 줄 — handedness-parser 가 읽는 유일한 지점. */
function profileHead(position: string): string {
  return `<ul><li><strong>포지션: </strong><span class="p">${position}</span></li></ul>`;
}

/** 타자 Basic: t0[9]=HR, t0[11]=RBI / t1[12]=PH-BA */
function hitterBasicHtml(): string {
  const t0 = ["LG", "0.312", "100", "420", "380", "60", "119", "20", "2", "15", "188", "70", "5", "2", "3", "4"];
  const t1 = ["40", "2", "5", "60", "8", "0.495", "0.380", "3", "71.4", "30", "0.875", "0.330", "0.250"];
  return `<html><body>${profileHead("외야수(우투우타)")}${table([[], t0])}${table([[], t1])}</body></html>`;
}

/** 투수 Basic: t0[16]=HR / t1[4]=SO */
function pitcherBasicHtml(): string {
  const t0 = ["키움", "3.45", "25", "0", "0", "10", "6", "0", "0", "0.625", "600", "2400", "150.1", "140", "25", "3", "12"];
  const t1 = ["2", "3", "45", "1", "130", "4", "0", "60", "58", "0", "1.23", "0.245", "15"];
  return `<html><body>${profileHead("투수(우투)")}${table([[], t0])}${table([[], t1])}</body></html>`;
}

/**
 * 타자 Situation: 6개 테이블 중 0(bases)/4(byHand)/5(byOuts)만 소비된다.
 * byHand 의 `우투수` 행은 AB>=30(vsHand 임계)을 넘겨야 실제 라인이 만들어진다.
 * 헤더 행("구분 …")도 실제 페이지처럼 넣어 parser 의 헤더 스킵 경로까지 태운다.
 */
function hitterSituationHtml(): string {
  const head = ["구분", "AVG", "AB", "H", "2B", "3B", "HR", "RBI", "BB", "HBP", "SO", "GDP"];
  const bases = table([head, ["주자없음", "0.300", "200", "60", "10", "1", "8", "8", "20", "2", "30", "3"]]);
  const filler = table([head]);
  const byHand = table([
    head,
    ["좌투수", "0.280", "120", "34", "5", "0", "4", "18", "12", "1", "20", "2"],
    ["우투수", "0.325", "260", "85", "15", "2", "11", "52", "28", "4", "40", "6"],
  ]);
  const byOuts = table([head, ["2아웃", "0.290", "140", "41", "7", "1", "5", "25", "15", "2", "24", "3"]]);
  return `<html><body>${bases}${filler}${filler}${filler}${byHand}${byOuts}</body></html>`;
}

/** 투수 Situation: 구분 | H | 2B | 3B | HR | BB | HBP | SO | WP | BK | AVG */
function pitcherSituationHtml(): string {
  const head = ["구분", "H", "2B", "3B", "HR", "BB", "HBP", "SO", "WP", "BK", "AVG"];
  const rows = (label: string) => [label, "40", "6", "1", "3", "15", "2", "35", "1", "0", "0.250"];
  const t = table([head, rows("주자없음")]);
  const byHand = table([head, rows("좌타자"), rows("우타자")]);
  const byOuts = table([head, rows("2아웃")]);
  return `<html><body>${t}${table([head])}${table([head])}${table([head])}${byHand}${byOuts}</body></html>`;
}

async function main() {
  console.log("\n=== live-edge-cache-smoke ===\n");

  const {
    RELAY_EDGE_TTL_SECONDS,
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
    /** upstream 응답 지연(ms). 느린 러너/느린 첫 GET 재현용. */
    delayMs?: number;
  }) {
    const { currentInning, failInnings = new Set<number>(), delayMs = 0 } = opts;
    const playsPerInning = opts.playsPerInning ?? (() => 2);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
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

  await check("warm cache HIT 응답이 실제 남은 수명과 일치한다(추정 금지)", async () => {
    // ⚠️ 이 검사는 두 번 틀렸다(삼순 NO-GO):
    //  1차: warm HIT 에 **full TTL** 을 기대 → remaining-age 계약 도입 뒤 느린 CI 에서 false-fail.
    //  2차: `t0` 로 경과시간을 재서 남은 수명을 **추정** → 만료 시계는 첫 GET **끝**의
    //       setCachedResponse 부터 시작하므로 느린 첫 GET 에서 추정치가 실제와 어긋난다.
    // → 추정을 버리고 route 의 **실제 캐시 엔트리 남은 수명**을 읽어 판정한다.
    //   지연을 주입해도 판정이 흔들리지 않아야 timing false-green/false-fail 이 사라진다.
    const gameId = "20260805EDGE4";
    // 첫 GET 을 인위적으로 느리게 만들어(1.2초) 느린 러너를 재현한다. 추정 기반이면
    // 여기서 어긋나고, 실제 remaining 기반이면 흔들리지 않는다.
    installRelayUpstream({ currentInning: 5, delayMs: 1200 });
    try {
      const first = await relayRoute.GET(makeReq(`gameId=${gameId}`));
      assert.equal(first.status, 200);

      // 캐시가 실제로 채워졌는지부터 확인한다(픽스처가 새면 검사가 조용히 무력화된다).
      const remainingBefore = relayRoute.__getCacheRemainingMsForTest(gameId);
      assert.ok(
        remainingBefore !== null,
        "첫 GET 이 캐시를 채우지 않았다 — warm HIT 경로를 태울 수 없다(픽스처 오류)",
      );

      const second = await relayRoute.GET(makeReq(`gameId=${gameId}`));
      const remainingAfter = relayRoute.__getCacheRemainingMsForTest(gameId);
      assert.equal(second.status, 200);
      const cc = parseCacheControl(second);

      // ⚠️ 순간값 하나로 등호 비교하면 1ms 차이로 floor 가 갈려 flake 가 난다(자기적발:
      //    remaining 1999ms → floor 1 인데 헤더는 2 였다). 헤더가 계산된 시점은
      //    before~after 사이 어딘가이므로 **그 구간 안에 있는지**로 판정한다.
      //    구간은 실제 캐시 수명에서 나오므로 여전히 추정이 아니다.
      const loMs = Math.min(remainingBefore!, remainingAfter ?? 0);
      const hiMs = Math.max(remainingBefore!, remainingAfter ?? 0);
      const loSec = Math.floor(loMs / 1000);
      const hiSec = Math.min(Math.floor(hiMs / 1000), RELAY_EDGE_TTL_SECONDS);

      if (loSec >= 1) {
        assert.ok(
          cc.sMaxAge !== null && cc.sMaxAge >= loSec && cc.sMaxAge <= hiSec,
          `warm HIT s-maxage=${cc.sMaxAge} 가 실제 남은 수명 구간(${loMs}~${hiMs}ms → ${loSec}~${hiSec}s)을 벗어남: ${cc.raw}`,
        );
        assert.equal(cc.swr, null, `warm HIT 에 SWR 발생: ${cc.raw}`);
      } else if (hiSec < 1) {
        // 남은 수명 1초 미만이면 no-store 가 정답(반올림으로 상한 초과 방지).
        assertNotCacheable(second, `warm HIT 남은 ${hiMs}ms`);
      }
      // loSec=0, hiSec>=1 인 경계는 어느 쪽이든 계약 위반이 아니라 판정하지 않는다.
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  console.log("\n[4] contextual-stats 동일 계약 (빈 응답 박제 금지)");

  // 배경: 이 게이트의 초기 버전은 game-relay 만 태워서, contextual-stats 의
  // liveCacheHeaders(!empty, ...) 를 liveCacheHeaders(true, ...) 로 바꿔도(= 빈
  // 응답까지 엣지에 박제) GREEN 이었다(mutation F). 매핑 실패·라이브 미조회
  // 구간의 빈 박스가 TTL 동안 고정되는 유저 버그라 직접 태운다.
  const contextualRoute = await import("../../src/app/api/contextual-stats/route");
  const ctxReq = (qs: string) =>
    new NextRequest(new URL(`http://localhost/api/contextual-stats?${qs}`));

  await check("gameId 누락 400 은 no-store", async () => {
    const res = await contextualRoute.GET(ctxReq(""));
    assert.equal(res.status, 400);
    assertNotCacheable(res, "contextual-stats 400");
  });

  await check(
    "라이브 미조회 → empty 응답은 캐시 금지(빈 박스 박제 방지)",
    async () => {
      // upstream 을 전면 실패시켜 fetchLiveGame 이 null → emptyResponse 경로.
      globalThis.fetch = (async () =>
        new Response("down", { status: 503 })) as typeof fetch;
      try {
        const res = await contextualRoute.GET(ctxReq("gameId=20260805EDGE9"));
        assert.equal(res.status, 200, `기대 200(empty payload), 실제 ${res.status}`);
        const body = (await res.clone().json()) as { empty?: boolean };
        assert.equal(body.empty, true, "empty 응답 경로를 재현하지 못함(픽스처 오류)");
        assertNotCacheable(res, "contextual-stats empty");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  await check(
    "상대 매핑 성공 시 최종 응답도 empty 면 캐시 금지 — 마지막 return 경로 직접 태움",
    async () => {
      // 앞의 검사들은 조기 emptyResponse 분기만 태워서, 최종 return 의
      // liveCacheHeaders(!empty, ...) 를 liveCacheHeaders(true, ...) 로 바꿔도 검출되지
      // 않았다(mutation F GREEN). 실제 로스터 선수로 매핑을 성공시켜 그 경로를 태운다.
      const roster = (await import("../../src/lib/constants/players-roster.json"))
        .default as Array<{ name: string; position: string }>;
      const pitcherName = roster.find((p) => p.position === "투수")?.name;
      const batterName = roster.find((p) => p.position !== "투수")?.name;
      assert.ok(pitcherName && batterName, "로스터에서 테스트 선수를 찾지 못함");

      const gameId = "20260805EDGE8";
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        // 경기 목록은 성공시켜 fetchLiveGame 이 rawGame 을 찾게 한다.
        if (url.includes("GetKboGameList")) {
          // parseKboGameListPayload 가 G_ID 패턴·GAME_STATE_SC·AWAY_NM·HOME_NM 을 전부
          // 검증한다. 하나라도 빠지면 payload 전체가 null 로 떨어져 fetchLiveGame 이
          // 조기 반환하고 최종 return 을 못 태운다(이게 mutation F 가 GREEN 이었던 이유).
          return new Response(
            JSON.stringify({
              game: [
                {
                  G_ID: gameId,
                  GAME_STATE_SC: "2",
                  AWAY_NM: "LG",
                  HOME_NM: "키움",
                  GAME_TB_SC: "T",
                  T_P_NM: batterName,
                  B_P_NM: pitcherName,
                  GAME_INN_NO: 5,
                  OUT_CN: 1,
                  BALL_CN: 2,
                  STRIKE_CN: 1,
                  SR_ID: "1",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // 선수 기록·박스스코어는 전부 실패 → lines/highlights 가 전부 null → empty:true.
        return new Response("upstream down", { status: 503 });
      }) as typeof fetch;

      try {
        const res = await contextualRoute.GET(ctxReq(`gameId=${gameId}`));
        const body = (await res.clone().json()) as {
          empty?: boolean;
          lines?: unknown;
          context?: { inning?: number };
        };
        // 매핑이 실패하면 조기 분기로 샤서 마지막 return 을 못 태운다 — 그것 자체를
        // 실패로 취급해야 픽스처가 썬 때 게이트가 조용히 약해지는 것을 막는다.
        assert.equal(res.status, 200, `기대 200, 실제 ${res.status}`);
        assert.equal(body.empty, true, "empty:true 경로 재현 실패(픽스처 stale)");
        // **최종 return 을 실제로 탔는지** 를 응답 내용으로 증명한다. 조기 emptyResponse
        // 분기는 lines 가 없거나 context.inning 이 rawGame 값을 반영하지 않는다.
        // 이 검사가 없으면 픽스처가 썬 때 조용히 앞 분기만 태우며 GREEN 이 된다.
        assert.equal(
          body.context?.inning,
          5,
          `최종 return 경로를 안 타고 조기 분기로 샐다(context.inning=${body.context?.inning})`,
        );
        assert.ok(
          body.lines !== undefined,
          "최종 return 경로가 아님 — lines 필드 부재",
        );
        assertNotCacheable(res, "contextual-stats 최종 return empty");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  console.log("\n[5] 삼순 NO-GO 2026-08-06 반영분");

  await check(
    "route 내부 TTL 과 엣지 TTL 이 단일 owner — drift 불가",
    async () => {
      const { readFileSync } = await import("node:fs");
      const src = readFileSync("src/app/api/game-relay/route.ts", "utf8");
      // 하드코딩된 리터럴(2_000 등)이면 한쪽만 바뀌는 drift 가 가능하다.
      // 반드시 엣지 TTL 상수에서 파생돼야 한다.
      const m = src.match(/const CACHE_TTL_MS = ([^;]+);/);
      assert.ok(m, "CACHE_TTL_MS 선언을 찾지 못함");
      assert.ok(
        /RELAY_EDGE_TTL_SECONDS/.test(m![1]),
        `CACHE_TTL_MS 가 엣지 TTL 상수에서 파생되지 않음: ${m![1].trim()} — 한쪽만 바뀌면 신선도 계약이 조용히 깨진다`,
      );
      // 값 자체도 실제로 일치하는지 런타임으로 확인한다(문자열 검사만으로는 부족).
      const relaySrcTtl = RELAY_EDGE_TTL_SECONDS * 1000;
      assert.equal(relaySrcTtl, 2000, `엣지 TTL 파생값 불일치: ${relaySrcTtl}`);
    },
  );

  await check(
    "cache HIT 는 남은 수명만큼만 엣지 TTL — route+edge 직렬 누적(age 2배) 차단",
    async () => {
      const { edgeCacheHeadersForRemaining } = await import("../../src/lib/http/live-cache");
      // 남은 수명이 full TTL 보다 짧으면 그만큼만 준다.
      const cc1 = parseCacheControl(
        new Response(null, { headers: edgeCacheHeadersForRemaining(1200, 2) }),
      );
      assert.equal(cc1.sMaxAge, 1, `남은 1.2초인데 s-maxage=${cc1.sMaxAge} (직렬 누적 발생)`);
      // 남은 수명이 1초 미만이면 캐시하지 않는다(반올림으로 상한 초과 방지).
      assertNotCacheable(
        new Response(null, { headers: edgeCacheHeadersForRemaining(400, 2) }),
        "남은 0.4초",
      );
      // 남은 수명이 TTL 보다 길어도 TTL 을 넘지 않는다.
      const cc3 = parseCacheControl(
        new Response(null, { headers: edgeCacheHeadersForRemaining(99_000, 2) }),
      );
      assert.equal(cc3.sMaxAge, 2, `TTL 상한 초과: ${cc3.sMaxAge}`);
      assertNotCacheable(
        new Response(null, { headers: edgeCacheHeadersForRemaining(0, 2) }),
        "남은 0",
      );
    },
  );

  await check(
    "actual cache HIT: 소비한 age 만큼 엣지 TTL 이 줄어든다(실 route GET, 실시간)",
    async () => {
      // ⚠️ age 가 0 인 즉시 HIT 은 full TTL 이 정상이다(총 age = 0 + 2s = 2s, 상한 내).
      //    그래서 실제로 시간을 흘려보내 age 를 소비시킨 뒤 s-maxage 가 따라 줄어드는지를 본다.
      //    이것이 "직렬 누적 차단" 의 진짜 계약이다.
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      installRelayUpstream({ currentInning: 6 });
      try {
        const first = await relayRoute.GET(makeReq("gameId=20260806AGEX1"));
        assert.equal(first.status, 200, "사전 상태 구성 실패");
        assert.equal(
          parseCacheControl(first).sMaxAge,
          RELAY_EDGE_TTL_SECONDS,
          "fresh 응답은 full TTL 이어야 함",
        );

        // ① 0.6초 소비 → 남은 ~1.4초 → s-maxage 는 1 로 줄어야 한다.
        await sleep(650);
        const midHit = await relayRoute.GET(makeReq("gameId=20260806AGEX1"));
        assert.equal(midHit.status, 200, `HIT 경로 200 아님: ${midHit.status}`);
        const midCc = parseCacheControl(midHit);
        assert.equal(
          midCc.sMaxAge,
          1,
          `0.65초 소비 후에도 s-maxage=${midCc.sMaxAge} — age 가 직렬 누적된다(총 상한 2배)`,
        );

        // ② 1.3초 소비 → 남은 0.7초(<1s) → 캐시 금지로 fail-close.
        await sleep(700);
        const lateHit = await relayRoute.GET(makeReq("gameId=20260806AGEX1"));
        assert.equal(lateHit.status, 200, `HIT 경로 200 아님: ${lateHit.status}`);
        assertNotCacheable(lateHit, "남은 수명 1초 미만 HIT");
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  await check(
    "game-live actual GET: upstream 실패 503 은 캐시 금지(traceHeaders 기본값 검증)",
    async () => {
      const liveRoute = await import("../../src/app/api/game-live/route");
      const { NextRequest: NR } = await import("next/server");
      // upstream 전부 실패시켜 fail-close 503 분기를 실제로 태운다.
      globalThis.fetch = (async () => {
        throw new Error("qa_forced_upstream_failure");
      }) as typeof fetch;
      try {
        const res = await liveRoute.GET(
          new NR(new URL("http://localhost/api/game-live?date=20260806")),
        );
        assert.ok(
          res.status >= 500,
          `upstream 전부 실패인데 ${res.status} — fail-close 분기를 안 탐(게이트 무효)`,
        );
        assertNotCacheable(res, `game-live ${res.status}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  await check(
    "부분열화 profile 은 1시간 캐시되지 않는다 — 다음 폴링 자가복구(actual)",
    async () => {
      // 삼순 NO-GO ②: loadProfile 이 부분열화 bundle 을 PROFILE_TTL(1h) 로 캐시하면
      // upstream 이 복구돼도 다음 폴링이 재조회하지 않아 유저 화면이 계속 빈다.
      // 소스 정규식이 아니라 **실제 실패 → 복구** 를 태워서 확인한다.
      // ⚠️ 픽스처 함정 2개를 실측으로 찾아 막았다(자기적발):
      //  ① 팀이 안 맞으면 매핑 결과가 엉켜 loadProfile 을 아예 안 타고 게이트가
      //     "fetch 0회" 로 조용히 통과한다 → away=LG(공격/타자) home=키움(수비/투수).
      //  ② 로스터에 있어도 `resolvePlayer` 가 null 을 주는 이름이 있다(동명이인 등).
      //     그 경우 loadProfile 이 호출되지 않는다 → **실제 resolve 되는 이름만** 쓴다.
      const roster = (await import("../../src/lib/constants/players-roster.json"))
        .default as Array<{ name: string; position: string; team: string; kboId: string }>;
      const { resolvePlayer } = await import("../../src/lib/utils/resolve-player");
      const isUsable = (p: { name: string; kboId: string }) =>
        /^[0-9]+$/.test(p.kboId) && resolvePlayer({ name: p.name }) !== null;
      const batterName = roster.find(
        (p) => p.team === "LG" && p.position !== "투수" && isUsable(p),
      )?.name;
      const pitcherName = roster.find(
        (p) => p.team === "키움" && p.position === "투수" && isUsable(p),
      )?.name;
      assert.ok(pitcherName && batterName, "로스터에서 resolve 가능한 테스트 선수를 찾지 못함");

      const gameId = "20260806HEAL1";
      let playerFetchOk = false;
      let playerFetchCount = 0;

      const makeGameList = () =>
        new Response(
          JSON.stringify({
            game: [{
              G_ID: gameId, GAME_STATE_SC: "2", AWAY_NM: "LG", HOME_NM: "키움",
              GAME_TB_SC: "T", T_P_NM: batterName, B_P_NM: pitcherName,
              GAME_INN_NO: 5, OUT_CN: 1, BALL_CN: 2, STRIKE_CN: 1, SR_ID: "1",
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("GetKboGameList")) return makeGameList();
        if (url.includes("HitterDetail") || url.includes("PitcherDetail")) {
          playerFetchCount++;
          if (!playerFetchOk) return new Response("down", { status: 503 });
          // ⚠️ **parser-valid** 마크업이어야 한다(삼순 NO-GO 5차).
          //    `<html>recovered</html>` 같은 더미는 basic=null·situation=빈 배열로
          //    떨어져 여전히 degraded → 재조회만 증명하고 실제 복구는 못 태운다.
          const isBatterPage = url.includes("HitterDetail");
          const isSituation = url.includes("Situation.aspx");
          const html = isBatterPage
            ? (isSituation ? hitterSituationHtml() : hitterBasicHtml())
            : (isSituation ? pitcherSituationHtml() : pitcherBasicHtml());
          return new Response(html, { status: 200 });
        }
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;

      try {
        // 1) 열화 상태로 1회 호출 → 부분열화 bundle 생성 + empty 응답
        const first = await contextualRoute.GET(ctxReq(`gameId=${gameId}`));
        const firstBody = (await first.json()) as { empty?: boolean };
        const afterFirst = playerFetchCount;
        assert.ok(afterFirst > 0, "선수 프로필 fetch 를 태우지 못함(픽스처 오류)");
        assert.equal(firstBody.empty, true, "열화 상태인데 empty 가 아님(픽스처 오류)");

        // 2) upstream 복구 후 재호출 → 재조회 + **정상 데이터 노출** 이어야 한다.
        playerFetchOk = true;
        await new Promise((r) => setTimeout(r, 3100)); // 짧은 재시도 TTL 경과
        const second = await contextualRoute.GET(ctxReq(`gameId=${gameId}`));
        const secondBody = (await second.json()) as {
          empty?: boolean;
          lines?: { vsHand?: unknown };
        };
        const afterSecond = playerFetchCount;

        assert.ok(
          afterSecond > afterFirst,
          `열화 bundle 이 캐시에 박혀 재조회가 없다(fetch ${afterFirst} → ${afterSecond}) — upstream 복구 후에도 유저 화면이 계속 빈다`,
        );
        // 재조회만으로는 부족하다 — 실제로 유저에게 값이 보여야 복구다.
        assert.equal(
          secondBody.empty,
          false,
          "재조회는 했지만 여전히 empty — 유저 화면은 그대로 비어 있다(복구 아님)",
        );
        assert.ok(
          secondBody.lines?.vsHand,
          "복구 후에도 vsHand 라인이 없다 — parser-valid 복구를 증명하지 못함",
        );

        // 3) 즉시 3차 폴링 — 추가 fetch 0(캐시 HIT).
        const third = await contextualRoute.GET(ctxReq(`gameId=${gameId}`));
        await third.json();
        assert.equal(
          playerFetchCount,
          afterSecond,
          `정상 bundle 이 캐시되지 않았다(fetch ${afterSecond} → ${playerFetchCount})`,
        );

        // 4) ⚠️ 3초를 더 흘린 뒤 4차 폴링 — 여기서도 fetch 0 이어야 **full TTL** 이다.
        //    3차만 보면 "3초 TTL"과 "1시간 TTL"이 구분되지 않아 검출력이 0이었다(자기적발:
        //    정상 bundle 을 3초만 캐시하는 mutation 이 GREEN 으로 통과했다).
        await new Promise((r) => setTimeout(r, 3100));
        const fourth = await contextualRoute.GET(ctxReq(`gameId=${gameId}`));
        await fourth.json();
        assert.equal(
          playerFetchCount,
          afterSecond,
          `정상 bundle 이 짧은 재시도 TTL 로 캐시됐다(3.1초 후 fetch ${afterSecond} → ${playerFetchCount}) — 복구 후에도 매 폴링이 upstream 을 두드린다`,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  await check(
    "fetch 200 인데 parse 실패도 열화로 본다 — 1시간 박제 금지(actual)",
    async () => {
      // 삼순 NO-GO ②의 나머지 절반: upstream 이 200 을 주더라도 마크업이 바뀌어
      // parser 가 값을 못 뽑으면 내용상 비어 있는 것이라 같은 열화다.
      // fetch 실패만 degraded 로 치면 이 경우가 1시간 캐시돼 복구가 막힌다.
      const roster = (await import("../../src/lib/constants/players-roster.json"))
        .default as Array<{ name: string; position: string; team: string; kboId: string }>;
      const { resolvePlayer } = await import("../../src/lib/utils/resolve-player");
      const isUsable = (p: { name: string; kboId: string }) =>
        /^[0-9]+$/.test(p.kboId) && resolvePlayer({ name: p.name }) !== null;
      // 앞 검사와 캐시 키가 겹치면 안 되므로 다른 선수를 고른다.
      const batters = roster.filter((p) => p.team === "LG" && p.position !== "투수" && isUsable(p));
      const pitchers = roster.filter((p) => p.team === "키움" && p.position === "투수" && isUsable(p));
      assert.ok(batters.length > 1 && pitchers.length > 1, "테스트 선수 부족");
      const batterName = batters[1].name;
      const pitcherName = pitchers[1].name;

      // ⚠️ G_ID 는 `/^\d{8}[A-Z]{4}\d$/` 를 만족해야 payload 가 파싱된다(실측).
      //    "PARSE1"(14자)·"PRS01"(영문4 아님) 둘 다 payload 를 null 로 떨어뜨려
      //    fetchLiveGame 이 조기 반환 → loadProfile 을 아예 안 타고 게이트가 죽었다.
      const gameId = "20260806PRSX1";
      let parseOk = false;
      let playerFetchCount = 0;

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("GetKboGameList")) {
          return new Response(JSON.stringify({ game: [{
            G_ID: gameId, GAME_STATE_SC: "2", AWAY_NM: "LG", HOME_NM: "키움",
            GAME_TB_SC: "T", T_P_NM: batterName, B_P_NM: pitcherName,
            GAME_INN_NO: 5, OUT_CN: 1, BALL_CN: 2, STRIKE_CN: 1, SR_ID: "1",
          }] }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("HitterDetail") || url.includes("PitcherDetail")) {
          playerFetchCount++;
          // ⚠️ 항상 **200**. 다만 parseOk 이전에는 parser 가 못 읽는 마크업이다.
          if (!parseOk) return new Response("<html><body>no tables here</body></html>", { status: 200 });
          const isBatterPage = url.includes("HitterDetail");
          const isSituation = url.includes("Situation.aspx");
          return new Response(
            isBatterPage
              ? (isSituation ? hitterSituationHtml() : hitterBasicHtml())
              : (isSituation ? pitcherSituationHtml() : pitcherBasicHtml()),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;

      try {
        const first = await contextualRoute.GET(ctxReq(`gameId=${gameId}`));
        const firstBody = (await first.json()) as { empty?: boolean };
        const afterFirst = playerFetchCount;
        assert.ok(afterFirst > 0, "선수 프로필 fetch 를 태우지 못함(픽스처 오류)");
        assert.equal(firstBody.empty, true, "parse 실패인데 empty 가 아님(픽스처 오류)");

        // 마크업 복구 후 재폴링 → 재조회 + 정상 노출이어야 한다.
        parseOk = true;
        await new Promise((r) => setTimeout(r, 3100));
        const second = await contextualRoute.GET(ctxReq(`gameId=${gameId}`));
        const secondBody = (await second.json()) as { empty?: boolean };

        assert.ok(
          playerFetchCount > afterFirst,
          `parse 실패 bundle 이 1시간 캐시에 박혔다(fetch ${afterFirst} → ${playerFetchCount}) — 마크업이 복구돼도 화면이 계속 빈다`,
        );
        assert.equal(
          secondBody.empty,
          false,
          "재조회했지만 여전히 empty — parse 복구가 반영되지 않음",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  await check(
    "game-live·contextual-stats 는 엣지 캐시 대상이 아니다 — 정상 200 도 no-store",
    async () => {
      // 삼순 NO-GO ①: 이 두 route 는 relay 와 달리 동등한 내부 TTL 이 없다.
      // s-maxage 를 새로 붙이면 점수·이닝·볼카운트가 그만큼 실제로 더 낡아진다
      // = "활성 유저 신선도 저하 0" 하드 제약 위반. 정상 200 을 실제로 태워 확인한다.
      const liveRoute = await import("../../src/app/api/game-live/route");
      const { NextRequest: NR } = await import("next/server");
      const gameId = "20260806FRSH1";
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("GetKboGameList")) {
          return new Response(
            JSON.stringify({
              game: [{
                G_ID: gameId, GAME_STATE_SC: "2", AWAY_NM: "LG", HOME_NM: "키움",
                GAME_TB_SC: "T", GAME_INN_NO: 5, OUT_CN: 1, BALL_CN: 2, STRIKE_CN: 1,
                SR_ID: "1", T_PIT_P_NM: "투수A", B_PIT_P_NM: "투수B",
              }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;
      try {
        const res = await liveRoute.GET(
          new NR(new URL("http://localhost/api/game-live?date=20260806")),
        );
        // 200 이든 503 이든 캐시는 금지다(신선도 계약).
        assertNotCacheable(res, `game-live ${res.status}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  await check(
    "엣지 캐시는 relay 에만 — 다른 라이브 route 에 s-maxage 재도입 금지(SSOT 계약)",
    async () => {
      const { readFileSync } = await import("node:fs");
      // 동등한 내부 TTL 이 없는 route 가 엣지 캐시 헬퍼를 import 하면 계약 위반이다.
      for (const path of [
        "src/app/api/game-live/route.ts",
        "src/app/api/contextual-stats/route.ts",
      ]) {
        // 주석은 제외한다 — 계약을 설명하는 주석에 s-maxage 라는 낱말이 나오는 것은
        // 위반이 아니다. 실제 코드에서 쓰는지만 본다.
        const src = readFileSync(path, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n")
          .filter((l) => !/^\s*\/\//.test(l))
          .join("\n");
        assert.ok(
          !/edgeCacheHeaders|liveCacheHeaders|s-maxage/.test(src),
          `${path}: 엣지 캐시 헬퍼/헤더를 씀 — 내부 TTL 이 없어 실제 신선도가 저하된다`,
        );
      }
      // relay 는 내부 TTL 이 있으므로 허용 대상이다(반대편 고정).
      const relaySrc = readFileSync("src/app/api/game-relay/route.ts", "utf8");
      assert.ok(
        /edgeCacheHeadersForRemaining/.test(relaySrc),
        "relay 가 엣지 캐시를 잃음 — 절감 효과가 사라진다",
      );
    },
  );

  await check("contextual-stats 가 캐시 헤더 SSOT 를 경유한다(직접 문자열 금지)", async () => {
    const { readFileSync } = await import("node:fs");
    for (const path of [
      "src/app/api/contextual-stats/route.ts",
      "src/app/api/game-relay/route.ts",
      "src/app/api/game-live/route.ts",
    ]) {
      const src = readFileSync(path, "utf8");
      assert.ok(
        src.includes("@/lib/http/live-cache"),
        `${path}: 캐시 헤더 SSOT 를 import 하지 않음`,
      );
      // 유일한 예외는 SSOT 모듈 자체. route 가 Cache-Control 을 직접 쓰면
      // 정책이 다시 흔어져 한 곳만 고치고 "적용 완료" 로 오판하게 된다.
      assert.ok(
        !/["'`]Cache-Control["'`]\s*:/.test(src),
        `${path}: Cache-Control 을 직접 생성함 — SSOT 헬퍼만 써야 함`,
      );
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
