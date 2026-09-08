#!/usr/bin/env node
/** Real browser fixture smoke. SQL/RLS is verified separately, not mocked as PASS here. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { expect } from "@playwright/test";
import { HOME_POPULAR_IDS, HOME_LATEST_IDS, HOME_POPULAR_LINKS, installHomePopularFixture } from "./fixtures/home-popular-feed.mjs";

const base = process.env.BASE || "http://127.0.0.1:3061";
const roster = JSON.parse(readFileSync(new URL("../../src/lib/constants/players-roster.json", import.meta.url), "utf8"));
const ownPlayer = roster.find((player) => player.teamId === 1);
const otherPlayer = roster.find((player) => player.teamId === 2);
assert.ok(ownPlayer?.kboId && otherPlayer?.kboId, "current roster has LG and opposing-team fixtures");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const runtimeErrors = [];
  page.on("pageerror", (e) => runtimeErrors.push(e.message));
  const fixture = await installHomePopularFixture(page);
  const section = page.locator('section[data-home-community="popular"]');
  const latest = page.locator('section[data-home-community="latest"]');
  const links = section.locator(HOME_POPULAR_LINKS);
  async function assertActions(mode, label) {
    const owner = mode === "latest" ? latest : section;
    await owner.getByRole("button", { name: "새 글 올리기", exact: true }).waitFor();
    // A moved section can remount; retry the count assertions through that transition.
    await expect(page.getByRole("button", { name: "새 글 올리기", exact: true }), label + " write button once").toHaveCount(1, { timeout: 30000 });
    await expect(page.getByRole("link", { name: "커뮤니티 최신글 보기", exact: true }), label + " latest link once").toHaveCount(1, { timeout: 30000 });
    await expect(owner.getByRole("link", { name: "커뮤니티 최신글 보기", exact: true })).toHaveAttribute("href", "/community/all-posts", { timeout: 30000 });
  }
  async function setCommunityPreferences(order, latestVisible, popularVisible) {
    await page.evaluate(({ order, latestVisible, popularVisible }) => {
      localStorage.setItem("kbo-home-sections-order", JSON.stringify(order));
      localStorage.setItem("kbo-home-community-visible", latestVisible ? "1" : "0");
      localStorage.setItem("kbo-home-community-popular-visible", popularVisible ? "1" : "0");
      window.dispatchEvent(new Event("home-sections-pref-changed"));
    }, { order, latestVisible, popularVisible });
  }
  async function loadPopularFeed(navigate) {
    // The popular section is global even before favorite-team hydration.
    // Latest-team restoration is asserted independently below.
    const teamResponse = page.waitForResponse((response) => {
      if (!response.url().includes("/rpc/home_popular_posts") || response.status() !== 200) return false;
      const args = response.request().postDataJSON();
      return args?.p_team_slug === null && args.p_limit === 6 && args.p_exclude?.length === 0;
    }, { timeout: 30000 });
    await Promise.all([navigate(), teamResponse]);
    await section.getByRole("heading", { name: /최근 24시간 인기글$/ }).waitFor();
    await links.nth(4).waitFor();
  }
  await loadPopularFeed(() => page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 90000 }));
  await latest.locator(HOME_POPULAR_LINKS).nth(4).waitFor();
  const latestIds = () => latest.locator(HOME_POPULAR_LINKS).evaluateAll((items) => items.map((a) => Number(a.dataset.homePostId)));
  assert.deepEqual(await latestIds(), HOME_LATEST_IDS.slice(0, 5));
  const latestFirst = fixture.latestRequests.at(-1);
  assert.equal(latestFirst.p_limit, 6);
  assert.equal(latestFirst.p_team_slug, "lg");
  assert.equal(latestFirst.p_before_created_at, null);
  assert.equal(latestFirst.p_before_id, null);
  assert.equal(Object.hasOwn(latestFirst, "p_since"), false, "latest feed has no 7-day cutoff");
  assert.ok(latestFirst.p_other_kbo_ids.includes(String(otherPlayer.kboId)));
  await assertActions("popular", "C1 default order");
  assert.equal(await page.getByRole("link", { name: "전체글", exact: true }).count(), 2, "section header links remain independent");
  const latestMore = latest.getByRole("button", { name: "15개 더 보기" });
  fixture.latestRows.unshift({ ...fixture.latestRows[0], id: 9999, created_at: new Date().toISOString() });
  await latestMore.click();
  await latest.locator(HOME_POPULAR_LINKS).nth(19).waitFor();
  assert.deepEqual(await latestIds(), HOME_LATEST_IDS.slice(0, 20), "new insert must not enter older pages");
  assert.equal(fixture.latestRequests.at(-1).p_before_id, HOME_LATEST_IDS[4]);
  assert.equal(fixture.latestRequests.at(-1).p_limit, 16, "more still requests 15 rows plus peek");
  assert.equal(await links.count(), 5, "latest pagination leaves popular feed untouched");
  await latestMore.click();
  await latest.locator(HOME_POPULAR_LINKS).nth(34).waitFor();
  assert.deepEqual(await latestIds(), HOME_LATEST_IDS.slice(0, 35));
  await latestMore.click();
  await latest.locator(HOME_POPULAR_LINKS).nth(39).waitFor();
  assert.deepEqual(await latestIds(), HOME_LATEST_IDS);
  assert.equal(await latestMore.count(), 0);
  console.log("PASS L1/L2 latest 5→20→35→40, strict-team args, stable cursor, exhaustion, independent sections");
  const first = fixture.requests.at(-1);
  assert.equal(first.p_limit, 6);
  assert.deepEqual(first.p_exclude, []);
  const age = Date.now() - Date.parse(first.p_since);
  assert.ok(Math.abs(age - 86400000) < 60000, "24-hour window");
  assert.equal(first.p_team_slug, null, "popular feed ignores favorite-team scope");
  assert.deepEqual(first.p_other_kbo_ids, [], "popular feed includes other-team player scopes");
  assert.ok(!first.p_other_kbo_ids.includes(String(ownPlayer.kboId)), "LG roster ID remains eligible");
  console.log("PASS F1 actual RPC args: 24-hour window / limit 6 / no excluded ids");
  const ids = () => links.evaluateAll((items) => items.map((a) => Number(a.getAttribute("href").split("/").pop())));
  assert.deepEqual(await ids(), HOME_POPULAR_IDS.slice(0, 5));
  const more = section.getByRole("button", { name: "15개 더 보기" });
  assert.equal(await more.isEnabled(), true);
  console.log("PASS F2 exact first 5 post links (navigation links excluded)");
  await more.click();
  await links.nth(19).waitFor();
  const next = fixture.requests.at(-1);
  assert.equal(next.p_limit, 16);
  assert.deepEqual(next.p_exclude, HOME_POPULAR_IDS.slice(0, 5));
  assert.deepEqual(await ids(), HOME_POPULAR_IDS, "peek row 995 is not skipped or duplicated");
  assert.equal(await more.count(), 0, "exact exhaustion removes button");
  console.log("PASS F3 click → exact 20 ids / no missing peek / exhausted button hidden");
  fixture.fail = true;
  const before = fixture.requests.length;
  const response = page.waitForResponse((r) => r.url().includes("/rpc/home_popular_posts") && r.status() === 500);
  await page.reload({ waitUntil: "domcontentloaded" });
  await response;
  await section.waitFor({ state: "hidden" });
  await latest.locator(HOME_POPULAR_LINKS).nth(4).waitFor();
  await assertActions("latest", "C2 later section failed");
  assert.ok(fixture.requests.length > before, "failure request actually issued");
  console.log("PASS F4 actual RPC 500 → section hidden");
  fixture.fail = false;
  await loadPopularFeed(() => page.reload({ waitUntil: "domcontentloaded" }));
  assert.deepEqual(await ids(), HOME_POPULAR_IDS.slice(0, 5));
  await latest.locator(HOME_POPULAR_LINKS).nth(4).waitFor();
  assert.deepEqual(await latestIds(), [9999, ...HOME_LATEST_IDS.slice(0, 4)], "reload picks up the new latest post");
  console.log("PASS F5 reload recovery / no browser runtime errors");
  await assertActions("popular", "C3 recovered later section");
  await setCommunityPreferences(["communityPopular", "news", "communityLatest"], true, true);
  // Existing home behavior remounts moved sections and may fetch their first page again.
  // Assert the settled order/rows/actions, not a zero-refetch contract.
  await expect(page.locator("section[data-home-community]").last()).toHaveAttribute("data-home-community", "latest", { timeout: 30000 });
  await latest.locator(HOME_POPULAR_LINKS).nth(4).waitFor();
  await assertActions("latest", "C4 reversed order with another section between");
  await setCommunityPreferences(["communityPopular", "communityLatest"], false, true);
  await latest.waitFor({ state: "hidden" });
  await assertActions("popular", "C5 latest hidden");
  await setCommunityPreferences(["communityPopular", "communityLatest"], true, false);
  await section.waitFor({ state: "hidden" });
  await assertActions("latest", "C6 popular hidden");
  await setCommunityPreferences(["communityPopular", "communityLatest"], false, false);
  await latest.waitFor({ state: "hidden" });
  await section.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "새 글 올리기", exact: true }).count(), 0, "C7 both hidden: no detached actions");
  assert.equal(await page.getByRole("link", { name: "커뮤니티 최신글 보기", exact: true }).count(), 0);
  fixture.latestRows.length = 0;
  await setCommunityPreferences(["communityPopular", "communityLatest"], true, true);
  await loadPopularFeed(() => page.reload({ waitUntil: "domcontentloaded" }));
  await latest.waitFor({ state: "hidden" });
  await assertActions("popular", "C8 last configured section empty");
  assert.deepEqual(runtimeErrors, []);
  console.log("PASS C1-C8 shared actions once: order/toggles/error/empty, header links preserved");
} finally {
  await browser.close();
}
