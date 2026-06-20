#!/usr/bin/env tsx
/**
 * QA: AI 경기 요약 논리 검증 회귀 가드.
 *
 * 박스스코어 기반 요약은 플레이 바이 플레이가 없으므로 주자·아웃·타석 순서를
 * 특정하면 안 된다. 특히 "만루 + 3점 홈런"처럼 야구 산술상 불가능한 문장은
 * 캐시에 저장되기 전에 reject해야 한다.
 */

import { findSummaryLogicIssues } from "../../src/lib/game-summary/logic-check";

interface Case {
  desc: string;
  summary: Record<string, unknown>;
  expectIssues: string[];
}

const cases: Case[] = [
  {
    desc: "만루 + 3점 홈런 모순 reject",
    summary: {
      headline: "문보경 3점포, LG 역전승",
      turningPoint: "5회말 2사 만루에서 문보경이 역전 3점 홈런을 터뜨렸다.",
    },
    expectIssues: ["bases-loaded three-run homer contradiction", "unsupported base/out play detail"],
  },
  {
    desc: "연속 안타/진루타/볼넷 순서 창작 reject",
    summary: {
      gameFlow: {
        mid: "천성호의 안타와 박해민의 진루타, 오스틴의 볼넷으로 만루를 만들었다.",
      },
    },
    expectIssues: ["unsupported base/out play detail", "unsupported play sequence detail"],
  },
  {
    desc: "라인스코어 기반 팀 득점 서술 pass",
    summary: {
      headline: "LG, 5회 3득점으로 경기 뒤집고 4-2 승리",
      turningPoint: "5회말 LG가 3점을 올리며 1-2 열세를 4-2 리드로 바꿨다.",
      mvpBatter: { name: "문보경", stats: "4타수 2안타 3타점", reason: "전체 타점 생산이 승부를 가른 핵심이었다." },
    },
    expectIssues: [],
  },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  const got = findSummaryLogicIssues(c.summary).sort();
  const expected = [...c.expectIssues].sort();
  const ok = got.length === expected.length && got.every((issue, i) => issue === expected[i]);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "✓" : "✗"} ${c.desc}${ok ? "" : `\n  expected: ${expected.join(", ")}\n  actual:   ${got.join(", ")}`}`);
}

console.log(`\n${pass}/${cases.length} passed`);
if (fail > 0) {
  console.error(`FAIL: ${fail} case(s) regressed`);
  process.exit(1);
}
