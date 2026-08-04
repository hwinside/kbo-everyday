import { createHash } from "node:crypto";
import { computeDefenseRuns } from "./defense-runs.mjs";
import { collectAllPages, createKboPageAdapter, signatureOf } from "./kbo-pagination.mjs";
import { createSelectAdapter, selectAndConfirm } from "./kbo-select.mjs";

export const SOURCE_DIGEST_MARKER = "KBO_SOURCE_DIGEST";

/** 원본 전체 key/value를 순서 독립적인 SHA-256으로 접는다. */
export function digestSourceMaps(labeledMaps) {
  const hash = createHash("sha256");
  for (const label of Object.keys(labeledMaps).sort()) {
    hash.update(`\n##${label}\n`);
    const map = labeledMaps[label];
    for (const key of [...map.keys()].sort()) {
      hash.update(`${key}\u0001${(map.get(key) ?? []).join("\u0002")}\n`);
    }
  }
  return hash.digest("hex");
}

/**
 * 스탯 원본 정합성 대조 — 크롤 write 경로와 독립 QA 스크립트가 공유하는 SSOT.
 *
 * 배경(2026-08-04): 종전 게이트는 행 개수·누락 델타(≤10)와 identity/shape만 봤다.
 * 그래서 ①곽빈 ERA를 99.99로 오염시켜도 전 게이트가 GREEN이었고,
 * ②타자 병합키가 `${name}|${team}` 이라 같은 팀 동명이인(키움 이주형 50167/51302)이
 * 서로를 덮어써 1명이 통째로 사라져도 아무도 못 잡았다.
 *
 * 여기서는 KBO 공식 기록실을 다시 읽어 우리 데이터셋과 전 행·전 필드를 대조한다.
 * 값 오염 1건 또는 행 누락/잉여 1건이라도 있으면 실패로 본다(fail-close).
 */

/** KBO 기록실 컬럼 인덱스 → 우리 필드명. 페이지 레이아웃이 바뀌면 여기만 고친다. */
export const PITCHER_COLUMNS = [
  [3, "era"], [4, "games"], [5, "wins"], [6, "losses"], [7, "saves"], [8, "holds"],
  [9, "wpct"], [10, "ip"], [11, "h"], [12, "hr"], [13, "bb"], [14, "hbp"],
  [15, "so"], [16, "r"], [17, "er"], [18, "whip"],
];

export const BATTER_BASIC1_COLUMNS = [
  [3, "avg"], [4, "games"], [5, "pa"], [6, "ab"], [7, "runs"], [8, "hits"],
  [9, "doubles"], [10, "triples"], [11, "hr"], [12, "tb"], [13, "rbi"], [14, "sac"], [15, "sf"],
];

export const BATTER_BASIC2_COLUMNS = [
  [4, "bb"], [5, "ibb"], [6, "hbp"], [7, "so"], [8, "gdp"], [9, "slg"], [10, "obp"], [11, "ops"],
];

/**
 * 도루 페이지(Runner) — 순위(0) 선수명(1) 팀명(2) G(3) SBA(4) SB(5) CS(6) SB%(7) OOB(8) PKO(9)
 * 이 페이지를 대조하지 않으면 타자의 `sb`/`cs` 값 오염이 그대로 통과한다(삼순 P0-1).
 */
export const RUNNER_COLUMNS = [[5, "sb"], [6, "cs"]];

/**
 * 수비는 한 선수가 여러 포지션을 보므로 playerId 단독이 아니라 `(playerId, pos)` 복합키다.
 * 순위(0) 선수명(1) 팀명(2) POS(3) G(4) GS(5) IP(6) E(7) PKO(8) PO(9) A(10) DP(11) FPCT(12) PB(13) SB(14) CS(15)
 */
export const DEFENSE_COLUMNS = [
  [4, "games"], [6, "ip"], [7, "e"], [8, "pko"], [9, "po"],
  [10, "a"], [11, "dp"], [12, "fpct"], [13, "pb"], [14, "sb"], [15, "cs"],
];

/**
 * KBO 기록실 한 화면을 전 페이지 순회해 `키 → 셀 배열`로 수집한다.
 *
 * ⚠︎ 순회 로직은 크롤러와 **같은 core**(`collectAllPages` + `createKboPageAdapter`)를 쓴다.
 * 종전에는 여기에 별도 구현이 있었고, 그쪽에는 그룹 전환 유실을 "마지막 그룹"으로 오인해
 * 조용히 EOF 처리하는 경로와 maxPages 소진 시 무예외 반환 경로가 남아 있었다.
 * 그래서 actual crawler 와 independent oracle 이 서로 다른 완주 계약을 가졌다(삼순 지적).
 * 이중 구현 자체를 없애 같은 fail-close 를 공유한다.
 *
 * 수집 불완전(전환 실패·상한 소진·0행)은 데이터 불일치가 아니므로 별도 예외로 구분된다.
 * 검증 불가를 통과로 취급하면 게이트가 아니고, 불완전 수집을 불일치로 보고하면 false RED 다.
 */
export async function collectKboPages(page, url, season, { keyOf } = {}) {
  const makeKey = keyOf ?? ((id) => id);
  await page.goto(url, { waitUntil: "networkidle" });

  const adapter = createKboPageAdapter(page);

  const seasonSelector = "#cphContents_cphContents_cphContents_ddlSeason_ddlSeason";
  if (season && (await page.$(seasonSelector))) {
    // ⚠︎ 종전에는 16회 polling 동안 표가 안 바뀌어도 그냥 루프를 빠져나와
    // **이전 시즌 행**으로 수집을 계속했다(삼순 6차 지적, fake postback 유실로 재현).
    // 이건 몇 행 유실이 아니라 데이터셋 전체가 다른 시즌이 되는 사고다 —
    // oracle 이 2025 를 원본으로 삼으면 전 필드 대조가 통째로 뒤집힌다.
    await selectAndConfirm(
      createSelectAdapter(page, seasonSelector, async () => signatureOf(await adapter.scrapeTable())),
      String(season),
      { label: `${url} 시즌` },
    );
  }

  const rows = await collectAllPages({ ...adapter, log: () => {} });

  const seen = new Map();
  for (const row of rows) {
    const id = (row.hrefs ?? []).map((href) => (href || "").match(/playerId=(\d+)/)?.[1]).find(Boolean);
    if (!id) continue;
    const key = makeKey(id, row.texts);
    if (!seen.has(key)) seen.set(key, row.texts);
  }

  if (seen.size === 0) {
    throw new Error(`source_unreachable: ${url} 에서 0행 수집 — 검증 불가(fail-close)`);
  }
  return seen;
}

/**
 * 수비 페이지 전용 수집 — 키가 `playerId|pos` 복합키다.
 * playerId 단독으로 받으면 멀티포지션 163명의 행이 서로를 덮어써 게이트가 거짓 불일치를 낸다.
 */
export async function collectKboDefensePages(page, url, season) {
  return collectKboPages(page, url, season, {
    keyOf: (id, tds) => `${id}|${tds[3] ?? ""}`,
  });
}

/** 한 데이터셋을 KBO 수집 결과와 행 집합 + 전 필드로 대조해 실패 목록을 돌려준다. */
export function crossCheckDataset({ label, rows, kbo, columns, checkRowSet = true, keyOf }) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const rowKey = keyOf ?? ((row) => String(row.kboId ?? row.playerId ?? "").trim());

  const byId = new Map();
  for (const row of rows) {
    const id = String(row.kboId ?? row.playerId ?? "").trim();
    if (!id) {
      fail(`${label}: canonical ID 없는 행 — ${row.name}/${row.team}`);
      continue;
    }
    const key = rowKey(row);
    if (byId.has(key)) fail(`${label}: 중복 키 ${key} (${row.name})`);
    byId.set(key, row);
  }

  if (checkRowSet) {
    for (const id of kbo.keys()) {
      if (!byId.has(id)) {
        fail(`${label}: KBO에 있으나 우리 데이터에 없음 — playerId=${id} (${kbo.get(id)?.[1] ?? "?"})`);
      }
    }
    for (const id of byId.keys()) {
      if (!kbo.has(id)) {
        fail(`${label}: 우리 데이터에만 있음 — playerId=${id} (${byId.get(id)?.name})`);
      }
    }
  }

  let cells = 0;
  for (const [id, tds] of kbo) {
    const row = byId.get(id);
    if (!row) continue;
    if (String(row.name).trim() !== String(tds[1]).trim()) {
      fail(`${label}: 이름 불일치 playerId=${id} ours=${row.name} kbo=${tds[1]}`);
    }
    if (String(row.team).trim() !== String(tds[2]).trim()) {
      fail(`${label}: 팀 불일치 playerId=${id} ours=${row.team} kbo=${tds[2]}`);
    }
    for (const [index, key] of columns) {
      cells++;
      const ours = String(row[key] ?? "").trim();
      const theirs = String(tds[index] ?? "").trim();
      if (ours !== theirs) {
        fail(`${label}: 값 불일치 playerId=${id}(${row.name}) ${key} ours=${ours} kbo=${theirs}`);
      }
    }
  }

  return { failures, cells, ourRows: rows.length, kboRows: kbo.size };
}

/**
 * 크롤 산출물을 KBO 원본과 전수 대조하고, 불일치가 1건이라도 있으면 **던진다**.
 *
 * ⚠︎ 판정 분기를 호출자(크롤러) 쪽에 두면 `if (false && failures.length)` 한 줄로 무력화되고,
 * 그래도 "호출이 존재하는가" 식 게이트는 GREEN이다(실제로 내 초기 구현이 그랬다).
 * 그래서 대조·판정·예외를 전부 여기서 끝낸다. 호출자는 이걸 부를 수만 있다.
 */
export async function assertSourceTruth({ browser, kboBase, season, batters, pitchers, defense, defenseRuns, roster, foreignIdSource, log = console.log }) {
  const page = await browser.newPage();
  const failures = [];
  try {
    const kboPitchers = await collectKboPages(
      page, `${kboBase}/Record/Player/PitcherBasic/Basic1.aspx?sort=GAME_CN`, season,
    );
    const kboBatters1 = await collectKboPages(
      page, `${kboBase}/Record/Player/HitterBasic/Basic1.aspx?sort=GAME_CN`, season,
    );
    const kboBatters2 = await collectKboPages(
      page, `${kboBase}/Record/Player/HitterBasic/Basic2.aspx?sort=GAME_CN`, season,
    );
    // 도루(Runner) — 타자의 sb/cs 는 이 페이지에서 온다.
    // 이걸 빼면 전다민 sb 1 → 999 오염이 그대로 통과한다(삼순 P0-1 실증).
    const kboRunner = await collectKboPages(
      page, `${kboBase}/Record/Player/Runner/Basic.aspx`, season,
    );
    // 수비는 `(playerId, pos)` 복합키다 — 한 선수가 여러 포지션을 본다.
    const kboDefense = await collectKboDefensePages(
      page, `${kboBase}/Record/Player/Defense/Basic.aspx?sort=GAME_CN`, season,
    );

    // freshness 안정성은 실패 문구가 아니라 원본 전체 key/value 자체로 판정한다.
    log(`${SOURCE_DIGEST_MARKER}=${digestSourceMaps({
      pitchers: kboPitchers,
      batters1: kboBatters1,
      batters2: kboBatters2,
      runner: kboRunner,
      defense: kboDefense,
    })}`);

    for (const spec of [
      { label: "투수", rows: pitchers, kbo: kboPitchers, columns: PITCHER_COLUMNS },
      { label: "타자", rows: batters, kbo: kboBatters1, columns: BATTER_BASIC1_COLUMNS },
      { label: "타자(추가지표)", rows: batters, kbo: kboBatters2, columns: BATTER_BASIC2_COLUMNS },
      // Runner 페이지에는 도루 기록이 있는 선수만 등장하므로 행 집합 대조는 하지 않는다.
      // 대신 등장하는 선수의 sb/cs 값은 반드시 일치해야 하고,
      // Runner 에 없는 선수는 아래에서 sb/cs = 0 인지 따로 확인한다.
      {
        label: "타자(도루)",
        rows: batters,
        kbo: kboRunner,
        columns: RUNNER_COLUMNS,
        checkRowSet: false,
      },
      {
        label: "수비",
        rows: defense,
        kbo: kboDefense,
        columns: DEFENSE_COLUMNS,
        keyOf: (row) => `${String(row.kboId ?? "").trim()}|${row.pos ?? ""}`,
      },
    ]) {
      const result = crossCheckDataset(spec);
      log(`    [${spec.label}] 우리 ${result.ourRows}행 / KBO ${result.kboRows}행 · ${result.cells}셀 대조`);
      failures.push(...result.failures);
    }

    // Runner 에 없는 선수가 0 이 아닌 도루 기록을 들고 있으면 조작이다.
    {
      let checked = 0;
      for (const row of batters) {
        const id = String(row.kboId ?? row.playerId ?? "").trim();
        if (kboRunner.has(id)) continue;
        checked++;
        if (Number(row.sb ?? 0) !== 0 || Number(row.cs ?? 0) !== 0) {
          failures.push(
            `타자(도루): KBO 도루 기록이 없는 선수에 값이 있음 — playerId=${id}(${row.name}) sb=${row.sb} cs=${row.cs}`,
          );
        }
      }
      log(`    [타자(도루 미등재)] ${checked}명 sb/cs=0 확인`);
    }
  } finally {
    await page.close().catch(() => {});
  }

  // 파생 산출물(defense-runs)까지 promote *전에* 같은 validator 로 검증한다.
  //
  // ⚠︎ 종전에는 `if (defenseRuns && roster && foreignIdSource)` 였다. 그래서 호출부에
  // 이름만 남기고 `roster: []`, `foreignIdSource: ""`, `defenseRuns: undefined` 를 넣으면
  // 검증이 조용히 skip 되는데도 전 게이트가 GREEN 이었다(삼순 6차 실증).
  // ⚠︎ 종전에는 `requireDerived` optional flag 였다. 그래서 caller 한 줄을 `false` 로
  // 바꾸면 파생 검증을 통째로 skip 할 수 있었는데 전 게이트가 GREEN 이었다(삼순 7차 실증).
  // 검증을 끌 수 있는 스위치 자체를 없앤다 — 파생 입력은 항상 필수다.
  {
    const missing = [];
    if (!defenseRuns || Object.keys(defenseRuns).length === 0) missing.push("defenseRuns");
    if (!Array.isArray(roster) || roster.length === 0) missing.push("roster");
    if (typeof foreignIdSource !== "string" || foreignIdSource.trim() === "") {
      missing.push("foreignIdSource");
    }
    if (missing.length) {
      throw new Error(
        `derived_inputs_missing: ${missing.join(", ")} — 파생 검증 입력이 비어 있어 `
          + "promote 전 검증을 수행할 수 없다(검증 skip 을 통과로 취급하지 않는다)",
      );
    }
    failures.push(
      ...crossCheckDerived({ batters, pitchers, defense, defenseRuns, roster, foreignIdSource }),
    );
  }

  if (failures.length) {
    for (const line of failures.slice(0, 20)) console.error("    - " + line);
    if (failures.length > 20) console.error(`    ... 외 ${failures.length - 20}건`);
    throw new Error(
      `stats_source_truth_mismatch: 원본 대조 ${failures.length}건 불일치 — 산출물을 쓰지 않음`,
    );
  }
  log("    ✅ 원본 정합성 전 행·전 필드 일치");
}

/**
 * 파생/교차 결속 — 네트워크 없이 로컬 데이터만으로 검사한다.
 * defense 복합키 유일성, defense runs 참조 무결성, 스탯↔roster canonical ID 결속.
 */
export function crossCheckDerived({ batters, pitchers, defense, defenseRuns, roster, foreignIdSource }) {
  const failures = [];
  const fail = (message) => failures.push(message);

  // 한 선수가 여러 포지션을 볼 수 있으므로 defense 유일키는 (kboId, pos) 복합키다.
  {
    const seen = new Set();
    for (const row of defense) {
      if (!String(row.kboId ?? "").trim()) {
        fail(`수비: canonical ID 없는 행 ${row.name}/${row.pos}`);
        continue;
      }
      const key = `${row.kboId}|${row.pos}`;
      if (seen.has(key)) fail(`수비: 복합키 중복 ${key} (${row.name})`);
      seen.add(key);
    }
  }

  // defense runs 는 참조 무결성만으로는 부족하다.
  //
  // ⚠︎ 종전에는 "키가 defense 에 실재하는가"만 봤다. 그래서 값 자체를 조작해도
  // (삼순 실증: `50054: -3.5 → 995.5`) 게이트가 GREEN 이었다.
  // defense-runs 는 검증된 defense 에서 결정론적으로 파생되는 값이므로,
  // 여기서 다시 계산해 저장본과 전 키·전 값을 대조한다.
  {
    const defenseIds = new Set(defense.map((row) => String(row.kboId)));
    for (const id of Object.keys(defenseRuns)) {
      if (!defenseIds.has(id)) fail(`수비runs: defense에 없는 ID ${id}`);
    }

    const expected = computeDefenseRuns(defense);
    const expectedKeys = Object.keys(expected);
    const storedKeys = Object.keys(defenseRuns);
    for (const id of expectedKeys) {
      if (!(id in defenseRuns)) fail(`수비runs: 파생 결과에 있으나 저장본에 없음 — ${id}`);
    }
    for (const id of storedKeys) {
      if (!(id in expected)) fail(`수비runs: 저장본에만 있음 — ${id}`);
    }
    for (const id of expectedKeys) {
      if (!(id in defenseRuns)) continue;
      // 파생값은 소수 1자리로 반올림돼 저장된다(computeDefenseRuns 계약).
      if (Number(defenseRuns[id]) !== Number(expected[id])) {
        fail(`수비runs: 값 불일치 ${id} stored=${defenseRuns[id]} derived=${expected[id]}`);
      }
    }
  }

  // 스탯에 등장하는 선수는 roster에 canonical ID로 존재해야 한다.
  //
  // ⚠︎ 외국인은 roster가 영문 canonical(FP007/AQ001)이고 스탯은 숫자 ID다.
  // SSOT 역매핑표를 거치지 않으면 외국인 31명이 전부 false RED가 된다
  // (초기 구현이 실제로 그랬다 — 게이트가 매 크롤을 막아버려 쓸 수 없게 된다).
  {
    const numericToAlpha = new Map();
    for (const match of foreignIdSource.matchAll(/"(\d+)":\s*"([A-Z]{2}\d+)"/g)) {
      numericToAlpha.set(match[1], match[2]);
    }
    if (numericToAlpha.size === 0) {
      fail("foreign-id-map 파싱 결과 0건 — 외국인 해석 불가(fail-close)");
    }
    const rosterIds = new Set(roster.map((player) => String(player.kboId)));
    for (const [label, rows] of [["타자", batters], ["투수", pitchers]]) {
      for (const row of rows) {
        const id = String(row.kboId ?? row.playerId ?? "");
        if (rosterIds.has(id)) continue;
        const alpha = numericToAlpha.get(id);
        if (alpha && rosterIds.has(alpha)) continue;
        fail(
          `${label}: roster에 없는 선수 playerId=${id} (${row.name}/${row.team})`
            + (alpha ? ` — 외국인 매핑 ${alpha} 이 roster에 없음` : ""),
        );
      }
    }
  }

  return failures;
}
