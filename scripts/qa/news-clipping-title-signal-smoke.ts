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
import { hasClippingTitleSignal } from "@/lib/news-relevance";
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
  .filter((p) => p.teamId === 1 && p.name.replace(/\s/g, "").length >= 3)
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
// "김건"(가상 2자 케이스) 류가 "김건희"에 매칭되면 안 됨. LG는 2자 이름이 없어
// 로스터 매칭 자체가 안 일어나야 한다(3자+ 필터).
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

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
