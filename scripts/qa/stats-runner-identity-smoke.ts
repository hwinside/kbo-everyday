/**
 * `/api/stats` 의 도루(Runner) 병합이 **kboId identity** 로 묶이는가.
 *
 * ⚠️ 이 게이트가 생긴 이유 (삼순 #1100 4차 P0-3).
 *
 * Runner 병합 키가 `이름::팀` 이라 **같은 팀 동명이인**이 서로의 도루 값을 덮어썼다.
 * 로스터 실측으로 7그룹 존재하고(이주형/키움, 이승현/삼성, 김현수/KIA …),
 * production `/api/stats` 응답에서도 이주형 2행이 같은 키로 묶이는 것을 확인했다.
 *
 * 하류에서 kboId 로 걸러도 **이미 오염된 값**이라 복구되지 않는다. 야잘알봇이
 * 그 값을 그대로 답하면 앱과도, 사실과도 다른 숫자를 말하게 된다.
 *
 * 검증 대상은 전부 **실제 배포 함수**다:
 *  · `parseRunnerPlayerIds` — KBO Runner HTML 에서 playerId 추출
 *  · `fetchAllRunnerRows`   — 수집 행에 playerId 결속
 *  · `applyRunnerStats`     — kboId 우선 병합
 *
 * 실행: npm run qa:stats-runner-identity
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import playersRoster from "../../src/lib/constants/players-roster.json";
import {
  parseTableWithIds,
  rowPlayerId,
  statsRowKey,
  mergeBasicRows,
  buildBatterStat,
  applyRunnerStats,
  fetchAllRunnerRows,
  parseRunnerPlayerIds,
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

async function main() {
  const homonym = findSameTeamHomonym();
  console.log(`  · 대상 동명이인: ${homonym.name}/${homonym.team} → ${homonym.ids.join(", ")}`);

  const [idA, idB] = homonym.ids;
  const runnerRows = [
    { playerId: idA, name: homonym.name, team: homonym.team, sb: 9, cs: 2 },
    { playerId: idB, name: homonym.name, team: homonym.team, sb: 0, cs: 0 },
  ];

  // ── ① playerId 추출 ─────────────────────────────────────────────────────
  await check("Runner HTML 에서 playerId 를 행 순서대로 뽑는다", () => {
    const ids = parseRunnerPlayerIds(runnerPageHtml(runnerRows));
    assert.deepEqual(ids, [idA, idB], `추출 결과 ${JSON.stringify(ids)}`);
  });
  await check("playerId 앵커가 없는 행은 null (하위호환 경로로 넘어간다)", () => {
    const ids = parseRunnerPlayerIds(runnerPageHtml([
      { playerId: null, name: "무명", team: "두산", sb: 3, cs: 1 },
    ]));
    assert.deepEqual(ids, [null]);
  });
  await check("production KBO 응답 형태에서도 뽑힌다", () => {
    const real = '<tbody><tr>\n<td>1</td>\n' +
      '<td><a href="/Record/Player/HitterDetail/Basic.aspx?playerId=50500">황성빈</a></td>\n' +
      '<td>롯데</td><td data-id="GAME_CN">80</td><td data-id="SBA_CN">41</td>' +
      '<td data-id="SB_CN">35</td><td data-id="CS_CN">6</td>' +
      '<td>85.4</td><td>4</td><td>4</td>\n</tr></tbody>';
    assert.deepEqual(parseRunnerPlayerIds(real), ["50500"]);
  });

  // ── ② 수집 행에 playerId 가 결속된다 ────────────────────────────────────
  // ⚠️ production 은 전 페이지 수집 완결(최소 9페이지·250행)을 요구한다. 축소 fixture 를 쓰면
  // "불완전 수집" 으로 거절돼 이 검사가 병합 계약이 아니라 상한 검사가 돼버린다.
  // 그래서 실제 형상대로 11페이지·329행을 만들고, **동명이인 2행을 그 안에 심는다**.
  await check("fetchAllRunnerRows 가 각 행 끝에 playerId 를 붙인다", async () => {
    const pages: string[] = [];
    let seq = 0;
    for (let page = 1; page <= 11; page += 1) {
      const count = page === 11 ? 29 : 30;
      const pageRows = Array.from({ length: count }, () => {
        seq += 1;
        if (seq === 1) return runnerRows[0];
        if (seq === 2) return runnerRows[1];
        return {
          playerId: String(900000 + seq),
          name: `선수${seq}`,
          team: "두산",
          sb: 0,
          cs: 0,
        };
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
    assert.equal(rows[0][10], idA, `1행 playerId=${rows[0][10]}`);
    assert.equal(rows[1][10], idB, `2행 playerId=${rows[1][10]}`);
    // 기존 인덱스 계약(이름 1 · 팀 2 · SB 5 · CS 6)은 그대로여야 한다.
    assert.equal(rows[0][1], homonym.name);
    assert.equal(rows[0][5], "9");
    // 마지막 페이지 행에도 결속돼야 한다(첫 페이지만 붙는 변종 차단).
    assert.ok(rows[328][10], "마지막 행에 playerId 가 없다");
  });

  // ── ③ 병합이 identity 로 갈린다 (P0-3 핵심) ─────────────────────────────
  const runnerMap = new Map<string, { sb: number; cs: number }>([
    [idA, { sb: 9, cs: 2 }],
    [idB, { sb: 0, cs: 0 }],
  ]);
  await check("같은 팀 동명이인이 서로의 도루를 덮어쓰지 않는다", () => {
    const merged = applyRunnerStats([
      { rank: 1, name: homonym.name, team: homonym.team, kboId: idA, sb: 0, cs: 0 },
      { rank: 2, name: homonym.name, team: homonym.team, kboId: idB, sb: 0, cs: 0 },
    ], runnerMap);
    assert.equal(
      Number(merged[0].sb), 9,
      `${idA} 도루가 ${merged[0].sb} — identity 병합이 아니다`,
    );
    assert.equal(
      Number(merged[1].sb), 0,
      `${idB} 가 ${merged[1].sb} 로 오염됐다 — 동명이인이 서로 덮어썼다`,
    );
    assert.notEqual(
      Number(merged[0].sb), Number(merged[1].sb),
      "동명이인 두 행이 같은 도루 값 — 이름::팀 키로 병합되고 있다",
    );
  });

  await check("kboId 없는 행은 이름::팀 값이 있어도 병합하지 않는다", () => {
    const unsafeMap = new Map<string, { sb: number; cs: number }>([
      ["무명::두산", { sb: 4, cs: 1 }],
    ]);
    const merged = applyRunnerStats(
      [{ rank: 1, name: "무명", team: "두산", kboId: "", sb: 0, cs: 0 }],
      unsafeMap,
    );
    assert.equal(Number(merged[0].sb), 0, "name::team fallback이 동명이인 오염을 허용한다");
  });

  await check("map 에 없는 선수는 기존 값을 유지한다(0 으로 밀지 않는다)", () => {
    const merged = applyRunnerStats(
      [{ rank: 1, name: "미수집", team: "LG", kboId: "99999999", sb: 7, cs: 3 }],
      runnerMap,
    );
    assert.equal(Number(merged[0].sb), 7);
    assert.equal(Number(merged[0].cs), 3);
  });

  // ── ④ Basic1/Basic2 source-row identity (삼순 #1100 7차 P0-2) ────────────
  //
  // ⚠️ Runner 병합만 kboId 로 고쳐도, 그 앞단인 Basic1 union · Basic2 lookup 이
  // `이름::팀` first-match 면 **원본 행 자체가** 동명이인끼리 서로를 가린다.
  // 그 경우 하류에서 뭐를 해도 이미 다른 선수 값이라 복구 불가능하다.
  const basicHtml = (rows: Array<{ playerId: string | null; name: string; team: string; avg: string }>) =>
    `<tbody>${rows.map((r, i) => {
      const nameCell = r.playerId
        ? `<a href="/Record/Player/HitterDetail/Basic.aspx?playerId=${r.playerId}">${r.name}</a>`
        : r.name;
      return `<tr><td>${i + 1}</td><td>${nameCell}</td><td>${r.team}</td><td>${r.avg}</td>` +
        "<td>1</td>".repeat(12) + "</tr>";
    }).join("")}</tbody>`;

  await check("parseTableWithIds 가 행 끝에 playerId 를 붙인다", () => {
    const parsed = parseTableWithIds(basicHtml([
      { playerId: idA, name: homonym.name, team: homonym.team, avg: ".333" },
      { playerId: idB, name: homonym.name, team: homonym.team, avg: ".111" },
    ]));
    assert.equal(parsed.length, 2);
    assert.equal(rowPlayerId(parsed[0]), idA, `1행 id=${rowPlayerId(parsed[0])}`);
    assert.equal(rowPlayerId(parsed[1]), idB, `2행 id=${rowPlayerId(parsed[1])}`);
    // 기존 셀 인덱스(이름 1 · 팀 2 · 타율 3)는 그대로여야 한다.
    assert.equal(parsed[0][1], homonym.name);
    assert.equal(parsed[0][3], ".333");
  });

  // ⚠️ **production 함수를 그대로 호출한다.** 게이트가 같은 키 규칙을 재구현하면
  // production 을 `이름::팀` 으로 되돌려도 GREEN 이다 — 실제로 내가 그렇게 만들어
  // mutation 2종(union 키 복원 · parseTableWithIds → parseTable)을 모두 놓쳤다.
  await check("같은 팀 동명이인의 Basic1 원본 행이 first-match 로 삼켜지지 않는다", () => {
    const parsed = parseTableWithIds(basicHtml([
      { playerId: idA, name: homonym.name, team: homonym.team, avg: ".333" },
      { playerId: idB, name: homonym.name, team: homonym.team, avg: ".111" },
    ]));
    const merged = mergeBasicRows([parsed]);
    assert.equal(
      merged.length, 2,
      `union 결과 ${merged.length}행 — 이름::팀 키라 동명이인이 합쳌졌다`,
    );
    const byId = new Map(merged.map((row) => [statsRowKey(row), row]));
    assert.equal(byId.get(idA)?.[3], ".333", `${idA} 행이 사라졌거나 값이 섞였다`);
    assert.equal(byId.get(idB)?.[3], ".111", `${idB} 행이 사라졌거나 값이 섞였다`);
  });

  // 정렬이 달라도(여러 table union) 동일인이 합쳐지면 안 된다 — production 은 6개 정렬을 합친다.
  await check("여러 정렬 table 을 union 해도 identity 가 유지된다", () => {
    const t1 = parseTableWithIds(basicHtml([
      { playerId: idA, name: homonym.name, team: homonym.team, avg: ".333" },
    ]));
    const t2 = parseTableWithIds(basicHtml([
      { playerId: idB, name: homonym.name, team: homonym.team, avg: ".111" },
      { playerId: idA, name: homonym.name, team: homonym.team, avg: ".333" },
    ]));
    const merged = mergeBasicRows([t1, t2]);
    assert.equal(merged.length, 2, `union ${merged.length}행 — 동명이인이 합쳌졌다`);
  });

  /**
   * production 이 **실제로** id 붙은 파서를 쓰는가 — AST 로 고정한다.
   *
   * ⚠️ 게이트가 `parseTableWithIds` 를 직접 호출해 검증하면, production 이 그걸 안 쓰고
   * 맨 `parseTable` 로 되돌려도 GREEN 이다. 실제로 내 첫 게이트가 그 mutation 을 놓쳤다.
   * 그래서 basic1/basic2 테이블 생성이 `parseTableWithIds` 로 묶였는지를 구문으로 본다.
   */
  await check("production basic1/basic2 파싱이 parseTableWithIds 에 결속돼 있다(AST)", async () => {
    const ts = (await import("typescript")).default;
    const src = readFileSync(
      path.join(path.resolve(import.meta.dirname, "../.."), "src/app/api/stats/route.ts"),
      "utf8",
    );
    const sf = ts.createSourceFile("route.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const bound = new Map<string, string>();
    const walk = (node: import("typescript").Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        (node.name.text === "basic1Tables" || node.name.text === "basic2Tables") &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isPropertyAccessExpression(node.initializer.expression) &&
        node.initializer.expression.name.text === "map"
      ) {
        const arg = node.initializer.arguments[0];
        bound.set(node.name.text, arg && ts.isIdentifier(arg) ? arg.text : "<non-identifier>");
      }
      node.forEachChild(walk);
    };
    sf.forEachChild(walk);
    for (const name of ["basic1Tables", "basic2Tables"]) {
      assert.equal(
        bound.get(name), "parseTableWithIds",
        `${name} 가 ${bound.get(name) ?? "없음"} 로 파싱된다 — playerId 가 붙지 않아 동명이인이 합쳌진다`,
      );
    }
  });

  // ── ⑤ 출력 identity · 규정타석 플래그 (삼순 #1100 8차 P0-2/P0-3) ────────
  //
  // ⚠️ union 키만 identity 로 갈라도 **출력 `kboId`** 가 로스터 이름 first-match 면
  // 동명이인 2행이 같은 ID 로 나가 하류에서 다시 섞인다.
  // 그리고 저장키와 조회키가 갈라지면 `qualifiedRate` 가 전부 0 이 된다.
  // 둘 다 **실제 배포 함수 `buildBatterStat` 을 호출**해 검증한다.
  const roster = playersRoster as Parameters<typeof buildBatterStat>[2];
  const emptyB2 = new Map<string, Parameters<typeof buildBatterStat>[3] extends Map<string, infer V> ? V : never>();
  const basicRow = (playerId: string | null, name: string, team: string) => {
    const cells = ["1", name, team, ".300"];
    while (cells.length < 16) cells.push("1");
    cells.push(playerId ?? "");
    return cells;
  };

  await check("동명이인 2행이 같은 kboId 로 출력되지 않는다", () => {
    const a = buildBatterStat(basicRow(idA, homonym.name, homonym.team), 0, roster, emptyB2, new Set());
    const b = buildBatterStat(basicRow(idB, homonym.name, homonym.team), 1, roster, emptyB2, new Set());
    assert.equal(a.kboId, idA, `1행 kboId=${a.kboId}`);
    assert.equal(b.kboId, idB, `2행 kboId=${b.kboId}`);
    assert.notEqual(
      a.kboId, b.kboId,
      "동명이인 두 행이 같은 kboId — 로스터 이름 first-match 로 합쳌졌다",
    );
    assert.equal(a.playerId, idA);
    assert.equal(b.playerId, idB);
  });

  await check("qualifiedRate 저장키와 조회키가 같다(규정타석이 전부 0 이 되지 않는다)", () => {
    const row = basicRow(idA, homonym.name, homonym.team);
    // production 과 동일하게 `statsRowKey` 로 저장된 키 집합을 준다.
    const qualified = new Set([statsRowKey(row)]);
    const stat = buildBatterStat(row, 0, roster, emptyB2, qualified);
    assert.equal(
      stat.qualifiedRate, 1,
      "규정타석 플래그가 0 — 저장키(playerId)와 조회키가 갈라졌다",
    );
    // 집합에 없는 행은 0 이어야 한다(무조건 1 반환 변종 차단).
    const other = buildBatterStat(basicRow(idB, homonym.name, homonym.team), 1, roster, emptyB2, qualified);
    assert.equal(other.qualifiedRate, 0, "규정타석 미충족인데 1 이 나왔다");
  });

  await check("playerId 없는 Basic 행은 이름::팀 하위호환으로 내려간다", () => {
    const parsed = parseTableWithIds(basicHtml([
      { playerId: null, name: "무명", team: "두산", avg: ".250" },
    ]));
    assert.equal(rowPlayerId(parsed[0]), "", "id 가 없는데 값이 나왔다");
    assert.equal(statsRowKey(parsed[0]), "무명::두산", "하위호환 키가 끊겼다");
  });

  if (failures.length > 0) {
    console.error(`\n❌ stats runner identity: PASS=${pass} FAIL=${failures.length}`);
    for (const f of failures) console.error(`   ${f}`);
    process.exit(1);
  }
  console.log(`\n✅ stats runner identity: ${pass} PASS (동명이인 도루 오염 차단)`);
}

main().catch((error) => {
  console.error("❌ stats runner identity FAIL:", error);
  process.exit(1);
});
