/**
 * 순환참조 메타게이트 (축②) — prebuild 필수 게이트.
 *
 * scripts/qa · scripts/ci 아래 모든 게이트/QA 파일을 스캔해, 크롤 자동 갱신 데이터 파일의
 * 값을 리터럴 기대값으로 하드코딩하거나(값 하드코딩), 관리파일을 읽으면서 @crawl-managed-read
 * 애노테이션을 빠뜨린 경우 RED 를 낸다. 이 게이트가 없으면 곽빈 ERA 2.64 유형(#1059·#1086)이
 * 재발해 roster/stats 자동 업데이트가 조용히 막힌다.
 *
 * 실행: node scripts/qa/circular-ref-gate.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectCircularRefs } from "../ci/lib/circular-ref-detect.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SCAN_DIRS = ["scripts/qa", "scripts/ci"];

// 게이트 인프라 자신은 관리파일명을 *문자열로* 담을 뿐 read 하지 않으므로 detect 가 reads=0 이지만,
// 방어적으로 명시 제외한다(레지스트리는 관리파일 경로 리터럴을 담는 SSOT).
const SELF_EXCLUDE = new Set([
  "scripts/ci/lib/crawl-managed-registry.mjs",
  "scripts/ci/lib/circular-ref-detect.mjs",
  "scripts/qa/circular-ref-gate.mjs",
  "scripts/qa/circular-ref-gate-smoke.mjs",
]);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(join(ROOT, dir));
  } catch {
    return out;
  }
  for (const name of entries) {
    const rel = `${dir}/${name}`;
    const abs = join(ROOT, rel);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(rel, out);
    } else if (/\.(ts|mjs|js)$/.test(name)) {
      out.push(rel);
    }
  }
  return out;
}

const files = [];
for (const d of SCAN_DIRS) walk(d, files);

let scanned = 0;
let managedReaders = 0;
const failures = [];

for (const rel of files) {
  if (SELF_EXCLUDE.has(rel)) continue;
  scanned++;
  const source = readFileSync(join(ROOT, rel), "utf-8");
  let result;
  try {
    result = detectCircularRefs(source, rel);
  } catch (e) {
    // 파싱 불가 자체를 fail-close: 검사 못 하는 파일을 조용히 통과시키지 않는다.
    failures.push({ file: rel, violations: [{ rule: "parse-error", line: 0, detail: String(e && e.message) }] });
    continue;
  }
  if (result.reads.length > 0) managedReaders++;
  if (result.violations.length > 0) {
    failures.push({ file: rel, violations: result.violations });
  }
}

console.log(`🔁 순환참조 메타게이트 — ${scanned}개 스캔, 관리파일 read ${managedReaders}개`);

if (failures.length === 0) {
  console.log("✅ 순환참조/애노테이션 위반 없음");
  process.exit(0);
}

console.error(`\n❌ ${failures.length}개 파일 위반:`);
for (const f of failures) {
  console.error(`\n  ${f.file}`);
  for (const v of f.violations) {
    console.error(`    L${v.line} [${v.rule}] ${v.detail}`);
  }
}
console.error(
  `\n순환참조 = 크롤이 매일 갱신하는 값을 기대값으로 박은 것. 값 비교는 합성 fixture 로 옮기고,\n` +
    `관리파일을 구조/불변식 검증에만 쓰면 상단에 \`// @crawl-managed-read: structural\` 을 선언하라.`,
);
process.exit(1);
