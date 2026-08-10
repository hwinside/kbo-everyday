/**
 * KBO 공식 `…Detail/Total.aspx` 에서 career-series 게이트 fixture 를 **기계 추출**한다.
 *
 * 손으로 fixture 를 지어내지 않는다 — 2026-08-09 #1137 에서 지어낸 fixture 를
 * "실측"이라 보고한 사고(`fabricated_fixture_is_not_measurement`)의 재발 방지다.
 * 이 스크립트가 저장한 원문이 곧 게이트 입력이고, 재추출로 언제든 재검증 가능하다.
 *
 * 사용: node scripts/qa/extract-kbo-career-fixture.mjs
 *   → scripts/qa/fixtures/kbo-career-{batter,pitcher}.html 갱신
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "fixtures");
mkdirSync(outDir, { recursive: true });

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
  Referer: "https://www.koreabaseball.com/",
};

// 실존 선수 2명 — roster SSOT 의 kboId 그대로 (최형우 72443 타자 / 임찬규 61101 투수).
const TARGETS = [
  { file: "kbo-career-batter.html", url: "https://www.koreabaseball.com/Record/Player/HitterDetail/Total.aspx?playerId=72443" },
  { file: "kbo-career-pitcher.html", url: "https://www.koreabaseball.com/Record/Player/PitcherDetail/Total.aspx?playerId=61101" },
];

for (const target of TARGETS) {
  const res = await fetch(target.url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    console.error(`FAIL ${target.url}: HTTP ${res.status}`);
    process.exitCode = 1;
    continue;
  }
  const html = await res.text();
  // 게이트가 보는 최소 표면만 남긴다: lblName 마커 + 첫 테이블. 나머지(스크립트·광고·네비)는
  // 재현성을 해치는 노이즈다. 잘라내기만 하고 **내용은 바이트 그대로** 둔다.
  const name = html.match(/<span[^>]*lblName[^>]*>[^<]*<\/span>/)?.[0];
  const table = html.match(/<table[^>]*>[\s\S]*?<\/table>/)?.[0];
  if (!name || !table) {
    console.error(`FAIL ${target.url}: 마커/테이블을 찾지 못함 (페이지 구조 변경?)`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(join(outDir, target.file), `${name}\n${table}\n`);
  console.log(`OK ${target.file} (${name.replace(/<[^>]+>/g, "")}, table ${table.length}b)`);
}
