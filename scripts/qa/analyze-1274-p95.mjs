#!/usr/bin/env node
/**
 * #1274 p95 원장 통계 분석 — 관측된 delta 가 "실제 차이"인지 "하니스 잡음"인지 가른다.
 *
 * 배경: 본측정 2회에서 p95 판정이 뒤집혔다(1차 A1 우세, 2차 baseline 우세).
 * 같은 빌드·같은 fixture·같은 room 인데 결론이 반대면, 그건 코드 차이가 아니라
 * **측정 분해능이 신호보다 크다**는 뜻이다. 그걸 감으로 말하지 않고 수치로 증명한다.
 *
 * 산출:
 *   1) delta p95/p50/mean 의 부트스트랩 95% CI  → 0 을 포함하면 "차이 없음과 구분 불가"
 *   2) 하니스 분해능 — **같은 arm** 표본을 무작위 반반으로 갈라 잰 |p95 차이|.
 *      같은 코드끼리이므로 이 값이 곧 잡음의 크기다. 관측 delta 가 이 안이면 판정 불능.
 *   3) Mann-Whitney U — 분포 전체 비교(정규성 가정 없음)
 *
 * 사용: node scripts/qa/analyze-1274-p95.mjs [원장.json ...]
 *       인자 생략 시 evidence/dplan-p95-*.json 중 최신 2개를 pool 한다.
 */
import fs from "node:fs";
import path from "node:path";

const SEED = 1274;
let _s = SEED;
/** 결정론 RNG — 같은 원장이면 같은 CI 가 나와야 재현 가능한 근거가 된다. */
function rnd() {
  _s = (_s * 1664525 + 1013904223) >>> 0;
  return _s / 0x100000000;
}
const pick = (a) => a[Math.floor(rnd() * a.length)];

const q = (v, p) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;

const EV = "scripts/qa/evidence";
let files = process.argv.slice(2);
if (!files.length) {
  files = fs.readdirSync(EV)
    .filter((f) => /^dplan-p95-.*\.json$/.test(f))
    .map((f) => path.join(EV, f))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
    .slice(-2);
}
if (!files.length) {
  console.error("원장을 찾지 못했습니다. 먼저 본측정을 실행하세요.");
  process.exit(2);
}

const B = [], A = [];
const builds = new Set();
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  B.push(...d.baseline.samples);
  A.push(...d.a1.samples);
  builds.add(`${d.builds.baseline.slice(0, 9)}|${d.builds.a1.slice(0, 9)}`);
  console.log(`원장 ${path.basename(f)}  baseline n=${d.baseline.n} p95=${d.baseline.p95}  a1 n=${d.a1.n} p95=${d.a1.p95}`);
}
// 서로 다른 빌드쌍의 표본을 섞으면 pool 자체가 무의미해진다 — fail-close.
if (builds.size !== 1) {
  console.error(`FAIL — 원장들의 build 쌍이 다릅니다: ${[...builds].join(" / ")}`);
  process.exit(1);
}
if (!B.length || !A.length) {
  console.error("FAIL — 표본이 비었습니다(n=0 은 판정 불능).");
  process.exit(1);
}

console.log(`\npooled  baseline n=${B.length}  a1 n=${A.length}   (build ${[...builds][0]})`);
for (const [lbl, v] of [["baseline", B], ["a1", A]]) {
  console.log(`  ${lbl.padEnd(8)} p50=${q(v, .5)} p90=${q(v, .9)} p95=${q(v, .95)} mean=${mean(v).toFixed(1)} max=${Math.max(...v)}`);
}
const obs95 = q(A, .95) - q(B, .95);
console.log(`  observed delta p95 = ${obs95 >= 0 ? "+" : ""}${obs95}ms`);

// ── 1) 부트스트랩 CI ────────────────────────────────────────────────────────
const N = 20000;
const d95 = [], d50 = [], dmean = [];
for (let i = 0; i < N; i++) {
  const b = B.map(() => pick(B)), a = A.map(() => pick(A));
  d95.push(q(a, .95) - q(b, .95));
  d50.push(q(a, .5) - q(b, .5));
  dmean.push(mean(a) - mean(b));
}
console.log(`\n[부트스트랩 ${N.toLocaleString()}회] delta 의 95% CI — 0 을 포함하면 '차이 없음'과 구분 불가`);
let anyDecisive = false;
for (const [lbl, arr] of [["delta p95", d95], ["delta p50", d50], ["delta mean", dmean]]) {
  const s = arr.sort((x, y) => x - y);
  const lo = s[Math.floor(.025 * s.length)], hi = s[Math.floor(.975 * s.length)];
  const has0 = lo <= 0 && 0 <= hi;
  if (!has0) anyDecisive = true;
  console.log(`  ${lbl.padEnd(11)} [${lo >= 0 ? "+" : ""}${lo.toFixed(0)}, ${hi >= 0 ? "+" : ""}${hi.toFixed(0)}] ms   0 포함: ${has0 ? "YES (구분 불가)" : "NO (유의)"}`);
}

// ── 2) 하니스 분해능 ────────────────────────────────────────────────────────
// 같은 arm 을 반반으로 가르면 '진짜 차이'는 0 이다. 그런데도 p95 가 흔들린 폭이 잡음의 크기.
const sw = [];
for (let i = 0; i < N; i++) {
  const x = [...B];
  for (let j = x.length - 1; j > 0; j--) { const k = Math.floor(rnd() * (j + 1)); [x[j], x[k]] = [x[k], x[j]]; }
  const h = Math.floor(x.length / 2);
  sw.push(Math.abs(q(x.slice(0, h), .95) - q(x.slice(h), .95)));
}
sw.sort((a, b) => a - b);
const swMed = sw[Math.floor(sw.length / 2)], swP95 = sw[Math.floor(.95 * sw.length)], swMax = sw[sw.length - 1];
console.log(`\n[하니스 분해능] baseline 을 무작위 반반으로 갈라 잰 |p95 차이| (같은 빌드 ⇒ 진짜 차이는 0)`);
console.log(`  median=${swMed}ms  p95=${swP95}ms  max=${swMax}ms`);
const withinNoise = Math.abs(obs95) <= swP95;
console.log(`  관측 delta |${obs95}|ms 는 잡음 p95(${swP95}ms) ${withinNoise ? "이내 → 판정 불능" : "초과 → 신호 가능성"}`);

// ── 3) Mann-Whitney U ──────────────────────────────────────────────────────
const comb = [...B, ...A];
const idx = comb.map((_, i) => i).sort((i, j) => comb[i] - comb[j]);
const rk = new Array(comb.length);
for (let i = 0; i < idx.length;) {
  let j = i;
  while (j + 1 < idx.length && comb[idx[j + 1]] === comb[idx[i]]) j++;
  const avg = (i + j) / 2 + 1;
  for (let k = i; k <= j; k++) rk[idx[k]] = avg;
  i = j + 1;
}
const n1 = B.length, n2 = A.length;
const R1 = rk.slice(0, n1).reduce((a, b) => a + b, 0);
const U1 = R1 - n1 * (n1 + 1) / 2;
const U = Math.min(U1, n1 * n2 - U1);
const mu = n1 * n2 / 2, sd = Math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12);
const z = (U - mu) / sd;
const erf = (x) => { // Abramowitz-Stegun 7.1.26
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
};
const p = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
console.log(`\n[Mann-Whitney U] U=${U.toFixed(0)} z=${z.toFixed(3)} p=${p.toFixed(3)} → ${p > 0.05 ? "유의차 없음" : "유의차 있음"}`);

console.log(`\n=== 판정 ===`);
if (!anyDecisive && p > 0.05 && withinNoise) {
  console.log(`  채팅 지연에 **검출 가능한 회귀 없음**. 단, 이 표본수에서 p95 단일 임계는 판정 불능이다`);
  console.log(`  (잡음 p95 ${swP95}ms > 관측 delta ${Math.abs(obs95)}ms). 효과 판정은 network signature 로 한다.`);
} else {
  console.log(`  유의한 차이 신호가 있다. 원장을 다시 확인할 것.`);
  process.exit(1);
}
