/**
 * Smoke/regression for isPhotoArticle (news-relevance).
 *
 * Why
 * ---
 * 사진기사 필터(마이페이지/팀뉴스 토글) ON일 때 포토데스크 기사만 정밀히 숨겨야 한다.
 * 하린아빠 prod QA: 필터 ON인데 "[사진]문성주 '역전포 날린 문보경...'"이 홈 캐러셀에
 * 그대로 노출됨 → 키워드가 "포토/화보/갤러리"뿐이라 대괄호 "[사진]" 프리픽스를 못 잡음.
 * 수정: 대괄호 안 "사진" 마커는 포토 기사로 보되, 바 단어 "사진 공개" 류는 오탐 없이 통과.
 *
 * 실행: npx tsx scripts/qa/photo-article-filter-smoke.ts  (npm run qa:photo-filter)
 */
import { isPhotoArticle } from "@/lib/news-relevance";

let fail = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) fail++;
}

const cases: [string, boolean][] = [
  // 포토 기사 — 숨김(true)
  ["[사진]문성주 '역전포 날린 문보경, 야구 주머니 대단해!'", true], // 하린아빠 repro
  ["[포토]오스틴 시즌 1호 홈런", true],
  ["[현장사진] 잠실 만원 관중", true],
  ["[HD사진] 김도영 타격폼", true],
  ["LG 트윈스 화보 공개", true],
  ["KIA 갤러리: 우승의 순간", true],
  // 일반 기사 — 노출(false), 바 단어 "사진" 오탐 회피
  ["김선수 '가족 사진 공개'에 팬들 화답", false],
  ["오스틴, 결승타 치고 인터뷰 '사진 찍기 좋은 날'", false],
  ["[단독] 두산 새 외국인 영입 임박", false],
  ["[인터뷰] 류현진 '올해 목표는 우승'", false],
];

for (const [title, expected] of cases) {
  ok(`isPhotoArticle(${JSON.stringify(title)}) === ${expected}`, isPhotoArticle(title) === expected);
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
