/**
 * fetchLiveGamesNaverPrimary(Live Activity 카드·위젯 라이브 소스) 결함주입 회귀.
 *
 * 배경(잠금화면 카드 점수 stale — 2026-08-26 하린아빠 제보): warmup cron 의 LA broadcast·
 * iOS/Android 위젯이 fetchKboLiveGames(KBO-primary)를 썼다. KBO 스코어보드가 200 OK 인데
 * 점수만 오래된(0:5) 구간에서 그 값을 그대로 카드에 넣고 Naver 를 아예 안 봐서, 알림·중계
 * 한 줄(Naver, 0:8)은 최신인데 카드 점수만 뒤처졌다. 앱 화면(games-user-facing)은 Naver-primary
 * 라 빠른데 LA/위젯만 KBO-primary 였던 게 원인.
 *
 * 이 스모크는 두 소스를 나란히 구동한다:
 *  - RED: 기존 warmup 소스 fetchKboLiveGames(KBO-primary) — KBO 200+stale 를 그대로 반환(재현).
 *  - GREEN: 새 fetchLiveGamesNaverPrimary — Naver-primary 로 최신 점수 반환, Naver 다운 시 KBO fallback.
 *
 * 고정 계약:
 *  - KBO 200+stale(0:5) + Naver 최신(0:8) → GREEN 은 Naver 값(0:8), source="naver". RED 는 KBO(0:5).
 *  - Naver schedule 다운 → KBO-primary fallback(자체 Naver failover 포함).
 *  - Naver 무경기(빈 배열) + KBO 경기 있음 → KBO fallback(경기 목록 무손실).
 *  - Naver relay evidence 로 볼카운트/주자/투타 보강이 raw 게임에 반영.
 *  - 1회초 0:0 + relay 실제 투구 없음 → scheduled 강등(가짜 live 방지).
 *  - dual-fail(Naver 다운 + KBO 하드실패) → ok:false, [](fail-close).
 *  - warmup route 가 fetchLiveGamesNaverPrimary 를 쓰고 fetchKboLiveGames() 직호출이 없다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { KboGame } from "../../src/lib/crawler/kbo-api";
import type { KboRawGame } from "../../src/types/api";
import {
  isScoreStateRetreat,
  resolveChannelUpdateDecision,
  decideLegacyTokenUpdate,
} from "../../src/lib/notifications/live-activity-channel-policy";
import {
  decideWidgetPushClaim,
  isWidgetScoreRetreat,
} from "../../src/lib/notifications/ios-widget-policy";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "smoke-service-role-key";

type Mod = typeof import("../../src/lib/notifications/kbo-live-games");
type FetchLiveGamesNaverPrimary = Mod["fetchLiveGamesNaverPrimary"];
type NaverImpl = Parameters<FetchLiveGamesNaverPrimary>[3];
type EvidenceImpl = Parameters<FetchLiveGamesNaverPrimary>[4];
type KboGamesImpl = Parameters<FetchLiveGamesNaverPrimary>[5];

const GID = "20260826NCLG0";

function naverGame(over: Partial<KboGame> = {}): KboGame {
  return {
    gameId: GID,
    date: "20260826",
    time: "18:30",
    stadium: "잠실",
    awayTeamId: 5,
    homeTeamId: 3,
    awayName: "NC",
    homeName: "LG",
    awayScore: 0,
    homeScore: 8,
    inning: 7,
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
    ...over,
  };
}

/** KBO raw 게임(스코어보드 원천 필드). stale 점수 재현용. */
function kboRaw(over: Partial<KboRawGame> = {}): KboRawGame {
  return {
    G_ID: GID,
    G_DT: "20260826",
    G_TM: "18:30",
    S_NM: "잠실",
    AWAY_ID: "NC",
    HOME_ID: "LG",
    AWAY_NM: "NC",
    HOME_NM: "LG",
    T_SCORE_CN: "0",
    B_SCORE_CN: "5", // KBO 스코어보드 stale (실제 8)
    GAME_INN_NO: 7,
    GAME_TB_SC: "B",
    GAME_STATE_SC: "2",
    CANCEL_SC_ID: "0",
    ...over,
  } as KboRawGame;
}

function kboFetch(rows: KboRawGame[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ game: rows }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

const kbo503: typeof fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;

const freshEvidence = {
  hasRealPlay: true,
  awayScore: null as number | null,
  homeScore: null as number | null,
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

const okEvidence: EvidenceImpl = (async () => freshEvidence) as EvidenceImpl;
// KBO enrich seam — 기본값(실 fetchKboGamesOnly)이 네트워크를 타지 않게 게이트에서 반드시 주입.
const kboEnrichNone: KboGamesImpl = (async () => []) as KboGamesImpl;

async function main() {
  const { fetchLiveGamesNaverPrimary, fetchKboLiveGames, fetchNaverLiveEvidence } = (await import(
    "../../src/lib/notifications/kbo-live-games"
  )) as Mod;

  const naverFresh: NaverImpl = async () => [naverGame()]; // 0:8
  const naverDown: NaverImpl = async () => {
    throw new Error("naver schedule down");
  };
  const naverEmpty: NaverImpl = async () => [];

  let pass = 0;
  const staleKbo = kboFetch([kboRaw()]); // KBO 200 + 점수 0:5 (stale)

  // ---------- RED: 기존 warmup 소스(KBO-primary)가 stale 를 그대로 반환 ----------
  // KBO 200+게임 있으면 Naver 를 아예 안 본다 → 카드가 0:5 로 굳는 원인.
  const red = await fetchKboLiveGames(GID.slice(0, 8), 0 + Date.now() + 10_000, staleKbo, naverFresh, okEvidence);
  assert.equal(red.ok, true, "RED ok");
  assert.equal(red.trace.source, "kbo", "RED source=kbo (Naver 미조회)");
  assert.equal(red.games[0]?.B_SCORE_CN, "5", "RED 홈 점수 stale 5 (버그 재현)");
  pass += 1;

  // ---------- GREEN P1(핵심): Naver-primary 가 최신 점수 반환 ----------
  const g1 = await fetchLiveGamesNaverPrimary(
    GID.slice(0, 8),
    Date.now() + 10_000,
    staleKbo,
    naverFresh,
    okEvidence,
    kboEnrichNone,
  );
  assert.equal(g1.ok, true, "P1 ok");
  assert.equal(g1.trace.source, "naver", "P1 source=naver");
  assert.equal(g1.games.length, 1, "P1 games");
  assert.equal(g1.games[0].B_SCORE_CN, "8", "P1 홈 점수 최신 8 (Naver)");
  assert.equal(g1.games[0].GAME_STATE_SC, "2", "P1 live");
  pass += 1;

  // P2) Naver schedule 다운 → KBO-primary fallback.
  const g2 = await fetchLiveGamesNaverPrimary(
    GID.slice(0, 8),
    Date.now() + 10_000,
    staleKbo,
    naverDown,
    okEvidence,
    kboEnrichNone,
  );
  assert.equal(g2.ok, true, "P2 ok");
  assert.equal(g2.trace.source, "kbo", "P2 source=kbo (fallback)");
  assert.equal(g2.games[0]?.B_SCORE_CN, "5", "P2 KBO 값 (Naver 다운)");
  pass += 1;

  // P3) Naver 무경기(빈 배열) + KBO 경기 있음 → KBO fallback(경기 목록 무손실).
  const g3 = await fetchLiveGamesNaverPrimary(
    GID.slice(0, 8),
    Date.now() + 10_000,
    staleKbo,
    naverEmpty,
    okEvidence,
    kboEnrichNone,
  );
  assert.equal(g3.ok, true, "P3 ok");
  assert.equal(g3.games.length, 1, "P3 KBO 게임 무손실");
  assert.equal(g3.games[0].G_ID, GID, "P3 game id");
  pass += 1;

  // P4) Naver relay evidence 로 볼카운트/주자/투타 보강이 raw 게임에 반영.
  const enrichEvidence: EvidenceImpl = (async () => ({
    ...freshEvidence,
    balls: 2,
    strikes: 1,
    outs: 1,
    runner1b: true,
    runner1bOrder: 3,
    currentPitcher: "최요한",
    currentBatter: "문보경",
  })) as EvidenceImpl;
  const g4 = await fetchLiveGamesNaverPrimary(
    GID.slice(0, 8),
    Date.now() + 10_000,
    staleKbo,
    naverFresh,
    enrichEvidence,
    kboEnrichNone,
  );
  assert.equal(g4.games[0].BALL_CN, 2, "P4 balls from naver relay");
  assert.equal(g4.games[0].STRIKE_CN, 1, "P4 strikes");
  assert.equal(g4.games[0].OUT_CN, 1, "P4 outs");
  assert.equal(g4.games[0].B1_BAT_ORDER_NO, 3, "P4 1루 주자 order");
  // isTop=false(말) → 홈 LG 공격·어웨이 NC 수비. naverGameToRaw 매핑:
  //   T_P_NM = currentPitcher(수비=어웨이), B_P_NM = currentBatter(공격=홈).
  assert.equal(g4.games[0].T_P_NM, "최요한", "P4 현재 투수 (말=어웨이 수비) → T_P_NM");
  assert.equal(g4.games[0].B_P_NM, "문보경", "P4 현재 타자 (말=홈 공격) → B_P_NM");
  pass += 1;

  // P5) 1회초 0:0 + relay 실제 투구 없음 → scheduled 강등(가짜 live 방지).
  const naverFirstPitch: NaverImpl = async () => [
    naverGame({ awayScore: 0, homeScore: 0, inning: 1, isTop: true }),
  ];
  const noPlayEvidence: EvidenceImpl = (async () => ({
    ...freshEvidence,
    hasRealPlay: false,
  })) as EvidenceImpl;
  const g5 = await fetchLiveGamesNaverPrimary(
    GID.slice(0, 8),
    Date.now() + 10_000,
    staleKbo,
    naverFirstPitch,
    noPlayEvidence,
    kboEnrichNone,
  );
  assert.equal(g5.games[0].GAME_STATE_SC, "1", "P5 scheduled 강등 (가짜 live 방지)");
  pass += 1;

  // P7) KBO 준정적 enrich — Naver 선발 빈 값 + KBO 선발 있음 → raw 에 선발 채워짐(라이브 점수는 Naver 유지).
  const kboEnrichStarters: KboGamesImpl = (async () => [
    naverGame({ awayStarterName: "박세웅", homeStarterName: "손주영" }),
  ]) as KboGamesImpl;
  const g7 = await fetchLiveGamesNaverPrimary(
    GID.slice(0, 8),
    Date.now() + 10_000,
    staleKbo,
    async () => [naverGame({ awayStarterName: "", homeStarterName: "" })],
    okEvidence,
    kboEnrichStarters,
  );
  assert.equal(g7.games[0].T_PIT_P_NM, "박세웅", "P7 KBO 선발 enrich (어웨이)");
  assert.equal(g7.games[0].B_PIT_P_NM, "손주영", "P7 KBO 선발 enrich (홈)");
  assert.equal(g7.games[0].B_SCORE_CN, "8", "P7 라이브 점수는 Naver 유지");
  pass += 1;

  // P8) 근본 수정 — relay currentGameState 점수가 schedule 점수를 덮어쓴다(schedule↔relay 지연차 해소).
  // schedule은 0:5(느림), relay evidence는 0:8(신선) → raw 는 relay 8.
  const staleScheduleNaver: NaverImpl = async () => [naverGame({ awayScore: 0, homeScore: 5 })];
  const relayFreshScore: EvidenceImpl = (async () => ({
    ...freshEvidence,
    awayScore: 0,
    homeScore: 8,
  })) as EvidenceImpl;
  const g8 = await fetchLiveGamesNaverPrimary(
    GID.slice(0, 8),
    Date.now() + 10_000,
    staleKbo,
    staleScheduleNaver,
    relayFreshScore,
    kboEnrichNone,
  );
  assert.equal(g8.games[0].B_SCORE_CN, "8", "P8 relay 점수(8)가 schedule 점수(5)를 override");
  assert.equal(g8.games[0].T_SCORE_CN, "0", "P8 relay away 점수");
  pass += 1;

  // W) 위젯 되감기 가드(B② 3축) — iOS 위젯 away|home 포맷.
  assert.equal(isWidgetScoreRetreat("0|8", "0|5"), true, "W iOS 위젯 점수 후퇴 감지");
  assert.equal(isWidgetScoreRetreat("0|8", "0|9"), false, "W iOS 위젯 전진 허용");
  assert.equal(decideWidgetPushClaim("0|8", "0|5"), "skip", "W 되감김은 claim-update 아니라 skip");
  assert.equal(decideWidgetPushClaim("0|8", "0|9"), "claim-update", "W 전진은 claim-update");
  assert.equal(decideWidgetPushClaim(null, "0|5"), "claim-insert", "W 최초 live는 insert");
  pass += 1;

  // G) 레거시 축 행동 테스트(삼순 B① — 소스 grep 이 아니라 decideLegacyTokenUpdate 까지 태움).
  // 되감김(isRetreat)은 catch-up(bootstrap lastWriteAtMs=null · 늦은 토큰)을 뚫지 못한다.
  assert.deepEqual(
    decideLegacyTokenUpdate({ decision: { send: false }, isRetreat: true, tokenUpdatedAtMs: 100, lastWriteAtMs: null }),
    { send: false },
    "G 되감김은 bootstrap catch-up 도 발송 안 함",
  );
  assert.deepEqual(
    decideLegacyTokenUpdate({ decision: { send: false }, isRetreat: true, tokenUpdatedAtMs: 200, lastWriteAtMs: 100 }),
    { send: false },
    "G 되감김은 늦은 토큰 catch-up 도 발송 안 함",
  );
  // 대조: 후퇴 아닌 no-diff skip 은 bootstrap catch-up 이 정상 동작(기존 #664 보존).
  assert.deepEqual(
    decideLegacyTokenUpdate({ decision: { send: false }, isRetreat: false, tokenUpdatedAtMs: 100, lastWriteAtMs: null }),
    { send: true, priority: "10" },
    "G 비후퇴 no-diff + bootstrap 은 catch-up p10 유지",
  );
  // 안드는 call-site 배선(전체 push 플로우 필요)이라 소스 grep 으로 보완.
  const androidSrc = readFileSync("src/lib/notifications/android-widget-live.ts", "utf8");
  assert.match(androidSrc, /isWidgetScoreRetreat\(/, "G 안드 위젯이 isWidgetScoreRetreat 호출");
  pass += 1;

  // B2) relay 점수 top-level 한정(삼순 B②) — fetchNaverLiveEvidence 가 actualPlay[0] 폴백 점수를 안 취한다.
  const origFetch = globalThis.fetch;
  const relayJson = (obj: unknown) =>
    (async () => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  // top-level 없음 + actualPlay[0] 에만 점수(1회 0:0) → 점수 null(오염 미취득), count 는 폴백에서 취득.
  globalThis.fetch = relayJson({
    result: { textRelayData: {
      textRelays: [{ textOptions: [{ pitchNum: 3, currentGameState: { homeScore: "0", awayScore: "0", ball: "1", strike: "2", out: "1", base1: "0", base2: "0", base3: "0" } }] }],
      awayLineup: {}, homeLineup: {},
    } },
  });
  const evFallback = await fetchNaverLiveEvidence(GID, new AbortController().signal);
  assert.equal(evFallback.awayScore, null, "B2 top-level 없으면 away 점수 null(폴백 점수 미취득)");
  assert.equal(evFallback.homeScore, null, "B2 top-level 없으면 home 점수 null(1회 점수 오염 차단)");
  assert.equal(evFallback.balls, 1, "B2 count 는 폴백에서 취득(기존 동작)");
  // top-level 있음 → 점수 취득.
  globalThis.fetch = relayJson({
    result: { textRelayData: {
      currentGameState: { homeScore: "8", awayScore: "0", ball: "2", strike: "0", out: "1", base1: "0", base2: "0", base3: "0" },
      textRelays: [{ textOptions: [{ pitchNum: 1, currentGameState: { homeScore: "0", awayScore: "0" } }] }],
      awayLineup: {}, homeLineup: {},
    } },
  });
  const evTop = await fetchNaverLiveEvidence(GID, new AbortController().signal);
  globalThis.fetch = origFetch;
  assert.equal(evTop.homeScore, 8, "B2 top-level 있으면 점수 취득(8)");
  assert.equal(evTop.awayScore, 0, "B2 top-level away 점수");
  pass += 1;

  // R) 되감김 가드(B②) — 예측/배선 둘 다.
  // scoreStateOf 포맷: away|home|inning|isTop|on1|on2|on3|status
  const lastSent = "0|8|7|false|false|false|false|live";
  assert.equal(isScoreStateRetreat(lastSent, "0|5|7|false|false|false|false|live"), true, "R 점수 후퇴 감지");
  assert.equal(isScoreStateRetreat(lastSent, "0|9|7|false|false|false|false|live"), false, "R 점수 전진 허용");
  assert.equal(isScoreStateRetreat(lastSent, "0|8|6|false|false|false|false|live"), true, "R 이닝 후퇴 감지");
  assert.equal(isScoreStateRetreat(null, "0|5|7|false|false|false|false|live"), false, "R 첫 발송은 후퇴 아님");
  assert.equal(isScoreStateRetreat(lastSent, "0|8|7|false|true|false|false|live"), false, "R 주자 변화는 후퇴 아님");
  // B① 핵심: 이닝교대 lag — 7말 0:8 → 8초 0:5(nRank>pRank 지만 점수 후퇴)는 되감김.
  assert.equal(isScoreStateRetreat(lastSent, "0|5|8|true|false|false|false|live"), true, "R 이닝 전진+점수 후퇴 = 되감김(B①)");
  // 이닝 전진+점수 유지는 전진.
  assert.equal(isScoreStateRetreat(lastSent, "0|8|8|true|false|false|false|live"), false, "R 이닝 전진+점수 유지 = 전진");
  // 배선: 되감김은 forceCatchup(지명 catch-up)이어도 broadcast skip.
  const retreatDecision = resolveChannelUpdateDecision({
    scoreState: "0|5|7|false|false|false|false|live",
    fullStateHash: "0|5|7|false|false|false|false|live|0|0|0|p|b|",
    lastScoreState: lastSent,
    lastStateHash: "different-hash",
    lastP10AtMs: null,
    nowMs: Date.now(),
    forceCatchup: true,
  });
  assert.equal(retreatDecision.decision.send, false, "R 되감김은 forceCatchup 이어도 broadcast/catch-up skip");
  // 대조: 전진(9점)은 정상 발송.
  const forwardDecision = resolveChannelUpdateDecision({
    scoreState: "0|9|7|false|false|false|false|live",
    fullStateHash: "0|9|7|false|false|false|false|live|0|0|0|p|b|",
    lastScoreState: lastSent,
    lastStateHash: "different-hash",
    lastP10AtMs: null,
    nowMs: Date.now(),
    forceCatchup: false,
  });
  assert.equal(forwardDecision.decision.send, true, "R 전진은 정상 발송");
  pass += 1;

  // P6) dual-fail: Naver 다운 + KBO 하드실패(503) → ok:false, [](fail-close).
  const g6 = await fetchLiveGamesNaverPrimary(
    GID.slice(0, 8),
    Date.now() + 10_000,
    kbo503,
    naverDown,
    okEvidence,
    kboEnrichNone,
  );
  assert.equal(g6.ok, false, "P6 fail-close ok=false");
  assert.deepEqual(g6.games, [], "P6 empty");
  assert.equal(g6.trace.stage, "dual-fail", "P6 dual-fail");
  pass += 1;

  // ---------- 소스 가드: warmup 이 Naver-primary 를 쓰고 KBO-primary 직호출이 없다 ----------
  const routeSrc = readFileSync("src/app/api/cron/game-events-warmup/route.ts", "utf8");
  const naverPrimaryCalls = (routeSrc.match(/fetchLiveGamesNaverPrimary\(/g) ?? []).length;
  assert.ok(naverPrimaryCalls >= 2, `warmup 이 Naver-primary 를 2곳(본체+fast-path)에서 호출 (found ${naverPrimaryCalls})`);
  assert.doesNotMatch(routeSrc, /fetchKboLiveGames\(/, "warmup 에 fetchKboLiveGames() 직호출 없음");
  pass += 1;

  assert.equal(pass, 14, `expected 14 checks, ran ${pass}`);
  console.log(`live-games-naver-primary: ${pass}/14 PASS`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
