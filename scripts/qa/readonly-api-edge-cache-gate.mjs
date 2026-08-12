#!/usr/bin/env node
/**
 * readonly-api-edge-cache-gate
 *
 * 계약: 읽기 전용 고빈도 API 3종(stats/player-stats/news counts)은 성공 응답에 엣지캐시
 * 헤더를 싣고, degraded fallback·에러 응답은 절대 캐시하지 않는다(no-store fail-close).
 * 배경: 2026-08-12 Vercel 24h 실측 — counts 307K + stats 225K + player-stats 198K ≈ 0.73M inv/일.
 * #1114 relay 엣지캐시와 동일 축: TTL=인메모리 캐시 TTL 동일값, SWR 미사용, degraded 캐시 금지.
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
      ["엣지캐시 TTL이 인메모리 TTL과 동일 소스(getCacheTtl)에서 파생", /s-maxage=\$\{Math\.floor\(getCacheTtl\(\) \/ 1000\)\}/],
      ["2025 static 응답 s-maxage", /season: 2025[\s\S]{0,200}?s-maxage=3600/],
      ["defense static 응답 s-maxage", /statsMeta\.defenseGeneratedAt[\s\S]{0,200}?s-maxage=3600/],
      ["인메모리 HIT 응답에 엣지 헤더", /NextResponse\.json\(cached, \{ headers: edgeCacheHeaders\(\) \}\)/],
      ["live 성공 응답에 엣지 헤더", /NextResponse\.json\(result, \{ headers: edgeCacheHeaders\(\) \}\)/],
      ["fallback 응답 no-store", /source: "fallback"[\s\S]{0,200}?NO_STORE/],
      ["500 응답 no-store", /status: 500, headers: NO_STORE/],
    ],
    [["fallback에 s-maxage 금지", /source: "fallback"[\s\S]{0,300}?s-maxage/]],
  ],
  [
    "src/app/api/player-stats/route.ts",
    [
      ["성공 응답 s-maxage=3600 (인메모리 1h 동일값)", /OK_HEADERS = \{ "Cache-Control": "public, s-maxage=3600" \}/],
      ["인메모리 HIT 응답에 엣지 헤더", /cached: true \}, \{ headers: OK_HEADERS \}/],
      ["기록없음(null) 단기 캐시", /s-maxage=600/],
      ["500 응답 no-store", /status: 500, headers: \{ "Cache-Control": "no-store" \}/],
    ],
    [["SWR 금지", /stale-while-revalidate/]],
  ],
  [
    "src/app/api/news/discussion/counts/route.ts",
    [
      ["GET 핸들러 존재(POST는 CDN 캐시 불가)", /export async function GET\(/],
      ["성공 응답 s-maxage=60", /COUNTS_CACHE_HEADERS = \{ "Cache-Control": "public, s-maxage=60" \}/],
      ["입력 상한 10개 유지", /urls\.length > 10/],
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
    ["M1 stats 엣지 헤더 제거", (rel, s) => (rel.includes("api/stats") ? s.replaceAll("edgeCacheHeaders()", "{}") : s)],
    ["M2 stats fallback을 캐시로 오염", (rel, s) => (rel.includes("api/stats") ? s.replace('source: "fallback"', 'source: "fallback" /* s-maxage */').replaceAll("NO_STORE", '{ "Cache-Control": "public, s-maxage=60" }') : s)],
    ["M3 player-stats 500 no-store 제거", (rel, s) => (rel.includes("player-stats") ? s.replace('status: 500, headers: { "Cache-Control": "no-store" }', "status: 500") : s)],
    ["M4 counts GET 제거", (rel, s) => (rel.includes("discussion/counts") ? s.replace("export async function GET(", "async function disabledGET(") : s)],
    ["M5 클라 GET→POST 회귀", (rel, s) => (rel.includes("NewsCarousel") ? s.replace("fetch(`/api/news/discussion/counts?${query}`)", 'fetch("/api/news/discussion/counts", { method: "POST", body: JSON.stringify({}) }) // discussion/counts') : s)],
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
console.log("readonly-api-edge-cache-gate PASS — 3라우트+클라 계약 충족(SWR 0·fallback/에러 no-store)");
