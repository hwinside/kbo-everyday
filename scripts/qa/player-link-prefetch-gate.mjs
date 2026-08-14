#!/usr/bin/env node
/**
 * player-link-prefetch-gate
 *
 * 계약: 선수 상세(/community/players/[playerId])로 향하는 <Link>는 prefetch={false}여야 한다.
 * 배경: 2026-08-12 Vercel 24h 실측에서 /community/players/[playerId]가 1.1M inv/일(전체 1/3)
 *        + Active CPU 1위. 원인 = 목록형 화면(홈 최애선수·선수목록·기록실·라인업·박스스코어)의
 *        viewport prefetch 폭발. 억제 시 탐색 UX 영향은 클릭 시 로드 1회뿐.
 *
 * 검사 2축:
 *  A) 전역 스캔 — src/**\/*.tsx의 모든 <Link ...> 오프닝 태그 중 태그 텍스트에
 *     "community/players"가 리터럴로 들어간 태그는 prefetch={false} 필수.
 *  B) 매니페스트 — href가 변수(href/playerHref/awayHref/homeHref)로 간접 결속된 파일은
 *     리터럴 스캔이 못 보므로, 파일별 "prefetch={false}인 <Link> 최소 개수"를 고정 계약으로 검증.
 *     (개수 미달 = 누군가 prefetch를 걷어냈다 → RED)
 *
 * 한계(정직 고지): B는 "새로 추가된 간접 href Link"까지는 못 잡는다. 리터럴 케이스는 A가 잡고,
 * 간접 신규 케이스는 리뷰 몫.
 *
 * --selftest: prefetch={false} 제거 변이를 주입해 게이트가 RED를 내는지 자기검증.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(new URL("../..", import.meta.url).pathname);
const SRC = join(ROOT, "src");

/** 간접 href 파일 매니페스트: prefetch={false} 붙은 <Link> 최소 개수 */
const MANIFEST = [
  ["src/app/(main)/players/page.tsx", 1],
  ["src/app/(main)/rankings/[stat]/page.tsx", 1],
  ["src/components/home/FavoritePlayersSection.tsx", 1],
  ["src/components/players/RecordRoom.tsx", 2],
  ["src/components/game/LineupTab.tsx", 3],
  ["src/components/game/FieldViewV2.tsx", 1],
  ["src/components/game/GameStatsTab.tsx", 2],
  ["src/components/game/MatchupCard.tsx", 2],
  ["src/components/game/AllStarEntryRoster.tsx", 1],
  ["src/components/game/PostgameInterviewSection.tsx", 1],
  ["src/components/home/TeamCard.tsx", 2],
  ["src/app/(main)/my-team/page.tsx", 2],
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (name.endsWith(".tsx")) yield p;
  }
}

/** <Link ...> 오프닝 태그 추출 (여러 줄 허용, 첫 '>'까지) */
function linkTags(source) {
  const tags = [];
  const re = /<Link\b/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const end = source.indexOf(">", m.index);
    if (end === -1) break;
    tags.push(source.slice(m.index, end + 1));
  }
  return tags;
}

function checkAll({ mutate } = {}) {
  const failures = [];

  // A) 전역 리터럴 스캔
  for (const file of walk(SRC)) {
    let source = readFileSync(file, "utf8");
    if (mutate) source = mutate(relative(ROOT, file), source);
    for (const tag of linkTags(source)) {
      if (tag.includes("community/players") && !/prefetch=\{false\}/.test(tag)) {
        failures.push(`[A] ${relative(ROOT, file)}: 선수 상세 Link에 prefetch={false} 누락 → ${tag.slice(0, 100)}`);
      }
    }
  }

  // B) 매니페스트 최소 개수
  for (const [rel, min] of MANIFEST) {
    let source;
    try {
      source = readFileSync(join(ROOT, rel), "utf8");
    } catch {
      failures.push(`[B] ${rel}: 파일 없음 — 이동/삭제 시 매니페스트 갱신 필요`);
      continue;
    }
    if (mutate) source = mutate(rel, source);
    const count = linkTags(source).filter((t) => /prefetch=\{false\}/.test(t)).length;
    if (count < min) {
      failures.push(`[B] ${rel}: prefetch={false} Link ${count}개 < 계약 ${min}개`);
    }
  }

  return failures;
}

const selftest = process.argv.includes("--selftest");

if (selftest) {
  // 변이 1: 전 파일에서 prefetch={false} 전부 제거 → A·B 모두 RED여야 함
  const f1 = checkAll({ mutate: (_rel, s) => s.replaceAll("prefetch={false}", "") });
  // 변이 2: 매니페스트 파일 하나만 제거 → B RED여야 함
  const target = MANIFEST[0][0];
  const f2 = checkAll({ mutate: (rel, s) => (rel === target ? s.replaceAll("prefetch={false}", "") : s) });
  // 변이 3: 리터럴 파일에 prefetch 없는 선수 Link 삽입 → A RED여야 함
  const f3 = checkAll({
    mutate: (rel, s) =>
      rel === target ? s + '\nexport const __mut = <Link href={`/community/players/1`}>x</Link>;\n' : s,
  });
  const results = [
    ["M1 전역 prefetch 제거", f1.length > 0],
    ["M2 단일 파일 prefetch 제거", f2.some((f) => f.includes(target))],
    ["M3 리터럴 위반 삽입", f3.some((f) => f.startsWith("[A]"))],
  ];
  let ok = true;
  for (const [name, red] of results) {
    console.log(`${red ? "RED(기대대로 검출)" : "MISS(검출 실패)"} — ${name}`);
    if (!red) ok = false;
  }
  // 원본은 GREEN이어야 selftest 의미가 있음
  const base = checkAll();
  if (base.length > 0) {
    ok = false;
    console.log("BASE NOT GREEN:");
    for (const f of base) console.log("  " + f);
  }
  process.exit(ok ? 0 : 1);
}

const failures = checkAll();
if (failures.length > 0) {
  console.error(`player-link-prefetch-gate FAIL (${failures.length}건)`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`player-link-prefetch-gate PASS — 리터럴 위반 0 · 매니페스트 ${MANIFEST.length}파일 계약 충족`);
