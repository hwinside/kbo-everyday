import { test, expect } from "@playwright/test";

test.describe("API 엔드포인트", () => {
  test("GET /api/standings → 10개 팀", async ({ request }) => {
    const res = await request.get("/api/standings");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.standings?.length).toBe(10);
  });

  test("GET /api/games?date=20260328 → 경기 배열", async ({ request }) => {
    const res = await request.get("/api/games?date=20260328");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(Array.isArray(data.games)).toBeTruthy();
  });

  test("GET /api/news → 뉴스 배열", async ({ request }) => {
    const res = await request.get("/api/news");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(Array.isArray(data.items)).toBeTruthy();
  });

  test("GET /api/highlights → 하이라이트 배열", async ({ request }) => {
    const res = await request.get("/api/highlights");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(Array.isArray(data.items)).toBeTruthy();
  });

  test("GET /api/player-teams?name=오스틴 → 선수 정보", async ({ request }) => {
    const res = await request.get("/api/player-teams?name=오스틴");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.players?.length).toBeGreaterThan(0);
  });

  test("GET /api/stats?type=batter → 타자 스탯", async ({ request }) => {
    const res = await request.get("/api/stats?type=batter");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.stats?.length || data.count).toBeGreaterThan(0);
  });

  test("GET /api/stats?type=pitcher → 투수 스탯", async ({ request }) => {
    const res = await request.get("/api/stats?type=pitcher");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.stats?.length || data.count).toBeGreaterThan(0);
  });
});
