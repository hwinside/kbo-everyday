#!/usr/bin/env tsx
/**
 * QA: AI 경기 요약 승패 검증 (loserClaimedWin) 회귀 가드
 *
 * 2026-06-03 사고: "롯데, KIA 꺾고 승리" 같은 정상 헤드라인에서 패팀(KIA)이
 * 승리 키워드 앞에 등장한다는 이유로 요약이 reject됨 → 캐시 미생성 → 사용자에게
 * "AI 분석 지연"이 며칠째 노출. 원인은 단순 "패팀 + 키워드" 근접 매칭이 목적어
 * (정상)와 주어(오류)를 구분하지 못한 것.
 *
 * 이 테스트는 정상 요약은 통과(false), 패팀을 승자로 서술한 요약만 reject(true)됨을 보장.
 */

import { loserClaimedWin } from "../../src/lib/game-summary/winner-check";

interface Case {
  desc: string;
  text: string;
  winner: string;
  loser: string;
  expect: boolean; // true = mismatch로 판정해야 함
}

const cases: Case[] = [
  // === 정상 요약 (통과해야 함 = false) ===
  { desc: "롯데, KIA 꺾고 승리 (이번 사고 케이스)", text: "롯데, KIA 꺾고 승리", winner: "롯데", loser: "KIA", expect: false },
  { desc: "타동사 제압 — 삼성이 두산을 제압", text: "삼성이 두산을 제압하며 시리즈를 가져갔다", winner: "삼성", loser: "두산", expect: false },
  { desc: "목적격 조사 — KIA, 한화에 역전승", text: "KIA, 한화에 역전승을 거뒀다", winner: "KIA", loser: "한화", expect: false },
  { desc: "어순 변형 — 한화에 역전승을 거둔 KIA", text: "한화에 역전승을 거둔 KIA의 뒷심", winner: "KIA", loser: "한화", expect: false },
  { desc: "스코어 낀 격파 — 롯데, KIA 8-3 격파", text: "롯데, 9회 대량득점으로 KIA 8-3 격파", winner: "롯데", loser: "KIA", expect: false },
  { desc: "본문 타동사 — LG가 NC를 잡았다", text: "선발의 호투를 앞세워 LG가 NC를 잡았다", winner: "LG", loser: "NC", expect: false },

  // === 실제 오류 (reject해야 함 = true) ===
  { desc: "패팀이 주어로 끝내기 승리 (KIA 패배인데 승자 서술)", text: "KIA, 짜릿한 끝내기 승리", winner: "롯데", loser: "KIA", expect: true },
  { desc: "패팀 완승 서술 (두산 패배)", text: "두산 완승으로 분위기 반전", winner: "LG", loser: "두산", expect: true },
  { desc: "패팀 단독 승리 서술", text: "한화 대승", winner: "삼성", loser: "한화", expect: true },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = loserClaimedWin(c.text, c.winner, c.loser);
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
