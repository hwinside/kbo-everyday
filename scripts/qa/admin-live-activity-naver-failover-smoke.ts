/**
 * admin Live Activity 관제(GET /api/admin/live-activity)의 오늘-경기 상태 조회가
 * raw KBO 직호출이 아니라 공용 SSOT fetchKboLiveGames(KBO 1.5s bounded → Naver failover,
 * dual-fail fail-close)를 경유하는지 고정하는 결함주입 회귀.
 *
 * 배경(이중화 감사 슬라이스①): admin LA route 의 fetchTodayGames 가 예전엔 KBO GetKboGameList
 * 를 직접 fetch 하고 non-200/파싱 실패만 ok=false 로 처리했다. → (a) KBO 하드실패(503/timeout)
 * 시 Naver 가 살아있어도 관제가 전 경기 "unknown" 으로 눈멀고, (b) KBO 200+빈배열 soft-empty 를
 * Naver 교차확인 없이 authoritative "무경기" 로 오인했다.
 *
 * 이 스모크는 두 구현을 나란히 구동한다:
 *  - RED: 예전 raw 구현 replica(legacyRawFetchTodayGames) — 위 결함을 실제로 재현.
 *  - GREEN: 실제 route export fetchTodayGames(liveGamesImpl seam) — SSOT failover 로 교정됨.
 *
 * 고정 계약:
 *  - KBO 503 / 204 / timeout + Naver 정상 → ok:true, Naver 값(source 무관, GAME_STATE_SC 채워짐).
 *  - KBO 200+빈배열 + Naver 정상 → ok:true, Naver 값(soft-empty 블랙홀 방지).
 *  - KBO 200+빈배열 + Naver 도 무경기 → ok:true, [](authoritative empty).
 *  - dual-fail(KBO 하드실패 + Naver 실패) → ok:false, [](fail-close: raw KBO 를 라이브로 오인 안 함).
 *  - Naver partial(일부 경기 relay 실패) → per-game fail-soft, 경기 목록 무손실.
 *  - route 소스에 raw GetKboGameList 직호출이 없고 fetchKboLiveGames 를 경유한다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { KboGame } from "../../src/lib/crawler/kbo-api";
import type { KboRawGame } from "../../src/types/api";

// import 체인(supabase admin 등)이 모듈 스코프에서 env 를 요구하므로 앱 코드는 env 설정 후
// 동적 import 한다(kbo-live-games / game-detail smoke 와 동일 패턴).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "smoke-service-role-key";

type FetchTodayGames =
  typeof import("../../src/app/api/admin/live-activity/route").fetchTodayGames;
type FetchKboLiveGames =
  typeof import("../../src/lib/notifications/kbo-live-games").fetchKboLiveGames;

const KBO_MAIN = "https://www.koreabaseball.com/ws/Main.asmx";

function naverGame(gameId: string): KboGame {
  return {
    gameId,
    date: "20260730",
    time: "18:30",
    stadium: "잠실",
    awayTeamId: 10,
    homeTeamId: 3,
    awayName: "키움",
    homeName: "LG",
    awayScore: 1,
    homeScore: 0,
    inning: 3,
    isTop: false,
    status: "live",
    awayStarterName: "",
    homeStarterName: "",
    winPitcher: "",
    losePitcher: "",
    savePitcher: "",
    strikes: 0,
    balls: 0,
    outs: 0,
    runnersOn: { first: false, second: false, third: false },
    currentPitcher: "",
    currentBatter: "",
    awayRank: 0,
    homeRank: 0,
  };
}

const zeroEvidence = {
  hasRealPlay: true,
  balls: 0,
  strikes: 0,
  outs: 0,
  runner1b: false,
  runner2b: false,
  runner3b: false,
  runner1bOrder: 0,
  runner2bOrder: 0,
  runner3bOrder: 0,
  currentPitcher: "",
  currentBatter: "",
};

// KBO fetchImpl 결함주입 팩토리.
const kbo503: typeof fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
const kbo204: typeof fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
const kbo200Empty: typeof fetch = (async () =>
  new Response(JSON.stringify({ game: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
const kboTimeout: typeof fetch = (async () => {
  throw new DOMException("The operation was aborted.", "AbortError");
}) as typeof fetch;

/**
 * 예전(수정 전) admin LA route 의 fetchTodayGames 를 그대로 복제 — RED baseline.
 * KBO 단독 직호출: r.ok 아니면 ok:false, r.ok 면 res.game ?? [] 를 그대로 authoritative.
 */
async function legacyRawFetchTodayGames(
  fetchImpl: typeof fetch,
): Promise<{ games: KboRawGame[]; ok: boolean }> {
  const res = await fetchImpl(`${KBO_MAIN}/GetKboGameList`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
      "Referer": "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
    },
    body: `leId=1&srId=0,1,3,4,5,7,8,9&date=20260730`,
    cache: "no-store",
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (res === null) return { games: [], ok: false };
  return { games: (res.game ?? []) as KboRawGame[], ok: true };
}

// liveGamesImpl seam: 실제 fetchKboLiveGames 를 결함주입 fetch/naver/evidence 로 부분적용해
// fetchTodayGames 에 주입한다(실제 route 배선을 통과하는 GREEN).
function inject(
  fetchKboLiveGames: FetchKboLiveGames,
  kboFetch: typeof fetch,
  naverImpl: Parameters<FetchKboLiveGames>[3],
  evidenceImpl: Parameters<FetchKboLiveGames>[4] = (async () => zeroEvidence) as Parameters<FetchKboLiveGames>[4],
): FetchKboLiveGames {
  return ((date: string, deadlineAtMs?: number) =>
    fetchKboLiveGames(date, deadlineAtMs, kboFetch, naverImpl, evidenceImpl)) as FetchKboLiveGames;
}

async function main() {
  const { fetchTodayGames } = (await import(
    "../../src/app/api/admin/live-activity/route"
  )) as { fetchTodayGames: FetchTodayGames };
  const { fetchKboLiveGames } = (await import(
    "../../src/lib/notifications/kbo-live-games"
  )) as { fetchKboLiveGames: FetchKboLiveGames };

  const naverOne: Parameters<FetchKboLiveGames>[3] = async () => [naverGame("20260730WOLG0")];
  const naverEmpty: Parameters<FetchKboLiveGames>[3] = async () => [];
  const naverDown: Parameters<FetchKboLiveGames>[3] = async () => {
    throw new Error("naver down");
  };

  // ---------- RED: 예전 raw 구현이 결함을 실제로 재현 ----------
  // R1) KBO 503 → 예전 구현은 ok:false 로 관제 눈멈(Naver 살아있어도 확인 못 함).
  const redK503 = await legacyRawFetchTodayGames(kbo503);
  assert.equal(redK503.ok, false);
  assert.deepEqual(redK503.games, []);
  // R2) KBO 200+빈배열 → 예전 구현은 Naver 교차확인 없이 ok:true, [](가짜 무경기 authoritative).
  const redEmpty = await legacyRawFetchTodayGames(kbo200Empty);
  assert.equal(redEmpty.ok, true);
  assert.deepEqual(redEmpty.games, []);

  // ---------- GREEN: 실제 fetchTodayGames(SSOT seam) 가 교정 ----------
  // G1) KBO 503 + Naver 정상 → ok:true, Naver 경기(GAME_STATE_SC 채워짐).
  const g503 = await fetchTodayGames(inject(fetchKboLiveGames, kbo503, naverOne));
  assert.equal(g503.ok, true, "G1 503→Naver ok");
  assert.equal(g503.games.length, 1, "G1 games");
  assert.equal(g503.games[0].G_ID, "20260730WOLG0");
  assert.equal(g503.games[0].GAME_STATE_SC, "2", "G1 live");

  // G2) KBO 204(빈 본문) + Naver 정상 → ok:true, Naver.
  const g204 = await fetchTodayGames(inject(fetchKboLiveGames, kbo204, naverOne));
  assert.equal(g204.ok, true, "G2 204→Naver ok");
  assert.equal(g204.games.length, 1, "G2 games");

  // G3) KBO timeout + Naver 정상 → ok:true, Naver.
  const gTimeout = await fetchTodayGames(inject(fetchKboLiveGames, kboTimeout, naverOne));
  assert.equal(gTimeout.ok, true, "G3 timeout→Naver ok");
  assert.equal(gTimeout.games.length, 1, "G3 games");

  // G4) KBO 200+빈배열 + Naver 정상 → ok:true, Naver(soft-empty 블랙홀 방지).
  const gSoftEmpty = await fetchTodayGames(inject(fetchKboLiveGames, kbo200Empty, naverOne));
  assert.equal(gSoftEmpty.ok, true, "G4 soft-empty→Naver ok");
  assert.equal(gSoftEmpty.games.length, 1, "G4 uses Naver not empty");
  assert.equal(gSoftEmpty.games[0].G_ID, "20260730WOLG0");

  // G5) KBO 200+빈배열 + Naver 도 무경기 → ok:true, [](authoritative empty).
  const gBothEmpty = await fetchTodayGames(inject(fetchKboLiveGames, kbo200Empty, naverEmpty));
  assert.equal(gBothEmpty.ok, true, "G5 authoritative empty ok");
  assert.deepEqual(gBothEmpty.games, [], "G5 empty");

  // G6) dual-fail: KBO 503 + Naver 실패 → ok:false, [](fail-close, raw KBO 라이브 오인 안 함).
  const gDualFail = await fetchTodayGames(inject(fetchKboLiveGames, kbo503, naverDown));
  assert.equal(gDualFail.ok, false, "G6 fail-close ok=false");
  assert.deepEqual(gDualFail.games, [], "G6 empty");

  // G6b) dual-fail 변형: KBO 200+빈배열 + Naver 실패 → 검증 실패 soft-empty 는 ok:false.
  const gEmptyNaverDown = await fetchTodayGames(inject(fetchKboLiveGames, kbo200Empty, naverDown));
  assert.equal(gEmptyNaverDown.ok, false, "G6b unverified soft-empty fail-close");
  assert.deepEqual(gEmptyNaverDown.games, []);

  // G7) Naver partial: 2경기 중 1경기 relay(evidence) 실패 → per-game fail-soft, 목록 무손실.
  const naverTwo: Parameters<FetchKboLiveGames>[3] = async () => [
    naverGame("20260730WOLG0"),
    naverGame("20260730HTSS0"),
  ];
  let evidenceCalls = 0;
  const evidencePartial: Parameters<FetchKboLiveGames>[4] = async () => {
    evidenceCalls += 1;
    if (evidenceCalls === 2) throw new Error("relay down for game 2");
    return zeroEvidence;
  };
  const gPartial = await fetchTodayGames(
    inject(fetchKboLiveGames, kbo503, naverTwo, evidencePartial),
  );
  assert.equal(gPartial.ok, true, "G7 partial ok");
  assert.equal(gPartial.games.length, 2, "G7 no game dropped on relay fail");
  for (const g of gPartial.games) assert.equal(g.GAME_STATE_SC, "2", "G7 stays live");

  // ---------- 소스 가드: raw 직호출 제거 + SSOT 경유 ----------
  const routeSrc = readFileSync("src/app/api/admin/live-activity/route.ts", "utf8");
  assert.match(routeSrc, /fetchKboLiveGames/, "route imports/uses fetchKboLiveGames");
  assert.doesNotMatch(routeSrc, /GetKboGameList/, "no raw KBO GetKboGameList in route");
  assert.doesNotMatch(routeSrc, /koreabaseball\.com\/ws\/Main\.asmx/, "no raw KBO endpoint in route");

  console.log("admin-live-activity-naver-failover: 12/12 PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
