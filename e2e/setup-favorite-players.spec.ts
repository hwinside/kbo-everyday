import { test, expect } from "@playwright/test";

/**
 * QA: 가입 시 게스트 온보딩에서 선택한 최애선수가 DB에 유지되는지 검증
 * - 시나리오 1: 최애선수 2명 선택 → 가입 → DB 저장 확인 → 마이페이지 유지
 * - 시나리오 2: 최애선수 미선택 → 가입 → 빈 배열 유지 (regression)
 */

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://lbmbdjgsnenqjwjotoei.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SB_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

async function createTestUser(suffix: string) {
  const email = `qa-e2e-fav-${suffix}-${Date.now()}@test.local`;
  const res = await fetch(`${SB_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password: "testpass123!", email_confirm: true }),
  });
  const user = await res.json();
  return { id: user.id, email };
}

async function getAccessToken(email: string) {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SB_ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "testpass123!" }),
  });
  const data = await res.json();
  return data.access_token;
}

async function getProfileFromDB(userId: string) {
  const res = await fetch(
    `${SB_URL}/rest/v1/profiles?id=eq.${userId}&select=nickname,team_id,favorite_players`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
  );
  const rows = await res.json();
  return rows[0];
}

async function deleteTestUser(userId: string) {
  await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${userId}`, {
    method: "DELETE",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  await fetch(`${SB_URL}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
}

const TEST_PLAYERS = [
  { playerId: "78515", name: "오스틴", teamId: 1, position: "외야수", number: 31 },
  { playerId: "65804", name: "김현수", teamId: 1, position: "외야수", number: 22 },
];

test.describe("가입 시 최애선수 유지", () => {
  let userId: string;
  let userEmail: string;

  test.afterEach(async () => {
    if (userId) await deleteTestUser(userId);
  });

  test("게스트 온보딩 최애선수 → 가입 → DB 저장 → 마이페이지 유지", async ({ page }) => {
    // 1. 테스트 유저 생성 + 토큰
    const user = await createTestUser("withfav");
    userId = user.id;
    userEmail = user.email;
    const token = await getAccessToken(userEmail);

    // 2. localStorage에 최애선수 설정 (게스트 온보딩 시뮬레이션)
    await page.goto("/");
    await page.evaluate((players) => {
      localStorage.setItem("kbo-favorite-players", JSON.stringify(players));
      localStorage.setItem("kbo-onboarding", "completed");
      localStorage.setItem("kbo-my-team", "1");
    }, TEST_PLAYERS);

    // 3. /setup 페이지로 이동 (access_token 해시 포함)
    await page.goto(`/setup#access_token=${token}&type=signup`);
    await page.waitForLoadState("networkidle");

    // 4. Step 1: 닉네임 입력
    const nickname = `E2E팹${Date.now()}`;
    await page.fill('input[placeholder*="닉네임"]', nickname);
    await page.waitForTimeout(600); // debounce 대기
    await page.click("button:has-text('다음')");

    // 5. Step 2: 팀 선택 (LG)
    await page.waitForSelector("text=응원 구단 선택");
    await page.click("button:has-text('LG')");
    await page.click("button:has-text('다음')");

    // 6. Step 3: 초대코드 건너뛰기
    await page.waitForSelector("text=초대코드");
    await page.click("button:has-text('건너뛰기')");

    // 7. 가입 완료 대기 (/welcome으로 리다이렉트)
    await page.waitForURL("**/welcome", { timeout: 15000 });

    // 8. DB에서 최애선수 확인
    const profile = await getProfileFromDB(userId);
    expect(profile).toBeTruthy();
    expect(profile.favorite_players).toHaveLength(2);
    expect(profile.favorite_players[0].playerId).toBe("78515");
    expect(profile.favorite_players[1].playerId).toBe("65804");

    // 9. 마이페이지 이동 → 최애선수 표시 확인
    await page.goto("/my");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000); // CSR hydration

    const body = await page.textContent("body");
    expect(body).toContain("오스틴");
    expect(body).toContain("김현수");

    // 10. 새로고침 후에도 유지 (DB → localStorage 동기화 검증)
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    const bodyAfterReload = await page.textContent("body");
    expect(bodyAfterReload).toContain("오스틴");
    expect(bodyAfterReload).toContain("김현수");

    // 11. 재로그인 후 DB 유지 확인 (DB = source of truth)
    // Note: E2E에서 hash token은 일회성이라 브라우저 세션 재현 불가,
    // 실제 프로덕션은 OAuth 쿠키로 세션 유지 → AuthContext.loadProfile → syncProfileToLocal
    // 여기서는 DB에 값이 영구 저장되어 있음을 재확인
    const profileAfterReload = await getProfileFromDB(userId);
    expect(profileAfterReload.favorite_players).toHaveLength(2);
    expect(profileAfterReload.favorite_players[0].name).toBe("오스틴");
    expect(profileAfterReload.favorite_players[1].name).toBe("김현수");
  });

  test("최애선수 미선택 가입 → 빈 배열 (regression)", async ({ page }) => {
    const user = await createTestUser("nofav");
    userId = user.id;
    userEmail = user.email;
    const token = await getAccessToken(userEmail);

    // localStorage에 최애선수 없이
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.removeItem("kbo-favorite-players");
      localStorage.setItem("kbo-onboarding", "completed");
      localStorage.setItem("kbo-my-team", "6");
    });

    await page.goto(`/setup#access_token=${token}&type=signup`);
    await page.waitForLoadState("networkidle");

    const nickname = `E2E노팹${Date.now()}`;
    await page.fill('input[placeholder*="닉네임"]', nickname);
    await page.waitForTimeout(600);
    await page.click("button:has-text('다음')");

    await page.waitForSelector("text=응원 구단 선택");
    await page.click("button:has-text('KIA')");
    await page.click("button:has-text('다음')");

    await page.waitForSelector("text=초대코드");
    await page.click("button:has-text('건너뛰기')");

    await page.waitForURL("**/welcome", { timeout: 15000 });

    const profile = await getProfileFromDB(userId);
    expect(profile).toBeTruthy();
    expect(profile.favorite_players).toHaveLength(0);
  });
});
