// 숏츠 야구 관련성 필터 회귀 가드.
// 2026-06-19 #cs 제보: 오스틴(LG) 검색에 종교 영상, 김영우 정치 뉴스가 숏츠에 노출.
import {
  hasNonBaseballSignal,
  isPlayerShortRelevant,
} from "@/lib/video/shorts-relevance";

let pass = 0,
  fail = 0;
function check(label: string, actual: boolean, expected: boolean) {
  if (actual === expected) {
    console.log(`✓ ${label} → ${actual}`);
    pass++;
  } else {
    console.log(`✗ ${label} → expected ${expected}, got ${actual}`);
    fail++;
  }
}

// --- 실제 제보된 누수 케이스 (전부 차단돼야 함) ---
check(
  "religious leak (제목에 선수명 없음)",
  isPlayerShortRelevant("하나님의 평가기준! 하나님의 관심은 어디인가?", "오스틴"),
  false,
);
check(
  "political leak (선수명 있어도 정치 negative)",
  isPlayerShortRelevant("김영우 '정권 찔어' 발언으로 명령, 이미 루비콘 강 건너", "김영우"),
  false,
);
check("hasNonBaseballSignal 종교", hasNonBaseballSignal("하나님의 평가기준!"), true);
check("hasNonBaseballSignal 정치", hasNonBaseballSignal("정권 찔어 발언"), true);
check("hasNonBaseballSignal 증시(상속)", hasNonBaseballSignal("LG전자 주가 급등"), true);

// --- 정상 선수 숏츠 (전부 통과돼야 함 — recall 보존) ---
check("정상: 오스틴 홈런", isPlayerShortRelevant("오스틴 끝내기 만루홈런 폭발!", "오스틴"), true);
check("정상: 문동주 호투", isPlayerShortRelevant("문동주 시즌 10승 무실점 호투", "문동주"), true);
check(
  "정상: 야구 키워드 없어도 선수명만 있으면 통과",
  isPlayerShortRelevant("오스틴 4타수 3안타 1타점", "오스틴"),
  true,
);
check("정상 케이스 negative 없음", hasNonBaseballSignal("오스틴 결승 적시타"), false);

// --- 우연 매칭 차단 (선수명이 제목에 없음) ---
check(
  "선수명 없는 일반 영상 차단",
  isPlayerShortRelevant("오늘의 홈런 모음 베스트", "오스틴"),
  false,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
