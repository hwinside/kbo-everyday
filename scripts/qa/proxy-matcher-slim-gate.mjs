#!/usr/bin/env node
/**
 * proxy-matcher-slim-gate
 *
 * 계약(2026-08-20, Vercel 비용 3순위 — proxy matcher 슬림):
 *  1. /api/* 폴링·읽기 경로는 middleware(proxy)에 매칭되지 않는다(0.73M+회/일 no-op 호출 제거).
 *  2. 단 /api/standings 는 예외로 매칭 유지 — 워치 UA 계측은 CDN 캐시 앞단(proxy)에서만 전량 잡힌다.
 *  3. 문서/페이지 경로는 계속 매칭 — canonical 308 redirect + top-level 세션 갱신(#890) 보존.
 *  4. 함수 본문의 `/api/` 패스스루 분기는 방어적으로 유지(마처가 넘겨도 행동 동일).
 *
 * 판정은 소스 문자열 존재가 아니라 **matcher 정규식을 실제로 컴파일해 경로 매트릭스를 실행**한다.
 * (Next matcher "/((?!...).*)" 형태는 ^/((?!...).*)$ 정규식과 동치 — 기존 catch-all 패턴과 동일 형식.)
 *
 * --selftest: matcher 결함 3종을 in-memory 주입해 게이트가 RED 를 내는지 자기검증.
 */
import { readFileSync } from "node:fs";

const PROXY = "src/proxy.ts";

/**
 * 주석을 공백으로 치환(오프셋 보존) — 주석 문구가 본문 assertion 을 대신 만족시키는
 * false-green 차단(2026-08-19 #1256 M2 동일 축). 문자열 리터럴 내부는 건드리지 않는다.
 */
function blankComments(source) {
  let out = "";
  let i = 0;
  let mode = "code";
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === "code") {
      if (ch === "'" || ch === '"' || ch === "`") { mode = ch; out += ch; i += 1; continue; }
      if (ch === "/" && next === "/") { mode = "line"; out += "  "; i += 2; continue; }
      if (ch === "/" && next === "*") { mode = "block"; out += "  "; i += 2; continue; }
      out += ch; i += 1; continue;
    }
    if (mode === "line") { out += ch === "\n" ? "\n" : " "; if (ch === "\n") mode = "code"; i += 1; continue; }
    if (mode === "block") {
      if (ch === "*" && next === "/") { mode = "code"; out += "  "; i += 2; }
      else { out += ch === "\n" ? "\n" : " "; i += 1; }
      continue;
    }
    out += ch;
    if (ch === "\\") { out += source[i + 1] ?? ""; i += 2; continue; }
    if (ch === mode) mode = "code";
    i += 1;
  }
  return out;
}

function extractMatcher(source) {
  const m = source.match(/matcher:\s*\[\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  // JS 문자열 리터럴 이스케이프 해제(\\ → \)
  return m[1].replace(/\\\\/g, "\\");
}

function compileMatcher(matcherStr) {
  // "/(<inner>)" 형태만 지원(현행 패턴). path-to-regexp 커스텀 그룹 → 전체 앵커 정규식.
  const m = matcherStr.match(/^\/\((.*)\)$/);
  if (!m) throw new Error(`지원하지 않는 matcher 형태: ${matcherStr}`);
  return new RegExp(`^/(${m[1]})$`);
}

/** [경로, 매칭 기대값, 이유] */
const MATRIX = [
  // 문서/페이지 — canonical redirect + 세션 갱신 보존
  ["/", true, "홈 문서"],
  ["/players/12345", true, "선수 페이지"],
  ["/posts/abc", true, "게시글 페이지"],
  ["/login", true, "로그인 페이지"],
  // 워치 계측 예외 — 반드시 매칭 유지
  ["/api/standings", true, "워치 UA 계측(proxy 전량 캡처)"],
  // 고빈도 폴링/읽기 API — 매칭 제외(비용 축)
  ["/api/game-events", false, "폴링"],
  ["/api/game-relay-events", false, "폴링"],
  ["/api/game-relay", false, "폴링"],
  ["/api/game-live", false, "폴링"],
  ["/api/stats", false, "고빈도 읽기"],
  ["/api/player-stats", false, "고빈도 읽기"],
  ["/api/news/discussion/counts", false, "고빈도 읽기"],
  // 인증/쓰기 API — proxy 는 원래 no-op 패스스루였으므로 제외해도 행동 동일(본문 분기 방어 유지)
  ["/api/me", false, "route handler 자체 인증"],
  ["/api/dm/threads", false, "route handler 자체 인증"],
  ["/api/posts", false, "route handler 자체 인증"],
  // 기존 제외 유지
  ["/_next/static/chunks/app.js", false, "정적"],
  ["/_next/image", false, "정적"],
  ["/favicon.ico", false, "정적"],
  ["/logo.png", false, "이미지 확장자"],
];

function check({ mutate } = {}) {
  const failures = [];
  let source = readFileSync(PROXY, "utf8");
  if (mutate) source = mutate(source);
  // 본문 계약 판정은 주석을 지운 소스로만 한다(주석 문구 false-green 차단).
  source = blankComments(source);

  const matcherStr = extractMatcher(source);
  if (!matcherStr) return ["matcher 배열을 소스에서 찾지 못함"];
  let re;
  try {
    re = compileMatcher(matcherStr);
  } catch (error) {
    return [`matcher 컴파일 실패: ${error.message}`];
  }

  for (const [path, expected, why] of MATRIX) {
    const actual = re.test(path);
    if (actual !== expected) {
      failures.push(`${path}: 기대 ${expected ? "매칭" : "제외"}(${why}) ↔ 실제 ${actual ? "매칭" : "제외"}`);
    }
  }

  // 방어적 본문 계약: matcher 가 넘겨도 /api 는 순수 통과여야 한다.
  if (!/pathname\.startsWith\("\/api\/"\)/.test(source)) {
    failures.push("함수 본문의 /api/ 패스스루 분기 소실 — matcher 우회 시 API 가 세션 갱신 경로를 탄다");
  }
  // 워치 계측 함수가 standings 전용으로 남아 있어야 예외 유지의 근거가 성립한다.
  if (!/pathname !== "\/api\/standings"\) return null/.test(source)) {
    failures.push("classifyWatchPlatform 의 standings 전용 가드 소실");
  }
  return failures;
}

if (process.argv.includes("--selftest")) {
  const mutations = [
    [
      "M1 api 제외 패턴 제거 — 전체 /api 가 다시 middleware 를 탄다(비용 회귀)",
      (s) => s.replace("api/(?!standings(?:/|$))|", ""),
    ],
    [
      "M2 standings 예외 제거 — 워치 계측이 middleware 에서 소실",
      (s) => s.replace("api/(?!standings(?:/|$))", "api/"),
    ],
    [
      "M3 문서 경로 제외 — canonical redirect·세션 갱신 소실",
      (s) => s.replace("_next/static", "players"),
    ],
    [
      "M4 본문 /api 패스스루 분기 제거(방어 계약)",
      (s) => s.replaceAll('pathname.startsWith("/api/")', 'pathname.startsWith("/__never__/")'),
    ],
  ];
  let ok = true;
  for (const [name, mutate] of mutations) {
    const red = check({ mutate }).length > 0;
    console.log(`${red ? "RED(기대대로 검출)" : "MISS(검출 실패)"} — ${name}`);
    if (!red) ok = false;
  }
  const base = check();
  if (base.length > 0) {
    ok = false;
    console.log("BASE NOT GREEN:");
    for (const f of base) console.log("  " + f);
  }
  process.exit(ok ? 0 : 1);
}

const failures = check();
if (failures.length > 0) {
  console.error(`proxy-matcher-slim-gate FAIL (${failures.length}건)`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`proxy-matcher-slim-gate PASS — 경로 매트릭스 ${MATRIX.length}건 + 본문 방어 계약 충족`);
