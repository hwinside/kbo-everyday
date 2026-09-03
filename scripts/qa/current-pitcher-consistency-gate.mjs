/**
 * 크관 현재타석 카드 교차팀 매치업 방지 — 투수-하프 정합성 가드 결함주입 게이트.
 *
 * 근인(2026-09-03 실측): 경기룸이 타자(relay 3초)와 투수(game-live 10초)를 서로 다른
 * 주기로 폴링해, 하프 전환 window 에 "신선한 타자 + 이전 하프 stale 투수"가 섞여
 * 교차팀(투수팀==공격팀) 매치업이 렌더됐다(7회초 롯데 전민재 vs 롯데 비슬리).
 *
 * ⚠️ 삼순 리뷰 ② 반영: 순수 resolver 만 검사하면 deriveGameState/latestRelayHalf wiring 을
 * 제거해도 GREEN 이라 검증력이 없다. 이 게이트는 **실제 카드 seam**
 * `resolveCurrentAtBatCardPitcher(latestInning, currentPitcher, boxScore)` 를 직접 import 해
 * 태운다(사본 아님). 이 함수 안에서 ①latestInning.half 추출 ②정합성 가드 호출이
 * 둘 다 일어나야 통과하도록 픽스처를 짠다 → 둘 중 하나라도 제거하면 RED.
 *
 * 추가로 KgwanTab 소스가 raw currentPitcher 가 아니라 이 seam 결과를 카드에 넘기는지
 * source-assertion 으로 wiring 을 고정한다.
 *
 * 검증:
 *  M(measure): 실제 seam 이 정/역방향 skew·실측 별칭(비슬리↔제러미 비슬리)을 폐기하고,
 *              정상 수비팀·양팀 동명이인·명단 지연은 보존하는가.
 *  --selftest: seam 의 half 추출 또는 가드 호출을 제거한 mutant 를 주입해 RED 를 내는가.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCurrentAtBatCardPitcher } from "../../src/lib/game/current-at-bat.ts";
import { resolveConsistentPitcher } from "../../src/lib/game/current-pitcher-consistency.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SELFTEST = process.argv.includes("--selftest");

// 실측 재현: 롯데(away):삼성(home). boxScore 는 풀네임(제러미 비슬리), game-live 는 단축(비슬리).
const BOX = {
  awayPitchers: [{ name: "제러미 비슬리" }, { name: "박정민" }, { name: "최준용" }, { name: "이이무라" }],
  homePitchers: [{ name: "원태인" }, { name: "김태훈" }, { name: "장찬희" }, { name: "사토시" }, { name: "임기영" }],
};
const inn = (half) => ({ inning: 7, half, teamName: half === "top" ? "롯데" : "삼성", plays: [] });

// selftest mutant: seam 을 두 방식으로 훼손해 검증력을 증명한다.
//  A) half 추출 제거(항상 undefined) → 가드 미적용 → 교차팀 통과(RED 나야 함)
//  B) 가드 호출 제거(currentPitcher 그대로 반환) → 교차팀 통과(RED 나야 함)
function mutantSeamNoHalf({ currentPitcher, boxScore }) {
  return resolveConsistentPitcher({
    currentPitcher,
    relayHalf: undefined, // MUTANT: latestInning.half 추출 누락
    awayPitcherNames: boxScore?.awayPitchers?.map((p) => p.name) ?? null,
    homePitcherNames: boxScore?.homePitchers?.map((p) => p.name) ?? null,
  });
}
function mutantSeamNoGuard({ currentPitcher }) {
  return (currentPitcher ?? "").trim() || null; // MUTANT: 가드 호출 제거
}

const seam = SELFTEST
  ? (args) => (process.env.MUT === "guard" ? mutantSeamNoGuard(args) : mutantSeamNoHalf(args))
  : resolveCurrentAtBatCardPitcher;

const cases = [
  {
    name: "정방향 skew: 7회초 stale 투수(비슬리=공격팀 롯데, 별칭 제러미 비슬리) → 폐기",
    args: { latestInning: inn("top"), currentPitcher: "비슬리", boxScore: BOX },
    expect: null,
    catchesNoHalf: true, // half 없으면 통과됨 → mutant RED
    catchesNoGuard: true,
  },
  {
    name: "역방향 skew: 7회말 stale 투수(사토시=공격팀 삼성) → 폐기",
    args: { latestInning: inn("bottom"), currentPitcher: "사토시", boxScore: BOX },
    expect: null,
    catchesNoHalf: true,
    catchesNoGuard: true,
  },
  {
    name: "정상: 7회초 수비팀 삼성 투수(원태인) → 유지",
    args: { latestInning: inn("top"), currentPitcher: "원태인", boxScore: BOX },
    expect: "원태인",
    catchesNoHalf: false,
    catchesNoGuard: false,
  },
  {
    name: "정상: 7회말 수비팀 롯데 투수(비슬리 별칭) → 유지",
    args: { latestInning: inn("bottom"), currentPitcher: "비슬리", boxScore: BOX },
    expect: "비슬리",
    catchesNoHalf: false,
    catchesNoGuard: false,
  },
  {
    name: "양팀 동명이인(양쪽 명단에 동일명) → 미확정 보존(유지)",
    args: {
      latestInning: inn("top"),
      currentPitcher: "김철수",
      boxScore: { awayPitchers: [{ name: "김철수" }], homePitchers: [{ name: "김철수" }] },
    },
    expect: "김철수",
    catchesNoHalf: false,
    catchesNoGuard: false,
  },
  {
    name: "boxScore 명단 지연(빈 배열) → 보존(유지)",
    args: { latestInning: inn("top"), currentPitcher: "비슬리", boxScore: { awayPitchers: [], homePitchers: [] } },
    expect: "비슬리",
    catchesNoHalf: false,
    catchesNoGuard: false,
  },
  {
    name: "relay half 미상(latestInning null) → 가드 미적용(유지)",
    args: { latestInning: null, currentPitcher: "비슬리", boxScore: BOX },
    expect: "비슬리",
    catchesNoHalf: false,
    catchesNoGuard: false,
  },
  {
    name: "투수명 없음 → null",
    args: { latestInning: inn("top"), currentPitcher: "", boxScore: BOX },
    expect: null,
    catchesNoHalf: false,
    catchesNoGuard: false,
  },
];

function runMeasure() {
  let pass = 0;
  for (const c of cases) {
    const got = resolveCurrentAtBatCardPitcher(c.args);
    assert.equal(got, c.expect, `${c.name}: got ${JSON.stringify(got)}, want ${JSON.stringify(c.expect)}`);
    console.log(`✓ ${c.name}`);
    pass++;
  }
  // source wiring assertion: KgwanTab 이 raw currentPitcher 가 아니라 seam 결과를 카드에 넘긴다.
  const kgwan = fs.readFileSync(path.join(ROOT, "src/components/game/KgwanTab.tsx"), "utf8");
  assert.match(kgwan, /resolveCurrentAtBatCardPitcher\(/, "KgwanTab must call resolveCurrentAtBatCardPitcher");
  assert.match(kgwan, /pitcherName=\{cardPitcher\}/, "CurrentAtBatCard must receive the guarded cardPitcher, not raw currentPitcher");
  console.log("✓ KgwanTab wiring: 카드에 guarded cardPitcher 전달");
  console.log(`\n✓ current-pitcher-consistency: ${pass}/${cases.length} PASS + wiring`);
}

function runSelftest() {
  // 두 mutant(half 추출 제거 / 가드 호출 제거) 각각이 최소 1개 교차팀 케이스에서 RED 를 내야 한다.
  for (const mut of ["half", "guard"]) {
    process.env.MUT = mut;
    let caught = false;
    for (const c of cases) {
      const flag = mut === "half" ? c.catchesNoHalf : c.catchesNoGuard;
      if (!flag) continue;
      const got = seam(c.args);
      if (got !== c.expect) caught = true;
    }
    assert.ok(caught, `SELFTEST FAIL: mutant(${mut}) 가 교차팀 케이스에서 RED 를 못 냄 = 검증력 없음`);
    console.log(`✓ SELFTEST mutant(${mut}): 교차팀 케이스 RED 검출`);
  }
  console.log("\n✓ SELFTEST: half 추출·가드 호출 제거 mutant 둘 다 RED (seam wiring 검증력 확인)");
}

if (SELFTEST) runSelftest();
else runMeasure();
