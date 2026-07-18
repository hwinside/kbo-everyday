#!/usr/bin/env node
/**
 * 신규 외국인 자동 온보딩 분류/리포트 순수 로직 스모크 (A안 슬라이스 1).
 * Usage: node scripts/qa/foreign-onboard-smoke.mjs
 */
import { classifyForeign, mergePendingReport } from "../lib/foreign-onboard.mjs";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`✓ ${label}`); }
  else { fail++; console.log(`✗ ${label}`); }
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)})`); }

// ===== classifyForeign =====
ok(classifyForeign({ draft: "26 삼성 자유선발", name: "페덱" }) === true, "자유선발 → 외인(페덱)");
ok(classifyForeign({ draft: "25 롯데 자유선발", name: "찰리반스" }) === true, "자유선발 → 외인(공백없는 외인명)");
ok(classifyForeign({ draft: "", name: "가나쿠보 유토" }) === true, "공백 풀네임 → 외인(아시아쿼터)");
ok(classifyForeign({ draft: "", name: "르윈 디아즈" }) === true, "공백 풀네임 → 외인(FP)");
ok(classifyForeign({ draft: "24 1차지명", name: "김영웅" }) === false, "국내 1차지명 → 국내");
ok(classifyForeign({ draft: "23 2차 3라운드", name: "이재현" }) === false, "국내 2차지명 → 국내");
ok(classifyForeign({ draft: "육성선수", name: "홍길동" }) === false, "육성선수 → 국내");
ok(classifyForeign({}) === false, "정보 없음 → 국내(보수적)");
ok(classifyForeign(null) === false, "null → false(방어)");

// ===== mergePendingReport =====
const now = "2026-07-19T00:00:00.000Z";

// 신규 후보 추가
eq(
  mergePendingReport({}, [{ kboId: "56459", name: "페덱", team: "삼성" }], {}, now),
  { "56459": { name: "페덱", team: "삼성", addedAt: now } },
  "빈 리포트 + 신규 1명 → 추가",
);

// 국적이 이미 붙은 항목은 병합 시 자동 소멸
eq(
  mergePendingReport(
    { "56459": { name: "페덱", team: "삼성", addedAt: "2026-07-18T00:00:00.000Z" } },
    [],
    { "56459": "US" },
    now,
  ),
  {},
  "국적 등록되면 기존 pending 제거(자동 소멸)",
);

// 기존 addedAt 보존(중복 추가 금지)
eq(
  mergePendingReport(
    { "56459": { name: "페덱", team: "삼성", addedAt: "2026-07-18T00:00:00.000Z" } },
    [{ kboId: "56459", name: "페덱", team: "삼성" }],
    {},
    now,
  ),
  { "56459": { name: "페덱", team: "삼성", addedAt: "2026-07-18T00:00:00.000Z" } },
  "이미 대기 중이면 addedAt 보존(재추가 안 함)",
);

// 국적 미상 신규 + 국적 붙은 기존 혼재
eq(
  mergePendingReport(
    { "55555": { name: "옛외인", team: "NC", addedAt: "2026-07-01T00:00:00.000Z" } },
    [{ kboId: "56459", name: "페덱", team: "삼성" }],
    { "55555": "DO" },
    now,
  ),
  { "56459": { name: "페덱", team: "삼성", addedAt: now } },
  "해결된 기존 제거 + 신규 추가 동시",
);

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
