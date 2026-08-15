/**
 * `/api/stats` 의 병합/출력 identity 가 **kboId(공식 playerId)** 로 묶이고,
 * identity 무결성 실패(ID 결손·중복·부분 coverage)는 혼합 없이 **전체 fallback** 으로
 * fail-close 되는가 — actual route(GET 종단) 양방향 게이트.
 *
 * ⚠️ 이 게이트가 생긴 이유 (#1100 삼순 4차 P0-3 → #1196 1차 NO-GO).
 * 병합 키가 `이름::팀` 이면 같은 팀 동명이인(로스터 실측 실재)이 서로의 값을 덮어쓴다.
 * 1차 구현은 ID 결손 행을 `이름::팀` 하위호환으로 흡수했는데, 그 하위호환 자체가
 * 동명이인 오염 경로라 **fail-close → 전체 fallback** 으로 계약을 바꿨다(삼순 P0).
 *
 * 구성:
 *  · 순수 함수 검사 — 실제 배포 함수(parseTable·mergeBasicRows·buildRunnerMap·
 *    buildBatterStat·applyRunnerStats·assertStatsComplete·fetchAllRunnerRows)를 직접 실행
 *  · route 종단 시나리오 — global.fetch 를 KBO fixture 로 모킹하고 **GET 을 그대로 호출**.
 *    모듈 인메모리 캐시 오염을 막기 위해 시나리오마다 자기 자신을 child process 로 띄운다.
 *    정상(live·동명이인 반대쌍) / ID 결손(basic1·runner·pitcher) / Basic2 부분 coverage
 *    양방향을 모두 판정한다.
 *
 * 실행: npm run qa:stats-kboid-identity
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import playersRoster from "../../src/lib/constants/players-roster.json";
import batterStats2026 from "../../src/lib/constants/stats-2026-batters.json";
import { canonicalKboId } from "../../src/lib/utils/resolve-player";

/** static 에서 raw≠canonical 외국인을 실제로 찾는다(하드코딩 금지 — 실측 타자 11명 존재).
 * full=1/fallback 응답이 이 선수를 raw 숫자ID 그대로 내보내면 rewrite 계약 위반이다. */
function findStaticForeign(): { name: string; raw: string; canonical: string } {
  for (const p of batterStats2026 as Array<{ name: string; kboId?: string }>) {
    const raw = String(p.kboId || "").trim();
    const canonical = canonicalKboId(raw);
    if (raw && canonical && canonical !== raw) return { name: p.name, raw, canonical };
  }
  throw new Error("static 에 raw≠canonical 외국인이 없다 — rewrite 시나리오 전제 소멸(게이트 재설계 필요)");
}

const PAGER_PREFIX = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ucPager$";

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
const HOMONYM = findSameTeamHomonym();
const [ID_A, ID_B] = HOMONYM.ids;

// ─────────────────────────────────────────────────────────────────────────────
// fixture builders — KBO 기록실 실제 형상(선수명 셀 playerId 앵커)
// ─────────────────────────────────────────────────────────────────────────────
interface FixRow { id: string | null; name: string; team: string; cells: string[] }

function nameCell(r: FixRow): string {
  return r.id
    ? `<a href="/Record/Player/HitterDetail/Basic.aspx?playerId=${r.id}">${r.name}</a>`
    : r.name;
}
/** rank·name·team + 지정 셀 수를 채운 표 HTML. */
function tableHtml(rows: FixRow[], totalCells: number): string {
  return `<tbody>${rows.map((r, i) => {
    const rest = [...r.cells];
    while (rest.length < totalCells - 3) rest.push("1");
    return `<tr><td>${i + 1}</td><td>${nameCell(r)}</td><td>${r.team}</td>` +
      rest.map((c) => `<td>${c}</td>`).join("") + "</tr>";
  }).join("")}</tbody>`;
}
function runnerPageHtml(rows: FixRow[], page: number, lastPage: number): string {
  const trs = rows.map((r, i) =>
    `<tr><td>${(page - 1) * 30 + i + 1}</td><td>${nameCell(r)}</td><td>${r.team}</td>` +
    `<td>1</td><td>1</td><td>${r.cells[0] ?? "0"}</td><td>${r.cells[1] ?? "0"}</td><td>0</td><td>0</td><td>0</td></tr>`,
  ).join("");
  const links = [`<a id="ucPager_btnNo${page}" class="on" href="#">${page}</a>`];
  if (page < lastPage) {
    links.push(`<a href="javascript:__doPostBack(&#39;${PAGER_PREFIX}btnNext&#39;,&#39;&#39;)">next</a>`);
  }
  return `<form><input type="hidden" name="__VIEWSTATE" value="vs-${page}" />` +
    `<input type="hidden" name="__EVENTVALIDATION" value="ev-${page}" />` +
    `<tbody>${trs}</tbody>${links.join("")}</form>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// route 종단 시나리오 (child process 에서 실행 — 모듈 캐시 격리)
// ─────────────────────────────────────────────────────────────────────────────
const SCENARIOS = [
  "batter-live",
  "batter-full-live",
  "batter-basic1-noid",
  "batter-basic1-dup",
  "batter-id-conflict",
  "batter-runner-noid",
  "batter-basic2-partial",
  "batter-basic2-dup",
  "batter-b1b2-conflict",
  "pitcher-live",
  "pitcher-noid",
  "pitcher-dup",
] as const;
type Scenario = (typeof SCENARIOS)[number];

async function runScenario(scenario: Scenario): Promise<void> {
  // ── 타자 fixture 로스터: 팀별 3명(전 10팀) + 동명이인 반대쌍(같은 이름·팀, 다른 id) ──
  const teams = ["한화", "KIA", "KT", "LG", "롯데", "NC", "두산", "SSG", "삼성", "키움"];
  const base: FixRow[] = [];
  let seq = 0;
  for (const team of teams) {
    for (let i = 0; i < 3; i += 1) {
      seq += 1;
      base.push({ id: String(700000 + seq), name: `타자${seq}`, team, cells: [] });
    }
  }
  // 동명이인 반대쌍 — hits(index 8 → cells[5])·sb 로 서로 다른 값을 심는다.
  const homoA: FixRow = { id: ID_A, name: HOMONYM.name, team: HOMONYM.team, cells: [".333", "10", "40", "35", "7", "21"] };
  const homoB: FixRow = { id: ID_B, name: HOMONYM.name, team: HOMONYM.team, cells: [".111", "10", "40", "35", "7", "4"] };
  // ⚠️ 교체는 같은 팀 슬롯에만 — 다른 팀 슬롯을 교체하면 팀 커버리지(3명)가 깨져 partial 이 된다.
  base[base.findIndex((r) => r.team === HOMONYM.team)] = homoA;
  base.push(homoB);                                     // 31행 — 팀 커버리지 유지
  const fillerQ: FixRow = { id: "799999", name: "규정필러", team: "LG", cells: [] };

  const rateSorts = new Set(["HRA_RT", "OPS_RT", "OBP_RT", "SLG_RT"]);
  const countingRows = [...base];
  // 비율 정렬 페이지에는 idB 대신 fillerQ — idB 는 규정타석 미충족이 된다(qualifiedRate 반대쌍).
  const rateRows = [...base.filter((r) => r.id !== ID_B), fillerQ];

  const unionIds = new Set([...countingRows, ...rateRows].map((r) => r.id as string));
  // Basic2 는 union 전원 커버(부분 coverage 시나리오에서만 한 명 제거).
  const basic2Rows = [...countingRows, fillerQ];

  // Runner 로스터: union + static 전체(응답 요구키) + 필러로 30행 페이지 정렬.
  const staticIds = (batterStats2026 as Array<{ kboId?: string }>)
    .map((p) => String(p.kboId || "").trim()).filter(Boolean);
  const runnerIds = [...new Set([...unionIds, ...staticIds])];
  const runnerRows: FixRow[] = runnerIds.map((id) => {
    if (id === ID_A) return { ...homoA, cells: ["9", "2"] };
    if (id === ID_B) return { ...homoB, cells: ["0", "0"] };
    return { id, name: `주자${id}`, team: "두산", cells: ["1", "0"] };
  });
  while (runnerRows.length % 30 !== 0 || runnerRows.length < 270) {
    seq += 1;
    runnerRows.push({ id: String(800000 + seq), name: `필러${seq}`, team: "두산", cells: ["0", "0"] });
  }
  const runnerPages: string[] = [];
  const lastPage = runnerRows.length / 30;
  for (let p = 1; p <= lastPage; p += 1) {
    runnerPages.push(runnerPageHtml(runnerRows.slice((p - 1) * 30, p * 30), p, lastPage));
  }

  // ── 투수 fixture: 팀별 6명 + 동명이인 반대쌍 ──
  const pitchers: FixRow[] = [];
  seq = 0;
  for (const team of teams) {
    for (let i = 0; i < 6; i += 1) {
      seq += 1;
      pitchers.push({ id: String(750000 + seq), name: `투수${seq}`, team, cells: ["3.50"] });
    }
  }
  const pHomoA: FixRow = { id: ID_A, name: HOMONYM.name, team: HOMONYM.team, cells: ["2.10"] };
  const pHomoB: FixRow = { id: ID_B, name: HOMONYM.name, team: HOMONYM.team, cells: ["5.90"] };
  // ⚠️ 같은 팀 슬롯 교체 — 팀 커버리지(6명) 유지.
  pitchers[pitchers.findIndex((r) => r.team === HOMONYM.team)] = pHomoA;
  pitchers.push(pHomoB);
  const pitcherHalf1 = pitchers.slice(0, 31);
  const pitcherHalf2 = pitchers.slice(31);
  while (pitcherHalf2.length < 30) {
    seq += 1;
    pitcherHalf2.push({ id: String(760000 + seq), name: `보강투수${seq}`, team: "두산", cells: ["4.44"] });
  }
  // ERA_RT(규정이닝) 페이지: pHomoA 포함, pHomoB 제외 → qualifiedRate 반대쌍.
  const pitcherQualified = [...pitchers.slice(0, 19), pHomoA];

  // ── 시나리오별 결손 주입 ──
  const noid = (rows: FixRow[], victim: string): FixRow[] =>
    rows.map((r) => (r.id === victim ? { ...r, id: null } : r));
  let b1Counting = countingRows;
  let runnerPagesServed = runnerPages;
  let b2Served = basic2Rows;
  let pitcherServed2 = pitcherHalf2;
  let rateServed = rateRows;
  if (scenario === "batter-basic1-noid") b1Counting = noid(countingRows, ID_B);
  // 같은 테이블 안 같은 ID 재등장 = 소스 오염 → 전체 fallback 이어야 한다(삼순 2차 P0).
  if (scenario === "batter-basic1-dup") b1Counting = [...countingRows, { ...homoA }];
  // 테이블 간 같은 ID 가 다른 이름으로 등장 = 식별 충돌 → 전체 fallback.
  if (scenario === "batter-id-conflict") {
    rateServed = rateRows.map((r) => (r.id === ID_A ? { ...r, name: "오염된이름" } : r));
  }
  if (scenario === "batter-runner-noid") {
    const mutated = runnerRows.map((r) => (r.id === ID_B ? { ...r, id: null } : r));
    runnerPagesServed = [];
    for (let p = 1; p <= lastPage; p += 1) {
      runnerPagesServed.push(runnerPageHtml(mutated.slice((p - 1) * 30, p * 30), p, lastPage));
    }
  }
  if (scenario === "batter-basic2-partial") b2Served = basic2Rows.filter((r) => r.id !== ID_B);
  // Basic2 같은 테이블 내 같은 ID 재등장 → 전체 fallback (삼순 3차 P0-2 보강축).
  if (scenario === "batter-basic2-dup") b2Served = [...basic2Rows, { ...basic2Rows[0] }];
  // 같은 kboId 가 Basic1과 Basic2 에서 다른 name → 교차 식별 충돌로 전체 fallback (삼순 3차 P0-2).
  if (scenario === "batter-b1b2-conflict") {
    b2Served = basic2Rows.map((r) => (r.id === ID_A ? { ...r, name: "오염된이름" } : r));
  }
  // ⚠️ 동명이인 행은 half2 에 있다 — 주입은 실제로 서빙되는 페이지에 걸어야 한다.
  if (scenario === "pitcher-noid") pitcherServed2 = noid(pitcherHalf2, ID_B);
  if (scenario === "pitcher-dup") pitcherServed2 = [...pitcherHalf2, { ...pHomoB }];

  // ── global.fetch 모킹 — KBO/Naver 전 엔드포인트 ──
  let runnerPageIdx = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("HitterBasic/Basic1.aspx")) {
      const sort = new URL(url).searchParams.get("sort") ?? "";
      return new Response(tableHtml(rateSorts.has(sort) ? rateServed : b1Counting, 16), { status: 200 });
    }
    if (url.includes("HitterBasic/Basic2.aspx")) {
      return new Response(tableHtml(b2Served, 12), { status: 200 });
    }
    if (url.includes("Runner/Basic.aspx")) {
      if ((init?.method ?? "GET") === "POST") runnerPageIdx += 1;
      else runnerPageIdx = 0;
      return new Response(runnerPagesServed[runnerPageIdx], {
        status: 200,
        headers: runnerPageIdx === 0 ? { "set-cookie": "ASP.NET_SessionId=fixture; path=/" } : {},
      });
    }
    if (url.includes("PitcherBasic/Basic1.aspx")) {
      const sort = new URL(url).searchParams.get("sort") ?? "";
      const rows = sort === "ERA_RT" ? pitcherQualified
        : ["SV_CN", "W_CN"].includes(sort) ? pitcherHalf1
        : pitcherServed2;
      return new Response(tableHtml(rows, 19), { status: 200 });
    }
    // Naver fallback 은 실패시켜 route 의 최종 static fallback(source="fallback")을 판정한다.
    return new Response("blocked", { status: 404 });
  }) as typeof fetch;

  const { GET } = await import("../../src/app/api/stats/route");
  const { NextRequest } = await import("next/server");
  const type = scenario.startsWith("pitcher") ? "pitcher" : "batter";
  const full = scenario === "batter-full-live" ? "&full=1" : "";
  const res = await GET(new NextRequest(`http://localhost/api/stats?type=${type}${full}`));
  const json = await res.json() as {
    source?: string; runnerSource?: string;
    stats: Array<Record<string, string | number>>;
  };

  if (scenario === "batter-full-live") {
    // full=1 종단 — static 보강이 섞인 최종 응답에서도 identity 가 유지되는가(삼순 2차 P0-3).
    assert.equal(json.source, "live", `source=${json.source}`);
    const a = json.stats.find((r) => r.kboId === ID_A);
    const b = json.stats.find((r) => r.kboId === ID_B);
    assert.ok(a && b, "full=1 응답에 동명이인 반대쌍이 각자 kboId 로 존재해야 한다");
    assert.equal(Number(a!.sb), 9);
    assert.equal(Number(b!.sb), 0, "full=1 경로에서 동명이인 Runner 오염");
    // static 보강이 실제로 병합됐는가(라이브 31명 + 비규정 static 보강).
    assert.ok(json.stats.length > 31, `full=1 행수=${json.stats.length} — static 보강이 없다`);
    // 최종 응답 전 행 identity 유일·비어있지 않음 — assertFullEntryIdentity 가 지키는 계약 그대로.
    const ids = json.stats.map((r) => String(r.kboId || "").trim());
    assert.ok(ids.every(Boolean), "full=1 응답에 빈 kboId 행이 남았다");
    assert.equal(new Set(ids).size, ids.length, "full=1 응답에 중복 kboId 가 남았다");
    // ⚠️ static-only 외국인 rewrite (삼순 4차): raw 숫자ID 가 아니라 canonical 로 나가야 한다.
    const foreign = findStaticForeign();
    assert.ok(
      json.stats.some((r) => r.kboId === foreign.canonical),
      `외국인 ${foreign.name} 이 canonical(${foreign.canonical})로 없다`,
    );
    assert.ok(
      !json.stats.some((r) => r.kboId === foreign.raw),
      `외국인 ${foreign.name} 이 raw 숫자ID(${foreign.raw})로 남았다 — rewrite 누락`,
    );
  } else if (scenario === "batter-live") {
    assert.equal(json.source, "live", `source=${json.source} — live 여야 한다`);
    assert.equal(json.runnerSource, "live", `runnerSource=${json.runnerSource}`);
    const a = json.stats.find((r) => r.kboId === ID_A);
    const b = json.stats.find((r) => r.kboId === ID_B);
    assert.ok(a && b, "동명이인 반대쌍이 응답에 각자 kboId 로 존재해야 한다");
    assert.equal(a!.name, HOMONYM.name);
    assert.equal(b!.name, HOMONYM.name);
    // Runner 반대쌍 — 이름::팀 병합이면 두 행이 같은 sb 가 된다.
    assert.equal(Number(a!.sb), 9, `idA sb=${a!.sb}`);
    assert.equal(Number(b!.sb), 0, `idB sb=${b!.sb} — 동명이인 오염`);
    // Basic 반대쌍 — 원본 행 자체가 안 섞였는가.
    assert.equal(Number(a!.hits), 21, `idA hits=${a!.hits}`);
    assert.equal(Number(b!.hits), 4, `idB hits=${b!.hits}`);
    // qualifiedRate 반대쌍 — 키가 identity 로 유지되는가.
    assert.equal(a!.qualifiedRate, 1, "idA 는 비율 정렬 페이지에 있어 규정타석");
    assert.equal(b!.qualifiedRate, 0, "idB 는 비율 정렬 페이지에 없어 미충족");
    assert.ok(json.stats.every((r) => String(r.kboId || "").trim()), "빈 kboId 행이 응답에 남았다");
  } else if (scenario === "pitcher-live") {
    assert.equal(json.source, "live", `source=${json.source}`);
    const a = json.stats.find((r) => r.kboId === ID_A);
    const b = json.stats.find((r) => r.kboId === ID_B);
    assert.ok(a && b, "투수 동명이인 반대쌍이 각자 kboId 로 존재해야 한다");
    assert.equal(a!.qualifiedRate, 1, "idA 규정이닝(ERA_RT 페이지 포함)");
    assert.equal(b!.qualifiedRate, 0, "idB 규정이닝 미충족");
    assert.equal(String(a!.era), "2.10");
    assert.equal(String(b!.era), "5.90", "동명이인 투수 행이 병합돼 사라졌다");
  } else {
    // 결손/부분 coverage — live 혼합 없이 전체 static fallback 으로 닫혀야 한다.
    assert.equal(json.source, "fallback", `${scenario}: source=${json.source} — 전체 fallback 이 아니라 live 혼합이 남았다`);
    assert.equal(res.headers.get("cache-control"), "no-store", "degraded 응답이 엣지에 캐시된다");
    if (type === "batter") {
      // ⚠️ fallback 응답도 rewrite 계약(삼순 4차) — static-only 외국인이 canonical 로 나가야 한다.
      const foreign = findStaticForeign();
      assert.ok(
        json.stats.some((r) => r.kboId === foreign.canonical),
        `fallback 응답에 외국인 ${foreign.name} canonical(${foreign.canonical})이 없다`,
      );
      assert.ok(
        !json.stats.some((r) => r.kboId === foreign.raw),
        `fallback 응답에 외국인 raw 숫자ID(${foreign.raw})가 남았다 — rewrite 누락`,
      );
    }
  }
  console.log(`  ✅ [route] ${scenario}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 순수 함수 검사 (orchestrator 프로세스)
// ─────────────────────────────────────────────────────────────────────────────
async function runPureChecks(): Promise<{ pass: number; failures: string[] }> {
  const {
    parseTable, rowKboId, mergeBasicRows, buildRunnerMap,
    buildBatterStat, applyRunnerStats, assertStatsComplete,
  } = await import("../../src/app/api/stats/route");

  let pass = 0;
  const failures: string[] = [];
  const check = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
      pass += 1;
      console.log(`  ✅ ${name}`);
    } catch (error) {
      failures.push(`${name}: ${(error as Error).message}`);
      console.error(`  ❌ ${name}: ${(error as Error).message}`);
    }
  };

  const pair: FixRow[] = [
    { id: ID_A, name: HOMONYM.name, team: HOMONYM.team, cells: [".333"] },
    { id: ID_B, name: HOMONYM.name, team: HOMONYM.team, cells: [".111"] },
  ];

  await check("parseTable 이 각 행에 playerId 를 결속한다 (동명이인 2행이 다른 id)", () => {
    const parsed = parseTable(tableHtml(pair, 16));
    assert.equal(rowKboId(parsed[0]), ID_A);
    assert.equal(rowKboId(parsed[1]), ID_B);
    assert.equal(parsed[0][1], HOMONYM.name);
    assert.equal(parsed[0][3], ".333");
  });
  await check("production KBO 응답 형태(개행·data-id 속성)에서도 결속된다", () => {
    const real = '<tbody><tr>\n<td>1</td>\n' +
      '<td><a href="/Record/Player/HitterDetail/Basic.aspx?playerId=50500">황성빈</a></td>\n' +
      '<td>롯데</td><td data-id="GAME_CN">80</td><td data-id="SBA_CN">41</td>' +
      '<td data-id="SB_CN">35</td><td data-id="CS_CN">6</td>' +
      '<td>85.4</td><td>4</td><td>4</td>\n</tr></tbody>';
    assert.equal(rowKboId(parseTable(real)[0]), "50500");
  });
  await check("mergeBasicRows: 동명이인 2행 보존 + 테이블 간 같은 id 정상 dedupe", () => {
    const t = parseTable(tableHtml(pair, 16));
    const merged = mergeBasicRows([t, t]);
    assert.equal(merged.length, 2, `union=${merged.length}`);
    assert.notEqual(rowKboId(merged[0]), rowKboId(merged[1]));
  });
  await check("mergeBasicRows: ID 결손 행은 이름::팀 흡수가 아니라 throw", () => {
    const t = parseTable(tableHtml([{ id: null, name: "무명", team: "두산", cells: [] }], 16));
    assert.throws(() => mergeBasicRows([t]), /identity missing/);
  });
  await check("mergeBasicRows: 같은 테이블 내 중복 ID throw · 테이블 간 name 충돌 throw", () => {
    const dupTable = parseTable(tableHtml([pair[0], pair[0]], 16));
    assert.throws(() => mergeBasicRows([dupTable]), /duplicated in table/);
    const t1 = parseTable(tableHtml([pair[0]], 16));
    const conflict = parseTable(tableHtml([{ ...pair[0], name: "오염된이름" }], 16));
    assert.throws(() => mergeBasicRows([t1, conflict]), /identity conflict/);
  });
  await check("buildRunnerMap: kboId exact 키 · 결손 throw · 중복 throw", () => {
    const ok = parseTable(runnerPageHtml([
      { id: ID_A, name: HOMONYM.name, team: HOMONYM.team, cells: ["9", "2"] },
      { id: ID_B, name: HOMONYM.name, team: HOMONYM.team, cells: ["0", "0"] },
    ], 1, 1));
    const map = buildRunnerMap(ok);
    assert.deepEqual([...map.keys()].sort(), [ID_A, ID_B].sort());
    assert.equal(map.get(ID_A)?.sb, 9);
    assert.equal(map.get(ID_B)?.sb, 0);
    const missing = parseTable(runnerPageHtml([{ id: null, name: "무명", team: "두산", cells: ["4", "1"] }], 1, 1));
    assert.throws(() => buildRunnerMap(missing), /identity missing/);
    const dup = parseTable(runnerPageHtml([
      { id: ID_A, name: HOMONYM.name, team: HOMONYM.team, cells: ["9", "2"] },
      { id: ID_A, name: HOMONYM.name, team: HOMONYM.team, cells: ["1", "1"] },
    ], 1, 1));
    assert.throws(() => buildRunnerMap(dup), /duplicated/);
  });
  await check("buildBatterStat: 출력 kboId=공식 id · qualifiedRate 동일 키 · 결손 throw", () => {
    const parsed = parseTable(tableHtml(pair, 16));
    const qualified = new Set<string>([ID_A]);
    const a = buildBatterStat(parsed[0], 0, new Map(), qualified);
    const b = buildBatterStat(parsed[1], 1, new Map(), qualified);
    assert.equal(a.kboId, ID_A);
    assert.equal(b.kboId, ID_B);
    assert.equal(a.qualifiedRate, 1);
    assert.equal(b.qualifiedRate, 0);
    const noidRow = parseTable(tableHtml([{ id: null, name: "무명", team: "두산", cells: [] }], 16))[0];
    assert.throws(() => buildBatterStat(noidRow, 0, new Map(), new Set()), /identity missing/);
  });
  await check("applyRunnerStats: kboId exact — 동명이인이 서로 값을 덮어쓰지 않는다", () => {
    const map = new Map([[ID_A, { sb: 9, cs: 2 }], [ID_B, { sb: 0, cs: 0 }]]);
    const merged = applyRunnerStats([
      { rank: 1, name: HOMONYM.name, team: HOMONYM.team, kboId: ID_A, sb: 0, cs: 0 },
      { rank: 2, name: HOMONYM.name, team: HOMONYM.team, kboId: ID_B, sb: 0, cs: 0 },
    ], map);
    assert.equal(Number(merged[0].sb), 9);
    assert.equal(Number(merged[1].sb), 0, "동명이인 오염");
    const nameKeyed = new Map([["무명::두산", { sb: 4, cs: 1 }]]);
    const kept = applyRunnerStats([{ rank: 1, name: "무명", team: "두산", kboId: "", sb: 0, cs: 0 }], nameKeyed);
    assert.equal(Number(kept[0].sb), 0, "이름::팀 fallback 이 살아있다");
  });
  await check("mergeFullEntry: ID-only 계약 — 결손/중복/충돌 throw · 동명이인 보존", async () => {
    const { mergeFullEntry } = await import("../../src/lib/stats/full-entry");
    const live = [
      { name: HOMONYM.name, team: HOMONYM.team, kboId: ID_A, qualifiedRate: 1 },
    ];
    const merged = mergeFullEntry(live, [
      { name: HOMONYM.name, team: HOMONYM.team, kboId: ID_B },
    ]);
    assert.equal(merged.length, 2, "동명이인 static 보강이 사라졌다");
    assert.throws(() => mergeFullEntry(live, [{ name: "무명", team: "KT", kboId: "" }]), /identity missing/);
    assert.throws(
      () => mergeFullEntry(live, [
        { name: "중복", team: "KT", kboId: "99001" },
        { name: "중복", team: "KT", kboId: "99001" },
      ]),
      /duplicated/,
    );
    assert.throws(
      () => mergeFullEntry(live, [{ name: "오염된이름", team: HOMONYM.team, kboId: ID_A }]),
      /identity conflict/,
    );
  });
  await check("canonicalizeStatsIdentity: 외국인 raw→canonical rewrite · 결손 throw", async () => {
    const { canonicalizeStatsIdentity } = await import("../../src/app/api/stats/route");
    const foreign = findStaticForeign();
    const out = canonicalizeStatsIdentity([
      { rank: 1, name: foreign.name, team: "두산", kboId: foreign.raw, playerId: foreign.raw },
    ] as never);
    assert.equal(out[0].kboId, foreign.canonical);
    assert.equal(out[0].playerId, foreign.canonical);
    assert.throws(
      () => canonicalizeStatsIdentity([{ rank: 1, name: "무명", team: "두산", kboId: "" }] as never),
      /identity missing/,
    );
  });
  await check("handleStatsGetFailure: 오염 fallback 은 200 이 아니라 500/no-store · 정상은 rewrite 후 200", async () => {
    const { handleStatsGetFailure } = await import("../../src/app/api/stats/route");
    // 정상 static 은 200 fallback (identity 검증 통과) + 외국인 canonical rewrite.
    const okRes = handleStatsGetFailure(new Error("crawl failed"), "current", "batter");
    assert.equal(okRes.status, 200);
    const okJson = await okRes.json();
    assert.equal(okJson.source, "fallback");
    const foreign = findStaticForeign();
    assert.ok(
      (okJson.stats as Array<{ kboId?: string }>).some((r) => r.kboId === foreign.canonical) &&
      !(okJson.stats as Array<{ kboId?: string }>).some((r) => r.kboId === foreign.raw),
      "fallback 응답이 외국인 raw 숫자ID 를 그대로 내보낸다",
    );
    // 빈 ID 오염 주입 → 500 + no-store (삼순 3차 P0-1: 오염 static 을 200 으로 되돌리면 fail-close 무효).
    const corrupt = [
      { rank: 1, name: HOMONYM.name, team: HOMONYM.team, kboId: ID_A },
      { rank: 2, name: "무명", team: "두산", kboId: "" },
    ];
    const bad = handleStatsGetFailure(new Error("crawl failed"), "current", "batter", new Date(), corrupt as never);
    assert.equal(bad.status, 500, `status=${bad.status}`);
    assert.equal(bad.headers.get("cache-control"), "no-store");
    // 중복 ID 오염도 동일.
    const dup = [
      { rank: 1, name: HOMONYM.name, team: HOMONYM.team, kboId: ID_A },
      { rank: 2, name: HOMONYM.name, team: HOMONYM.team, kboId: ID_A },
    ];
    const badDup = handleStatsGetFailure(new Error("crawl failed"), "current", "batter", new Date(), dup as never);
    assert.equal(badDup.status, 500);
  });
  await check("assertFullEntryIdentity: 동명이인 정상쌍 통과 · 빈 id throw · 중복 id throw", async () => {
    const { assertFullEntryIdentity } = await import("../../src/app/api/stats/route");
    const ok = [
      { rank: 1, name: HOMONYM.name, team: HOMONYM.team, kboId: ID_A },
      { rank: 2, name: HOMONYM.name, team: HOMONYM.team, kboId: ID_B },
    ];
    assert.doesNotThrow(() => assertFullEntryIdentity(ok as never));
    assert.throws(
      () => assertFullEntryIdentity([...ok, { rank: 3, name: "무명", team: "두산", kboId: "" }] as never),
      /identity missing/,
    );
    assert.throws(
      () => assertFullEntryIdentity([...ok, { rank: 3, name: "중복", team: "두산", kboId: ID_A }] as never),
      /identity duplicated/,
    );
  });
  await check("assertStatsComplete: 같은 팀 동명이인 정상 · 빈 id throw · 중복 id throw", () => {
    const teams10 = ["한화", "KIA", "KT", "LG", "롯데", "NC", "두산", "SSG", "삼성", "키움"];
    const rows = teams10.flatMap((team, t) =>
      [0, 1, 2].map((i) => ({ rank: 0, name: `선수${t}-${i}`, team, kboId: String(710000 + t * 3 + i) })),
    );
    rows[rows.findIndex((r) => r.team === HOMONYM.team)] = { rank: 0, name: HOMONYM.name, team: HOMONYM.team, kboId: ID_A };
    rows.push({ rank: 0, name: HOMONYM.name, team: HOMONYM.team, kboId: ID_B });
    assert.doesNotThrow(() => assertStatsComplete(rows as never, "batter"));
    const blank = rows.map((r, i) => (i === 0 ? { ...r, kboId: "" } : r));
    assert.throws(() => assertStatsComplete(blank as never, "batter"), /identity missing/);
    const dup = rows.map((r, i) => (i === 0 ? { ...r, kboId: ID_A } : r));
    assert.throws(() => assertStatsComplete(dup as never, "batter"), /partial/);
  });
  return { pass, failures };
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const scenario = process.env.KBOID_SCENARIO as Scenario | undefined;
  if (scenario) {
    await runScenario(scenario);
    return;
  }
  console.log(`  · 대상 동명이인: ${HOMONYM.name}/${HOMONYM.team} → ${HOMONYM.ids.join(", ")}`);
  const { pass, failures } = await runPureChecks();
  let routePass = 0;
  for (const s of SCENARIOS) {
    try {
      execFileSync("node_modules/.bin/tsx", [process.argv[1]], {
        env: { ...process.env, KBOID_SCENARIO: s },
        stdio: ["ignore", "inherit", "pipe"],
      });
      routePass += 1;
    } catch (error) {
      const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
      failures.push(`[route] ${s}: ${stderr.split("\n").slice(-12).join("\n")}`);
      console.error(`  ❌ [route] ${s}`);
    }
  }
  const total = pass + routePass;
  console.log(failures.length === 0
    ? `\n✅ stats kboId identity: ${total} PASS (pure ${pass} + route ${routePass})`
    : `\n❌ stats kboId identity: ${total} PASS / ${failures.length} FAIL\n${failures.join("\n")}`);
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error("stats-kboid-identity-smoke crashed:", error);
  process.exit(1);
});
