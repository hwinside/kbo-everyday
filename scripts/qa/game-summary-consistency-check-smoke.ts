#!/usr/bin/env tsx
/**
 * QA: AI 경기 요약 내부 정합성 검증 (hasBaseRunnerContradiction) 회귀 가드
 *
 * 2026-06-20 사고 (두산 2:4 LG): 박스스코어엔 주자 상황이 없는데 LLM이 승부처를
 * 극적으로 쓰려고 주자 상황을 환각 → "8회말 2사 *만루*에서 문보경 역전 *3점* 홈런".
 * 만루(주자 3명)에서 홈런이면 만루홈런(4점)이어야 하므로 산술 모순. 같은 요약이
 * 첫 문단은 "연속 안타로 만루", 승부처는 "안타+진루타+볼넷"으로 출루 과정까지
 * 서로 다르게 서술했다.
 *
 * 이 테스트는 정상 서술은 통과(false), 만루+비만루홈런 산술 모순만 reject(true)됨을 보장.
 * 오탐(정상 만루홈런/만루와 무관한 솔로홈런/주자 언급 없는 홈런)이 reject되지 않아야 한다.
 */

import { hasBaseRunnerContradiction } from "../../src/lib/game-summary/consistency-check";

interface Case {
  desc: string;
  text: string;
  expect: boolean; // true = 모순으로 판정해야 함
}

const cases: Case[] = [
  // === 실제 모순 (reject해야 함 = true) ===
  { desc: "이번 사고 — 2사 만루에서 3점 홈런", text: "두산이 2-1로 앞선 상황에서 LG는 천성호의 안타와 박해민의 진루타, 오스틴의 볼넷으로 2사 만루 찬스를 잡았다. 여기서 타석에 들어선 문보경이 역전 3점 홈런을 터뜨리며 경기는 순식간에 4-2로 뒤집혔다.", expect: true },
  { desc: "이번 사고 첫 문단 — 만루 기회 + 홈런으로 3점 추가", text: "LG는 8회말 천성호, 박해민, 오스틴의 연속 안타로 만루 기회를 만들었고, 문보경의 결정적인 홈런으로 단숨에 3점을 추가하며 4-2 역전에 성공했다.", expect: true },
  { desc: "만루 + 2점 홈런", text: "2사 만루에서 터진 2점 홈런으로 달아났다", expect: true },
  { desc: "만루 + 솔로 홈런 (공격 장면)", text: "1사 만루에서 터진 솔로 홈런으로 균형을 깼다", expect: true },
  { desc: "만루 + 3점포 (포 표현)", text: "1사 만루, 결정적인 3점포가 터졌다", expect: true },
  { desc: "만루 + 스리런 (한글 표현, 삼순 리뷰)", text: "2사 만루에서 문보경이 스리런을 터뜨렸다", expect: true },
  { desc: "만루 + 투런포 (한글 표현, 삼순 리뷰)", text: "만루 찬스에서 투런포가 터졌다", expect: true },
  { desc: "만루(다음 문장) + 쓰리런", text: "1사 만루 찬스를 잡았다. 이어 김현수가 쓰리런 홈런을 쏘아 올렸다.", expect: true },

  // === 정상 서술 (통과해야 함 = false) ===
  { desc: "정상 만루홈런 (4점)", text: "2사 만루에서 만루홈런이 터지며 4점을 쓸어 담았다", expect: false },
  { desc: "정상 만루홈런 — 그랜드슬램", text: "만루 찬스에서 그랜드슬램으로 단숨에 4점", expect: false },
  { desc: "정상 만루 + 4점 홈런 표현", text: "2사 만루에서 4점 홈런으로 경기를 끝냈다", expect: false },
  { desc: "만루지만 홈런 아님 — 적시타", text: "2사 만루에서 적시 2루타로 2점을 뽑았다", expect: false },
  { desc: "홈런 있지만 만루 아님 — 솔로", text: "선두타자 솔로 홈런으로 동점을 만들었다", expect: false },
  { desc: "홈런 있지만 만루 아님 — 3점 홈런", text: "주자 2명을 두고 문보경이 3점 홈런을 터뜨렸다", expect: false },
  { desc: "투런 있지만 만루 아님 (정상)", text: "1사 1루에서 투런포로 달아났다", expect: false },
  { desc: "만루와 솔로홈런이 서로 다른 장면(문장 분리)", text: "3회 만루 위기를 무실점으로 넘겼다. 5회에는 솔로 홈런으로 한 점을 보탰다.", expect: false },
  { desc: "만루 언급 없음", text: "문보경이 3타점 홈런으로 4-2 역전을 만들었다", expect: false },
  { desc: "득점 수 없는 만루+홈런 (추측 회피 — 통과)", text: "만루 기회를 홈런으로 연결했다", expect: false },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = hasBaseRunnerContradiction(c.text);
  const ok = got === c.expect;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "✓" : "✗"} [${c.expect ? "reject" : "pass  "}] ${c.desc}${ok ? "" : ` — got ${got}`}`);
}

console.log(`\n${pass}/${cases.length} passed`);
if (fail > 0) {
  console.error(`FAIL: ${fail} case(s) regressed`);
  process.exit(1);
}
