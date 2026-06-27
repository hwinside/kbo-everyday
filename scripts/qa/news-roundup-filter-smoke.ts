/**
 * Smoke/regression for 묶음 클릭베이트 기사 차단 (news-relevance).
 *
 * Why
 * ---
 * "[핫클릭] 서산서 탈출 늑대개 1마리 추가 귀소…2마리 남아 外" 같은 연합뉴스TV 화제
 * 묶음 기사가 본문에 'LG 트윈스'를 스쳐 언급해서 마스코트 게이트(isTeamBaseballRelevant)를
 * 통과 → LG 히어로 뉴스에 노출(2026-06-25 #cs 제보). 헤드라인은 야구와 무관.
 * 수정: NON_BASEBALL_NEGATIVE에 "핫클릭" 묶음 마커 추가 → 제목 substring으로 정밀 차단.
 *
 * 실행: npx tsx scripts/qa/news-roundup-filter-smoke.ts  (npm run qa:news-roundup)
 */
import { isTeamBaseballRelevant, isPlayerBaseballRelevant } from "@/lib/news-relevance";

let fail = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) fail++;
}

// 제보 repro: 헤드라인은 늑대개, 본문에 LG 트윈스 묶음 언급
const ROUNDUP_TITLE = "[핫클릭] 서산서 탈출 늑대개 1마리 추가 귀소…2마리 남아 外";
const ROUNDUP_BODY = "이 밖에 LG 트윈스가 연승을 이어가는 등 오늘의 화제를 모았다.";

// 차단(false) — 묶음 클릭베이트는 본문에 마스코트가 있어도 노출 금지
ok(
  "roundup blocked from LG team news",
  isTeamBaseballRelevant(ROUNDUP_TITLE, ROUNDUP_BODY, "트윈스") === false
);
ok(
  "roundup blocked from player news",
  isPlayerBaseballRelevant(ROUNDUP_TITLE, ROUNDUP_BODY, "오스틴") === false
);

// recall 유지(true) — 정상 야구 기사는 그대로 통과
ok(
  "normal team article passes (mascot in title)",
  isTeamBaseballRelevant("LG 트윈스, 연장 끝내기 승리", "오스틴 결승타", "트윈스") === true
);
ok(
  "normal team article passes (player-name-only headline, mascot in body)",
  isTeamBaseballRelevant("고승민 1루·손호영 2루 선발 라인업", "롯데 자이언츠 선발 명단", "자이언츠") === true
);
ok(
  "normal player article passes",
  isPlayerBaseballRelevant("오스틴, 프로야구 시즌 1호 홈런", "LG 트윈스 4번타자", "오스틴") === true
);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
