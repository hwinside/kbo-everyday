/**
 * 콘텐츠 조회수(숏츠·뉴스) 정책 스모크 — 2026-08-14.
 * 순수 정책(policy.ts) 판정 + dedup 계약 검증. 실행: npm run qa:content-views
 */
import { strict as assert } from "node:assert";
import {
  CONTENT_ID_MAX_LENGTH,
  contentViewKey,
  isContentViewType,
  isValidContentId,
  newsContentId,
  shouldCountShortsView,
} from "../../src/lib/content-views/policy";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

check("type 판정: shorts/news만 허용", () => {
  assert.equal(isContentViewType("shorts"), true);
  assert.equal(isContentViewType("news"), true);
  assert.equal(isContentViewType("post"), false);
  assert.equal(isContentViewType(""), false);
  assert.equal(isContentViewType(undefined), false);
  assert.equal(isContentViewType(1), false);
});

check("content_id 유효성: 1..512자", () => {
  assert.equal(isValidContentId("abc"), true);
  assert.equal(isValidContentId(""), false);
  assert.equal(isValidContentId(null), false);
  assert.equal(isValidContentId(3), false);
  assert.equal(isValidContentId("x".repeat(CONTENT_ID_MAX_LENGTH)), true);
  assert.equal(isValidContentId("x".repeat(CONTENT_ID_MAX_LENGTH + 1)), false);
});

check("뉴스 content_id: canonical(원문) 우선, 없으면 클릭 타깃", () => {
  assert.equal(
    newsContentId("https://n.news.naver.com/a", "https://press.example/b"),
    "https://press.example/b",
  );
  assert.equal(newsContentId("https://n.news.naver.com/a", null), "https://n.news.naver.com/a");
  assert.equal(newsContentId("https://n.news.naver.com/a", undefined), "https://n.news.naver.com/a");
});

check("뉴스 content_id: 무효 URL은 null (플레이스홀더 '#' 포함)", () => {
  assert.equal(newsContentId("#"), null);
  assert.equal(newsContentId(""), null);
});

check("뉴스 content_id: 512자 초과는 절단 (DB CHECK 정합)", () => {
  const long = "https://example.com/" + "a".repeat(600);
  const id = newsContentId(long);
  assert.equal(id?.length, CONTENT_ID_MAX_LENGTH);
  assert.equal(isValidContentId(id), true);
});

check("숏츠 세션 dedup: 처음이면 집계, 같은 세션 재노출이면 미집계", () => {
  const seen = new Set<string>();
  assert.equal(shouldCountShortsView(seen, "vid123"), true);
  seen.add(contentViewKey("shorts", "vid123"));
  assert.equal(shouldCountShortsView(seen, "vid123"), false);
  assert.equal(shouldCountShortsView(seen, "vid456"), true);
});

check("숏츠 세션 dedup: 무효 id는 집계 대상 아님", () => {
  assert.equal(shouldCountShortsView(new Set(), ""), false);
});

check("counts 키 형식: `<type>:<id>`", () => {
  assert.equal(contentViewKey("shorts", "vid123"), "shorts:vid123");
  assert.equal(contentViewKey("news", "https://a.b/c"), "news:https://a.b/c");
});

// ── 서명 계약 (삼순 blocker3: 임의 content_id 차단) ──
// 서명 비밀은 서버 env에서 유도 — 스모크용 가짜 값 주입 후 import(CJS 변환 환경이라 top-level await 불가).
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "smoke-secret";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { signContentView, verifyContentViewToken } = require("../../src/lib/content-views/sign") as typeof import("../../src/lib/content-views/sign");

check("서명 라운드트립: 발급 토큰은 검증 통과", () => {
  const token = signContentView("shorts", "vid123");
  assert.ok(token && token.length === 32);
  assert.equal(verifyContentViewToken("shorts", "vid123", token), true);
});

check("서명 거부: 다른 id/type/위조·비문자열 토큰은 거부", () => {
  const token = signContentView("shorts", "vid123")!;
  assert.equal(verifyContentViewToken("shorts", "vid999", token), false); // 다른 id
  assert.equal(verifyContentViewToken("news", "vid123", token), false); // 다른 type
  assert.equal(verifyContentViewToken("shorts", "vid123", "f".repeat(32)), false); // 위조
  assert.equal(verifyContentViewToken("shorts", "vid123", undefined), false);
  assert.equal(verifyContentViewToken("shorts", "vid123", "short"), false); // 길이 불일치
});

check("서명 결정론: 같은 입력 → 같은 토큰 (캐시 응답에 담겨도 유효)", () => {
  assert.equal(signContentView("news", "https://a.b/c"), signContentView("news", "https://a.b/c"));
});

console.log(`\ncontent-views smoke: ${passed} PASS`);
