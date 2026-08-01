/**
 * /api/team-records KBO HTML → Naver team statistics failover 회귀.
 * KBO hard-fail/partial 모두 Naver 10구단으로 복구하고, Naver partial/중복은 fail-close한다.
 *
 * 삼순 NO-GO 2건 회귀(RED→GREEN):
 *  - Blocker 1: KBO partial(200-empty/중복/필수값 결측)을 길이 10만으로 false-green 채택 → Naver 전환.
 *  - Blocker 2: KBO 5s + Naver 5s 직렬(5,004ms/10,004ms) → 공유 absolute deadline 으로 Naver reserve 확보·bound.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NextRequest } from "next/server";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "smoke-service-role-key";

const NAVER_TEAMS = [
  ["LG", "LG"],
  ["OB", "두산"],
  ["KT", "KT"],
  ["SK", "SSG"],
  ["NC", "NC"],
  ["HT", "KIA"],
  ["LT", "롯데"],
  ["SS", "삼성"],
  ["HH", "한화"],
  ["WO", "키움"],
] as const;

// KBO Record 표에 노출되는 팀명(shortName). blocker1 coverage 회귀용 HTML stub 에 사용.
const KBO_TEAM_NAMES = [
  "LG",
  "두산",
  "KT",
  "SSG",
  "NC",
  "KIA",
  "롯데",
  "삼성",
  "한화",
  "키움",
] as const;

function naverPayload(
  teams: readonly (readonly [string, string])[] = NAVER_TEAMS,
) {
  return {
    success: true,
    result: {
      seasonTeamStats: teams.map(([teamId, teamName], index) => ({
        teamId,
        teamName,
        offenseHra: 0.25 + index / 1000,
        offenseOps: 0.7 + index / 1000,
        offenseHr: 50 + index,
        offenseRun: 300 + index,
        offenseSb: 40 + index,
        offenseAb: 1000,
        offenseHit: 250 + index,
        defenseEra: 3.5 + index / 100,
        defenseWhip: 1.2 + index / 100,
        defenseKk: 500 + index,
        defenseSave: 20 + index,
        defenseHr: 60 + index,
        defenseInning: 900,
        defenseEr: 350 + index,
        defenseHit: 800 + index,
        gameCount: 100,
      })),
    },
  };
}

// ── KBO HTML 표 stub (실 컬럼 인덱스 준수) ────────────────────────────────
function htmlTable(rows: string[][]): string {
  const trs = rows
    .map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("");
  return `<table><tbody>${trs}</tbody></table>`;
}
const EMPTY_TABLE = "<table><tbody></tbody></table>";

// Hitter Basic1: 팀명(1) AVG(2) R(6) HR(10)
function hitterBasic1(names: readonly string[]): string {
  return htmlTable(
    names.map((n, i) => [
      `${i + 1}`,
      n,
      ".280",
      "144",
      "5000",
      "4400",
      "700",
      "1200",
      "200",
      "20",
      "150",
      "1800",
      "680",
      "30",
      "40",
    ]),
  );
}
// Hitter Basic2: 팀명(1) OPS(10)
function hitterBasic2(names: readonly string[]): string {
  return htmlTable(
    names.map((n, i) => [
      `${i + 1}`,
      n,
      ".280",
      "400",
      "5",
      "50",
      "900",
      "100",
      ".450",
      ".360",
      ".810",
    ]),
  );
}
// Runner Basic: 팀명(1) SB(4)
function runnerBasic(names: readonly string[]): string {
  return htmlTable(names.map((n, i) => [`${i + 1}`, n, ".280", "30", "88"]));
}
// Pitcher Basic1: 팀명(1) ERA(2) SV(6) IP(9) HR(11) SO(14) WHIP(17)
function pitcherBasic1(names: readonly string[]): string {
  return htmlTable(
    names.map((n, i) => [
      `${i + 1}`,
      n,
      "3.80",
      "144",
      "72",
      "60",
      "35",
      "20",
      ".560",
      "1290 1/3",
      "1200",
      "110",
      "480",
      "55",
      "1050",
      "560",
      "540",
      "1.35",
    ]),
  );
}

type KboVariant =
  | "full"
  | "hitterBasic1Empty"
  | "hitterBasic2Empty"
  | "runnerEmpty"
  | "pitcherEmpty"
  | "duplicate"
  | "requiredMissing";

/** URL 로 KBO 표를 분기해 응답하는 fetch stub. variant 로 200-empty/중복 결함 주입. */
function kboFetchStub(variant: KboVariant = "full"): typeof fetch {
  const dupNames = ["LG", ...KBO_TEAM_NAMES.slice(1, 9), "LG"]; // 10행·unique 9(키움 결손+LG 중복)
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    let body: string;
    if (url.includes("/Hitter/Basic1")) {
      body =
        variant === "hitterBasic1Empty"
          ? EMPTY_TABLE
          : hitterBasic1(variant === "duplicate" ? dupNames : KBO_TEAM_NAMES);
      if (variant === "requiredMissing")
        body = body.replace("<td>.280</td>", "<td></td>");
    } else if (url.includes("/Hitter/Basic2")) {
      body =
        variant === "hitterBasic2Empty"
          ? EMPTY_TABLE
          : hitterBasic2(KBO_TEAM_NAMES);
    } else if (url.includes("/Runner/Basic")) {
      body =
        variant === "runnerEmpty" ? EMPTY_TABLE : runnerBasic(KBO_TEAM_NAMES);
    } else if (url.includes("/Pitcher/Basic1")) {
      body =
        variant === "pitcherEmpty"
          ? EMPTY_TABLE
          : pitcherBasic1(KBO_TEAM_NAMES);
    } else {
      return new Response("not found", { status: 404 });
    }
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

/** signal-aware 무한 stall(hard-hang). AbortSignal 이 뜨면 reject, 아니면 영원히 pending. */
function stallFetch(): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted)
          return reject(new DOMException("Aborted", "AbortError"));
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }
    })) as unknown as typeof fetch;
}

function bodyStallFetch(kind: "text" | "json"): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    [kind]: () => new Promise<never>(() => {}),
  })) as unknown as typeof fetch;
}

function statusFetch(status: number, jsonBody?: unknown): typeof fetch {
  return (async () =>
    new Response(
      status === 204 ? null : jsonBody != null ? JSON.stringify(jsonBody) : "",
      { status },
    )) as unknown as typeof fetch;
}

/** URL 분기: KBO 는 status, Naver 는 별도 처리. GET 캐시 게이트용 global fetch stub. */
function routedFetch(kbo: typeof fetch, naver: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return url.includes("api-gw.sports.naver.com")
      ? naver(input, init)
      : kbo(input, init);
  }) as unknown as typeof fetch;
}

async function main() {
  const route = await import("../../src/app/api/team-records/route");
  const { loadTeamRecords, mapNaverTeamRecords, fetchKboTeamRecords, GET } =
    route;

  const mapped = mapNaverTeamRecords(naverPayload(), 2026);
  assert.equal(mapped.batting.length, 10);
  assert.equal(mapped.pitching.length, 10);
  assert.equal(new Set(mapped.batting.map((row) => row.teamId)).size, 10);
  assert.deepEqual(mapped.batting[0], {
    teamId: 1,
    slug: "lg",
    avg: ".250",
    ops: "0.700",
    hr: 50,
    runs: 300,
    sb: 40,
    games: 100,
    ab: 1000,
    hits: 250,
  });
  assert.deepEqual(mapped.pitching[0], {
    teamId: 1,
    slug: "lg",
    era: "3.50",
    whip: "1.20",
    so: 500,
    sv: 20,
    hra: 60,
    games: 100,
    inningsOuts: 2700,
    er: 350,
    hitsAllowed: 800,
  });

  const kboData = { batting: mapped.batting, pitching: mapped.pitching };
  let naverCalls = 0;
  const naverOk = async () => {
    naverCalls += 1;
    return mapped;
  };

  const primary = await loadTeamRecords(2026, async () => kboData, naverOk);
  assert.deepEqual(primary, { season: 2026, ...kboData });
  assert.equal(naverCalls, 0, "KBO 정상 시 Naver 미호출");

  const hardFail = await loadTeamRecords(
    2026,
    async () => {
      throw new Error("KBO HTTP 503");
    },
    naverOk,
  );
  assert.equal(hardFail.batting.length, 10);

  const partial = await loadTeamRecords(
    2026,
    async () => ({
      batting: mapped.batting.slice(0, 9),
      pitching: mapped.pitching,
    }),
    naverOk,
  );
  assert.equal(partial.pitching.length, 10);
  assert.equal(naverCalls, 2, "hard-fail + partial 각각 Naver 1회");

  assert.throws(
    () => mapNaverTeamRecords(naverPayload(NAVER_TEAMS.slice(0, 9)), 2026),
    /schema invalid/,
    "Naver partial fail-close",
  );
  assert.throws(
    () =>
      mapNaverTeamRecords(
        naverPayload([...NAVER_TEAMS.slice(0, 9), NAVER_TEAMS[0]]),
        2026,
      ),
    /incomplete team data/,
    "Naver duplicate fail-close",
  );
  const incompleteNaver = naverPayload();
  incompleteNaver.result.seasonTeamStats[0].defenseWhip = Number.NaN;
  assert.throws(
    () => mapNaverTeamRecords(incompleteNaver, 2026),
    /incomplete team data/,
    "Naver 필수값 결측 fail-close",
  );

  // ── Blocker 1: KBO partial(coverage/필수값) false-green 방지 ──────────────
  // 정상 KBO HTML 은 Naver 없이 그대로 채택.
  naverCalls = 0;
  const kboNormal = await loadTeamRecords(
    2026,
    (d) => fetchKboTeamRecords(d, kboFetchStub("full")),
    naverOk,
  );
  assert.equal(kboNormal.batting.length, 10);
  assert.equal(new Set(kboNormal.batting.map((r) => r.teamId)).size, 10);
  assert.equal(kboNormal.pitching[0].inningsOuts, 3871, "KBO fractional IP 전용 파서");
  assert.equal(naverCalls, 0, "정상 KBO HTML → Naver 미호출");

  const venueRouteSource = readFileSync(
    resolve(process.cwd(), "src/app/api/me/venue-stats/route.ts"),
    "utf8",
  );
  assert.match(venueRouteSource, /loadCachedTeamRecords\(requestedSeason\)/);
  assert.match(venueRouteSource, /teamRecords,\s*favoriteIds:/);
  assert.match(
    venueRouteSource,
    /teamSeasonTotals:\s*currentBaselines\?\.teamSeasonTotals\s*\?\?\s*null/,
  );

  const partialVariants: KboVariant[] = [
    "hitterBasic1Empty",
    "hitterBasic2Empty",
    "runnerEmpty",
    "pitcherEmpty",
    "duplicate",
    "requiredMissing",
  ];
  for (const variant of partialVariants) {
    const before = naverCalls;
    const res = await loadTeamRecords(
      2026,
      (d) => fetchKboTeamRecords(d, kboFetchStub(variant)),
      naverOk,
    );
    assert.equal(res.batting.length, 10, `${variant} → Naver 10구단 복구`);
    assert.equal(
      naverCalls,
      before + 1,
      `KBO ${variant} partial → Naver 전환(false-green 방지)`,
    );
  }
  // 503(HTTP 하드실패)도 Naver 전환.
  {
    const before = naverCalls;
    const res = await loadTeamRecords(
      2026,
      (d) => fetchKboTeamRecords(d, statusFetch(503)),
      naverOk,
    );
    assert.equal(res.batting.length, 10);
    assert.equal(naverCalls, before + 1, "KBO 503 → Naver 전환");
  }
  {
    const before = naverCalls;
    const res = await loadTeamRecords(
      2026,
      (d) => fetchKboTeamRecords(d, statusFetch(204)),
      naverOk,
    );
    assert.equal(res.batting.length, 10);
    assert.equal(naverCalls, before + 1, "KBO 204 → Naver 전환");
  }

  // ── Blocker 2: 공유 absolute deadline / Naver reserve (5,004ms/10,004ms bound) ──
  // KBO hang + Naver 정상: KBO sub-budget(~1.5s) 안에 끊고 Naver 로 승계(직렬 5,004ms 제거).
  {
    const t0 = Date.now();
    const res = await loadTeamRecords(
      2026,
      (d) => fetchKboTeamRecords(d, stallFetch()),
      naverOk,
    );
    const elapsed = Date.now() - t0;
    assert.equal(res.batting.length, 10, "KBO hang → Naver 복구");
    assert.ok(
      elapsed < 2500,
      `KBO hang→Naver reserve 확보 elapsed=${elapsed}ms (<2500, RED old≈5004ms)`,
    );
    console.log(`  [blocker2] KBO hang → Naver reserve elapsed=${elapsed}ms`);
  }
  // KBO 200 response 뒤 body stall도 동일 KBO sub-budget 안에 끊고 Naver로 복구.
  {
    const t0 = Date.now();
    const res = await loadTeamRecords(
      2026,
      (d) => fetchKboTeamRecords(d, bodyStallFetch("text")),
      naverOk,
    );
    const elapsed = Date.now() - t0;
    assert.equal(res.batting.length, 10, "KBO body stall → Naver 복구");
    assert.ok(elapsed < 2500, `KBO body stall elapsed=${elapsed}ms`);
  }
  // dual-hang: KBO+Naver 모두 stall → absolute deadline 안에 결정적 fail-close.
  {
    const t0 = Date.now();
    await assert.rejects(
      loadTeamRecords(
        2026,
        (d) => fetchKboTeamRecords(d, stallFetch()),
        async (_year, deadlineAt) => {
          // Naver 도 stall: 실제 fetchNaverTeamRecords 를 통해 deadline race 검증.
          return route.fetchNaverTeamRecords(2026, deadlineAt, stallFetch());
        },
      ),
      "dual-hang fail-close",
    );
    const elapsed = Date.now() - t0;
    assert.ok(
      elapsed < 3800,
      `dual-hang absolute deadline elapsed=${elapsed}ms (<3800, RED old≈10004ms)`,
    );
    console.log(
      `  [blocker2] dual-hang absolute deadline elapsed=${elapsed}ms`,
    );
  }
  // KBO response stall 뒤 Naver 200 response/body stall도 공유 absolute deadline 내 종료.
  {
    const t0 = Date.now();
    await assert.rejects(
      loadTeamRecords(
        2026,
        (d) => fetchKboTeamRecords(d, stallFetch()),
        (_year, deadlineAt) =>
          route.fetchNaverTeamRecords(2026, deadlineAt, bodyStallFetch("json")),
      ),
      "Naver body stall fail-close",
    );
    assert.ok(Date.now() - t0 < 3800, "Naver body stall absolute deadline");
  }

  // ── 캐시 정책: 캐시 없음 dual-fail→오류 / 프라임 후 dual-fail→stale 서빙 ──
  const originalFetch = globalThis.fetch;
  const mkReq = (): NextRequest =>
    ({
      nextUrl: new URL("http://localhost/api/team-records?season=2026"),
    }) as unknown as NextRequest;
  try {
    // 캐시 없음 + dual-fail(KBO 503, Naver 503) → 500.
    globalThis.fetch = routedFetch(statusFetch(503), statusFetch(503));
    const noCache = await GET(mkReq());
    assert.equal(noCache.status, 500, "캐시 없음 dual-fail → 500");

    // 프라임: KBO 503 → Naver 200 정상 → 캐시 채움.
    globalThis.fetch = routedFetch(
      statusFetch(503),
      statusFetch(200, naverPayload()),
    );
    const primed = await GET(mkReq());
    assert.equal(primed.status, 200, "Naver 복구 → 200 프라임");

    // 캐시 있음 + dual-fail → stale 서빙(200, s-maxage=60).
    globalThis.fetch = routedFetch(statusFetch(503), statusFetch(503));
    const realNow = Date.now;
    let stale!: Response;
    try {
      Date.now = () => realNow() + 31 * 60 * 1000;
      stale = await GET(mkReq());
    } finally {
      Date.now = realNow;
    }
    assert.equal(stale.status, 200, "캐시 있음 dual-fail → stale 서빙");
    assert.match(
      stale.headers.get("Cache-Control") ?? "",
      /s-maxage=60/,
      "stale 응답 캐시 헤더",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("team-records Naver failover smoke: ALL assertions PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
