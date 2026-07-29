// QA: fetchGames 의 Naver schedule/games 폴백 (슬라이스① KBO↔Naver 이중화).
// - mapNaverGameToKbo 순수 매핑(상태/스코어/이닝/gameId/teamId)
// - fetchGames 가 KBO fetch 실패 시 Naver 폴백으로 KboGame[] 반환
// - Naver fail-closed(success:false → throw), 경기 없는 날(games:[]) → 빈 배열
//
// supabase/admin 싱글톤이 모듈 로드 시 env를 요구한다. _smoke-env 가 더미 env를 선주입하므로
// 반드시 kbo-api 보다 먼저 import 되어야 한다(ESM 평가 순서).
import "./_smoke-env";
import assert from "node:assert/strict";
import { fetchGames } from "../../src/lib/crawler/kbo-api";
import { fetchNaverGames, mapNaverGameToKbo } from "../../src/lib/crawler/naver-games";

const DATE = "20260729";

function naverGame(overrides: Record<string, unknown> = {}) {
  return {
    gameDateTime: "2026-07-29T18:30:00",
    stadium: "대구",
    homeTeamCode: "SS",
    homeTeamName: "삼성",
    homeTeamScore: 0,
    awayTeamCode: "HT",
    awayTeamName: "KIA",
    awayTeamScore: 0,
    winner: "DRAW",
    statusCode: "READY",
    statusInfo: "경기전",
    cancel: false,
    suspended: false,
    reversedHomeAway: true,
    ...overrides,
  };
}

// ── 1. 순수 매퍼 ─────────────────────────────────────────────
{
  // READY → scheduled, score null, gameId = date+away+home+"0"(실측 순서), teamId 정상.
  const g = mapNaverGameToKbo(naverGame(), DATE);
  assert.equal(g.status, "scheduled");
  assert.equal(g.awayScore, null);
  assert.equal(g.homeScore, null);
  assert.equal(g.gameId, "20260729HTSS0"); // away=HT, home=SS
  assert.equal(g.homeName, "삼성");
  assert.equal(g.awayName, "KIA");
  assert.equal(g.homeTeamId, 8); // SS
  assert.equal(g.awayTeamId, 6); // HT
  assert.equal(g.time, "18:30");
  assert.equal(g.stadium, "대구");
  assert.equal(g.inning, 0);
  assert.equal(g.isTop, true);
  // graceful degradation
  assert.equal(g.strikes, 0);
  assert.equal(g.currentBatter, "");
  assert.deepEqual(g.runnersOn, { first: false, second: false, third: false });
  assert.equal(g.broadcastChannels, undefined);
}
{
  // STARTED → live, score 숫자, inning/isTop from statusInfo.
  const g = mapNaverGameToKbo(
    naverGame({ statusCode: "STARTED", statusInfo: "5회초", homeTeamScore: 3, awayTeamScore: 2 }),
    DATE,
  );
  assert.equal(g.status, "live");
  assert.equal(g.homeScore, 3);
  assert.equal(g.awayScore, 2);
  assert.equal(g.inning, 5);
  assert.equal(g.isTop, true);
}
{
  // RESULT → final, score 숫자, statusInfo "9회말" → isTop false.
  const g = mapNaverGameToKbo(
    naverGame({ statusCode: "RESULT", statusInfo: "9회말", homeTeamScore: 12, awayTeamScore: 5, winner: "HOME" }),
    DATE,
  );
  assert.equal(g.status, "final");
  assert.equal(g.homeScore, 12);
  assert.equal(g.awayScore, 5);
  assert.equal(g.inning, 9);
  assert.equal(g.isTop, false);
}
{
  // CANCEL / cancel:true → cancelled. score 는 status!=="scheduled" 귀칙으로 숫자(0) — KBO parseGame 과 동일.
  const gCode = mapNaverGameToKbo(naverGame({ statusCode: "CANCEL" }), DATE);
  assert.equal(gCode.status, "cancelled");
  assert.equal(gCode.homeScore, 0);
  const gFlag = mapNaverGameToKbo(naverGame({ statusCode: "READY", cancel: true }), DATE);
  assert.equal(gFlag.status, "cancelled");
  const gSusp = mapNaverGameToKbo(naverGame({ statusCode: "STARTED", suspended: true }), DATE);
  assert.equal(gSusp.status, "cancelled");
}

// ── fetch stub 헬퍼 ──────────────────────────────────────────
const realFetch = globalThis.fetch;
function stubFetch(handler: (url: string) => Promise<Response> | Response) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(handler(url));
  }) as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function main() {
// ── 2. fetchGames: KBO 실패 → Naver 폴백 ────────────────────
{
  stubFetch((url) => {
    if (url.includes("GetKboGameList")) throw new Error("KBO down");
    if (url.includes("api-gw.sports.naver.com/schedule/games")) {
      return jsonResponse({
        code: 200,
        success: true,
        result: { games: [naverGame({ statusCode: "STARTED", statusInfo: "3회말", homeTeamScore: 1, awayTeamScore: 0 })] },
      });
    }
    throw new Error(`unexpected url ${url}`);
  });
  const games = await fetchGames(DATE);
  restoreFetch();
  assert.equal(games.length, 1);
  assert.equal(games[0].status, "live");
  assert.equal(games[0].gameId, "20260729HTSS0");
  assert.equal(games[0].homeScore, 1);
  assert.equal(games[0].inning, 3);
  assert.equal(games[0].isTop, false);
}

// ── 3. Naver fail-closed: success:false → throw ─────────────
{
  stubFetch(() => jsonResponse({ code: 500, success: false, result: null }));
  await assert.rejects(fetchNaverGames(DATE), /sanity/);
  restoreFetch();
}

// ── 4. 경기 없는 날: games:[] → 빈 배열 정상 ─────────────────
{
  stubFetch(() => jsonResponse({ code: 200, success: true, result: { games: [] } }));
  const games = await fetchNaverGames(DATE);
  restoreFetch();
  assert.equal(games.length, 0);
}

console.log("✅ games-naver-fallback smoke passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
