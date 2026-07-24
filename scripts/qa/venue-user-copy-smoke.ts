/**
 * 직관 스토리 유저 노출 문구 회귀 — "MB" 숫자 노출 봉인 스모크.
 * 실행: npm run qa:venue-user-copy
 * 배경: PR #813/#814 삼순 blocker — 유저는 방금 찍은 영상이 몇 MB인지 모른다(하린아빠 2026-07-24).
 *       클라·서버 어디서든 venue-stories 유저 노출 문자열에 "MB"가 다시 들어오면 실패한다.
 *       (서버 route 는 data.error 를 Composer 가 그대로 노출하므로 서버 문자열도 유저 문구다.)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** 소스에서 주석 제거 후 문자열 리터럴만 뽑아 "MB" 포함 리터럴 목록 반환(순수 — 자가검증용 export 불필요) */
export function findMbStringLiterals(source: string): string[] {
  const noComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // URL(https://) 오탐 방지
  const literals = noComments.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
  return literals.filter((lit) => /MB/.test(lit));
}

// 자가검증 — 검출기가 실제로 잡는지 먼저 확인(스모크가 침묵 통과하는 사고 방지)
console.log("[detector 자가검증]");
ok("MB 문구 리터럴 검출", findMbStringLiterals(`const m = "파일이 너무 큽니다 (최대 50MB)";`).length === 1);
ok("주석 속 MB 는 무시", findMbStringLiterals(`// 50MB 백스톱\nconst m = "화질이 높아요";`).length === 0);
ok("템플릿 리터럴 MB 검출", findMbStringLiterals("const m = `최대 ${cap}MB`;").length === 1);
ok("MB 없는 문구 통과", findMbStringLiterals(`const m = "영상은 15초 이하만 올릴 수 있어요";`).length === 0);

// venue-stories 유저 노출 표면 전체 스캔
const ROOTS = [
  "src/lib/venue-stories",
  "src/app/api/venue-stories",
  "src/components/game",
];
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
const files = ROOTS.flatMap(walk).filter(
  (p) => !p.includes("src/components/game") || /VenueStor/i.test(p),
);

console.log(`[venue-stories 표면 스캔 — ${files.length}개 파일]`);
let violations = 0;
for (const file of files) {
  const hits = findMbStringLiterals(readFileSync(file, "utf8"));
  if (hits.length > 0) {
    violations += hits.length;
    console.log(`  ❌ ${file}: ${hits.join(", ")}`);
  }
}
ok("유저 노출 문자열에 'MB' 패턴 0건", violations === 0, `${violations}건 검출`);

console.log(`\n결과: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
