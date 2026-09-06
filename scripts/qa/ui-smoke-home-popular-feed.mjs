#!/usr/bin/env node
/**
 * 홈 인기글 섹션 End-User 스모크 — page.route로 Supabase RPC 픽스처 주입 (삼순 #1343 ② CI 보완).
 *
 * 운영 DB 불필요: page.route("**\/rpc/home_popular_posts**")가 RPC 응답을 가로채 픽스처를 반환한다.
 *
 * 검증 항목:
 *  F1) RPC 인자 prefetch 변이 검출 — p_limit = want+1(확인행) 이 실제 네트워크 요청에 실림.
 *      리팩토링으로 확인행이 빠지면 이 체크가 RED.
 *  F2) 실제 글 렌더 — 픽스처 5건 렌더 후 '커뮤니티 인기글' 섹션·글 링크 5개 확인.
 *  F3) 더보기 RPC — '15개 더 보기' 클릭 → p_exclude 화면 5개·p_limit 16 확인 → 글 20개.
 *  F4) 미렌더 실패 — RPC 500 응답 → 섹션 숨김(빈 박스 없음).
 *
 * 실행: BASE=http://127.0.0.1:3000 node scripts/qa/ui-smoke-home-popular-feed.mjs
 * CI: npm run qa:ui:home-popular-feed  (dev 서버 기동 후)
 */
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const HOME_PATH = process.env.HOME_PATH || "/";

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function makePost(id, popularity) {
  return {
    id,
    author_id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    board_type: "team",
    board_id: "lg",
    content_type: "general",
    title: `인기글 ${id}`,
    content: "내용",
    image_urls: [],
    video_urls: [],
    like_count: popularity,
    comment_count: 0,
    created_at: "2026-09-04T00:00:00Z",
    is_hidden: false,
    game_id: null,
    player_tags: [],
    team_tags: ["lg"],
    hashtags: [],
    author_team_id_snapshot: 1,
    click_view_count: 0,
    impression_view_count: 0,
    popularity,
    profiles: { nickname: `user${id}`, team_id: 1, grade: "bronze", points: 0, avatar_url: null },
  };
}

/** 캡처된 RPC 요청 목록 */
const capturedRequests = [];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const runtimeErrors = [];
page.on("pageerror", (e) => runtimeErrors.push(e.message));

// ── F1/F2/F3: 5건(+확인행) 픽스처 → 실제 렌더 → 더보기 ──
let routePhase = "first"; // 첫 페이지: 5+1개 | 더보기: 15개
await page.route("**/rpc/home_popular_posts**", async (route) => {
  const req = route.request();
  const body = req.postDataJSON?.() ?? {};
  capturedRequests.push({ phase: routePhase, body });

  if (routePhase === "first") {
    const posts = Array.from({ length: 6 }, (_, i) => makePost(1000 - i, 100 - i));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(posts) });
  } else if (routePhase === "more") {
    const posts = Array.from({ length: 15 }, (_, i) => makePost(994 - i, 94 - i));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(posts) });
  } else {
    // F4 실패 단계
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "error" }) });
  }
});

try {
  await page.goto(BASE + HOME_PATH, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  // F1 prefetch 변이 검출
  const firstReq = capturedRequests.find((r) => r.phase === "first");
  if (firstReq) {
    const body = firstReq.body ?? {};
    // Supabase RPC 호출 인자는 POST body에 직접 포함됨
    const pLimit = body.p_limit;
    check("F1 p_limit = want+1(확인행 포함) = 6", pLimit === 6, `p_limit=${pLimit}`);
    check("F1 p_since 7일 창 포함", typeof body.p_since === "string" && body.p_since.length > 0, `p_since=${body.p_since}`);
  } else {
    check("F1 RPC 요청 캡처됨", false, "route handler 미호출 — 서버사이드 RPC 또는 라우팅 미일치");
  }

  // F2 실제 글 렌더 — 셀션 안 '커뮤니티 최신글 보기'(/community/all-posts) 링크는 제외하고
  // 실제 글 상세 링크(/community/teams/<slug>/posts/<id>) 만 센다(삼순 #1343 ②-b 카운트 오류).
  const POST_LINK = 'section:has-text("커뮤니티 인기글") a[href*="/posts/"]';
  const postLinks = page.locator(POST_LINK);
  const linkCount = await postLinks.count().catch(() => 0);
  check("F2 '커뮤니티 인기글' 섹션 표시", await page.locator('section:has-text("커뮤니티 인기글")').count() > 0);
  check("F2 픽스처 글 5개 렌더(링크 5개)", linkCount === 5, `count=${linkCount}`);
  check("F2 '15개 더 보기' 버튼 표시", await page.locator("button:has-text('15개 더 보기')").count() > 0);

  // F3 더보기 RPC
  routePhase = "more";
  const moreBtn = page.locator("button:has-text('15개 더 보기')");
  if ((await moreBtn.count()) > 0) {
    await moreBtn.click();
    await page.waitForTimeout(2000);
    const moreReq = capturedRequests.find((r) => r.phase === "more");
    if (moreReq) {
      const body = moreReq.body ?? {};
      check("F3 더보기 p_limit = step+1 = 16", body.p_limit === 16, `p_limit=${body.p_limit}`);
      const excl = Array.isArray(body.p_exclude) ? body.p_exclude : [];
      check("F3 더보기 p_exclude = 화면 5개 id", excl.length === 5, `p_exclude.length=${excl.length}`);
    } else {
      check("F3 더보기 RPC 호출됨", false, "더보기 route handler 미호출");
    }
    const afterLinks = await page.locator(POST_LINK).count().catch(() => 0);
    check("F3 더보기 후 글 20개", afterLinks === 20, `count=${afterLinks}`);
  } else {
    check("F3 더보기 버튼 존재 전제", false, "버튼 없음 — F2 실패 후 건너뜀");
  }

  // F4 미렌더 실패
  routePhase = "fail";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const sectionAfterFail = await page.locator('section:has-text("커뮤니티 인기글")').count();
  check("F4 RPC 500 → 섹션 숨김(빈 박스 없음)", sectionAfterFail === 0, `section count=${sectionAfterFail}`);

  check("런타임 오류 없음", runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\n❌ ui-smoke-home-popular-feed FAIL — ${failures}건`);
  process.exit(1);
}
console.log("\n✅ ui-smoke-home-popular-feed PASS");
