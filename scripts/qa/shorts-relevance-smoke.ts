// 숏츠 야구 관련성 필터 회귀 가드.
// 2026-06-19 #cs 제보: 오스틴(LG) 검색에 종교 영상, 김영우 정치 뉴스가 숏츠에 노출.
import {
  hasBaseballShortContext,
  hasNonBaseballSignal,
  isPlayerShortRelevant,
  isTeamShortRelevant,
} from "@/lib/video/shorts-relevance";
import {
  detectAllTeamsFromTitle,
  detectTeamFromTitle,
} from "@/lib/video/team-detector";

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

// --- '시장' allowlist: 야구 市場은 통과, 정치 市長은 차단 (삼순 조건부 GO) ---
check("정상: FA 시장 (공백)", hasNonBaseballSignal("LG 최대어 FA 시장 큰손 등판"), false);
check("정상: FA시장 (붙임)", hasNonBaseballSignal("올겨울 FA시장 전망"), false);
check("정상: 트레이드 시장", hasNonBaseballSignal("마감 임박 트레이드 시장 정리"), false);
check("정상: 외국인 투수 시장", hasNonBaseballSignal("외국인 투수 시장 매물 분석"), false);
check("차단 유지: 정치 시장(市長) 후보", hasNonBaseballSignal("OO 시장 후보 유세 현장"), true);

// --- 우연 매칭 차단 (선수명이 제목에 없음) ---
check(
  "선수명 없는 일반 영상 차단",
  isPlayerShortRelevant("오늘의 홈런 모음 베스트", "오스틴"),
  false,
);

// --- LG 약칭 오탐 차단 (#cs 2026-07-22 실제 제보) ---
const LG_CHEMICAL_TITLE = "LG화학 나주공장, 또 생산라인 축소...가소제 라인";
check("LG화학: 야구 문맥 없음", hasBaseballShortContext(LG_CHEMICAL_TITLE), false);
check("LG화학: 수집 team_id ETC", detectTeamFromTitle(LG_CHEMICAL_TITLE) === "ETC", true);
check(
  "LG화학: 전체 팀 감지에서도 LG 제외",
  detectAllTeamsFromTitle(LG_CHEMICAL_TITLE).includes("LG"),
  false,
);
check(
  "LG화학: 기존 LG 오분류 행도 노출 차단",
  isTeamShortRelevant(LG_CHEMICAL_TITLE, "LG"),
  false,
);
check(
  "정상: LG + 트윈스 문맥",
  isTeamShortRelevant("LG 트윈스 끝내기 승리", "LG"),
  true,
);
check(
  "정상: LG + 경기 문맥",
  detectTeamFromTitle("LG 경기 하이라이트") === "LG",
  true,
);
check(
  "정상: LG 선수 태그가 있는 커뮤니티 영상",
  isTeamShortRelevant("LG 오스틴 결승타", "LG", { hasPlayerTag: true }),
  true,
);
check(
  "정상: LG 공식 채널 영상",
  isTeamShortRelevant("드디어 돌아왔다", "LG", { isOfficial: true }),
  true,
);
check(
  "회귀: 다른 팀 기존 동작 유지",
  isTeamShortRelevant("삼성 멋진 장면", "삼성"),
  true,
);

// --- LG 계열사 다의어/부분문자열 오탐 (2026-07-24 삼순 리뷰 반례) ---
for (const title of [
  "LG화학 신입사원 선발",
  "LG유플러스 선수금 지급",
  "LG전자 경기 침체에도 승리",
]) {
  check(`계열사 오탐: 야구 문맥 아님 (${title})`, hasBaseballShortContext(title), false);
  check(`계열사 오탐: 수집 team_id ETC (${title})`, detectTeamFromTitle(title) === "ETC", true);
  check(
    `계열사 오탐: 기존 LG 행 노출 차단 (${title})`,
    isTeamShortRelevant(title, "LG"),
    false,
  );
}
check(
  "정상: 다의어 2개 조합은 야구 문맥 (LG 잠실 역전승)",
  detectTeamFromTitle("LG 잠실서 짜릿한 역전승") === "LG",
  true,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
