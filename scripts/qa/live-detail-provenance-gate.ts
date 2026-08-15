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

  // ── ③ 비정상 타입(문자열/NaN/음수)도 관측값으로 취급하면 안 된다
  for (const bad of [{ BALL_CN: "3" }, { OUT_CN: Number.NaN }, { STRIKE_CN: -1 }]) {
    const key = Object.keys(bad)[0];
    const g = await parseKboRaw(kboRawLive(bad));
    check(`KBO live 비정상값(${key}=${String(Object.values(bad)[0])}) → flag=false`,
      g.liveDetailFromKbo === false, `실제 ${g.liveDetailFromKbo}`);
  }

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
