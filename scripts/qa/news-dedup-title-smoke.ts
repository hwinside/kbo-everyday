/**
 * Smoke/regression for isSameStoryTitle / dedupeNewsByTitle (news-relevance).
 *
 * Why
 * ---
 * 같은 사건을 매체만 다르게 올린 near-duplicate 기사가 홈/팀 뉴스에 중복 노출됨
 * (하린아빠 prod QA: LG 강뉴합창단 후원 기사가 ddaily/edaily 2건). URL 완전일치
 * dedup으론 못 잡아서 제목 토큰 overlap 기반 near-dup 제거를 추가.
 * 핵심: 같은 사건은 합치되, 일부 단어만 겹치는 *다른* 기사는 절대 합치지 않는다(보수적).
 *
 * 실행: npx tsx scripts/qa/news-dedup-title-smoke.ts  (npm run qa:news-dedup)
 */
import { isSameStoryTitle, dedupeNewsByTitle } from "@/lib/news-relevance";

let fail = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) fail++;
}

// 같은 사건(다른 매체/제목) → 동일로 판정(true)
ok(
  "repro: LG 강뉴합창단 후원 (ddaily vs edaily)",
  isSameStoryTitle(
    "LG, 에티오피아 참전용사 후손 강뉴합창단 방한 전액 후원",
    "LG, 6·25 에티오피아 참전용사 후손 '강뉴합창단' 방한 체류비 후원"
  ) === true
);
ok(
  "거의 동일 제목(매체 표기만 차이)은 합침",
  isSameStoryTitle(
    "[KBO] 두산, KIA 꺾고 5연승 질주",
    "두산, KIA 꺾고 5연승 질주"
  ) === true
);
// 보수적 경계: 핵심 토큰이 60%만 겹치는(동사·수식어 다른) 경기 리캡은
// 서로 다른 기사일 수 있어 *합치지 않는다*(false).
ok(
  "경계: 60% 겹침(꺾고/잡고 등 표현 차이)은 보수적으로 미합침",
  isSameStoryTitle(
    "두산, KIA 꺾고 5연승 질주",
    "두산 KIA 잡고 선두 추격 청신호"
  ) === false
);
// 삼순 NO-GO 가드: 결과만 정반대인 짧은 헤드라인(공통 3/4=0.75)은 0.8 임계값으로 차단.
// 승리와 패배는 정반대 기사이므로 절대 합치면 안 됨.
ok(
  "FP: 프로야구 LG 삼성전 승리 vs 패배 미합침",
  isSameStoryTitle("프로야구 LG 삼성전 승리", "프로야구 LG 삼성전 패배") === false
);
ok(
  "FP: KBO 두산 KIA전 승리 vs 패배 미합침",
  isSameStoryTitle("KBO 두산 KIA전 승리", "KBO 두산 KIA전 패배") === false
);

// 서로 다른 기사(일부 단어만 겹침) → 다름(false)
ok(
  "다른 선수 홈런 기사는 합치지 않음",
  isSameStoryTitle("LG 오스틴 결승 홈런", "LG 문보경 만루 홈런") === false
);
ok(
  "같은 팀 다른 사건",
  isSameStoryTitle("LG 트윈스 5연승 질주", "LG 트윈스 신인 투수 발탁") === false
);
ok(
  "짧은 제목 일부 겹침은 미합침(공통<3)",
  isSameStoryTitle("KIA 승리", "KIA 패배") === false
);

// dedupeNewsByTitle — 중복 1건만 유지, 다른 기사는 보존
const items = [
  { title: "LG, 에티오피아 참전용사 후손 강뉴합창단 방한 전액 후원", link: "a" },
  { title: "LG, 6·25 에티오피아 참전용사 후손 '강뉴합창단' 방한 체류비 후원", link: "b" },
  { title: "LG 오스틴 결승 홈런", link: "c" },
];
const deduped = dedupeNewsByTitle(items);
ok("dedup: 3건 → 2건 (near-dup 1건 제거)", deduped.length === 2);
ok("dedup: 첫(최신) 항목 유지", deduped[0].link === "a");
ok("dedup: 다른 기사(오스틴) 보존", deduped.some((d) => d.link === "c"));

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
