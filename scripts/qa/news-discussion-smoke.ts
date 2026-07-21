import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  articleKeyForUrl,
  mapDiscussionCounts,
  normalizeArticleUrl,
  parseCountLookups,
  parseNewsDiscussionInput,
} from "../../src/lib/news/discussion";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

test("tracking params, fragment and trailing slash are removed", () => {
  assert.equal(
    normalizeArticleUrl("HTTPS://Example.COM/news/1/?utm_source=x&b=2&a=1#reply"),
    "https://example.com/news/1?a=1&b=2",
  );
});

test("canonical URL creates a stable key across click URL variants", () => {
  const first = parseNewsDiscussionInput({
    url: "https://m.sports.naver.com/article/001/123?utm_source=home",
    canonicalUrl: "https://press.example.com/kbo/123?utm_medium=feed",
    title: "기사",
    teamId: 1,
  });
  const second = parseNewsDiscussionInput({
    url: "https://sports.naver.com/article/001/123",
    canonicalUrl: "https://PRESS.example.com/kbo/123#top",
    title: "기사 수정",
    teamId: 1,
  });
  assert.equal(first.articleKey, second.articleKey);
  assert.equal(first.articleKey, articleKeyForUrl("https://press.example.com/kbo/123"));
});

test("invalid protocols and team ids fail closed", () => {
  assert.throws(() => parseNewsDiscussionInput({ url: "javascript:alert(1)", title: "x" }));
  assert.throws(() => parseNewsDiscussionInput({ url: "https://example.com/a", title: "x", teamId: 11 }));
});

test("count lookup caps at ten and requires unique ids", () => {
  const articles = Array.from({ length: 10 }, (_, i) => ({ lookupId: String(i), url: `https://example.com/${i}` }));
  assert.equal(parseCountLookups({ articles }).length, 10);
  assert.throws(() => parseCountLookups({ articles: [...articles, { lookupId: "11", url: "https://example.com/11" }] }));
  assert.throws(() => parseCountLookups({ articles: [articles[0], articles[0]] }));
});

test("batch counts preserve lookup ids and default missing discussions to zero", () => {
  const lookups = parseCountLookups({
    articles: [
      { lookupId: "home-1", url: "https://example.com/1" },
      { lookupId: "home-2", url: "https://example.com/2" },
    ],
  });
  const counts = mapDiscussionCounts(lookups, [
    { article_key: lookups[0].articleKey, visible_comment_count: 7 },
  ]);
  assert.deepEqual(counts, { "home-1": 7, "home-2": 0 });
});

test("batch counts use visible rows and accept bigint strings", () => {
  const lookups = parseCountLookups({
    articles: [{ lookupId: "home-1", url: "https://example.com/1" }],
  });
  const counts = mapDiscussionCounts(lookups, [
    { article_key: lookups[0].articleKey, visible_comment_count: "0" },
  ]);
  assert.deepEqual(counts, { "home-1": 0 });
});

test("existing ensure path cannot update stored metadata", () => {
  const route = readFileSync(new URL("../../src/app/api/news/discussion/route.ts", import.meta.url), "utf8");
  const existingBranch = route.slice(route.indexOf("if (existing)"), route.indexOf("const { data: bridge"));
  assert.doesNotMatch(existingBranch, /\.update\s*\(/);
});

test("report sheet stays above the comment sheet stacking layer", () => {
  const reportSheet = readFileSync(new URL("../../src/components/community/ReportSheet.tsx", import.meta.url), "utf8");
  assert.match(reportSheet, /z-\[10000\]/);
});

test("visible count SQL excludes blinded comments", () => {
  const migration = readFileSync(
    new URL("../../supabase/migrations/20260721_news_article_discussions.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /c\.is_hidden IS DISTINCT FROM true/);
  assert.match(migration, /root\.id = c\.parent_id/);
  assert.match(migration, /root\.is_hidden IS DISTINCT FROM true/);
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION news_discussion_visible_counts\(text\[\]\)/);
});

test("discussion UI and APIs stay admin-only during production QA", () => {
  const button = readFileSync(
    new URL("../../src/components/news/NewsCommentButton.tsx", import.meta.url),
    "utf8",
  );
  const ensureRoute = readFileSync(
    new URL("../../src/app/api/news/discussion/route.ts", import.meta.url),
    "utf8",
  );
  const countsRoute = readFileSync(
    new URL("../../src/app/api/news/discussion/counts/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(button, /<AdminOnly>/);
  assert.match(ensureRoute, /isNewsDiscussionAdmin/);
  assert.match(countsRoute, /isNewsDiscussionAdmin/);
});

test("carousel article opener is not on the comment sheet React ancestor", () => {
  const carousel = readFileSync(
    new URL("../../src/components/news/NewsCarousel.tsx", import.meta.url),
    "utf8",
  );
  const slide = carousel.slice(carousel.indexOf('role="group"'), carousel.indexOf("{/* ── 다크"));
  assert.doesNotMatch(slide, /onClick/);
  assert.match(carousel, /if \(!isAdmin\) return/);
});

console.log(`news discussion smoke: ${passed} passed`);
