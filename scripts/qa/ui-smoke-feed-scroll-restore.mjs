/**
 * 커뮤니티 피드 뒤로가기 복원 — 실브라우저 End-User 스모크.
 *
 * 사고 재현(production 실측, iPhone 390x844): 피드 깊게 스크롤 → 투표/일반글 상세 진입 →
 * 뒤로가기 시 scrollY 12849 → 1243, 카드 31 → 11 로 맨 위 초기화.
 *
 * 이 스모크는 로컬 production 빌드에 같은 동선을 걸어 복원 여부를 판정한다.
 *   BASE=http://127.0.0.1:3311 node scripts/qa/ui-smoke-feed-scroll-restore.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://127.0.0.1:3311";
const PATH = process.env.FEED_PATH || "/community/teams/lg";
// 복원 판정 허용 오차(px). 이미지·투표 요약이 늦게 붙어 몇 px 어긋나는 건 정상.
const TOLERANCE = Number(process.env.TOLERANCE || 250);

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
});

const cardCount = () =>
  page.evaluate(() => document.querySelectorAll('a[href^="/community/free/"]').length);

try {
  await page.goto(BASE + PATH, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);

  // 무한 스크롤로 여러 페이지 로드.
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(1100);
  }
  const beforeY = await page.evaluate(() => window.scrollY);
  const beforeCards = await cardCount();
  console.log(`\n[진입 전] scrollY=${beforeY} cards=${beforeCards}`);
  check("깊은 스크롤 상태 확보(테스트 전제)", beforeY > 3000 && beforeCards > 20, `y=${beforeY} cards=${beforeCards}`);

  // 현재 화면에 보이는 글로 진입(실제 유저 동선 = 클릭).
  // ⚠️ JS 의 element.click() 은 Next.js Link 라우팅을 타지 않아 네비게이션이 안 일어난다(실측).
  // 반드시 실제 포인터 클릭을 써야 사고 동선이 재현된다.
  const link = page.locator('a[href^="/community/free/"]').nth(12);
  const href = await link.getAttribute("href");
  check("진입할 글 링크 확보", !!href, href || "none");
  await link.scrollIntoViewIfNeeded();
  // 클릭 직전의 실제 위치가 복원 목표다(scrollIntoView 로 위치가 바뀔 수 있으므로 여기서 다시 읽는다).
  const targetY = await page.evaluate(() => window.scrollY);
  await link.click();
  await page.waitForURL("**/community/free/**", { timeout: 30000 });
  await page.waitForTimeout(2500);
  check("글 상세 진입", page.url().includes("/community/free/"), page.url());

  // 뒤로가기(실제 popstate).
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);

  const afterY = await page.evaluate(() => window.scrollY);
  const afterCards = await cardCount();
  console.log(`[복귀 후] scrollY=${afterY} cards=${afterCards}`);

  check(
    "뒤로가기 후 피드가 맨 위로 초기화되지 않음",
    afterY > 1000,
    `scrollY=${afterY}`,
  );
  check(
    "로드 분량(카드 수) 복원",
    afterCards >= beforeCards,
    `${beforeCards} → ${afterCards}`,
  );
  check(
    `스크롤 위치 복원(±${TOLERANCE}px)`,
    Math.abs(afterY - targetY) <= TOLERANCE,
    `${targetY} → ${afterY} (Δ${Math.abs(afterY - targetY)})`,
  );

  // push 진입(탭바 등 새 진입)에서는 복원되지 않아야 한다 = 항상 최상단.
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.goto(BASE + PATH, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  const pushY = await page.evaluate(() => window.scrollY);
  check("push 진입은 복원 없이 최상단", pushY < 300, `scrollY=${pushY}`);

  // ────────────────────────────────────────────────────────────────────────
  // [경계 A] 무관한 화면에서의 뒤로가기가 다음 feed push 를 오염시키지 않아야 한다.
  // 삼순 리뷰 actual: 피드 저장 → 경기 push → 순위 push → **경기로 back** → 커뮤니티 push →
  // 팀 피드 push 인데 12972 로 복원됨(전역 pop 플래그가 목적지를 안 봄).
  //
  // ⚠️ 반드시 **SPA 링크 클릭**으로 동선을 만들어야 한다. page.goto 는 전체 문서 로드라
  // popstate 자체가 안 뜨고, 그러면 이 경계를 검사하지 못한 채 초록이 된다(내 첫 시도가 그랬다).
  // ────────────────────────────────────────────────────────────────────────
  console.log("\n[경계 A] 무관한 back → feed push 는 최상단 (SPA 동선)");
  const nav = (label) => page.locator(`nav a:has-text("${label}"), footer a:has-text("${label}")`).first();

  await page.goto(BASE + PATH, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(1100);
  }
  const armedY = await page.evaluate(() => window.scrollY);
  check("경계 A 전제: 깊은 위치 저장됨", armedY > 3000, `y=${armedY}`);

  // 피드 → 경기 push → 순위 push (전부 SPA)
  await nav("경기").click();
  await page.waitForURL("**/games**", { timeout: 30000 });
  await page.waitForTimeout(1800);
  await nav("순위").click();
  await page.waitForURL("**/standings**", { timeout: 30000 });
  await page.waitForTimeout(1800);

  // feed 와 무관한 back (순위 → 경기). 여기서 pop 플래그가 생긴다.
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const poppedTo = page.url();
  check("경계 A 전제: feed 와 무관한 화면으로 back 발생", poppedTo.includes("/games"), poppedTo);

  // 이제 push 로 피드에 새로 진입 — 복원되면 안 된다.
  await nav("커뮤니티").click();
  await page.waitForURL("**/community**", { timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.locator(`a[href="${PATH}"]`).first().click();
  await page.waitForURL(`**${PATH}`, { timeout: 30000 });
  await page.waitForTimeout(4500);
  const afterUnrelatedBackY = await page.evaluate(() => window.scrollY);
  check(
    "무관한 back 뒤 push 진입은 최상단(전역 pop 플래그 오염 없음)",
    afterUnrelatedBackY < 300,
    `scrollY=${afterUnrelatedBackY} (stale=${armedY})`,
  );

  // ────────────────────────────────────────────────────────────────────────
  // [경계 B] 유저가 직접 맨 위로 올린 뒤 글 진입 → back 하면 최상단이어야 한다.
  // 삼순 리뷰 actual: 12972 저장 → 유저가 wheel 로 최상단(0) → 첫 글 진입 → back → 12972 복원.
  // ────────────────────────────────────────────────────────────────────────
  console.log("\n[경계 B] 유저가 만든 진짜 최상단은 복원되지 않아야 함");
  await page.goto(BASE + PATH, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(1100);
  }
  const deepY = await page.evaluate(() => window.scrollY);
  check("경계 B 전제: 깊은 위치 확보", deepY > 3000, `y=${deepY}`);
  // 실제 유저 입력으로 최상단까지 되돌린다(스크립트 scrollTo 가 아니라 wheel).
  for (let i = 0; i < 14; i++) {
    await page.mouse.wheel(0, -3000);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1200);
  const topY = await page.evaluate(() => window.scrollY);
  check("경계 B 전제: 유저가 최상단으로 복귀", topY <= 5, `y=${topY}`);

  const firstLink = page.locator('a[href^="/community/free/"]').first();
  await firstLink.click();
  await page.waitForURL("**/community/free/**", { timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  const backFromTopY = await page.evaluate(() => window.scrollY);
  check(
    "유저가 만든 최상단에서 back 하면 최상단 유지(오래된 깊은 위치로 튀지 않음)",
    backFromTopY < 300,
    `scrollY=${backFromTopY} (stale=${deepY})`,
  );
} catch (e) {
  failures++;
  console.error("ERROR", e.message);
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} (failures=${failures})`);
process.exit(failures === 0 ? 0 : 1);
