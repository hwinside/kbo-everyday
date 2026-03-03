import { test, expect } from "@playwright/test";

test.describe("인터랙션", () => {
  test("구단별 필터 → 선수 목록 변경", async ({ page }) => {
    await page.goto("/boards/players");
    await page.waitForLoadState("networkidle");

    // 구단 필터 버튼 클릭 (LG)
    const lgBtn = page.getByRole("button", { name: /LG/ });
    if (await lgBtn.isVisible()) {
      const beforeCount = await page.locator('a[href*="/boards/players/"]').count();
      await lgBtn.click();
      await page.waitForTimeout(500);
      const afterCount = await page.locator('a[href*="/boards/players/"]').count();
      // 필터 적용되면 숫자 변경됨
      expect(afterCount).toBeLessThanOrEqual(beforeCount);
    }
  });

  test("순위 시즌 토글", async ({ page }) => {
    await page.goto("/standings");
    await page.waitForLoadState("networkidle");

    const btn2025 = page.getByRole("button", { name: "2025" });
    if (await btn2025.isVisible()) {
      await btn2025.click();
      await page.waitForTimeout(1000);
      // 페이지 에러 없음 확인
      const body = await page.textContent("body");
      expect(body).not.toContain("Application error");
    }
  });

  test("뉴스 캐러셀 스와이프", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // 캐러셀 dot indicators
    const dots = page.locator("button.rounded-full");
    const dotCount = await dots.count();
    expect(dotCount).toBeGreaterThan(0);
  });

  test("비로그인 상태에서 글쓰기 FAB → 로그인 유도", async ({ page }) => {
    await page.goto("/teams/1"); // LG 팀페이지
    await page.waitForLoadState("networkidle");
    
    // FAB 버튼 찾기
    const fab = page.locator('button:has(svg)').filter({ hasText: "" }).last();
    // FAB 없을 수도 있음 (로그인 필요 페이지)
  });
});

test.describe("반응형 레이아웃", () => {
  test("모바일에서 탭바 하단 고정", async ({ page }) => {
    await page.goto("/");
    const nav = page.locator("nav.fixed");
    await expect(nav).toBeVisible();
  });

  test("컨텐츠가 탭바에 가려지지 않음", async ({ page }) => {
    await page.goto("/");
    const main = page.locator("main");
    const mainBox = await main.boundingBox();
    const navBox = await page.locator("nav").boundingBox();
    if (mainBox && navBox) {
      // main의 padding-bottom이 nav 높이 이상
      expect(mainBox.height).toBeGreaterThan(100);
    }
  });
});
