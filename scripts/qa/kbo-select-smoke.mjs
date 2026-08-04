/**
 * KBO 드롭다운(시즌·시리즈) 전환 계약 스모크.
 *
 * ── 배경(2026-08-04, 삼순 6차) ──
 * 페이지 순회는 fail-close 로 고쳤는데 select 전환은 양쪽 다 무확인 통과였다.
 *  - oracle: 16회 polling 동안 표가 안 바뀌어도 루프를 빠져나와 **이전 시즌 행**으로 진행
 *  - crawler: `waitForFunction` 타임아웃을 catch 한 뒤 고정 대기만 하고 진행
 * 이건 몇 행 유실이 아니라 데이터셋 전체가 다른 시즌이 되는 사고이고, 개수 가드로는
 * 절대 잡히지 않는다(2025 도 행 수는 정상이다).
 *
 * 계약:
 *  1) postback 유실(값 불변) → fail-close
 *  2) 지연 후 반영 → bounded 재시도로 회복
 *  3) 이미 목표 값이면 no-op
 *  4) 값은 맞는데 표가 그대로면 실패로 보지 않는다(다른 시즌이어도 첫 화면이 같을 수 있다)
 *  5) 실제 배선 — oracle·crawler 가 이 계약을 쓰는가
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectAndConfirm } from "../lib/kbo-select.mjs";

/**
 * @param {object} opts
 * @param {number} opts.lostClicks 앞의 N회 select 를 통째로 흘린다(postback 유실)
 * @param {boolean} opts.neverApplies 영구히 반영되지 않는다
 * @param {boolean} opts.tableFrozen 값은 바뀌지만 표는 그대로
 */
function makeIo({ initial = "2025", lostClicks = 0, neverApplies = false, tableFrozen = false } = {}) {
  let value = initial;
  let lost = lostClicks;
  const calls = { select: 0, reads: 0 };
  return {
    calls,
    get value() { return value; },
    async readValue() { calls.reads++; return value; },
    async select(next) {
      calls.select++;
      if (neverApplies) return;
      if (lost > 0) { lost--; return; }
      value = String(next);
    },
    async tableSignature() { return tableFrozen ? "FROZEN" : `rows-${value}`; },
    async sleep() {},
  };
}

/* 1) postback 유실(영구) → fail-close */
{
  const io = makeIo({ neverApplies: true });
  await assert.rejects(
    () => selectAndConfirm(io, "2026", { label: "시즌", polls: 3 }),
    /source_season_transition_incomplete/,
    "select 가 끝내 반영되지 않으면 이전 시즌 데이터로 진행하면 안 된다",
  );
  assert.equal(io.value, "2025", "실패 시 값은 그대로여야 한다");
}

/* 2) 일시 유실 → bounded 재시도로 회복 */
{
  const io = makeIo({ lostClicks: 2 });
  const result = await selectAndConfirm(io, "2026", { label: "시즌", polls: 2, attempts: 3 });
  assert.equal(io.value, "2026", "재시도로 목표 시즌이 적용돼야 한다");
  assert.equal(result.changed, true);
  assert.ok(io.calls.select >= 3, "유실된 만큼 재클릭해야 한다");
}

/* 3) 이미 목표 값이면 no-op */
{
  const io = makeIo({ initial: "2026" });
  const result = await selectAndConfirm(io, "2026", { label: "시즌" });
  assert.equal(result.changed, false);
  assert.equal(io.calls.select, 0, "이미 목표 값이면 건드리지 않는다");
}

/* 4) 값은 target 인데 표가 그대로 → **실패**여야 한다 (삼순 8차 지적)
 *
 * ⚠︎ Playwright `selectOption()` 은 서버 postback 이 끝나기 전에 이미 DOM select 값을
 * target 으로 바꾼다. 그래서 postback/표 갱신이 유실되면 "selector 는 2026 인데 표는 2025"
 * 상태가 실제로 만들어진다. 종전 스모크는 이 fail-open 을 정답으로 고정하고 있었다.
 * 전환이 필요했던 경우에는 값 + 표 교체가 둘 다 성공 조건이다. */
{
  const io = makeIo({ tableFrozen: true });
  await assert.rejects(
    () => selectAndConfirm(io, "2026", { label: "시즌", polls: 2, attempts: 2 }),
    /source_season_transition_incomplete/,
    "selector 값만 바뀌고 표가 그대로면 지난 조건 데이터를 정본으로 읽는다 — 통과시키면 안 된다",
  );
}

/* 5) 재시도 상한을 실제로 지키는가(무한 루프 방지) */
{
  const io = makeIo({ neverApplies: true });
  await assert.rejects(() => selectAndConfirm(io, "2026", { attempts: 2, polls: 2 }), /source_season_transition_incomplete/);
  assert.equal(io.calls.select, 2, "attempts 만큼만 시도해야 한다");
}

/* 6) oracle 행동 검증 — postback 유실 시 실제로 던지는가 ──────────
 *
 * ⚠︎ 문자열 배선 검사만으로는 `if (false) await selectAndConfirm(...)` 같은 위장을
 * 못 잡는다(mutation 으로 확인한 실제 false-green). 가짜 page 로 직접 태운다.
 * 이건 단순 배선 문제가 아니라, 통과하면 **2025 데이터가 2026 원본으로 쓰인다**. */
{
  const { collectKboPages } = await import("../lib/stats-source-truth.mjs");
  const SEASON_SELECTOR = "#cphContents_cphContents_cphContents_ddlSeason_ddlSeason";
  const rowsOf = (season) =>
    Array.from({ length: 3 }, (_, i) => ({
      texts: ["1", `${season}선수${i}`, "TT"],
      hrefs: ["", `?playerId=${season === "2025" ? 70000 + i : 90000 + i}`],
    }));

  const makePage = ({ postbackLost }) => {
    let current = "2025";
    return {
      async goto() {},
      async $(sel) { return sel === SEASON_SELECTOR ? {} : null; },
      async $eval(sel) { return sel === SEASON_SELECTOR ? current : null; },
      async selectOption(sel, value) {
        if (sel === SEASON_SELECTOR && !postbackLost) current = String(value);
      },
      async $$eval(sel) {
        if (sel === "tbody tr") return rowsOf(current);
        if (sel === 'a[id*="ucPager_btnNo"]') return "1:";
        return "";
      },
      locator() {
        return { filter: () => ({ first: () => ({ async count() { return 0; }, async click() {} }) }) };
      },
      async waitForLoadState() {}, async waitForTimeout() {}, async close() {},
    };
  };

  const ok = await collectKboPages(makePage({ postbackLost: false }), "u", "2026");
  const okNames = [...ok.values()].map((t) => t[1]);
  assert.ok(
    okNames.every((n) => n.startsWith("2026")),
    `정상 경로는 목표 시즌 행을 읽어야 한다 (actual: ${okNames[0]})`,
  );

  await assert.rejects(
    () => collectKboPages(makePage({ postbackLost: true }), "u", "2026"),
    /source_season_transition_incomplete/,
    "oracle 은 시즌 전환 미확인 시 OLD-SEASON 행을 반환하면 안 된다",
  );
}

/* 7) crawler 행동 검증 — selectSeason·sortTable 을 직접 태운다 ────────
 *
 * ⚠︎ MUT-5/6(`if (false) await selectAndConfirm(...)`, sort throw 제거)이 문자열 검사만으로는
 * GREEN 이었다. 실제 함수를 import 해 가짜 page 로 돌린다. */
{
  // crawl-stats 는 SEASON 을 process.argv 에서 읽는다. fake 초기값(2025)과 달라야
  // 전환 경로가 실제로 실행되므로, import 전에 인자를 심는다.
  const argvBackup = process.argv.slice();
  process.argv = [...argvBackup.slice(0, 2), "--season", "2026"];
  const { selectSeason, sortTable } = await import("../crawl-stats.mjs");
  process.argv = argvBackup;

  const makePage = ({ seasonLost = false, sortLost = false } = {}) => {
    let season = "2025";
    let series = "1";
    let sortKey = "ERA_RT";
    // 실제 KBO 는 series/season/sort 어느 postback 이든 표를 재렌더한다.
    // fake 가 series 를 표에 반영하지 않으면, 강화된 "값+표 교체" 계약에서
    // 정상 경로가 false RED 가 된다(모델이 현실과 달라서 나는 실패).
    const rows = () => [{
      texts: ["1", `${season}/${series}/${sortKey}`, "TT"],
      hrefs: ["", "?playerId=90001"],
    }];
    return {
      async $(sel) {
        if (sel.includes("ddlSeries")) return {};
        if (sel.includes("ddlSeason")) return {};
        if (sel.startsWith("a[href=")) {
          const key = sel.match(/sort\('([^']+)'\)/)?.[1];
          return { async click() { if (!sortLost) sortKey = key; } };
        }
        return null;
      },
      async $eval(sel) {
        if (sel.includes("ddlSeries")) return series;
        if (sel.includes("ddlSeason")) return season;
        return null;
      },
      async selectOption(sel, value) {
        if (sel.includes("ddlSeries")) { series = String(value); return; }
        if (sel.includes("ddlSeason") && !seasonLost) season = String(value);
      },
      async $$eval(sel) {
        if (sel === "tbody tr") return rows();
        return "";
      },
      locator() {
        return { filter: () => ({ first: () => ({ async count() { return 0; }, async click() {} }) }) };
      },
      async waitForLoadState() {}, async waitForTimeout() {},
    };
  };

  // 정상 경로는 통과해야 한다(과도한 fail-close 로 매일 크롤을 막으면 안 된다).
  await selectSeason(makePage());
  await sortTable(makePage(), "GAME_CN", { attempts: 2, polls: 2 });

  // 시즌 postback 유실 → fail-close
  await assert.rejects(
    () => selectSeason(makePage({ seasonLost: true })),
    /source_season_transition_incomplete/,
    "crawler 도 시즌 전환 미확인 시 이전 시즌으로 크롤하면 안 된다",
  );

  // 정렬 미적용 → fail-close (GAME_CN 정렬이 안 먹으면 규정이닝 투수만 남는다)
  await assert.rejects(
    () => sortTable(makePage({ sortLost: true }), "GAME_CN", { attempts: 2, polls: 2 }),
    /sort_change_failed/,
    "정렬이 적용되지 않으면 대상 집합이 통째로 바뀌므로 fail-close 여야 한다",
  );
}

/* 8) 실제 배선 — oracle 과 crawler 가 이 계약을 쓰는가 ─────────────
 * 라이브러리가 옳아도 호출부가 옛 무확인 경로면 사고는 그대로다. */
{
  const oracle = readFileSync("scripts/lib/stats-source-truth.mjs", "utf8");
  assert.ok(
    /selectAndConfirm\(/.test(oracle),
    "oracle 은 확인된 시즌 전환(selectAndConfirm)을 써야 한다",
  );
  assert.ok(
    !/for \(let i = 0; i < 16; i\+\+\)/.test(oracle),
    "oracle 에 무확인 polling 루프가 남아 있으면 안 된다",
  );

  const crawler = readFileSync("scripts/crawl-stats.mjs", "utf8");
  assert.ok(
    /selectAndConfirm\(/.test(crawler),
    "crawler 도 같은 계약을 써야 한다",
  );
  // 타임아웃을 삼키고 고정 대기로 넘어가는 옛 경로가 남으면 안 된다.
  assert.ok(
    !/catch\s*\{\s*await page\.waitForTimeout\(waitMs\);/.test(crawler),
    "crawler 에 타임아웃 무시 후 진행하는 옛 경로가 남아 있으면 안 된다",
  );
  assert.ok(
    !/waitForFunction\(/.test(crawler),
    "crawler 가 자체 대기 로직을 다시 들면 계약이 갈라진다",
  );
  // 표 읽기도 공용 adapter 로 통일돼야 한다(중복 구현 = 계약 갈라짐).
  assert.ok(
    !/async function scrapeTable\(page\)/.test(crawler),
    "crawler 가 자체 scrapeTable 을 다시 가지면 안 된다",
  );
  // 정렬 전환도 같은 결손이었다 — GAME_CN 정렬이 안 먹히면 규정이닝 투수만 남는다.
  assert.ok(
    /sort_change_failed/.test(crawler),
    "정렬 전환도 미적용이면 fail-close 해야 한다",
  );
}

console.log("kbo select smoke: ALL assertions PASS");
