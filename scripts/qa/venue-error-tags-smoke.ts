/**
 * D7(실책 목격) 집계 + 태그 회귀 — 하린아빠 2026-08-02
 * "유독 실책을 많이 보는 발암경기 인내형" / "태그는 사소하고 많을수록 좋아".
 *
 * 핵심 계약: `errors` 는 canonical hash 바깥 enrichment 라 경기별 **미상(NULL)** 이 있다.
 * 미상을 0으로 세면 "실책을 안 본 사람"으로 둔갑하므로, 아는 경기만 분모로 쓴다.
 */

import { ERROR_TAG_THRESHOLDS, venueErrorTags } from "../../src/lib/venue-stats/ui";
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
  myErrorsPerGame: 0,
  knownGames: 5,
  worstGame: null,
  ...over,
});

console.log("D7 실책 태그 — 아는 경기만 분모 + 임계 계약");

// ── ① 표본/미상 fail-close ────────────────────────────────────────────────
{
  ok("D7 값 없음(미상) → 태그 없음",
    venueErrorTags(null).heavy === null && venueErrorTags(null).clean === null);
  ok("undefined → 태그 없음", venueErrorTags(undefined).heavy === null);
  // 아는 경기가 최소 표본 미만이면 어떤 주장도 하지 않는다.
  ok("아는 경기 2건(최소 표본 미만) → 태그 없음",
    venueErrorTags(d7({ knownGames: 2, myTeamErrors: 6, myErrorsPerGame: 3 })).heavy === null);
  ok("myErrorsPerGame null → 태그 없음",
    venueErrorTags(d7({ myErrorsPerGame: null, myTeamErrors: 9 })).heavy === null);
  ok("myErrorsPerGame 비유한값 → 태그 없음",
    venueErrorTags(d7({ myErrorsPerGame: Number.POSITIVE_INFINITY })).heavy === null);
}

// ── ② 발암경기 인내형 (하린아빠 지시 태그 본체) ────────────────────────────
{
  const heavy = venueErrorTags(d7({
    myTeamErrors: 8, myErrorsPerGame: 1.6, knownGames: 5,
  })).heavy;
  ok("경기당 1.5 이상 → 발암경기 인내형",
    heavy?.label === "발암경기 인내형", JSON.stringify(heavy));
  ok("근거에 실책 수와 분모(아는 경기)를 함께 표기",
    heavy?.value.includes("8실책") === true && heavy?.value.includes("5경기") === true,
    heavy?.value);

  // 최악 경기가 2실책 이상이면 더 구체적으로(태그는 사소할수록 재밌다).
  const withWorst = venueErrorTags(d7({
    myTeamErrors: 8, myErrorsPerGame: 1.6, knownGames: 5,
    worstGame: { gameId: "20260725LGHH0", date: "2026-07-25", errors: 3 },
  })).heavy;
  ok("최악 경기 3실책 → 근거에 포함",
    withWorst?.value.includes("한 경기 3실책") === true, withWorst?.value);

  // 1실책짜리 최악 경기는 굳이 강조하지 않는다.
  const trivialWorst = venueErrorTags(d7({
    myTeamErrors: 8, myErrorsPerGame: 1.6, knownGames: 5,
    worstGame: { gameId: "g", date: "2026-07-25", errors: 1 },
  })).heavy;
  ok("최악 경기 1실책이면 강조하지 않음",
    trivialWorst?.value.includes("한 경기") === false, trivialWorst?.value);
}

// ── ③ 임계 경계 — 상수 되돌림 차단 ────────────────────────────────────────
{
  ok("임계 상수가 선언되어 있다",
    ERROR_TAG_THRESHOLDS.heavy === 1.5 && ERROR_TAG_THRESHOLDS.moderate === 1.0,
    JSON.stringify(ERROR_TAG_THRESHOLDS));

  const at = (perGame: number) =>
    venueErrorTags(d7({ myTeamErrors: Math.round(perGame * 5), myErrorsPerGame: perGame, knownGames: 5 })).heavy?.label ?? null;

  ok("1.5 경계 = 발암경기 인내형", at(ERROR_TAG_THRESHOLDS.heavy) === "발암경기 인내형");
  ok("1.49 는 실책 목격자", at(1.49) === "실책 목격자");
  ok("1.0 경계 = 실책 목격자", at(ERROR_TAG_THRESHOLDS.moderate) === "실책 목격자");
  ok("0.99 는 실책 태그 없음", at(0.99) === null, String(at(0.99)));

  // 단조성 — 실책이 늘수록 등급이 내려가지 않는다.
  const rank = (label: string | null) =>
    label === "발암경기 인내형" ? 2 : label === "실책 목격자" ? 1 : 0;
  let prev = -1;
  let monotone = true;
  for (let v = 0; v <= 3; v += 0.1) {
    const r = rank(at(Number(v.toFixed(2))));
    if (r < prev) monotone = false;
    prev = r;
  }
  ok("실책이 늘수록 등급 역행 없음", monotone);
}

// ── ④ 반대편 태그 (많을수록 좋다 — 사소한 태그 확대) ──────────────────────
{
  const clean = venueErrorTags(d7({
    myTeamErrors: 0, myErrorsPerGame: 0, knownGames: 6,
  })).clean;
  ok("내 팀 실책 0 → 무결점 수비 관람", clean?.label === "무결점 수비 관람", JSON.stringify(clean));
  ok("무결점 근거에 분모 표기", clean?.value.includes("6경기") === true, clean?.value);

  const reflected = venueErrorTags(d7({
    myTeamErrors: 1, opponentErrors: 4, myErrorsPerGame: 0.2, knownGames: 5,
  })).clean;
  ok("상대 실책이 2배 초과 → 상대 실책 수집가",
    reflected?.label === "상대 실책 수집가", JSON.stringify(reflected));

  // heavy 와 clean 은 동시에 뜨지 않는다(모순 태그 금지).
  const both = venueErrorTags(d7({
    myTeamErrors: 9, opponentErrors: 20, myErrorsPerGame: 1.8, knownGames: 5,
  }));
  ok("heavy 와 clean 동시 노출 금지",
    !(both.heavy != null && both.clean != null),
    JSON.stringify(both));
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
