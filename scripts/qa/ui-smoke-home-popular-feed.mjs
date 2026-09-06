#!/usr/bin/env node
/** Real browser fixture smoke. SQL/RLS is verified separately, not mocked as PASS here. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { HOME_POPULAR_IDS, HOME_POPULAR_LINKS, installHomePopularFixture } from "./fixtures/home-popular-feed.mjs";

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
  await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 90000 });
  const section = page.locator("section").filter({ has: page.getByRole("heading", { name: /커뮤니티 인기글/ }) });
  const links = section.locator(HOME_POPULAR_LINKS);
  await links.nth(4).waitFor();
  const first = fixture.requests.at(-1);
  assert.equal(first.p_limit, 6);
  assert.deepEqual(first.p_exclude, []);
  const age = Date.now() - Date.parse(first.p_since);
  assert.ok(Math.abs(age - 7 * 86400000) < 60000, "7-day window");
  assert.equal(first.p_team_slug, "lg", "returning guest's favorite team");
  assert.ok(first.p_other_kbo_ids.includes(String(otherPlayer.kboId)), "opposing-team roster ID is excluded");
  assert.ok(!first.p_other_kbo_ids.includes(String(ownPlayer.kboId)), "LG roster ID remains eligible");
  console.log("PASS F1 actual RPC args: 7-day window / limit 6 / no excluded ids");
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
  assert.ok(fixture.requests.length > before, "failure request actually issued");
  console.log("PASS F4 actual RPC 500 → section hidden");
  fixture.fail = false;
  await page.reload({ waitUntil: "domcontentloaded" });
  await links.nth(4).waitFor();
  assert.deepEqual(await ids(), HOME_POPULAR_IDS.slice(0, 5));
  assert.deepEqual(runtimeErrors, []);
  console.log("PASS F5 reload recovery / no browser runtime errors");
} finally {
  await browser.close();
}
