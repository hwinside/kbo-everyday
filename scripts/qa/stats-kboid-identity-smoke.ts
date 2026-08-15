/**
 * `/api/stats` 의 병합/출력 identity 가 **kboId(공식 playerId)** 로 묶이는가.
 *
 * ⚠️ 이 게이트가 생긴 이유 (#1100 삼순 4차 P0-3, B안 트랙).
 *
 * 병합 키가 `이름::팀` 이면 **같은 팀 동명이인**이 서로의 값을 덮어쓴다.
 * 로스터 실측으로 그런 그룹이 실재하고(이주형/키움, 이승현/삼성 등), 하류에서
 * kboId 로 걸러도 **이미 오염된 값**이라 복구되지 않는다 — 야잘알봇이 그 값을
 * 그대로 답하면 앱과도, 사실과도 다른 숫자를 말하게 된다.
 *
 * 검증 대상은 전부 **실제 배포 함수**다 (게이트가 키 규칙을 재구현하면
 * production 을 `이름::팀` 으로 되돌려도 GREEN 이다 — #1100 7차 P0-2):
 *  · `parseTable`        — KBO HTML 행에 공식 playerId 결속
 *  · `statsRowKey`/`mergeBasicRows` — Basic1 union·Basic2 lookup identity
 *  · `fetchAllRunnerRows` — Runner 전 페이지 수집 행의 playerId 보존
 *  · `buildBatterStat`   — 출력 kboId/qualifiedRate 종단
 *  · `applyRunnerStats`  — Runner 병합 kboId exact
 *
 * 실행: npm run qa:stats-kboid-identity
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import playersRoster from "../../src/lib/constants/players-roster.json";
import type { RosterPlayer } from "@/types/api";
import {
  parseTable,
  rowKboId,
  statsRowKey,
  mergeBasicRows,
  buildBatterStat,
  buildRunnerMap,
  applyRunnerStats,
  fetchAllRunnerRows,
  type ParsedTableRow,
  type Basic2Entry,
} from "../../src/app/api/stats/route";

const PAGER_PREFIX = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ucPager$";

let pass = 0;
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
    console.error(`  ❌ ${name}: ${(error as Error).message}`);
  }
}

interface RosterEntry { name: string; kboId: string; team: string }
const ROSTER = playersRoster as unknown as RosterEntry[];

/** 로스터에서 **같은 팀 동명이인** 그룹을 실제로 찾는다(하드코딩 금지 — 로스터가 바뀌면 같이 움직여야 한다). */
function findSameTeamHomonym(): { name: string; team: string; ids: string[] } {
  const groups = new Map<string, string[]>();
  for (const p of ROSTER) {
    const key = `${p.name}::${p.team}`;
    groups.set(key, [...(groups.get(key) ?? []), p.kboId]);
  }
  for (const [key, ids] of groups) {
    if (ids.length > 1) {
      const [name, team] = key.split("::");
      return { name, team, ids };
    }
  }
  throw new Error("로스터에 같은 팀 동명이인이 없다 — 이 게이트의 전제가 사라졌다");
}

/** KBO Runner 페이지 HTML 형태 그대로. 선수명 셀에 `playerId=` 앵커가 들어간다. */
function runnerPageHtml(
  rows: Array<{ playerId: string | null; name: string; team: string; sb: number; cs: number }>,
  page = 1,
  lastPage = 1,
): string {
  const trs = rows.map((r, i) => {
    const nameCell = r.playerId
      ? `<a href="/Record/Player/HitterDetail/Basic.aspx?playerId=${r.playerId}">${r.name}</a>`
      : r.name;
    return `<tr><td>${i + 1}</td><td>${nameCell}</td><td>${r.team}</td>` +
      `<td>1</td><td>1</td><td>${r.sb}</td><td>${r.cs}</td><td>0</td><td>0</td><td>0</td></tr>`;
  }).join("");
  const links = [`<a id="ucPager_btnNo${page}" class="on" href="#">${page}</a>`];
  if (page < lastPage) {
    links.push(`<a href="javascript:__doPostBack(&#39;${PAGER_PREFIX}btnNext&#39;,&#39;&#39;)">next</a>`);
  }
  return `<form><input type="hidden" name="__VIEWSTATE" value="vs-${page}" />` +
    `<input type="hidden" name="__EVENTVALIDATION" value="ev-${page}" />` +
    `<tbody>${trs}</tbody>${links.join("")}</form>`;
}

/** KBO Basic1 페이지 표 형태(16셀). */
function basicHtml(rows: Array<{ playerId: string | null; name: string; team: string; avg: string }>): string {
  return `<tbody>${rows.map((r, i) => {
    const nameCell = r.playerId
      ? `<a href="/Record/Player/HitterDetail/Basic.aspx?playerId=${r.playerId}">${r.name}</a>`
      : r.name;
    return `<tr><td>${i + 1}</td><td>${nameCell}</td><td>${r.team}</td><td>${r.avg}</td>` +
      "<td>1</td>".repeat(12) + "</tr>";
  }).join("")}</tbody>`;
}

async function main() {
  const homonym = findSameTeamHomonym();
  console.log(`  · 대상 동명이인: ${homonym.name}/${homonym.team} → ${homonym.ids.join(", ")}`);
  const [idA, idB] = homonym.ids;
  const roster = playersRoster as unknown as RosterPlayer[];

  // ── ① parseTable 이 행에 공식 playerId 를 결속한다 ──────────────────────
  await check("parseTable 이 각 행에 playerId 를 붙인다 (동명이인 2행이 다른 id)", () => {
    const parsed = parseTable(basicHtml([
      { playerId: idA, name: homonym.name, team: homonym.team, avg: ".333" },
      { playerId: idB, name: homonym.name, team: homonym.team, avg: ".111" },
    ]));
    assert.equal(parsed.length, 2);
    assert.equal(rowKboId(parsed[0]), idA, `1행 id=${rowKboId(parsed[0])}`);
    assert.equal(rowKboId(parsed[1]), idB, `2행 id=${rowKboId(parsed[1])}`);
    // 기존 셀 인덱스(이름 1 · 팀 2 · 타율 3) 계약은 그대로여야 한다.
    assert.equal(parsed[0][1], homonym.name);
    assert.equal(parsed[0][3], ".333");
  });
  await check("앵커가 없는 행은 rowKboId=\"\" → statsRowKey 가 이름::팀 하위호환", () => {
    const parsed = parseTable(basicHtml([{ playerId: null, name: "무명", team: "두산", avg: ".200" }]));
    assert.equal(rowKboId(parsed[0]), "");
    assert.equal(statsRowKey(parsed[0]), "무명::두산");
  });
  await check("production KBO 응답 형태(개행·data-id 속성 포함)에서도 결속된다", () => {
    const real = '<tbody><tr>\n<td>1</td>\n' +
      '<td><a href="/Record/Player/HitterDetail/Basic.aspx?playerId=50500">황성빈</a></td>\n' +
      '<td>롯데</td><td data-id="GAME_CN">80</td><td data-id="SBA_CN">41</td>' +
      '<td data-id="SB_CN">35</td><td data-id="CS_CN">6</td>' +
      '<td>85.4</td><td>4</td><td>4</td>\n</tr></tbody>';
    const parsed = parseTable(real);
    assert.equal(rowKboId(parsed[0]), "50500");
  });

  // ── ② Basic1 union 이 identity 로 갈린다 (7차 P0-2 축) ──────────────────
  await check("같은 팀 동명이인의 Basic1 원본 행이 first-match 로 삼켜지지 않는다", () => {
    const t1 = parseTable(basicHtml([
      { playerId: idA, name: homonym.name, team: homonym.team, avg: ".333" },
      { playerId: idB, name: homonym.name, team: homonym.team, avg: ".111" },
    ]));
    const merged = mergeBasicRows([t1]);
    assert.equal(merged.length, 2, `union 결과 ${merged.length}행 — 동명이인 1행이 삼켜졌다`);
    assert.notEqual(statsRowKey(merged[0]), statsRowKey(merged[1]));
  });
  await check("같은 playerId 는 정렬 테이블이 달라도 1행으로 dedupe 된다", () => {
    const t1 = parseTable(basicHtml([{ playerId: idA, name: homonym.name, team: homonym.team, avg: ".333" }]));
    const t2 = parseTable(basicHtml([{ playerId: idA, name: homonym.name, team: homonym.team, avg: ".333" }]));
    assert.equal(mergeBasicRows([t1, t2]).length, 1);
  });

  // ── ③ 출력 종단: buildBatterStat 의 kboId·qualifiedRate (8차 P0-2/P0-3 축) ─
  await check("동명이인 2행의 출력 kboId 가 서로 다른 공식 id 다 (로스터 first-match 아님)", () => {
    const parsed = parseTable(basicHtml([
      { playerId: idA, name: homonym.name, team: homonym.team, avg: ".333" },
      { playerId: idB, name: homonym.name, team: homonym.team, avg: ".111" },
    ]));
    const basic2Map = new Map<string, Basic2Entry>();
    const qualified = new Set<string>([statsRowKey(parsed[0])]);
    const a = buildBatterStat(parsed[0], 0, roster, basic2Map, qualified);
    const b = buildBatterStat(parsed[1], 1, roster, basic2Map, qualified);
    assert.equal(a.kboId, idA, `출력 kboId=${a.kboId}`);
    assert.equal(b.kboId, idB, `출력 kboId=${b.kboId}`);
    assert.notEqual(a.kboId, b.kboId, "출력 ID 가 같다 — 하류가 다시 섞인다");
    // qualifiedRate 는 저장키(statsRowKey)와 같은 키로 조회해야 한다.
    assert.equal(a.qualifiedRate, 1);
    assert.equal(b.qualifiedRate, 0);
  });
  await check("Basic2 join 도 identity 키로 맞는다 (동명이인 b2 가 섞이지 않는다)", () => {
    const b1 = parseTable(basicHtml([
      { playerId: idA, name: homonym.name, team: homonym.team, avg: ".333" },
      { playerId: idB, name: homonym.name, team: homonym.team, avg: ".111" },
    ]));
    const basic2Map = new Map<string, Basic2Entry>([
      [idA, { bb: 30, ibb: 1, hbp: 2, so: 40, gdp: 3, slg: ".500", obp: ".400", ops: ".900" }],
      [idB, { bb: 5, ibb: 0, hbp: 0, so: 10, gdp: 1, slg: ".300", obp: ".280", ops: ".580" }],
    ]);
    const a = buildBatterStat(b1[0], 0, roster, basic2Map, new Set());
    const b = buildBatterStat(b1[1], 1, roster, basic2Map, new Set());
    assert.equal(a.bb, 30);
    assert.equal(b.bb, 5, `동명이인 b2 오염: bb=${b.bb}`);
  });

  // ── ④ Runner 수집 행의 playerId 보존 (4차 P0-3 핵심 전제) ────────────────
  // ⚠️ production 은 전 페이지 수집 완결(최소 9페이지·250행)을 요구한다. 축소 fixture 를 쓰면
  // "불완전 수집" 으로 거절돼 이 검사가 병합 계약이 아니라 상한 검사가 돼버린다.
  // 그래서 실제 형상대로 11페이지·329행을 만들고, **동명이인 2행을 그 안에 심는다**.
  await check("fetchAllRunnerRows 수집 행이 playerId 를 유지한다 (전 페이지)", async () => {
    const pages: string[] = [];
    let seq = 0;
    for (let page = 1; page <= 11; page += 1) {
      const count = page === 11 ? 29 : 30;
      const pageRows = Array.from({ length: count }, () => {
        seq += 1;
        if (seq === 1) return { playerId: idA, name: homonym.name, team: homonym.team, sb: 9, cs: 2 };
        if (seq === 2) return { playerId: idB, name: homonym.name, team: homonym.team, sb: 0, cs: 0 };
        return { playerId: String(900000 + seq), name: `선수${seq}`, team: "두산", sb: 0, cs: 0 };
      });
      pages.push(runnerPageHtml(pageRows, page, 11));
    }
    let current = 0;
    const fakeFetch = (async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") current += 1;
      return new Response(pages[current], {
        status: 200,
        headers: current === 0 ? { "set-cookie": "ASP.NET_SessionId=identity-test; path=/" } : {},
      });
    }) as unknown as typeof fetch;

    const rows = await fetchAllRunnerRows(fakeFetch);
    assert.equal(rows.length, 329, `수집 행수 ${rows.length}`);
    assert.equal(rowKboId(rows[0]), idA, `1행 id=${rowKboId(rows[0])}`);
    assert.equal(rowKboId(rows[1]), idB, `2행 id=${rowKboId(rows[1])}`);
    // 기존 인덱스 계약(이름 1 · SB 5)은 그대로여야 한다.
    assert.equal(rows[0][1], homonym.name);
    assert.equal(rows[0][5], "9");
    // 마지막 페이지 행에도 결속돼야 한다(첫 페이지만 붙는 변종 차단).
    assert.ok(rowKboId(rows[328]), "마지막 행에 playerId 가 없다");
  });

  // ── ⑤ Runner 병합이 identity 로 갈린다 (4차 P0-3 핵심) ──────────────────
  // ⚠️ map 구성도 **실제 배포 함수**(buildRunnerMap)로 만든다 — 게이트가 직접 만들면
  // production 구성 키를 `이름::팀` 으로 되돌려도 GREEN 이다(1차 검증에서 실제로 놓친 mutation).
  const runnerParsed = parseTable(runnerPageHtml([
    { playerId: idA, name: homonym.name, team: homonym.team, sb: 9, cs: 2 },
    { playerId: idB, name: homonym.name, team: homonym.team, sb: 0, cs: 0 },
    { playerId: null, name: "무명", team: "두산", sb: 4, cs: 1 },
  ]));
  const runnerMap = buildRunnerMap(runnerParsed);
  await check("buildRunnerMap 이 kboId exact 키로 묶고, id 없는 행은 버린다", () => {
    assert.deepEqual([...runnerMap.keys()].sort(), [idA, idB].sort(), `키=${[...runnerMap.keys()]}`);
    assert.equal(runnerMap.get(idA)?.sb, 9);
    assert.equal(runnerMap.get(idB)?.sb, 0);
    assert.equal(runnerMap.size, 2, "playerId 없는 행이 이름으로 추정 병합됐다");
  });
  await check("같은 팀 동명이인이 서로의 도루를 덮어쓰지 않는다", () => {
    const merged = applyRunnerStats([
      { rank: 1, name: homonym.name, team: homonym.team, kboId: idA, sb: 0, cs: 0 },
      { rank: 2, name: homonym.name, team: homonym.team, kboId: idB, sb: 0, cs: 0 },
    ], runnerMap);
    assert.equal(Number(merged[0].sb), 9, `${idA} 도루가 ${merged[0].sb} — identity 병합이 아니다`);
    assert.equal(Number(merged[1].sb), 0, `${idB} 가 ${merged[1].sb} 로 오염됐다 — 동명이인이 서로 덮어썼다`);
    assert.notEqual(Number(merged[0].sb), Number(merged[1].sb), "동명이인 두 행이 같은 도루 값 — 이름::팀 키로 병합되고 있다");
  });
  await check("kboId 없는 행은 이름::팀 값이 있어도 병합하지 않는다", () => {
    const unsafeMap = new Map<string, { sb: number; cs: number }>([["무명::두산", { sb: 4, cs: 1 }]]);
    const merged = applyRunnerStats(
      [{ rank: 1, name: "무명", team: "두산", kboId: "", sb: 0, cs: 0 }],
      unsafeMap,
    );
    assert.equal(Number(merged[0].sb), 0, "name::team fallback 이 동명이인 오염을 허용한다");
  });
  await check("map 에 없는 선수는 기존 값을 유지한다(0 으로 밀지 않는다)", () => {
    const merged = applyRunnerStats(
      [{ rank: 1, name: "미수집", team: "LG", kboId: "99999999", sb: 7, cs: 3 }],
      runnerMap,
    );
    assert.equal(Number(merged[0].sb), 7);
    assert.equal(Number(merged[0].cs), 3);
  });
  await check("외국인 영문 id 도 canonical 로 매칭된다 (숫자 vs 영문 이중체계)", () => {
    const map = new Map<string, { sb: number; cs: number }>([["50500", { sb: 3, cs: 1 }]]);
    const merged = applyRunnerStats(
      [{ rank: 1, name: "황성빈", team: "롯데", kboId: " 50500 ", sb: 0, cs: 0 }],
      map,
    );
    assert.equal(Number(merged[0].sb), 3, "kboId 공백/형식 차이가 canonical 로 안 맞춰진다");
  });

  // ── ⑥ 투수·완결성 가드 소스 결속 (실행 경로가 네트워크라 소스로 고정) ────
  // ⚠️ 보조 앵커일 뿐 주 검증이 아니다 — 위 ①~⑤가 실제 함수를 태운다.
  await check("투수 병합·규정이닝 플래그·Runner map 구성이 배포 함수에 결속된다 (소스 결속)", () => {
    const src = readFileSync("src/app/api/stats/route.ts", "utf8");
    // ⚠️ 호출부 결속 — buildRunnerMap 을 인라인 name::team 구성으로 우회하면
    // 함수 자체는 멀씩해도 production 이 오염된다(mutation M2b 실측 GREEN 이었던 구멍).
    const batterBlock = src.slice(src.indexOf("async function fetchBatterStats"), src.indexOf("export function buildRunnerMap"));
    assert.match(batterBlock, /buildRunnerMap\(runnerResult\.rows\)/, "fetchBatterStats 가 buildRunnerMap 을 타지 않는다");
    assert.doesNotMatch(batterBlock, /runnerMap\.set\(`\$\{/, "Runner map 이 인라인 name::team 구성으로 우회됐다");
    const pitcherBlock = src.slice(src.indexOf("async function fetchPitcherStats"), src.indexOf("interface StatsResult"));
    assert.match(pitcherBlock, /const key = statsRowKey\(c\);/, "투수 병합 키가 statsRowKey 가 아니다");
    assert.match(pitcherBlock, /p\.qualifiedRate = qualifiedKeys\.has\(key\)/, "투수 qualifiedRate 가 병합 키와 다른 키로 조회된다");
    assert.doesNotMatch(pitcherBlock, /qualifiedKeys\.has\(`\$\{p\.name\}/, "투수 qualifiedRate 가 이름::팀 으로 되돌아갔다");
    const assertBlock = src.slice(src.indexOf("function assertStatsComplete"), src.indexOf("async function fetchCurrentStats"));
    assert.match(assertBlock, /canonicalKboId\(String\(row\.kboId/, "완결성 uniqueness 가 identity 를 안 본다 — 동명이인 정상 응답을 partial 로 오판한다");
  });

  console.log(failures.length === 0
    ? `\n✅ stats kboId identity: ${pass} PASS`
    : `\n❌ stats kboId identity: ${pass} PASS / ${failures.length} FAIL`);
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error("stats-kboid-identity-smoke crashed:", error);
  process.exit(1);
});
