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
import { fetchNaverGames, mapNaverGameToKbo, extractGameSeq } from "../../src/lib/crawler/naver-games";
import { fetchHomeLiveGames } from "../../src/lib/crawler/home-live-games";

const DATE = "20260729";

function naverGame(overrides: Record<string, unknown> = {}) {
  return {
    gameId: "20260729HTSS02026",
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
// ── 5. extractGameSeq: 더블헤더 회차 보존 + 올스타/말포머드 클램프 (P0) ───
{
  assert.equal(extractGameSeq("20260729HTSS02026"), "0"); // 단일경기
  assert.equal(extractGameSeq("20240623KTLG12024"), "1"); // DH 1차
  assert.equal(extractGameSeq("20240623KTLG22024"), "2"); // DH 2차
  assert.equal(extractGameSeq("20260706HTSS09999"), "0"); // 올스타(연도접미 9999, 회차 0)
  assert.equal(extractGameSeq("20260706HTSS9999"), "0");  // 회차 자리 결측+9999 → 오인식 방지 "0"
  assert.equal(extractGameSeq(undefined), "0");
  assert.equal(extractGameSeq(""), "0");
}
// ── 6. DH 두 경기가 고유 gameId 로 분리되는가 (P0: 해시/캐시/알림 키 충돌 방지) ───
{
  const dh1 = mapNaverGameToKbo(naverGame({ gameId: "20240623HTSS12024", statusCode: "RESULT", statusInfo: "9회말" }), DATE);
  const dh2 = mapNaverGameToKbo(naverGame({ gameId: "20240623HTSS22024", statusCode: "READY", statusInfo: "경기전" }), DATE);
  assert.equal(dh1.gameId, `${DATE}HTSS1`);
  assert.equal(dh2.gameId, `${DATE}HTSS2`);
  assert.notEqual(dh1.gameId, dh2.gameId);
}

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
// Node 의 AbortSignal.timeout() 타이머는 unref 라 순수 promise mock 만 남으면 이벤트루프가
// abort 전에 비어 조기 종료한다(PR #952 교훈). refed keepAlive 로 테스트 종료까지 루프 유지.
const keepAlive = setInterval(() => {}, 1000);
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

// ── 7. 통합 P1: KBO throw + Naver 무경기일(games:[]) → fetchGames 가 500 아닌 빈 배열 ───
{
  stubFetch((url) => {
    if (url.includes("GetKboGameList")) throw new Error("KBO down");
    if (url.includes("schedule/games")) return jsonResponse({ code: 200, success: true, result: { games: [] } });
    throw new Error(`unexpected url ${url}`);
  });
  const games = await fetchGames(DATE); // 이전엔 KBO 에러 재훈 → 500. 이제 Naver 성공(빈)으로 간주.
  restoreFetch();
  assert.equal(games.length, 0);
}

// ── 8. 통합 P1: KBO HTTP 200 스키마 열화({} / game 부재) → Naver 폴백 발동 ───
{
  stubFetch((url) => {
    if (url.includes("GetKboGameList")) return jsonResponse({}); // 200이지만 game 필드 없음(열화)
    if (url.includes("schedule/games")) {
      return jsonResponse({ code: 200, success: true, result: { games: [naverGame({ statusCode: "STARTED", statusInfo: "2회초", homeTeamScore: 0, awayTeamScore: 1 })] } });
    }
    throw new Error(`unexpected url ${url}`);
  });
  const games = await fetchGames(DATE);
  restoreFetch();
  assert.equal(games.length, 1); // 빈 배열로 종료하지 않고 Naver 로 전환됨
  assert.equal(games[0].status, "live");
}

// ── 9a. soft-empty 교차확인: KBO 200 game:[] + Naver 도 빈 → 정상 무경기일 [] ───
{
  let naverCalled = false;
  stubFetch((url) => {
    if (url.includes("GetKboGameList")) return jsonResponse({ game: [] });
    if (url.includes("schedule/games")) { naverCalled = true; return jsonResponse({ code: 200, success: true, result: { games: [] } }); }
    throw new Error(`unexpected url ${url}`);
  });
  const games = await fetchGames(DATE);
  restoreFetch();
  assert.equal(games.length, 0);
  assert.equal(naverCalled, true); // 빈 KBO 는 열화일 수 있어 Naver 로 교차확인
}

// ── 9b. soft-empty 교차확인: KBO 200 game:[](열화) + Naver 에 경기 있음 → Naver 사용 ───
{
  stubFetch((url) => {
    if (url.includes("GetKboGameList")) return jsonResponse({ game: [] }); // 게임데이인데 빈 응답(열화)
    if (url.includes("schedule/games")) {
      return jsonResponse({ code: 200, success: true, result: { games: [naverGame({ statusCode: "STARTED", statusInfo: "4회말", homeTeamScore: 2, awayTeamScore: 5 })] } });
    }
    throw new Error(`unexpected url ${url}`);
  });
  const games = await fetchGames(DATE);
  restoreFetch();
  assert.equal(games.length, 1); // soft-empty 놀침 없이 Naver 경기 사용
  assert.equal(games[0].status, "live");
  assert.equal(games[0].awayScore, 5);
}

// ── 9c. soft-empty 안전망: KBO 200 game:[] + Naver 실패 → KBO 빈 응답 존중([]) ───
{
  stubFetch((url) => {
    if (url.includes("GetKboGameList")) return jsonResponse({ game: [] });
    if (url.includes("schedule/games")) throw new Error("Naver down");
    throw new Error(`unexpected url ${url}`);
  });
  const games = await fetchGames(DATE); // throw 아닌 [] — 정상 무경기일 가능성 존중
  restoreFetch();
  assert.equal(games.length, 0);
}

// ── 9d. KBO per-game 부분 열화(game:[{}]) → schema-error → Naver 폴백 (P1) ───
{
  stubFetch((url) => {
    if (url.includes("GetKboGameList")) return jsonResponse({ game: [{}] }); // 필수 필드 전면 결측
    if (url.includes("schedule/games")) {
      return jsonResponse({ code: 200, success: true, result: { games: [naverGame({ statusCode: "STARTED", statusInfo: "6회초", homeTeamScore: 1, awayTeamScore: 3 })] } });
    }
    throw new Error(`unexpected url ${url}`);
  });
  const games = await fetchGames(DATE);
  restoreFetch();
  assert.equal(games.length, 1); // 가짜 teamId=0 경기로 진행하지 않고 Naver 전환
  assert.equal(games[0].awayTeamId > 0, true);
}

// ── 10. 통합 P1: KBO 정상 200(유효 game) → KBO 사용, Naver 호출 안 함 ───
{
  let naverCalled = false;
  stubFetch((url) => {
    if (url.includes("GetKboGameList")) {
      return jsonResponse({ game: [{ G_ID: "20260729HTSS0", G_DT: "20260729", G_TM: "18:30", S_NM: "대구", AWAY_ID: "HT", AWAY_NM: "KIA", HOME_ID: "SS", HOME_NM: "삼성", GAME_STATE_SC: "1", CANCEL_SC_ID: "0", GAME_TB_SC: "T" }] });
    }
    if (url.includes("schedule/games")) { naverCalled = true; throw new Error("Naver 를 호출하면 안 됨"); }
    throw new Error(`unexpected url ${url}`);
  });
  const games = await fetchGames(DATE);
  restoreFetch();
  assert.equal(games.length, 1);
  assert.equal(games[0].gameId, "20260729HTSS0");
  assert.equal(naverCalled, false);
}

// ── 11. Naver 부분/가짜 응답 fail-close: games:[{}] → per-game sanity throw ───
{
  stubFetch(() => jsonResponse({ code: 200, success: true, result: { games: [{}] } }));
  await assert.rejects(fetchNaverGames(DATE), /sanity/);
  restoreFetch();
}

// ── 11b. Naver raw sanity(P1): source gameId 결측 → 합성 gameId 로 숨기지 않고 fail-close ───
{
  stubFetch(() => jsonResponse({ code: 200, success: true, result: { games: [naverGame({ gameId: undefined })] } }));
  await assert.rejects(fetchNaverGames(DATE), /sanity/);
  restoreFetch();
}

// ── 11c. Naver raw sanity(P1): live 인데 score 결측 → 가짜 0:0 으로 숨기지 않고 fail-close ───
{
  stubFetch(() => jsonResponse({ code: 200, success: true, result: { games: [naverGame({ statusCode: "STARTED", statusInfo: "3회초", homeTeamScore: undefined, awayTeamScore: undefined })] } }));
  await assert.rejects(fetchNaverGames(DATE), /sanity/);
  restoreFetch();
}

// ── 11d. Naver raw sanity(P1): live 인데 이닝 정보(statusInfo) 결측 → fail-close ───
{
  stubFetch(() => jsonResponse({ code: 200, success: true, result: { games: [naverGame({ statusCode: "STARTED", statusInfo: "", homeTeamScore: 1, awayTeamScore: 0 })] } }));
  await assert.rejects(fetchNaverGames(DATE), /sanity/);
  restoreFetch();
}

// ── 11e. Naver raw sanity(P1): 미지 statusCode → 합성 scheduled 로 숨기지 않고 fail-close ───
{
  stubFetch(() => jsonResponse({ code: 200, success: true, result: { games: [naverGame({ statusCode: "WEIRD_NEW_STATE" })] } }));
  await assert.rejects(fetchNaverGames(DATE), /sanity/);
  stubFetch(() => jsonResponse({ code: 200, success: true, result: { games: [naverGame({ statusCode: undefined })] } }));
  await assert.rejects(fetchNaverGames(DATE), /sanity/);
  restoreFetch();
}

// ── 11f. Naver mapped gameId 유일성: DH 회차 유실로 중복되면 fail-close ───
{
  stubFetch(() => jsonResponse({ code: 200, success: true, result: { games: [
    naverGame({ gameId: "20260729HTSS02026" }),
    naverGame({ gameId: "20260729HTSS02026" }), // 동일 id → mapped 도 동일 → 중복
  ] } }));
  await assert.rejects(fetchNaverGames(DATE), /중복|sanity/);
  restoreFetch();
}

// ── 11g. 정상 live 경기(완전한 필드)는 raw sanity 통과 ───
{
  stubFetch(() => jsonResponse({ code: 200, success: true, result: { games: [naverGame({ statusCode: "STARTED", statusInfo: "7회말", homeTeamScore: 4, awayTeamScore: 4 })] } }));
  const games = await fetchNaverGames(DATE);
  restoreFetch();
  assert.equal(games.length, 1);
  assert.equal(games[0].inning, 7);
}

// ── 12. srId 계약(P1): 전-시리즈 셋이 아닌 srId → fail-close throw ───
{
  stubFetch(() => jsonResponse({ code: 200, success: true, result: { games: [naverGame()] } }));
  await assert.rejects(fetchNaverGames(DATE, "0"), /fail-close|series|srId/);
  restoreFetch();
}

// ── 13. srId 계약 통합: fetchGames(date,"0") + KBO throw → Naver fail-close → 원 KBO 에러 재훈 ───
{
  stubFetch((url) => {
    if (url.includes("GetKboGameList")) throw new Error("KBO down");
    if (url.includes("schedule/games")) return jsonResponse({ code: 200, success: true, result: { games: [naverGame()] } });
    throw new Error(`unexpected url ${url}`);
  });
  await assert.rejects(fetchGames(DATE, "0"), /KBO down/); // 시리즈 오염 방지 fail-close
  restoreFetch();
}

// ── 14. 홈 SSR bounded(P0): KBO blackhole → fetchHomeLiveGames 가 budget 안에 합성으로 수렴 ───
{
  // blackhole stub: abort 시그널을 존중하는 영원 pending fetch.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("GetKboGameList")) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }
        // signal 없으면 영원히 pending(이게 기존 홈 hang 재현이자, bounded 강제 회귀)
      });
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
  const fallbackGames = [
    mapNaverGameToKbo(naverGame({ statusCode: "STARTED", statusInfo: "5회초", homeTeamScore: 2, awayTeamScore: 3 }), DATE),
  ];
  const t0 = Date.now();
  const live = await fetchHomeLiveGames(DATE, fallbackGames, { budgetMs: 300 });
  const elapsed = Date.now() - t0;
  restoreFetch();
  assert.ok(elapsed < 2000, `bounded 수렴 실패: ${elapsed}ms`); // blackhole 이어도 budget 안 수렴
  assert.equal(live.length, 1); // 경기목록(Naver 폴백)에서 합성
  assert.equal(live[0].status, "live");
  assert.equal(live[0].awayScore, 3);
  assert.equal(live[0].isLive, true);
  assert.equal(live[0].currentInning, "5회초");
}

// ── 15. 홈 SSR: KBO 라이브 정상 응답 → 상세(BSO 포함) 사용 ───
{
  stubFetch((url) => {
    if (url.includes("GetKboGameList")) {
      return jsonResponse({ game: [{ G_ID: "20260729HTSS0", G_DT: "20260729", G_TM: "18:30", S_NM: "대구", AWAY_ID: "HT", AWAY_NM: "KIA", HOME_ID: "SS", HOME_NM: "삼성", GAME_STATE_SC: "2", CANCEL_SC_ID: "0", GAME_TB_SC: "T", GAME_INN_NO: 5, T_SCORE_CN: "3", B_SCORE_CN: "2", STRIKE_CN: 2, BALL_CN: 1, OUT_CN: 1, B1_BAT_ORDER_NO: 4 }] });
    }
    throw new Error(`unexpected url ${url}`);
  });
  const live = await fetchHomeLiveGames(DATE, [], { budgetMs: 1000 });
  restoreFetch();
  assert.equal(live.length, 1);
  assert.equal(live[0].strikes, 2); // 상세(BSO)는 KBO 직접 응답에서만
  assert.equal(live[0].runner1b, true);
  assert.equal(live[0].isLive, true);
}

// ── 16. 홈 SSR: KBO 라이브 빈/열화 응답 → 경기목록에서 합성 ───
{
  stubFetch((url) => {
    if (url.includes("GetKboGameList")) return jsonResponse({}); // 열화
    throw new Error(`unexpected url ${url}`);
  });
  const fallbackGames = [mapNaverGameToKbo(naverGame({ statusCode: "RESULT", statusInfo: "9회말", homeTeamScore: 7, awayTeamScore: 1 }), DATE)];
  const live = await fetchHomeLiveGames(DATE, fallbackGames, { budgetMs: 1000 });
  restoreFetch();
  assert.equal(live.length, 1);
  assert.equal(live[0].status, "final");
  assert.equal(live[0].homeScore, 7);
}

clearInterval(keepAlive);
console.log("✅ games-naver-fallback smoke passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
