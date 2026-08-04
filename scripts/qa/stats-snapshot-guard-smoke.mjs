import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateBatterSnapshot,
  validateDefenseRunsSnapshot,
  validateDefenseSnapshot,
  validatePitcherSnapshot,
} from "../lib/stats-snapshot-guard.mjs";

/* ── 투수(기존 계약) ─────────────────────────────────────────── */
const full = Array.from({ length: 276 }, (_, index) => ({
  kboId: String(50000 + index),
  name: `투수${index + 1}`,
  team: `T${index % 10}`,
}));

assert.doesNotThrow(
  () => validatePitcherSnapshot(full, full.map((row) => ({ ...row }))),
  "complete 276-row rerun stays GREEN",
);

const missingMiddlePage = full.filter((_row, index) => index < 120 || index >= 150);
assert.equal(missingMiddlePage.length, 246);
assert.throws(
  () => validatePitcherSnapshot(full, missingMiddlePage),
  /pitcher_snapshot_partial:previous=276,candidate=246,countDelta=30,missing=30/,
  "276→246 middle-page omission fails closed",
);

/* ── 타자 ────────────────────────────────────────────────────
 * 종전에는 가드가 투수에만 걸려 있어, 타자 페이지가 통째로 빠져도 그대로 썼다. */
const batters = Array.from({ length: 329 }, (_, index) => ({
  kboId: String(60000 + index),
  name: `타자${index + 1}`,
  team: `T${index % 10}`,
}));
assert.doesNotThrow(
  () => validateBatterSnapshot(batters, batters.map((row) => ({ ...row }))),
  "complete batter rerun stays GREEN",
);
assert.throws(
  () => validateBatterSnapshot(batters, batters.slice(30)),
  /batter_snapshot_partial:previous=329,candidate=299,countDelta=30,missing=30/,
  "타자 한 페이지(30행) 유실은 fail-close",
);

/* ── 수비 — (kboId, pos) 복합키 ───────────────────────────────
 * 실측 사고(2026-08-04): 823행 → 30행(첫 페이지만 남음)으로 무너졌는데
 * 수비에는 가드가 아예 없어 조용히 파일에 썼다. */
const defense = Array.from({ length: 823 }, (_, index) => ({
  kboId: String(70000 + Math.floor(index / 2)),
  name: `수비${index + 1}`,
  team: `T${index % 10}`,
  pos: index % 2 === 0 ? "유격수" : "2루수",
}));
assert.doesNotThrow(
  () => validateDefenseSnapshot(defense, defense.map((row) => ({ ...row }))),
  "complete defense rerun stays GREEN",
);
assert.throws(
  () => validateDefenseSnapshot(defense, defense.slice(0, 30)),
  /defense_snapshot_partial:previous=823,candidate=30,countDelta=793,missing=793/,
  "수비 823→30 붕괴는 fail-close (실측 사고 재현)",
);
// 같은 선수의 다른 포지션 행이 서로를 상쇄하면 안 된다 — 복합키가 실제로 쓰이는지 확인.
{
  const shortstopOnly = defense.filter((row) => row.pos === "유격수");
  assert.throws(
    () => validateDefenseSnapshot(defense, shortstopOnly),
    /defense_snapshot_partial/,
    "포지션 한 종류만 남으면 복합키 기준으로 누락이 잡혀야 한다",
  );
}

/* ── 수비 runs — 배열이 아니라 { kboId: runs } 맵 ────────────── */
const defenseRuns = Object.fromEntries(
  Array.from({ length: 271 }, (_, index) => [String(70000 + index), index / 10]),
);
assert.doesNotThrow(
  () => validateDefenseRunsSnapshot(defenseRuns, { ...defenseRuns }),
  "complete defense-runs rerun stays GREEN",
);
assert.throws(
  () => validateDefenseRunsSnapshot(
    defenseRuns,
    Object.fromEntries(Object.entries(defenseRuns).slice(0, 30)),
  ),
  /defense_runs_snapshot_partial:previous=271,candidate=30/,
  "수비runs 271→30 붕괴는 fail-close",
);

/* ── 실제 배선 — 네 가드가 모두 첫 write보다 앞에서 실행되는가 ──
 * 존재만 확인하면 write 뒤로 옮겨도 GREEN이므로 위치 관계를 고정한다. */
const crawler = readFileSync("scripts/crawl-stats.mjs", "utf8");
// 산출물 교체는 promoteAtomically 한 지점에서만 일어난다(원자 promote, 삼순 P0-3).
// 순차 직쓰기가 남아 있으면 atomic-promote 스모크가 따로 RED 를 낸다.
const firstWriteIndex = crawler.indexOf("promoteAtomically(artifacts)");
assert.ok(firstWriteIndex >= 0, "산출물 promote 지점을 찾을 수 있어야 한다");

for (const call of [
  "validatePitcherSnapshot(",
  "validateBatterSnapshot(",
  "validateDefenseSnapshot(",
  "validateDefenseRunsSnapshot(",
]) {
  const index = crawler.indexOf(call);
  assert.ok(index >= 0, `크롤러가 \`${call}\` 를 호출해야 한다`);
  assert.ok(
    index < firstWriteIndex,
    `\`${call}\` 는 모든 stats/meta write 보다 앞에서 실행돼야 한다`,
  );
}

/* ── 원본 대조(값 정확도)가 write 앞에서 *실제로 차단*하는가 ────
 * 개수 가드만으로는 값 오염을 못 잡는다.
 *
 * ⚠︎ 문자열 존재 검사만으로는 부족하다. 크롤러가 판정 분기를 들고 있으면
 * `if (false && failures.length)` 한 줄로 무력화되는데 존재 검사는 GREEN이다
 * (실제로 초기 구현이 그랬고 mutation으로 잡았다). 그래서 판정·예외를 라이브러리로 옮기고,
 * 여기서는 ①크롤러가 그 함수를 write 앞에서 부르는가 ②그 함수가 실제로 던지는가 를 본다. */
{
  const truthIndex = crawler.indexOf("assertSourceTruth(");
  assert.ok(truthIndex >= 0, "크롤러가 assertSourceTruth 를 호출해야 한다");
  assert.ok(
    truthIndex < firstWriteIndex,
    "원본 정합성 대조는 모든 stats/meta write 보다 앞에서 실행돼야 한다",
  );
  // 크롤러가 결과를 삼키지 못하도록 await 호출이어야 한다(Promise 무시 방지).
  assert.ok(
    /await\s+assertSourceTruth\(/.test(crawler),
    "assertSourceTruth 는 await 로 호출돼야 한다(거부를 삼키면 안 된다)",
  );
}

/* ── assertSourceTruth 행동 검증 — 실제로 던지는지 직접 실행한다 ──
 * KBO를 호출하지 않도록 browser/page 를 스텁으로 주입한다. */
{
  const { assertSourceTruth } = await import("../lib/stats-source-truth.mjs");

  // KBO 페이지를 흉내내는 스텁: 요청 URL에 따라 고정된 행을 돌려준다.
  const makeStubBrowser = (rowsByUrl) => ({
    async newPage() {
      let current = [];
      return {
        async goto(url) {
          const key = Object.keys(rowsByUrl).find((k) => url.includes(k));
          current = rowsByUrl[key] ?? [];
        },
        async $() { return null; },
        async $eval() { return null; },
        async $$eval(selector, fn) {
          // pager 조회는 항상 빈 문자열 → 다음 페이지 없음으로 종료
          return "";
        },
        locator() { return { filter: () => ({ first: () => ({ async count() { return 0; } }) }) }; },
        async waitForLoadState() {},
        async waitForTimeout() {},
        async selectOption() {},
        async close() {},
        // scrapeRows 가 쓰는 경로
        async $$evalRows() { return current; },
        __rows: () => current,
      };
    },
  });

  // 실제 collectKboPages 는 page.$$eval("tbody tr", fn) 로 행을 읽는다.
  // 스텁이 그 시그니처를 흉내내도록 별도 구성.
  // 공용 core(collectAllPages + createKboPageAdapter) 가 읽는 형태로 돌려준다.
  // adapter.scrapeTable 은 `{texts, hrefs}` 를 기대하므로 stub 도 그 shape 이어야 한다.
  const buildPage = (rowsByUrl) => {
    let current = [];
    return {
      async goto(url) {
        const key = Object.keys(rowsByUrl).find((k) => url.includes(k));
        current = rowsByUrl[key] ?? [];
      },
      async $(sel) { return null; },      // btnNext 없음 → 단일 그룹, 정상 EOF
      async $eval() { return null; },
      async $$eval(selector) {
        if (selector === "tbody tr") {
          return current.map((r) => ({
            texts: r.tds,
            hrefs: r.tds.map((_, i) => (i === 1 ? `?playerId=${r.id}` : "")),
          }));
        }
        return "";                        // pager 없음
      },
      locator() {
        return { filter: () => ({ first: () => ({ async count() { return 0; } }) }) };
      },
      async waitForLoadState() {},
      async waitForTimeout() {},
      async selectOption() {},
      async close() {},
    };
  };

  const row = (id, name, team, cells) => ({ id, tds: ["1", name, team, ...cells] });
  // 컬럼 인덱스 3부터 값이 시작하므로 넉넉히 채운다.
  const pad = (n) => Array.from({ length: n }, () => "0");

  const pitcherRow = row("90001", "테스트투수", "TT", [
    "1.00", "10", "1", "0", "0", "0", "1.000", "10", "5", "0", "2", "0", "9", "1", "1", "0.70",
  ]);
  const batterCells1 = ["0.300", "10", "40", "35", "5", "10", "2", "0", "1", "15", "5", "0", "0"];
  const batterCells2 = ["0.300", "4", "0", "1", "8", "0", "0.400", "0.380", "0.780"];
  const batterRow1 = row("90002", "테스트타자", "TT", batterCells1);
  const batterRow2 = row("90002", "테스트타자", "TT", batterCells2);
  const defenseRow = row("90003", "테스트수비", "TT", ["유격수", "10", "10", "80", "1", "0", "20", "30", "5", "0.980", "0", "0", "0"]);

  // 도루(Runner): 순위0 선수명1 팀명2 G3 SBA4 SB5 CS6 ...
  const runnerRow = row("90002", "테스트타자", "TT", ["10", "5", "3", "1", "0.750", "0", "0"]);
  const urls = {
    "PitcherBasic": [pitcherRow],
    "HitterBasic/Basic1": [batterRow1],
    "HitterBasic/Basic2": [batterRow2],
    "Runner": [runnerRow],
    "Defense": [defenseRow],
  };

  const ourPitchers = [{
    kboId: "90001", name: "테스트투수", team: "TT",
    era: "1.00", games: 10, wins: 1, losses: 0, saves: 0, holds: 0, wpct: "1.000",
    ip: "10", h: 5, hr: 0, bb: 2, hbp: 0, so: 9, r: 1, er: 1, whip: "0.70",
  }];
  const ourBatters = [{
    kboId: "90002", name: "테스트타자", team: "TT",
    avg: "0.300", games: 10, pa: 40, ab: 35, runs: 5, hits: 10,
    doubles: 2, triples: 0, hr: 1, tb: 15, rbi: 5, sac: 0, sf: 0,
    bb: 4, ibb: 0, hbp: 1, so: 8, gdp: 0, slg: "0.400", obp: "0.380", ops: "0.780",
    sb: 3, cs: 1,
  }];
  const ourDefense = [{
    kboId: "90003", name: "테스트수비", team: "TT", pos: "유격수",
    games: 10, ip: "80", e: 1, pko: 0, po: 20, a: 30, dp: 5, fpct: "0.980", pb: 0, sb: 0, cs: 0,
  }];

  const stubBrowser = { async newPage() { return buildPage(urls); } };
  const silent = () => {};

  // 파생 검증은 optional 이 아니다(끌 수 있는 flag 자체를 제거했다).
  // 스텁 호출도 실제 계약대로 파생 입력을 넘긴다.
  const ourDefenseRuns = { "90003": 0 };
  const ourRoster = [
    { name: "테스트투수", kboId: "90001", teamId: 1 },
    { name: "테스트타자", kboId: "90002", teamId: 1 },
    { name: "테스트수비", kboId: "90003", teamId: 1 },
  ];
  const ourForeignIdSource = 'export const FOREIGN_NUMERIC_TO_ALPHA = { "55855": "FP007" };';
  const derived = {
    defenseRuns: ourDefenseRuns,
    roster: ourRoster,
    foreignIdSource: ourForeignIdSource,
  };

  // 일치하면 통과해야 한다.
  await assertSourceTruth({
    browser: stubBrowser, kboBase: "https://kbo.test", season: "2026",
    batters: ourBatters, pitchers: ourPitchers, defense: ourDefense, ...derived, log: silent,
  });

  // 값 오염 1건 → 반드시 던져야 한다.
  await assert.rejects(
    () => assertSourceTruth({
      browser: stubBrowser, kboBase: "https://kbo.test", season: "2026",
      batters: ourBatters,
      pitchers: [{ ...ourPitchers[0], era: "99.99" }],
      defense: ourDefense, ...derived, log: silent,
    }),
    /stats_source_truth_mismatch/,
    "값 오염 1건이면 assertSourceTruth 가 던져야 한다",
  );

  // 행 누락 1건 → 반드시 던져야 한다.
  await assert.rejects(
    () => assertSourceTruth({
      browser: stubBrowser, kboBase: "https://kbo.test", season: "2026",
      batters: ourBatters, pitchers: ourPitchers, defense: [], ...derived, log: silent,
    }),
    /stats_source_truth_mismatch/,
    "수비 행 누락이면 assertSourceTruth 가 던져야 한다",
  );

  // 도루(sb/cs) 값 오염도 잡아야 한다 — 종전에는 Runner 를 아예 안 읽어 GREEN 이었다.
  await assert.rejects(
    () => assertSourceTruth({
      browser: stubBrowser, kboBase: "https://kbo.test", season: "2026",
      batters: [{ ...ourBatters[0], sb: 999 }],
      pitchers: ourPitchers, defense: ourDefense, ...derived, log: silent,
    }),
    /stats_source_truth_mismatch/,
    "타자 도루 값 오염이면 assertSourceTruth 가 던져야 한다",
  );

  // 파생 입력을 비우면(검증을 끄려는 시도) 반드시 던져야 한다.
  // `requireDerived` optional flag 를 제거했으므로 우회 스위치가 없다.
  for (const [label, override] of [
    ["defenseRuns", { defenseRuns: {} }],
    ["roster", { roster: [] }],
    ["foreignIdSource", { foreignIdSource: "" }],
  ]) {
    await assert.rejects(
      () => assertSourceTruth({
        browser: stubBrowser, kboBase: "https://kbo.test", season: "2026",
        batters: ourBatters, pitchers: ourPitchers, defense: ourDefense,
        ...derived, ...override, log: silent,
      }),
      /derived_inputs_missing/,
      `파생 입력 ${label} 이 비면 assertSourceTruth 가 던져야 한다(검증 skip 불가)`,
    );
  }

  /* ── actual caller 검증 — 크롤러가 진짜 파생 입력을 넘기는가 ──────
   *
   * ⚠︎ 위 루프는 라이브러리 계약만 본다. 그래서 caller 한 줄을 `defenseRuns: {}` 나
   * `roster: []` 로 바꿔 검증을 우회해도 이 게이트가 GREEN 이었다(mutation 으로 확인).
   * flag 를 없앨다고 끝난 게 아니다 — 우회 경로가 caller 로 옮겨갔을 뿐이다.
   * 크롤러 소스에서 실제 호출 인자를 뚜어 빈 값·리터럴 주입을 차단한다. */
  {
    const crawler = readFileSync("scripts/crawl-stats.mjs", "utf8");
    const start = crawler.indexOf("await assertSourceTruth({");
    assert.ok(start >= 0, "크롤러가 assertSourceTruth 를 await 호출해야 한다");
    const end = crawler.indexOf("});", start);
    const call = crawler.slice(start, end);

    for (const key of ["defenseRuns", "roster", "foreignIdSource"]) {
      const line = call.split("\n").find((l) => new RegExp(`^\\s*${key}\\b`).test(l));
      assert.ok(line, `크롤러 호출에 파생 입력 ${key} 가 있어야 한다`);
      // 빈 객체/배열/문자열 리터럴을 직접 넘기는 건 검증 우회다.
      assert.ok(
        !/:\s*(\{\s*\}|\[\s*\]|""|''|null|undefined)\s*,?\s*$/.test(line),
        `크롤러가 ${key} 에 빈 값을 넘기면 파생 검증이 우회된다: ${line.trim()}`,
      );
    }

    // 독립 검증기도 같은 계약을 지켜야 한다.
    // 종전에는 여기서 파생 입력을 빼고 `crossCheckDerived` 를 따로 불렀다.
    // 그 상태로 라이브러리가 파생 검증을 강제하게 되자 live 검증이 통째로 깨졌다
    // (`derived_inputs_missing`). 검증 경로가 둘로 갈라지면 언젠가 한쪽만 갱신된다.
    const verifier = readFileSync("scripts/qa/stats-source-truth-verify.mjs", "utf8");
    const vStart = verifier.indexOf("await assertSourceTruth({");
    assert.ok(vStart >= 0, "독립 검증기도 assertSourceTruth 를 써야 한다");
    const vCall = verifier.slice(vStart, verifier.indexOf("});", vStart));
    for (const key of ["defenseRuns", "roster", "foreignIdSource"]) {
      assert.ok(
        new RegExp(`^\\s*${key}\\b`, "m").test(vCall),
        `독립 검증기 호출에도 파생 입력 ${key} 가 있어야 한다`,
      );
    }

  }

  /* ── 파생 대조 결과를 실제로 반영하는가(행동 검증) ────────────
   *
   * ⚠︎ 정규식으로 `failures.push(...crossCheckDerived(...))` 존재만 보면
   * `if (false) failures.push(...)` 를 못 잡는다(mutation 으로 확인한 false-green).
   * 원본은 전부 일치하고 **파생만 오염**된 입력을 넣어, 그 오염이 실제로
   * 예외로 이어지는지를 행동으로 확인한다. */
  await assert.rejects(
    () => assertSourceTruth({
      browser: stubBrowser, kboBase: "https://kbo.test", season: "2026",
      batters: ourBatters, pitchers: ourPitchers, defense: ourDefense,
      ...derived,
      // defense 에 없는 ID 를 파생에 넣는다 — 원본 대조는 전부 통과하고
      // 오직 crossCheckDerived 만 잡을 수 있는 오염이다.
      defenseRuns: { ...derived.defenseRuns, "99999": 1.5 },
      log: silent,
    }),
    /stats_source_truth_mismatch/,
    "파생(defense-runs) 오염만 있어도 assertSourceTruth 가 던져야 한다(결과 버리기 차단)",
  );

  // 원본을 못 읽으면(0행) 통과가 아니라 실패여야 한다.
  const emptyBrowser = { async newPage() { return buildPage({}); } };
  await assert.rejects(
    () => assertSourceTruth({
      browser: emptyBrowser, kboBase: "https://kbo.test", season: "2026",
      batters: ourBatters, pitchers: ourPitchers, defense: ourDefense, ...derived, log: silent,
    }),
    /source_unreachable|source_incomplete/,
    "원본 수집 0행은 통과가 아니라 실패여야 한다",
  );
}

console.log("stats snapshot guard smoke: ALL assertions PASS");
