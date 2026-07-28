/**
 * game-relay delta(증분) 폴링 헬퍼 스모크.
 * 실시간 손실 0 + 기능(지난 이닝 pitch-by-pitch 보관) 손실 0 을 회귀로 고정한다.
 *
 * 실행: npx tsx scripts/qa/relay-delta-smoke.ts
 */
import { filterDeltaInnings, mergeDeltaInnings, inningKey } from "../../src/lib/game/relay-delta";
import type { InningRelay } from "../../src/app/api/game-relay/route";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${name}`); }
}

function inn(inning: number, half: "top" | "bottom", plays: number): InningRelay {
  return {
    inning,
    half,
    teamName: `T${inning}${half}`,
    plays: Array.from({ length: plays }, (_, i) => ({
      batterName: `b${i}`,
      result: "안타",
      type: 1 as InningRelay["plays"][number]["type"],
      pitches: [{ count: "S", type: "직구", speed: 150 } as unknown as NonNullable<InningRelay["plays"][number]["pitches"]>[number]],
    })),
  };
}

// 9회까지 진행된 경기: 초/말 각각.
function fullGame(maxInning: number): InningRelay[] {
  const out: InningRelay[] = [];
  for (let i = 1; i <= maxInning; i++) {
    out.push(inn(i, "top", 3));
    out.push(inn(i, "bottom", 3));
  }
  return out;
}

// ---- filterDeltaInnings (server) ----
{
  const innings = fullGame(9); // 1~9회 초/말 = 18개
  // since<=0 → 전체(full)
  check("since=0 returns full", filterDeltaInnings(innings, 0).length === 18);
  check("since<0 returns full", filterDeltaInnings(innings, -1).length === 18);
  // since=8 → 직전(7)부터: 7,8,9회 = 6개
  const d8 = filterDeltaInnings(innings, 8);
  check("since=8 keeps inning>=7", d8.every((x) => x.inning >= 7));
  check("since=8 count 6", d8.length === 6);
  // since=9 → 8,9회 = 4개 (현재 이닝은 항상 완전 포함)
  const d9 = filterDeltaInnings(innings, 9);
  check("since=9 keeps inning>=8", d9.every((x) => x.inning >= 8));
  check("since=9 includes current inning fully", d9.some((x) => x.inning === 9 && x.half === "bottom"));
  // since=1 → min은 1로 clamp, 전체 유지(과소 방지)
  check("since=1 clamps to 1", filterDeltaInnings(innings, 1).length === 18);
}

// ---- mergeDeltaInnings (client) ----
{
  const cache = new Map<string, InningRelay>();
  // 1) 첫 full 로드
  const merged1 = mergeDeltaInnings(cache, fullGame(7), false);
  check("full load size 14", merged1.length === 14);
  check("cache holds 14", cache.size === 14);

  // 2) delta: 8회 진행 → 서버가 since=7 로 7,8회만 내려줌
  const delta = [inn(7, "top", 3), inn(7, "bottom", 3), inn(8, "top", 2)];
  const merged2 = mergeDeltaInnings(cache, delta, true);
  // 지난 이닝(1~6회)은 유지 + 8회 추가 = 15개
  check("delta merge keeps past innings", merged2.length === 15);
  check("delta merge added inning 8", merged2.some((x) => inningKey(x) === "8-top"));
  check("past inning 1 still present (pitches retained)", merged2.some((x) => x.inning === 1 && x.plays[0].pitches?.length === 1));

  // 3) delta 로 현재 이닝 play 추가(2→3구): 같은 키 교체
  const delta2 = [inn(8, "top", 3)];
  const merged3 = mergeDeltaInnings(cache, delta2, true);
  const eighthTop = merged3.find((x) => inningKey(x) === "8-top");
  check("delta replaces current inning by key", eighthTop?.plays.length === 3);
  check("no duplicate inning key", merged3.filter((x) => inningKey(x) === "8-top").length === 1);

  // 4) full self-heal: 과거 이닝 정정 반영(1회 plays 3→5로 수정된 full)
  const corrected = fullGame(8);
  const fixed = corrected.find((x) => inningKey(x) === "1-top")!;
  fixed.plays = inn(1, "top", 5).plays;
  const merged4 = mergeDeltaInnings(cache, corrected, false);
  const firstTop = merged4.find((x) => inningKey(x) === "1-top");
  check("full self-heal rebuilds cache", cache.size === 16);
  check("full self-heal applies past correction", firstTop?.plays.length === 5);
}

console.log(`relay-delta-smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
