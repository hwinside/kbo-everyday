#!/usr/bin/env node
/**
 * readonly-api-edge-cache-gate
 *
 * 계약: 읽기 전용 고빈도 API 3종(stats/player-stats/news counts)은 성공 응답에 엣지캐시
 * 헤더를 싣고, degraded fallback·에러 응답은 절대 캐시하지 않는다(no-store fail-close).
 * 배경: 2026-08-12 Vercel 24h 실측 — counts 307K + stats 225K + player-stats 198K ≈ 0.73M inv/일.
 * #1114 relay 엣지캐시와 동일 축. 삼순 NO-GO 4개 blocker 반영:
 *  1) counts GET RPC는 query-guard bounded annotation 필수
 *  2) TTL 누적 금지 — stats는 remaining-TTL, player-stats는 60초 상한
 *  3) player-stats upstream 장애(res.ok/parse anomaly)는 throw → no-store ('기록 없음'과 구분)
 *  4) stats의 runner static-fallback 혼합 degraded도 no-store
 *
 * --selftest: 헤더 제거/오염 변이를 주입해 게이트가 RED를 내는지 자기검증.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(new URL("../..", import.meta.url).pathname);

/** [파일, [ [설명, 필수 정규식] ... ], [ [설명, 금지 정규식] ... ]] */
const CONTRACTS = [
  [
    "src/app/api/stats/route.ts",
    [
      ["remaining-TTL 파생(TTL 누적 금지)", /Math\.floor\(\(getCacheTtl\(\) - ageMs\) \/ 1000\)/],
      ["degraded 판정 헬퍼: runner static-fallback → no-store", /runnerSource === "static-fallback" \|\| result\.source === "fallback"\) return NO_STORE/],
      ["2025 static 응답 s-maxage", /season: 2025[\s\S]{0,200}?s-maxage=3600/],
      ["defense static 응답 s-maxage", /statsMeta\.defenseGeneratedAt[\s\S]{0,200}?s-maxage=3600/],
      ["인메모리 HIT 응답이 degraded 판정 경유 + 실측 age", /NextResponse\.json\(cached\.data, \{ headers: statsEdgeHeaders\(cached\.data, cached\.ageMs\) \}\)/],
      ["live 성공 응답이 degraded 판정 경유", /NextResponse\.json\(result, \{ headers: statsEdgeHeaders\(result, 0\) \}\)/],
      ["크롤 실패 fallback 응답 no-store", /source: "fallback"[\s\S]{0,300}?NO_STORE/],
      ["500 응답 no-store", /status: 500, headers: NO_STORE/],
    ],
    [["SWR 금지", /stale-while-revalidate/]],
  ],
  [
    "src/app/api/player-stats/route.ts",
    [
      ["성공 응답 60초 상한(revalidate+memory+edge 누적 방지)", /OK_HEADERS = \{ "Cache-Control": "public, s-maxage=60" \}/],
      ["upstream 비정상 상태코드 throw", /if \(!res\.ok\) throw new Error\(`upstream \$\{res\.status\}`\)/],
      ["투수 테이블 부재 = 장애 throw", /throw new Error\("upstream parse anomaly: pitcher tables missing"\)/],
      ["타자 테이블 부재 = 장애 throw", /throw new Error\("upstream parse anomaly: hitter tables missing"\)/],
      ["명시적 '기록 없음'만 null", /if \(t0\[0\] === "기록이 없습니다\."\) return null;/],
      ["인메모리 HIT 응답에 엣지 헤더", /cached: true \}, \{ headers: OK_HEADERS \}/],
      ["성공/기록없음 응답에 엣지 헤더", /\{ stats, cached: false \}, \{ headers: OK_HEADERS \}/],
      ["500 응답 no-store", /status: 500, headers: \{ "Cache-Control": "no-store" \}/],
    ],
    [
      ["SWR 금지", /stale-while-revalidate/],
      ["60초 초과 s-maxage 금지", /s-maxage=(?!60\b)\d+/],
    ],
  ],
  [
    "src/app/api/news/discussion/counts/route.ts",
    [
      ["GET 핸들러 존재(POST는 CDN 캐시 불가)", /export async function GET\(/],
      ["성공 응답 s-maxage=60", /COUNTS_CACHE_HEADERS = \{ "Cache-Control": "public, s-maxage=60" \}/],
      ["입력 상한 10개 유지", /urls\.length > 10/],
      ["RPC bounded annotation(query-guard)", /query-guard:\s*bounded\s*--\s*p_article_keys[^\n]{12,}\n[\s\S]{0,120}?getSupabaseAdmin\(\)\.rpc\("news_discussion_visible_counts"/],
      ["에러 응답 no-store", /status: 400, headers: NO_STORE/],
      ["rate-limit 유지", /allowNewsDiscussionRequest\(`counts:\$\{ip\}`\)/],
      ["POST 핸들러 유지(구클라 호환)", /export async function POST\(/],
    ],
    [["SWR 금지", /stale-while-revalidate/]],
  ],
  [
    "src/components/news/NewsCarousel.tsx",
    [
      ["클라이언트가 GET 사용", /fetch\(`\/api\/news\/discussion\/counts\?\$\{query\}`\)/],
      ["쿼리 정규화(정렬) — 캐시 키 안정화", /\.sort\(\)/],
      ["lookupId 재매핑", /a\.lookupId, Number\(result\.counts\[a\.canonicalUrl\]/],
    ],
    [["POST 잔존 금지", /method: "POST"[\s\S]{0,80}?discussion\/counts/]],
  ],
];

function check({ mutate } = {}) {
  const failures = [];
  for (const [rel, required, forbidden] of CONTRACTS) {
    let source;
    try {
      source = readFileSync(join(ROOT, rel), "utf8");
    } catch {
      failures.push(`${rel}: 파일 없음`);
      continue;
    }
    if (mutate) source = mutate(rel, source);
    for (const [desc, re] of required) {
      if (!re.test(source)) failures.push(`${rel}: [필수 누락] ${desc}`);
    }
    for (const [desc, re] of forbidden ?? []) {
      if (re.test(source)) failures.push(`${rel}: [금지 위반] ${desc}`);
    }
  }
  return failures;
}

if (process.argv.includes("--selftest")) {
  const mutations = [
    ["M1 stats 엣지 헤더 제거", (rel, s) => (rel.includes("api/stats") ? s.replaceAll("statsEdgeHeaders", "noHeaders") : s)],
    ["M2 stats 크롤 실패 fallback을 캐시로 오염", (rel, s) => (rel.includes("api/stats") ? s.replace('source: "fallback"', 'source: "fallback" /* s-maxage */').replaceAll("NO_STORE", '{ "Cache-Control": "public, s-maxage=60" }') : s)],
    ["M3 player-stats 500 no-store 제거", (rel, s) => (rel.includes("player-stats") ? s.replace('status: 500, headers: { "Cache-Control": "no-store" }', "status: 500") : s)],
    ["M4 counts GET 제거", (rel, s) => (rel.includes("discussion/counts") ? s.replace("export async function GET(", "async function disabledGET(") : s)],
    ["M5 클라 GET→POST 회귀", (rel, s) => (rel.includes("NewsCarousel") ? s.replace("fetch(`/api/news/discussion/counts?${query}`)", 'fetch("/api/news/discussion/counts", { method: "POST", body: JSON.stringify({}) }) // discussion/counts') : s)],
    ["M6 stats remaining-TTL을 고정 TTL로 회귀(누적 재발)", (rel, s) => (rel.includes("api/stats") ? s.replace("Math.floor((getCacheTtl() - ageMs) / 1000)", "Math.floor(getCacheTtl() / 1000)") : s)],
    ["M7 stats runner static-fallback degraded 캐시 오염", (rel, s) => (rel.includes("api/stats") ? s.replace('runnerSource === "static-fallback" || result.source === "fallback") return NO_STORE', 'result.source === "never") return NO_STORE') : s)],
    ["M8 player-stats res.ok 검사 제거", (rel, s) => (rel.includes("player-stats") ? s.replace("if (!res.ok) throw new Error(`upstream ${res.status}`);", "") : s)],
    ["M9 player-stats 테이블 부재를 null로 회귀(장애가 60초 캐시됨)", (rel, s) => (rel.includes("player-stats") ? s.replace('throw new Error("upstream parse anomaly: hitter tables missing")', "return null") : s)],
    ["M10 player-stats 60초 상한 초과(3600s)", (rel, s) => (rel.includes("player-stats") ? s.replace('"public, s-maxage=60"', '"public, s-maxage=3600"') : s)],
    ["M11 counts bounded annotation 제거", (rel, s) => (rel.includes("discussion/counts") ? s.replace(/\s*\/\/ query-guard: bounded -- p_article_keys[^\n]*\n/, "\n") : s)],
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
  console.error(`readonly-api-edge-cache-gate FAIL (${failures.length}건)`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log("readonly-api-edge-cache-gate PASS — 3라우트+클라 계약 충족(remaining-TTL·60s 상한·degraded/에러 no-store·SWR 0)");
