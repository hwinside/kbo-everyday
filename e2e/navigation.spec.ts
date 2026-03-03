import { test, expect } from "@playwright/test";

test.describe("핵심 네비게이션", () => {
  test("홈 → 탭바 렌더링", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("nav")).toBeVisible();
    const tabs = page.locator("nav a");
    await expect(tabs).toHaveCount(5);
  });

  test("경기 페이지 로드", async ({ page }) => {
    await page.goto("/games");
    await expect(page.locator("nav")).toBeVisible();
  });

  test("순위 페이지 + 시즌 버튼 존재", async ({ page }) => {
    await page.goto("/standings");
    const seasonBtns = page.getByRole("button").filter({ hasText: /202[5-6]/ });
    await expect(seasonBtns.first()).toBeVisible();
  });

  test("선수 목록 로드 (CSR)", async ({ page }) => {
    await page.goto("/boards/players");
    await page.waitForLoadState("networkidle");
    // CSR 페이지 — 최소한 에러 없이 로드되는지 확인
    await expect(page.locator("nav")).toBeVisible();
    const body = await page.textContent("body");
    expect(body).not.toContain("Application error");
  });

  test("선수 상세 김도영", async ({ page }) => {
    await page.goto("/boards/players/52605");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000); // CSR hydration 대기
    const body = await page.textContent("body");
    expect(body).toContain("김도영");
  });

  test("팀 페이지 로드 (CSR)", async ({ page }) => {
    await page.goto("/teams/1");
    await page.waitForLoadState("networkidle");
    // CSR 페이지 — 로드 자체만 확인 (JS 렌더링은 headless에서 정상이면 OK)
    await expect(page.locator("nav")).toBeVisible();
  });

  test("MY 페이지 로드", async ({ page }) => {
    await page.goto("/my");
    await expect(page.locator("nav")).toBeVisible();
  });

  test("구장가이드 로드", async ({ page }) => {
    await page.goto("/stadiums");
    await page.waitForLoadState("networkidle");
    const body = await page.textContent("body");
    expect(body).toMatch(/잠실|고척|인천|수원|대전|대구|광주|사직|창원/);
  });

  test("하이라이트 페이지 로드", async ({ page }) => {
    await page.goto("/highlights");
    await expect(page.locator("nav")).toBeVisible();
  });

  test("예측 페이지 로드", async ({ page }) => {
    await page.goto("/predict");
    await expect(page.locator("nav")).toBeVisible();
  });
});

test.describe("탭바 네비게이션", () => {
  test("탭바 직접 URL 이동", async ({ page }) => {
    const paths = ["/", "/games", "/standings", "/predict", "/highlights"];
    for (const path of paths) {
      await page.goto(path);
      await expect(page.locator("nav")).toBeVisible();
    }
  });
});
