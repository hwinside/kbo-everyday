/**
 * cross-check 판정 로직 단위 테스트 (API 의존 0 — CI 게이트용).
 *
 * 검증 포인트(삼순 NO-GO #2): "오염된 동일 이미지가 1장만 일치해도 통과"되던 구멍을
 * ≥2개 독립 도메인 합치 요구로 막았는지 부정 테스트로 확인.
 *
 *   node scripts/hero-batch/test-crosscheck.mjs
 */
import { decideCrossCheck, registrableDomain } from "./run-batch.mjs";

let pass = 0,
  fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : ` → got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
}

// ── registrableDomain ──
eq("domain: news.osen.co.kr → osen.co.kr", registrableDomain("https://news.osen.co.kr/a/b.jpg"), "osen.co.kr");
eq("domain: www.spotvnews.co.kr → spotvnews.co.kr", registrableDomain("http://www.spotvnews.co.kr/x.jpg"), "spotvnews.co.kr");
eq("domain: imgnews.pstatic.net → pstatic.net", registrableDomain("https://imgnews.pstatic.net/img.jpg"), "pstatic.net");
eq("domain: example.com → example.com", registrableDomain("https://example.com/p.jpg"), "example.com");

// ── decideCrossCheck ──
const D = (sim, dom) => ({ similarity: sim, domain: dom });

// 핵심 부정 테스트: 오염 이미지 1장만 강하게 일치 → 통과되면 안 됨 (HOLD)
eq(
  "오염 1장만 일치(단일 도메인) → uncertain(차단)",
  pick(decideCrossCheck([D(0.95, "osen.co.kr"), D(0.1, "a.com"), D(0.05, "b.com")])),
  "uncertain"
);

// 같은 도메인에서 2장 일치 → 독립성 부족 → 통과 금지
eq(
  "같은 도메인 2장 일치 → uncertain(차단)",
  pick(decideCrossCheck([D(0.95, "osen.co.kr"), D(0.9, "osen.co.kr"), D(0.1, "b.com")])),
  "uncertain"
);

// 정상: 2개 독립 도메인 일치 → pass
eq(
  "독립 2도메인 일치 → pass",
  pick(decideCrossCheck([D(0.95, "osen.co.kr"), D(0.88, "spotvnews.co.kr"), D(0.2, "x.com")])),
  "pass"
);

// 아무도 안 닮음(최고<0.5) → fail (seed 가 다른 사람 의심 = 가나쿠보 osen 사고형)
eq(
  "전부 낮음 → fail",
  pick(decideCrossCheck([D(0.2, "a.com"), D(0.15, "b.com"), D(0.05, "c.com")])),
  "fail"
);

// 후보 0건 → uncertain
eq("후보 0건 → uncertain", pick(decideCrossCheck([])), "uncertain");

function pick(r) {
  return r.verdict;
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
