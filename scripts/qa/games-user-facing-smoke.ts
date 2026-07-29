// QA: 유저 대면 하이브리드 경기목록 (슬라이스①.5) — Naver primary + KBO enrich.
// - mergeKboEnrichment: 순수 병합(스코어/이닝=Naver, BSO/주자/투타/선발/랭크=KBO, live 게이트)
// - fetchGamesUserFacing: Naver ok+KBO ok 병합 / KBO blackhole→Naver 베이스 bounded /
//   Naver 빈+KBO 있음→KBO 안전망 / Naver 실패→KBO 폴백 / 둘 다 실패→throw
import "./_smoke-env";
import assert from "node:assert/strict";
import { mergeKboEnrichment, fetchGamesUserFacing, KBO_ENRICH_TIMEOUT_MS, USER_FACING_NAVER_TIMEOUT_MS } from "../../src/lib/crawler/games-user-facing";
import { mapNaverGameToKbo } from "../../src/lib/crawler/naver-games";
import type { KboGame } from "../../src/lib/crawler/kbo-api";
import { GET as gamesRouteGET } from "../../src/app/api/games/route";

const DATE = "20260729";

function naverGame(overrides: Record<string, unknown> = {}) {
  return {
    gameId: "20260729HTSS02026",
    gameDateTime: "2026-07-29T18:30:00",
    stadium: "대구",
    homeTeamCode: "SS", homeTeamName: "삼성", homeTeamScore: 1,
    awayTeamCode: "HT", awayTeamName: "KIA", awayTeamScore: 2,
    statusCode: "STARTED", statusInfo: "5회초",
    cancel: false, suspended: false,
    ...overrides,
  };
}
function kboRaw(overrides: Record<string, unknown> = {}) {
  return {
    G_ID: "20260729HTSS0", G_DT: "20260729", G_TM: "18:30", S_NM: "대구",
    AWAY_ID: "HT", AWAY_NM: "KIA", HOME_ID: "SS", HOME_NM: "삼성",
    GAME_STATE_SC: "2", CANCEL_SC_ID: "0", GAME_TB_SC: "T", GAME_INN_NO: 5,
    T_SCORE_CN: "2", B_SCORE_CN: "1", STRIKE_CN: 2, BALL_CN: 1, OUT_CN: 1,
    B1_BAT_ORDER_NO: 3, T_P_NM: "타자김", B_P_NM: "투수리",
    T_PIT_P_NM: "선발KIA", B_PIT_P_NM: "선발삼성", T_RANK_NO: 3, B_RANK_NO: 5,
    ...overrides,
  };
}
function kboGame(overrides: Record<string, unknown> = {}): KboGame {
  // parseGame 을 태우기 위해 fetchKboGamesOnly 를 stub 으로 통과시키는 대신, mergeKboEnrichment
  // 순수 테스트는 KboGame 을 직접 만든다.
  return {
    gameId: "20260729HTSS0", date: DATE, time: "18:30", stadium: "대구",
    awayTeamId: 6, homeTeamId: 8, awayName: "KIA", homeName: "삼성",
    awayScore: 2, homeScore: 1, inning: 5, isTop: true, status: "live",
    awayStarterName: "선발KIA", homeStarterName: "선발삼성",
    winPitcher: "", losePitcher: "", savePitcher: "",
    strikes: 2, balls: 1, outs: 1,
    runnersOn: { first: true, second: false, third: false },
    currentPitcher: "투수리", currentBatter: "타자김",
    awayRank: 3, homeRank: 5, broadcastChannels: undefined,
    ...overrides,
  } as KboGame;
}

// ── 1. mergeKboEnrichment: live 경기 → BSO/주자/투타/선발/랭크 KBO 오버레이, 스코어/이닝 Naver 유지 ──
{
  const base = mapNaverGameToKbo(naverGame(), DATE); // live 2:1 5T, BSO 0
  assert.equal(base.strikes, 0); assert.equal(base.currentBatter, ""); // Naver 는 degrade
  const merged = mergeKboEnrichment([base], [kboGame()]);
  assert.equal(merged.length, 1);
  const m = merged[0];
  // 스코어/이닝/상태 = Naver(primary)
  assert.equal(m.awayScore, 2); assert.equal(m.homeScore, 1); assert.equal(m.inning, 5); assert.equal(m.isTop, true); assert.equal(m.status, "live");
  // BSO/주자/투타 = KBO enrich
  assert.equal(m.strikes, 2); assert.equal(m.balls, 1); assert.equal(m.outs, 1);
  assert.equal(m.runnersOn.first, true);
  assert.equal(m.currentBatter, "타자김"); assert.equal(m.currentPitcher, "투수리");
  // 선발/랭크 = KBO
  assert.equal(m.awayStarterName, "선발KIA"); assert.equal(m.awayRank, 3); assert.equal(m.homeRank, 5);
}
// ── 2. 매칭 KBO 없음 → base 그대로 ──
{
  const base = mapNaverGameToKbo(naverGame(), DATE);
  const merged = mergeKboEnrichment([base], []);
  assert.deepEqual(merged[0], base);
}
// ── 3. 종료 경기 → BSO 오버레이 안 함(live 게이트), 단 선발/승패투/랭크는 채움 ──
{
  const base = mapNaverGameToKbo(naverGame({ statusCode: "RESULT", statusInfo: "9회말", awayTeamScore: 3, homeTeamScore: 7 }), DATE);
  const k = kboGame({ status: "final", strikes: 3, balls: 2, outs: 2, winPitcher: "승리투수", awayRank: 1, homeRank: 2, runnersOn: { first: true, second: true, third: true } });
  const m = mergeKboEnrichment([base], [k])[0];
  assert.equal(m.status, "final");
  assert.equal(m.strikes, 0); assert.equal(m.runnersOn.first, false); // BSO/주자 오버레이 안 함
  assert.equal(m.winPitcher, "승리투수"); assert.equal(m.awayRank, 1); // 선발/승패투/랭크는 채움
}
// ── 4. Naver live 인데 KBO 가 scheduled(불일치) → BSO 오버레이 안 함 ──
{
  const base = mapNaverGameToKbo(naverGame(), DATE); // live
  const k = kboGame({ status: "scheduled", strikes: 2, balls: 3, outs: 1 });
  const m = mergeKboEnrichment([base], [k])[0];
  assert.equal(m.strikes, 0); assert.equal(m.balls, 0); // 양쪽 live 아니면 미오버레이
}
// ── 4b. 이닝/스코어 불일치(Naver 6회초 3:1 + KBO 5회말 2:1) → BSO/현재타자 오버레이 안 함(삼순 P1) ──
{
  const base = mapNaverGameToKbo(naverGame({ statusInfo: "6회초", awayTeamScore: 3, homeTeamScore: 1 }), DATE); // 6T 3:1 live
  const k = kboGame({ status: "live", inning: 5, isTop: false, awayScore: 2, homeScore: 1, strikes: 2, balls: 3, outs: 1, currentBatter: "옷타자", runnersOn: { first: true, second: true, third: true } });
  const m = mergeKboEnrichment([base], [k])[0];
  assert.equal(m.inning, 6); assert.equal(m.isTop, true); assert.equal(m.awayScore, 3); // Naver 체간
  assert.equal(m.strikes, 0); assert.equal(m.currentBatter, ""); // 불일치 → KBO 옷값 미혼입
  assert.equal(m.runnersOn.first, false);
}
// ── 4c. 정확히 같은 라이브 순간(이닝/초말/스코어 일치) → BSO 오버레이 함 ──
{
  const base = mapNaverGameToKbo(naverGame(), DATE); // 5T 2:1 live
  const k = kboGame({ inning: 5, isTop: true, awayScore: 2, homeScore: 1, strikes: 2, balls: 1, outs: 1 });
  const m = mergeKboEnrichment([base], [k])[0];
  assert.equal(m.strikes, 2); assert.equal(m.currentBatter, "타자김"); // 일치 → 오버레이
}
// ── 4d. KBO-only 경기(Naver 부분목록) union 보존 + DH dedupe(삼순 P1) ──
{
  const base = mapNaverGameToKbo(naverGame(), DATE); // 20260729HTSS0
  const kSame = kboGame(); // 20260729HTSS0 (Naver 와 동일)
  const kOnly = kboGame({ gameId: "20260729LTOB0", awayName: "롯데", homeName: "두산" }); // KBO-only
  const merged = mergeKboEnrichment([base], [kSame, kOnly]);
  assert.equal(merged.length, 2); // Naver 1 + KBO-only 1 union
  assert.deepEqual(merged.map((g) => g.gameId).sort(), ["20260729HTSS0", "20260729LTOB0"]);
  // DH dedupe: 동일 gameId 가 Naver·KBO 양쪽에 있어도 중복 안 됨
  const dh1 = mapNaverGameToKbo(naverGame({ gameId: "20260729HTSS12026" }), DATE);
  const dh2 = mapNaverGameToKbo(naverGame({ gameId: "20260729HTSS22026" }), DATE);
  const mDh = mergeKboEnrichment([dh1, dh2], [kboGame({ gameId: "20260729HTSS1" }), kboGame({ gameId: "20260729HTSS2" })]);
  assert.equal(mDh.length, 2);
  assert.equal(new Set(mDh.map((g) => g.gameId)).size, 2);
}
// ── 4e. KBO 내부 중복 gameId(upstream 부분열화/중복 응답) → union dedupe (삼순 3차 P1) ──
{
  const base = mapNaverGameToKbo(naverGame(), DATE); // HTSS0
  // KBO: HTSS0(overlap) + LTOB0 ×2(내부 중복)
  const merged = mergeKboEnrichment([base], [
    kboGame(),
    kboGame({ gameId: "20260729LTOB0" }),
    kboGame({ gameId: "20260729LTOB0" }),
  ]);
  const uniq = new Set(merged.map((g) => g.gameId)).size;
  assert.equal(merged.length, uniq); // result.length === unique gameId size
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((g) => g.gameId).sort(), ["20260729HTSS0", "20260729LTOB0"]);
}

// ── fetch stub 헬퍼 ──
const realFetch = globalThis.fetch;
function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
}
function restoreFetch() { globalThis.fetch = realFetch; }
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
function kboListText(games: unknown[]): Response {
  return new Response(JSON.stringify({ game: games }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function main() {
const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout unref 함정 대응(#952 교훈)

// ── 5. Naver ok + KBO ok → 병합(BSO=KBO, 스코어=Naver) ──
{
  stubFetch((url) => {
    if (url.includes("GetKboGameList")) return kboListText([kboRaw()]);
    if (url.includes("schedule/games")) return jsonResponse({ code: 200, success: true, result: { games: [naverGame()] } });
    throw new Error(`unexpected ${url}`);
  });
  const games = await fetchGamesUserFacing(DATE);
  restoreFetch();
  assert.equal(games.length, 1);
  assert.equal(games[0].awayScore, 2);      // Naver primary
  assert.equal(games[0].strikes, 2);         // KBO enrich
  assert.equal(games[0].currentBatter, "타자김");
  assert.equal(games[0].awayRank, 3);
}

// ── 6. Naver ok + KBO blackhole(abort) → Naver 베이스(BSO degrade), bounded ──
{
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("GetKboGameList")) {
      return new Promise<Response>((_res, rej) => {
        const s = init?.signal;
        if (s) { if (s.aborted) return rej(new DOMException("aborted", "AbortError")); s.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")), { once: true }); }
      });
    }
    if (url.includes("schedule/games")) return Promise.resolve(jsonResponse({ code: 200, success: true, result: { games: [naverGame()] } }));
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const t0 = Date.now();
  const games = await fetchGamesUserFacing(DATE);
  const elapsed = Date.now() - t0;
  restoreFetch();
  assert.ok(elapsed < KBO_ENRICH_TIMEOUT_MS + 1500, `bounded 실패: ${elapsed}ms`);
  assert.equal(games.length, 1);
  assert.equal(games[0].awayScore, 2);   // Naver 스코어는 있음
  assert.equal(games[0].strikes, 0);      // KBO 죽어 BSO degrade
  assert.equal(games[0].status, "live");
}

// ── 7. Naver 빈 + KBO 에 경기 있음 → KBO 사용(Naver 오탐 안전망) ──
{
  stubFetch((url) => {
    if (url.includes("GetKboGameList")) return kboListText([kboRaw()]);
    if (url.includes("schedule/games")) return jsonResponse({ code: 200, success: true, result: { games: [] } });
    throw new Error(`unexpected ${url}`);
  });
  const games = await fetchGamesUserFacing(DATE);
  restoreFetch();
  assert.equal(games.length, 1);
  assert.equal(games[0].strikes, 2); // KBO full data
}

// ── 8. Naver 실패 + KBO ok → KBO 폴백(full data) ──
{
  stubFetch((url) => {
    if (url.includes("GetKboGameList")) return kboListText([kboRaw()]);
    if (url.includes("schedule/games")) return jsonResponse({ code: 500, success: false, result: null });
    throw new Error(`unexpected ${url}`);
  });
  const games = await fetchGamesUserFacing(DATE);
  restoreFetch();
  assert.equal(games.length, 1);
  assert.equal(games[0].strikes, 2);
  assert.equal(games[0].currentBatter, "타자김");
}

// ── 9. Naver 실패 + KBO 실패 → throw ──
{
  stubFetch((url) => {
    if (url.includes("GetKboGameList")) return new Response("nope", { status: 503 });
    if (url.includes("schedule/games")) return jsonResponse({ code: 500, success: false, result: null });
    throw new Error(`unexpected ${url}`);
  });
  await assert.rejects(fetchGamesUserFacing(DATE));
  restoreFetch();
}

// ── 10. 무경기일: Naver [] + KBO [] → [] ──
{
  stubFetch((url) => {
    if (url.includes("GetKboGameList")) return kboListText([]);
    if (url.includes("schedule/games")) return jsonResponse({ code: 200, success: true, result: { games: [] } });
    throw new Error(`unexpected ${url}`);
  });
  const games = await fetchGamesUserFacing(DATE);
  restoreFetch();
  assert.equal(games.length, 0);
}

// ── 11. P0(삼순): Naver blackhole + 건강한 KBO → KBO 폴백을 Naver budget 안에 bounded 반환 ──
{
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("schedule/games")) {
      return new Promise<Response>((_res, rej) => {
        const s = init?.signal;
        if (s) { if (s.aborted) return rej(new DOMException("aborted", "AbortError")); s.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")), { once: true }); }
      });
    }
    if (url.includes("GetKboGameList")) return Promise.resolve(kboListText([kboRaw()]));
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const t0 = Date.now();
  const games = await fetchGamesUserFacing(DATE);
  const elapsed = Date.now() - t0;
  restoreFetch();
  // 기본 Naver 5s 면 elapsed≈5s → 이 assert 실패. user-facing Naver budget(2s) 사용 증명.
  assert.ok(elapsed < USER_FACING_NAVER_TIMEOUT_MS + 1200, `Naver-down bounded 실패: ${elapsed}ms`);
  assert.equal(games.length, 1);
  assert.equal(games[0].strikes, 2); // KBO 폴백 full data
}

// ── 12. P0(삼순): actual GET /api/games — Naver blackhole + KBO 정상 → bounded 200 ──
{
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("schedule/games")) {
      return new Promise<Response>((_res, rej) => {
        const s = init?.signal;
        if (s) { if (s.aborted) return rej(new DOMException("aborted", "AbortError")); s.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")), { once: true }); }
      });
    }
    if (url.includes("GetKboGameList")) return Promise.resolve(kboListText([kboRaw()]));
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const req = { nextUrl: new URL("http://localhost/api/games?date=20260729") } as unknown as Parameters<typeof gamesRouteGET>[0];
  const t0 = Date.now();
  const res = await gamesRouteGET(req);
  const elapsed = Date.now() - t0;
  restoreFetch();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(elapsed < USER_FACING_NAVER_TIMEOUT_MS + 1200, `route Naver-down bounded 실패: ${elapsed}ms`);
  assert.equal(body.count, 1);
  assert.equal(body.games[0].strikes, 2); // KBO full data
}

clearInterval(keepAlive);
console.log("✅ games-user-facing smoke passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
