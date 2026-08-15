/**
 * 라이브 상세 provenance 게이트 — "거짓 0-0-0" 이 유저에게 노출되지 않는지 검증한다.
 *
 * 배경 (삼순 2026-08-15 NO-GO / P1):
 *  - Naver schedule 피드에는 BSO/주자/현재투타가 없어 매핑이 항상 0/false 로 degrade 한다.
 *  - KBO 도 HTTP 200 인데 per-game 상세 필드만 빠지는 부분 열화가 가능하다.
 *  → 값(0)만 보면 "실제 관측된 0" 과 "못 받았다" 가 구분되지 않아, KBO timeout·시점 불일치·
 *    부분결측에서 UI 가 "볼카운트 0-0, 주자 없음" 을 사실처럼 단정하게 된다.
 *
 * 이 게이트는 production 함수를 그대로 태워(재구현 금지) 아래를 확인한다:
 *   parseGame(kbo-api) / mapNaverGameToKbo(naver-games) / mergeKboEnrichment(games-user-facing)
 *
 * 불변식: liveDetailFromKbo === false 이면 BSO·주자가 전부 degrade 기본값(0/false)이어야 한다.
 *   (플래그만 false 인데 값이 남아있으면 소비자가 값을 믿고 그릴 여지가 생긴다)
 * 또한 값과 플래그가 같은 조건으로 묶였는지를 시나리오별로 확인한다.
 *
 * --selftest: 판정을 무력화했을 때 실제로 RED 가 나는지(검출력) 증명한다.
 */
// kbo-api 는 트랜지티브로 supabase/admin 싱글톤을 로드하고, 그 싱글톤이 모듈 로드 시점에
// SUPABASE env 를 요구한다. 이 게이트는 순수 파싱/병합만 검증하므로 더미 값을 선주입한다
// (반드시 아래 import 보다 먼저 평가될 것 — 기존 scripts/qa/_smoke-env.ts 와 동일 패턴).
import "./_smoke-env";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { mapNaverGameToKbo } from "@/lib/crawler/naver-games";
import { mergeKboEnrichment, type KboGame } from "@/lib/crawler/games-user-facing";

const SELFTEST = process.argv.includes("--selftest");
let failed = 0;

function check(name: string, cond: boolean, detail = "") {
  // selftest 는 기대를 반전시켜 "이 게이트가 RED 를 낼 수 있는가" 를 증명한다.
  const pass = SELFTEST ? !cond : cond;
  if (pass) {
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** KBO live raw 원형 — 상세 필드가 전부 유효한 정상 경기 */
function kboRawLive(overrides: Record<string, unknown> = {}) {
  return {
    G_ID: "20260815LGSS0",
    G_DT: "20260815",
    G_TM: "18:30",
    S_NM: "잠실",
    AWAY_ID: "SS",
    HOME_ID: "LG",
    AWAY_NM: "삼성",
    HOME_NM: "LG",
    T_SCORE_CN: "3",
    B_SCORE_CN: "5",
    GAME_INN_NO: 7,
    GAME_TB_SC: "T",
    GAME_STATE_SC: "2", // live
    CANCEL_SC_ID: "0",
    T_PIT_P_NM: "원태인",
    B_PIT_P_NM: "임찬규",
    W_PIT_P_NM: "",
    L_PIT_P_NM: "",
    SV_PIT_P_NM: "",
    STRIKE_CN: 2,
    BALL_CN: 3,
    OUT_CN: 1,
    B1_BAT_ORDER_NO: 4,
    B2_BAT_ORDER_NO: 0,
    B3_BAT_ORDER_NO: 7,
    B_P_NM: "김진성",
    T_P_NM: "구자욱",
    T_RANK_NO: 2,
    B_RANK_NO: 1,
    ...overrides,
  };
}

/** Naver schedule raw — live 경기 */
function naverRawLive(overrides: Record<string, unknown> = {}) {
  return {
    gameId: "20260815LGSS02026",
    gameDateTime: "2026-08-15T18:30:00",
    stadium: "잠실",
    awayTeamCode: "SS",
    homeTeamCode: "LG",
    awayTeamName: "삼성",
    homeTeamName: "LG",
    awayTeamScore: 3,
    homeTeamScore: 5,
    statusCode: "STARTED",
    statusInfo: "7회초",
    ...overrides,
  };
}

/** production parseGame 은 module-private 이므로 fetchKboGamesOnly 의 파서를 우회 접근한다. */
async function parseKboRaw(raw: Record<string, unknown>): Promise<KboGame> {
  const mod = await import("@/lib/crawler/kbo-api");
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ game: [raw] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const games = await mod.fetchKboGamesOnly("20260815", "0,1");
    if (games.length !== 1) throw new Error(`파싱 결과 ${games.length}건 — fixture 전제가 깨졌다`);
    return games[0];
  } finally {
    globalThis.fetch = orig;
  }
}

/** 불변식: 플래그가 false 면 상세 값은 전부 degrade 기본값이어야 한다. */
function degradedValuesOnly(g: KboGame): boolean {
  return (
    g.balls === 0 && g.strikes === 0 && g.outs === 0 &&
    !g.runnersOn.first && !g.runnersOn.second && !g.runnersOn.third
  );
}

async function main() {
  console.log("live-detail provenance gate\n");

  // ── ① KBO 정상 live: 관측값이므로 flag=true, 값 보존
  const ok = await parseKboRaw(kboRawLive());
  check("KBO 정상 live → liveDetailFromKbo=true", ok.liveDetailFromKbo === true, `실제 ${ok.liveDetailFromKbo}`);
  check("KBO 정상 live → 관측값 보존(B3/S2/O1, 1·3루)",
    ok.balls === 3 && ok.strikes === 2 && ok.outs === 1 && ok.runnersOn.first && !ok.runnersOn.second && ok.runnersOn.third,
    `B${ok.balls}/S${ok.strikes}/O${ok.outs} ${JSON.stringify(ok.runnersOn)}`);

  // ── ② KBO 부분결측(HTTP 200 인데 상세 필드만 빠짐) → 합성 0 을 관측값으로 내보내면 안 된다
  for (const missing of ["STRIKE_CN", "BALL_CN", "OUT_CN", "B1_BAT_ORDER_NO", "B2_BAT_ORDER_NO", "B3_BAT_ORDER_NO"]) {
    const g = await parseKboRaw(kboRawLive({ [missing]: undefined }));
    check(`KBO live 부분결측(${missing}) → flag=false`, g.liveDetailFromKbo === false, `실제 ${g.liveDetailFromKbo}`);
    check(`KBO live 부분결측(${missing}) → 값도 degrade`, degradedValuesOnly(g),
      `B${g.balls}/S${g.strikes}/O${g.outs} ${JSON.stringify(g.runnersOn)}`);
  }

  // ── ③ 비정상 타입/도메인 이탈도 관측값으로 취급하면 안 된다
  //    (삼순 2026-08-15: Number.isInteger + 도메인 상한까지 — 과대값·소수는 upstream 열화 신호)
  for (const bad of [
    { BALL_CN: "3" },            // 문자열
    { OUT_CN: Number.NaN },       // NaN
    { STRIKE_CN: -1 },            // 음수
    { BALL_CN: 99 },              // 과대값(도메인 상한 초과)
    { OUT_CN: 1.5 },              // 소수
    { STRIKE_CN: 7 },             // 상한 초과
    { B1_BAT_ORDER_NO: 12 },      // 타순 상한(9) 초과
    { B2_BAT_ORDER_NO: 2.5 },     // 타순 소수
  ]) {
    const key = Object.keys(bad)[0];
    const g = await parseKboRaw(kboRawLive(bad));
    check(`KBO live 비정상값(${key}=${String(Object.values(bad)[0])}) → flag=false`,
      g.liveDetailFromKbo === false, `실제 ${g.liveDetailFromKbo}`);
    check(`KBO live 비정상값(${key}) → 값도 degrade`, degradedValuesOnly(g));
  }

  // ── ③-2 순간 관측 경계값(4B/3S/3O)은 정상 — 상한을 표기 도메인(3/2/2)으로 잡으면
  //    볼넷/삼진/이닝종료 순간의 정상 피드가 '준비 중'으로 오판된다(과차단 방지 경계).
  const edge = await parseKboRaw(kboRawLive({ BALL_CN: 4, STRIKE_CN: 3, OUT_CN: 3 }));
  check("KBO live 순간 경계값(4B/3S/3O) → 정상 관측값(flag=true)", edge.liveDetailFromKbo === true);

  // ── ④ Naver degrade: 상세가 아예 없는 소스
  const nv = mapNaverGameToKbo(naverRawLive(), "20260815", new Date("2026-08-15T19:00:00+09:00"));
  check("Naver 매핑 → flag=false", nv.liveDetailFromKbo === false, `실제 ${nv.liveDetailFromKbo}`);
  check("Naver 매핑 → 값 degrade", degradedValuesOnly(nv));

  // ── ⑤ 병합: 같은 라이브 순간이면 KBO 관측값 + flag 를 함께 오버레이
  const same = mergeKboEnrichment([{ ...nv }], [{ ...ok, gameId: nv.gameId, inning: nv.inning, isTop: nv.isTop, awayScore: nv.awayScore, homeScore: nv.homeScore }]);
  check("병합(동일 순간) → flag=true", same[0].liveDetailFromKbo === true, `실제 ${same[0].liveDetailFromKbo}`);
  check("병합(동일 순간) → KBO 값 오버레이", same[0].balls === 3 && same[0].outs === 1);

  // ── ⑥ 병합: 시점 불일치(이닝/스코어 상이)면 값도 flag 도 오버레이하지 않는다
  const drift = mergeKboEnrichment([{ ...nv }], [{ ...ok, gameId: nv.gameId, inning: nv.inning + 1, isTop: nv.isTop, awayScore: nv.awayScore, homeScore: nv.homeScore }]);
  check("병합(시점 불일치) → flag=false", drift[0].liveDetailFromKbo === false, `실제 ${drift[0].liveDetailFromKbo}`);
  check("병합(시점 불일치) → 값도 degrade 유지", degradedValuesOnly(drift[0]));

  // ── ⑦ KBO timeout(enrich 없음) → Naver 단독
  const timeout = mergeKboEnrichment([{ ...nv }], []);
  check("KBO timeout(enrich 0건) → flag=false", timeout[0].liveDetailFromKbo === false);
  check("KBO timeout(enrich 0건) → 값 degrade", degradedValuesOnly(timeout[0]));

  // ── ⑧ 전역 불변식: flag=false 인 모든 결과는 값이 degrade 여야 한다
  const all = [nv, drift[0], timeout[0]];
  check("불변식: flag=false ⇒ 값 degrade (전수)", all.every((g) => g.liveDetailFromKbo || degradedValuesOnly(g)));

  // ── ⑨-0 mapper 배선 (삼순 2026-08-15): route 응답과 카드 사이의 games/page.tsx mapper 가
  //    liveDetailFromKbo 를 실제로 전달하는가. 이 한 줄이 빠지면 카드는 영원히 '준비 중'이 되고
  //    (fail-close 방향이라 안전하지만) 기능이 죽는다 — 값 검증만으로는 잡힐 수 없다.
  {
    const src = readFileSync(resolve(import.meta.dirname, "../../src/app/(main)/games/page.tsx"), "utf8");
    check("mapper 배선: games/page.tsx 가 liveDetailFromKbo 를 카드로 전달",
      /liveDetailFromKbo:\s*g\.liveDetailFromKbo/.test(src));
    check("mapper 배선: 응답 타입에도 liveDetailFromKbo 선언 존재",
      /liveDetailFromKbo\?:\s*boolean/.test(src));
  }

  // ── ⑨ route 종단 (삼순 2026-08-15): 실제 KBO abort → /api/games GET → 응답 flag=false
  //    병합 함수 단위가 아니라 production route 모듈을 그대로 실행해 배선을 고정한다.
  await routeEndToEnd();

  // ── ⑩ 카드 DOM 종단: flag=false live 카드가 '준비 중'을 그리고 BSO 를 그리지 않는지,
  //    flag=true 면 BSO/다이아몬드를 그리는지 — 실제 CompactGameCard 렌더로 확인한다.
  await cardEndToEnd();
}

/** ⑨ production /api/games route 를 실제로 태운다 — KBO 는 abort, Naver 는 정상. */
async function routeEndToEnd() {
  const naverBody = {
    code: 200, success: true,
    result: { games: [naverRawLive()] },
  };
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("koreabaseball.com")) {
      // 실제 KBO timeout 이 던지는 것과 동일한 AbortError 를 던진다.
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    if (url.includes("api-gw.sports.naver.com") || url.includes("naver")) {
      return new Response(JSON.stringify(naverBody), { status: 200, headers: { "content-type": "application/json" } });
    }
    // 문자중계 self-fetch 등 그 외 호출은 조용히 실패(목록 응답은 유지되어야 한다)
    throw new Error(`unexpected fetch in gate: ${url}`);
  }) as typeof fetch;
  try {
    const { GET } = await import("@/app/api/games/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest("http://localhost/api/games?date=20260815"));
    const body = await res.json();
    check("route 종단: KBO abort 에도 200 + 경기 반환", res.status === 200 && Array.isArray(body.games) && body.games.length === 1,
      `status=${res.status} games=${body?.games?.length}`);
    const g = body.games?.[0] ?? {};
    check("route 종단: KBO abort → liveDetailFromKbo=false 가 응답까지 전파", g.liveDetailFromKbo === false,
      `실제 ${String(g.liveDetailFromKbo)}`);
    check("route 종단: 값도 degrade 유지", g.balls === 0 && g.strikes === 0 && g.outs === 0);
  } finally {
    globalThis.fetch = orig;
  }
}

/** ⑩ 실제 CompactGameCard 를 JSDOM 에 렌더해 '준비 중' ↔ BSO 분기를 확인한다. */
async function cardEndToEnd() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true, url: "http://localhost/",
  });
  const g = globalThis as Record<string, unknown>;
  const prev = {
    window: g.window, document: g.document, navigator: g.navigator,
    HTMLElement: g.HTMLElement, self: g.self, requestIdleCallback: g.requestIdleCallback,
  };
  g.window = dom.window; g.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  g.HTMLElement = dom.window.HTMLElement;
  // next/link 가 prefetch 관츰을 걸 때 `self` / requestIdleCallback 을 직접 참조한다(JSDOM 에 없음).
  g.self = dom.window;
  g.requestIdleCallback = ((cb: () => void) => dom.window.setTimeout(cb, 0)) as unknown;
  (dom.window as unknown as Record<string, unknown>).requestIdleCallback = g.requestIdleCallback;
  g.cancelIdleCallback = ((id: number) => dom.window.clearTimeout(id)) as unknown;
  (dom.window as unknown as Record<string, unknown>).cancelIdleCallback = g.cancelIdleCallback;
  try {
    const React = (await import("react")).default;
    // client createRoot 는 JSDOM 에서 scheduler(MessageChannel) 충돌로 프로세스 exit 를 깨뜨린다.
    // 여기서 필요한 건 렌더 결과 마크업이므로 서버 렌더러로 실제 캴포넌트를 그대로 태운다.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Card = (await import("@/components/game/CompactGameCard")).default;
    const baseGame = {
      id: "20260815SSLG0", awayTeamId: 4, homeTeamId: 1, awayScore: 3, homeScore: 5,
      status: "live" as const, inning: "7회초", time: "18:30", stadium: "잠실",
      balls: 0, strikes: 0, outs: 0, runnersOn: { first: false, second: false, third: false },
      currentPitcher: "", currentBatter: "",
    };
    const render = (game: Record<string, unknown>) =>
      renderToStaticMarkup(React.createElement(Card, { game } as never));
    const degraded = render({ ...baseGame, liveDetailFromKbo: false });
    check("카드 종단: flag=false → '실시간 상세 준비 중' 표시", degraded.includes("실시간 상세 준비 중"));
    check("카드 종단: flag=false → BSO/다이아몬드 미렌더(거짓 0-0-0 없음)",
      !degraded.includes("aria-label=\"주자") && !/>B</.test(degraded));
    const observed = render({ ...baseGame, liveDetailFromKbo: true, balls: 3, strikes: 2, outs: 1, runnersOn: { first: true, second: false, third: true }, currentPitcher: "김진성", currentBatter: "오스틴" });
    check("카드 종단: flag=true → BSO·다이아몬드·투타 렌더", observed.includes("aria-label=\"주자 1루·3루\"") && observed.includes("김진성") && !observed.includes("실시간 상세 준비 중"));
    const noField = render({ ...baseGame, liveDetailFromKbo: undefined });
    check("카드 종단: 필드 부재(구호출부) → fail-close('준비 중')", noField.includes("실시간 상세 준비 중"));
  } finally {
    g.window = prev.window; g.document = prev.document; g.HTMLElement = prev.HTMLElement;
    g.self = prev.self; g.requestIdleCallback = prev.requestIdleCallback;
    Object.defineProperty(globalThis, "navigator", { value: prev.navigator, configurable: true });
  }

  console.log();
  if (SELFTEST) {
    if (failed === 0) {
      console.error("✗ SELFTEST FAILED — 기대를 반전했는데 전부 통과했다. 게이트에 검출력이 없다.");
      process.exit(1);
    }
    console.log(`✓ SELFTEST PASS — 반전 시 ${failed}건 RED (검출력 확인)`);
    return;
  }
  if (failed > 0) {
    console.error(`✗ FAIL — ${failed}건`);
    process.exit(1);
  }
  console.log("✓ PASS — 전 시나리오 통과");
}

main().catch((e) => {
  console.error("✗ ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
