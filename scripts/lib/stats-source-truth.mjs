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
 * 수비는 한 선수가 여러 포지션을 보므로 playerId 단독이 아니라 `(playerId, pos)` 복합키다.
 * 순위(0) 선수명(1) 팀명(2) POS(3) G(4) GS(5) IP(6) E(7) PKO(8) PO(9) A(10) DP(11) FPCT(12) PB(13) SB(14) CS(15)
 */
export const DEFENSE_COLUMNS = [
  [4, "games"], [6, "ip"], [7, "e"], [8, "pko"], [9, "po"],
  [10, "a"], [11, "dp"], [12, "fpct"], [13, "pb"], [14, "sb"], [15, "cs"],
];

/** 현재 테이블을 `{id, tds}` 배열로 읽는다. */
async function scrapeRows(page) {
  return page.$$eval("tbody tr", (trs) =>
    trs.map((tr) => {
      const tds = [...tr.querySelectorAll("td")].map((td) => td.textContent.trim());
      const anchor = tr.querySelector("a[href*='playerId=']");
      const id = anchor
        ? (anchor.getAttribute("href").match(/playerId=(\d+)/) || [])[1]
        : null;
      return { id, tds };
    }),
  );
}

/** 현재 페이지의 식별 시그니처(행 id 순서열). 상태 변경 감지용. */
async function pageSignature(page) {
  const rows = await scrapeRows(page);
  return rows.map((r) => r.id ?? "").join(",");
}

/**
 * 클릭 후 테이블이 *실제로* 바뀌었는지 확인한다.
 *
 * ⚠︎ 직전 판은 고정 900ms 대기 뒤 바로 다음 페이지로 간주했다. 그래서 KBO가 느리면
 * 이전 페이지를 다시 읽고(id 중복 → 0 new) 페이지 번호만 증가해 **한 페이지(30행)를 통째 건너뛰었다**.
 * 실측: 타자 Basic1이 329 대신 299로 수집돼, 데이터는 멀줥한데 게이트가 30건 false RED를 냈다.
 * fail-close 게이트가 랜덤하게 터지면 매일 크롤을 막아 지금과 같은 정지 사고를 게이트가 스스로 만든다.
 */
async function waitForTableChange(page, previousSignature, { attempts = 12, intervalMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await page.waitForTimeout(intervalMs);
    const signature = await pageSignature(page);
    if (signature && signature !== previousSignature) return signature;
  }
  return null;
}

/**
 * KBO 기록실 한 화면을 전 페이지 순회해 `playerId → 셀 배열`로 수집한다.
 *
 * 수집 불완전(페이지 전환 실패·0행)은 데이터 불일치가 아니므로 **별도 예외**로 구분해 던진다.
 * 검증 불가를 통과로 취급하면 게이트가 아니고, 불완전 수집을 불일치로 보고하면 false RED가 된다.
 */
export async function collectKboPages(page, url, season, { keyOf } = {}) {
  const makeKey = keyOf ?? ((id) => id);
  await page.goto(url, { waitUntil: "networkidle" });

  const seasonSelector = "#cphContents_cphContents_cphContents_ddlSeason_ddlSeason";
  if (season && (await page.$(seasonSelector))) {
    const current = await page.$eval(seasonSelector, (el) => el.value).catch(() => null);
    if (current !== String(season)) {
      const before = await pageSignature(page);
      await page.selectOption(seasonSelector, String(season));
      await page.waitForLoadState("networkidle").catch(() => {});
      await waitForTableChange(page, before);
    }
  }

  const seen = new Map();
  const visitedSignatures = new Set();
  let pageNum = 1;

  while (pageNum <= 60) {
    const signature = await pageSignature(page);
    if (!signature) {
      throw new Error(`source_incomplete: ${url} page ${pageNum} 에서 0행 — 수집 불완전`);
    }
    if (visitedSignatures.has(signature)) {
      // 같은 화면을 두 번 읽었다 = 페이지 전환이 실제로 안 일어난 것.
      // 그대로 진행하면 한 페이지를 통째 건너뛰게 된다.
      throw new Error(
        `source_incomplete: ${url} page ${pageNum} 가 직전 페이지와 동일 — 페이지 전환 실패`,
      );
    }
    visitedSignatures.add(signature);

    for (const row of await scrapeRows(page)) {
      if (!row.id) continue;
      const key = makeKey(row.id, row.tds);
      if (!seen.has(key)) seen.set(key, row.tds);
    }

    const nextVisible = page
      .locator('a[id*="ucPager_btnNo"]')
      .filter({ hasText: String(pageNum + 1) })
      .first();
    if (await nextVisible.count()) {
      await nextVisible.click();
      await page.waitForLoadState("networkidle").catch(() => {});
      const changed = await waitForTableChange(page, signature);
      if (!changed) {
        throw new Error(
          `source_incomplete: ${url} page ${pageNum} → ${pageNum + 1} 전환 후에도 내용이 그대로 — 페이지 유실 위험`,
        );
      }
      pageNum++;
      continue;
    }

    const nextGroup = await page.$('a[id$="btnNext"]');
    if (!nextGroup) break;
    const beforePager = await page.$$eval('a[id*="ucPager_btnNo"]', (ls) =>
      ls.map((a) => a.textContent?.trim()).join("|"),
    );
    await nextGroup.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    const changed = await waitForTableChange(page, signature);
    const afterPager = await page.$$eval('a[id*="ucPager_btnNo"]', (ls) =>
      ls.map((a) => a.textContent?.trim()).join("|"),
    );
    // 페이저가 그대로면 마지막 그룹 — 정상 종료.
    if (!afterPager || afterPager === beforePager) break;
    if (!changed) {
      throw new Error(
        `source_incomplete: ${url} 페이지 그룹 전환 후에도 내용이 그대로 — 페이지 유실 위험`,
      );
    }
    pageNum++;
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
export async function assertSourceTruth({ browser, kboBase, season, batters, pitchers, defense, log = console.log }) {
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
    // 수비는 `(playerId, pos)` 복합키다 — 한 선수가 여러 포지션을 본다.
    const kboDefense = await collectKboDefensePages(
      page, `${kboBase}/Record/Player/Defense/Basic.aspx?sort=GAME_CN`, season,
    );

    for (const spec of [
      { label: "투수", rows: pitchers, kbo: kboPitchers, columns: PITCHER_COLUMNS },
      { label: "타자", rows: batters, kbo: kboBatters1, columns: BATTER_BASIC1_COLUMNS },
      { label: "타자(추가지표)", rows: batters, kbo: kboBatters2, columns: BATTER_BASIC2_COLUMNS },
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
  } finally {
    await page.close().catch(() => {});
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

  // defense runs 키는 전부 defense에 실재하는 선수여야 한다.
  {
    const defenseIds = new Set(defense.map((row) => String(row.kboId)));
    for (const id of Object.keys(defenseRuns)) {
      if (!defenseIds.has(id)) fail(`수비runs: defense에 없는 ID ${id}`);
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
