/**
 * 스모크: 조회수(관리자 전용) 핵심 정책 — 2026-07-21.
 *   ① 관리자 화이트리스트 게이트(isAdminEmail)
 *   ② 조회수 dedup 정책(view-tracker-policy): click 재진입=집계, impression 동일유저·세션=1회,
 *      계정 전환 분리, viewerKey 우선순위(로그인>게스트), beacon=false fallback
 *   ③ 피드·상세 공용 관리자 배지: click+impression 합산, 라벨 제거, 일반 유저 미노출
 *   ④ route abuse cap(view-rate-limit): 1초 창 중복 차단
 * 실행: npm run qa:admin-view
 */
import { readFileSync } from "node:fs";
import {
  isAdminEmail,
  ADMIN_EMAILS,
  canBypassVenueGeofenceForQa,
} from "../../src/lib/admin/admin-users";
import {
  viewerKeyOf,
  impressionDedupKey,
  shouldCountImpression,
  pickTransport,
  postViewTotal,
} from "../../src/lib/community/view-tracker-policy";
import { shouldAllowView } from "../../src/lib/community/view-rate-limit";

let pass = 0;
let fail = 0;
function check(label: string, got: unknown, want: unknown) {
  if (got === want) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// ── ① 관리자 화이트리스트 ─────────────────────────────
check("harinclaw admin", isAdminEmail("harinclaw@gmail.com"), true);
check("yoonyeonryul admin", isAdminEmail("yoonyeonryul@gmail.com"), true);
check("uppercase admin", isAdminEmail("Harinclaw@Gmail.com"), true);
check("whitespace admin", isAdminEmail("  yoonyeonryul@gmail.com  "), true);
check("random user", isAdminEmail("someone@gmail.com"), false);
check("empty", isAdminEmail(""), false);
check("null", isAdminEmail(null), false);
check("undefined", isAdminEmail(undefined), false);
check("prefix spoof", isAdminEmail("harinclaw@gmail.com.evil.com"), false);
check("substring spoof", isAdminEmail("xharinclaw@gmail.com"), false);
check("list is lowercase", ADMIN_EMAILS.every((e) => e === e.toLowerCase()), true);
check("venue QA admin GPS bypass", canBypassVenueGeofenceForQa("harinclaw@gmail.com"), true);
check("venue QA random user GPS enforced", canBypassVenueGeofenceForQa("someone@gmail.com"), false);
check("venue QA missing email GPS enforced", canBypassVenueGeofenceForQa(null), false);

// ── ② viewerKey 우선순위 ─────────────────────────────
check("viewer login>guest", viewerKeyOf("u1", "g1"), "u:u1");
check("viewer guest fallback", viewerKeyOf(null, "g1"), "g:g1");
check("viewer anon", viewerKeyOf(null, null), "g:anon");
check("viewer login differs guest", viewerKeyOf("u1") !== viewerKeyOf(null, "u1"), true);

// ── ② impression 동일 유저 세션당 1회 ─────────────────
{
  const seen = new Set<string>();
  const vk = viewerKeyOf("u1");
  // 첫 노출 = 집계 대상
  check("impression first counts", shouldCountImpression(seen, 10, vk), true);
  seen.add(impressionDedupKey(10, vk)); // 집계 처리
  // 같은 유저·같은 글 재노출 = 미집계
  check("impression same user repeat = no", shouldCountImpression(seen, 10, vk), false);
  // 다른 글 = 집계
  check("impression other post = yes", shouldCountImpression(seen, 11, vk), true);
}

// ── ② 계정 전환 분리(같은 세션, 다른 유저 각 1회) ──────
{
  const seen = new Set<string>();
  const vkA = viewerKeyOf("userA");
  const vkB = viewerKeyOf("userB");
  check("acctA first counts", shouldCountImpression(seen, 20, vkA), true);
  seen.add(impressionDedupKey(20, vkA));
  check("acctA repeat = no", shouldCountImpression(seen, 20, vkA), false);
  // 같은 글이라도 다른 계정은 별도 1회
  check("acctB same post counts", shouldCountImpression(seen, 20, vkB), true);
}

// ── ② auth hydration: guest→user 전환도 각 viewerKey 분리(관찰 게이트는 훅이 담당) ──
{
  const seen = new Set<string>();
  const guestVk = viewerKeyOf(null, "g-abc");
  const userVk = viewerKeyOf("u-abc");
  check("guest counts", shouldCountImpression(seen, 30, guestVk), true);
  seen.add(impressionDedupKey(30, guestVk));
  // hydration 후 user로 바뀌면 정책상 별개 키 → 훅의 authLoading 게이트가 이 이중집계를 막음
  check("user after hydration is separate key", shouldCountImpression(seen, 30, userVk), true);
}

// ── ② 잘못된 postId 방어 ─────────────────────────────
check("impression bad postId 0", shouldCountImpression(new Set(), 0, "u:x"), false);
check("impression bad postId -1", shouldCountImpression(new Set(), -1, "u:x"), false);

// ── ② beacon=false fallback ─────────────────────────
check("beacon ok → beacon", pickTransport(true, true), "beacon");
check("beacon queued false → fetch", pickTransport(true, false), "fetch");
check("beacon unavailable → fetch", pickTransport(false, false), "fetch");

// ── ③ 관리자 피드·상세 공용 합산 표시 ────────────────
check("view total click+impression", postViewTotal(12, 34), 46);
check("view total null click", postViewTotal(null, 34), 34);
check("view total null impression", postViewTotal(12, null), 12);
check("view total both null", postViewTotal(null, null), 0);

{
  const badge = readFileSync(new URL("../../src/components/community/PostViewBadge.tsx", import.meta.url), "utf8");
  const feed = readFileSync(new URL("../../src/components/community/PhotoFeed.tsx", import.meta.url), "utf8");
  const detail = readFileSync(new URL("../../src/components/community/PostDetail.tsx", import.meta.url), "utf8");
  check("view badge remains admin-only", badge.includes("<AdminOnly>"), true);
  check("view badge uses shared total", badge.includes("postViewTotal(clickCount, impressionCount)"), true);
  check("view badge removes click label", badge.includes("클릭 {"), false);
  check("view badge removes impression label", badge.includes("노출 {"), false);
  check("feed uses shared view badge", feed.includes("<PostViewBadge"), true);
  check("detail uses shared view badge", detail.includes("<PostViewBadge"), true);
}

// ── ④ route abuse cap(1초 창) ────────────────────────
check("rate first allow", shouldAllowView(undefined, 1000, 1000), true);
check("rate within window block", shouldAllowView(1000, 1500, 1000), false);
check("rate at boundary allow", shouldAllowView(1000, 2000, 1000), true);
check("rate after window allow", shouldAllowView(1000, 2500, 1000), true);

console.log(`admin-view-smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
