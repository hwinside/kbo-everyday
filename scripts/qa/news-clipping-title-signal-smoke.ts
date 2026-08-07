// @crawl-managed-read: structural  (크롤 관리 데이터 파일을 구조·불변식 검증에만 사용 — 값 하드코딩 금지, 축② 순환참조 메타게이트)
/**
 * Smoke/regression for 뉴스클리핑 positive 제목 게이트 (hasClippingTitleSignal).
 *
 * Why
 * ---
 * "[버디 or 보기] 'K-10 클럽' 효과로 롱런하는 한국 여자 골프" — 여자골프 기사인데
 * 본문에 'LG 트윈스 김진성'(실제 LG 로스터 선수)을 스쳐 언급 → 팀 관련성 가드
 * (isTeamBaseballRelevant: 마스코트 본문 매칭)를 통과 → Gemini가 억지 김진성 요약을
 * 만들어 제목·사진(골프)과 요약(야구)이 어긋난 클리핑 카드가 나옴(2026-07-19 하린아빠 제보).
 *
 * 수정: 클리핑 후보에 positive 제목 게이트 추가 — 제목에 팀 식별자 / 소속 선수명(3자+) /
 * 야구 키워드 중 하나라도 있어야 선정. 골프 헤드라인은 셋 다 없어 원천 컷되고,
 * 선수명만 쓴 정상 팀 기사(로스터 매칭)는 recall 유지.
 *
 * 실행: npx tsx scripts/qa/news-clipping-title-signal-smoke.ts  (npm run qa:news-clip-title)
 */
import "./_smoke-env"; // supabase env 선주입 — news-clipping 로드 전에 실행되어야 함
import { hasClippingTitleSignal } from "@/lib/news-relevance";
import { isOtherTeamTitle } from "@/lib/news-clipping";
import { TEAM_SEARCH } from "@/lib/naver-news";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";

let fail = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) fail++;
}

// 프로덕션 collectYesterdayCandidates 와 동일한 방식으로 구성.
const LG_TOKENS = ["LG", "LG", "트윈스"]; // teamShort + fullName split
// LG 로스터 선수명 (3자+) — rosterTitleNames 와 동일 필터.
const LG_ROSTER = (PLAYERS_ROSTER as { name: string; teamId: number }[])
  .filter((p) => p.teamId === 1)
  .map((p) => p.name);

// sanity — 리팩터/데이터 변동 감지
ok("LG roster names loaded", LG_ROSTER.length > 50);
ok("김진성 in LG roster names", LG_ROSTER.includes("김진성"));
ok("오스틴 in LG roster names", LG_ROSTER.includes("오스틴"));

// === 원천 차단(false) — 제보 repro ===
ok(
  "여자 골프 헤드라인 컷 (제목에 팀/선수/야구 신호 0)",
  hasClippingTitleSignal(
    "[버디 or 보기] 'K-10 클럽' 효과로 롱런하는 한국 여자 골프",
    LG_TOKENS,
    LG_ROSTER
  ) === false
);
ok(
  "off-sport 헤드라인 컷 (배구 등)",
  hasClippingTitleSignal("여자 배구 대표팀, 세계선수권 4강 진출", LG_TOKENS, LG_ROSTER) === false
);
ok(
  "정치/연예 헤드라인 컷",
  hasClippingTitleSignal("‘K-드라마’ 열풍, 글로벌 시청 신기록", LG_TOKENS, LG_ROSTER) === false
);

// === 2자 이름 substring 오탐 방지 ===
// "김건" 류가 "김건희"에 매칭되면 안 됨. LG는 2자 이름이 없어 애초에 로스터 매칭이
// 안 일어나고, 2자 이름을 보유한 팀의 boundary 매칭 검증은 아래 NO-GO #2 블록에서 한다.
ok(
  "‘김건희’ 정치 헤드라인 컷 (2자 이름 substring 오탐 차단)",
  hasClippingTitleSignal("김건희 특검, 다음주 소환 조사", LG_TOKENS, LG_ROSTER) === false
);

// === recall 유지(true) — 정상 클리핑 대상 ===
ok(
  "팀 약칭 헤드라인 유지",
  hasClippingTitleSignal("LG, 연장 끝내기 승리로 선두 굳혔다", LG_TOKENS, LG_ROSTER) === true
);
ok(
  "마스코트 헤드라인 유지",
  hasClippingTitleSignal("트윈스, 안방서 위닝시리즈 완성", LG_TOKENS, LG_ROSTER) === true
);
ok(
  "야구 키워드 헤드라인 유지 (프로야구)",
  hasClippingTitleSignal("프로야구 오늘의 경기, 잠실서 빅매치", LG_TOKENS, LG_ROSTER) === true
);
ok(
  "야구 키워드 헤드라인 유지 (KBO)",
  hasClippingTitleSignal("KBO 후반기 순위 판도, 5강 경쟁 치열", LG_TOKENS, LG_ROSTER) === true
);
ok(
  "선수명만 쓴 헤드라인 유지 (로스터 매칭, 팀/야구 토큰 없음)",
  hasClippingTitleSignal("김진성, 3⅓이닝 무실점 역투로 승리 지켰다", LG_TOKENS, LG_ROSTER) === true
);
ok(
  "외국인 선수명 헤드라인 유지",
  hasClippingTitleSignal("오스틴, 시즌 25호 대포로 타점 선두 질주", LG_TOKENS, LG_ROSTER) === true
);

// === 다른 팀 선수명은 LG 클리핑에서 로스터 매칭 안 됨(false) ===
// (isOtherTeamTitle 이 별도로 잡지만, positive 게이트도 독립적으로 컷)
ok(
  "타팀 선수명 헤드라인은 LG 로스터 매칭 안 됨",
  hasClippingTitleSignal("문동주, 완봉승으로 한화 4연승 견인", LG_TOKENS, LG_ROSTER) === false
);

// ============================================================================
// 삼순 NO-GO 반영 (2026-07-19) — case-insensitive 타팀 판정 + 2자 이름 boundary 매칭
// ============================================================================
const tokensFor = (short: string): string[] => [short, ...TEAM_SEARCH[short].split(/\s+/)];
const rosterFor = (teamId: number): string[] =>
  (PLAYERS_ROSTER as { name: string; teamId: number }[])
    .filter((p) => p.teamId === teamId)
    .map((p) => p.name);

// --- NO-GO #1: 타팀 식별자 case-insensitive (isOtherTeamTitle) ---
// 2026-07-18 NC 클리핑에서 새 게이트를 통과한 유일 후보였던 소문자 'kt' 타팀 기사.
// case-insensitive 비교로 타팀(KT)으로 잡아 NC 후보에서 탈락시켜야 한다.
ok(
  "소문자 'kt' 타팀 헤드라인이 NC 후보에서 탈락 (case-insensitive)",
  isOtherTeamTitle("프로야구 kt, 좌완 투수 로건과 정식 계약", "NC") === true
);
// own-team 소문자 헤드라인은 타팀 오판(=false) 없이 positive 게이트도 통과(=true).
ok(
  "소문자 own-team 'nc' 헤드라인은 타팀 오판 안 함 (NC)",
  isOtherTeamTitle("nc, 9회말 끝내기 승리로 위닝시리즈", "NC") === false
);
ok(
  "소문자 own-team 'nc' 헤드라인 positive 게이트 유지",
  hasClippingTitleSignal("nc, 9회말 끝내기 승리로 위닝시리즈", tokensFor("NC"), rosterFor(5)) === true
);

// --- NO-GO #2: 2자 이름 boundary 매칭 ---
const SSG_TOKENS = tokensFor("SSG");
const SSG_ROSTER = rosterFor(4);
// sanity — 새 필터로 2자 이름이 로스터에 포함됨
ok("2자 이름 로스터 포함됨 (SSG '최정')", SSG_ROSTER.includes("최정"));

// 2자 이름 recall 복구 — 7/18 SSG 실데이터 (팀/야구 토큰 없이 선수명만)
ok(
  "SSG '최정 부상' 헤드라인 유지 (공백 경계)",
  hasClippingTitleSignal("최정 부상 미스터리, 결장 장기화되나", SSG_TOKENS, SSG_ROSTER) === true
);
ok(
  "SSG '50홈런 없는 최정' 헤드라인 유지 (문장 끝 경계)",
  hasClippingTitleSignal("50홈런 없는 최정", SSG_TOKENS, SSG_ROSTER) === true
);
// boundary 오탐 차단 — '최정상'(단어 일부), '김건희'(NC '김건' 2자 substring)
ok(
  "‘최정상’(단어 일부) 헤드라인 컷 (boundary 오탐 차단)",
  hasClippingTitleSignal("K-뷰티, 글로벌 최정상 브랜드로 우뚝", SSG_TOKENS, SSG_ROSTER) === false
);
ok(
  "NC '김건' 2자, '김건희' 정치 헤드라인 컷 (boundary 오탐 차단)",
  hasClippingTitleSignal("김건희 특검, 다음주 소환 조사", tokensFor("NC"), rosterFor(5)) === false
);

// 10개 구단 실제 2자 선수 boundary 매칭 (LG는 2자 이름 없음 — 위에서 별도 검증)
const TWO_CHAR_CASES: { team: string; teamId: number; name: string; title: string }[] = [
  { team: "두산", teamId: 2, name: "곽빈", title: "곽빈, 7이닝 무실점 호투로 승리" },
  { team: "KT", teamId: 3, name: "주권", title: "주권, 불펜서 3연투 소화" },
  { team: "SSG", teamId: 4, name: "최정", title: "최정, 시즌 21호 아치 그렸다" },
  { team: "NC", teamId: 5, name: "김건", title: "김건, 데뷔 첫 선발 등판 예고" },
  { team: "KIA", teamId: 6, name: "네일", title: "네일, 8이닝 1실점 완벽투" },
  { team: "롯데", teamId: 7, name: "박진", title: "박진, 대타 결승타 폭발" },
  { team: "삼성", teamId: 8, name: "페덱", title: "페덱, 6이닝 QS로 시즌 첫 승" },
  { team: "한화", teamId: 9, name: "유민", title: "유민 멀티히트로 맹타" },
  { team: "키움", teamId: 10, name: "윤현", title: "윤현, 마무리 세이브 성공" },
];
for (const c of TWO_CHAR_CASES) {
  ok(
    `${c.team} 2자 선수 '${c.name}' 헤드라인 유지 (boundary)`,
    hasClippingTitleSignal(c.title, tokensFor(c.team), rosterFor(c.teamId)) === true
  );
}

// ============================================================================
// 삼순 2차 NO-GO 반영 (2026-07-19) — 선수명 뒤 조사 경계 허용 + Latin 약칭 ASCII 경계
// ============================================================================

// --- NO-GO #1: 선수명 뒤 한국어 조사가 붙어도 유지(팀/야구 토큰 없는 제목) ---
// 이전 구현은 이름 다음 글자가 한글이면 전부 탈락시켜 '김진성이 지킨'·'오스틴의'도 false였다.
ok(
  "LG '김진성이 지킨 승리' 유지 (이름+조사 '이')",
  hasClippingTitleSignal("김진성이 지킨 승리, 불펜의 힘", LG_TOKENS, LG_ROSTER) === true
);
ok(
  "LG '오스틴의 25호포' 유지 (이름+조사 '의')",
  hasClippingTitleSignal("오스틴의 25호포로 다시 앞서간 LG", LG_TOKENS, LG_ROSTER) === true
);
ok(
  "롯데 '고승민은 1루·손호영은 2루' 유지 (이름+조사 '은')",
  hasClippingTitleSignal("고승민은 1루·손호영은 2루 선발", tokensFor("롯데"), rosterFor(7)) === true
);
ok(
  "SSG '최정이 터트린 그랜드슬램' 유지 (2자+조사 '이')",
  hasClippingTitleSignal("최정이 터트린 그랜드슬램", SSG_TOKENS, SSG_ROSTER) === true
);
// 조사가 아닌 한글이 이어지면 여전히 컷(단어 일부) — '최정상'·'김건희' 재확인
ok(
  "'최정상'(단어 일부) 여전히 컷 (조사 아닌 한글 연속)",
  hasClippingTitleSignal("K-뷰티, 글로벌 최정상 브랜드로 우뚝", SSG_TOKENS, SSG_ROSTER) === false
);

// --- NO-GO #2: Latin 약칭 ASCII 경계 (일반 영단어 오탐 차단) ---
// 이전 구현은 소문자 substring이라 algorithm→LG, concert/encore→NC, Nokia→KIA 오탐.
ok(
  "'algorithm' 영단어가 LG 신호로 오탐 안 됨",
  hasClippingTitleSignal("New algorithm boosts recommendation accuracy", LG_TOKENS, LG_ROSTER) === false
);
ok(
  "'concert' 영단어가 NC 신호로 오탐 안 됨",
  hasClippingTitleSignal("Sold-out concert draws record crowd", tokensFor("NC"), rosterFor(5)) === false
);
ok(
  "'encore' 영단어가 NC 신호로 오탐 안 됨",
  hasClippingTitleSignal("Fans demand an encore performance", tokensFor("NC"), rosterFor(5)) === false
);
ok(
  "'Nokia' 영단어가 KIA 신호로 오탐 안 됨",
  hasClippingTitleSignal("Nokia unveils new 5G equipment lineup", tokensFor("KIA"), rosterFor(6)) === false
);
// own-team Latin 약칭은 경계에서 유지(case-insensitive + ASCII 경계)
ok(
  "'프로야구 kt,' own-team 유지 (소문자+ASCII 경계)",
  hasClippingTitleSignal("프로야구 kt, 위즈 대역전 승리", tokensFor("KT"), rosterFor(3)) === true
);
ok(
  "'KIA, 대역전 승리' own-team 유지 (대문자+ASCII 경계)",
  hasClippingTitleSignal("KIA, 안방서 위닝시리즈 완성", tokensFor("KIA"), rosterFor(6)) === true
);
// 한글 마스코트는 그대로 substring 유지(한글 경계 오탐 사실상 없음)
ok(
  "한글 마스코트 '타이거즈' 유지",
  hasClippingTitleSignal("타이거즈, 과감한 주루플레이", tokensFor("KIA"), rosterFor(6)) === true
);

// ============================================================================
// 삼순 3차 NO-GO 반영 (2026-07-19) — isOtherTeamTitle도 titleHasTeamToken 공유
// (positive gate만 경계 매칭하고 isOtherTeamTitle은 substring이면 Latin 오판정 잔존)
// ============================================================================

// 축1 target substring 우회 차단: LG 대상 '프로야구 kt, algorithm...' — algorithm 속 'lg'를
// own-team으로 오인해 실제 타팀 kt 검사를 건너뛰면 안 됨 → 타팀(true)로 잡혀야 함.
ok(
  "LG 대상 '프로야구 kt, algorithm 분석' → 타팀 true (target substring 우회 차단)",
  isOtherTeamTitle("프로야구 kt, algorithm 기반 투구 분석", "LG") === true
);
// 축2 other substring false-drop 차단: LG 대상 '오스틴, encore...' — encore 속 'nc'를
// 타팀으로 오인하면 안 됨 → 타팀 아님(false), 오스틴(LG 선수)은 own-team.
ok(
  "LG 대상 '오스틴, encore 요청 받은 홌런쇼' → 타팀 false (other substring 오판정 차단)",
  isOtherTeamTitle("오스틴, encore 요청 받은 홌런쇼", "LG") === false
);
// 축3 기존 정상: 소문자 exact 'kt' 타팀 차단 / exact 'nc,' own-team 유지
ok(
  "NC 대상 소문자 exact 'kt' 타팀 차단 (기존 유지)",
  isOtherTeamTitle("프로야구 kt, 좌완 투수 로건과 정식 계약", "NC") === true
);
ok(
  "NC 대상 exact 'nc,' own-team 유지 (기존 유지)",
  isOtherTeamTitle("nc, 9회말 끝내기 승리", "NC") === false
);
// 한글 마스코트 타팀 판정도 그대로(substring) — LG 대상 '기아 타이거즈' 타팀 true
ok(
  "LG 대상 한글 마스코트 '타이거즈' → 타팀 true (한글 substring 유지)",
  isOtherTeamTitle("타이거즈, 안방서 위닝시리즈", "LG") === true
);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
