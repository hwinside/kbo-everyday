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

test("news discussion is public (read/ensure/count), write is gated by CommentSheet login", () => {
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
  const commentSheet = readFileSync(
    new URL("../../src/components/community/CommentSheet.tsx", import.meta.url),
    "utf8",
  );

  // 인피드 버튼은 더 이상 관리자 전용이 아니다(전원 노출).
  assert.doesNotMatch(button, /<AdminOnly>/);

  // === 익명 CTA 회귀(삼순 blocker) ===
  // ensure(브릿지 생성/조회)는 공개다 — 로그인 게이트(isNewsDiscussion*)를 두면 비로그인
  // CTA 탭이 401/404→generic 실패로 끝나 CommentSheet의 LoginSheet에 도달하지 못한다.
  assert.doesNotMatch(ensureRoute, /isNewsDiscussion(User|Admin)/);
  assert.doesNotMatch(ensureRoute, /unauthorized/);
  // ensure 남용 방지는 rate-limit + 입력검증 + author=SYSTEM + 최초 metadata immutable 로 대체.
  assert.match(ensureRoute, /allowNewsDiscussionRequest/);
  assert.match(ensureRoute, /parseNewsDiscussionInput/);
  assert.match(ensureRoute, /author_id:\s*process\.env\.SYSTEM_USER_ID/);

  // 카운트는 공개 조회지만 rate-limit은 유지한다.
  assert.doesNotMatch(countsRoute, /isNewsDiscussion(User|Admin)/);
  assert.match(countsRoute, /allowNewsDiscussionRequest/);

  // 작성 게이트는 CommentSheet가 담당: 미로그인 작성 시도면 LoginSheet 노출.
  assert.match(commentSheet, /if \(!user\)\s*\{\s*setShowLogin\(true\)/);
  assert.match(button, /CommentSheet/);
});

test("carousel article opener is not on the comment sheet React ancestor", () => {
  const carousel = readFileSync(
    new URL("../../src/components/news/NewsCarousel.tsx", import.meta.url),
    "utf8",
  );
  const slide = carousel.slice(carousel.indexOf('role="group"'), carousel.indexOf("{/* ── 다크"));
  assert.doesNotMatch(slide, /onClick/);
  // 홈 카드 댓글수 조회는 admin 게이트 없이 전원 실행된다(공개 count).
  assert.doesNotMatch(carousel, /if \(!isAdmin\) return/);
  assert.doesNotMatch(carousel, /useIsAdmin/);
});

console.log(`news discussion smoke: ${passed} passed`);
