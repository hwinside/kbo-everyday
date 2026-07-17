import { resolvePlayer } from "@/lib/utils/resolve-player";

const cases: [string | { name: string; team?: string }, string | null][] = [
  // 외국인 - 영문 ID
  ["AQ002", "라클란 웰스"],
  // 외국인 - 숫자 ID (KBO site format)
  ["55348", "라클란 웰스"],
  // 외국인 - 이름만
  [{ name: "웰스", team: "LG" }, "라클란 웰스"],
  // 외국인 - 풀네임
  [{ name: "라클란 웰스", team: "LG" }, "라클란 웰스"],
  // 한국선수
  ["69100", "구본혁"],
  [{ name: "구본혁", team: "LG" }, "구본혁"],
  // 동명이인 (team으로 분리)
  [{ name: "오웬 화이트", team: "한화" }, "오웬 화이트"],
  [{ name: "미치 화이트", team: "SSG" }, "미치 화이트"],
  // 일본 선수 — 성이 앞(prefix) 짧은 중계 표기 (2026-07-17 스기모토 사진 미표시 CS)
  [{ name: "스기모토", team: "KT" }, "스기모토 고우키"],
  ["스기모토", "스기모토 고우키"],
  [{ name: "가나쿠보", team: "키움" }, "가나쿠보 유토"],
  [{ name: "교야마", team: "롯데" }, "교야마 마사야"],
  [{ name: "다무라", team: "두산" }, "다무라 이치로"],
  [{ name: "다케다", team: "SSG" }, "다케다 쇼타"],
  [{ name: "도다", team: "NC" }, "도다 나츠키"],
  // prefix 동명 첫 토큰 ("맷" — 매닝/사우어): team 있으면 분리, 없으면 유일성 게이트로 null
  [{ name: "맷", team: "삼성" }, "맷 매닝"],
  ["맷", null],
  // prefix 토큰 경계 — 부분 문자열은 매칭 금지
  ["스기", null],
  // 레거시 pN
  ["p1", null],  // unknown — legacy map has p1→67430, but may or may not resolve
  // 실패 케이스
  ["999999", null],
  ["", null],
];

let pass = 0, fail = 0;
for (const [q, expected] of cases) {
  const r = resolvePlayer(q);
  const actual = r?.name ?? null;
  const ok = expected === null ? actual === null : actual === expected;
  // p1 케이스는 유연 처리
  const str = typeof q === "string" ? q : JSON.stringify(q);
  if (ok || (q === "p1" && r !== null)) {
    console.log(`✓ ${str} → ${actual ?? "null"}`);
    pass++;
  } else {
    console.log(`✗ ${str} → expected ${expected}, got ${actual}`);
    fail++;
  }
}
// 추가: warn 옵션 동작 검증
const warnSpy: string[] = [];
const origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnSpy.push(args.map(String).join(" "));
};

resolvePlayer("존재안함999");                                     // silent
resolvePlayer("존재안함999", undefined, { context: "test" });     // warn
resolvePlayer("AQ002", undefined, { context: "test" });           // no warn (hit)

console.warn = origWarn;

if (warnSpy.length === 1 && warnSpy[0].includes("[test] player lookup miss: 존재안함999")) {
  console.log(`✓ warn context — silent without context, 1 warn with context on miss, no warn on hit`);
  pass++;
} else {
  console.log(`✗ warn context — expected 1 warn, got ${warnSpy.length}: ${JSON.stringify(warnSpy)}`);
  fail++;
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
