#!/usr/bin/env node
/**
 * Tailwind 산출 CSS 파싱 가능성 게이트.
 *
 * 배경 — 2026-08-06, 이 PR 자체에서 CI 가 잡은 실제 결함
 *   Tailwind v4 는 auto source detection 으로 레포 파일을 훑어 "클래스처럼 생긴
 *   문자열"을 전부 유틸 후보로 삼는다. `scripts/` 의 **주석**에 생략표를 넣은
 *   padding-bottom 임의값 예시를 적었더니 그게 그대로 클래스로 생성돼
 *   CSS 값 안에 연속 마침표가 들어갔고, Next 의 CSS 파서가
 *   `Unexpected token Delim` 로 죽으면서 전 페이지가 500 이 됐다.
 *   tsc·정적 게이트는 전부 GREEN 이었다.
 *
 *   ⚠️ 그래서 이 파일 자체도 유효한 클래스처럼 보이는 리터럴을 쓰지 않는다.
 *
 * 즉 "타입 통과 + 정적 게이트 통과"는 CSS 가 빌드된다는 증거가 아니다.
 * 이 게이트는 실제로 Tailwind 를 돌려 산출 CSS 를 만들고, 그것이 파싱 가능한지
 * 본다. 빌드 전체(수 분)를 돌리지 않고 CSS 축만 초 단위로 검증한다.
 *
 * exit 0 = PASS, 1 = FAIL, 2 = 검증 불가(= FAIL 취급)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GLOBALS = path.join(ROOT, 'src/styles/globals.css');

let postcss, tailwindcss;
try {
  ({ default: postcss } = await import('postcss'));
  ({ default: tailwindcss } = await import('@tailwindcss/postcss'));
} catch (e) {
  console.error('FAIL(검증불가): postcss/@tailwindcss/postcss 로드 실패 —', e.message);
  process.exit(2);
}

let out;
try {
  const src = readFileSync(GLOBALS, 'utf8');
  const res = await postcss([tailwindcss()]).process(src, { from: GLOBALS });
  out = res.css;
} catch (e) {
  console.error('FAIL: Tailwind 컴파일 실패 —', e.message);
  process.exit(1);
}

if (!out || out.length < 1000) {
  console.error(`FAIL(검증불가): 산출 CSS 가 비정상적으로 작음 (${out?.length ?? 0}b)`);
  process.exit(2);
}

const fails = [];

// 1) 산출 CSS 를 다시 파싱 — Next 의 CSS 파서와 같은 축의 검사.
try {
  postcss.parse(out, { from: 'generated' });
} catch (e) {
  fails.push(`산출 CSS 재파싱 실패: ${e.message}`);
}

// 2) 값 안에 생략표(`...`)가 들어간 선언 — 주석 예시가 클래스로 유출된 신호.
//    실제 CSS 값에 연속 마침표가 올 일은 없다.
for (const m of out.matchAll(/([-\w]+)\s*:\s*([^;{}]*\.{3}[^;{}]*);/g)) {
  fails.push(`값에 생략표 포함(주석 유출 의심): ${m[1]}: ${m[2].trim().slice(0, 80)}`);
}

// 3) 게이트가 대상 유틸을 실제로 만들어냈는지 (fail-close).
//    `.pb-safe` 가 안 나오면 이 PR 의 수정 자체가 산출되지 않은 것이다.
if (!/\.pb-safe\s*\{/.test(out)) {
  fails.push('.pb-safe 가 산출 CSS 에 없음 — 정의 누락 또는 소스 스캔 결손 (fail-close)');
}

const emitted = [...out.matchAll(/\.pb-[^{]*\{[^}]*\}/g)].map((m) => m[0]).filter((s) => /safe/.test(s));
console.log('=== Tailwind CSS 빌드 파싱 게이트 ===');
console.log(`  산출 CSS ${out.length.toLocaleString()}b · safe 관련 .pb-* 규칙 ${emitted.length}개`);
if (fails.length) {
  for (const f of fails) console.log('  FAIL', f);
  console.log(`\n결과: FAIL (${fails.length}건)`);
  process.exit(1);
}
console.log('  PASS 산출 CSS 재파싱 성공 · 생략표 유출 0건 · .pb-safe 산출 확인');
console.log('\n결과: PASS');
