/**
 * 수비 실책 파싱·대조 회귀 (하린아빠 2026-08-02 `발암경기 인내형` 트랙).
 *
 * 계약:
 *  - 실측 표기 3형(`이름(N회)`, `이름K(N M회)`, 복수 선수)을 파싱한다.
 *  - 선수별 합계가 공식 `rheb` 팀 실책 수와 **팀 단위로 exact 일치**할 때만 채택.
 *  - 불일치·팀 미상·공식 합계 결측은 전부 null(미상) — 0으로 강등하지 않는다.
 */

import {
  extractErrorText,
  parseErrorText,
  parseTeamErrorTotal,
  reconcileGameErrors,
} from "../../src/lib/game-logs/errors";

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

console.log("game-log 실책 파싱 — 선수별 + 공식 팀합계 exact 대조");

// ── ① 실측 표기 파싱 (2026 실경기 8건에서 확인한 형식) ─────────────────────
{
  const cases: Array<[string, Record<string, number>]> = [
    ["오지환2(7 8회)", { 오지환: 2 }],
    ["이영빈(9회)", { 이영빈: 1 }],
    ["디아즈(4회) 김규성(8회)", { 디아즈: 1, 김규성: 1 }],
    ["김웅빈2(2 7회) 서건창(4회)", { 김웅빈: 2, 서건창: 1 }],
    ["", {}],
  ];
  for (const [text, expected] of cases) {
    const parsed = Object.fromEntries(parseErrorText(text));
    ok(`파싱 "${text || "(빈 문자열)"}"`, JSON.stringify(parsed) === JSON.stringify(expected),
      JSON.stringify(parsed));
  }
  // 심판명처럼 `(...회)` 가 없는 토큰은 이름으로 인정하지 않는다.
  ok("괄호 없는 토큰은 무시(심판명 오염 차단)",
    parseErrorText("김익수 배병두 전일수 김갑수").size === 0);
}

// ── ② rheb strict 파싱 — 0 강등 금지 ────────────────────────────────────
{
  ok("정상 값", parseTeamErrorTotal({ away: { e: 2 }, home: { e: 0 } }, "away") === 2);
  ok("0 은 유효한 값", parseTeamErrorTotal({ away: { e: 0 } }, "away") === 0);
  for (const bad of [undefined, null, "", "x", -1, 1.5]) {
    ok(`결측/이상치 ${JSON.stringify(bad)} → null(0 아님)`,
      parseTeamErrorTotal({ away: { e: bad } }, "away") === null);
  }
  ok("rheb 자체가 없으면 null", parseTeamErrorTotal(null, "away") === null);
}

// ── ③ 팀 단위 exact 대조 — 핵심 계약 ─────────────────────────────────────
{
  // 실측 재현: 20260725LGHH0 (away LG 오지환 2 / home HH 0)
  const lgAway = (name: string) => (name === "오지환" ? "away" as const : null);
  const good = reconcileGameErrors({
    errorText: "오지환2(7 8회)",
    rheb: { away: { e: 2 }, home: { e: 0 } },
    resolveTeam: lgAway,
  });
  ok("실측 경기 정합 → 채택", good != null && good.byPlayerName.get("오지환") === 2);
  ok("팀 총계 보존", good?.awayTotal === 2 && good?.homeTotal === 0);

  // 실책 0 경기
  const zero = reconcileGameErrors({
    errorText: "",
    rheb: { away: { e: 0 }, home: { e: 0 } },
    resolveTeam: () => null,
  });
  ok("실책 0 경기 → 빈 맵으로 채택(미상 아님)",
    zero != null && zero.byPlayerName.size === 0);

  // RED ①: 공식 합계는 0인데 선수 실책이 파싱됨 → 모순 → 미상
  ok("공식 0인데 선수 실책 존재 → null",
    reconcileGameErrors({
      errorText: "오지환(7회)",
      rheb: { away: { e: 0 }, home: { e: 0 } },
      resolveTeam: lgAway,
    }) === null);

  // RED ②: 개수 불일치 → 미상 (과소 집계 차단)
  ok("선수 합계 < 공식 합계 → null",
    reconcileGameErrors({
      errorText: "오지환(7회)",
      rheb: { away: { e: 2 }, home: { e: 0 } },
      resolveTeam: lgAway,
    }) === null);

  // RED ③: 합계는 맞는데 팀 배분이 틀림 → 미상
  //   (away 2 / home 0 인데 파싱분이 전부 home 으로 붙는 경우)
  ok("합계는 같지만 팀 배분 불일치 → null",
    reconcileGameErrors({
      errorText: "오지환2(7 8회)",
      rheb: { away: { e: 2 }, home: { e: 0 } },
      resolveTeam: () => "home",
    }) === null);

  // RED ④: 팀 미상 선수 1명이라도 있으면 전체 fail-close
  ok("팀 미상 선수 → 전체 null",
    reconcileGameErrors({
      errorText: "오지환(7회) 미등록선수(8회)",
      rheb: { away: { e: 2 }, home: { e: 0 } },
      resolveTeam: (n) => (n === "오지환" ? "away" : null),
    }) === null);

  // RED ⑤: 공식 합계 결측 → 대조 불가 → 미상
  ok("rheb 결측 → null",
    reconcileGameErrors({
      errorText: "오지환2(7 8회)",
      rheb: { away: {}, home: { e: 0 } },
      resolveTeam: lgAway,
    }) === null);

  // 양 팀 분산 케이스 — 20260728HTSS0 재현
  const split = reconcileGameErrors({
    errorText: "디아즈(4회) 김규성(8회)",
    rheb: { away: { e: 1 }, home: { e: 1 } },
    resolveTeam: (n) => (n === "디아즈" ? "away" : "home"),
  });
  ok("양 팀 1개씩 분산 → 채택",
    split != null && split.byPlayerName.size === 2);
}

// ── ④ etcRecords 추출 ───────────────────────────────────────────────────
{
  const etc = [
    { how: "홈런", result: "오스틴29호(1회1점 류현진)" },
    { how: "실책", result: "오지환2(7 8회)" },
    { how: "도루", result: "심우준(2회)" },
  ];
  ok("etcRecords 에서 실책만 추출", extractErrorText(etc) === "오지환2(7 8회)");
  ok("실책 항목 없으면 빈 문자열(=0경기, 미상 아님)",
    extractErrorText([{ how: "홈런", result: "x" }]) === "");
  ok("etcRecords 자체가 배열이 아니면 빈 문자열", extractErrorText(null) === "");
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
