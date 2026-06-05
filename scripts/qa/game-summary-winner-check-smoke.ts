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
 *
 * 2026-06-05 재발: 본문 자유서사("롯데의 추격을 꺾기에는 역부족")와 긴 헤드라인에서
 * 또 false reject → 다수 경기 "AI 분석 지연". 대응: (1) route는 *헤드라인만* 스캔
 * (본문 부정문/소유격은 winner 필드 백스톱에 위임), (2) winner-check는 소유격 '의'를
 * 비주어로, 검사 범위를 고정 윈도→'같은 절 전체'로 보강. 아래 6/5 케이스가 회귀 가드.
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

  // === 삼순 리뷰 보강: 어순 뒤집힌 타동사 오답 (패팀=주어, 승팀=목적어) ===
  { desc: "어순 역전 — KIA, 롯데 꺾고 승리 (실승자 롯데인데 KIA가 꺾었다고 서술)", text: "KIA, 롯데 꺾고 승리", winner: "롯데", loser: "KIA", expect: true },
  { desc: "어순 역전 — 두산, 삼성 제압 (실승자 삼성)", text: "두산, 삼성 제압하며 위닝시리즈", winner: "삼성", loser: "두산", expect: true },
  { desc: "조사 역전 — 롯데를 KIA가 대파 (실승자 롯데)", text: "롯데를 KIA가 대파한 경기", winner: "롯데", loser: "KIA", expect: true },
  { desc: "winner 필드 정상이어도 헤드라인 오답은 reject (NC, LG 격파 / 실승자 LG)", text: "NC, LG 격파로 단독 선두", winner: "LG", loser: "NC", expect: true },

  // === 2026-06-05 보강: 정상 헤드라인 false-reject 차단 (한화 9:2 롯데 / 삼성 2:5 KIA 등 다수 경기) ===
  // ① 소유격 '의' — 패팀이 동사 주어가 아니라 수식어
  { desc: "소유격 — 한화가 롯데의 추격을 꺾고 대승 (정상)", text: "한화가 롯데의 추격을 꺾고 대승", winner: "한화", loser: "롯데", expect: false },
  // ② 긴 헤드라인 — 승팀이 문두, 키워드가 25자 밖 (고정 윈도였으면 false reject)
  { desc: "긴 헤드라인 — 한화, …앞세워 롯데 9-2 대파 (정상)", text: "한화, 류현진 호투 페라자 맹타 앞세워 롯데 9-2 대파", winner: "한화", loser: "롯데", expect: false },
  // ③ 실제 6/5 프로덕션 헤드라인 (모두 정상 = 통과해야 함)
  { desc: "실제 — 한화, 페라자 맹타 앞세워 롯데 9-2 대파", text: "한화, 페라자 맹타 앞세워 롯데 9-2 대파", winner: "한화", loser: "롯데", expect: false },
  { desc: "실제 — KIA, 삼성 꺾고 5-2 승리... 올러 쾌투", text: "KIA, 삼성 꺾고 5-2 승리... 올러 7이닝 무실점 쾌투", winner: "KIA", loser: "삼성", expect: false },
  { desc: "실제 — SSG, 최지훈 맹타 앞세워 KT에 6-5 역전승", text: "SSG, 최지훈 맹타 앞세워 KT에 6-5 역전승", winner: "SSG", loser: "KT", expect: false },
  { desc: "실제 — 한화, 롯데 마운드 맹폭! 9대2 대승으로 위닝시리즈 확보", text: "한화, 롯데 마운드 맹폭! 9대2 대승으로 위닝시리즈 확보", winner: "한화", loser: "롯데", expect: false },
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
