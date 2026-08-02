/**
 * D7(실책 목격) 태그 회귀 — 하린아빠 2026-08-02
 * "유독 실책을 많이 보는 발암경기 인내형" / "태그는 사소하고 많을수록 좋아".
 *
 * 검증 축:
 *  ① 임계 `ERROR_PRONE_MIN` 이 **실측 분포 근거**를 갖는가 (무근거 상수 재발 차단)
 *  ② 미확인 경기를 0으로 세지 않는가 (조회 실패가 "실책 없음"으로 둔갑 금지)
 *  ③ 태그가 단조·도달 가능한가 (도달 불가 등급만 만들지 않기 — awayFanTag 교훈)
 */
import {
  ERROR_PRONE_MIN,
  MEASURED_TEAM_GAME_ERRORS,
  venueErrorTags,
} from "../../src/lib/venue-stats/ui";
import type { D7Value } from "../../src/lib/venue-stats/types";

let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const d7 = (over: Partial<D7Value>): D7Value => ({
  myTeamErrors: 0,
  opponentErrors: 0,
  errorProneGames: 0,
  myErrorsPerGame: 0,
  knownGames: 5,
  worstGame: null,
  ...over,
});

console.log("D7 실책 태그 — 실측 분포 임계 + 확인된 경기만 분모");

// ── ① 임계 근거: 실측 분포에서 유의미한 상위 구간인가 ──────────────────────
{
  const h = MEASURED_TEAM_GAME_ERRORS.histogram;
  const total = MEASURED_TEAM_GAME_ERRORS.teamGames;
  const sum = Object.values(h).reduce((a, b) => a + b, 0);
  ok("히스토그램 합 = 팀-경기 수(실측 자체 정합)", sum === total, `${sum} vs ${total}`);

  const atOrAbove = (k: number) =>
    Object.entries(h)
      .filter(([e]) => Number(e) >= k)
      .reduce((a, [, c]) => a + c, 0) / total;

  const share = atOrAbove(ERROR_PRONE_MIN);
  console.log(`    실측: >=1 ${(atOrAbove(1) * 100).toFixed(1)}% · >=2 ${(atOrAbove(2) * 100).toFixed(1)}% · >=3 ${(atOrAbove(3) * 100).toFixed(1)}%`);
  ok(
    `임계 ${ERROR_PRONE_MIN}개 이상이 20% 이하 (너무 흔하면 '발암'이 아니다)`,
    share <= 0.2,
    `${(share * 100).toFixed(1)}%`,
  );
  ok(
    `임계 ${ERROR_PRONE_MIN}개 이상이 3% 이상 (너무 희귀하면 도달 불가 등급)`,
    share >= 0.03,
    `${(share * 100).toFixed(1)}%`,
  );
  // RED — 임계를 1로 내리면 47.5%가 발암경기가 되어 상한을 깬다.
  ok("임계 1은 상한 초과(=1로 내리면 FAIL)", atOrAbove(1) > 0.2, `${(atOrAbove(1) * 100).toFixed(1)}%`);
  // RED — 3으로 올리면 5.2%라 직관 1~4경기 유저는 사실상 도달 불가.
  ok("임계 3은 하한 근처로 희귀", atOrAbove(3) < 0.1, `${(atOrAbove(3) * 100).toFixed(1)}%`);
  ok(
    "평균 실책이 임계보다 작다(임계가 평균 이하로 내려가면 변별력 없음)",
    MEASURED_TEAM_GAME_ERRORS.meanPerTeamGame < ERROR_PRONE_MIN,
    `${MEASURED_TEAM_GAME_ERRORS.meanPerTeamGame}`,
  );
}

// ── ② 미확인/표본 fail-close ────────────────────────────────────────────
{
  ok("D7 값 없음(미확인) → 태그 없음",
    venueErrorTags(null).heavy === null && venueErrorTags(null).clean === null);
  ok("undefined → 태그 없음", venueErrorTags(undefined).heavy === null);
  ok("확인된 경기 0건 → 태그 없음",
    venueErrorTags(d7({ knownGames: 0, myTeamErrors: 0 })).heavy === null);
  ok("errorProneGames 비유한값 → 태그 없음",
    venueErrorTags(d7({ errorProneGames: Number.NaN, myTeamErrors: 9 })).heavy === null);
}

// ── ③ 표본 가드는 태그 성격별로 다르다 (삼순 P1 2026-08-02) ────────────────
// 실측 48명 분포는 1경기 43 · 2경기 4 · 4경기 1 이다. 네 태그 모두 3경기+를 요구하면
// 47/48명이 어떤 태그에도 도달하지 못한다 — "사소한 태그도 많이"와 정반대.
{
  // 성향 주장은 3경기+ 필요.
  const oneGameHeavy = venueErrorTags(d7({
    knownGames: 1, myTeamErrors: 2, errorProneGames: 1,
    worstGame: { gameId: "g", date: "2026-07-25", errors: 2 },
  }));
  ok("1경기에서는 '발암경기 인내형'(성향 주장)을 붙이지 않는다",
    oneGameHeavy.heavy?.label !== "발암경기 인내형", JSON.stringify(oneGameHeavy.heavy));
  // 하지만 사실 서술은 1경기부터 성립해야 한다.
  ok("1경기여도 '실책 목격자'(사실 서술)는 붙는다",
    oneGameHeavy.heavy?.label === "실책 목격자", JSON.stringify(oneGameHeavy.heavy));

  ok("1경기 실책 0 → 무결점 수비 관람",
    venueErrorTags(d7({ knownGames: 1, myTeamErrors: 0 })).clean?.label === "무결점 수비 관람");
  ok("1경기 상대 실책 우위 → 상대 실책 수집가",
    venueErrorTags(d7({ knownGames: 1, myTeamErrors: 1, opponentErrors: 3 })).clean?.label
      === "상대 실책 수집가");

  // RED — 실측 P50(1경기) 유저가 어떤 태그에도 못 닿으면 FAIL.
  const p50Cases = [
    d7({ knownGames: 1, myTeamErrors: 0 }),
    d7({ knownGames: 1, myTeamErrors: 2, errorProneGames: 1 }),
    d7({ knownGames: 1, myTeamErrors: 1, opponentErrors: 3 }),
  ];
  ok(
    "실측 P50(1경기) 유저도 태그에 도달 가능(도달 불가 등급만 만들지 않기)",
    p50Cases.every((v) => {
      const t = venueErrorTags(v);
      return t.heavy != null || t.clean != null;
    }),
  );

  // 3경기+ 과반이면 성향 태그로 승격.
  const heavy = venueErrorTags(d7({
    myTeamErrors: 8, errorProneGames: 3, knownGames: 5,
    worstGame: { gameId: "20260725LGHH0", date: "2026-07-25", errors: 3 },
  })).heavy;
  ok("3경기+ 발암경기 과반 → 발암경기 인내형", heavy?.label === "발암경기 인내형", JSON.stringify(heavy));
  ok("근거에 발암경기/분모 표기", heavy?.value.includes("3/5") === true, heavy?.value);
  ok("최악 경기도 근거에 포함", heavy?.value.includes("한 경기 3실책") === true, heavy?.value);

  const moderate = venueErrorTags(d7({
    myTeamErrors: 3, errorProneGames: 1, knownGames: 5,
    worstGame: { gameId: "g", date: "2026-07-25", errors: 2 },
  })).heavy;
  ok("발암경기 소수 → 실책 목격자", moderate?.label === "실책 목격자", JSON.stringify(moderate));

  ok("발암경기 0 → heavy 없음",
    venueErrorTags(d7({ myTeamErrors: 2, errorProneGames: 0, knownGames: 5 })).heavy === null);
}

// ── ④ 반대편 태그 ─────────────────────────────────────────────────────────
{
  const clean = venueErrorTags(d7({ myTeamErrors: 0, knownGames: 6 })).clean;
  ok("내 팀 실책 0 → 무결점 수비 관람", clean?.label === "무결점 수비 관람", JSON.stringify(clean));
  ok("무결점 근거에 분모 표기", clean?.value.includes("6경기") === true, clean?.value);

  const both = venueErrorTags(d7({
    myTeamErrors: 9, opponentErrors: 20, errorProneGames: 3, knownGames: 5,
  }));
  ok("heavy 와 clean 동시 노출 금지",
    !(both.heavy != null && both.clean != null), JSON.stringify(both));
}

// ── ⑤ 단조성 — 발암경기가 늘수록 등급 역행 없음 ───────────────────────────
{
  const rank = (v: D7Value) => {
    const t = venueErrorTags(v).heavy?.label ?? null;
    return t === "발암경기 인내형" ? 2 : t === "실책 목격자" ? 1 : 0;
  };
  let prev = -1;
  let monotone = true;
  for (let n = 0; n <= 5; n += 1) {
    const r = rank(d7({ myTeamErrors: n * 2, errorProneGames: n, knownGames: 5 }));
    if (r < prev) monotone = false;
    prev = r;
  }
  ok("발암경기가 늘수록 등급 역행 없음", monotone);
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
