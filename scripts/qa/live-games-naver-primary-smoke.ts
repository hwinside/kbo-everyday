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
type FramesImpl = Parameters<FetchLiveGamesNaverPrimary>[6];

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
// ⓔ frames 폴백 seam — 기본값(game_relay_frames DB 조회)이 네트워크를 타지 않게 반드시 주입.
const framesNone: FramesImpl = (async () => null) as FramesImpl;

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
    framesNone,
  );
  assert.equal(g1.ok, true, "P1 ok");
  assert.equal(g1.trace.source, "naver", "P1 source=naver");
  assert.equal(g1.games.length, 1, "P1 games");
  assert.equal(g1.games[0].B_SCORE_CN, "8", "P1 홈 점수 최신 8 (Naver)");
  assert.equal(g1.games[0].GAME_STATE_SC, "2", "P1 live");
  // 관측 노출(삼순 2026-08-28 분리 선배포): relay 점수가 null 이면 schedule 점수가 쓰인다는
  // 사실이 trace.enrichObs 에 score-src=schedule 로 남아야 한다(응답 JSON 판독 계약).
  assert.equal(
    g1.trace.enrichObs?.includes(`${GID}:score-src=schedule`),
    true,
    `P1 enrichObs score-src=schedule 기록 (실제: ${JSON.stringify(g1.trace.enrichObs)})`,
  );
  pass += 1;

  // P2) Naver schedule 다운 → KBO-primary fallback.
  const g2 = await fetchLiveGamesNaverPrimary(
    GID.slice(0, 8),
    Date.now() + 10_000,
    staleKbo,
    naverDown,
    okEvidence,
    kboEnrichNone,
    framesNone,
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
    framesNone,
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
    framesNone,
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
    framesNone,
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
    framesNone,
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
    framesNone,
  );
  assert.equal(g8.games[0].B_SCORE_CN, "8", "P8 relay 점수(8)가 schedule 점수(5)를 override");
  assert.equal(g8.games[0].T_SCORE_CN, "0", "P8 relay away 점수");
  // 관측 노출: relay 점수가 실제 쓰인 틱은 score-src=relay 로 기록되어야 한다.
  assert.equal(
    g8.trace.enrichObs?.includes(`${GID}:score-src=relay`),
    true,
    `P8 enrichObs score-src=relay 기록 (실제: ${JSON.stringify(g8.trace.enrichObs)})`,
  );
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
    framesNone,
  );
  assert.equal(g6.ok, false, "P6 fail-close ok=false");
  assert.deepEqual(g6.games, [], "P6 empty");
  assert.equal(g6.trace.stage, "dual-fail", "P6 dual-fail");
  pass += 1;

  // ---------- ⓓⓔ relay 보호 예산 + frames 폴백 (2026-08-29) ----------
  const {
    RELAY_EVIDENCE_BUDGET_MS,
    applyRelayFramesFallback,
    FRAMES_FALLBACK_COUNT_MAX_AGE_MS,
    FRAMES_FALLBACK_SCORE_MAX_AGE_MS,
  } = (await import("../../src/lib/notifications/kbo-live-games")) as Mod;

  // F1) relay evidence 실패 + frames 신선(점수 전진) → frames 점수 사용, obs 에 relay-failed + score-src=frames.
  const evidenceDown: EvidenceImpl = (async () => {
    throw new Error("relay down");
  }) as EvidenceImpl;
  const framesFresh: FramesImpl = (async () => ({
    ageMs: 5_000,
    awayScore: 0,
    homeScore: 9,
    balls: 1,
    strikes: 2,
    outs: 2,
    runner1b: true,
    runner2b: false,
    runner3b: false,
    runner1bOrder: 5,
    runner2bOrder: 0,
    runner3bOrder: 0,
    currentPitcher: "고우석",
    currentBatter: "오지환",
  })) as FramesImpl;
  const f1 = await fetchLiveGamesNaverPrimary(
    GID.slice(0, 8),
    Date.now() + 10_000,
    staleKbo,
    naverFresh, // schedule 0:8
    evidenceDown,
    kboEnrichNone,
    framesFresh, // frames 0:9 (전진)
  );
  assert.equal(f1.ok, true, "F1 ok");
  assert.equal(f1.games[0].B_SCORE_CN, "9", "F1 frames 점수(9)가 stale schedule(8)을 대체");
  assert.equal(f1.games[0].BALL_CN, 1, "F1 frames 카운트 적용(relay 실패 틱)");
  assert.equal(f1.games[0].B1_BAT_ORDER_NO, 5, "F1 frames 주자 적용");
  assert.equal(
    f1.trace.enrichObs?.includes(`${GID}:relay-failed`),
    true,
    `F1 relay-failed 기록 (실제: ${JSON.stringify(f1.trace.enrichObs)})`,
  );
  assert.equal(
    f1.trace.enrichObs?.includes(`${GID}:score-src=frames`),
    true,
    `F1 score-src=frames 기록 (실제: ${JSON.stringify(f1.trace.enrichObs)})`,
  );
  pass += 1;

  // F2) evidence 성공·점수만 null + frames 신선(전진) → 점수만 frames, 카운트는 evidence 유지.
  const evidenceNullScoreCounts: EvidenceImpl = (async () => ({
    ...freshEvidence,
    balls: 3,
    strikes: 0,
    outs: 1,
  })) as EvidenceImpl;
  const f2 = await fetchLiveGamesNaverPrimary(
    GID.slice(0, 8),
    Date.now() + 10_000,
    staleKbo,
    naverFresh,
    evidenceNullScoreCounts,
    kboEnrichNone,
    framesFresh,
  );
  assert.equal(f2.games[0].B_SCORE_CN, "9", "F2 점수는 frames(9)");
  assert.equal(f2.games[0].BALL_CN, 3, "F2 카운트는 evidence(더 신선) 유지");
  assert.equal(
    f2.trace.enrichObs?.includes(`${GID}:score-src=frames`),
    true,
    `F2 score-src=frames 기록 (실제: ${JSON.stringify(f2.trace.enrichObs)})`,
  );
  pass += 1;

  // F3) relay 실패 + frames 미스(null) → 기존 동작(schedule 유지) + score-src=schedule 기록.
  const f3 = await fetchLiveGamesNaverPrimary(
    GID.slice(0, 8),
    Date.now() + 10_000,
    staleKbo,
    naverFresh,
    evidenceDown,
    kboEnrichNone,
    framesNone,
  );
  assert.equal(f3.games[0].B_SCORE_CN, "8", "F3 frames 미스면 schedule 유지");
  assert.equal(
    f3.trace.enrichObs?.includes(`${GID}:score-src=schedule`),
    true,
    `F3 score-src=schedule 기록 (실제: ${JSON.stringify(f3.trace.enrichObs)})`,
  );
  pass += 1;

  // F4) 단조 가드(순수) — 낡은/후퇴 frames 는 점수를 못 바꾼다. 카운트도 age 초과면 미적용.
  const baseGame = naverGame(); // 0:8
  const retreatFrames = {
    ageMs: 5_000,
    awayScore: 0,
    homeScore: 5, // 후퇴
    balls: 2,
    strikes: 2,
    outs: 2,
    runner1b: false,
    runner2b: false,
    runner3b: false,
    runner1bOrder: 0,
    runner2bOrder: 0,
    runner3bOrder: 0,
    currentPitcher: "",
    currentBatter: "",
  };
  const r1 = applyRelayFramesFallback(baseGame, retreatFrames, { includeCounts: true });
  assert.equal(r1.scoreFromFrames, false, "F4 후퇴 frames 점수 미사용");
  assert.equal(r1.game.homeScore, 8, "F4 schedule 점수 유지");
  assert.equal(r1.game.balls, 2, "F4 신선 frames 카운트는 적용(점수 독립)");
  const staleFrames = { ...retreatFrames, homeScore: 9, ageMs: FRAMES_FALLBACK_SCORE_MAX_AGE_MS + 1 };
  const r2 = applyRelayFramesFallback(baseGame, staleFrames, { includeCounts: true });
  assert.equal(r2.scoreFromFrames, false, "F4 age 초과 frames 점수 미사용");
  assert.equal(r2.game.balls, baseGame.balls, "F4 age 초과면 카운트도 미적용");
  const equalFrames = { ...retreatFrames, homeScore: 8 };
  const r3 = applyRelayFramesFallback(baseGame, equalFrames, { includeCounts: false });
  assert.equal(r3.scoreFromFrames, false, "F4 동점 frames 는 정보 없음 → schedule 출처 유지");
  assert.ok(
    FRAMES_FALLBACK_COUNT_MAX_AGE_MS < FRAMES_FALLBACK_SCORE_MAX_AGE_MS,
    "F4 카운트 창 < 점수 창(계약)",
  );
  pass += 1;

  // D1) ⓓ relay 보호 예산 — evidence 가 행이어도 전체 deadline(10s)이 아니라 예산(2.5s) 안에 실패 확정.
  const evidenceHang: EvidenceImpl = ((
    _gameId: string,
    signal: AbortSignal,
  ) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as EvidenceImpl;
  const dStart = Date.now();
  const d1 = await fetchLiveGamesNaverPrimary(
    GID.slice(0, 8),
    Date.now() + 20_000,
    staleKbo,
    naverFresh,
    evidenceHang,
    kboEnrichNone,
    framesFresh,
  );
  const dElapsed = Date.now() - dStart;
  assert.ok(
    dElapsed < RELAY_EVIDENCE_BUDGET_MS + 2_500,
    `D1 보호 예산 안 실패 확정 (elapsed ${dElapsed}ms < ${RELAY_EVIDENCE_BUDGET_MS + 2_500}ms)`,
  );
  assert.equal(
    d1.trace.enrichObs?.includes(`${GID}:relay-failed`),
    true,
    "D1 예산 초과는 relay-failed 로 기록",
  );
  assert.equal(d1.games[0].B_SCORE_CN, "9", "D1 실패 확정 후 frames 폴백 동작");
  pass += 1;

  // ⓕ) 발현 틱 선별(순수) — 발현 마커 있는 틱만 남고, 정상 relay 틱·무관측 틱은 버려진다.
  const { selectEmergentObsTicks } = await import(
    "../../src/lib/notifications/warmup-enrich-obs"
  );
  const tick = (obs: string[], kind: "initial" | "subtick" = "subtick") => ({
    atMs: Date.now(),
    tickKind: kind,
    liveSource: "naver",
    liveStage: "naver",
    obs,
  });
  const selected = selectEmergentObsTicks([
    tick([`${GID}:score-src=relay`]), // 정상 — 제외
    tick([]), // 무관측 — 제외
    tick([`${GID}:score-src=schedule`], "initial"), // 발현
    tick([`${GID}:relay-failed`]), // 발현
    tick([`${GID}:deadline-cut`]), // 발현
    tick([`${GID}:score-src=frames`]), // 발현(폴백 작동 = relay 이상 있음)
    tick([`${GID}:score-src=relay`, `${GID}:relay-failed`]), // 혼합(한 경기 정상·한 경기 실패) — 발현
  ]);
  assert.equal(selected.length, 5, `ⓕ 발현 틱 5개 선별 (실제 ${selected.length})`);
  assert.equal(selected[0].tickKind, "initial", "ⓕ initial 틱 보존");
  pass += 1;

  // ---------- 소스 가드: warmup 이 Naver-primary 를 쓰고 KBO-primary 직호출이 없다 ----------
  const routeSrc = readFileSync("src/app/api/cron/game-events-warmup/route.ts", "utf8");
  const naverPrimaryCalls = (routeSrc.match(/fetchLiveGamesNaverPrimary\(/g) ?? []).length;
  assert.ok(naverPrimaryCalls >= 2, `warmup 이 Naver-primary 를 2곳(본체+fast-path)에서 호출 (found ${naverPrimaryCalls})`);
  assert.doesNotMatch(routeSrc, /fetchKboLiveGames\(/, "warmup 에 fetchKboLiveGames() 직호출 없음");
  // 관측 배선(삼순 #1317 P1) — 서브틱 fetch 가 enrichObsTicks 에 수집되고 응답에 노출된다.
  assert.match(
    routeSrc,
    /enrichObsTicks\.push\(\{\s*atMs: r\.trace\.fetchedAtMs,\s*obs: r\.trace\.enrichObs,\s*source: r\.trace\.source,\s*stage: r\.trace\.stage,\s*\}\)/,
    "fast-loop 클로저가 서브틱 trace.enrichObs(+source/stage) 를 enrichObsTicks 에 수집",
  );
  assert.match(routeSrc, /enrichObsTicks,\s*\n/, "응답 JSON 에 enrichObsTicks 노출");
  assert.match(routeSrc, /enrichObs: initialFetch\.trace\.enrichObs \?\? \[\]/, "응답 JSON 에 초기틱 enrichObs 노출");
  // ⓕ 발현 틱 DB 적재 배선 — persist 호출이 Promise.all(모든 발송 완료) 뒤에 있고 응답에 결과 노출.
  assert.match(routeSrc, /persistWarmupEnrichObs\(enrichObsAllTicks\)/, "ⓕ persistWarmupEnrichObs 호출 배선");
  assert.match(routeSrc, /enrichObsPersist,\s*\n/, "ⓕ 응답 JSON 에 enrichObsPersist 노출");
  assert.ok(
    routeSrc.indexOf("persistWarmupEnrichObs(enrichObsAllTicks)") >
      routeSrc.indexOf("laOrchestration.drainFanout"),
    "ⓕ persist 는 fanout drain 뒤(critical path 밖)",
  );
  pass += 1;

  assert.equal(pass, 20, `expected 20 checks, ran ${pass}`);
  console.log(`live-games-naver-primary: ${pass}/20 PASS`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
