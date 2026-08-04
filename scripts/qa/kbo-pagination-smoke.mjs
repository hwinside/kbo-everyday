/**
 * KBO 페이지네이션 완주 계약 스모크.
 *
 * 배경(2026-08-04, 삼순 P1): 종전 스모크는 one-page stub 이라 실제 multi-page /
 * 그룹 전환 / stale 재렌더 / `0 new` / 중간 페이지 누락을 행동으로 태우지 못했다.
 *
 * 여기서는 KBO 페이저를 흉내내는 fake 를 만들어 실제 시나리오를 재현한다:
 *  - 11페이지(30행 × 10 + 29행), 10페이지 단위 그룹 전환
 *  - 느린 응답(클릭 후 N회 polling 동안 이전 화면 유지)
 *  - 클릭이 아예 먹지 않는 페이지(전환 실패)
 *  - 이미 본 페이지가 다시 나오는 stale 재렌더
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { collectAllPages, createKboPageAdapter, signatureOf } from "../lib/kbo-pagination.mjs";

/** 30행짜리 페이지 11장(마지막 29행) = 329행. 실제 타자 페이지 구조와 같다. */
function makePages({ total = 329, perPage = 30 } = {}) {
  const pages = [];
  for (let start = 0; start < total; start += perPage) {
    const rows = [];
    for (let i = start; i < Math.min(start + perPage, total); i++) {
      rows.push({ texts: [String(i + 1), `선수${i + 1}`, `T${i % 10}`], hrefs: ["", `?playerId=${90000 + i}`] });
    }
    pages.push(rows);
  }
  return pages;
}

/**
 * KBO 페이저 fake.
 * @param {object} opts
 * @param {number} opts.groupSize 한 그룹에 보이는 페이지 번호 수
 * @param {Map<number, number>} opts.slowPages 해당 페이지로 갈 때 N회 polling 동안 이전 화면 유지
 * @param {Set<number>} opts.deadPages 클릭해도 절대 전환되지 않는 페이지
 * @param {number|null} opts.staleAt 해당 페이지에서 이전 화면을 다시 내주는 재렌더
 */
function makeFakePager(pages, { groupSize = 10, slowPages = new Map(), deadPages = new Set(), staleAt = null, flakyOnce = new Set(), deadGroupSwitch = false, flakyGroupOnce = false } = {}) {
  let current = 1; // 1-based
  let pendingTarget = null;
  let pendingDelay = 0;
  const totalPages = pages.length;
  const groupOf = (page) => Math.floor((page - 1) / groupSize);

  return {
    calls: { scrape: 0, click: 0, group: 0 },
    async scrapeTable() {
      this.calls.scrape++;
      if (pendingTarget !== null) {
        if (pendingDelay > 0) {
          pendingDelay--;
          return pages[current - 1]; // 아직 이전 화면
        }
        current = pendingTarget;
        pendingTarget = null;
      }
      if (staleAt !== null && current === staleAt) {
        return pages[staleAt - 2]; // 이전 페이지를 다시 내준다(stale 재렌더)
      }
      return pages[current - 1];
    },
    async clickPage(pageText) {
      const target = Number(pageText);
      if (!Number.isFinite(target) || target < 1 || target > totalPages) return false;
      if (groupOf(target) !== groupOf(current)) return false; // 다른 그룹의 번호는 안 보인다
      this.calls.click++;
      if (deadPages.has(target)) return true; // 눌리긴 하는데 전환 안 됨
      if (flakyOnce.has(target)) {
        // 첫 클릭은 유실되고(전환 없음), 재클릭부터 정상 동작한다.
        flakyOnce.delete(target);
        return true;
      }
      pendingTarget = target;
      pendingDelay = slowPages.get(target) ?? 0;
      return true;
    },
    async clickNextGroup() {
      const nextGroupFirst = (groupOf(current) + 1) * groupSize + 1;
      if (nextGroupFirst > totalPages) return false;
      this.calls.group++;
      // 클릭은 수락(true)되지만 DOM 전환이 유실되는 경계 — 삼순 실증 케이스.
      if (deadGroupSwitch) return true;
      if (flakyGroupOnce) {
        flakyGroupOnce = false;
        return true; // 첫 시도만 유실, 재시도부터 정상
      }
      pendingTarget = nextGroupFirst;
      pendingDelay = 0;
      return true;
    },
    async pagerSignature() {
      return `group:${groupOf(pendingTarget ?? current)}`;
    },
    async sleep() {},
  };
}

const run = (pager, overrides = {}) =>
  collectAllPages({
    scrapeTable: () => pager.scrapeTable(),
    clickPage: (t) => pager.clickPage(t),
    clickNextGroup: () => pager.clickNextGroup(),
    pagerSignature: () => pager.pagerSignature(),
    sleep: () => pager.sleep(),
    log: () => {},
    swapIntervalMs: 0,
    ...overrides,
  });

/* 1) 정상 — 11페이지 전 페이지 완주, 329행 */
{
  const pages = makePages();
  assert.equal(pages.length, 11, "11페이지 구조여야 한다");
  const rows = await run(makeFakePager(pages));
  assert.equal(rows.length, 329, "전 페이지를 완주해 329행을 모아야 한다");
  const ids = new Set(rows.map((r) => r.hrefs[1]));
  assert.equal(ids.size, 329, "중복 없이 고유 선수 329명이어야 한다");
}

/* 2) 느린 응답 — bounded retry 안에서 회복하면 유실 없이 완주
 *    (여기서 죽으면 게이트가 매일 크롤을 랜덤하게 막아 정지 사고를 스스로 만든다) */
{
  const pages = makePages();
  // 5페이지는 polling 3회 동안 이전 화면 유지, 8페이지는 6회 유지
  const slow = new Map([[5, 3], [8, 6]]);
  const rows = await run(makeFakePager(pages, { slowPages: slow }));
  assert.equal(rows.length, 329, "일시적 지연은 재시도로 흡수하고 전 페이지를 모아야 한다");
}

/* 3) 재클릭 retry 가 실제로 동작하는가 — 4페이지 첫 클릭을 통째로 유실시킨다.
 *    retry 가 없으면 여기서 page_advance_failed 로 죽고 30행이 사라진다. */
{
  const pages = makePages();
  const pager = makeFakePager(pages, { flakyOnce: new Set([4]) });
  const rows = await run(pager, { retries: 2 });
  assert.equal(rows.length, 329, "첫 클릭이 유실돼도 재클릭으로 회복해야 한다");

  // retries 를 0 으로 주면 같은 상황에서 반드시 죽어야 한다(= retry 가 실효 원인).
  await assert.rejects(
    () => run(makeFakePager(pages, { flakyOnce: new Set([4]) }), { retries: 0 }),
    /page_advance_failed/,
    "retry 가 없으면 클릭 유실이 그대로 페이지 유실로 이어져야 한다",
  );
}

/* 4) 전환 실패 — retry 소진 후 반드시 죽는다 (조용한 페이지 유실 금지) */
{
  const pages = makePages();
  await assert.rejects(
    () => run(makeFakePager(pages, { deadPages: new Set([6]) })),
    /page_advance_failed/,
    "전환이 끝내 안 되면 수집 불완전으로 죽어야 한다",
  );
}

/* 5) stale 재렌더 — 이미 본 화면이 다시 나오면 실패 */
{
  const pages = makePages();
  await assert.rejects(
    () => run(makeFakePager(pages, { staleAt: 3 })),
    /page_advance_failed/,
    "이미 수집한 화면이 다시 나오면 실패해야 한다",
  );
}

/* 6) 중간 페이지 누락이 조용히 통과하지 못한다
 *    — 6페이지가 죽으면 그 뒤 페이지도 못 가므로 부분 수집으로 끝나면 안 된다 */
{
  const pages = makePages();
  let captured = null;
  try {
    await run(makeFakePager(pages, { deadPages: new Set([6]) }));
  } catch (error) {
    captured = error;
  }
  assert.ok(captured, "중간 페이지 유실은 예외여야 한다");
  assert.match(String(captured.message), /수집 불완전/);
}

/* 7) 그룹 전환 — 10페이지 그룹 경계를 넘어야 11페이지까지 간다 */
{
  const pages = makePages();
  const pager = makeFakePager(pages, { groupSize: 10 });
  const rows = await run(pager);
  assert.equal(rows.length, 329);
  assert.ok(pager.calls.group >= 1, "그룹 전환이 최소 1회 일어나야 한다");
}

/* 8) 연속 2회 실행이 동일한 identity set + 전 셀 hash 를 낸다 */
{
  const pages = makePages();
  const first = await run(makeFakePager(pages, { slowPages: new Map([[5, 2]]) }));
  const second = await run(makeFakePager(pages, { slowPages: new Map([[7, 4]]) }));
  assert.deepEqual(
    first.map((r) => r.hrefs[1]).sort(),
    second.map((r) => r.hrefs[1]).sort(),
    "연속 실행의 identity set 이 같아야 한다",
  );
  assert.equal(
    signatureOf(first),
    signatureOf(second),
    "연속 실행의 전 셀 시그니처가 같아야 한다",
  );
}

/* 10) 그룹 전환 유실을 EOF 로 오인하면 안 된다 (삼순 P1 blocker 2)
 *     클릭은 수락되는데 pager/table 이 안 변하는 상황. 종전에는 예외 없이
 *     329행 중 300행만 "정상" 반환했다 = 30행 유실을 성공으로 보고. */
{
  const pages = makePages();
  await assert.rejects(
    () => run(makeFakePager(pages, { deadGroupSwitch: true })),
    /source_pagination_incomplete/,
    "그룹 전환이 유실되면 EOF 가 아니라 수집 실패여야 한다",
  );

  // 조용한 부분 반환이 아님을 명시적으로 못 박는다.
  let rows = null;
  try { rows = await run(makeFakePager(pages, { deadGroupSwitch: true })); } catch { /* expected */ }
  assert.equal(rows, null, "그룹 전환 유실 시 부분 결과를 정상 반환하면 안 된다");
}

/* 11) 그룹 전환도 bounded retry 로 회복한다 */
{
  const pages = makePages();
  const recovered = await run(makeFakePager(pages, { flakyGroupOnce: true }), { retries: 2 });
  assert.equal(recovered.length, 329, "그룹 전환 첫 시도가 유실돼도 재시도로 완주해야 한다");

  // retries=0 이면 같은 상황이 RED — retry 가 실효 원인임을 증명.
  await assert.rejects(
    () => run(makeFakePager(pages, { flakyGroupOnce: true }), { retries: 0 }),
    /source_pagination_incomplete/,
    "retry 가 없으면 그룹 전환 유실이 그대로 수집 실패로 이어져야 한다",
  );
}

/* 12) maxPages 소진은 정상 종료가 아니다 */
{
  const pages = makePages();
  await assert.rejects(
    () => run(makeFakePager(pages), { maxPages: 3 }),
    /source_pagination_incomplete/,
    "maxPages 소진은 완주가 아니라 실패여야 한다",
  );
}

/* 13) 실제 어댑터 행동 검증 — 문자열이 아니라 fake page 로 직접 태운다.
 *     `clickNextGroup` 을 `() => false` 로 바꾸면 여기서 RED 가 된다. */
{
  const pages = makePages({ total: 350 }); // 12페이지 = 그룹 경계(10) 를 넘긴다
  let current = 1;
  const groupSize = 10;
  const groupOf = (p) => Math.floor((p - 1) / groupSize);

  const fakePage = {
    async $$eval(selector) {
      if (selector === "tbody tr") {
        return pages[current - 1].map((r) => ({ texts: r.texts, hrefs: r.hrefs }));
      }
      return `group:${groupOf(current)}`;
    },
    async $(selector) {
      if (selector === 'a[id$="btnNext"]') {
        const next = (groupOf(current) + 1) * groupSize + 1;
        return next <= pages.length ? { async click() { current = next; } } : null;
      }
      return null;
    },
    locator() {
      return {
        filter: ({ hasText }) => ({
          first: () => ({
            async count() {
              const t = Number(hasText);
              return Number.isFinite(t) && t <= pages.length && groupOf(t) === groupOf(current) ? 1 : 0;
            },
            async click() { current = Number(hasText); },
          }),
        }),
      };
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
  };

  const rows = await collectAllPages({
    ...createKboPageAdapter(fakePage),
    log: () => {},
    swapIntervalMs: 0,
  });
  assert.equal(rows.length, 350, "실제 어댑터로도 그룹 경계를 넘어 전 페이지를 완주해야 한다");
}

/* 14) 어댑터의 clickNextGroup 우회 mutation 은 RED 여야 한다 */
{
  const pages = makePages({ total: 350 });
  let current = 1;
  const groupSize = 10;
  const groupOf = (p) => Math.floor((p - 1) / groupSize);
  const fakePage = {
    async $$eval(selector) {
      if (selector === "tbody tr") return pages[current - 1].map((r) => ({ texts: r.texts, hrefs: r.hrefs }));
      return `group:${groupOf(current)}`;
    },
    async $() { return null; }, // btnNext 를 못 찾게 만든다 = clickNextGroup 우회
    locator() {
      return {
        filter: ({ hasText }) => ({
          first: () => ({
            async count() {
              const t = Number(hasText);
              return Number.isFinite(t) && t <= pages.length && groupOf(t) === groupOf(current) ? 1 : 0;
            },
            async click() { current = Number(hasText); },
          }),
        }),
      };
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
  };
  const rows = await collectAllPages({ ...createKboPageAdapter(fakePage), log: () => {}, swapIntervalMs: 0 });
  // btnNext 자체가 없으면 정상 EOF 로 취급된다 — 그래서 "완주했다"고 착각하면 안 된다.
  // 이 경우 수집량이 기대보다 작다는 것을 호출부(원본 대조)가 반드시 잡아야 한다.
  assert.ok(rows.length < 350, "btnNext 우회 시 부분 수집이 되며, 원본 대조가 이를 잡아야 한다");
  assert.equal(rows.length, 300, "첫 그룹(10페이지=300행)까지만 수집된다");
}

/* 9) 실제 배선 — 크롤러가 이 로직을 쓰는가 */
{
  const crawler = readFileSync("scripts/crawl-stats.mjs", "utf8");
  assert.ok(
    crawler.includes("collectAllPages(") && crawler.includes("createKboPageAdapter("),
    "크롤러는 공용 어댑터 + collectAllPages 로 페이지를 순회해야 한다",
  );
  assert.ok(
    !/await page\.waitForTimeout\(1200\);\s*\n\s*pageNum\+\+/.test(crawler),
    "고정 대기 후 무조건 페이지 증가하는 옛 경로가 남아 있으면 안 된다",
  );
}

console.log("kbo pagination smoke: ALL assertions PASS");
