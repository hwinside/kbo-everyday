#!/usr/bin/env node
/**
 * safe-area 단일 계약 게이트 (#1264).
 *
 * 계약: src 안의 모든 safe-area 소비는
 *   var(--safe-area-inset-X, env(safe-area-inset-X[, fb]))
 * 형태여야 한다. Android 네이티브(Capacitor 8 SystemBars, API 35+)가 실측 인셋을
 * `--safe-area-inset-*` CSS 변수로 주입하고, 미주입 플랫폼(iOS·웹/PWA)은 env()로
 * 폴백한다. bare `env(safe-area-inset-*)` 단독 소비는 env()가 0으로 깨지는
 * Android WebView 조합(S25 3버튼 등)에서 상·하단 겹침을 재발시키는 축이므로 금지.
 *
 * 판정: 주석 라인을 제외한 소스에서 `env(safe-area-inset-X` 가
 * `var(--safe-area-inset-X, ` 로 감싸이지 않은 채 등장하면 FAIL.
 *
 * --selftest: 결함 픽스처(bare env 3종 + 정상 2종)를 스캐너에 주입해
 * 검출력(RED 3 / GREEN 2)을 증명한다. 실제 스캔과 동일한 판정 함수를 태운다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const EXTS = new Set([".css", ".tsx", ".ts"]);
const ROOT = "src";

/** 한 파일 텍스트에서 계약 위반(bare env) 라인을 찾는다. 주석 라인은 제외. */
export function findBareEnvViolations(text) {
  const violations = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    // 주석 라인 제외 (codemod 와 동일 휴리스틱): //, *, /* 로 시작하는 라인
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const re = /env\(\s*safe-area-inset-(top|bottom|left|right)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const name = `safe-area-inset-${m[1]}`;
      // 허용: 직전에 `var(--safe-area-inset-X, ` (공백 유연) 가 붙은 내부 env 폴백
      const before = line.slice(0, m.index);
      const wrapRe = new RegExp(`var\\(\\s*--${name}\\s*,\\s*$`);
      if (!wrapRe.test(before)) {
        violations.push({ line: i + 1, name, text: line.trim().slice(0, 160) });
      }
    }
  }
  return violations;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXTS.has(extname(p))) yield p;
  }
}

function selftest() {
  const fixtures = [
    // RED 기대 (bare env 소비)
    { text: 'padding-top: env(safe-area-inset-top, 0px);', red: true },
    { text: 'style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)" }}', red: true },
    { text: 'bottom: max(env( safe-area-inset-bottom , 0px), 12px);', red: true },
    // GREEN 기대 (var 계약 준수 / 주석)
    { text: 'padding-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px));', red: false },
    { text: ' * 주석: env(safe-area-inset-top) 이 0 으로 깨지는 케이스.', red: false },
  ];
  let bad = 0;
  fixtures.forEach((f, i) => {
    const hit = findBareEnvViolations(f.text).length > 0;
    const ok = hit === f.red;
    console.log(`  ${ok ? "✅" : "❌"} selftest#${i + 1} ${f.red ? "RED" : "GREEN"} 기대 → ${hit ? "검출" : "통과"}`);
    if (!ok) bad++;
  });
  if (bad > 0) {
    console.error(`safe-area var contract gate: SELFTEST FAIL (${bad})`);
    process.exit(1);
  }
  console.log("safe-area var contract gate: SELFTEST PASS (RED 3 / GREEN 2)");
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  let total = 0;
  let files = 0;
  const offenders = [];
  for (const p of walk(ROOT)) {
    const text = readFileSync(p, "utf8");
    if (!text.includes("safe-area-inset")) continue;
    files++;
    for (const v of findBareEnvViolations(text)) {
      total++;
      offenders.push(`${p}:${v.line} [${v.name}] ${v.text}`);
    }
  }
  if (total > 0) {
    console.error(`safe-area var contract gate: FAIL — bare env(safe-area-inset-*) ${total}건:`);
    for (const o of offenders) console.error(`  ${o}`);
    process.exit(1);
  }
  console.log(`safe-area var contract gate: PASS (safe-area 소비 파일 ${files}개, bare env 0건)`);
}
