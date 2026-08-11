#!/usr/bin/env node
/**
 * KBO 공식 수상 페이지(`SeriesPrize.aspx`)에서 smoke fixture 를 **기계 추출**한다.
 *
 * fixture 를 손으로 쓰지 않는 이유(2026-08-09 #1137 사고): 지어낸 fixture 는 실측이
 * 아니고, 그 위의 게이트는 검증력이 0이다. 이 추출기는 실 페이지를 받아 수상 테이블
 * 구획만 잘라 저장하고, 잘라낸 결과에 최소 신원 마커가 있는지 자체 검증한다.
 *
 * 사용: node scripts/qa/extract-kbo-series-prize-fixture.mjs
 * 출력: scripts/qa/fixtures/kbo-series-prize.fixture.html
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const URL = "https://www.koreabaseball.com/Player/Awards/SeriesPrize.aspx";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "kbo-series-prize.fixture.html");

const res = await fetch(URL, { headers: { "User-Agent": "Mozilla/5.0 (compatible; keubo-fan-qa)" } });
if (!res.ok) {
  console.error(`fetch failed: ${res.status}`);
  process.exit(1);
}
const html = await res.text();

// 수상 테이블 구획만 잘라낸다 — 페이지 전체를 넣으면 fixture 가 무엇을 고정하는지 흐려진다.
// 마커: 한국시리즈/올스타전 헤더가 있는 테이블 블록.
const tables = html.match(/<table[\s\S]*?<\/table>/g) ?? [];
const target = tables.filter((t) => t.includes("한국시리즈") && t.includes("올스타전"));
if (target.length === 0) {
  console.error("수상 테이블을 찾지 못했다 — 페이지 구조 변경 여부를 확인하라.");
  process.exit(1);
}
const fixture = target.join("\n");

// 자체 검증: 파서가 요구하는 마커·연도 행이 실제로 있는가 (빈 fixture 커밋 방지).
const years = [...fixture.matchAll(/<td[^>]*>\s*(?:<span[^>]*>)?\s*(\d{4})\s*(?:<\/span>)?\s*<\/td>/g)]
  .map((m) => Number(m[1]));
if (years.length < 10) {
  console.error(`연도 행이 ${years.length}개뿐이다 — 추출 구획이 잘못됐다.`);
  process.exit(1);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, fixture);
console.log(`fixture 저장: ${OUT} (${fixture.length} bytes, 연도 ${Math.max(...years)}~${Math.min(...years)})`);
