/**
 * Smoke/regression for isNaverNewsUrl (news-relevance).
 *
 * Why
 * ---
 * '무조건 네이버' 보장: Naver 검색 API `link`는 네이버 *등록* 기사만 네이버 뉴스 URL이고,
 * 미등록 기사는 link도 언론사 원문 URL로 내려온다. 그 기사는 노출에서 제외해야 한다.
 * 삼순 prod QA NO-GO(hansbiz가 언론사로 열림) + 조건부 GO(dot-boundary) 재발 방지:
 *  - hansbiz/chosun 등 언론사 URL은 false
 *  - n.news/news/m.sports/sports.news 등 네이버 계열은 true
 *  - notnaver.com / fake-naver.com 같은 유사 도메인은 substring 오통과 없이 false
 *
 * 실행: npx tsx scripts/qa/news-naver-url-smoke.ts  (npm run qa:news-naver-url)
 */
import { isNaverNewsUrl } from "@/lib/news-relevance";

let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!cond) fail++;
}

const cases: [string | undefined | null, boolean][] = [
  // 언론사 원문 URL — 제외(false)
  ["http://www.hansbiz.co.kr/news/articleView.html?idxno=845439", false], // 삼순 prod QA repro
  ["https://www.chosun.com/sports/2026/x.html", false],
  // 네이버 뉴스 계열 — 노출(true)
  ["https://n.news.naver.com/mnews/article/001/0001", true],
  ["https://news.naver.com/main/read.naver?oid=1", true],
  ["https://m.sports.naver.com/kbaseball/article/001/2", true],
  ["https://sports.news.naver.com/news?oid=1", true],
  // dot-boundary — 유사 도메인 오통과 방지(false)  ← 삼순 조건부 GO 지적
  ["https://notnaver.com/article/1", false],
  ["https://fake-naver.com/article/2", false],
  ["https://naver.com.evil.com/x", false],
  // 빈 값/깨진 URL
  ["", false],
  [undefined, false],
  ["not-a-url", false],
];

for (const [url, expected] of cases) {
  ok(`isNaverNewsUrl(${JSON.stringify(url)}) === ${expected}`, isNaverNewsUrl(url) === expected);
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
