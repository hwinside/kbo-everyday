/**
 * 현재타석 카드 투수-하프 정합성 가드 결함주입 게이트.
 *
 * 근인(2026-09-03 실측): 경기룸이 타자(relay 3초)와 투수(game-live 10초)를 서로 다른
 * 주기로 폴링해, 하프 전환 window 에 "신선한 타자 + 이전 하프 stale 투수"가 섞여
 * 교차팀(투수팀==공격팀) 매치업이 렌더됐다(7회초 롯데 전민재 vs 롯데 비슬리).
 *
 * production seam = src/lib/game/current-pitcher-consistency.ts 의 resolveConsistentPitcher /
 * isPitcherHalfStale. 이 게이트는 그 *실제 함수*를 import 해 실행한다(사본 아님).
 *
 * 검증:
 *  M(measure): 실제 함수가 교차팀 stale 을 폐기(null)하고, 정합/판정불가는 유지하는가.
 *  --selftest: 함수 계약을 반전한 mutant 를 주입해 이 게이트가 RED 를 내는가(검증력 증명).
 */
import assert from "node:assert/strict";
import {
  resolveConsistentPitcher,
  isPitcherHalfStale,
} from "../../src/lib/game/current-pitcher-consistency.ts";

const SELFTEST = process.argv.includes("--selftest");

// 실측 재현 픽스처: 롯데(away):삼성(home), 7회초(롯데 공격 → 투수=삼성).
// 비슬리=롯데 투수(이전 하프 '말'에서 던짐), 원태인·사토시=삼성 투수.
const LOTTE_PITCHERS = ["비슬리", "정현수", "김원중"];
const SAMSUNG_PITCHERS = ["원태인", "사토시", "임기영"];

const cases = [
  {
    name: "7회초 stale 투수(비슬리=공격팀 롯데) → 폐기",
    input: {
      currentPitcher: "비슬리",
      relayHalf: "top", // 공격=away(롯데), 수비=home(삼성)
      awayPitcherNames: LOTTE_PITCHERS,
      homePitcherNames: SAMSUNG_PITCHERS,
    },
    expectStale: true,
    expectResolved: null,
  },
  {
    name: "7회초 정합 투수(사토시=수비팀 삼성) → 유지",
    input: {
      currentPitcher: "사토시",
      relayHalf: "top",
      awayPitcherNames: LOTTE_PITCHERS,
      homePitcherNames: SAMSUNG_PITCHERS,
    },
    expectStale: false,
    expectResolved: "사토시",
  },
  {
    name: "7회말 stale 투수(사토시=공격팀 삼성) → 폐기",
    input: {
      currentPitcher: "사토시",
      relayHalf: "bottom", // 공격=home(삼성), 수비=away(롯데)
      awayPitcherNames: LOTTE_PITCHERS,
      homePitcherNames: SAMSUNG_PITCHERS,
    },
    expectStale: true,
    expectResolved: null,
  },
  {
    name: "7회말 정합 투수(비슬리=수비팀 롯데) → 유지",
    input: {
      currentPitcher: "비슬리",
      relayHalf: "bottom",
      awayPitcherNames: LOTTE_PITCHERS,
      homePitcherNames: SAMSUNG_PITCHERS,
    },
    expectStale: false,
    expectResolved: "비슬리",
  },
  {
    name: "하프 미상(relay 없음) → 가드 미적용(유지)",
    input: {
      currentPitcher: "비슬리",
      relayHalf: null,
      awayPitcherNames: LOTTE_PITCHERS,
      homePitcherNames: SAMSUNG_PITCHERS,
    },
    expectStale: false,
    expectResolved: "비슬리",
  },
  {
    name: "어느 팀 명단에도 없음(외국인 표기 흔들림) → fail-safe 유지",
    input: {
      currentPitcher: "비슬리 ", // 정규 후행 공백(trim 대상)
      relayHalf: "top",
      awayPitcherNames: ["비슬 리"], // 표기 흔들림 → 정규화해도 불일치
      homePitcherNames: SAMSUNG_PITCHERS,
    },
    expectStale: false,
    expectResolved: "비슬리", // trim 후 유지(어느 명단에도 없음 → 폐기 안 함)
  },
  {
    name: "boxScore 명단 결측(null) → fail-safe 유지",
    input: {
      currentPitcher: "비슬리",
      relayHalf: "top",
      awayPitcherNames: null,
      homePitcherNames: null,
    },
    expectStale: false,
    expectResolved: "비슬리",
  },
  {
    name: "투수명 없음 → null",
    input: {
      currentPitcher: "",
      relayHalf: "top",
      awayPitcherNames: LOTTE_PITCHERS,
      homePitcherNames: SAMSUNG_PITCHERS,
    },
    expectStale: false,
    expectResolved: null,
  },
  {
    name: "공백 정규화(양쪽 명단에 공백 포함) → stale 판정 유지",
    input: {
      currentPitcher: " 비슬리 ",
      relayHalf: "top",
      awayPitcherNames: [" 비슬리 "],
      homePitcherNames: SAMSUNG_PITCHERS,
    },
    expectStale: true,
    expectResolved: null,
  },
];

// --selftest: 실제 함수 계약을 반전한 mutant. 게이트가 이 mutant 를 RED 로 잡아야 한다.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- mutant 계약 대칭성(isPitcherHalfStale 시그니처 미러)
function mutantStale(input) {
  // MUTANT: 하프 정합성을 무시하고 항상 정합(폐기 안 함)이라 주장.
  return false;
}
function mutantResolve(input) {
  // MUTANT: stale 이어도 원본 투수를 그대로 반환(가드 무력화).
  return (input.currentPitcher ?? "").trim() || null;
}

const staleFn = SELFTEST ? mutantStale : isPitcherHalfStale;
const resolveFn = SELFTEST ? mutantResolve : resolveConsistentPitcher;

let pass = 0;
let mutantCaught = false;
for (const c of cases) {
  const gotStale = staleFn(c.input);
  const gotResolved = resolveFn(c.input);
  try {
    assert.equal(gotStale, c.expectStale, `[stale] ${c.name}: got ${gotStale}, want ${c.expectStale}`);
    assert.equal(gotResolved, c.expectResolved, `[resolve] ${c.name}: got ${JSON.stringify(gotResolved)}, want ${JSON.stringify(c.expectResolved)}`);
    console.log(`✓ ${c.name}`);
    pass++;
  } catch (e) {
    if (SELFTEST) {
      mutantCaught = true;
      console.log(`✗ (expected under mutant) ${c.name}`);
    } else {
      console.error(`✗ ${c.name}\n  ${e.message}`);
      process.exitCode = 1;
    }
  }
}

if (SELFTEST) {
  // mutant 가 최소 1개 교차팀 케이스에서 잡혀야 검증력이 증명된다.
  assert.ok(mutantCaught, "SELFTEST FAIL: mutant 가 어떤 케이스도 위반하지 않았다 = 게이트 검증력 없음");
  console.log("\n✓ SELFTEST: mutant 를 RED 로 검출함(게이트 검증력 확인)");
} else {
  assert.equal(pass, cases.length, `expected all ${cases.length} cases to pass, got ${pass}`);
  console.log(`\n✓ current-pitcher-consistency: ${pass}/${cases.length} PASS`);
}
