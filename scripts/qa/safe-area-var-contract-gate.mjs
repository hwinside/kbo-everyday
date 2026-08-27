#!/usr/bin/env node
/**
 * safe-area 단일 계약 게이트 v2 (#1264, 삼순 2차 NO-GO 반영).
 *
 * 계약: src 안의 모든 safe-area 소비는
 *   var(--safe-area-inset-X, env(safe-area-inset-X[, fb]))   ← 축(X) 일치 필수
 * 형태여야 한다. Android 네이티브(Capacitor 8 SystemBars, API 35+)가 실측 인셋을
 * `--safe-area-inset-*` CSS 변수로 주입하고, 미주입 플랫폼(iOS·웹/PWA)은 env()로
 * 폴백한다.
 *
 * 판정 4축 (전부 주석 라인 제외):
 *  [1] bare env — `env(safe-area-inset-X)` 가 var(--safe-area-inset-X, ...) 폴백
 *      내부가 아닌 곳에 등장하면 FAIL (env()=0 기기에서 겹침 재발 축).
 *  [2] var 폴백 계약 — `var(--safe-area-inset-X, ...)` 의 폴백이
 *      `env(safe-area-inset-X` 로 시작하지 않으면 FAIL. 폴백 제거
 *      (`var(--safe-area-inset-top, 0px)`)와 축 swap
 *      (`var(--safe-area-inset-top, env(safe-area-inset-bottom))`) 모두 잡는다.
 *      폴백 없는 `var(--safe-area-inset-X)` 단독도 FAIL (iOS 미주입 → no-op).
 *  [3] className arbitrary 공백 — className 의 `[...safe-area-inset...]` 안에
 *      공백이 있으면 FAIL. 공백은 class token 을 분할해 Tailwind 유틸이
 *      생성/적용되지 않는다 (2차 NO-GO 실사고: 16곳 false-green).
 *  [4] Tailwind 산출 CSS — src 에서 추출한 safe-area arbitrary class 후보 전부를
 *      Tailwind v4 compile API 로 실제 빌드해, 각 후보가 --safe-area-inset 선언을
 *      가진 유틸을 실제로 산출하는지 확인한다 (존재 확인이 아니라 산출물 검증).
 *
 * --selftest: 결함주입 픽스처 RED 6 / GREEN 3 로 검출력을 증명한다.
 * 실제 스캔과 동일한 판정 함수를 태운다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const EXTS = new Set([".css", ".tsx", ".ts"]);
const ROOT = "src";
const AXES = "(top|bottom|left|right)";

function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** [1] bare env 위반 */
export function findBareEnvViolations(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (isCommentLine(line)) return;
    const re = new RegExp(`env\\(\\s*safe-area-inset-${AXES}`, "g");
    let m;
    while ((m = re.exec(line)) !== null) {
      const name = `safe-area-inset-${m[1]}`;
      const before = line.slice(0, m.index);
      const wrapRe = new RegExp(`var\\(\\s*--${name}\\s*,\\s*$`);
      if (!wrapRe.test(before)) out.push({ line: i + 1, rule: "bare-env", name, text: line.trim().slice(0, 160) });
    }
  });
  return out;
}

/** [2] var 폴백 계약 위반 — 폴백 부재·env 아님·축 불일치 */
export function findVarFallbackViolations(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (isCommentLine(line)) return;
    const re = new RegExp(`var\\(\\s*--safe-area-inset-${AXES}\\s*(,?)`, "g");
    let m;
    while ((m = re.exec(line)) !== null) {
      const axis = m[1];
      const rest = line.slice(re.lastIndex);
      if (m[2] !== ",") {
        // 폴백 없음: var(--safe-area-inset-X)
        out.push({ line: i + 1, rule: "no-fallback", name: `safe-area-inset-${axis}`, text: line.trim().slice(0, 160) });
        continue;
      }
      const fbRe = new RegExp(`^\\s*env\\(\\s*safe-area-inset-${axis}\\b`);
      if (!fbRe.test(rest)) {
        out.push({ line: i + 1, rule: "fallback-not-env-or-axis", name: `safe-area-inset-${axis}`, text: line.trim().slice(0, 160) });
      }
    }
  });
  return out;
}

/** [3] className arbitrary bracket 내 공백 */
export function findClassNameSpaceViolations(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (isCommentLine(line) || !line.includes("className")) return;
    const re = /\[([^\[\]]*safe-area-inset[^\[\]]*)\]/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      if (/\s/.test(m[1])) out.push({ line: i + 1, rule: "classname-space", name: "arbitrary", text: line.trim().slice(0, 160) });
    }
  });
  return out;
}

/** [4] className 에서 safe-area arbitrary class 후보 추출 (변형 prefix 포함) */
export function extractArbitraryCandidates(text) {
  const found = new Set();
  text.split("\n").forEach((line) => {
    if (isCommentLine(line) || !line.includes("className")) return;
    const re = /[!\w:-]*-\[[^\[\]\s"']*safe-area-inset[^\[\]\s"']*\]/g;
    let m;
    while ((m = re.exec(line)) !== null) found.add(m[0]);
  });
  return [...found];
}

/** [4] Tailwind v4 compile 로 후보 전부의 유틸 산출을 검증 */
export async function verifyTailwindBuild(candidates) {
  const { compile } = await import("tailwindcss");
  const compiler = await compile("@tailwind utilities;");
  const misses = [];
  for (const cand of candidates) {
    const css = compiler.build([cand]);
    // 산출 CSS 에 실제 rule 블록 + --safe-area-inset 선언이 있어야 인정
    if (!css.includes("{") || !css.includes("--safe-area-inset")) misses.push(cand);
  }
  return misses;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXTS.has(extname(p))) yield p;
  }
}

function scanText(text) {
  return [
    ...findBareEnvViolations(text),
    ...findVarFallbackViolations(text),
    ...findClassNameSpaceViolations(text),
  ];
}

async function selftest() {
  const fixtures = [
    // RED 기대
    { label: "bare env 소비", text: 'padding-top: env(safe-area-inset-top, 0px);', red: true },
    { label: "bare env (calc)", text: 'style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)" }}', red: true },
    { label: "env 폴백 제거", text: 'padding-top: var(--safe-area-inset-top, 0px);', red: true },
    { label: "축 swap 폴백", text: 'padding-top: var(--safe-area-inset-top, env(safe-area-inset-bottom, 0px));', red: true },
    { label: "폴백 없는 var 단독", text: 'padding-top: var(--safe-area-inset-top);', red: true },
    { label: "className bracket 공백", text: 'className="pb-[var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))]"', red: true },
    // GREEN 기대
    { label: "정상 var 계약", text: 'padding-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px));', red: false },
    { label: "정상 className token", text: 'className="pb-[var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))]"', red: false },
    { label: "주석 라인", text: ' * 주석: env(safe-area-inset-top) 이 0 으로 깨지는 케이스.', red: false },
  ];
  let bad = 0;
  fixtures.forEach((f, i) => {
    const hit = scanText(f.text).length > 0;
    const ok = hit === f.red;
    console.log(`  ${ok ? "✅" : "❌"} selftest#${i + 1} [${f.red ? "RED" : "GREEN"}] ${f.label} → ${hit ? "검출" : "통과"}`);
    if (!ok) bad++;
  });
  // [4] Tailwind 산출 mutation: 정상 토큰은 산출, 공백 분할 잔해 토큰은 미산출(RED)
  const okBuild = await verifyTailwindBuild(["pb-[var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))]"]);
  const brokenBuild = await verifyTailwindBuild(["pb-[var(--safe-area-inset-bottom,"]);
  const buildOk = okBuild.length === 0 && brokenBuild.length === 1;
  console.log(`  ${buildOk ? "✅" : "❌"} selftest#tw Tailwind 산출 검증 (정상=산출 / 분할잔해=미산출 RED)`);
  if (!buildOk) bad++;
  if (bad > 0) {
    console.error(`safe-area var contract gate: SELFTEST FAIL (${bad})`);
    process.exit(1);
  }
  console.log("safe-area var contract gate: SELFTEST PASS (RED 7 / GREEN 3)");
}

async function main() {
  if (process.argv.includes("--selftest")) {
    await selftest();
    return;
  }
  let files = 0;
  const offenders = [];
  const candidates = new Set();
  for (const p of walk(ROOT)) {
    const text = readFileSync(p, "utf8");
    if (!text.includes("safe-area-inset")) continue;
    files++;
    for (const v of scanText(text)) offenders.push(`${p}:${v.line} [${v.rule}] ${v.text}`);
    for (const c of extractArbitraryCandidates(text)) candidates.add(c);
  }
  if (offenders.length > 0) {
    console.error(`safe-area var contract gate: FAIL — 계약 위반 ${offenders.length}건:`);
    for (const o of offenders) console.error(`  ${o}`);
    process.exit(1);
  }
  const misses = await verifyTailwindBuild([...candidates]);
  if (misses.length > 0) {
    console.error(`safe-area var contract gate: FAIL — Tailwind 유틸 미산출 class ${misses.length}건:`);
    for (const c of misses) console.error(`  ${c}`);
    process.exit(1);
  }
  console.log(
    `safe-area var contract gate: PASS (소비 파일 ${files}개 · 계약 위반 0건 · arbitrary class ${candidates.size}종 전부 Tailwind 산출 확인)`,
  );
}

await main();
