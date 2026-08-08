import { createHash } from "node:crypto";
import { computeDefenseRuns } from "./defense-runs.mjs";
import { collectAllPages, createKboPageAdapter, signatureOf } from "./kbo-pagination.mjs";
import { createSelectAdapter, selectAndConfirm } from "./kbo-select.mjs";
import {
  assertConfirmReads,
  assertLedgerBounded,
  classifyRowStability,
  describeUnstableRows,
  describeValueConflicts,
  ledgerKeySet,
  MIN_CONFIRM_READS,
} from "./source-row-stability.mjs";

export const SOURCE_DIGEST_MARKER = "KBO_SOURCE_DIGEST";

/**
 * 원본 전체 key/value를 순서 독립적인 SHA-256으로 접는다.
 *
 * `excludeKeys` 는 **원장에 등재된 불안정 행**이다. 그 행은 원본이 조회마다
 * 줬다 안 줬다 하므로, 포함하면 digest 가 매 회차 달라져 freshness 의 안정 window 가
 * 계속 reset 된다 — 원인을 고쳐도 게이트가 다른 이유로 정체한다(삼순 지적).
 *
 * ⚠︎ 제외는 그 key 의 **존재 여부**에만 적용된다. 나머지 전 행·전 필드는 그대로 들어가므로,
 * 무관한 값이 바뀌면 digest 는 반드시 바뀜다. 전체를 지우면 digest 를 꺼버린 것과 같다.
 */
export function digestSourceMaps(labeledMaps, { excludeKeys } = {}) {
  const excluded = excludeKeys ?? new Set();
  const hash = createHash("sha256");
  for (const label of Object.keys(labeledMaps).sort()) {
    hash.update(`\n##${label}\n`);
    const map = labeledMaps[label];
    for (const key of [...map.keys()].sort()) {
      if (excluded.has(key)) continue;
      hash.update(`${key}\u0001${(map.get(key) ?? []).join("\u0002")}\n`);
    }
  }
  return hash.digest("hex");
}

export function emitSourceDigest(log, labeledMaps, options) {
  const digest = digestSourceMaps(labeledMaps, options);
  log(`${SOURCE_DIGEST_MARKER}=${digest}`);
  return digest;
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

/**
 * 확인 재조회 후 **재판정 병합** — 순수 함수.
 *
 * ⚠︎ 이걸 assertSourceTruth 안에 인라인으로 두면 게이트가 검증할 수가 없다.
 * 실제로 1차 구현에서 `carriedFailures = []`, `if (false) failures.push(conflictNote)`
 * 두 변이가 전부 GREEN 이었다 — 스모크가 소스 문자열만 봤기 때문이다.
 * 병합 규칙을 다음 세 줄로 고정하고 게이트가 **직접 호출**해 행동을 본다.
 *
 *   1) 재판정 결과(흔들린 키 제외)를 쓴다
 *   2) 최초 판정의 **비-행집합 failure**(값 불일치 등)는 그대로 살린다
 *   3) 회차별 값 충돌은 fail-close 로 붙인다
 *
 * @returns {string[]} 최종 failure 목록
 */
export function mergeConfirmedJudgement({ initialResult, confirmedResult, conflictNote }) {
  const rowSetMessages = initialResult.rowSetMessages ?? new Set();
  // 최초 판정에서 행집합이 아닌 실패는 재조회로 바뀌지 않는다 — 버리면 증거가 사라진다.
  const carried = (initialResult.failures ?? []).filter((line) => !rowSetMessages.has(line));
  const merged = [...(confirmedResult.failures ?? [])];
  for (const line of carried) {
    if (!merged.includes(line)) merged.push(line);
  }
  if (conflictNote && !merged.includes(conflictNote)) merged.push(conflictNote);
  return merged;
}

/**
 * 확인 관측 → 재판정 → 병합까지의 **전체 경로**. 수집기를 주입받는다.
 *
 * ⚠︎ 이 경로를 assertSourceTruth 안에 인라인으로 두면 게이트가 못 태운다.
 * 실측으로 2차 구현에서 `conflictNote: null` · `merged = []` 두 변이가 GREEN 이었다
 * — 순수 병합 함수만 빼놓고 **그 함수에 뭐를 넘기는지**는 소스 문자열로만 봤기 때문이다.
 * 수집만 주입점으로 남기고 판정·병합을 전부 여기서 끝낸다.
 *
 * @param {object} input
 * @param {object} input.spec crossCheckDataset 스펙(+ kbo = 최초 관측)
 * @param {object} input.initialResult 최초 판정 결과
 * @param {(opts:{priorObservations:Array}) => Promise<object>} input.collectConfirmed 확인 관측 수집기
 */
export async function judgeWithConfirmation({ spec, initialResult, collectConfirmed, ledgerKeys, log = () => {} }) {
  const confirmed = await collectConfirmed({ priorObservations: [spec.kbo] });

  const unstableNote = confirmed.unstableKeys.size > 0
    ? describeUnstableRows(spec.label, confirmed.unstableKeys, confirmed.union)
    : null;
  if (unstableNote) log(`    ⚠︎ ${unstableNote}`);

  /* 재판정: 확인 관측의 union 을 원본으로 쓰고, 흔들린 키는 행 집합에서 제외한다.
   *
   * ⚠︎ 이번 확인에서 관측된 불안정 키 **그리고** 크롤이 남긴 원장 키를 함께 면제한다.
   * 원장을 빼면, 오라클이 확인 3회에서도 그 행을 모두 놓친 경우에 다시 죽는다 —
   * 크롤은 보존했는데 오라클은 모르는 상태가 정확히 그 재정체 경로다.
   */
  const exempt = new Set(confirmed.unstableKeys);
  for (const key of ledgerKeys ?? []) exempt.add(key);

  const rejudged = crossCheckDataset({
    ...spec,
    kbo: confirmed.union,
    unstableKeys: exempt,
  });

  // 같은 key 가 회차마다 다른 값이면 불안정이 아니라 오염 후보라 fail-close 한다.
  rejudged.failures = mergeConfirmedJudgement({
    initialResult,
    confirmedResult: rejudged,
    conflictNote: describeValueConflicts(spec.label, confirmed.valueConflictKeys),
  });

  return { result: rejudged, unstableNote };
}

/**
 * 같은 화면을 N회 독립 조회해 **행 존재 안정성**까지 판정한다.
 *
 * ⚠︎ 이 함수는 row-set 불일치가 이미 관측됐을 때만 부른다. 정상 런에서 매번 N배로
 * 조회하면 게이트 비용이 그대로 N배가 되고, 그러면 게이트를 끄자는 압력이 생긴다.
 * 확인 비용은 "의심스러울 때만" 낸다.
 *
 * reads 하한(`assertConfirmReads`)은 여기서 강제한다 — 1회 관측은 정의상 전부 stable 이라
 * 종전과 같은 strict 판정이 되는데, union·stable 은 그럴듯하게 채워져 아무도 못 잡는다.
 */
export async function collectKboPagesConfirmed(page, url, season, { keyOf, reads, priorObservations = [] } = {}) {
  assertConfirmReads(reads);
  // ⚠︎ 최초 관측을 버리면 안 된다(삼순 지적). 최초에만 보였던 key 가 증거에서 사라지고,
  // 새 회차만으로 통째 교체하면 관측 모수가 줄어 불안정 판정도 느슬해진다.
  const observations = [...priorObservations];
  while (observations.length < reads) {
    observations.push(await collectKboPages(page, url, season, { keyOf }));
  }
  return classifyRowStability(observations);
}

/**
 * 한 데이터셋을 KBO 수집 결과와 행 집합 + 전 필드로 대조해 실패 목록을 돌려준다.
 *
 * `unstableKeys` 는 원본이 조회마다 줬다 안 줬다 한 키다(2026-08-08 전다민 54214 실측).
 * 그 키는 **행 집합** 판정에서만 빠진다 — 값 대조는 그대로다. 흔들리는 건 행의 존재지
 * 값이 아니고, 값까지 봐주면 그건 게이트를 지운 것이다.
 */
export function crossCheckDataset({ label, rows, kbo, columns, checkRowSet = true, keyOf, unstableKeys }) {
  const failures = [];
  const unstable = unstableKeys ?? new Set();
  const fail = (message) => failures.push(message);
  // 행 집합 실패만 따로 센다 — "확인 재조회를 할지"를 이걸로 결정하기 때문이다.
  // 값 불일치는 재조회로 바뀌지 않으므로 포함하지 않는다.
  let rowSetFailures = 0;
  // 재판정이 들어올 때 "무엇을 버려도 되는가"를 구분하려면 행집합 문장을 알아야 한다.
  // 이게 없으면 보존 로직이 문장 접두사 추측으로 가고, 그러면 문구를 바꿔도 안 깨진다.
  const rowSetMessages = new Set();
  const failRowSet = (message) => {
    rowSetFailures++;
    rowSetMessages.add(message);
    failures.push(message);
  };
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
      if (unstable.has(id)) continue; // 원본이 흔든 행 — 존재 여부로 판정하지 않는다
      if (!byId.has(id)) {
        failRowSet(`${label}: KBO에 있으나 우리 데이터에 없음 — playerId=${id} (${kbo.get(id)?.[1] ?? "?"})`);
      }
    }
    for (const id of byId.keys()) {
      if (unstable.has(id)) continue;
      if (!kbo.has(id)) {
        failRowSet(`${label}: 우리 데이터에만 있음 — playerId=${id} (${byId.get(id)?.name})`);
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

  return { failures, rowSetFailures, rowSetMessages, cells, ourRows: rows.length, kboRows: kbo.size };
}

/**
 * 크롤 산출물을 KBO 원본과 전수 대조하고, 불일치가 1건이라도 있으면 **던진다**.
 *
 * ⚠︎ 판정 분기를 호출자(크롤러) 쪽에 두면 `if (false && failures.length)` 한 줄로 무력화되고,
 * 그래도 "호출이 존재하는가" 식 게이트는 GREEN이다(실제로 내 초기 구현이 그랬다).
 * 그래서 대조·판정·예외를 전부 여기서 끝낸다. 호출자는 이걸 부를 수만 있다.
 */
export async function assertSourceTruth({ browser, kboBase, season, batters, pitchers, defense, defenseRuns, roster, foreignIdSource, rowLedger, log = console.log }) {
  /* ── 행 불안정 원장 ─────────────────────────────────────────
   *
   * 크롤이 N회 읽어 "이 행은 원본이 흔든다"를 알아내도, 오라클은 그걸 모른다.
   * 오라클이 우연히 N회 모두 그 행을 놓치면 다시 "우리에만 있음"으로 죽고,
   * promote 와 원장이 함께 롤백돼 다음 런에도 똑같이 죽는다(삼순 실증).
   *
   * 그래서 크롤의 관측 사실을 **산출물과 같은 promote payload** 에 실어 여기서 읽는다.
   * ⚠︎ 원장은 **행 존재** 판정만 면제한다. 값 대조는 그대로 엄격하다.
   */
  /* ⚠︎ 원장 미전달을 **여기서** 죽인다(삼순 P0, 2026-08-08).
   *
   * 크롤 내부 promote 는 payload 파생이라 항상 넘어오지만, updater 가 PR 직전에 부르는
   * 독립 verifier 는 별도 프로세스다. 그쪽이 안 넘기면 `ledgerKeys = ∅` 이 돼
   * 행 면제와 digest 정규화가 통째로 꺼지고 정체가 그대로 재현된다.
   *
   * caller 쪽에 "넘겼는가" 검사를 두면 그건 문자열 게이트라 한 줄 삭제에 GREEN 이다
   * — 실측으로 Q1(rowLedger 미전달)·Q2(원장 경로 제거) 변이가 둘 다 GREEN 이었다.
   * 그래서 계약을 대조 로직 안으로 옮겼다. 어느 경로로 들어오든 원장이 없으면 죽는다.
   *
   * 비어있는 원장은 정상이다(흔든 행이 없는 날). 없는 것과 비어있는 건 다르다. */
  if (!rowLedger || typeof rowLedger !== "object"
    || typeof rowLedger.rows !== "object" || rowLedger.rows === null) {
    throw new Error(
      "row_ledger_missing: 행 불안정 원장이 전달되지 않았다 — 원장 없이 대조하면"
        + " 원본 행 불안정 면제와 digest 정규화가 모두 꺼져 거짓 불일치로 정체한다(fail-close)",
    );
  }

  const ledgerKeys = ledgerKeySet(rowLedger);
  // 원장은 몇 행짜리 예외일 때만 유효하다. 통째로 부풀면 그건 면제가 아니라
  // 행 집합 대조를 꺼버린 것이다 — 그 상태에서도 전 게이트는 GREEN 이므로 상한을 둔다.
  assertLedgerBounded(rowLedger, defense?.length ?? 0, { label: "수비" });

  // ⚠︎ 입력 계약을 다 본 뒤에야 네트워크를 열어야 한다. 순서가 반대면 배선이 끊겼을 때
  // 원인이 다른 실패(브라우저·페이지)로 가려져 진단이 엉뚱한 데로 간다.
  const page = await browser.newPage();
  const failures = [];
  const unstableNotes = [];
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

    /* freshness 안정성은 실패 문구가 아니라 원본 전체 key/value 자체로 판정한다.
     *
     * ⚠︎ 원장 등재 키는 digest 에서 **제외**한다(삼순 지적). 그렇게 안 하면
     * 좌/중 flapping 이 매 회차 digest 를 바꿔 freshness 의 180초 window 가 계속 reset 되고,
     * 판정 자체가 끝나지 않는다 — 원인은 고쳤는데 게이트가 다른 이유로 정체한다.
     *
     * ⚠︎ 단, **값이 바뀌면 digest 는 반드시 바뀜다.** 제외하는 건 원장 등재 키의
     * "있다/없다"뿐이고, 나머지 전 행·전 필드는 그대로 들어간다. 전체를 지우면
     * 그건 digest 를 꺼버린 것과 같아진다.
     */
    emitSourceDigest(log, {
      pitchers: kboPitchers,
      batters1: kboBatters1,
      batters2: kboBatters2,
      runner: kboRunner,
      defense: kboDefense,
    }, { excludeKeys: ledgerKeys });

    for (const spec of [
      {
        label: "투수",
        rows: pitchers,
        kbo: kboPitchers,
        columns: PITCHER_COLUMNS,
        url: `${kboBase}/Record/Player/PitcherBasic/Basic1.aspx?sort=GAME_CN`,
      },
      {
        label: "타자",
        rows: batters,
        kbo: kboBatters1,
        columns: BATTER_BASIC1_COLUMNS,
        url: `${kboBase}/Record/Player/HitterBasic/Basic1.aspx?sort=GAME_CN`,
      },
      {
        label: "타자(추가지표)",
        rows: batters,
        kbo: kboBatters2,
        columns: BATTER_BASIC2_COLUMNS,
        url: `${kboBase}/Record/Player/HitterBasic/Basic2.aspx?sort=GAME_CN`,
      },
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
        url: `${kboBase}/Record/Player/Defense/Basic.aspx?sort=GAME_CN`,
        keyOfSource: (id, tds) => `${id}|${tds[3] ?? ""}`,
        // 원장은 수비 축에만 걸린다 — 행 존재가 흔들린다고 실측된 곳이 여기만이다.
        useLedger: true,
      },
    ]) {
      // 원장 등재 행은 **행 존재** 판정에서 바로 면제된다.
      // 이게 없으면 크롤이 baseline 행을 보존해도 오라클이 그 행을 N회 모두 놓치면
      // "우리에만 있음"으로 죽고, promote·원장이 함께 롤백돼 다음 런에도 똑같이 죽는다.
      const ledgerForSpec = spec.useLedger ? ledgerKeys : undefined;
      let result = crossCheckDataset({ ...spec, unstableKeys: ledgerForSpec });

      /* ── 행 집합 불일치 → 원본 행 불안정인지 확인 재조회 ──────────────
       *
       * 2026-08-08 실측: KBO 는 같은 URL 을 조회할 때마다 rank 동률 최하위 구간의 행을
       * 줬다 안 줬다 한다(전다민 54214, 824↔825). 크롤이 한 번 읽어 산출물을 굳히므로,
       * 그 뒤 오라클이 다른 회차를 읽으면 "실제로 다르다"가 안정적으로 재현된다.
       * 재판독으로는 절대 안 풀린다 — 산출물은 이미 고정이기 때문이다.
       *
       * 그래서 행 집합 실패가 났을 때만 원본을 추가 관측해, 그 키가
       * **매 회차 나오는 키인지**를 확인한다. 매번 나오면 진짜 불일치고,
       * 회차마다 오락가락하면 원본이 흔든 것이다.
       *
       * ⚠︎ 값 대조는 이 경로에 없다. 흔들리는 건 행의 존재지 값이 아니다.
       * ⚠︎ 정상 런에서는 rowSetFailures 가 0 이라 추가 조회가 0회다(비용 그대로).
       */
      if (result.rowSetFailures > 0 && spec.url) {
        log(`    [${spec.label}] 행 집합 불일치 ${result.rowSetFailures}건 — 원본 행 안정성 확인(최초 관측 포함 총 ${MIN_CONFIRM_READS}회)`);

        // 판정·병합은 judgeWithConfirmation 이 끝낸다 — 여기서 풀어 쓰면 변이를 못 잡는다.
        // 이 경로가 넘기는 건 수집 방법뿐이다.
        const judged = await judgeWithConfirmation({
          spec,
          initialResult: result,
          log,
          ledgerKeys: ledgerForSpec,
          // 최초 관측을 1회차로 산입한다 — 버리면 그 회차에만 보였던 key 가 증거에서 사라진다.
          collectConfirmed: ({ priorObservations }) =>
            collectKboPagesConfirmed(page, spec.url, season, {
              keyOf: spec.keyOfSource,
              reads: MIN_CONFIRM_READS,
              priorObservations,
            }),
        });
        if (judged.unstableNote) unstableNotes.push(judged.unstableNote);
        result = judged.result;
      }

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
